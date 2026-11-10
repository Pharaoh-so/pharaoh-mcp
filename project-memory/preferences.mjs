import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateMemoryPath } from "./bundle.mjs";
import { hasUserHooks } from "./hook-config.mjs";
import { ANCHORED_MEMORY_FILE, atomicWrite, shellWord } from "./local.mjs";
import { memoryClientRoot, readActiveMemoryClients, readHookSettings } from "./user-target.mjs";

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
				["memory", "graph", "diagnostics"].some(
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
	// Sign-out, clean and disable all drop the locally kept memory records.
	const root = memoryClientRoot(home);
	for (const name of existsSync(root) ? readdirSync(root) : [])
		if (ANCHORED_MEMORY_FILE.test(name)) rmSync(join(root, name), { force: true });
	const choices = readHookPreferences(home);
	for (const client of MEMORY_HOOK_CLIENTS) {
		const choice = choices[client];
		if (disable) choices[client] = { ...choice, memory: false, graph: false, diagnostics: false };
		else if (choice) {
			if (choice.memory === true) delete choice.memory;
			if (choice.graph === true) delete choice.graph;
			if (Object.keys(choice).length === 0) delete choices[client];
		}
	}
	writeHookPreferences(choices, home);
	if (disable) {
		// Disable clears bounded content immediately, including loaded hook queues.
		for (const client of MEMORY_HOOK_CLIENTS) {
			try {
				const parent = join(memoryClientRoot(home), "diagnostics");
				const parentInfo = lstatSync(parent);
				if (
					parentInfo.isDirectory() &&
					parentInfo.uid === process.getuid?.() &&
					!(parentInfo.mode & 0o077)
				) {
					const path = join(parent, client);
					const info = lstatSync(path);
					if (info.isDirectory() && info.uid === process.getuid?.() && !(info.mode & 0o077))
						rmSync(path, { recursive: true, force: true });
				}
			} catch {
				/* An absent or linked queue is never followed. */
			}
			if (!choices[client]?.diagnosticsGeneration) continue;
			atomicWrite(
				join(memoryClientRoot(home), `diagnostics-revocation-${client}.json`),
				JSON.stringify({
					generation: choices[client].diagnosticsGeneration,
					policyVersion: choices[client].diagnosticsPolicyVersion,
				}),
			);
			const digest = readActiveMemoryClients(home)[client];
			const sender = digest
				? join(memoryClientRoot(home), digest, "diagnostics-sender.mjs")
				: fileURLToPath(new URL("diagnostics-sender.mjs", import.meta.url));
			const child = spawn(process.execPath, [sender, client, "--revoke"], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, HOME: home },
			});
			child.once("error", () => {});
			child.unref();
		}
	}
}

function nativeMemoryClient(info) {
	const name = typeof info?.name === "string" ? info.name.toLowerCase() : "";
	return ["codex", "codex-mcp-client", "codex_cli_rs", "codex-desktop"].includes(name)
		? "codex"
		: ["claude-code", "claude-cli"].includes(name)
			? "claude-code"
			: undefined;
}

/** Configuration evidence only: native review, trust and execution remain unobserved. */
export function memoryHookStateForClient(
	info,
	{ home = homedir(), env = process.env, platform = process.platform } = {},
) {
	if (typeof info?.name !== "string" || !info.name) return "unknown";
	const client = nativeMemoryClient(info);
	if (!client || platform === "win32" || typeof process.getuid !== "function") return "unsupported";
	try {
		if (readHookPreferences(home)[client]?.memory === false) return "declined";
		const codex = client === "codex";
		const directory =
			(codex ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR) ?? join(home, codex ? ".codex" : ".claude");
		if (!isAbsolute(directory)) return "unknown";
		let settings = join(directory, codex ? "hooks.json" : "settings.json");
		try {
			settings = realpathSync(settings);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const config = readHookSettings(settings);
		if (!config || typeof config !== "object" || Array.isArray(config)) return "unknown";
		if (client === "claude-code" && config.disableAllHooks === true) return "absent";
		if (
			config.hooks !== undefined &&
			(!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))
		)
			return "unknown";
		const groups = config.hooks?.UserPromptSubmit;
		if (
			groups !== undefined &&
			(!Array.isArray(groups) || groups.some((group) => !Array.isArray(group?.hooks)))
		)
			return "unknown";
		const reminder = { hooks: { UserPromptSubmit: groups } };
		if (!hasUserHooks(reminder, client)) return "absent";
		const digest = readActiveMemoryClients(home)[client];
		if (!digest) return "unknown";
		const runtime = join(realpathSync(memoryClientRoot(home)), digest);
		privateMemoryPath(runtime, true);
		const hook = join(runtime, "pharaoh-memory-hook.mjs");
		privateMemoryPath(hook, false);
		const invocation = [hook, client, "--user"].map(shellWord).join(" ");
		return groups.some(
			(group) =>
				group?.enabled !== false &&
				Array.isArray(group?.hooks) &&
				group.hooks.some(
					(entry) =>
						entry?.enabled !== false &&
						entry?.type === "command" &&
						typeof entry.command === "string" &&
						entry.command.includes(invocation) &&
						hasUserHooks({ hooks: { UserPromptSubmit: [{ hooks: [entry] }] } }, client),
				),
		)
			? "installed"
			: "unknown";
	} catch {
		return "unknown";
	}
}

/** Consent metadata for the actual native initialize identity; unknown clients stay unknown. */
export function memoryDiagnosticsForClient(info, home = homedir()) {
	const clientName = nativeMemoryClient(info);
	if (!clientName) return;
	try {
		const choice = readHookPreferences(home)[clientName];
		if (
			choice?.memory === false ||
			choice?.diagnostics !== true ||
			!choice.diagnosticsGeneration ||
			!choice.diagnosticsPolicyVersion ||
			!readActiveMemoryClients(home)[clientName]
		)
			return;
		const version =
			typeof info?.version === "string" && /^[A-Za-z0-9._:/+ -]{1,120}$/.test(info.version)
				? info.version
				: null;
		return {
			clientName,
			generation: choice.diagnosticsGeneration,
			versions: {
				clientVersion: version,
				collectionPolicyVersion: choice.diagnosticsPolicyVersion,
				collectorVersion: "native-v1",
				capabilitySchemaVersion: "native-hooks-v1",
			},
		};
	} catch {
		return;
	}
}
