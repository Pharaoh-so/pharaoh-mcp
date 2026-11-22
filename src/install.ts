/** One-command developer setup. Registration is separate from an answered tool call. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { nativeFeedHooksReady, syncNativeFeedHooks } from "../runtime/feed-hooks.mjs";
import { TESTED_FEED_PROFILES } from "../runtime/feed-profiles.mjs";
import {
	automaticRuntimeIntent,
	disableRuntime,
	type RuntimeDeviceApproval,
	type RuntimeEnrollmentIntent,
} from "../runtime/runtime-client.mjs";
import { syncLocalWorktreeHooks, syncUpdateNoticeHook } from "../runtime/runtime-hooks.mjs";
import { RUNTIME_CLIENTS } from "../runtime/runtime-native.mjs";
import { copyUpdateNoticeHook } from "../runtime/update-notice.mjs";
import {
	pollForToken,
	printActivationPrompt,
	printAuthSuccess,
	requestDeviceCode,
} from "./auth.js";
import {
	CLIENT_LABELS,
	desktopRestartable,
	listClients,
	restartDesktop,
} from "./client-install.js";
import {
	bootstrapLegacyFeedSignIn,
	type Credentials,
	readCredentials,
	saveAuthorizedCredentials,
} from "./credentials.js";
import {
	abortOnEnter,
	askYesNo,
	DEFAULT_SERVER,
	INSTALL_COMMAND,
	NPX_COMMAND,
	OTHER_WAYS_TO_CONNECT,
	type Progress,
	pickOption,
	printLines,
	resolveSseUrl,
	showProgress,
	tokenToCredentials,
} from "./helpers.js";
import { askInstallPath, gitWorktreeRoot, resolveInstallScope } from "./install-scope.js";
import type { ClientId, ClientOutcome, InstallScope, LaunchConfig } from "./install-types.js";
import { installedLocalAnalyzer } from "./local/worker-host.js";
import { recordInstalledVersion } from "./memory-hint.js";
import { loadAndRefresh } from "./refresh.js";
import { adoptLauncher, ensureRuntime, RuntimeSetupError, registryKey } from "./runtime.js";
import {
	attachInstalledRuntime,
	describeRuntimeDisable,
	enableInstalledRuntime,
} from "./runtime-command.js";
import {
	type ClientTarget,
	configureClients,
	discoverClients,
	freshRuntimeClients,
	legacyMigrations,
	preflightInstallScope,
	scopeInstallTargets,
	verifiedCodingClients,
} from "./setup.js";
import { SETUP_TOOL_PROMPT } from "./setup-prompt.generated.js";
import {
	fetchLatestVersion,
	getPackageVersion,
	isNewerVersion,
	UPGRADE_COMMAND,
} from "./version.js";

/** Statuses the summary reports on their own line; the rest fold into "Connected to …". */
const PROBLEMS: Partial<Record<ClientOutcome["status"], string>> = {
	unavailable: "not available",
	ambiguous: "needs attention",
	failed: "setup failed",
};

function codexHooksAllowed(path: string): boolean {
	try {
		const file = lstatSync(path);
		if (!file.isFile() || file.size > 262_144) return false;
		const config = parseToml(readFileSync(path, "utf8"));
		const features = config.features;
		return (
			features === undefined ||
			(features !== null &&
				typeof features === "object" &&
				!Array.isArray(features) &&
				(features as Record<string, unknown>).hooks !== false &&
				(features as Record<string, unknown>).codex_hooks !== false)
		);
	} catch {
		return false;
	}
}

/** Statuses whose client has an enabled `pharaoh` entry the setup prompt can reach. */
const CONNECTED: ReadonlySet<ClientOutcome["status"]> = new Set([
	"configured",
	"already-configured",
	"preserved-custom",
]);

/** An agent CLI the installer can start with the setup prompt. */
export interface AgentLaunch {
	/** The client whose registration the agent reads. */
	client: ClientId;
	/** The executable `discoverClients` saw start (`claude`, `codex`). */
	command: string;
	/** The setup prompt, as the agent's first message. */
	args: string[];
	/** Explicit Local installs start the agent inside the selected checkout. */
	cwd?: string;
}

/**
 * Whether the installer may ask a question and start an agent here: a terminal
 * on both sides, and not CI or a NO_COLOR environment.
 */
export function canStartAgent(
	env: NodeJS.ProcessEnv = process.env,
	input: { isTTY?: boolean } = process.stdin,
	output: { isTTY?: boolean } = process.stderr,
): boolean {
	return Boolean(input.isTTY && output.isTTY && !env.CI && !env.NO_COLOR);
}

/**
 * A variable npx set for this process: its lowercase `npm_*` run-script values
 * and INIT_CWD. Registry and credential settings stay, as in runtime.ts: a user
 * may export them, and an `.npmrc` may read `NPM_TOKEN`.
 */
function npxVariable(key: string): boolean {
	if (key === "INIT_CWD") return true;
	if (!key.startsWith("npm_")) return false;
	return !(key.startsWith("npm_config_") && registryKey(key.slice("npm_config_".length)));
}

/**
 * Run an agent CLI in this terminal with inherited stdio and wait for it to exit.
 * npx's own variables are dropped: `npm_config_yes` would let every `npx` the
 * agent runs install without asking.
 * @returns false when the agent could not be started.
 */
export function startAgent(agent: AgentLaunch): Promise<boolean> {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !npxVariable(key)));
	return new Promise((resolve) => {
		// The agent owns Ctrl-C now; this process only waits for it.
		const ignore = () => {};
		process.on("SIGINT", ignore);
		const done = (started: boolean) => {
			process.off("SIGINT", ignore);
			resolve(started);
		};
		spawn(agent.command, agent.args, {
			stdio: "inherit",
			env,
			...(agent.cwd ? { cwd: agent.cwd } : {}),
		})
			.once("error", () => done(false))
			.once("exit", () => done(true));
	});
}

/** The command a person can paste to start an agent with the setup prompt. */
function agentCommand(agent: AgentLaunch): string {
	const command = `${agent.command} ${agent.args.map((arg) => JSON.stringify(arg)).join(" ")}`;
	return agent.cwd ? `cd -- '${agent.cwd.replaceAll("'", "'\\''")}' && ${command}` : command;
}

