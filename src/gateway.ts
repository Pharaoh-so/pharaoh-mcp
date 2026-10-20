/**
 * Pure-logic device-flow state machine for the auth-required proxy mode.
 *
 * When Claude Code spawns the proxy without valid credentials, we can't just
 * exit — that would force the user to restart their agent every time. Instead,
 * the proxy stays alive, advertises a single MCP tool, and turns every tool
 * call into a device-flow lifecycle step: request a code, surface the URL,
 * poll once per tool call (rate-limited), and swap to the SSE backend once
 * the user authorizes.
 *
 * This module owns the state. It has no MCP imports and no knowledge of the
 * stdio transport — those live in backend.ts and proxy-server.ts. The only
 * side effects are (a) POSTing to the Pharaoh /device and /device/token
 * endpoints via auth.ts, (b) opening a browser once per cycle, and (c)
 * writing credentials to disk on authorization.
 */

import {
	openBrowser,
	type PollResult,
	pollOnce,
	requestDeviceCode,
	type TokenResponse,
} from "./auth.js";
import { type Credentials, readCredentials, writeCredentials } from "./credentials.js";
import { resolveSseUrl, tokenToCredentials } from "./helpers.js";
import { refreshIfNeeded } from "./refresh.js";

/**
 * Structured MCP tool response returned when the proxy is waiting for auth.
 *
 * Shape rationale: MCP clients that inspect `_meta` can render the auth URL
 * and user code directly in their UI (Claude Code does this). Clients that
 * only read `content[0].text` see the same information in human-readable form.
 * `isError: true` ensures Claude Code surfaces this to the user as an actionable
 * error rather than silently eating the response.
 */
export interface ToolAuthResponse {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
	_meta: {
		auth_url: string;
		user_code: string;
		expires_in_seconds: number;
	};
}

/** Public surface consumed by AuthRequiredBackend. */
export interface DeviceFlowGateway {
	/**
	 * Called on every pre-auth tool invocation. Returns null when credentials
	 * just became valid (caller should swap to SSE backend); otherwise returns
	 * the auth-required tool response. Never throws — all error paths collapse
	 * into a ToolAuthResponse the agent can surface.
	 */
	handleToolCall(): Promise<ToolAuthResponse | null>;
	/** True when credentials on disk are present and not access-expired. */
	hasValidCredentials(): boolean;
	/** The last credentials loaded from disk; null if never loaded successfully. */
	getCredentials(): Credentials | null;
}

/** Internal state of the pending device-flow cycle. */
interface PendingState {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_at: number;
	interval_ms: number;
	/** Always a number — seeded in startNewCycle, updated on every poll. */
	last_poll_at: number;
	/** Cached response so we return identical content between polls. */
	response: ToolAuthResponse;
}

/**
 * True when the credentials' access token is at or past its expiry.
 *
 * Takes `now` as a parameter so boundary tests (Date.now() === expires_at
 * exactly) work naturally with the gateway's injected clock — previously
 * this used Date.now() directly, which couldn't be controlled from tests.
 */
function isAccessExpired(creds: Credentials, now: () => number): boolean {
	const expiresAt = new Date(creds.expires_at).getTime();
	if (Number.isNaN(expiresAt)) return true;
	return now() >= expiresAt;
}

function buildAuthResponse(device: {
	verification_uri: string;
	verification_uri_complete: string;
	user_code: string;
	expires_in: number;
	errorMessage?: string;
}): ToolAuthResponse {
	// Stryker disable next-line StringLiteral: user-facing UX copy; wording
	// changes are deliberate and covered by manual review, not mutation testing.
	const prefix = device.errorMessage ? `${device.errorMessage}\n\n` : "";
	const text =
		// Stryker disable next-line StringLiteral: user-facing UX copy
		`${prefix}Pharaoh authentication required.\n\n` +
		// Stryker disable next-line StringLiteral: user-facing UX copy
		`  1. Visit ${device.verification_uri_complete}\n` +
		// Stryker disable next-line StringLiteral: user-facing UX copy
		`  2. Enter code: ${device.user_code}\n` +
		// Stryker disable next-line StringLiteral: user-facing UX copy
		`  3. Re-run this tool after authorizing.`;
	return {
		content: [{ type: "text", text }],
		isError: true,
		_meta: {
			auth_url: device.verification_uri_complete,
			user_code: device.user_code,
			expires_in_seconds: device.expires_in,
		},
	};
}

/**
 * Create a fresh state-machine instance. Each proxy spawn gets one gateway;
 * its lifecycle is the lifecycle of the stdio process.
 */
