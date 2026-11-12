/**
 * Keeps the stored project-memory hint in step with the account's access now,
 * for sign-ins from before memory existed. A read-only server call: no token
 * rotates, and only the memory fields of the credentials file ever change.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
	acquireCredentialsLock,
	CREDENTIALS_PATH,
	type Credentials,
	readCredentials,
	writeCredentials,
} from "./credentials.js";
import { DEFAULT_SERVER, validMemoryHint } from "./helpers.js";

/** Re-check a complete hint once a day; after a failed or incomplete check, wait an hour. */
const RECHECK_MS = 24 * 3_600_000;
const RETRY_MS = 3_600_000;
/** How long a check in flight holds off other proxies; one cut short by its session ending frees up after it. */
const CLAIM_MS = 3 * 60_000;
const TIMEOUT_MS = 5_000;

/** The time before which no proxy sharing this file starts another check (recorded beside it). */
function blockedUntil(path: string): number {
	try {
		return Number(readFileSync(`${path}.memory-check`, "utf8")) || 0;
	} catch {
		return 0;
	}
}

/** Never throws: a marker that can't be written only means another check may start sooner. */
function holdOff(path: string, until: number): void {
	try {
		writeFileSync(`${path}.memory-check`, String(until), { mode: 0o600 });
	} catch {
		// ALLOWED-CATCH: the marker is an optimization; the check itself is optional
	}
}

/**
 * Ask the server for this sign-in's current memory hint and store it.
 *
 * @param server - Pharaoh server origin; only production carries hints
 * @param options.force - Skip the daily and hourly waits (the installer)
 * @param options.path - Credentials file (tests)
 * @param options.rounds - Calls allowed when the server asks to retry (about a minute apart)
 * @param options.background - Inside a running proxy: the waits never keep the process alive
 * @param options.onPartial - Called when an incomplete answer adds proven repos, so hooks turn on before the check finishes
 * @returns The updated credentials, or null when nothing changed on disk
 */
export async function updateMemoryHint(
	server: string,
	{
		force = false,
		path = CREDENTIALS_PATH,
		rounds = 12,
		background = false,
		onPartial,
	}: {
		force?: boolean;
		path?: string;
		rounds?: number;
		background?: boolean;
		onPartial?: (creds: Credentials) => void;
	} = {},
): Promise<Credentials | null> {
	if (server !== DEFAULT_SERVER) return null;
	const now = Date.now();
	const before = await withLock(path, () => {
		const creds = readCredentials(path);
		if (!creds || new URL(creds.sse_url).origin !== DEFAULT_SERVER) return null;
		const checked = Date.parse(creds.project_memory_checked_at ?? "") || 0;
		if (!force && (now - checked < RECHECK_MS || now < blockedUntil(path))) return null;
		// One check at a time across every proxy sharing this file. The claim is short,
		// so a check cut short (its session ended) doesn't hold the next one off for an hour.
		holdOff(path, now + CLAIM_MS);
		return creds;
	});
	if (!before) return null;
	// A check of many repos completes over several calls: follow the server's retry hint.
	let body: {
		project_memory?: unknown;
		project_memory_checked?: unknown;
		project_memory_retry_after_ms?: unknown;
	};
	let partial: Credentials | null = null;
	const failed = () => {
		holdOff(path, Date.now() + RETRY_MS);
		return partial;
	};
	for (let round = 1; ; round++) {
		try {
			const res = await fetch(`${server}/device/project-memory`, {
				headers: { Authorization: `Bearer ${before.access_token}` },
				redirect: "error",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!res.ok) return failed();
			body = (await res.json()) as typeof body;
		} catch {
			return failed();
		}
		const wait = Number(body?.project_memory_retry_after_ms);
		if (body?.project_memory_checked === true) break;
		// Proven repos turn their hooks on now; the check carries on for the rest.
		const proven = validMemoryHint(body?.project_memory);
		if (proven.length) {
			const stored = await store(path, before, proven, false, now);
			if (stored) {
				partial = stored;
				onPartial?.(stored);
			}
		}
		if (!(wait > 0) || round >= rounds) break;
		// Still checking: keep the claim alive through the wait.
		holdOff(path, Date.now() + Math.min(wait, 120_000) + CLAIM_MS);
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, Math.min(wait, 120_000));
			// A running proxy must not stay up for this wait; the installer must, or Node exits mid-await.
			if (background) timer.unref();
		});
	}
	if (body?.project_memory_checked !== true) return failed();
	return store(path, before, validMemoryHint(body.project_memory), true, now);
}

/**
 * Write the memory fields only. A complete check replaces the hint (an empty one
 * clears it) and records the check; an incomplete one adds the repos it proved.
 */
function store(
	path: string,
	before: Credentials,
	hint: Array<{ repo: string; revision: string | null }>,
	complete: boolean,
	now: number,
): Promise<Credentials | null> {
	return withLock(path, () => {
		const current = readCredentials(path);
		// A different sign-in replaced the file meanwhile; its own check comes later.
		if (!current || current.github_login !== before.github_login) return null;
		// A check that completed after this one started is newer: a late partial answer
		// must not re-add a repo it removed.
		if (!complete && (Date.parse(current.project_memory_checked_at ?? "") || 0) >= now) return null;
		const {
			project_memory: previous,
			project_memory_status: _status,
			project_memory_session: session,
			...rest
		} = current;
		const known = complete
			? hint
			: [
					...(previous ?? []),
					...hint.filter((entry) => !previous?.some((kept) => kept.repo === entry.repo)),
				];
		const same = JSON.stringify(previous ?? []) === JSON.stringify(known);
		const next: Credentials = {
			...rest,
			...(known.length
				? {
						project_memory: known,
						project_memory_session: same && session ? session : randomUUID(),
					}
				: {}),
			...(complete ? { project_memory_checked_at: new Date(now).toISOString() } : {}),
		};
		writeCredentials(next, path);
		return next;
	});
}

/** Run `work` holding the credentials lock; any failure means "nothing changed". */
async function withLock<T>(path: string, work: () => T | null): Promise<T | null> {
	let release: () => void;
	try {
		release = await acquireCredentialsLock(path);
	} catch {
		return null;
	}
	try {
		return work();
	} catch {
		return null;
	} finally {
		release();
	}
}
