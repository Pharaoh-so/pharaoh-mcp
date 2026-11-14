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
import { resetHookPreferences, setMemoryCapture } from "../project-memory/preferences.mjs";
import {
	applyMemoryHookChoices,
	chooseMemoryHooks,
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
import {
	allowReadTools,
	describeAgentInstructionOutcome,
	describeAllowReadTools,
	offerAgentInstructionLines,
	runInstallSkills,
} from "./install-skills.js";
import { handleRefreshFailure, tryMidSessionRefresh } from "./lifecycle.js";
import { updateMemoryHint } from "./memory-hint.js";
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
) {
	try {
		if (requested) setMemoryCapture(true);
		const decision = await chooseMemoryHooks({
			credentials,
			clients,
			requested,
			ask: askYesNoInTerminal,
		});
		// Memory runs on its own (DECIDED 2026-11-10: hands-off), so install reports only its
		// failures, which start "Pharaoh:". The Codex trust step is the summary's own check.
		const notices = applyMemoryHookChoices(decision, { credentials });
		note(...notices.filter((notice) => notice.startsWith("Pharaoh:")));
	} catch {
		note("Pharaoh: could not finish local project memory setup. MCP remains available.");
	}
}

/** Explicit reset retains its old broad Claude cleanup; logout removes managed connections only. */
async function cleanupClientRegistrations(reset: boolean): Promise<boolean> {
	const { cleanCodexSetup, cleanupManagedClients, cleanSlate } = await import("./setup.js");
	let outcomes: ReturnType<typeof cleanupManagedClients> = [];
	let provenanceFailed = false;
	try {
		outcomes = cleanupManagedClients();
	} catch {
		printLines(
			"Pharaoh: the installation record could not be read; managed cleanup could not be verified.",
		);
		provenanceFailed = true;
	}
	if (reset) cleanSlate();
	cleanCodexSetup();
	const localCleanupSupported =
		typeof process.getuid === "function" ||
		(process.platform === "win32" &&
			Boolean((await import("./local/worker-host.js")).installedLocalAnalyzer()));
	if (localCleanupSupported) {
		const { syncLocalWorktreeHooks, syncUpdateNoticeHook } = await import(
			"../runtime/runtime-hooks.mjs"
		);
		for (const client of ["claude-code", "codex"] as const) {
			try {
				syncLocalWorktreeHooks(client, null);
			} catch {
				printLines("Pharaoh: saved-worktree hook cleanup needs attention.");
				provenanceFailed = true;
			}
			try {
				syncUpdateNoticeHook(client, null);
			} catch {
				printLines("Pharaoh: update notice hook cleanup needs attention.");
				provenanceFailed = true;
			}
		}
	}
	for (const outcome of outcomes) {
		if (outcome.status === "failed" || outcome.status === "ambiguous") {
			printLines(
				`Pharaoh: ${outcome.client} cleanup needs attention. ${outcome.recovery ?? "Retry the install command."}`,
			);
		}
	}
	return (
		!provenanceFailed &&
		!outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "ambiguous")
	);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const explicitInstall = args[0] === "install";
	if (explicitInstall) args.shift();
	if (!explicitInstall && args[0] === "update") {
		const { runUpdateCommand } = await import("./update.js");
		process.exitCode = await runUpdateCommand(args.slice(1));
		return;
	}
	if (!explicitInstall && args[0] && !args[0].startsWith("-")) {
		const { runCli } = await import("./cli.js");
		return runCli(args);
	}

	if (args.includes("--help") || args.includes("-h")) {
		printUsage();
		process.exit(0);
	}

	// Stdout, alone on its line, so a script can capture the version to pin
	if (args.includes("--version") || args.includes("-v")) {
		process.stdout.write(`${getPackageVersion()}\n`);
		return;
	}

	if (args.includes("--doctor")) {
		const { diagnoseLocalSetup, renderLocalSetupDiagnosis } = await import("./doctor.js");
		const clientFlag = args.indexOf("--client");
		const clientName = clientFlag >= 0 ? args[clientFlag + 1] : undefined;
		process.stdout.write(`${renderLocalSetupDiagnosis(diagnoseLocalSetup({ clientName }))}\n`);
		return;
	}
	if (args.some((arg) => arg.startsWith("--runtime-"))) {
		try {
			const { runRuntimeCommand } = await import("./runtime-command.js");
			process.exitCode = await runRuntimeCommand(args);
		} catch {
			printLines(
				"Pharaoh: local runtime setup could not finish. Check the private setup state and retry.",
			);
			process.exitCode = 1;
		}
		return;
	}

	// Inspect mode — serve tool schemas over stdio for Glama directory inspection
	if (args.includes("--inspect")) {
		const { runInspect } = await import("./inspect.js");
		await runInspect();
		return;
	}

	// Install-skills mode — copy bundled skills to ~/.openclaw/skills/
	if (args.includes("--install-skills")) {
		const { runInstallSkills } = await import("./install-skills.js");
		runInstallSkills();
		return;
	}

	if (args.includes("--disable-memory-capture")) {
		try {
			setMemoryCapture(false);
			printLines(
				"Pharaoh: automatic project memory saving is off. Run `npx @pharaoh-so/mcp install --memory-hooks` to turn it back on.",
			);
		} catch {
			printLines("Pharaoh: could not update local project memory choices.");
			process.exitCode = 1;
		}
		return;
	}

	if (args.includes("--undo-memory")) {
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
		return;
	}

	if (args.includes("--disable-memory-hooks")) {
		const saved = clearMemoryHookChoices(true);
		if (!reportMemorySetup() || !saved) process.exitCode = 1;
		return;
	}

	// Clean mode — remove all pharaoh traces from Claude Code config (MCP entries,
	// disabled states, project-scoped configs). Useful for resetting broken installs.
	if (args.includes("--clean")) {
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

	const { server, logout } = parseArgs(args);

	if (logout) {
		const { uninstallClaudePlugin } = await import("./install-skills.js");
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
		process.exit(cleaned && runtimeCleaned ? 0 : 1);
	}

	const isInteractive = explicitInstall || Boolean(process.stdin.isTTY);

	// ── Interactive mode (user running in a terminal) ──
	// The explicit command also works on a pipe; the bare TTY command stays an alias.
	if (isInteractive) {
		process.stderr.write(`${BANNER}\n`);

		const { runInstall, validateInstallArguments } = await import("./install.js");
		const invalid = explicitInstall ? validateInstallArguments(args) : null;
		if (invalid) {
			printLines(invalid);
			process.exitCode = 2;
			return;
		}
		process.exitCode = await runInstall({
			server,
			migrateLegacy: args.includes("--migrate-legacy"),
			skipRuntime: args.includes("--skip-runtime"),
			// Questions print as they're asked; the outcomes wait for the install summary.
			afterConfigure: async (credentials, clients, note) => {
				let extraFailures = false;
				const codingClients = clients.filter(
					(client): client is "claude-code" | "codex" =>
						client === "claude-code" || client === "codex",
				);
				if (clients.length) {
					const { errors } = runInstallSkills(undefined, { silent: true, clients: codingClients });
					if (errors.length) {
						note(...errors);
						extraFailures = true;
					}
				}
				if (clients.includes("claude-code")) {
					const allowed = describeAllowReadTools(allowReadTools());
					if (allowed) note(allowed);
				}
				const instructions = await offerAgentInstructionLines(
					codingClients,
					(question) => askYesNo(question),
					Boolean(process.stdin.isTTY && process.stderr.isTTY),
				);
				for (const instruction of instructions) {
					const message = describeAgentInstructionOutcome(instruction);
					if (message) note(message);
				}
				if (instructions.some((instruction) => instruction.outcome === "failed")) {
					extraFailures = true;
				}
				await setupMemoryHooks(credentials, clients, args.includes("--memory-hooks"), note);
				if (extraFailures) throw new Error("Optional client setup needs attention.");
			},
		});
		return;
	}

	// ── Proxy mode (Claude Code spawned us as a stdio MCP server) ──
	// Single flow: load creds → pick starting backend → wait for lifetime
	// events → swap backends in place. Session C design note: we never exit
	// on recoverable conditions (missing creds, expired-refresh, mid-session
	// 401). The stdio session stays alive for the whole life of the agent;
	// only non-recoverable failures (tenant suspended, transient refresh error
	// on cold start) terminate the process.
	const outcome = await loadAndRefresh(server);

	// Install skills opportunistically — must not block startup. Failures
	// here include network hiccups (npm registry blips) and transient fs
	// issues, neither of which should prevent the proxy serving MCP traffic.
	// Log the message so "silent" is still distinguishable from "never ran."
	try {
		const { verifiedCodingClients } = await import("./setup.js");
		const clients = verifiedCodingClients({
			runningLaunch: {
				command: process.execPath,
				args: [runningEntry(fileURLToPath(import.meta.url))],
			},
		});
		if (clients.length) runInstallSkills(undefined, { clients });
	} catch (err) {
		// ALLOWED-CATCH: skill install failure must not block MCP proxy startup
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`Pharaoh: skill install skipped — ${msg}\n`);
	}

	// Needs auth: either no creds file OR refresh token is terminally rejected.
	// Both cases: start in auth-required mode, wait for the user to complete
	// device flow, then swap to SSE via the onAuthorized callback.
	const needsAuth = outcome === null || (!outcome.ok && outcome.action === "reauth");

	if (needsAuth) {
		// A rejected refresh has already removed the stale creds file
		// (refreshIfNeeded, under the lock) unless another process replaced it.

		// The callback closure captures `proxy` via the destructured `const`
		// binding declared below. The closure is only invoked once authorization
		// completes (after the user's device-flow round trip), long after the
		// assignment — so TS's strict-binding checks accept the reference.
		const { proxy } = await startInAuthRequiredMode(server, {
			onAuthorized: async (creds) => {
				printLines("Pharaoh: authenticated — swapping to SSE backend.");
				await useSse(proxy, creds);
			},
		});
		printLines("Pharaoh: awaiting authentication via Claude Code...");
		await waitForProxyLifetime(proxy, server);
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

	// Happy path: valid credentials. Start SSE backend, wait for lifetime,
	// handle any mid-session failures by swapping backends in place.
	const creds = outcome.creds;
	printLines(`Pharaoh: token valid for ${formatTtl(creds.expires_at)} — connecting`);
	activeCreds = creds;
	const proxy = await startInSseMode(creds);
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
	activeCreds = creds;
	await proxy.setBackend(createSseBackend(creds.sse_url, creds.access_token));
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