export function createGateway(opts: {
	server: string;
	credentialsPath?: string;
	/** Test hook for deterministic expiry/interval math. Do not use in prod. */
	now?: () => number;
	/**
	 * Override the browser-open side effect. Tests MUST pass a noop — the real
	 * impl calls `open`/`xdg-open` on the OS, which hits a user's actual browser
	 * even when the URL points at an ephemeral test server that's already closed.
	 * Default: the platform-native open from auth.ts.
	 */
	openBrowser?: (url: string) => void;
}): DeviceFlowGateway {
	const now = opts.now ?? (() => Date.now());
	// Stryker disable next-line LogicalOperator: the `??` fallback is exercised
	// at runtime when no opts.openBrowser is passed, but tests vi.mock auth.js's
	// openBrowser to a noop, so a mutated operator can't be distinguished via
	// observable behavior. vi.mock is the safety net; the fallback is defense
	// in depth for production. See packages/mcp-proxy/tests/*.test.ts for the
	// module-level mock that keeps real browser-open calls out of CI.
	const openBrowserImpl = opts.openBrowser ?? openBrowser;
	let pending: PendingState | null = null;
	let lastCreds: Credentials | null = null;

	/** Start a new device-flow cycle: POST /device, open browser, cache state. */
	async function startNewCycle(): Promise<ToolAuthResponse> {
		const device = await requestDeviceCode(opts.server);
		// Browser-open is opportunistic. Headless environments (SSH, containers,
		// CI runners with no DE) are first-class — the URL surfaces in the tool
		// response regardless, so a throwing opener must not mask it.
		try {
			openBrowserImpl(device.verification_uri_complete);
		} catch {
			// ALLOWED-CATCH: browser-open failures are non-fatal by design
		}
		const response = buildAuthResponse(device);
		// last_poll_at is seeded with now() — the cycle start counts as a
		// server round-trip, so the next tool call shouldn't immediately
		// re-hit /device/token within the interval window. This is what
		// makes scenario "rapid-fire calls right after auth URL appears"
		// not flood the server's 20/min rate limiter.
		pending = {
			device_code: device.device_code,
			user_code: device.user_code,
			verification_uri: device.verification_uri,
			verification_uri_complete: device.verification_uri_complete,
			expires_at: now() + device.expires_in * 1000,
			interval_ms: device.interval * 1000,
			last_poll_at: now(),
			response,
		};
		return response;
	}

	/**
	 * Persist a new session's credentials. Separated so handleToolCall stays
	 * simple — see how success is collapsed into `pending = null; return null`.
	 */
	function persistAuthorizedToken(token: TokenResponse): void {
		const sseUrl = resolveSseUrl(token.sse_url, opts.server);
		const creds = tokenToCredentials(token, sseUrl);
		writeCredentials(creds, opts.credentialsPath);
		lastCreds = creds;
		pending = null;
	}

	/** Decide whether the cached response is still valid without polling. */
	function shouldSkipPoll(state: PendingState): boolean {
		return now() - state.last_poll_at < state.interval_ms;
	}

	/**
	 * Handle the result of a single /device/token poll. Mutates state as a
	 * side effect and returns the outbound response (or null on authorization).
	 * Network errors fall through silently (no state change, retry on next call).
	 */
	function applyPollResult(state: PendingState, result: PollResult): ToolAuthResponse | null {
		if (result.status === "authorized") {
			persistAuthorizedToken(result.token);
			return null;
		}
		if (result.status === "denied") {
			// Clear state so the next call starts fresh. Return the error text
			// inline so the agent sees why; the user will naturally retry.
			pending = null;
			return {
				// Stryker disable next-line StringLiteral: user-facing UX copy
				content: [{ type: "text", text: `Pharaoh auth denied: ${result.error}` }],
				isError: true,
				_meta: {
					auth_url: state.verification_uri,
					user_code: state.user_code,
					expires_in_seconds: 0,
				},
			};
		}
		// pending, expired, network_error: keep cached response. Expired is
		// handled by the expiry check in handleToolCall; we don't force it here
		// because applyPollResult runs AFTER the expiry check, which means an
		// expired server code here is a rare race (<1s window) and getting the
		// same response back is fine.
		return state.response;
	}

	async function handleToolCall(): Promise<ToolAuthResponse | null> {
		// Another process may have signed in since this proxy started — a sibling
		// proxy finishing device flow, or `npx @pharaoh-so/mcp` in a terminal.
		// Use those credentials rather than asking the user to sign in again.
		if (await useStoredCredentials()) {
			pending = null;
			return null;
		}

		// No active cycle — start one.
		if (pending === null) {
			return startNewCycle();
		}

		// Client-side expiry check. If the device code has expired, the server
		// will reject further polls; clear state and start a fresh cycle. This
		// is the only state transition triggered purely by time.
		if (now() >= pending.expires_at) {
			pending = null;
			return startNewCycle();
		}

		// Rate-limit: respect the server's interval so we don't hammer /token
		// when agents rapid-fire tool calls on failure.
		if (shouldSkipPoll(pending)) {
			return pending.response;
		}

		const state = pending;
		state.last_poll_at = now();
		const result = await pollOnce(opts.server, state.device_code);
		return applyPollResult(state, result);
	}

	function hasValidCredentials(): boolean {
		const creds = readCredentials(opts.credentialsPath);
		if (!creds) return false;
		lastCreds = creds;
		return !isAccessExpired(creds, now);
	}

	/**
	 * True when credentials on disk are usable now: valid as stored, or
	 * refreshed successfully. Sets lastCreds to whatever will be used.
	 */
	async function useStoredCredentials(): Promise<boolean> {
		if (hasValidCredentials()) return true;
		// Read the file again rather than reuse lastCreds: a rejected refresh
		// deletes the file, and its dead token must not be sent on every call.
		const stored = readCredentials(opts.credentialsPath);
		if (!stored) return false;
		const refreshed = await refreshIfNeeded(stored, opts.server, opts.credentialsPath);
		if (!refreshed.ok) {
			process.stderr.write(
				`Pharaoh: stored credentials unusable (${refreshed.action}) — ${refreshed.message}\n`,
			);
			return false;
		}
		lastCreds = refreshed.creds;
		return true;
	}

	function getCredentials(): Credentials | null {
		return lastCreds;
	}

	return { handleToolCall, hasValidCredentials, getCredentials };
}
