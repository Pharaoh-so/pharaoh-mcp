#!/usr/bin/env node
/**
 * @pharaoh-so/mcp — Stdio-to-SSE proxy for headless MCP environments.
 *
 * Presents as an MCP server on stdio (for Claude Code) and relays messages
 * to a remote Pharaoh SSE server. Authenticates via RFC 8628 device flow
 * so the user can authorize on any device with a browser.
 *
 * Two modes determined by whether stdin is a TTY:
 * - Interactive (TTY): authenticate, print setup instructions, exit.
 * - Proxy (pipe):      bridge stdio ↔ SSE. No valid creds? Run in auth-required
 *                      mode until device flow completes, then swap to SSE in
 *                      place — the stdio session never disconnects.
 */
import { fileURLToPath } from "node:url";
import { memoryScopeMatches, setMemoryInstallScope } from "../project-memory/install-scope.mjs";
import { resetHookPreferences, setMemoryCapture } from "../project-memory/preferences.mjs";
import {
	applyMemoryHookChoices,
	chooseMemoryHooks,
	configureChangeReview,
	syncMemoryHooks,
} from "../project-memory/setup.mjs";
import { AuthRequiredBackend, createSseBackend } from "./backend.js";
import { type Credentials, readCredentials, takeCredentialsForLogout } from "./credentials.js";
import { createGateway } from "./gateway.js";
import {
	askYesNo,
	askYesNoInTerminal,
	formatTtl,
	parseArgs,
	printLines,
	printUsage,
} from "./helpers.js";
import { gitWorktreeRoot, installScopeArguments } from "./install-scope.js";
import {
	allowReadTools,
	describeAgentInstructionOutcome,
	describeAllowReadTools,
	offerAgentInstructionLines,
	offerNativeDelegationGuidance,
	runInstallSkills,
} from "./install-skills.js";
import type { ClientId, InstallScope } from "./install-types.js";
import { handleRefreshFailure, tryMidSessionRefresh } from "./lifecycle.js";
import { updateMemoryHint } from "./memory-hint.js";
import { NativeFeedRuntime } from "./native-feed.js";
import { TenantSuspendedError, TokenExpiredError } from "./proxy.js";
import { type ProxyServer, startInAuthRequiredMode, startInSseMode } from "./proxy-server.js";
import { loadAndRefresh } from "./refresh.js";
import { getPackageVersion, runningEntry } from "./version.js";

const BANNER = [
	"",
	"  ___  _  _   _   ___    _    ___  _  _ ",
	" | _ \\| || | /_\\ | _ \\  /_\\  / _ \\| || |",
	" |  _/| __ |/ _ \\|   / / _ \\| (_) | __ |",
	" |_|  |_||_/_/ \\_\\_|_\\/_/ \\_\\\\___/|_||_|",
	"",
].join("\n");

function reportMemorySetup(options?: Parameters<typeof syncMemoryHooks>[0]): boolean {
	try {
		const notices = syncMemoryHooks(options);
		if (notices.length) printLines(...notices);
		return notices.length === 0;
	} catch {
		printLines("Pharaoh: project memory setup could not update local activation.");
		return false;
	}
}

function clearMemoryHookChoices(disable: boolean): boolean {
	try {
		resetHookPreferences(disable);
		return true;
	} catch {
		printLines("Pharaoh: could not update local project memory choices.");
		return false;
	}
}

async function setupMemoryHooks(
	credentials: Credentials,
	clients: string[],
	requested: boolean,
	note: (...lines: string[]) => void,
	scope?: InstallScope,
) {
	try {
		if (requested) setMemoryCapture(true);
		const decision = await chooseMemoryHooks({
			credentials,
			clients,
			requested,
			scope,
			ask: askYesNoInTerminal,
		});
		// Memory runs on its own (DECIDED 2026-11-10: hands-off), so install reports only its
		// failures, which start "Pharaoh:". The Codex trust step is the summary's own check.
		const notices = applyMemoryHookChoices(decision, { credentials, scope });
		note(...notices.filter((notice) => notice.startsWith("Pharaoh:")));
	} catch {
		note("Pharaoh: could not finish local project memory setup. MCP remains available.");
	}
}

/** What a cleanup says when it can't read the installation record. */
const RECORD_UNREADABLE =
	"Pharaoh: the installation record could not be read; managed cleanup could not be verified.";

/** Explicit reset retains its old broad Claude cleanup; logout removes managed connections only. */
async function cleanupClientRegistrations(reset: boolean): Promise<boolean> {
	const { cleanCodexSetup, cleanupManagedClients, cleanSlate } = await import("./setup.js");
	let outcomes: ReturnType<typeof cleanupManagedClients> = [];
	let provenanceFailed = false;
	try {
		outcomes = cleanupManagedClients();
	} catch {
		printLines(RECORD_UNREADABLE);
		provenanceFailed = true;
	}
	if (reset) cleanSlate();
	cleanCodexSetup();
	if (!(await cleanupClientHooks())) provenanceFailed = true;
	const unresolved = outcomes.filter(
		(outcome) => outcome.status === "failed" || outcome.status === "ambiguous",
	);
	for (const outcome of unresolved) {
		printLines(
			`Pharaoh: ${outcome.client} cleanup needs attention. ${outcome.recovery ?? "Retry the install command."}`,
		);
	}
	return !provenanceFailed && !unresolved.length;
}

