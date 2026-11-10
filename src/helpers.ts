/**
 * Pure helper functions for the mcp-proxy CLI — no side effects on import.
 * Separated from index.ts so tests can import without triggering main().
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { TokenResponse } from "./auth.js";
import type { Credentials } from "./credentials.js";
import { isExpired } from "./credentials.js";

export const DEFAULT_SERVER = "https://mcp.pharaoh.so";

/** The npx command users run to set up Pharaoh. Single source of truth for all output. */
export const NPX_COMMAND = "npx @pharaoh-so/mcp";

/** Explicit setup works in a terminal or a script; tool commands keep the base NPX command. */
export const INSTALL_COMMAND = "npx @pharaoh-so/mcp@latest install";

/** Write one or more lines to stderr. */
export function printLines(...lines: string[]): void {
	process.stderr.write(`${lines.join("\n")}\n`);
}

/** How long to read and drop input that was typed before a question showed. */
const TYPE_AHEAD_MS = 50;

/**
 * Ask a yes/no question. Enter uses the default; `y` or `yes` is yes; `n`
 * or `no` is no; anything else asks again. Ctrl-C exits (130). On a terminal,
 * keys pressed before the question showed (an Enter while sign-in waited) are
 * dropped, so only a key pressed after reading it answers.
 *
 * @param question - The prompt, ending in something like `[Y/n] `.
 * @param input - Where the answer is read (defaults to stdin).
 * @param output - Where the prompt is written (defaults to stderr, like every other line).
 * @param defaultAnswer - The answer for Enter (defaults to yes).
 * @returns The answer, or null when input ended before one.
 */
export async function askYesNo(
	question: string,
	input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
	output: NodeJS.WritableStream = process.stderr,
	defaultAnswer = true,
): Promise<boolean | null> {
	if (input.isTTY) await dropTypedAhead(input);
	const rl = createInterface({ input, output });
	rl.on("SIGINT", () => {
		output.write("\n");
		process.exit(130);
	});
	rl.setPrompt(question);
	rl.prompt();
	try {
		// The iterator ends on EOF; rl.question never settles then.
		for await (const reply of rl) {
			const answer = reply.trim().toLowerCase();
			if (answer === "") return defaultAnswer;
			if (answer === "y" || answer === "yes") return true;
			if (answer === "n" || answer === "no") return false;
			rl.prompt();
		}
		return null;
	} finally {
		rl.close();
	}
}

/** Optional installer choices require a terminal on both sides of the prompt. */
export function askYesNoInTerminal(
	question: string,
	defaultAnswer: boolean,
	input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
	output: NodeJS.WritableStream & { isTTY?: boolean } = process.stderr,
): Promise<boolean | null> {
	return input.isTTY && output.isTTY
		? askYesNo(question, input, output, defaultAnswer)
		: Promise.resolve(null);
}

/** Read and drop the input already waiting, in raw mode so a half-typed line goes too. */
async function dropTypedAhead(input: NodeJS.ReadableStream): Promise<void> {
	(input as Partial<NodeJS.ReadStream>).setRawMode?.(true);
	const drop = () => {};
	input.on("data", drop);
	await new Promise((resolve) => setTimeout(resolve, TYPE_AHEAD_MS));
	input.off("data", drop);
	input.pause();
}

/** Parse CLI arguments. */
export function parseArgs(argv: string[] = process.argv.slice(2)): {
	server: string;
	logout: boolean;
} {
	let server = DEFAULT_SERVER;
	let logout = false;

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--server" && argv[i + 1]) {
			server = argv[i + 1];
			i++;
		} else if (argv[i] === "--logout") {
			logout = true;
		}
	}

	// Strip trailing slash
	server = server.replace(/\/+$/, "");

	// Reject non-HTTPS servers (allow loopback addresses for local dev)
	try {
		const parsed = new URL(server);
		const isLoopback =
			parsed.hostname === "localhost" ||
			parsed.hostname === "127.0.0.1" ||
			parsed.hostname === "[::1]";
		if (parsed.protocol !== "https:" && !isLoopback) {
			printLines(
				`Pharaoh: --server must use HTTPS (got ${parsed.protocol}//…). Use https:// or http://localhost for local dev.`,
			);
			process.exit(1);
		}
		if (parsed.protocol !== "https:" && isLoopback) {
			printLines("⚠ Warning: using insecure HTTP over loopback — do not use in production.");
		}
	} catch {
		printLines(`Pharaoh: --server is not a valid URL: ${server}`);
		process.exit(1);
	}

	return { server, logout };
}