/** What a computer with no supported client hears, instead of a sign-in it couldn't use. */
const NO_AGENT_HERE = [
	"Pharaoh: no Claude Code, Codex or Claude Desktop on this computer, so there's nothing to connect.",
	"Running this for someone else? Run it on their computer instead.",
	OTHER_WAYS_TO_CONNECT,
];

/** The menu title for the first run; each connected agent CLI is an option, then Skip. */
const TRY_TITLE = "Try Pharaoh in:";

/** When Enter starts to skip the wait for Desktop to quit: a quit it doesn't question is done by then. */
const DESKTOP_SKIP_AFTER_MS = 2_000;

/**
 * The next step, as the summary's last line. In a terminal it offers a menu of the connected
 * agent CLIs (one or several) plus Skip; the one picked starts with the setup prompt, and
 * the menu collapses to a "Starting …" line. Without a terminal it prints each agent's
 * command. Claude Desktop has no command to start, so it gets the request to send, as does
 * a person with no agent CLI, who sees no menu at all.
 * @param desktop - What to do in a connected Claude Desktop: open it, restart it after a new
 *   registration, or nothing yet when it stayed open ("rerun"): its note says to quit it and
 *   run the install again, and that install gives the request.
 * @returns The agent the person chose to start, or null.
 */
async function chooseAgent(
	agents: AgentLaunch[],
	desktop: "open" | "restart" | "rerun" | null,
	interactive: boolean,
	{ choose, write }: Pick<InstallDependencies, "choose" | "write">,
): Promise<AgentLaunch | null> {
	const request = JSON.stringify(SETUP_TOOL_PROMPT);
	if (desktop === "open" || desktop === "restart")
		write(`Claude Desktop: ${desktop} it and ask ${request}`);
	else if (!desktop && !agents.length) write(`Next: ask your agent ${request}`);
	if (!agents.length) return null;
	if (!interactive) {
		write(...agents.map((agent) => `Start: ${agentCommand(agent)}`));
		return null;
	}
	const labels = agents.map((agent) => CLIENT_LABELS[agent.client]);
	const picked = await choose(TRY_TITLE, [...labels, "Skip"]);
	// Skip, n/Esc (-1) and an ended input (null) all start nothing.
	if (picked === null || picked < 0 || picked >= agents.length) return null;
	write(`Starting ${labels[picked]}…`);
	return agents[picked];
}

/** The part of Codex's hooks.json the trust check reads: event → groups → handlers. */
type CodexHooks = Record<string, Array<{ hooks?: Array<{ command?: unknown; args?: unknown }> }>>;

/** Pharaoh's hook commands: project memory, saved-worktree, runtime and update-notice hooks. */
const PHARAOH_HOOK =
	/pharaoh-project-memory:|--pharaoh-(?:local-worktree|runtime|update-notice|native-feed)-v1/;

/**
 * Whether Codex has a Pharaoh hook it hasn't trusted yet: a hooks.json entry with
 * no `trusted_hash` at its position (`<hooks.json>:<event>:<group>:<hook>`) in
 * config.toml's `[hooks.state]`. A hook that changed at a trusted position isn't
 * caught here; Codex asks for that review itself.
 * @param root - Codex's configuration directory (CODEX_HOME or ~/.codex).
 */
export function codexHookUntrusted(root: string): boolean {
	const hooksPath = join(root, "hooks.json");
	const configPath = join(root, "config.toml");
	try {
		if (!existsSync(hooksPath)) return false;
		const hooks: CodexHooks = JSON.parse(readFileSync(hooksPath, "utf8")).hooks ?? {};
		const config = existsSync(configPath) ? parseToml(readFileSync(configPath, "utf8")) : {};
		const state =
			(config.hooks as { state?: Record<string, { trusted_hash?: unknown }> } | undefined)?.state ??
			{};
		return Object.entries(hooks).some(([event, groups]) => {
			const name = event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
			return groups.some((group, i) =>
				(group.hooks ?? []).some(
					(hook, j) =>
						PHARAOH_HOOK.test(
							`${hook.command ?? ""} ${Array.isArray(hook.args) ? hook.args.join(" ") : ""}`,
						) && typeof state[`${hooksPath}:${name}:${i}:${j}`]?.trusted_hash !== "string",
				),
			);
		});
	} catch {
		// An unreadable file shows no trust gap; Codex still asks for its own review.
		return false;
	}
}

/** Install options that take a value, each with the check of that value: the error, or null. */
const VALUED_OPTIONS = new Map<
	string,
	(value: string | undefined, args: readonly string[]) => string | null
>([
	["--server", (value) => (!value || value.startsWith("--") ? "--server needs a URL." : null)],
	[
		"--scope",
		(value) =>
			value !== "global" && value !== "local" ? "--scope must be global or local." : null,
	],
	[
		"--path",
		(value, args) => {
			if (!value || value.startsWith("--")) return "--path needs a repository directory.";
			if (!args.includes("--scope") || args[args.indexOf("--scope") + 1] !== "local")
				return "--path requires --scope local.";
			return null;
		},
	],
]);

/** Install options that take no value. */
const FLAG_OPTIONS = [
	"--migrate-legacy",
	"--memory-hooks",
	"--skip-runtime",
	"--native-delegation",
];

/** Reject a mistyped explicit install command before it can authorize or change settings. */
export function validateInstallArguments(args: readonly string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const check = VALUED_OPTIONS.get(args[i]);
		if (check) {
			const error = check(args[i + 1], args);
			if (error) return error;
			i++;
		} else if (!FLAG_OPTIONS.includes(args[i])) {
			return "Unknown install option. Run pharaoh-mcp install --help.";
		}
	}
	if (args.includes("--native-delegation") && args[args.indexOf("--scope") + 1] !== "global")
		return "--native-delegation requires --scope global.";
	return null;
}

function sameOrigin(left: string, right: string): boolean {
	try {
		return new URL(left).origin === new URL(right).origin;
	} catch {
		return false;
	}
}

interface InstallAuthResult {
	credentials: Credentials;
	runtimeApprovals?: RuntimeDeviceApproval[];
	/** The saved sign-in was still good, so this run updates an existing setup. */
	reused?: true;
}