/**
 * Remove both coding clients' native context, saved-worktree and update notice
 * hooks, where this platform supports local cleanup.
 * @returns False when a hook's cleanup needs attention.
 */
async function cleanupClientHooks(): Promise<boolean> {
	const localCleanupSupported =
		typeof process.getuid === "function" ||
		(process.platform === "win32" &&
			Boolean((await import("./local/worker-host.js")).installedLocalAnalyzer()));
	if (!localCleanupSupported) return true;
	const { syncNativeFeedHooks } = await import("../runtime/feed-hooks.mjs");
	const { syncLocalWorktreeHooks, syncUpdateNoticeHook } = await import(
		"../runtime/runtime-hooks.mjs"
	);
	let cleaned = true;
	for (const client of ["claude-code", "codex"] as const) {
		const cleanups: [() => void, string][] = [
			[
				() => syncNativeFeedHooks(client, null),
				"Pharaoh: native context hook cleanup needs attention.",
			],
			[
				() => syncLocalWorktreeHooks(client, null),
				"Pharaoh: saved-worktree hook cleanup needs attention.",
			],
			[
				() => syncUpdateNoticeHook(client, null),
				"Pharaoh: update notice hook cleanup needs attention.",
			],
		];
		for (const [cleanup, failure] of cleanups) {
			try {
				cleanup();
			} catch {
				printLines(failure);
				cleaned = false;
			}
		}
	}
	return cleaned;
}

/** Remove one owned activation boundary without clearing sign-in or another checkout. */
async function cleanupInstallScope(scope: InstallScope, client: ClientId): Promise<boolean> {
	const { cleanupManagedClients } = await import("./setup.js");
	if (client === "claude-desktop") return cleanupDesktopScope(scope, cleanupManagedClients);
	const { cleanupInstallExtras } = await import("./install-skills.js");
	const { detachRuntimeTarget } = await import("../runtime/runtime-client.mjs");
	const { syncNativeFeedHooks } = await import("../runtime/feed-hooks.mjs");
	const { syncLocalWorktreeHooks, syncUpdateNoticeHook } = await import(
		"../runtime/runtime-hooks.mjs"
	);
	const notices = syncMemoryHooks({ clients: [client], scope });
	notices.push(...cleanupInstallExtras(scope, [client]));
	let runtimeCleaned = false;
	try {
		runtimeCleaned = await detachRuntimeTarget(client, { scope });
		syncNativeFeedHooks(client, null, { scope });
		syncLocalWorktreeHooks(client, null, { scope });
		syncUpdateNoticeHook(client, null, { scope });
		if (!runtimeCleaned)
			notices.push(
				"Pharaoh: runtime revocation or hook cleanup is pending. Retry this cleanup after signing in to the original server.",
			);
	} catch {
		notices.push("Pharaoh: scoped runtime cleanup needs attention. Retry the cleanup command.");
	}
	let outcomes: ReturnType<typeof cleanupManagedClients>;
	try {
		outcomes = cleanupManagedClients({ scope, client });
	} catch {
		notices.push(RECORD_UNREADABLE);
		printLines(...notices);
		return false;
	}
	for (const outcome of outcomes)
		if (!["configured", "already-configured"].includes(outcome.status))
			notices.push(outcome.recovery ?? "Pharaoh: scoped registration cleanup needs attention.");
	if (notices.length) printLines(...notices);
	return runtimeCleaned && !notices.length;
}

/** Claude Desktop's part of a scoped cleanup: its registration only. */
function cleanupDesktopScope(
	scope: InstallScope,
	cleanupManagedClients: typeof import("./setup.js").cleanupManagedClients,
): boolean {
	let outcomes: ReturnType<typeof cleanupManagedClients>;
	try {
		outcomes = cleanupManagedClients({ scope, client: "claude-desktop" });
	} catch {
		printLines(RECORD_UNREADABLE);
		return false;
	}
	const unresolved = outcomes.filter(
		(outcome) => !["configured", "already-configured"].includes(outcome.status),
	);
	for (const outcome of unresolved)
		printLines(outcome.detail ?? "Pharaoh: Desktop cleanup needs attention.");
	return unresolved.length === 0;
}

/** The scoped cleanup command's usage line, said for any argument it doesn't accept. */
const CLEANUP_USAGE =
	"Use cleanup --client claude-code|codex --scope global|local [--path <repo>].";

/** Validate the explicit scoped removal command before doing any filesystem work. */
async function runScopedCleanup(args: string[]): Promise<void> {
	const { scope, client } = cleanupArguments(args);
	process.exitCode = (await cleanupInstallScope(scope, client)) ? 0 : 1;
	if (!process.exitCode)
		printLines("Pharaoh: selected installation removed. Restart the client to unload it.");
}

/** The cleanup command's client and scope; throws when the arguments don't name them. */
function cleanupArguments(args: string[]): { scope: InstallScope; client: ClientId } {
	if (!cleanupOptionsPaired(args)) throw new Error(CLEANUP_USAGE);
	const { kind, path } = installScopeArguments(args);
	const client = args[args.indexOf("--client") + 1];
	if (!kind || !args.includes("--client") || !isClientId(client) || (kind === "global" && path))
		throw new Error(CLEANUP_USAGE);
	return { scope: cleanupScope(kind, path, client), client };
}