export function printUsage(): void {
	printLines(
		"Usage: pharaoh-mcp [options]",
		"       pharaoh-mcp install [--migrate-legacy] [options]",
		"       pharaoh-mcp <tool> --repo <name> [flags] [--json] (use <tool> --help)",
		"",
		"Options:",
		"  --server <url>    Pharaoh server URL (default: https://mcp.pharaoh.so)",
		"  --logout          Clear credentials, MCP config, the Claude Code plugin and the CLAUDE.md line, then exit",
		"  --clean           Remove Pharaoh setup, including managed local project memory hooks",
		"  --memory-hooks    Re-enable eligible memory reminders and offer optional settings",
		"  --disable-memory-hooks  Remove Pharaoh's memory hooks and remember the choice",
		"  --install-skills  Reinstall the Claude Code plugin and OpenClaw skills",
		"  --migrate-legacy  Move plain pinned NPX connections to the managed runtime during install",
		"  --skip-runtime    Turn off runtime analytics during install and remember the choice",
		"  --doctor          Report bounded local setup markers offline; changes nothing",
		"  --client <name>   With --doctor, select claude-code to inspect project markers",
		"  --runtime-enable --client <name>  Opt in to native runtime observations (claude-code or codex)",
		"  --runtime-revoke [--client <name>]  Turn off collection and revoke consent",
		"  --runtime-status [--client <name>] [--json]  Read local runtime status",
		"  --runtime-profile <id> --client <name> [--json]  Choose a profile for the next episode",
		"  --runtime-profile-receipt <id> --client <name> [--json]  Read a consumed profile selection",
		"  --version, -v     Print the version",
		"  --help, -h        Show this help",
		"",
		"Get started:",
		`  ${INSTALL_COMMAND}`,
		"",
	);
}

/**
 * Validate that a server-supplied SSE URL shares the same origin as the configured server.
 * Prevents a compromised auth response from redirecting the Bearer token to an attacker's host.
 * Falls back to `${server}/sse` if the URL is missing, malformed, or cross-origin.
 */
export function resolveSseUrl(tokenSseUrl: string | undefined, server: string): string {
	const fallback = `${server}/sse`;
	if (!tokenSseUrl) return fallback;
	try {
		const sseOrigin = new URL(tokenSseUrl).origin;
		const serverOrigin = new URL(server).origin;
		if (sseOrigin !== serverOrigin) {
			printLines(`Pharaoh: ignoring cross-origin sse_url (${sseOrigin} ≠ ${serverOrigin})`);
			return fallback;
		}
		return tokenSseUrl;
	} catch {
		return fallback;
	}
}

/**
 * Convert a token response to storable credentials.
 *
 * @throws if the server response omits refresh_token — this is a breaking
 * contract, not a graceful degradation: without a refresh token the proxy
 * will eventually hit the same silent-expiry cliff we're trying to eliminate.
 * Fail loud so the server regression surfaces instead of being absorbed.
 */
export function tokenToCredentials(
	token: TokenResponse,
	sseUrl: string,
	server?: string,
): Credentials {
	if (!token.refresh_token || !token.refresh_token_expires_in) {
		throw new Error(
			"Pharaoh server response missing refresh_token — server is older than this client. " +
				"Update the server to a version that issues refresh tokens, or downgrade the client.",
		);
	}
	const now = Date.now();
	const production = server === DEFAULT_SERVER && new URL(sseUrl).origin === DEFAULT_SERVER;
	const memory = production ? validMemoryHint(token.project_memory) : [];
	return {
		version: 2,
		access_token: token.access_token,
		refresh_token: token.refresh_token,
		expires_at: new Date(now + token.expires_in * 1000).toISOString(),
		refresh_expires_at: new Date(now + token.refresh_token_expires_in * 1000).toISOString(),
		expires_in: token.expires_in,
		sse_url: sseUrl,
		github_login: token.github_login ?? null,
		tenant_name: token.tenant_name ?? null,
		repos: token.repos ?? [],
		...(memory.length ? { project_memory: memory, project_memory_session: randomUUID() } : {}),
		...(production && token.project_memory_status === "unavailable"
			? { project_memory_status: "unavailable" }
			: {}),
	};
}

/** The well-formed entries of a server memory hint: `owner/repo` and a 40-hex revision or null. */
export function validMemoryHint(
	entries: unknown,
): Array<{ repo: string; revision: string | null }> {
	return Array.isArray(entries)
		? entries.filter(
				(entry) =>
					typeof entry?.repo === "string" &&
					/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(entry.repo) &&
					(entry.revision === null ||
						(typeof entry.revision === "string" &&
							/^(?!0{40}$)[a-f0-9]{40}$/.test(entry.revision))),
			)
		: [];
}

/** Format remaining TTL as human-readable string (e.g. "5d 12h"). */
export function formatTtl(expiresAt: string): string {
	const remainingMs = new Date(expiresAt).getTime() - Date.now();
	if (remainingMs <= 0) return "expired";
	const hours = Math.floor(remainingMs / 3_600_000);
	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	if (days > 0) return `${days}d ${remHours}h`;
	if (hours > 0) return `${hours}h`;
	return `${Math.floor(remainingMs / 60_000)}m`;
}

/** Format a credential identity string (e.g. "alice (my-org)"). */
export function formatIdentity(creds: Credentials): string {
	return [creds.github_login ?? "unknown", creds.tenant_name ? `(${creds.tenant_name})` : null]
		.filter(Boolean)
		.join(" ");
}

/**
 * Determine if credentials are valid for proxy use.
 * Returns a diagnostic message if not, null if valid.
 */
export function validateCredentials(creds: Credentials | null): string | null {
	if (!creds || isExpired(creds)) {
		return [
			"Pharaoh: no valid credentials — cannot start proxy.",
			"Run this command first to authenticate:",
			"  npx @pharaoh-so/mcp",
			"",
		].join("\n");
	}
	return null;
}