/**
 * Place the session-start update notice for these clients: the hook at its
 * stable path, the installed version beside it, and one SessionStart handler per
 * client. Never throws; a client whose hooks can't be written goes without.
 * @param clients - Coding clients this install connected
 * @param node - The Node executable their Pharaoh registration runs
 * @param options.home - Home directory (tests)
 * @param options.env - Environment for CLAUDE_CONFIG_DIR / CODEX_HOME (tests)
 */
export async function installUpdateNotice(
	clients: readonly ("claude-code" | "codex")[],
	node: string,
	{
		home = homedir(),
		env = process.env,
		scope,
	}: { home?: string; env?: NodeJS.ProcessEnv; scope?: InstallScope } = {},
): Promise<void> {
	const directory = join(home, ".pharaoh");
	const hook = clients.length ? copyUpdateNoticeHook(directory) : null;
	if (!hook) return;
	if (!(await recordInstalledVersion(getPackageVersion(), join(directory, "credentials.json"))))
		return;
	for (const client of clients) {
		try {
			syncUpdateNoticeHook(client, hook, { node, home, env, scope });
		} catch {
			// Disabled or unreadable hook settings: this client has no notice, and nothing else changes.
		}
	}
}

/** Keep working credentials until a new device authorization has actually succeeded. */
async function authenticateInstall(
	server: string,
	runtimeInstallations: readonly RuntimeEnrollmentIntent[],
): Promise<InstallAuthResult> {
	const existing = readCredentials();
	if (existing && sameOrigin(existing.sse_url, server)) {
		const current = await loadAndRefresh(server, undefined, true);
		if (current?.ok) {
			printAuthSuccess(
				current.creds.github_login,
				current.creds.tenant_name,
				current.creds.repos.length,
			);
			// Which repos have memory is checked in the background at the next session start.
			return { credentials: current.creds, reused: true };
		}
		if (current && current.action !== "reauth") {
			throw new Error(
				"Sign-in could not be refreshed. Try again; your saved credentials were kept.",
			);
		}
	}

	const device = await requestDeviceCode(server, runtimeInstallations);
	printActivationPrompt(device);
	const token = await pollForToken(server, device.device_code, device.interval);
	// Validate the server binding before replacing credentials.
	const sseUrl = resolveSseUrl(token.sse_url, server);
	const credentials = tokenToCredentials(token, sseUrl, server);
	const offered = Array.isArray(token.runtime_approvals) ? token.runtime_approvals : [];
	const runtimeApprovals = runtimeInstallations.flatMap((intent) => {
		const approval = offered.find(
			(offer) =>
				offer?.client === intent.client &&
				offer.installationId === intent.installationId &&
				offer.generation === intent.generation &&
				offer.policyVersion === intent.policyVersion,
		);
		return approval ? [approval] : [];
	});
	if (runtimeApprovals.length) credentials.runtime_session = randomUUID();
	// A device ticket stays in this process. Only the ordinary OAuth record goes to disk.
	await saveAuthorizedCredentials(credentials);
	if (token.provisional) {
		printLines(`Pharaoh: install the GitHub App to map your repos: ${token.install_url ?? ""}`);
	}
	printAuthSuccess(credentials.github_login, credentials.tenant_name, credentials.repos.length);
	return { credentials, runtimeApprovals };
}

interface InstallDependencies {
	discover: () => ClientTarget[];
	migrations: typeof legacyMigrations;
	authenticate: typeof authenticateInstall;
	/** Prepare the runtime; `onInstall` fires only when a version has to be installed. */
	runtime: (
		onInstall: (version: string) => void,
		onDiagnostic: (message: string) => void,
		signal: AbortSignal,
	) => Promise<LaunchConfig>;
	/** A transient progress line naming the current step. */
	progress: () => Progress;
	/** Puts the runtime behind the stable launcher; null keeps the exact-version launch (Windows). */
	launcher: (launch: LaunchConfig) => Promise<string | null>;
	configure: typeof configureClients;
	/** Whether Claude Desktop is open and this install doesn't run inside it. */
	canRestartDesktop: () => boolean;
	/** Quit Claude Desktop, register `launch`, reopen it; null when it didn't quit or `signal` ended the wait. */
	restartDesktop: (
		target: ClientTarget,
		launch: LaunchConfig,
		flags: { migrateLegacy: boolean; signal: AbortSignal },
	) => Promise<ClientOutcome | null>;
	/** A signal Enter aborts until `stop`, the person's way out of a wait; `onListen` fires once Enter counts. */
	skipOnEnter: (onListen: () => void) => { signal: AbortSignal; stop(): void };
	ask: (question: string) => Promise<boolean | null>;
	askPath: (question: string) => Promise<string | null>;
	resolveRoot: (path: string) => string | null;
	preflightScope: (targets: readonly ClientTarget[], scope: InstallScope) => ClientOutcome[];
	/** Pick one of `options` from a menu: its 0-based index, -1 for none, null on ended input. */
	choose: (title: string, options: readonly string[]) => Promise<number | null>;
	startAgent: (agent: AgentLaunch) => Promise<boolean>;
	write: (...lines: string[]) => void;
	latest: typeof fetchLatestVersion;
	updateNotice: typeof installUpdateNotice;
	nativeFeedHooks: typeof syncNativeFeedHooks;
	bootstrapFeed: typeof bootstrapLegacyFeedSignIn;
	localAnalyzer: typeof installedLocalAnalyzer;
	freshRuntimeClients: typeof freshRuntimeClients;
	verifiedRuntimeClients: typeof verifiedCodingClients;
	runtimeIntent: typeof automaticRuntimeIntent;
	enableRuntime: typeof enableInstalledRuntime;
	attachRuntime: typeof attachInstalledRuntime;
	disableRuntime: typeof disableRuntime;
}