/** Whether every argument is --scope, --path or --client followed by its value. */
function cleanupOptionsPaired(args: string[]): boolean {
	for (let i = 0; i < args.length; i += 2)
		if (
			!["--scope", "--path", "--client"].includes(args[i]) ||
			!args[i + 1] ||
			args[i + 1].startsWith("--")
		)
			return false;
	return true;
}

/** Whether `client` names a client a cleanup can target. */
function isClientId(client: string | undefined): client is ClientId {
	return client === "claude-code" || client === "codex" || client === "claude-desktop";
}

/** The scope a cleanup removes; a Local one needs a coding client and a Git checkout. */
function cleanupScope(
	kind: InstallScope["kind"],
	path: string | undefined,
	client: ClientId,
): InstallScope {
	if (kind === "global") return { kind };
	const root = gitWorktreeRoot(path ?? process.cwd());
	if (client === "claude-desktop" || !root)
		throw new Error("Local cleanup needs a supported coding client and Git checkout.");
	return { kind, root };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const explicitInstall = args[0] === "install";
	if (explicitInstall) args.shift();
	if (!explicitInstall && (await runSubcommand(args))) return;
	if (await runFlagCommand(args)) return;

	const { server, serverArgv, feedClient, feedRegistration, logout } = parseArgs(args);
	if (logout) return signOut();

	// ── Interactive mode (user running in a terminal) ──
	// The explicit command also works on a pipe; the bare TTY command stays an alias.
	const isInteractive = explicitInstall || Boolean(process.stdin.isTTY);
	if (isInteractive) return runInteractiveInstall(args, explicitInstall, server, serverArgv);
	return runProxy(args, { server, serverArgv, feedClient, feedRegistration });
}

/** `update`, `cleanup`, or a question tool's name (the shell CLI). False when the arguments start with none of them. */
async function runSubcommand(args: string[]): Promise<boolean> {
	if (args[0] === "update") {
		const { runUpdateCommand } = await import("./update.js");
		process.exitCode = await runUpdateCommand(args.slice(1));
		return true;
	}
	if (args[0] === "cleanup") {
		await runScopedCleanup(args.slice(1));
		return true;
	}
	if (args[0] && !args[0].startsWith("-")) {
		const { runCli } = await import("./cli.js");
		await runCli(args);
		return true;
	}
	return false;
}

/** A command a flag selects: whether the arguments ask for it, and what it does. */
interface FlagCommand {
	applies: (args: string[]) => boolean;
	run: (args: string[]) => Promise<void> | void;
}

/** The commands flags select, checked in this order: the first that applies runs, and the CLI stops. */
const FLAG_COMMANDS: FlagCommand[] = [
	{
		applies: (args) => args.includes("--help") || args.includes("-h"),
		run: () => {
			printUsage();
			process.exit(0);
		},
	},
	{
		// Stdout, alone on its line, so a script can capture the version to pin
		applies: (args) => args.includes("--version") || args.includes("-v"),
		run: () => {
			process.stdout.write(`${getPackageVersion()}\n`);
		},
	},
	{ applies: (args) => args.includes("--doctor"), run: runDoctor },
	{ applies: (args) => args.some((arg) => arg.startsWith("--runtime-")), run: runRuntime },
	{
		// Inspect mode — serve tool schemas over stdio for Glama directory inspection
		applies: (args) => args.includes("--inspect"),
		run: async () => {
			const { runInspect } = await import("./inspect.js");
			await runInspect();
		},
	},
	{
		// Install-skills mode — copy bundled skills to ~/.openclaw/skills/
		applies: (args) => args.includes("--install-skills"),
		run: async () => {
			const { runInstallSkills } = await import("./install-skills.js");
			runInstallSkills();
		},
	},
	{
		applies: (args) =>
			args.includes("--enable-change-review") || args.includes("--disable-change-review"),
		run: runChangeReview,
	},
	{ applies: (args) => args.includes("--disable-memory-capture"), run: disableMemoryCapture },
	{ applies: (args) => args.includes("--undo-memory"), run: undoMemory },
	{
		applies: (args) => args.includes("--disable-memory-hooks"),
		run: () => {
			const saved = clearMemoryHookChoices(true);
			if (!reportMemorySetup() || !saved) process.exitCode = 1;
		},
	},
	{ applies: (args) => nativeContextSwitches(args).length > 0, run: runNativeContextSwitch },
	{
		applies: (args) => args.includes("--native-context-status"),
		run: async () => {
			const { nativeFeedStatus } = await import("./native-feed-status.js");
			process.stdout.write(`${JSON.stringify(nativeFeedStatus(), null, 2)}\n`);
		},
	},
	{
		// Clean mode — remove all pharaoh traces from Claude Code config (MCP entries,
		// disabled states, project-scoped configs). Useful for resetting broken installs.
		applies: (args) => args.includes("--clean"),
		run: runClean,
	},
];

/** Run the first flag command that applies. False when none does. */
async function runFlagCommand(args: string[]): Promise<boolean> {
	const command = FLAG_COMMANDS.find(({ applies }) => applies(args));
	if (!command) return false;
	await command.run(args);
	return true;
}

