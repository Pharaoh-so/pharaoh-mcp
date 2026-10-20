/**
 * Silent access-token renewal via OAuth2 refresh grant.
 *
 * Called at proxy startup (when access is expired but refresh is valid) and on
 * mid-session 401 (from proxy.ts TokenExpiredError handler). Success writes new
 * credentials to disk. Failure returns a classified action so the caller can
 * decide whether to preserve credentials for a later retry or re-authenticate.
 *
 * Every proxy on the machine shares one credentials file and one OAuth session,
 * and the server keeps one access token per session — each refresh invalidates
 * every other proxy's token. So refreshes run one at a time under the
 * credentials lock, and a proxy whose token was replaced by another proxy's
 * refresh adopts the new credentials instead of refreshing again.
 */
import type { Credentials } from "./credentials.js";
import {
	acquireCredentialsLock,
	deleteCredentials,
	isExpired,
	isRefreshExpired,
	readCredentials,
	writeCredentials,
} from "./credentials.js";

/**
 * Subset of the OAuth2 token response returned by the refresh grant.
 * Refresh doesn't re-issue identity fields (github_login, tenant_name, repos)
 * or the sse_url — those are carried over from existing credentials.
 */
interface RefreshGrantResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	refresh_token_expires_in: number;
}

/** Outcome of a refresh attempt. */
export type RefreshOutcome =
	| { ok: true; creds: Credentials }
	| { ok: false; action: RefreshFailureAction; message: string };

/**
 * How the caller should handle a failed refresh.
 *
 * - `reauth`:    server says the refresh token is dead (revoked, expired past
 *                grace, user removed from org). Delete credentials and prompt
 *                for re-auth on next start.
 * - `preserve`:  transient server/network failure (503, fetch error). Keep the
 *                credentials file intact — the next startup may succeed.
 * - `transient`: unexpected response shape we can't confidently classify. Keep
 *                credentials, exit with a diagnostic message. If this branch
 *                fires often in production, tighten classification.
 */
export type RefreshFailureAction = "reauth" | "preserve" | "transient";

/** Classify a non-200 response from the /token refresh endpoint. */
function classifyRefreshError(
	status: number,
	body: { error?: string; error_description?: string },
): RefreshFailureAction {
	// 503 or network — the server or GitHub API had a blip. Keep the refresh
	// token; the next proxy spawn will retry. Blowing away good creds on a
	// transient failure is exactly the "forced re-auth" pattern we're trying
	// to eliminate (VestaTech-BV churn was this exact shape).
	if (status >= 500) return "preserve";

	// 400 invalid_grant covers all three terminal cases from the server:
	//   • user removed from GitHub org (not_member)
	//   • session unreadable / pre-GCM CBC (reauth_required)
	//   • refresh token expired or rotated out of grace window
	// All three mean: the creds cannot produce a working session. Delete them
	// so the next spawn shows the re-auth prompt instead of looping forever.
	if (status === 400 && body.error === "invalid_grant") return "reauth";

	// Anything else — 401 without invalid_grant, 403, 404, parse error, etc.
	// Don't delete creds (might be recoverable), but don't pretend it's
	// transient either. Log-friendly exit, preserve creds, let the next spawn
	// retry. If this case fires in practice, we'll see it in logs and tighten
	// the classification.
	return "transient";
}

/**
 * Deadline for the refresh request. Kept under the lock's stale age
 * (credentials.ts LOCK_STALE_MS) so a refresh still in flight is never broken
 * by another proxy that would then refresh the same token again.
 */
const REFRESH_TIMEOUT_MS = 10_000;

/**
 * Renew the access token, coordinating with every other proxy on the machine.
 *
 * Under the credentials lock: if the file already holds a different, unexpired
 * access token than `creds` (another proxy refreshed, or someone signed in), those
 * credentials are returned without a request. Otherwise the refresh grant runs.
 * On `reauth`, the file is deleted only if it still holds the rejected refresh
 * token; a file rewritten while the request was in flight is adopted instead.
 *
 * @param creds   the credentials the caller was using (possibly access-expired or rejected)
 * @param server  Pharaoh server base URL (e.g. "https://mcp.pharaoh.so")
 * @param path    optional custom credentials path (for tests)
 * @param timeoutMs how long the refresh request may take (for tests)
 * @returns New or adopted credentials, or a classified failure. A lock held by
 *   another proxy for too long is `transient` (credentials untouched).
 */