/** Install hooks/skills only for coding clients whose enabled registration was verified. */
export interface InstallOptions {
	server: string;
	/** Literal --server option tokens; absent retains the existing programmatic default. */
	serverArgv?: string[];
	migrateLegacy?: boolean;
	skipRuntime?: boolean;
	/** Selected activation kind; omitted presents the picker in a terminal. */
	scope?: InstallScope["kind"];
	/** Local checkout path; omitted resolves the current working directory. */
	path?: string;
	/** Working directory override for isolated installer fixtures. */
	cwd?: string;
	/** Check hook and plugin overlaps before any setup side effects. */
	preflightScope?: (
		scope: InstallScope,
		targets: readonly ClientTarget[],
	) => string[] | Promise<string[]>;
	/** Ask questions and offer to start an agent (default: canStartAgent()). */
	interactive?: boolean;
	/** Optional client setup. Lines passed to `note` show in the summary, after the client list. */
	afterConfigure?: (
		credentials: Credentials,
		clients: string[],
		note: (...lines: string[]) => void,
		scope: InstallScope,
	) => Promise<void>;
	/** Optional, separately consented guidance for a managed Global pilot connection. */
	offerNativeDelegation?: (
		client: "codex" | "claude-code",
		version: string,
		eligible: () => boolean,
	) => Promise<string | null>;
	/** Isolated process/filesystem fixtures use the same orchestration without real user writes. */
	dependencies?: Partial<InstallDependencies>;
}

/** The installer's progress line, and the runtime's notes held back until sign-in ends. */
interface InstallUi {
	/** The current progress line: a placeholder until sign-in ends, then the real one. */
	progress: Progress;
	signedIn: boolean;
	/** The runtime version being installed, once one has to be. */
	installing?: string;
	runtimeReady: boolean;
	/** Runtime notes written before sign-in ended. */
	held: string[];
}

/** What an install connects: where it activates, and the clients it targets. */
interface InstallPlan {
	options: InstallOptions;
	dependencies: InstallDependencies;
	/** Ask questions (a terminal on both sides, unless the caller said otherwise). */
	interactive: boolean;
	scope: InstallScope;
	targets: ClientTarget[];
	/** The targets that are neither unavailable nor ambiguous. */
	activeTargets: ClientTarget[];
}

/** An install that has signed in and configured its clients. */
interface ConnectedInstall extends InstallPlan {
	ui: InstallUi;
	credentials: Credentials;
	runtimeApprovals?: RuntimeDeviceApproval[];
	/** The saved sign-in was still good, so this run updates an existing setup. */
	reused?: true;
	runtimeInstallations: RuntimeEnrollmentIntent[];
	/** The prepared runtime's own launch. */
	launch: LaunchConfig;
	/** The stable launcher in front of it; null keeps the exact-version launch (Windows). */
	launcher: string | null;
	/** The launch every registration and hook names. */
	configuredLaunch: LaunchConfig;
	outcomes: ClientOutcome[];
	/** Coding clients (not Claude Desktop) this install configured or found configured. */
	codingClients: ClientId[];
	/** Lines the summary prints after the client list. */
	notes: string[];
}

/**
 * Discover the supported clients (none: stop before anything else), prepare the pinned
 * runtime while signing in, then configure every client independently. A failed runtime never reaches a configuration writer, and an install that
 * stops early stops the runtime's preparation too. Partial successes are retained.
 * @returns A shell exit status; does not terminate the caller or mark onboarding complete.
 */
export async function runInstall(options: InstallOptions): Promise<number> {
	const dependencies = installDependencies(options);
	const write = dependencies.write;
	const ui: InstallUi = {
		progress: { visible: false, step() {}, stop() {} },
		signedIn: false,
		runtimeReady: false,
		held: [],
	};
	// Whichever way runInstall leaves, nothing it started keeps the process alive: an
	// unfinished runtime preparation stops (a finished one ignores this).
	const preparation = new AbortController();
	try {
		const plan = await planInstall(options, dependencies);
		if (typeof plan === "number") return plan;
		return await install(plan, ui, preparation.signal);
	} catch (error) {
		ui.progress.stop();
		// Never print native process errors: npm output/configuration may contain registry secrets.
		if (error instanceof RuntimeSetupError) write(`Pharaoh: ${error.message}`);
		write(`Pharaoh: installation could not finish. Retry ${INSTALL_COMMAND}.`);
		return 1;
	} finally {
		preparation.abort();
	}
}

/** The installer's dependencies: the real ones, with the caller's fixtures over them. */
function installDependencies(options: InstallOptions): InstallDependencies {
	return {
		discover: discoverClients,
		migrations: legacyMigrations,
		authenticate: authenticateInstall,
		runtime: (onInstall, onDiagnostic, signal) =>
			ensureRuntime({ onDiagnostic, onInstall, signal }),
		progress: () => showProgress(),
		launcher: (launch) => adoptLauncher(launch),
		configure: configureClients,
		canRestartDesktop: () => desktopRestartable(),
		restartDesktop: (target, launch, flags) => restartDesktop(target, launch, flags),
		skipOnEnter: (onListen) => abortOnEnter(DESKTOP_SKIP_AFTER_MS, onListen),
		ask: (question) => askYesNo(question),
		askPath: askInstallPath,
		resolveRoot: gitWorktreeRoot,
		preflightScope: (targets, scope) => preflightInstallScope(targets, { scope }),
		choose: (title, labels) => pickOption(title, labels),
		startAgent,
		write: printLines,
		latest: fetchLatestVersion,
		updateNotice: installUpdateNotice,
		nativeFeedHooks: syncNativeFeedHooks,
		bootstrapFeed: bootstrapLegacyFeedSignIn,
		localAnalyzer: installedLocalAnalyzer,
		freshRuntimeClients,
		verifiedRuntimeClients: verifiedCodingClients,
		runtimeIntent: automaticRuntimeIntent,
		enableRuntime: enableInstalledRuntime,
		attachRuntime: attachInstalledRuntime,
		disableRuntime,
		...options.dependencies,
	};
}

/**
 * Where the install activates and which clients it targets, or the exit status
 * when it stops first: no client to connect (1), a cancelled scope picker (0),
 * overlapping hook or plugin settings (1), or no available client (1).
 */