/** --doctor: the local setup's diagnosis, for one client with --client. */
async function runDoctor(args: string[]): Promise<void> {
	const { diagnoseLocalSetup, renderLocalSetupDiagnosis } = await import("./doctor.js");
	const clientFlag = args.indexOf("--client");
	const clientName = clientFlag >= 0 ? args[clientFlag + 1] : undefined;
	process.stdout.write(`${renderLocalSetupDiagnosis(diagnoseLocalSetup({ clientName }))}\n`);
}

/** --runtime-*: the local runtime commands; a failure says only that setup could not finish. */
async function runRuntime(args: string[]): Promise<void> {
	try {
		const { runRuntimeCommand } = await import("./runtime-command.js");
		process.exitCode = await runRuntimeCommand(args);
	} catch {
		printLines(
			"Pharaoh: local runtime setup could not finish. Check the private setup state and retry.",
		);
		process.exitCode = 1;
	}
}

/** --enable-change-review / --disable-change-review, for Claude Code in a Global or Local scope. */
async function runChangeReview(args: string[]): Promise<void> {
	const refusal = changeReviewRefusal(args);
	if (refusal) {
		printLines(refusal);
		process.exitCode = 2;
		return;
	}
	const scope = changeReviewScope(args);
	setMemoryInstallScope(scope);
	const enabled = args.includes("--enable-change-review");
	try {
		const notices = configureChangeReview(enabled, {
			credentials: readCredentials() ?? undefined,
			scope,
		});
		printLines(
			enabled
				? "Pharaoh: automatic change review is on for this Claude Code installation. Restart Claude Code to load its hooks."
				: "Pharaoh: automatic change review is off for this installation.",
			...notices,
		);
	} catch (error) {
		printLines(
			`Pharaoh: ${error instanceof Error ? error.message : "Could not update change review."}`,
		);
		process.exitCode = 1;
	}
}

/** Why a change review command can't run: both switches, or a client other than Claude Code. */
function changeReviewRefusal(args: string[]): string | null {
	if (args.includes("--enable-change-review") && args.includes("--disable-change-review"))
		return "Pharaoh: choose enable or disable change review, not both.";
	const clientIndex = args.indexOf("--client");
	if (clientIndex >= 0 && args[clientIndex + 1] !== "claude-code")
		return "Pharaoh: change review currently supports Claude Code only.";
	return null;
}

/** The scope a change review command applies to; a Local one needs a Git checkout. */
function changeReviewScope(args: string[]): InstallScope {
	const selected = installScopeArguments(args);
	if (selected.kind !== "local") return { kind: "global" };
	const root = gitWorktreeRoot(selected.path ?? process.cwd());
	if (!root) throw new Error("Local review needs a Git checkout.");
	return { kind: "local", root };
}

/** --disable-memory-capture: turn automatic project memory saving off. */
function disableMemoryCapture(): void {
	try {
		setMemoryCapture(false);
		printLines(
			"Pharaoh: automatic project memory saving is off. Run `npx @pharaoh-so/mcp install --memory-hooks` to turn it back on.",
		);
	} catch {
		printLines("Pharaoh: could not update local project memory choices.");
		process.exitCode = 1;
	}
}

/** --undo-memory: remove the last automatic save from project memory. */
async function undoMemory(): Promise<void> {
	const { undoLastCapture } = await import("../project-memory/capture.mjs");
	try {
		// The npm package has no bundled runtime/refresh.js; its own refresh module is the same code.
		const { undone, repo } = await undoLastCapture({ helper: await import("./refresh.js") });
		printLines(
			undone
				? `Pharaoh: removed the last automatic save from ${repo} project memory.`
				: "Pharaoh: there is no automatic save to undo.",
		);
	} catch {
		printLines(
			"Pharaoh: could not reach project memory to undo the last save. Retry, or remove it at https://mcp.pharaoh.so/setup/memory.",
		);
		process.exitCode = 1;
	}
}

/** The native context switches among the arguments (--enable-/--disable-native-context, optionally -preview). */
function nativeContextSwitches(args: string[]): string[] {
	return args.filter((arg) => /^--(?:enable|disable)-native-context(?:-preview)?$/.test(arg));
}

/** One native context switch, for both coding clients or the one --client names. */
async function runNativeContextSwitch(args: string[]): Promise<void> {
	const contextChoice = nativeContextSwitches(args);
	if (contextChoice.length !== 1) throw new Error("Choose one native context switch.");
	const { setNativeFeedEnabled, setNativeFeedPreviewEnabled, syncNativeFeedHooks } = await import(
		"../runtime/feed-hooks.mjs"
	);
	const enabled = contextChoice[0].startsWith("--enable-");
	const preview = contextChoice[0].endsWith("-preview");
	const clientIndex = args.indexOf("--client");
	const selected = clientIndex < 0 ? ["codex", "claude-code"] : [args[clientIndex + 1]];
	if (selected.some((client) => client !== "codex" && client !== "claude-code"))
		throw new Error("Invalid native context client.");
	for (const client of selected) {
		const adapter = client as "codex" | "claude-code";
		if (preview) setNativeFeedPreviewEnabled(adapter, enabled);
		else {
			setNativeFeedEnabled(adapter, enabled);
			if (!enabled) syncNativeFeedHooks(adapter, null);
		}
	}
	printLines(
		preview
			? `Pharaoh: native context preview ${enabled ? "enabled" : "disabled"}.`
			: enabled
				? "Pharaoh: native context enabled. Run the install command to restore its hooks."
				: "Pharaoh: native context disabled.",
	);
}

