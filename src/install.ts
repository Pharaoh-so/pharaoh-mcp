/** One-command developer setup. Registration is separate from an answered tool call. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
	automaticRuntimeIntent,
	disableRuntime,
	type RuntimeDeviceApproval,
	type RuntimeEnrollmentIntent,
} from "../runtime/runtime-client.mjs";
import { syncLocalWorktreeHooks } from "../runtime/runtime-hooks.mjs";
import { RUNTIME_CLIENTS } from "../runtime/runtime-native.mjs";
import {
	pollForToken,
	printActivationPrompt,
	printAuthSuccess,
	requestDeviceCode,
} from "./auth.js";
import { type Credentials, readCredentials, saveAuthorizedCredentials } from "./credentials.js";
import {
	askChoice,
	askYesNo,
	DEFAULT_SERVER,
	INSTALL_COMMAND,
	NPX_COMMAND,
	printLines,
	resolveSseUrl,
	showProgress,
	tokenToCredentials,
} from "./helpers.js";
import type { ClientId, ClientOutcome, LaunchConfig } from "./install-types.js";
import { installedLocalAnalyzer } from "./local/worker-host.js";
import { loadAndRefresh } from "./refresh.js";
import { ensureRuntime, RuntimeSetupError, registryKey } from "./runtime.js";
import { describeRuntimeDisable, enableInstalledRuntime } from "./runtime-command.js";
import {
	type ClientTarget,
	configureClients,
	discoverClients,
	freshRuntimeClients,
	legacyMigrations,
	verifiedCodingClients,
} from "./setup.js";
import { SETUP_TOOL_PROMPT } from "./setup-prompt.generated.js";
import {
	fetchLatestVersion,
	getPackageVersion,
	isNewerVersion,
	UPGRADE_COMMAND,
} from "./version.js";

const LABELS: Record<ClientId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	"claude-desktop": "Claude Desktop",
};

/** Statuses the summary reports on their own line; the rest fold into "Connected to …". */
const PROBLEMS: Partial<Record<ClientOutcome["status"], string>> = {
	unavailable: "not available",
	ambiguous: "needs attention",
	failed: "setup failed",
};

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
		spawn(agent.command, agent.args, { stdio: "inherit", env })
			.once("error", () => done(false))
			.once("exit", () => done(true));
	});
}