async function planInstall(
	options: InstallOptions,
	dependencies: InstallDependencies,
): Promise<InstallPlan | number> {
	const write = dependencies.write;
	// Nothing here to connect (an agent's cloud sandbox, say): stop before sign-in and before
	// any download, and say so in words the agent relays (VISION.md § Two screens).
	const discovered = dependencies.discover();
	if (!discovered.length) {
		write(...NO_AGENT_HERE);
		return 1;
	}
	const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
	const scope = await resolveInstallScope({
		kind: options.scope,
		path: options.path,
		cwd: options.cwd,
		interactive,
		choose: dependencies.choose,
		askPath: dependencies.askPath,
		resolveRoot: dependencies.resolveRoot,
		write,
	});
	if (!scope) return 0;
	const targets = scopeInstallTargets(discovered, scope);
	// Unsupported clients are reported by configure, but cannot overlap an installation
	// that will not activate them. Do not let their unrelated settings block this scope.
	const activeTargets = targets.filter(
		(target) => !target.unavailableReason && !target.ambiguousReason,
	);
	const plan: InstallPlan = { options, dependencies, interactive, scope, targets, activeTargets };
	if (await reportConflicts(plan)) return 1;
	if (targets.every((target) => target.unavailableReason || target.ambiguousReason)) {
		for (const target of targets)
			write(
				`${CLIENT_LABELS[target.client]}: ${target.unavailableReason ?? target.ambiguousReason}`,
			);
		return 1;
	}
	return plan;
}

/** Whether hook or plugin settings overlap this scope's installation; each overlap is written. */
async function reportConflicts({
	options,
	dependencies,
	scope,
	activeTargets,
}: InstallPlan): Promise<boolean> {
	const write = dependencies.write;
	const conflicts = dependencies.preflightScope(activeTargets, scope);
	const extraConflicts = (await options.preflightScope?.(scope, activeTargets)) ?? [];
	if (!conflicts.length && !extraConflicts.length) return false;
	for (const conflict of conflicts)
		write(
			`${CLIENT_LABELS[conflict.client]}: ${conflict.detail}`,
			...(conflict.recovery ? [conflict.recovery] : []),
		);
	write(...extraConflicts);
	return true;
}

/** Sign in, configure every client, set up hooks and analytics, then write the summary and the next step. */
async function install(plan: InstallPlan, ui: InstallUi, signal: AbortSignal): Promise<number> {
	const { options, dependencies, scope, targets } = plan;
	// The runtime and the newest version need no sign-in, so both start now and the
	// install waits only for what's left.
	const runtime = startRuntime(dependencies, ui, signal);
	const latestVersion = dependencies.latest();
	if (options.skipRuntime && !(await disableRuntimeAnalytics(dependencies))) return 1;
	const migrateLegacy = await legacyMigrationConsent(plan);
	const runtimeInstallations = runtimeEnrollments(plan);
	const { credentials, runtimeApprovals, reused } = await dependencies.authenticate(
		options.server,
		runtimeInstallations,
	);
	const launch = await runtimeAfterSignIn(plan, ui, runtime);
	// Registrations and hooks name the launcher, so a later update changes no client setting.
	const launcher = await dependencies.launcher(launch);
	const configuredLaunch = launchFor(plan, launch, launcher);
	if (await reportConflicts(plan)) return 1;
	const outcomes = dependencies.configure(targets, configuredLaunch, {
		migrateLegacy,
		scope,
		nativeFeed: true,
	});
	const desktopRestarted = await restartOpenDesktop(
		plan,
		ui,
		outcomes,
		configuredLaunch,
		migrateLegacy,
	);
	const codingClients = codingClientsOf(outcomes);
	const extras = await runAfterConfigure(plan, credentials, codingClients);
	const run: ConnectedInstall = {
		...plan,
		ui,
		credentials,
		runtimeApprovals,
		reused,
		runtimeInstallations,
		launch,
		launcher,
		configuredLaunch,
		outcomes,
		codingClients,
		notes: extras.notes,
	};
	await installHooks(run);
	// Existing setup decides Claude tool permissions before runtime hooks can create settings.json.
	// Both clients publish through the same private runtime lock.
	for (const { client } of runtimeInstallations) await activateRuntimeAnalytics(run, client);
	await attachRuntimeAnalytics(run);

	ui.progress.stop();
	const connected = writeSummary(run);
	const latest = await latestVersion;
	if (latest && isNewerVersion(latest, getPackageVersion())) {
		dependencies.write(`Pharaoh ${latest} is available: ${UPGRADE_COMMAND}`);
	}
	const status =
		extras.extrasFailed ||
		outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "ambiguous")
			? 1
			: 0;
	await nextStep(run, connected, desktopRestarted);
	return status;
}

/**
 * Start preparing the runtime. Until sign-in ends, its progress and notes are
 * held back so the sign-in prompt stays clean.
 */
function startRuntime(
	dependencies: InstallDependencies,
	ui: InstallUi,
	signal: AbortSignal,
): Promise<LaunchConfig> {
	const write = dependencies.write;
	const runtime = dependencies.runtime(
		(version) => {
			ui.installing = version;
			if (ui.signedIn) ui.progress.step(`Installing Pharaoh ${version}`);
		},
		(message) => (ui.signedIn ? write(message) : ui.held.push(message)),
		signal,
	);
	// Awaited after sign-in; a failure before then must not go unhandled.
	runtime.then(
		() => {
			ui.runtimeReady = true;
		},
		() => {},
	);
	return runtime;
}

/** --skip-runtime: turn runtime analytics off for every client. False when a choice could not be saved. */
async function disableRuntimeAnalytics(dependencies: InstallDependencies): Promise<boolean> {
	const stopped = await Promise.allSettled(
		RUNTIME_CLIENTS.map(async (client) => dependencies.disableRuntime(client)),
	);
	const results = stopped.map((result) =>
		result.status === "fulfilled" ? result.value : "not_saved",
	);
	for (const [index, client] of RUNTIME_CLIENTS.entries())
		dependencies.write(describeRuntimeDisable(client, results[index]));
	return !results.includes("not_saved");
}

/** Whether to move existing pinned NPX connections to the managed runtime: --migrate-legacy, or asked. */
async function legacyMigrationConsent({
	options,
	dependencies,
	interactive,
	targets,
}: InstallPlan): Promise<boolean> {
	const write = dependencies.write;
	const migrations = dependencies.migrations(targets);
	let migrateLegacy = options.migrateLegacy === true;
	if (!migrations.length || migrateLegacy) return migrateLegacy;
	write("Existing pinned NPX connections:");
	for (const item of migrations) {
		write(`  ${CLIENT_LABELS[item.client]}: ${item.launch.command} ${item.launch.args.join(" ")}`);
	}
	if (interactive) {
		migrateLegacy =
			(await dependencies.ask("Move these connections to Pharaoh's managed runtime? [Y/n] ")) ===
			true;
	}
	if (!migrateLegacy) {
		write(`Kept those pins. To migrate them: ${INSTALL_COMMAND} --migrate-legacy`);
	}
	return migrateLegacy;
}

