import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateMemoryPath } from "./bundle.mjs";
import { atomicWrite } from "./local.mjs";
import { memoryClientRoot } from "./user-target.mjs";

export const MEMORY_HOOK_CLIENTS = ["claude-code", "codex"];
const FILE = "hook-preferences-v1.json";

export function readHookPreferences(home = homedir()) {
	const root = memoryClientRoot(home);
	const path = join(root, FILE);
	try {
		privateMemoryPath(root, true);
		if (privateMemoryPath(path, false).size > 1024)
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
				["memory", "graph"].some(
					(key) => Object.hasOwn(choice, key) && typeof choice[key] !== "boolean",
				)
			)
				throw new Error("Project memory preferences contain an invalid choice.");
		}
		return clients;
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw error;
	}
}

export function writeHookPreferences(clients, home = homedir(), expected) {
	const previous = readHookPreferences(home);
	if (expected && JSON.stringify(expected) !== JSON.stringify(previous))
		throw new Error("Project memory preferences changed while setup was asking.");
	if (JSON.stringify(clients) === JSON.stringify(previous)) return;
	const root = memoryClientRoot(home);
	const path = join(root, FILE);
	if (Object.keys(clients).length === 0) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(root, { recursive: true, mode: 0o700 });
	privateMemoryPath(root, true);
	atomicWrite(path, `${JSON.stringify({ version: 1, clients })}\n`);
}

export function resetHookPreferences(disable, home = homedir()) {
	if (typeof process.getuid !== "function") return;
	const choices = readHookPreferences(home);
	for (const client of MEMORY_HOOK_CLIENTS) {
		const choice = choices[client];
		if (disable) choices[client] = { memory: false, graph: false };
		else if (choice) {
			if (choice.memory === true) delete choice.memory;
			if (choice.graph === true) delete choice.graph;
			if (Object.keys(choice).length === 0) delete choices[client];
		}
	}
	writeHookPreferences(choices, home);
}