/** "Claude Code", "Claude Code and Codex", "Claude Desktop, Claude Code and Codex". */
function listNames(outcomes: readonly ClientOutcome[]): string {
	const names = outcomes.map((outcome) => LABELS[outcome.client]);
	return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

/** The command a person can paste to start an agent with the setup prompt. */
function agentCommand(agent: AgentLaunch): string {
	return `${agent.command} ${agent.args.map((arg) => JSON.stringify(arg)).join(" ")}`;
}

/**
 * The next step, as the summary's last line. In a terminal it asks to start an
 * agent CLI with the setup prompt: [Y/n] for one, a numbered pick for several
 * (Enter = 1). Without a terminal it prints each agent's command. Claude Desktop
 * has no command to start, so it gets the request to send, as does a person
 * with no agent CLI.
 * @param desktop - What to do in a connected Claude Desktop (restart after a new registration).
 * @returns The agent the person chose to start, or null.
 */
async function chooseAgent(
	agents: AgentLaunch[],
	desktop: "open" | "restart" | null,
	interactive: boolean,
	{ ask, choose, write }: Pick<InstallDependencies, "ask" | "choose" | "write">,
): Promise<AgentLaunch | null> {
	const request = JSON.stringify(SETUP_TOOL_PROMPT);
	if (desktop) write(`Claude Desktop: ${desktop} it and ask ${request}`);
	else if (!agents.length) write(`Next: ask your agent ${request}`);
	if (!agents.length) return null;
	if (!interactive) {
		write(...agents.map((agent) => `Start: ${agentCommand(agent)}`));
		return null;
	}
	if (agents.length === 1) {
		const label = LABELS[agents[0].client];
		return (await ask(`Start ${label} with the setup prompt? [Y/n] `)) ? agents[0] : null;
	}
	const options = agents.map((agent, i) => `[${i + 1}] ${LABELS[agent.client]}`).join("  ");
	const picked = await choose(`Start with: ${options}  (Enter = 1, n = skip) `, agents.length);
	return picked ? agents[picked - 1] : null;
}

/** The part of Codex's hooks.json the trust check reads: event → groups → handlers. */
type CodexHooks = Record<string, Array<{ hooks?: Array<{ command?: unknown; args?: unknown }> }>>;

/** Pharaoh's hook commands: project memory, saved-worktree and runtime hooks. */
const PHARAOH_HOOK = /pharaoh-project-memory:|--pharaoh-(?:local-worktree|runtime)-v1/;

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

/** Reject a mistyped explicit install command before it can authorize or change settings. */
export function validateInstallArguments(args: readonly string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--server") {
			if (!args[i + 1] || args[i + 1].startsWith("--")) return "--server needs a URL.";
			i++;
		} else if (!["--migrate-legacy", "--memory-hooks", "--skip-runtime"].includes(args[i])) {
			return "Unknown install option. Run pharaoh-mcp install --help.";
		}
	}
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
			return { credentials: current.creds };
		}
		if (current && current.action !== "reauth") {
			throw new Error(
				"Sign-in could not be refreshed. Try again; your saved credentials were kept.",
			);
		}
	}

	const device = await requestDeviceCode(server, runtimeInstallations);
	printActivationPrompt(
		device.user_code,
		device.verification_uri,
		device.verification_uri_complete,
	);
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
	/** Prepare the runtime; `onInstall` fires only when a version has to be downloaded. */
	runtime: (onInstall: (version: string) => void) => Promise<LaunchConfig>;
	/** Show a transient progress line; the returned function erases it. */
	progress: (label: string) => () => void;
	configure: typeof configureClients;
	ask: (question: string) => Promise<boolean | null>;
	choose: (question: string, count: number) => Promise<number | null>;
	startAgent: (agent: AgentLaunch) => Promise<boolean>;
	write: (...lines: string[]) => void;
	latest: typeof fetchLatestVersion;
	freshRuntimeClients: typeof freshRuntimeClients;
	verifiedRuntimeClients: typeof verifiedCodingClients;
	runtimeIntent: typeof automaticRuntimeIntent;
	enableRuntime: typeof enableInstalledRuntime;
	disableRuntime: typeof disableRuntime;
}

/** Install hooks/skills only for coding clients whose enabled registration was verified. */
export interface InstallOptions {
	server: string;
	migrateLegacy?: boolean;
	skipRuntime?: boolean;
	/** Ask questions and offer to start an agent (default: canStartAgent()). */
	interactive?: boolean;
	/** Optional client setup. Lines passed to `note` show in the summary, after the client list. */
	afterConfigure?: (
		credentials: Credentials,
		clients: string[],
		note: (...lines: string[]) => void,
	) => Promise<void>;
	/** Isolated process/filesystem fixtures use the same orchestration without real user writes. */
	dependencies?: Partial<InstallDependencies>;
}

/**
 * Discover, authorize, prepare a pinned runtime, then configure every client independently.
 * A failed runtime never reaches a configuration writer. Partial successes are retained.
 * @returns A shell exit status; does not terminate the caller or mark onboarding complete.
 */
