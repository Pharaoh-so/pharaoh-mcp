/** Bounded owner-private filesystem operations for native context. No subprocess or network dependency. */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { feedRootForCredentials } from "./feed-signin.mjs";

/** Hash an opaque local identifier before using it as a filename. */
export function feedHash(value) {
	return createHash("sha256").update(value).digest("hex");
}
/** Locate feed state for the active credentials path, including scratch installations. */
export function feedRoot(options = {}) {
	return feedRootForCredentials(
		options.credentialsPath ?? join(options.home ?? homedir(), ".pharaoh", "credentials.json"),
	);
}
/** Refuse symlinks, foreign ownership, permissive modes and unsupported Windows ACLs. */
export function privateFeedPath(path, directory = false) {
	const stat = lstatSync(path);
	if (
		process.platform === "win32" ||
		typeof process.getuid !== "function" ||
		stat.uid !== process.getuid() ||
		(stat.mode & 0o077) !== 0 ||
		(directory ? !stat.isDirectory() : !stat.isFile())
	)
		throw new Error("Native context state is unavailable.");
	return stat;
}
/** Create one private directory without following a pre-existing link. */
export function ensureFeedDirectory(path) {
	try {
		privateFeedPath(path, true);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (race) {
			if (race.code !== "EEXIST") throw race;
		}
		privateFeedPath(path, true);
	}
	return path;
}
/** Create only the private feed hierarchy below an already-private credential directory. */
export function ensureFeedRoot(options = {}) {
	const root = feedRoot(options);
	privateFeedPath(dirname(dirname(root)), true);
	ensureFeedDirectory(dirname(root));
	return ensureFeedDirectory(root);
}
/** Read one regular private JSON file once, never a pipe or an oversized payload. */
export function readFeedJSON(path, limit = 16_384) {
	let fd;
	try {
		privateFeedPath(dirname(path), true);
		const stat = privateFeedPath(path);
		if (stat.size > limit) return null;
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(fd);
		if (
			!opened.isFile() ||
			opened.ino !== stat.ino ||
			opened.dev !== stat.dev ||
			opened.size > limit
		)
			return null;
		const bytes = Buffer.alloc(limit + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		if (length > limit) return null;
		return JSON.parse(bytes.subarray(0, length).toString("utf8"));
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
/** Atomically publish bounded data inside an existing private directory. */
export function writeFeedJSON(directory, name, value, limit = 16_384) {
	privateFeedPath(directory, true);
	if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw new Error("Invalid native context filename.");
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > limit) throw new Error("Native context record is oversized.");
	const target = join(directory, name);
	try {
		privateFeedPath(target);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const temporary = join(directory, `${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}
/** Remove one private regular file; an absent file is already removed. */
export function removeFeedFile(path) {
	try {
		privateFeedPath(path);
		rmSync(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
/** Try one filesystem lock; contention drops optional work instead of waiting. */
export function feedLock(directory, operation, name = "feed.lock", now = Date.now()) {
	privateFeedPath(directory, true);
	if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw new Error("Invalid native context lock.");
	const path = join(directory, name);
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		try {
			if (now - privateFeedPath(path, true).mtimeMs > 10_000) rmSync(path, { recursive: true });
		} catch {
			/* Unsafe locks remain unavailable. */
		}
		return null;
	}
	const owned = privateFeedPath(path, true);
	try {
		const result = operation();
		if (result && typeof result.then === "function")
			throw new Error("Native context locks require synchronous operations.");
		return result;
	} finally {
		try {
			const current = privateFeedPath(path, true);
			if (current.ino === owned.ino && current.dev === owned.dev) rmSync(path, { recursive: true });
		} catch {
			/* Revocation may remove a stale lock. */
		}
	}
}
