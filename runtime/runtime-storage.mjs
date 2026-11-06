/** Owner-private, bounded storage shared by the opt-in runtime observer. */
import { randomUUID } from "node:crypto";
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
import { join } from "node:path";

/** Resolve the observer's private directory without creating it. */
export function runtimeRoot(home = homedir()) {
	return join(home, ".pharaoh", "runtime-observations");
}

/** Require a regular owner-controlled file/directory, without following links. */
export function privatePath(path, directory = false) {
	const stat = lstatSync(path);
	if (
		typeof process.getuid !== "function" ||
		stat.uid !== process.getuid() ||
		(stat.mode & 0o077) !== 0 ||
		(directory ? !stat.isDirectory() : !stat.isFile())
	) {
		throw new Error("Runtime observations require an owner-private regular path.");
	}
	return stat;
}

/** Create the fixed private hierarchy; existing links and permissive directories are refused. */
export function ensureRuntimeRoot(home = homedir()) {
	const parent = join(home, ".pharaoh");
	for (const path of [parent, runtimeRoot(home)]) {
		try {
			privatePath(path, true);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			mkdirSync(path, { mode: 0o700 });
			privatePath(path, true);
		}
	}
	return runtimeRoot(home);
}

/** Read a bounded private JSON file; absent/unsafe/invalid input is unavailable. */
export function readRuntimeJSON(path, limit = 16_384) {
	let fd;
	try {
		const stat = privatePath(path);
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
		const buffer = Buffer.alloc(limit + 1);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		if (length > limit) return null;
		return JSON.parse(buffer.subarray(0, length).toString("utf8"));
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Atomically replace bounded JSON inside an already-private directory. */
export function writeRuntimeJSON(directory, name, value, limit = 65_536) {
	privatePath(directory, true);
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > limit || !/^[a-zA-Z0-9.-]+$/.test(name))
		throw new Error("Invalid runtime record.");
	const target = join(directory, name);
	try {
		privatePath(target);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const temporary = join(directory, `${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Serialize local state changes; a busy observer drops this observation instead of blocking work. */
export function runtimeLock(
	directory,
	operation,
	now = Date.now(),
	staleAfter = 60_000,
	name = "observer.lock",
) {
	privatePath(directory, true);
	const path = join(directory, name);
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		try {
			if (now - privatePath(path, true).mtimeMs > staleAfter) rmSync(path, { recursive: true });
		} catch {
			/* An unsafe lock remains unavailable. */
		}
		return null;
	}
	const owned = privatePath(path, true);
	const release = () => {
		try {
			const current = privatePath(path, true);
			if (current.ino === owned.ino && current.dev === owned.dev)
				rmSync(path, { recursive: true, force: true });
		} catch {
			/* A revoked installation may already have removed this lease. */
		}
	};
	try {
		const result = operation();
		if (result && typeof result.then === "function")
			return Promise.resolve(result).finally(release);
		release();
		return result;
	} catch (error) {
		release();
		throw error;
	}
}