/** The new managed clients that send runtime usage metadata by default, said once before sign-in. */
function runtimeEnrollments({
	options,
	dependencies,
	scope,
	targets,
}: InstallPlan): RuntimeEnrollmentIntent[] {
	let runtimeInstallations: RuntimeEnrollmentIntent[] = [];
	if (!options.skipRuntime && options.server === DEFAULT_SERVER) {
		try {
			runtimeInstallations = dependencies
				.freshRuntimeClients(targets, { scope })
				.flatMap((client) => {
					const intent = dependencies.runtimeIntent(client, { scope });
					return intent ? [intent] : [];
				});
		} catch {
			// Unavailable runtime metadata cannot prevent sign-in or setup.
		}
	}
	if (runtimeInstallations.length) {
		dependencies.write(
			"Eligible new managed clients send runtime usage metadata by default. No prompt or instruction text is sent.",
			`To turn it off, run ${INSTALL_COMMAND} --skip-runtime.`,
			"https://pharaoh.so/docs/use-pharaoh/what-we-measure#optional-runtime-analytics",
		);
	}
	return runtimeInstallations;
}

/** Once sign-in ends: the held notes, the progress line, and the prepared runtime. */
async function runtimeAfterSignIn(
	{ dependencies, targets }: InstallPlan,
	ui: InstallUi,
	runtime: Promise<LaunchConfig>,
): Promise<LaunchConfig> {
	ui.signedIn = true;
	if (ui.held.length) dependencies.write(...ui.held);
	// What's left shows as one line naming the step, erased before the summary.
	ui.progress = dependencies.progress();
	if (ui.installing && !ui.runtimeReady) ui.progress.step(`Installing Pharaoh ${ui.installing}`);
	const launch = await runtime;
	ui.progress.step(`Connecting ${listClients(targets)}`);
	return launch;
}

/** The launch registrations name: the launcher (or the runtime), the server and a Local scope's root. */
function launchFor(
	{ options, scope }: InstallPlan,
	launch: LaunchConfig,
	launcher: string | null,
): LaunchConfig {
	const runLaunch = launcher ? { command: launch.command, args: [launcher] } : launch;
	const serverArgv =
		options.serverArgv ?? (options.server === DEFAULT_SERVER ? [] : ["--server", options.server]);
	const serverLaunch = { ...runLaunch, args: [...runLaunch.args, ...serverArgv] };
	return scope.kind === "local"
		? {
				...serverLaunch,
				args: [...serverLaunch.args, "--install-scope", "local", "--install-root", scope.root],
			}
		: serverLaunch;
}

/**
 * An open Desktop saves its earlier settings over the change; restarted, it
 * keeps this one. Asks, then quits, registers and reopens it.
 * @returns Whether Desktop restarted onto the new registration.
 */
async function restartOpenDesktop(
	{ dependencies, interactive, targets }: InstallPlan,
	ui: InstallUi,
	outcomes: ClientOutcome[],
	configuredLaunch: LaunchConfig,
	migrateLegacy: boolean,
): Promise<boolean> {
	const opened = outcomes.findIndex((outcome) => outcome.desktopOpen);
	const desktopTarget = targets.find((target) => target.client === "claude-desktop");
	if (opened < 0 || !desktopTarget || !interactive || !dependencies.canRestartDesktop())
		return false;
	ui.progress.stop();
	let desktopRestarted = false;
	if (
		await dependencies.ask(
			"Claude Desktop is open and saves its earlier settings over this change. Restart it now? [Y/n] ",
		)
	) {
		ui.progress.step("Restarting Claude Desktop");
		// Desktop may ask to confirm, and a "no" there can't be seen from here: Enter ends the
		// wait, once a quit it doesn't question would have finished.
		const skip = dependencies.skipOnEnter(() => {
			const waiting = "Waiting for Claude Desktop to quit";
			// Where the line doesn't draw (TERM=dumb, stderr piped), Enter still works: say so once.
			if (ui.progress.visible) ui.progress.step(`${waiting} · Enter skips`);
			else dependencies.write(`${waiting}. Press Enter to skip.`);
		});
		try {
			// Desktop may write a legacy pin back as it quits; the consent to migrate it holds.
			const restarted = await dependencies.restartDesktop(desktopTarget, configuredLaunch, {
				migrateLegacy,
				signal: skip.signal,
			});
			if (restarted) outcomes[opened] = restarted;
			desktopRestarted = restarted !== null;
		} finally {
			skip.stop();
		}
	}
	// The rest of the setup, under the line it had before the question.
	ui.progress.step(`Connecting ${listClients(targets)}`);
	return desktopRestarted;
}

/** The coding clients (not Claude Desktop) whose registration is configured. */
function codingClientsOf(outcomes: ClientOutcome[]): ClientId[] {
	return outcomes
		.filter(
			(outcome) =>
				outcome.client !== "claude-desktop" &&
				(outcome.status === "configured" || outcome.status === "already-configured"),
		)
		.map((outcome) => outcome.client);
}

/** The caller's optional client setup: its notes, and whether it failed (a nonzero exit). */
async function runAfterConfigure(
	{ options, scope }: InstallPlan,
	credentials: Credentials,
	codingClients: ClientId[],
): Promise<{ notes: string[]; extrasFailed: boolean }> {
	const notes: string[] = [];
	try {
		await options.afterConfigure?.(
			credentials,
			codingClients,
			(...lines) => notes.push(...lines),
			scope,
		);
		return { notes, extrasFailed: false };
	} catch {
		notes.push(`Pharaoh: optional client setup could not finish. Retry ${INSTALL_COMMAND}.`);
		return { notes, extrasFailed: true };
	}
}

/**
 * The update notice, saved-worktree hooks and native feed hooks of the
 * connected coding clients, then the optional pilot delegation guidance.
 */