/** --clean: remove this computer's Pharaoh setup, keeping any Local installation it can see. */
async function runClean(): Promise<void> {
	const { recordedLocalRoots } = await import("./setup.js");
	let localRoots: string[] = [];
	let scopeUnknown = false;
	try {
		localRoots = recordedLocalRoots();
	} catch {
		scopeUnknown = true;
	}
	if (localRoots.length || scopeUnknown) {
		await cleanGlobalOnly(scopeUnknown);
		return;
	}
	const { uninstallClaudePlugin } = await import("./install-skills.js");
	const { clearRuntimeForCleanup } = await import("./runtime-command.js");
	const runtimeCleaned = await clearRuntimeForCleanup();
	clearMemoryHookChoices(false);
	reportMemorySetup();
	const cleaned = await cleanupClientRegistrations(true);
	uninstallClaudePlugin();
	printLines("Pharaoh: local setup cleanup finished.");
	process.exit(cleaned && runtimeCleaned ? 0 : 1);
}

/** --clean with Local installations (or an unreadable record): clean the Global scope only. */
async function cleanGlobalOnly(scopeUnknown: boolean): Promise<void> {
	let cleaned = true;
	for (const client of ["claude-code", "codex", "claude-desktop"] as const)
		cleaned = (await cleanupInstallScope({ kind: "global" }, client)) && cleaned;
	if (scopeUnknown) {
		const { cleanSlate, cleanCodexSetup } = await import("./setup.js");
		cleanSlate();
		cleanCodexSetup();
	}
	printLines("Pharaoh: Global cleanup finished; Local installations were preserved.");
	process.exitCode = cleaned ? 0 : 1;
}

/** --logout: clean up every installation, clear the local credentials, then exit. */
async function signOut(): Promise<void> {
	const { uninstallClaudePlugin } = await import("./install-skills.js");
	const { recordedLocalRoots } = await import("./setup.js");
	let localCleaned = true;
	try {
		for (const root of recordedLocalRoots()) {
			for (const client of ["claude-code", "codex"] as const)
				localCleaned = (await cleanupInstallScope({ kind: "local", root }, client)) && localCleaned;
		}
	} catch {
		localCleaned = false;
		printLines(
			"Pharaoh: Local installation cleanup needs attention; sign-out will still clear credentials.",
		);
	}
	// Retain the origin-bound bearer in memory long enough to request revocation.
	// A cleanup step that fails must never leave credentials on disk.
	const previousCredentials = await takeCredentialsForLogout();
	const { clearRuntimeForCleanup } = await import("./runtime-command.js");
	const runtimeCleaned = await clearRuntimeForCleanup(previousCredentials);
	clearMemoryHookChoices(false);
	reportMemorySetup();
	const cleaned = await cleanupClientRegistrations(false);
	uninstallClaudePlugin();
	printLines("Pharaoh: credentials cleared and local setup cleanup finished.");
	process.exit(cleaned && runtimeCleaned && localCleaned ? 0 : 1);
}

/** The install a person runs in a terminal (or the explicit `install` command on a pipe). */
async function runInteractiveInstall(
	args: string[],
	explicitInstall: boolean,
	server: string,
	serverArgv: string[],
): Promise<void> {
	process.stderr.write(`${BANNER}\n`);

	const { runInstall, validateInstallArguments } = await import("./install.js");
	const invalid = explicitInstall ? validateInstallArguments(args) : null;
	if (invalid) {
		printLines(invalid);
		process.exitCode = 2;
		return;
	}
	const selectedScope = installScopeArguments(args);
	process.exitCode = await runInstall({
		server,
		serverArgv,
		scope: selectedScope.kind,
		path: selectedScope.path,
		preflightScope: preflightExtras,
		migrateLegacy: args.includes("--migrate-legacy"),
		skipRuntime: args.includes("--skip-runtime"),
		...(explicitInstall &&
			args.includes("--native-delegation") && { offerNativeDelegation: offerDelegationGuidance }),
		// Questions print as they're asked; the outcomes wait for the install summary.
		afterConfigure: (credentials, clients, note, scope) =>
			configureExtras(args, credentials, clients, note, scope),
	});
}

/** The install's extra overlap check: skills, hooks and plugins against the recorded Local roots. */
async function preflightExtras(
	scope: InstallScope,
	targets: readonly { client: ClientId }[],
): Promise<string[]> {
	const { preflightInstallExtras } = await import("./install-skills.js");
	const { recordedLocalRoots } = await import("./setup.js");
	const clients = targets.flatMap((target) =>
		target.client === "claude-code" || target.client === "codex" ? [target.client] : [],
	);
	return preflightInstallExtras(scope, clients, undefined, recordedLocalRoots());
}

