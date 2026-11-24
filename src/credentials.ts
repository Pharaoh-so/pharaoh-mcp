/**
 * Credential storage for Pharaoh MCP proxy — persists device flow tokens to ~/.pharaoh/credentials.json.
 * File permissions: 0600 (credentials.json, its lock and temp files), 0700 (~/.pharaoh/).
 *
 * Every proxy on a machine shares this file and the one OAuth session behind it, so
 * refreshes take a lock (acquireCredentialsLock) and writes are atomic.
 */
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	beginFeedSignIn,
	bootstrapFeedSignIn,
	commitFeedSignIn,
	readFeedSignIn,
	withdrawFeedSignIn,
} from "../runtime/feed-signin.mjs";

/**
 * A lock older than this was left by a proxy that died mid-refresh; it may be
 * broken. Above refresh.ts REFRESH_TIMEOUT_MS, so a live refresh never looks stale.
 */
const LOCK_STALE_MS = 15_000;

/** How long to wait for another proxy's refresh — longer than LOCK_STALE_MS, so a dead holder's lock gets broken. */
const LOCK_WAIT_MS = 20_000;

/** How often to check whether the lock is free. */
const LOCK_POLL_MS = 50;

/**
 * Current credential schema version. v2 adds refresh_token + refresh_expires_at
 * so the proxy can silently renew access tokens. v1 files parse as null, which
 * forces one re-auth on upgrade — unavoidable because v1 never had a refresh
 * token to upgrade from.
 */
const SCHEMA_VERSION = 2;

/** Stored credential shape. */
export interface Credentials {
	/** Only set on the separate origin-bound design credential. */
	designScope?: "design:read" | "design:draft";
	version: typeof SCHEMA_VERSION;
	access_token: string;
	/** Refresh token used by refreshIfNeeded() to renew the access token. */
	refresh_token: string;
	/** ISO 8601 timestamp when the access token expires. */
	expires_at: string;
	/** ISO 8601 timestamp when the refresh token itself expires. */
	refresh_expires_at: string;
	/** Original access token TTL in seconds (from the token response). */
	expires_in: number;
	sse_url: string;
	github_login: string | null;
	tenant_name: string | null;
	repos: string[];
	/** Device sign-in hint only; the server authorizes every memory operation. */
	project_memory?: Array<{ repo: string; revision: string | null }>;
	project_memory_status?: "unavailable";
	/** Local readiness binding, stable only across refreshes of this sign-in. */
	project_memory_session?: string;
	/** When the server last answered the hint completely (memory-hint.ts); absent before 0.3.80. */
	project_memory_checked_at?: string;
	/** Private installation binding, preserved across refresh and replaced on a new sign-in. */
	runtime_session?: string;
	/** Explicit sign-in fence for optional native context; preserved by ordinary refreshes. */
	native_feed_generation?: string;
}

/** Default credential file path (route-grep-hook.ts checks the same file to know Pharaoh is signed in). */
export const CREDENTIALS_PATH = join(homedir(), ".pharaoh", "credentials.json");

/**
 * Read and parse stored credentials. Returns null if missing, unreadable,
 * malformed, or wrong schema version (v1 credentials will return null here,
 * forcing one last re-auth on upgrade to v2).
 */
