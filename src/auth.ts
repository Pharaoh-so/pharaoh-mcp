/**
 * Device flow client for Pharaoh MCP proxy (RFC 8628).
 * All user-visible output goes to stderr — stdout is reserved for JSON-RPC.
 */
import { execFile } from "node:child_process";

/** Response from POST /device. */
export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

/** Successful response from POST /device/token. */
export interface TokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	/**
	 * Refresh token for silent access-token renewal. Present on all new sessions
	 * (server at src/web/routes/agent-auth.ts). Optional at the type level only
	 * for backward compat with hypothetical older servers — if missing, the proxy
	 * falls through to the full re-auth path on expiry.
	 */
	refresh_token?: string;
	/** Refresh token TTL in seconds. */
	refresh_token_expires_in?: number;
	sse_url: string;
	github_login?: string;
	tenant_name?: string;
	repos?: string[];
	provisional?: boolean;
	install_url?: string;
}

/** Error response from POST /device/token while still waiting. */
interface DeviceTokenError {
	error: string;
	error_description?: string;
}

/**
 * Result of a single poll against /device/token.
 *
 * This type is the contract between the state-machine gateway (gateway.ts),
 * the blocking interactive poller (pollForToken), and the test harness. It
 * collapses HTTP details into the four lifecycle outcomes callers actually
 * need to branch on, plus a network_error bucket so callers can distinguish
 * "server said no" from "couldn't reach server."
 */
export type PollResult =
	| { status: "pending"; slowDown?: boolean }
	| { status: "authorized"; token: TokenResponse }
	| { status: "expired" }
	| { status: "denied"; error: string }
	| { status: "network_error"; error: string };

/**
 * Request a device code from the Pharaoh server (RFC 8628 §3.1).
 * Returns the device code, user code, and verification URIs.
 */
export async function requestDeviceCode(baseUrl: string): Promise<DeviceCodeResponse> {
	const res = await fetch(`${baseUrl}/device`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Device code request failed (${res.status}): ${text}`);
	}

	return (await res.json()) as DeviceCodeResponse;
}

/**
 * Perform one POST to /device/token. No loop, no sleep — maps HTTP responses
 * into a PollResult discriminated union.
 *
 * Called in two shapes:
 * - pollForToken() (TTY path): loops with interval+jitter until terminal state.
 * - gateway.handleToolCall() (proxy path): called once per tool call, gated
 *   by a last_poll_at check against the server's interval.
 *
 * Note: slow_down is mapped to "pending" — the caller's pacing logic is what
 * responds to it. pollForToken bumps its local interval; gateway relies on the
 * server-specified interval it already tracks. This keeps pollOnce stateless.
 */
export async function pollOnce(baseUrl: string, deviceCode: string): Promise<PollResult> {
	const grantType = "urn:ietf:params:oauth:grant-type:device_code";

	let res: Response;
	try {
		res = await fetch(`${baseUrl}/device/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ device_code: deviceCode, grant_type: grantType }),
		});
	} catch (err) {
		return {
			status: "network_error",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.ok) {
		const token = (await res.json()) as TokenResponse;
		return { status: "authorized", token };
	}

	// 5xx is an upstream/transport issue (CDN 503, Render cold-start 502,
	// gateway 504 with an HTML error page). Treat as network_error so the
	// gateway keeps the pending cycle alive and retries on the next tool call
	// — a transient hiccup must not surface to the user as "auth denied".
	if (res.status >= 500) {
		return { status: "network_error", error: `HTTP ${res.status}` };
	}

	const body = (await res.json().catch(() => ({ error: "unknown" }))) as DeviceTokenError;

	if (body.error === "authorization_pending") {
		return { status: "pending" };
	}
	if (body.error === "slow_down") {
		return { status: "pending", slowDown: true };
	}
	if (body.error === "expired_token") {
		return { status: "expired" };
	}
	if (body.error === "access_denied") {
		return { status: "denied", error: "Authorization was denied." };
	}
	return {
		status: "denied",
		error: `Device token error: ${body.error} — ${body.error_description ?? ""}`,
	};
}