/** --native-delegation: offer the pilot guidance; its note names the detected CLI build. */
async function offerDelegationGuidance(
	client: "codex" | "claude-code",
	version: string,
	eligible: () => boolean,
): Promise<string | null> {
	const result = await offerNativeDelegationGuidance(
		client,
		(question) => askYesNo(question, undefined, undefined, false),
		Boolean(process.stdin.isTTY && process.stderr.isTTY),
		eligible,
	);
	const note = result && describeAgentInstructionOutcome(result);
	return note ? `${note} Detected CLI build ${version}.` : null;
}

/**
 * The install's optional client setup: skills, read-tool permissions, agent
 * instruction lines and project memory. Throws when skills or instruction lines
 * fail; permission and memory problems are reported as notes.
 */
async function configureExtras(
	args: string[],
	credentials: Credentials,
	clients: string[],
	note: (...lines: string[]) => void,
	scope: InstallScope,
): Promise<void> {
	setMemoryInstallScope(scope);
	const codingClients = clients.filter(
		(client): client is "claude-code" | "codex" => client === "claude-code" || client === "codex",
	);
	let extraFailures = false;
	if (clients.length && !installExtraSkills(codingClients, scope, note)) extraFailures = true;
	if (clients.includes("claude-code")) {
		const allowed = describeAllowReadTools(allowReadTools(undefined, { scope }), { scope });
		if (allowed) note(allowed);
	}
	if (!(await offerInstructionLines(codingClients, scope, note))) extraFailures = true;
	await setupMemoryHooks(credentials, clients, args.includes("--memory-hooks"), note, scope);
	if (extraFailures) throw new Error("Optional client setup needs attention.");
}

/** Install the bundled skills for these coding clients. False when any failed (its errors are notes). */
function installExtraSkills(
	codingClients: ("claude-code" | "codex")[],
	scope: InstallScope,
	note: (...lines: string[]) => void,
): boolean {
	const { errors } = runInstallSkills(undefined, {
		silent: true,
		clients: codingClients,
		scope,
	});
	if (!errors.length) return true;
	note(...errors);
	return false;
}

/** Offer the agent instruction lines (Global installs only). False when one failed. */
async function offerInstructionLines(
	codingClients: ("claude-code" | "codex")[],
	scope: InstallScope,
	note: (...lines: string[]) => void,
): Promise<boolean> {
	const instructions =
		scope?.kind === "local"
			? []
			: await offerAgentInstructionLines(
					codingClients,
					(question) => askYesNo(question),
					Boolean(process.stdin.isTTY && process.stderr.isTTY),
				);
	for (const instruction of instructions) {
		const message = describeAgentInstructionOutcome(instruction);
		if (message) note(message);
	}
	return !instructions.some((instruction) => instruction.outcome === "failed");
}

/** The managed proxy's launch options. */
interface ProxyLaunch {
	server: string;
	serverArgv: string[];
	feedClient?: "claude-code" | "codex";
	feedRegistration?: string;
}

// ── Proxy mode (Claude Code spawned us as a stdio MCP server) ──

/**
 * The managed proxy's flow.
 * Single flow: load creds → pick starting backend → wait for lifetime
 * events → swap backends in place. Session C design note: we never exit
 * on recoverable conditions (missing creds, expired-refresh, mid-session
 * 401). The stdio session stays alive for the whole life of the agent;
 * only non-recoverable failures (tenant suspended, transient refresh error
 * on cold start) terminate the process.
 */
async function runProxy(
	args: string[],
	{ server, serverArgv, feedClient, feedRegistration }: ProxyLaunch,
): Promise<void> {
	const scope = await proxyScope(args);
	setMemoryInstallScope(scope);
	const outcome = await loadAndRefresh(server);
	const nativeFeed =
		feedClient && feedRegistration
			? new NativeFeedRuntime({
					client: feedClient,
					registration: feedRegistration,
					server,
					serverArgv,
					credentials: outcome?.ok ? outcome.creds : undefined,
				})
			: undefined;
	await installSkillsQuietly(args, scope);

	// Needs auth: either no creds file OR refresh token is terminally rejected.
	// Both cases: start in auth-required mode, wait for the user to complete
	// device flow, then swap to SSE via the onAuthorized callback.
	if (outcome === null || (!outcome.ok && outcome.action === "reauth")) {
		await serveUntilAuthorized(server, scope, nativeFeed);
		return;
	}

	// Non-recoverable refresh failure (transient / preserve). Don't delete
	// creds; the next spawn will retry. Match the pre-Session-C behavior for
	// these codepaths exactly — if we can't refresh on cold start, we can't
	// serve any tool calls, so bailing is honest.
	if (!outcome.ok) {
		handleRefreshFailure(outcome.action, outcome.message);
		return; // unreachable — handleRefreshFailure calls process.exit
	}
	await serveSignedIn(outcome.creds, server, scope, nativeFeed);
}

/**
 * The Local scope a managed launch names (--install-scope local --install-root
 * <root>), checked against this checkout; undefined for a Global launch.
 */