export async function refreshIfNeeded(
	creds: Credentials,
	server: string,
	path?: string,
	timeoutMs = REFRESH_TIMEOUT_MS,
): Promise<RefreshOutcome> {
	let release: () => void;
	try {
		release = await acquireCredentialsLock(path);
	} catch (err) {
		return {
			ok: false,
			action: "transient",
			message: err instanceof Error ? err.message : String(err),
		};
	}
	try {
		const current = readCredentials(path);
		if (current && current.access_token !== creds.access_token && !isExpired(current)) {
			return { ok: true, creds: current };
		}
		const source = current ?? creds;
		const outcome = await requestRefresh(source, server, timeoutMs, path);
		if (outcome.ok || outcome.action !== "reauth") return outcome;

		const after = readCredentials(path);
		if (!after || after.refresh_token === source.refresh_token) {
			deleteCredentials(path);
			return outcome;
		}
		return isExpired(after) ? outcome : { ok: true, creds: after };
	} finally {
		release();
	}
}

/**
 * One refresh-grant round trip: POST the refresh token, persist and return the
 * new credentials on success, or classify the failure. Caller holds the lock.
 */
async function requestRefresh(
	creds: Credentials,
	server: string,
	timeoutMs: number,
	path?: string,
): Promise<RefreshOutcome> {
	// Guard: refresh token itself expired. No point hitting the server — the
	// grant will fail with invalid_grant. Short-circuit to reauth.
	if (isRefreshExpired(creds)) {
		return {
			ok: false,
			action: "reauth",
			message: "Refresh token expired",
		};
	}

	let res: Response;
	try {
		// POST to /device/token-refresh — RFC 8628 device-flow refresh. Distinct
		// from /token (browser OAuth) because device flow has no client_id —
		// the refresh_token itself is the credential.
		res = await fetch(`${server}/device/token-refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				refresh_token: creds.refresh_token,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		// Network failure — keep creds, let the next spawn retry.
		return {
			ok: false,
			action: "preserve",
			message: `Network error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (res.ok) {
		// Parse body inside try/catch — a 200 response with truncated/malformed
		// JSON (CDN/proxy mangling, connection drop mid-stream) would otherwise
		// throw SyntaxError out of refreshIfNeeded and hit main()'s redact-only
		// catch, giving the user no classification.
		let token: RefreshGrantResponse;
		try {
			token = (await res.json()) as RefreshGrantResponse;
		} catch (err) {
			return {
				ok: false,
				action: "transient",
				message: `Malformed JSON in refresh response: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		if (
			!token.access_token ||
			!token.refresh_token ||
			!token.expires_in ||
			!token.refresh_token_expires_in
		) {
			// Server OK'd the request but returned an incomplete body. Treat as
			// transient rather than reauth — the creds we have are still valid.
			// (0 is not a legal OAuth2 TTL per RFC 6749; a server returning 0 is
			// a regression, not a signal to delete credentials.)
			return {
				ok: false,
				action: "transient",
				message: "Refresh response missing required fields",
			};
		}
		const now = Date.now();
		const newCreds: Credentials = {
			...creds,
			access_token: token.access_token,
			refresh_token: token.refresh_token,
			expires_at: new Date(now + token.expires_in * 1000).toISOString(),
			refresh_expires_at: new Date(now + token.refresh_token_expires_in * 1000).toISOString(),
			expires_in: token.expires_in,
		};
		// Persist new credentials. If the disk write fails (EACCES, ENOSPC,
		// EROFS), report `preserve` — the server already rotated the token
		// server-side, so the old refresh_token is now in grace. Returning
		// `ok: true` here would mean the next spawn reads stale creds and
		// attempts to refresh with a rotated token, forcing an unnecessary
		// re-auth. Preserving lets the user fix the disk issue and retry
		// within the grace window.
		try {
			writeCredentials(newCreds, path);
		} catch (err) {
			return {
				ok: false,
				action: "preserve",
				message: `Could not persist refreshed credentials: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		return { ok: true, creds: newCreds };
	}

	let body: { error?: string; error_description?: string } = {};
	try {
		body = (await res.json()) as { error?: string; error_description?: string };
	} catch {
		// ALLOWED-CATCH: non-JSON body — classify on status alone
	}

	const action = classifyRefreshError(res.status, body);
	const message = body.error_description ?? body.error ?? `HTTP ${res.status} ${res.statusText}`;
	return { ok: false, action, message };
}

/**
 * Read credentials from disk and refresh if the access token is expired.
 *
 * Returns:
 * - `null` if no credentials exist (caller should show re-auth instructions)
 * - `RefreshOutcome` with `ok: true` if creds are fresh or refresh succeeded
 * - `RefreshOutcome` with `ok: false` if refresh failed (check `.action`)
 *
 * Intended use: called at proxy startup to replace the current "die if expired"
 * branch in index.ts.
 */
export async function loadAndRefresh(
	server: string,
	path?: string,
): Promise<RefreshOutcome | null> {
	const creds = readCredentials(path);
	if (!creds) return null;

	// Access token still valid — no refresh needed.
	const expiresAt = new Date(creds.expires_at).getTime();
	const bufferMs = creds.expires_in * 1000 * 0.1;
	if (Date.now() < expiresAt - bufferMs) {
		return { ok: true, creds };
	}

	return refreshIfNeeded(creds, server, path);
}