/**
 * Poll for device authorization completion (RFC 8628 §3.5).
 * Blocks until the user authorizes, the code expires, or an error occurs.
 * Adds 1s jitter to the server-specified interval to avoid thundering herd.
 */
export async function pollForToken(
	baseUrl: string,
	deviceCode: string,
	interval: number,
): Promise<TokenResponse> {
	let currentInterval = interval;
	while (true) {
		// Wait interval + 0–1s jitter before each poll
		const jitterMs = Math.random() * 1000;
		await sleep(currentInterval * 1000 + jitterMs);

		const result = await pollOnce(baseUrl, deviceCode);

		if (result.status === "authorized") return result.token;
		if (result.status === "expired") {
			throw new Error("Device code expired. Please try again.");
		}
		if (result.status === "denied") throw new Error(result.error);
		if (result.status === "network_error") throw new Error(result.error);

		// result.status === "pending". RFC 8628 §3.5: only bump interval on
		// slow_down (authorization_pending is the normal polling response).
		if (result.slowDown) currentInterval += 5;
	}
}

/**
 * Open a URL in the user's default browser.
 * Uses platform-specific commands; fails silently if unavailable.
 *
 * Exported for gateway.ts — the state machine fires this once per device code
 * to pre-fill the activation URL in the user's browser. Silent-on-failure is
 * critical for headless environments: a missing `open`/`xdg-open` binary must
 * not crash the proxy.
 *
 * Test / CI escape hatch: set PHARAOH_MCP_DISABLE_BROWSER=1 when spawning the
 * proxy as a child process during E2E testing. The openBrowser dependency-
 * injection path in gateway.ts is sufficient for in-process tests, but child-
 * process tests bypass module mocking — the env-var short-circuit catches
 * every spawn path (gateway, printActivationPrompt, direct index.ts calls).
 */
export function openBrowser(url: string): void {
	if (process.env.PHARAOH_MCP_DISABLE_BROWSER === "1") return;
	if (process.platform === "darwin") {
		execFile("open", [url], () => {});
	} else if (process.platform === "win32") {
		execFile("cmd.exe", ["/c", "start", "", url], () => {});
	} else {
		execFile("xdg-open", [url], () => {});
	}
}

/**
 * Print the device activation prompt to stderr.
 * Shows the user code and verification URI in a visible box,
 * and opens the verification URL in the default browser.
 */
export function printActivationPrompt(
	userCode: string,
	verificationUri: string,
	verificationUriComplete?: string,
): void {
	// Auto-open browser with the complete URI (pre-fills the code)
	openBrowser(verificationUriComplete ?? verificationUri);

	const W = 48;
	const pad = (s: string) => `│  ${s.padEnd(W - 2)}│`;
	const empty = `│${" ".repeat(W)}│`;
	const top = `┌${"─".repeat(W)}┐`;
	const bot = `└${"─".repeat(W)}┘`;

	const lines = [
		"",
		top,
		empty,
		pad(`Your code:  ${userCode}`),
		empty,
		pad("A browser window should open automatically."),
		pad("If it didn't open, visit:"),
		pad(verificationUri),
		empty,
		bot,
		"",
	];
	process.stderr.write(`${lines.join("\n")}\n`);
}

/**
 * Print authentication success message to stderr.
 */
export function printAuthSuccess(
	login: string | null,
	tenant: string | null,
	repoCount: number,
): void {
	const parts: string[] = ["✓ Authenticated"];
	if (login) parts.push(`as ${login}`);
	if (tenant) parts.push(`(${tenant})`);
	parts.push(`— ${repoCount} repo${repoCount === 1 ? "" : "s"} connected`);
	process.stderr.write(`${parts.join(" ")}\n`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