async function installHooks(run: ConnectedInstall): Promise<void> {
	const { options, dependencies, scope, configuredLaunch, codingClients } = run;
	const managedProxyRoot = dirname(dirname(run.launch.args[0]));
	// Looked up first: on Windows it also sets up the private-path check every hook settings write needs.
	const analyzer =
		options.server === DEFAULT_SERVER ? dependencies.localAnalyzer(managedProxyRoot) : undefined;
	if (options.server === DEFAULT_SERVER)
		await dependencies.updateNotice(
			codingClients.filter(
				(client): client is "claude-code" | "codex" =>
					client === "claude-code" || client === "codex",
			),
			configuredLaunch.command,
			{ scope },
		);
	if (analyzer) syncWorktreeHooks(run, managedProxyRoot);
	// The feed is independent of analyzer, memory, and runtime-analytics enrollment.
	if (process.platform === "win32" && codingClients.length)
		dependencies.write(
			"Native context updates are unavailable on Windows. Hosted queries remain available.",
		);
	const delegationTargets = await installFeedHooks(run, managedProxyRoot);
	if (options.offerNativeDelegation) await offerDelegation(run, delegationTargets);
}

/** Saved-worktree hooks for each verified coding client; a client whose hooks fail keeps hosted queries. */
function syncWorktreeHooks(run: ConnectedInstall, managedProxyRoot: string): void {
	const { options, dependencies, scope, launcher, configuredLaunch, codingClients } = run;
	const hookPath = launcher ?? join(managedProxyRoot, "runtime", "local-worktree-hook.mjs");
	const verified = dependencies.verifiedRuntimeClients({
		scope,
		runningLaunch: configuredLaunch,
		rejectProjectOverrides: true,
	});
	for (const client of verified) {
		if (!codingClients.includes(client)) continue;
		try {
			syncLocalWorktreeHooks(client, hookPath, {
				node: configuredLaunch.command,
				viaLauncher: launcher !== null,
				scope,
				...(options.server !== DEFAULT_SERVER ? { server: options.server } : {}),
			});
		} catch {
			dependencies.write(
				`${CLIENT_LABELS[client]}: saved-worktree hooks could not be configured. Hosted queries remain available.`,
			);
		}
	}
}

/** A coding client eligible for the pilot native delegation guidance. */
interface DelegationTarget {
	client: "codex" | "claude-code";
	version: string;
	/** Rechecked right before the offer. */
	eligible: () => boolean;
}

/**
 * Native feed hooks for each verified coding client with a feed registration.
 * A client whose hooks fail keeps hosted queries.
 * @returns The clients eligible for the pilot delegation guidance.
 */
async function installFeedHooks(
	run: ConnectedInstall,
	managedProxyRoot: string,
): Promise<DelegationTarget[]> {
	const { dependencies, scope, configuredLaunch, codingClients } = run;
	const feedClients = dependencies.verifiedRuntimeClients({
		scope,
		runningLaunch: configuredLaunch,
		rejectProjectOverrides: true,
	});
	const bootstrapped = new Set<string>();
	const delegationTargets: DelegationTarget[] = [];
	for (const outcome of run.outcomes) {
		const feed = outcome.nativeFeed;
		if (
			!feed ||
			outcome.client === "claude-desktop" ||
			!codingClients.includes(outcome.client) ||
			!feedClients.includes(outcome.client)
		)
			continue;
		try {
			const target = await installFeedHook(
				run,
				outcome.client,
				feed,
				managedProxyRoot,
				bootstrapped,
			);
			if (target) delegationTargets.push(target);
		} catch {
			dependencies.write(
				`${CLIENT_LABELS[outcome.client]}: native context hooks could not be configured. Hosted queries remain available.`,
			);
		}
	}
	return delegationTargets;
}

/**
 * One coding client's native feed hook, after carrying a reused sign-in into
 * its feed credentials. Throws when either can't be written.
 * @returns The client, when it's eligible for the pilot delegation guidance.
 */
async function installFeedHook(
	run: ConnectedInstall,
	client: "codex" | "claude-code",
	feed: NonNullable<ClientOutcome["nativeFeed"]>,
	managedProxyRoot: string,
	bootstrapped: Set<string>,
): Promise<DelegationTarget | undefined> {
	const { options, dependencies, scope, launcher, configuredLaunch } = run;
	const credentialsPath = join(feed.home, ".pharaoh", "credentials.json");
	if (run.reused && !bootstrapped.has(credentialsPath)) {
		await dependencies.bootstrapFeed(run.credentials, options.server, credentialsPath);
		bootstrapped.add(credentialsPath);
	}
	const hookPath = launcher ?? join(managedProxyRoot, "runtime", "native-feed-hook.mjs");
	const hookOptions = {
		node: configuredLaunch.command,
		viaLauncher: launcher !== null,
		home: feed.home,
		settingsPath: feed.settingsPath,
		registration: feed.registration,
		serverArgv: feed.serverArgv,
		scope,
	};
	dependencies.nativeFeedHooks(client, hookPath, hookOptions);
	if (!options.offerNativeDelegation || scope.kind !== "global") return undefined;
	const target = run.targets.find((target) => target.client === client && target.cli);
	if (
		!target?.version ||
		!TESTED_FEED_PROFILES.some(
			(profile) => profile.client === client && profile.version === target.version,
		)
	)
		return undefined;
	const eligible = () =>
		dependencies
			.verifiedRuntimeClients({
				scope,
				runningLaunch: configuredLaunch,
				requiredFeedRegistration: feed.registration,
				rejectProjectOverrides: true,
			})
			.includes(client) &&
		(client !== "codex" || codexHooksAllowed(target.path)) &&
		nativeFeedHooksReady(client, hookPath, hookOptions);
	return eligible() ? { client, version: target.version, eligible } : undefined;
}

/** Offer the pilot native delegation guidance to each client still eligible; its notes go in the summary. */
async function offerDelegation(
	{ options, notes }: ConnectedInstall,
	delegationTargets: DelegationTarget[],
): Promise<void> {
	if (delegationTargets.length === 0)
		notes.push("Pilot native delegation guidance requires an eligible managed Global CLI setup.");
	for (const { client, version, eligible } of delegationTargets) {
		try {
			if (!eligible()) continue;
			const note = await options.offerNativeDelegation?.(client, version, eligible);
			if (note) notes.push(note);
		} catch {
			// ALLOWED-CATCH: pilot consent cannot interrupt hosted or native feed setup.
			notes.push(`${CLIENT_LABELS[client]}: could not offer pilot native delegation guidance.`);
		}
	}
}