export async function runInstall(options: InstallOptions): Promise<number> {
	const dependencies: InstallDependencies = {
		discover: discoverClients,
		migrations: legacyMigrations,
		authenticate: authenticateInstall,
		runtime: (onInstall) => ensureRuntime({ onDiagnostic: printLines, onInstall }),
		progress: showProgress,
		configure: configureClients,
		ask: (question) => askYesNo(question),
		choose: (question, count) => askChoice(question, count),
		startAgent,
		write: printLines,
		latest: fetchLatestVersion,
		freshRuntimeClients,
		verifiedRuntimeClients: verifiedCodingClients,
		runtimeIntent: automaticRuntimeIntent,
		enableRuntime: enableInstalledRuntime,
		disableRuntime,
		...options.dependencies,
	};
	const write = dependencies.write;
	try {
		if (options.skipRuntime) {
			const stopped = await Promise.allSettled(
				RUNTIME_CLIENTS.map(async (client) => dependencies.disableRuntime(client)),
			);
			const results = stopped.map((result) =>
				result.status === "fulfilled" ? result.value : "not_saved",
			);
			for (const [index, client] of RUNTIME_CLIENTS.entries())
				write(describeRuntimeDisable(client, results[index]));
			if (results.includes("not_saved")) return 1;
		}
		const targets = dependencies.discover();
		const migrations = dependencies.migrations(targets);
		let migrateLegacy = options.migrateLegacy === true;
		if (migrations.length && !migrateLegacy) {
			write("Existing pinned NPX connections:");
			for (const item of migrations) {
				write(`  ${LABELS[item.client]}: ${item.launch.command} ${item.launch.args.join(" ")}`);
			}
			if (options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY)) {
				migrateLegacy =
					(await dependencies.ask(
						"Move these connections to Pharaoh's managed runtime? [Y/n] ",
					)) === true;
			}
			if (!migrateLegacy) {
				write(`Kept those pins. To migrate them: ${INSTALL_COMMAND} --migrate-legacy`);
			}
		}

		let runtimeInstallations: RuntimeEnrollmentIntent[] = [];
		if (!options.skipRuntime && options.server === DEFAULT_SERVER) {
			try {
				runtimeInstallations = dependencies.freshRuntimeClients(targets).flatMap((client) => {
					const intent = dependencies.runtimeIntent(client);
					return intent ? [intent] : [];
				});
			} catch {
				// Unavailable runtime metadata cannot prevent sign-in or setup.
			}
		}
		if (runtimeInstallations.length) {
			write(
				"Eligible new managed clients send runtime usage metadata by default. No prompt or instruction text is sent.",
				`To turn it off, run ${INSTALL_COMMAND} --skip-runtime.`,
				"https://pharaoh.so/docs/use-pharaoh/what-we-measure#optional-runtime-analytics",
			);
		}
		const { credentials, runtimeApprovals } = await dependencies.authenticate(
			options.server,
			runtimeInstallations,
		);
		// A new version downloads for several seconds after "Signed in"; say so instead of
		// looking frozen. The line is erased before anything else prints.
		let stopProgress = () => {};
		let launch: LaunchConfig;
		try {
			launch = await dependencies.runtime((version) => {
				stopProgress();
				stopProgress = dependencies.progress(`Installing Pharaoh ${version} (once per update)…`);
			});
		} finally {
			stopProgress();
		}
		const configuredLaunch =
			options.server === DEFAULT_SERVER
				? launch
				: { ...launch, args: [...launch.args, "--server", options.server] };
		const outcomes = dependencies.configure(targets, configuredLaunch, { migrateLegacy });
		const codingClients = outcomes
			.filter(
				(outcome) =>
					outcome.client !== "claude-desktop" &&
					(outcome.status === "configured" || outcome.status === "already-configured"),
			)
			.map((outcome) => outcome.client);
		let extrasFailed = false;
		const notes: string[] = [];
		try {
			await options.afterConfigure?.(credentials, codingClients, (...lines) =>
				notes.push(...lines),
			);
		} catch {
			extrasFailed = true;
			notes.push(`Pharaoh: optional client setup could not finish. Retry ${INSTALL_COMMAND}.`);
		}
		const managedProxyRoot = dirname(dirname(launch.args[0]));
		if (options.server === DEFAULT_SERVER && installedLocalAnalyzer(managedProxyRoot)) {
			const hookPath = join(managedProxyRoot, "runtime", "local-worktree-hook.mjs");
			const verified = dependencies.verifiedRuntimeClients({
				runningLaunch: configuredLaunch,
				rejectProjectOverrides: true,
			});
			for (const client of verified) {
				if (!codingClients.includes(client)) continue;
				try {
					syncLocalWorktreeHooks(client, hookPath, { node: configuredLaunch.command });
				} catch {
					write(
						`${LABELS[client]}: saved-worktree hooks could not be configured. Hosted queries remain available.`,
					);
				}
			}
		}
		// Existing setup decides Claude tool permissions before runtime hooks can create settings.json.
		// Both clients publish through the same private runtime lock.
		for (const { client } of runtimeInstallations) {
			const label = LABELS[client];
			if (!outcomes.some((outcome) => outcome.client === client && outcome.created)) {
				write(`${label}: runtime analytics skipped. Review the connection setup result below.`);
				continue;
			}
			const canActivate = () =>
				dependencies
					.verifiedRuntimeClients({
						runningLaunch: configuredLaunch,
						requiredProxy: { minimumVersion: getPackageVersion(), server: options.server },
						rejectProjectOverrides: true,
					})
					.includes(client);
			let activated = false;
			try {
				if (!canActivate()) {
					write(`${label}: runtime analytics skipped. Review the client and project settings.`);
					continue;
				}
				const approval = runtimeApprovals?.find((entry) => entry.client === client);
				if (approval && credentials.runtime_session) {
					activated = await dependencies.enableRuntime(
						options.server,
						approval,
						credentials.runtime_session,
						canActivate,
					);
				}
			} catch {
				// Analytics setup failures leave the working client connection available.
			}
			if (!activated)
				write(
					`${label}: runtime analytics could not be enabled. Check --runtime-status or try --runtime-enable --client ${client}.`,
				);
		}

		// The summary: who's connected, a line per problem or needed action, then
		// the next step as the last line. Everything else stays quiet.
		const connected = outcomes.filter((outcome) => CONNECTED.has(outcome.status));
		if (connected.length) write(`✓ Connected to ${listNames(connected)}`);
		for (const outcome of outcomes) {
			const label = LABELS[outcome.client];
			const problem = PROBLEMS[outcome.status];
			// "…registration was kept." only restates the status; other details explain it.
			const detail = outcome.detail && !/ was kept\.$/.test(outcome.detail) ? outcome.detail : "";
			if (problem) write(`✗ ${label}: ${problem}.${detail ? ` ${detail}` : ""}`);
			else if (detail) write(`! ${label}: ${detail}`);
			if (outcome.recovery) write(`  ${outcome.recovery}`);
		}
		if (notes.length) write(...notes);
		const codex = targets.find((target) => target.client === "codex");
		if (
			codex &&
			connected.some((outcome) => outcome.client === "codex") &&
			codexHookUntrusted(dirname(codex.path))
		)
			write("! Codex: trust the Pharaoh hook in /hooks");
		const latest = await dependencies.latest();
		if (latest && isNewerVersion(latest, getPackageVersion())) {
			write(`Pharaoh ${latest} is available: ${UPGRADE_COMMAND}`);
		}
		const status =
			extrasFailed ||
			outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "ambiguous")
				? 1
				: 0;

		if (!connected.length) {
			write(
				"No agent connected; your existing choices were kept.",
				`Shell queries: ${NPX_COMMAND} get_codebase_map --repo <name>`,
			);
			return status;
		}
		const agents: AgentLaunch[] = targets.flatMap((target) =>
			target.cli && connected.some((outcome) => outcome.client === target.client)
				? [{ client: target.client, command: target.cli, args: [SETUP_TOOL_PROMPT] }]
				: [],
		);
		const desktop = connected.find((outcome) => outcome.client === "claude-desktop");
		const agent = await chooseAgent(
			agents,
			desktop ? (desktop.status === "configured" ? "restart" : "open") : null,
			options.interactive ?? canStartAgent(),
			dependencies,
		);
		if (agent && !(await dependencies.startAgent(agent))) {
			write(`Pharaoh: ${agent.command} could not start. Run: ${agentCommand(agent)}`);
		}
		return status;
	} catch (error) {
		// Never print native process errors: npm output/configuration may contain registry secrets.
		if (error instanceof RuntimeSetupError) write(`Pharaoh: ${error.message}`);
		write(`Pharaoh: installation could not finish. Retry ${INSTALL_COMMAND}.`);
		return 1;
	}
}
