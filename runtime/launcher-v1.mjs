/**
 * Pharaoh's stable launcher: the one path client registrations and hook
 * commands name, so an accepted update changes which version runs without
 * touching any client's settings (Codex asks to re-trust a changed hook).
 * Install copies this file alone to ~/.pharaoh/runtimes/mcp/launcher-v1.mjs,
 * so it imports nothing but Node built-ins. A change older registrations
 * can't run needs a new file name (launcher-v2.mjs) and a new migration.
 *
 * Proxy mode, `node launcher-v1.mjs [proxy flags]`: applies a staged, verified
 * update (pending.json) to current.json under .activate-lock, then runs the
 * current version, or the previous one when current is unusable. Nothing from
 * a version directory runs before the launcher has validated that directory.
 * Hook mode, `node launcher-v1.mjs hook <family> [args]`: runs that hook of the
 * current version, never activates, and stays silent on any failure.
 *
 * The runtime imports the same helpers from its own copy of this file
 * (src/update.ts, src/install.ts), so one lock and one pointer format serve both.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The launcher's own file name, as registrations and hook commands name it. */
export const LAUNCHER_NAME = "launcher-v1.mjs";
const PACKAGE_DIR = ["node_modules", "@pharaoh-so", "mcp"];
const PACKAGE_NAME = "@pharaoh-so/mcp";
/** Hook families a hook command can name, and their script in a version's package. */
const HOOKS = {
	"local-worktree": "runtime/local-worktree-hook.mjs",
};
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const LOCK = ".activate-lock";
const LOCK_STALE_MS = 60_000;
const POINTER_LIMIT = 16_384;
const LOG_LIMIT = 262_144;

/** `[major, minor, patch]` of a plain x.y.z version, or null. */
function parts(version) {
	return typeof version === "string" && VERSION.test(version)
		? version.split(".").map(Number)
		: null;
}

/**
 * Whether `candidate` is a plain x.y.z newer than `current` (anything newer than nothing).
 * @param {string} candidate
 * @param {string | undefined} current
 */
export function newerVersion(candidate, current) {
	const a = parts(candidate);
	if (!a) return false;
	const b = parts(current);
	if (!b) return current === undefined;
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
	return false;
}

/** A regular, non-link file's bytes, at most `limit` of them; null otherwise. */
function readSmallFile(path, limit = POINTER_LIMIT) {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > limit) return null;
		return readFileSync(path);
	} catch {
		return null;
	}
}

/**
 * Read one of the launcher's pointer files (current.json, pending.json, release.json).
 * @param {string} root - The runtimes directory (~/.pharaoh/runtimes/mcp)
 * @param {string} name - File name inside it
 * @returns {Record<string, unknown> | null} The parsed object, or null when absent or invalid
 */
