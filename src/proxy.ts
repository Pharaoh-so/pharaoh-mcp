/**
 * Typed SSE errors + classifier. The stdio ↔ SSE wiring itself lives in
 * backend.ts (SseProxyBackend); this module exports only the error types and
 * the classifier so both the backend and tests can produce/assert on the
 * same typed errors.
 *
 * RECONNECTION DESIGN (implemented in backend.ts SseProxyBackend):
 * The MCP SDK's SSEClientTransport wraps an EventSource, which has built-in
 * auto-reconnect (every 3s by default). This is problematic because:
 *   1. Each reconnect creates a NEW server-side session (new auth, new ID)
 *   2. The proxy's reconnect loop doesn't know about the internal reconnect
 *   3. Tool calls get lost between the stale and new sessions
 *
 * Solution: on any non-fatal SSE error, explicitly close() the transport to
 * kill the EventSource, then let the proxy's own backoff loop create a fresh
 * transport for the next attempt. See backend.ts SseProxyBackend.waitForClose.
 */

/** Thrown when the remote server returns 401 — token is expired or revoked. */
export class TokenExpiredError extends Error {
	constructor() {
		super("Token expired or revoked (401)");
		this.name = "TokenExpiredError";
	}
}

/** Thrown when the remote server returns 403 — tenant is suspended. */
export class TenantSuspendedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TenantSuspendedError";
	}
}

/**
 * Classify an SSE error — detect 401/403 and throw typed errors.
 * Exported for testability; used internally by the reconnect loop in
 * backend.ts.
 *
 * The fallback uses status-prefix regex patterns rather than a bare
 * `msg.includes("401")`. Session C calls this classifier on every reconnect
 * error (not just SSE transport onerror events), so a substring match would
 * misclassify any unrelated error text containing "401" — e.g. a port number,
 * a timestamp suffix, or HTML body text echoed from a proxy. The regex
 * requires an HTTP-shaped context so only actual status codes trigger a reauth
 * loop.
 */
export function classifySSEError(err: Error): void {
	const msg = err.message ?? "";
	// SseError from SDK includes the HTTP status code on `.code` — the
	// authoritative signal.
	if ("code" in err) {
		const code = (err as { code?: number }).code;
		if (code === 401) throw new TokenExpiredError();
		if (code === 403) throw new TenantSuspendedError(msg || "Tenant suspended");
	}
	// Fallback regex for errors that don't expose `.code`. Matches common HTTP
	// status renderings: "HTTP 401", "HTTP/1.1 401", "401 Unauthorized",
	// "status 401", "status: 401" — but NOT bare "401" anywhere in the string.
	const m = msg.match(
		/\b(?:HTTP(?:\/[\d.]+)?|status:?)\s+(\d{3})\b|\b(\d{3})\s+(?:Unauthorized|Forbidden)\b/i,
	);
	if (m) {
		const code = Number(m[1] ?? m[2]);
		if (code === 401) throw new TokenExpiredError();
		if (code === 403) throw new TenantSuspendedError(msg || "Tenant suspended");
	}
}
