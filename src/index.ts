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
import {
	pollForToken,
	printActivationPrompt,
	printAuthSuccess,
	requestDeviceCode,
} from "./auth.js";
import { AuthRequiredBackend, createSseBackend } from "./backend.js";
import {
	type Credentials,
	deleteCredentials,
	readCredentials,
	writeCredentials,
} from "./credentials.js";
import { createGateway } from "./gateway.js";
import {
	formatTtl,
	parseArgs,
	printLines,
	printUsage,
	resolveSseUrl,
	tokenToCredentials,
} from "./helpers.js";
import {
	allowReadTools,
	describeAllowReadTools,
	formatKeptCommands,
	runInstallSkills,
} from "./install-skills.js";
import { handleRefreshFailure, tryMidSessionRefresh } from "./lifecycle.js";
import { TenantSuspendedError, TokenExpiredError } from "./proxy.js";
import { type ProxyServer, startInAuthRequiredMode, startInSseMode } from "./proxy-server.js";
import { loadAndRefresh } from "./refresh.js";
import {
	fetchLatestVersion,
	getPackageVersion,
	isNewerVersion,
	UPGRADE_COMMAND,
} from "./version.js";

const BANNER = [
	"",
	"  ___  _  _   _   ___    _    ___  _  _ ",
	" | _ \\| || | /_\\ | _ \\  /_\\  / _ \\| || |",
	" |  _/| __ |/ _ \\|   / / _ \\| (_) | __ |",
	" |_|  |_||_/_/ \\_\\_|_\\/_/ \\_\\\\___/|_||_|",
	"",
].join("\n");

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.includes("--help") || args.includes("-h")) {
		printUsage();
		process.exit(0);
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

	// Clean mode — remove all pharaoh traces from Claude Code config (MCP entries,
	// disabled states, project-scoped configs). Useful for resetting broken installs.
	if (args.includes("--clean")) {
		const { cleanSlate } = await import("./setup.js");
		const { uninstallClaudePlugin } = await import("./install-skills.js");
		cleanSlate();
		uninstallClaudePlugin();
		printLines("Pharaoh: cleaned all MCP entries and the plugin from Claude Code config");
		process.exit(0);
	}

	const { server, logout } = parseArgs(args);

	if (logout) {
		const { cleanSlate } = await import("./setup.js");
		const { uninstallClaudePlugin } = await import("./install-skills.js");
		cleanSlate();
		uninstallClaudePlugin();
		deleteCredentials();
		printLines("Pharaoh: credentials, MCP config and the Claude Code plugin cleared");
		process.exit(0);
	}

	const isInteractive = Boolean(process.stdin.isTTY);

	// ── Interactive mode (user running in a terminal) ──
	// Full setup every time: fresh auth → register MCP → install skills → done.
	// Running `npx @pharaoh-so/mcp` is the only command a user needs.
	if (isInteractive) {
		process.stderr.write(`${BANNER}\n`);

		// Always re-authenticate for a fresh session
		deleteCredentials();
		const deviceCode = await requestDeviceCode(server);
		printActivationPrompt(
			deviceCode.user_code,
			deviceCode.verification_uri,
			deviceCode.verification_uri_complete,
		);
		const token = await pollForToken(server, deviceCode.device_code, deviceCode.interval);

		if (token.provisional) {
			printLines(
				`Pharaoh: provisional access — install the GitHub App to map your repos: ${token.install_url ?? ""}`,
			);
		}

		const sseUrl = resolveSseUrl(token.sse_url, server);
		const newCreds = tokenToCredentials(token, sseUrl);
		writeCredentials(newCreds);

		printAuthSuccess(
			token.github_login ?? null,
			token.tenant_name ?? null,
			token.repos?.length ?? 0,
		);

		// Register MCP server + install skills (silent — user doesn't need internals)
		process.stderr.write("  Setting up...");
		const { runSetup } = await import("./setup.js");
		runSetup({ silent: true });
		const { keptCommands } = runInstallSkills(undefined, { silent: true });
		process.stderr.write(" done.\n");

		// Two things the user must hear about: their settings.json (the only
		// place this setup edits permissions, never a silent start) and any
		// command file of theirs that was left alone.
		printLines(describeAllowReadTools(allowReadTools()));
		const kept = formatKeptCommands(keptCommands);
		if (kept) printLines(kept);

		// The registration is pinned to this version; upgrading is a deliberate
		// re-run. Interactive only, and quiet when the registry can't be reached.
		const latest = await fetchLatestVersion();
		const running = getPackageVersion();
		if (latest && isNewerVersion(latest, running)) {
			printLines(
				`Pharaoh: ${latest} is available (this is ${running}). Upgrade: ${UPGRADE_COMMAND}`,
			);
		}

		printLines(
			"",
			"Pharaoh is ready. Try these in a new Claude Code conversation:",
			"",
			'  "What modules does this codebase have?"',
			'  "Search for functions related to authentication"',
			'  "What breaks if I change this file?"',
			"",
		);
		process.exit(0);
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
		runInstallSkills();
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