export function readCredentials(path = CREDENTIALS_PATH): Credentials | null {
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!isValidCredentials(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Write credentials to disk with restrictive permissions.
 * Creates the parent directory (0700) if it doesn't exist. Writes a 0600 temp
 * file and renames it over the target, so a reader never sees a half-written file.
 */
export function writeCredentials(creds: Credentials, path = CREDENTIALS_PATH): void {
	ensureDir(path);
	const tmp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(creds, null, "\t"), { mode: 0o600 });
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}

/** Publish a newly authorized sign-in without racing a refresh from the previous one. */
export async function saveAuthorizedCredentials(
	credentials: Credentials,
	path = CREDENTIALS_PATH,
): Promise<void> {
	const release = await acquireCredentialsLock(path);
	try {
		// The credential write fences old feed state even when optional marker IO fails.
		const generation = randomUUID();
		writeCredentials({ ...credentials, native_feed_generation: generation }, path);
		if (process.platform !== "win32") {
			try {
				const pending = beginFeedSignIn(credentials.sse_url, path, generation);
				commitFeedSignIn(pending, path);
			} catch {
				// Native context is optional; a mismatching marker stays unreadable.
			}
		}
	} finally {
		release();
	}
}

/**
 * Initialize native feed identity for a legacy sign-in already validated by install.
 * Acquires the credential lock and refuses a different saved authorization or server.
 * @returns The committed generation, or null when the sign-in changed or was withdrawn.
 */
export async function bootstrapLegacyFeedSignIn(
	validated: Credentials,
	server: string,
	path = CREDENTIALS_PATH,
): Promise<string | null> {
	if (process.platform === "win32") return null;
	const release = await acquireCredentialsLock(path);
	try {
		const current = readCredentials(path);
		if (
			!current ||
			current.access_token !== validated.access_token ||
			current.refresh_token !== validated.refresh_token ||
			current.sse_url !== validated.sse_url ||
			new URL(current.sse_url).origin !== new URL(server).origin
		)
			return null;
		const active = readFeedSignIn(path);
		if (active) return active.server === new URL(server).origin ? active.generation : null;
		// Existing generation without a readable marker is an incomplete publication, not legacy.
		if (current.native_feed_generation) return null;
		try {
			return bootstrapFeedSignIn(server, path, (generation) => {
				writeCredentials({ ...current, native_feed_generation: generation }, path);
			});
		} catch {
			// A failed optional bootstrap must not prevent the working client setup.
			return null;
		}
	} finally {
		release();
	}
}

/**
 * Take the lock that serializes token refreshes across every proxy on this
 * machine. Waits while another proxy holds it; breaks a lock older than
 * LOCK_STALE_MS (its owner died mid-refresh).
 *
 * @param path - Credentials file the lock guards (lock lives at `${path}.lock`).
 * @returns A release function that removes the lock only if this caller still owns it.
 * @throws If the lock stays held for LOCK_WAIT_MS, or a stale lock can't be removed.
 */
export async function acquireCredentialsLock(path = CREDENTIALS_PATH): Promise<() => void> {
	ensureDir(path);
	const lockPath = `${path}.lock`;
	const owner = `${process.pid}:${randomUUID()}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			writeFileSync(lockPath, owner, { flag: "wx", mode: 0o600 });
			return () => {
				try {
					releaseLock(lockPath, owner);
				} catch (err) {
					// The refresh is done; a lock left behind goes stale and is broken later.
					process.stderr.write(
						`Pharaoh: couldn't remove ${lockPath}: ${err instanceof Error ? err.message : String(err)}\n`,
					);
				}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		// Remove only the lock judged stale: another waiter may already have broken
		// it and taken a fresh one, which an unconditional unlink would delete.
		const holder = lockHolder(lockPath);
		if (holder !== null && lockAgeMs(lockPath) > LOCK_STALE_MS) {
			releaseLock(lockPath, holder);
			continue;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Another Pharaoh process has held ${lockPath} for over ${LOCK_WAIT_MS / 1000}s`,
			);
		}
		await sleep(LOCK_POLL_MS);
	}
}

/** The lock's owner tag, or null when no lock exists. */
function lockHolder(lockPath: string): string | null {
	try {
		return readFileSync(lockPath, "utf-8");
	} catch (err) {
		if (!isMissing(err)) throw err;
		return null; // released between our create attempt and this read — retry immediately
	}
}

/**
 * Remove the lock file — only while it still holds `owner`.
 * @throws When the lock exists but can't be read or removed (permissions).
 */
function releaseLock(lockPath: string, owner: string): void {
	try {
		if (readFileSync(lockPath, "utf-8") !== owner) return;
		unlinkSync(lockPath);
	} catch (err) {
		if (!isMissing(err)) throw err; // already gone — nothing to release
	}
}

/** True when a filesystem error means the file isn't there — the only one the lock helpers expect. */
function isMissing(err: unknown): boolean {
	return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Milliseconds since the lock was written; 0 if it vanished meanwhile. */
function lockAgeMs(lockPath: string): number {
	try {
		return Date.now() - statSync(lockPath).mtimeMs;
	} catch (err) {
		if (!isMissing(err)) throw err;
		return 0; // released between our create attempt and this stat — retry immediately
	}
}

/**
 * Create `~/.pharaoh` with mode 0700 and set that mode again if it already
 * exists. The one place the directory is created, whichever path gets there
 * first (credentials or the Claude Code plugin marketplace), so it is never
 * left world-readable (security review SC-8).
 *
 * @param dir - The directory (defaults to `~/.pharaoh`).
 */
export function ensurePharaohHome(dir = join(homedir(), ".pharaoh")): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

/** Create the directory holding a credentials file (0700). */
function ensureDir(path: string): void {
	ensurePharaohHome(dirname(path));
}

/** Delete the credential file. No-op if it doesn't exist. */
export function deleteCredentials(path = CREDENTIALS_PATH): void {
	try {
		if (process.platform !== "win32") withdrawFeedSignIn(path);
	} catch {
		// Missing or unsafe private state already prevents a scoped feed read.
	}
	try {
		unlinkSync(path);
	} catch {
		// File doesn't exist — nothing to delete
	}
}

/** Snapshot credentials for same-origin revocation and delete them under the refresh lock. */
export async function takeCredentialsForLogout(
	path = CREDENTIALS_PATH,
): Promise<Credentials | null> {
	const release = await acquireCredentialsLock(path);
	try {
		const previous = readCredentials(path);
		deleteCredentials(path);
		return previous;
	} finally {
		release();
	}
}

/**
 * Check if the access token is expired or within 10% of expiry.
 * The 10% buffer prevents connecting with a token that will expire mid-session.
 */
export function isExpired(creds: Credentials): boolean {
	const expiresAt = new Date(creds.expires_at).getTime();
	if (Number.isNaN(expiresAt)) return true;

	const now = Date.now();
	const totalTtlMs = creds.expires_in * 1000;
	const bufferMs = totalTtlMs * 0.1;

	return now >= expiresAt - bufferMs;
}

/**
 * Check if the refresh token itself has expired. When this returns true, even
 * refresh cannot rescue the session — the user must re-authenticate.
 */
export function isRefreshExpired(creds: Credentials): boolean {
	const refreshExpiresAt = new Date(creds.refresh_expires_at).getTime();
	if (Number.isNaN(refreshExpiresAt)) return true;
	return Date.now() >= refreshExpiresAt;
}

/** Type guard for valid credential objects. */
function isValidCredentials(value: unknown): value is Credentials {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return (
		obj.version === SCHEMA_VERSION &&
		typeof obj.access_token === "string" &&
		typeof obj.refresh_token === "string" &&
		typeof obj.expires_at === "string" &&
		typeof obj.refresh_expires_at === "string" &&
		typeof obj.expires_in === "number" &&
		typeof obj.sse_url === "string" &&
		Array.isArray(obj.repos)
	);
}