async function proxyScope(args: string[]): Promise<InstallScope | undefined> {
	const scopeFlag = args.indexOf("--install-scope");
	const rootFlag = args.indexOf("--install-root");
	if (scopeFlag < 0 && rootFlag < 0) return undefined;
	if (args[scopeFlag + 1] !== "local" || rootFlag < 0) {
		throw new Error("Invalid scoped Pharaoh launch. Run the Local installer again.");
	}
	const scope: InstallScope = { kind: "local", root: args[rootFlag + 1] ?? "" };
	const { verifiedCodingClients } = await import("./setup.js");
	if (
		!memoryScopeMatches(process.cwd(), scope) ||
		!verifiedCodingClients({
			scope,
			runningLaunch: {
				command: process.execPath,
				args: [runningEntry(fileURLToPath(import.meta.url)), ...args],
			},
		}).length
	)
		throw new Error("Pharaoh Local is not active for this checkout. Run the Local installer here.");
	return scope;
}

/**
 * Install skills opportunistically — must not block startup. Failures
 * here include network hiccups (npm registry blips) and transient fs
 * issues, neither of which should prevent the proxy serving MCP traffic.
 * Log the message so "silent" is still distinguishable from "never ran."
 */
async function installSkillsQuietly(
	args: string[],
	scope: InstallScope | undefined,
): Promise<void> {
	try {
		const { verifiedCodingClients } = await import("./setup.js");
		const clients = verifiedCodingClients({
			scope,
			runningLaunch: {
				command: process.execPath,
				args: [runningEntry(fileURLToPath(import.meta.url)), ...args],
			},
		});
		if (clients.length) runInstallSkills(undefined, { clients, scope });
	} catch (err) {
		// ALLOWED-CATCH: skill install failure must not block MCP proxy startup
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`Pharaoh: skill install skipped — ${msg}\n`);
	}
}

/**
 * Serve without credentials until device flow completes, then swap to SSE.
 * A rejected refresh has already removed the stale creds file
 * (refreshIfNeeded, under the lock) unless another process replaced it.
 */
async function serveUntilAuthorized(
	server: string,
	scope: InstallScope | undefined,
	nativeFeed: NativeFeedRuntime | undefined,
): Promise<void> {
	// The callback closure captures `proxy` via the destructured `const`
	// binding declared below. The closure is only invoked once authorization
	// completes (after the user's device-flow round trip), long after the
	// assignment — so TS's strict-binding checks accept the reference.
	const { proxy } = await startInAuthRequiredMode(server, {
		nativeFeed,
		scope,
		onAuthorized: async (creds) => {
			printLines("Pharaoh: authenticated — swapping to SSE backend.");
			await useSse(proxy, creds);
		},
	});
	printLines("Pharaoh: awaiting authentication via Claude Code...");
	await waitForProxyLifetime(proxy, server);
}

/**
 * Happy path: valid credentials. Start SSE backend, wait for lifetime,
 * handle any mid-session failures by swapping backends in place.
 */
async function serveSignedIn(
	creds: Credentials,
	server: string,
	scope: InstallScope | undefined,
	nativeFeed: NativeFeedRuntime | undefined,
): Promise<void> {
	printLines(`Pharaoh: token valid for ${formatTtl(creds.expires_at)} — connecting`);
	activeCreds = creds;
	const proxy = await startInSseMode(creds, scope, nativeFeed);
	proxy.setMemoryCredentials(creds);
	// Sign-ins from before project memory have no hint: ask once, in the background.
	void updateMemoryHint(server, {
		background: true,
		onPartial: (partial) => proxy.setMemoryCredentials(partial),
	})
		.then((updated) => updated && proxy.setMemoryCredentials(updated))
		// ALLOWED-CATCH: the memory check is optional; MCP keeps working without it
		.catch(() => {});
	await waitForProxyLifetime(proxy, server);
}

/** Circuit breaker: abort after this many TokenExpiredError recoveries in the window. */
const RECOVERY_WINDOW_MS = 60_000;
const MAX_RECOVERIES_PER_WINDOW = 3;

/**
 * Block on proxy.waitForLifetime() and reconcile mid-session failures by
 * swapping the backend in place. Loops so successive swaps (e.g. SSE → auth
 * → SSE) all stay under the same stdio connection.
 *
 * Terminates (returns normally) only when:
 *   - stdio closes (Claude Code disconnects), or
 *   - a non-recoverable branch explicitly process.exit()s.
 *
 * Circuit breaker: a buggy or hostile upstream can force a SSE↔auth churn by
 * issuing a fresh 401 immediately after each successful reauth. Cap the
 * recovery rate so the proxy exits with a diagnostic instead of pinning the
 * user in a loop that re-prompts device flow every few seconds.
 */
async function waitForProxyLifetime(proxy: ProxyServer, server: string): Promise<void> {
	const recoveryTimestamps: number[] = [];
	while (true) {
		try {
			await proxy.waitForLifetime();
			return; // stdio closed cleanly — end of session
		} catch (err) {
			if (err instanceof TokenExpiredError) {
				const now = Date.now();
				// Drop timestamps older than the window.
				while (recoveryTimestamps.length && now - recoveryTimestamps[0] > RECOVERY_WINDOW_MS) {
					recoveryTimestamps.shift();
				}
				recoveryTimestamps.push(now);
				if (recoveryTimestamps.length > MAX_RECOVERIES_PER_WINDOW) {
					printLines(
						`Pharaoh: ${recoveryTimestamps.length} token-expired recoveries in ${RECOVERY_WINDOW_MS / 1000}s — aborting to avoid an auth loop. Restart to retry.`,
					);
					process.exit(1);
				}
				const recovered = await recoverFromTokenExpired(proxy, server);
				if (recovered) continue; // swapped to a new backend; keep waiting
				return; // recovery exited / handed off to auth-required loop
			}
			if (err instanceof TenantSuspendedError) {
				printLines(`Pharaoh: ${err.message}`);
				process.exit(1);
			}
			throw err;
		}
	}
}

