/**
 * Where project memory keeps its per-client state, and how hook settings are
 * read. A leaf: it imports only Node built-ins, so preferences.mjs and
 * user-target.mjs can share it without importing each other.
 */
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MEMORY_HOOK_CLIENTS = ["claude-code", "codex"];

export function readHookSettings(path, storage) {
	let fd;
	try {
		if (storage) storage.privatePath(dirname(path), true);
		const info = storage ? storage.privatePath(path, false) : lstatSync(path);
		if (!info.isFile() || (!storage && info.uid !== process.getuid?.()) || info.size > 512 * 1024)
			throw new Error("Expected a regular owner-controlled hook settings file.");
		if (!storage) return JSON.parse(readFileSync(path, "utf8"));
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(fd);
		if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
			throw new Error("Hook settings changed during inspection.");
		const bytes = Buffer.alloc(opened.size + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		if (length !== opened.size) throw new Error("Hook settings changed during inspection.");
		return JSON.parse(bytes.toString("utf8", 0, length));
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function memoryClientRoot(home = homedir()) {
	return join(home, ".pharaoh", "project-memory-client");
}

export function readActiveMemoryClients(home = homedir()) {
	try {
		const root = memoryClientRoot(home);
		const directory = lstatSync(root);
		if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077)
			return {};
		const path = join(root, "active.json");
		const file = lstatSync(path);
		if (!file.isFile() || file.uid !== process.getuid?.() || file.mode & 0o077 || file.size > 512)
			return {};
		const active = JSON.parse(readFileSync(path, "utf8"));
		return Object.fromEntries(
			MEMORY_HOOK_CLIENTS.flatMap((client) => {
				const digest = active?.[client];
				return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)
					? [[client, digest]]
					: [];
			}),
		);
	} catch {
		return {};
	}
}