export function readPointer(root, name) {
	const bytes = readSmallFile(join(root, name));
	if (!bytes) return null;
	try {
		const value = JSON.parse(bytes.toString("utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * Replace a pointer file atomically: a reader sees the old file or the new one, never part of one.
 * @param {string} root - The runtimes directory
 * @param {string} name - File name inside it
 * @param {Record<string, unknown>} value - What to store
 */
export function writePointer(root, name, value) {
	const temporary = join(root, `.${name}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, join(root, name));
	} finally {
		rmSync(temporary, { force: true });
	}
}

/**
 * Remove a pointer file; absent is fine.
 * @param {string} root
 * @param {string} name
 */
export function removePointer(root, name) {
	rmSync(join(root, name), { force: true });
}

/**
 * A version's package directory inside the runtimes directory.
 * @param {string} root
 * @param {string} version
 */
export function packageRoot(root, version) {
	return join(root, version, ...PACKAGE_DIR);
}

/**
 * The entry point of an installed version, when its directory checks out: a real
 * directory (not a link) holding this package at that version, with the
 * installer's marker and a dist/index.js. Reads only; runs nothing.
 * @param {string} root
 * @param {unknown} version
 * @returns {string | null} Absolute path of dist/index.js, or null
 */
export function usableVersion(root, version) {
	if (!parts(version)) return null;
	try {
		const directory = lstatSync(join(root, version));
		if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
		const marker = JSON.parse(String(readSmallFile(join(root, version, ".pharaoh-runtime.json"))));
		const pkg = JSON.parse(
			String(readSmallFile(join(packageRoot(root, version), "package.json"), 65_536)),
		);
		const entry = join(packageRoot(root, version), "dist", "index.js");
		if (
			marker?.package !== PACKAGE_NAME ||
			marker.version !== version ||
			pkg?.name !== PACKAGE_NAME ||
			pkg.version !== version ||
			!lstatSync(entry).isFile()
		)
			return null;
		return entry;
	} catch {
		return null;
	}
}

/**
 * SHA-256 of a version's verification receipt (.pharaoh-verified.json), which the
 * updater writes inside the staged directory before publishing it.
 * @param {string} root
 * @param {string} version
 * @returns {string | null} Hex digest, or null without a receipt
 */
export function receiptDigest(root, version) {
	const bytes = parts(version)
		? readSmallFile(join(root, version, ".pharaoh-verified.json"))
		: null;
	return bytes ? createHash("sha256").update(bytes).digest("hex") : null;
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}

/** Take the lock once, reclaiming it from a dead or long-silent owner; false when held. */
function tryLock(path, token, now) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(path, { mode: 0o700 });
			writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, token }), {
				mode: 0o600,
				flag: "wx",
			});
			return true;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		let owner = null;
		try {
			owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
		} catch {
			// An owner still writing its record, or none: judged by the lock's age.
		}
		const dead = Number.isInteger(owner?.pid) && !processAlive(owner.pid);
		let old = false;
		try {
			old = now() - lstatSync(path).mtimeMs > LOCK_STALE_MS;
		} catch {
			continue;
		}
		if (!dead && !old) return false;
		try {
			const stale = `${path}.stale-${randomUUID()}`;
			renameSync(path, stale);
			rmSync(stale, { recursive: true, force: true });
		} catch {
			// Another process reclaimed it first.
		}
	}
	return false;
}

function unlock(path, token) {
	try {
		if (JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token === token)
			rmSync(path, { recursive: true, force: true });
	} catch {
		// Reclaimed after going stale; the new owner keeps it.
	}
}

/**
 * Run `work` holding .activate-lock: the one lock every change to current.json,
 * pending.json and the Claude Code plugin takes, so no two of them interleave.
 * @param {string} root - The runtimes directory
 * @param {() => unknown} work - Runs while the lock is held (sync, or a promise)
 * @param {{ waitMs?: number, now?: () => number }} [options] - How long to wait for a busy lock (default: not at all)
 * @returns {Promise<{ held: true, value: unknown } | { held: false }>}
 */
export async function withActivateLock(root, work, { waitMs = 0, now = Date.now } = {}) {
	const path = join(root, LOCK);
	const token = randomUUID();
	const deadline = now() + waitMs;
	while (!tryLock(path, token, now)) {
		if (now() >= deadline) return { held: false };
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	try {
		return { held: true, value: await work() };
	} finally {
		unlock(path, token);
	}
}

/**
 * {@link withActivateLock} for synchronous work that never waits: a busy lock means "not now".
 * @param {string} root
 * @param {() => unknown} work
 * @returns {{ held: true, value: unknown } | { held: false }}
 */
export function withActivateLockSync(root, work) {
	const path = join(root, LOCK);
	const token = randomUUID();
	if (!tryLock(path, token, Date.now)) return { held: false };
	try {
		return { held: true, value: work() };
	} finally {
		unlock(path, token);
	}
}

/**
 * Append one receipt line to update.log: what the updater and the launcher did
 * and why. Bounded (rotates to update.log.1); never throws.
 * @param {string} root
 * @param {Record<string, unknown>} entry
 */
export function logUpdate(root, entry) {
	try {
		const path = join(root, "update.log");
		try {
			if (lstatSync(path).size > LOG_LIMIT) renameSync(path, `${path}.1`);
		} catch {
			// No log yet.
		}
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
			mode: 0o600,
		});
	} catch {
		// Receipts are evidence, not a condition for running.
	}
}

/**
 * Apply a staged update: under .activate-lock (never waiting), a pending version
 * newer than current whose directory checks out and whose receipt is the one the
 * updater recorded becomes current; any other pending is discarded. current.json
 * is written before pending.json is removed, so a crash between them leaves a
 * stale pending the next start discards.
 * @param {string} root
 * @returns {Promise<string | null>} The version activated, or null
 */
export async function activatePending(root) {
	const outcome = await withActivateLock(root, () => {
		const pending = readPointer(root, "pending.json");
		if (!pending) return null;
		const current = readPointer(root, "current.json");
		const version = pending.version;
		let reason = null;
		if (!newerVersion(version, current?.version)) reason = "not-newer";
		else if (!usableVersion(root, version)) reason = "unusable";
		else if (
			typeof pending.receiptDigest !== "string" ||
			receiptDigest(root, version) !== pending.receiptDigest
		)
			reason = "receipt-mismatch";
		if (reason) {
			removePointer(root, "pending.json");
			logUpdate(root, { event: "discarded", version, reason });
			return null;
		}
		writePointer(root, "current.json", {
			version,
			previous: current?.version,
			appliedAt: new Date().toISOString(),
		});
		removePointer(root, "pending.json");
		logUpdate(root, { event: "activated", version, from: current?.version });
		return version;
	});
	return outcome.held ? outcome.value : null;
}

/**
 * The version to run: current when its directory checks out, else previous.
 * @param {string} root
 * @param {{ log?: boolean }} [options] - Record a fallback in update.log (proxy mode)
 * @returns {{ version: string, entry: string } | null}
 */
export function selectVersion(root, { log = true } = {}) {
	const current = readPointer(root, "current.json");
	const entry = usableVersion(root, current?.version);
	if (entry) return { version: current.version, entry };
	const previous = usableVersion(root, current?.previous);
	if (!previous) return null;
	if (log)
		logUpdate(root, { event: "fallback", version: current.previous, from: current?.version });
	return { version: current.previous, entry: previous };
}

async function main() {
	const launcher = realpathSync(fileURLToPath(import.meta.url));
	const root = dirname(launcher);
	const [mode, family, ...rest] = process.argv.slice(2);
	if (mode === "hook") {
		// A hook never activates or logs: it runs whatever version is current, or nothing.
		const selected = Object.hasOwn(HOOKS, family) ? selectVersion(root, { log: false }) : null;
		if (!selected) return;
		const target = join(packageRoot(root, selected.version), HOOKS[family]);
		process.argv = [process.argv[0], target, ...rest];
		// The hook names the launch it belongs to, as the proxy does (local-worktree-hook.mjs).
		globalThis[Symbol.for("pharaoh.launcher")] = {
			path: launcher,
			root,
			version: selected.version,
		};
		try {
			await import(pathToFileURL(target).href);
		} catch {
			// A version without this hook (or a broken one) never fails the client's session.
		}
		return;
	}
	try {
		await activatePending(root);
	} catch {
		// An update that can't be applied leaves current running.
	}
	const selected = selectVersion(root);
	if (!selected) {
		process.stderr.write(
			"Pharaoh: no usable runtime is installed. Run npx @pharaoh-so/mcp@latest install.\n",
		);
		process.exit(1);
	}
	// The running proxy reads which launcher started it from here (src/version.ts).
	globalThis[Symbol.for("pharaoh.launcher")] = { path: launcher, root, version: selected.version };
	await import(pathToFileURL(selected.entry).href);
}

/** Whether node is running this file itself (not a module that imported it for its helpers). */
function invokedDirectly() {
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (invokedDirectly()) await main();