/**
 * Handle a mid-session 401 without tearing down the stdio session:
 *   1. Attempt a silent refresh. If it works, swap to a fresh SSE backend.
 *   2. If the refresh says reauth, swap to AuthRequiredBackend — the next
 *      tool call surfaces the auth URL. The onAuthorized callback swaps us
 *      back to SSE once the user completes device flow.
 *   3. If the refresh is transient/preserve, the session can't recover here
 *      — exit with the classified message.
 *
 * Returns `true` when a backend swap happened and the caller should keep
 * waiting on waitForLifetime(); returns `false` when the caller's loop should
 * exit (because this function either handed off to an async auth-required
 * swap-back or process.exit()'d for a non-recoverable case).
 */
async function recoverFromTokenExpired(proxy: ProxyServer, server: string): Promise<boolean> {
	// The rejected token is the one the live backend was built from. Pass
	// those creds, not a fresh disk read: if another proxy already refreshed
	// (which is what invalidated ours — the server keeps one access token per
	// session), refreshIfNeeded sees the newer token on disk and adopts it
	// instead of refreshing again and invalidating everyone else in turn.
	const rejected = activeCreds ?? readCredentials();
	if (!rejected) {
		// No creds anywhere — shouldn't happen mid-session, but if it does,
		// fall through to auth-required mode to get new ones.
		await swapToAuthRequired(proxy, server);
		return true;
	}
	const result = await tryMidSessionRefresh(rejected, server);
	if (result.ok) {
		printLines("Pharaoh: token refreshed mid-session — swapping SSE backend");
		await useSse(proxy, result.creds);
		return true;
	}
	// Branch on the explicit classification returned by tryMidSessionRefresh
	// rather than inferring from disk state. `reauth` means the refresh token
	// is terminally rejected — swap to auth-required so the user can re-
	// authenticate without the session tearing down. `preserve`/`transient`
	// mean the server's temporarily unable to refresh us; exit with the
	// message so the user knows their credentials are intact.
	if (result.action === "reauth") {
		await swapToAuthRequired(proxy, server);
		return true;
	}
	printLines(
		`Pharaoh: mid-session refresh failed (${result.action}) — credentials preserved; restart to retry.`,
	);
	process.exit(1);
}

/**
 * Credentials the live SSE backend was built from. After a 401 these are the
 * rejected ones — recoverFromTokenExpired compares them with what's on disk.
 */
let activeCreds: Credentials | null = null;

/** Point the proxy at a fresh SSE backend for `creds`, remembering which creds it uses. */
async function useSse(proxy: ProxyServer, creds: Credentials): Promise<void> {
	await proxy.setBackend(createSseBackend(creds.sse_url, creds.access_token));
	activeCreds = creds;
	proxy.setNativeFeedCredentials(creds);
	proxy.setMemoryCredentials(creds);
}

/**
 * Swap the live ProxyServer over to an AuthRequiredBackend, wiring an
 * onAuthorized callback that swaps back to SSE. Used on both mid-session
 * reauth and first-missing-creds recovery.
 */
async function swapToAuthRequired(proxy: ProxyServer, server: string): Promise<void> {
	const gateway = createGateway({ server });
	const authBackend = new AuthRequiredBackend(gateway, async () => {
		const fresh = gateway.getCredentials();
		if (!fresh) {
			process.stderr.write("Pharaoh: swap-back aborted — gateway returned no creds\n");
			return;
		}
		printLines("Pharaoh: re-authenticated — swapping back to SSE backend.");
		await useSse(proxy, fresh);
	});
	printLines("Pharaoh: re-authentication required — next tool call will surface the URL.");
	await proxy.setBackend(authBackend);
}

main().catch((err) => {
	// Default: print only error name/code to avoid leaking tokens, internal URLs,
	// or stack fragments that persist in CI logs. Full message behind PHARAOH_DEBUG.
	if (process.env.PHARAOH_DEBUG === "1" && err instanceof Error) {
		// Use main's comprehensive redaction patterns when showing the full message
		const safeMsg = err.message
			.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
			.replace(/(?:phat|phrt|ghp|gho|ghs|ghu)_\S+/gi, "[REDACTED_TOKEN]")
			.replace(/[?&](?:code|token|key|secret|password|state)=[^&\s]+/gi, "?[REDACTED_PARAM]")
			.replace(/\b[0-9a-f]{32,}\b/gi, "[REDACTED_HEX]");
		printLines(`Pharaoh: fatal — ${safeMsg}`);
	} else {
		const label = err instanceof Error ? err.name : "Error";
		printLines(`Pharaoh: fatal — ${label}. Set PHARAOH_DEBUG=1 for details.`);
	}
	process.exit(1);
});