/** Whether a client's verified registration runs this proxy version against this server. */
function runtimeActivatable(
	{ options, dependencies, scope, configuredLaunch }: ConnectedInstall,
	client: "claude-code" | "codex",
): () => boolean {
	return () =>
		dependencies
			.verifiedRuntimeClients({
				scope,
				runningLaunch: configuredLaunch,
				requiredProxy: { minimumVersion: getPackageVersion(), server: options.server },
				rejectProjectOverrides: true,
			})
			.includes(client);
}

/** Enable runtime analytics for a client sign-in enrolled; a failure leaves its connection working. */
async function activateRuntimeAnalytics(
	run: ConnectedInstall,
	client: RuntimeEnrollmentIntent["client"],
): Promise<void> {
	const { options, dependencies, scope, credentials } = run;
	const label = CLIENT_LABELS[client];
	if (!run.outcomes.some((outcome) => outcome.client === client && outcome.created)) {
		dependencies.write(
			`${label}: runtime analytics skipped. Review the connection setup result below.`,
		);
		return;
	}
	const canActivate = runtimeActivatable(run, client);
	let activated = false;
	try {
		if (!canActivate()) {
			dependencies.write(
				`${label}: runtime analytics skipped. Review the client and project settings.`,
			);
			return;
		}
		const approval = run.runtimeApprovals?.find((entry) => entry.client === client);
		if (approval && credentials.runtime_session) {
			activated = await dependencies.enableRuntime(
				options.server,
				approval,
				credentials.runtime_session,
				canActivate,
				{ scope },
			);
		}
	} catch {
		// Analytics setup failures leave the working client connection available.
	}
	if (!activated)
		dependencies.write(
			`${label}: runtime analytics could not be enabled. Check --runtime-status or try --runtime-enable --client ${client}.`,
		);
}

/** Attach runtime analytics to the other managed coding clients; a failure is a note. */
async function attachRuntimeAnalytics(run: ConnectedInstall): Promise<void> {
	const { options, dependencies, scope } = run;
	if (options.skipRuntime || options.server !== DEFAULT_SERVER) return;
	for (const client of run.codingClients) {
		if (client !== "claude-code" && client !== "codex") continue;
		if (run.runtimeInstallations.some((intent) => intent.client === client)) continue;
		try {
			await dependencies.attachRuntime(client, runtimeActivatable(run, client), { scope });
		} catch {
			run.notes.push(
				`${CLIENT_LABELS[client]}: runtime analytics could not be attached. Check --runtime-status.`,
			);
		}
	}
}

/**
 * The summary: who's connected, a line per problem or needed action, the
 * notes, and the Codex hook trust when it's missing.
 * @returns The connected clients' outcomes.
 */
function writeSummary({
	dependencies,
	outcomes,
	notes,
	targets,
}: ConnectedInstall): ClientOutcome[] {
	const write = dependencies.write;
	const connected = outcomes.filter((outcome) => CONNECTED.has(outcome.status));
	if (connected.length) write(`✓ Connected to ${listClients(connected)}`);
	for (const outcome of outcomes) writeOutcome(outcome, write);
	if (notes.length) write(...notes);
	const codex = targets.find((target) => target.client === "codex");
	if (
		codex &&
		connected.some((outcome) => outcome.client === "codex") &&
		codexHookUntrusted(dirname(codex.path))
	)
		write("! Codex: trust the Pharaoh hook in /hooks");
	return connected;
}

/** One client's summary lines: its problem or its detail, then its recovery. */
function writeOutcome(outcome: ClientOutcome, write: InstallDependencies["write"]): void {
	const label = CLIENT_LABELS[outcome.client];
	const problem = PROBLEMS[outcome.status];
	// "…registration was kept." only restates the status; other details explain it.
	const detail = outcome.detail && !/ was kept\.$/.test(outcome.detail) ? outcome.detail : "";
	if (problem) write(`✗ ${label}: ${problem}.${detail ? ` ${detail}` : ""}`);
	else if (detail) write(`! ${label}: ${detail}`);
	if (outcome.recovery) write(`  ${outcome.recovery}`);
}

/**
 * The summary's last line: nothing connected, a restart after an agent's
 * update, or the next step (offering to start a connected agent CLI).
 */
async function nextStep(
	{ options, dependencies, scope, targets, reused }: ConnectedInstall,
	connected: ClientOutcome[],
	desktopRestarted: boolean,
): Promise<void> {
	const write = dependencies.write;
	if (!connected.length) {
		write(
			"No agent connected; your existing choices were kept.",
			`Shell queries: ${NPX_COMMAND} get_codebase_map --repo <name>`,
		);
		return;
	}
	// An agent that ran this update tells the person to restart; starting another agent is a first-setup step.
	if (reused && !(options.interactive ?? canStartAgent())) {
		write(`Restart ${listClients(connected)} to use Pharaoh ${getPackageVersion()}.`);
		return;
	}
	const agents: AgentLaunch[] = targets.flatMap((target) =>
		target.cli && connected.some((outcome) => outcome.client === target.client)
			? [
					{
						client: target.client,
						command: target.cli,
						args: [SETUP_TOOL_PROMPT],
						...(scope.kind === "local" ? { cwd: scope.root } : {}),
					},
				]
			: [],
	);
	const agent = await chooseAgent(
		agents,
		desktopNextStep(connected, desktopRestarted),
		options.interactive ?? canStartAgent(),
		dependencies,
	);
	if (agent && !(await dependencies.startAgent(agent))) {
		write(`Pharaoh: ${agent.command} could not start. Run: ${agentCommand(agent)}`);
	}
}

/** What to do in a connected Claude Desktop; a restarted one's outcome was written while it was closed, without desktopOpen. */
function desktopNextStep(
	connected: ClientOutcome[],
	desktopRestarted: boolean,
): "open" | "restart" | "rerun" | null {
	const desktop = connected.find((outcome) => outcome.client === "claude-desktop");
	if (!desktop) return null;
	if (desktop.desktopOpen) return "rerun";
	return desktop.status === "configured" && !desktopRestarted ? "restart" : "open";
}
