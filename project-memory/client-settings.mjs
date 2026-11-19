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
	readdirSync,
	readFileSync,
	readSync,
} from "node:fs";
import { createHash } from "node:crypto";
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

/** Independent activation receipt for each selected checkout. */
export function memoryActivePath(root, scope) {
	const key =
		scope?.kind === "local" ? createHash("sha256").update(scope.root).digest("hex") : null;
	return join(root, key ? `active-local-${key}.json` : "active.json");
}

export function readActiveMemoryClients(home = homedir(), scope) {
	return readActivePath(memoryClientRoot(home), memoryActivePath(memoryClientRoot(home), scope));
}

/** Whether another installation shares this client's diagnostic consent and queue. */
export function hasOtherActiveMemoryClient(client, home = homedir(), scope) {
	const root = memoryClientRoot(home);
	const current = memoryActivePath(root, scope);
	try {
		return readdirSync(root).some((name) => {
			if (!/^(?:active|active-local-[a-f0-9]{64})\.json$/.test(name)) return false;
			const path = join(root, name);
			return path !== current && Boolean(readActivePath(root, path)[client]);
		});
	} catch {
		return false;
	}
}

function readActivePath(root, path) {
	try {
		const directory = lstatSync(root);
		if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077)
			return {};
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

/** Validate preferences without loading the memory runtime or following a symlink. */
function privatePreferencesPath(path, directory) {
	const stat = lstatSync(path);
	if (
		(directory ? !stat.isDirectory() : !stat.isFile()) ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o077) !== 0
	)
		throw new Error("Project memory needs a regular owner-private preferences path.");
	return stat;
}

/** Read the bounded per-client choices shared by the memory runtime and Claude plugin. */
export function readHookPreferences(home = homedir()) {
	const root = memoryClientRoot(home);
	const path = join(root, "hook-preferences-v1.json");
	try {
		privatePreferencesPath(root, true);
		if (privatePreferencesPath(path, false).size > 1024)
			throw new Error("Project memory preferences are too large.");
		const { version, clients } = JSON.parse(readFileSync(path, "utf8"));
		if (version !== 1 || !clients || typeof clients !== "object" || Array.isArray(clients))
			throw new Error("Project memory preferences have an unknown format.");
		for (const client of MEMORY_HOOK_CLIENTS) {
			if (!Object.hasOwn(clients, client)) continue;
			const choice = clients[client];
			if (
				!choice ||
				typeof choice !== "object" ||
				Array.isArray(choice) ||
				["memory", "graph", "diagnostics", "capture"].some(
					(key) => Object.hasOwn(choice, key) && typeof choice[key] !== "boolean",
				) ||
				(choice.diagnosticsPolicyVersion !== undefined &&
					(typeof choice.diagnosticsPolicyVersion !== "string" ||
						choice.diagnosticsPolicyVersion.length > 128)) ||
				(choice.diagnosticsGeneration !== undefined &&
					(typeof choice.diagnosticsGeneration !== "string" ||
						!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(choice.diagnosticsGeneration)))
			)
				throw new Error("Project memory preferences contain an invalid choice.");
		}
		return clients;
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw error;
	}
}
