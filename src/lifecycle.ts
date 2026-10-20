/**
 * Proxy lifecycle helpers — credential state transitions and re-auth messaging.
 *
 * Extracted from index.ts so the branching logic can be unit-tested without
 * booting the full CLI. Imported by main() and exercised as a real runtime
 * dependency — no "test-only exports" here.
 */
import type { Credentials } from "./credentials.js";
import { NPX_COMMAND, printLines } from "./helpers.js";
import { type RefreshFailureAction, refreshIfNeeded } from "./refresh.js";

/** Discriminated result from tryMidSessionRefresh. */
export type MidSessionRefreshResult =
	| { ok: true; creds: Credentials }
	| { ok: false; action: RefreshFailureAction; message: string };

/**
 * Attempt a silent refresh triggered by a mid-session TokenExpiredError.
 * Returns new credentials on success, or a tagged failure carrying the
 * RefreshFailureAction so the caller can branch on the real classification
 * instead of re-inferring from disk state.
 *
 * @param creds - The credentials whose access token the server just rejected.
 *   When another proxy has already refreshed, its newer credentials come back
 *   without a second refresh.
 */
export async function tryMidSessionRefresh(
	creds: Credentials,
	server: string,
): Promise<MidSessionRefreshResult> {
	const outcome = await refreshIfNeeded(creds, server);
	if (outcome.ok) return { ok: true, creds: outcome.creds };

	// Log the failure reason before the caller decides what to do.
	if (outcome.action === "reauth") {
		// refreshIfNeeded already removed the rejected credentials (if no other
		// process had replaced them) — deletion has one owner, under the lock.
		printLines("Pharaoh: refresh rejected — re-authentication required.", `  ${NPX_COMMAND}`, "");
	} else {
		// preserve / transient — keep creds, print diagnostic + next-step hint so
		// the user knows their credentials file is intact (matches startup path).
		printLines(
			`Pharaoh: refresh failed (${outcome.action}) — ${outcome.message}`,
			"Credentials preserved; next startup will retry.",
			"",
		);
	}
	return { ok: false, action: outcome.action, message: outcome.message };
}

/**
 * Handle a failed `loadAndRefresh` at startup. Exits the process with the
 * appropriate message per the classified action. Never deletes credentials:
 * refreshIfNeeded already did, under the lock, if they were the rejected ones.
 */
export function handleRefreshFailure(action: RefreshFailureAction, message: string): never {
	if (action === "reauth") {
		printLines("Pharaoh: session no longer valid — re-authenticate.", `  ${NPX_COMMAND}`, "");
		process.exit(1);
	}
	// preserve / transient — keep creds, exit with diagnostic. Next spawn will
	// try again; if the underlying cause clears, it just works.
	printLines(
		`Pharaoh: refresh failed (${action}) — ${message}`,
		"Credentials preserved; next startup will retry.",
		"",
	);
	process.exit(1);
}
