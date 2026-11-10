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
const TIMEOUT_MS = 5_000;

function lastAttempt(path: string): number {
	try {
		return Number(readFileSync(`${path}.memory-check`, "utf8")) || 0;
	} catch {
		return 0;
	}
}

/**
 * Ask the server for this sign-in's current memory hint and store it.
 *
 * @param server - Pharaoh server origin; only production carries hints
 * @param options.force - Skip the daily and hourly waits (the installer)
 * @param options.path - Credentials file (tests)
 * @param options.rounds - Calls allowed when the server asks to retry (about a minute apart)
 * @returns The updated credentials, or null when nothing changed on disk
 */
export async function updateMemoryHint(
	server: string,
	{
		force = false,
		path = CREDENTIALS_PATH,
		rounds = 12,
	}: { force?: boolean; path?: string; rounds?: number } = {},
): Promise<Credentials | null> {
	if (server !== DEFAULT_SERVER) return null;
	const now = Date.now();
	const before = await withLock(path, () => {
		const creds = readCredentials(path);
		if (!creds || new URL(creds.sse_url).origin !== DEFAULT_SERVER) return null;
		const checked = Date.parse(creds.project_memory_checked_at ?? "") || 0;
		if (!force && (now - checked < RECHECK_MS || now - lastAttempt(path) < RETRY_MS)) return null;
		// One attempt per hour across every proxy sharing this file, recorded beside it.
		writeFileSync(`${path}.memory-check`, String(now), { mode: 0o600 });
		return creds;
	});
	if (!before) return null;
	// A check of many repos completes over several calls: follow the server's retry hint.
	let body: {
		project_memory?: unknown;
		project_memory_checked?: unknown;
		project_memory_retry_after_ms?: unknown;
	};
	for (let round = 1; ; round++) {
		try {
			const res = await fetch(`${server}/device/project-memory`, {
				headers: { Authorization: `Bearer ${before.access_token}` },
				redirect: "error",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!res.ok) return null;
			body = (await res.json()) as typeof body;
		} catch {
			return null;
		}
		const wait = Number(body?.project_memory_retry_after_ms);
		if (body?.project_memory_checked === true || !(wait > 0) || round >= rounds) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 120_000)).unref());
	}
	// An incomplete check proves nothing either way: keep what is stored.
	if (body?.project_memory_checked !== true) return null;
	const hint = validMemoryHint(body.project_memory);
	return withLock(path, () => {
		const current = readCredentials(path);
		// A different sign-in replaced the file meanwhile; its own check comes later.
		if (!current || current.github_login !== before.github_login) return null;
		const {
			project_memory: previous,
			project_memory_status: _status,
			project_memory_session: session,
			...rest
		} = current;
		const same = JSON.stringify(previous ?? []) === JSON.stringify(hint);
		const next: Credentials = {
			...rest,
			...(hint.length
				? { project_memory: hint, project_memory_session: same && session ? session : randomUUID() }
				: {}),
			project_memory_checked_at: new Date(now).toISOString(),
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
