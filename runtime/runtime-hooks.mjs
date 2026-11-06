/** Independently managed native hooks; memory and unrelated hook definitions are preserved. */

import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RUNTIME_TOOL_NAMES, runtimeUuid } from "./runtime-native.mjs";
import { ensurePrivateDirectory, privatePath } from "./runtime-storage.mjs";

const MARKER = "--pharaoh-runtime-v1";
const OWNED = / --pharaoh-runtime-v1(?: '[0-9a-f-]{36}')?$/;
const COMMON = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"];
const TOOL_NAMES = `mcp__pharaoh__(?:${RUNTIME_TOOL_NAMES.join("|")})`;
const shellWord = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function atLeast(build, floor) {
	if (typeof build !== "string" || !/^\d+\.\d+\.\d+$/.test(build)) return false;
	const actual = build.split(".").map(Number);
	for (let i = 0; i < floor.length; i++) if (actual[i] !== floor[i]) return actual[i] > floor[i];
	return true;
}

/** Merge/remove only this observer's marked handlers, keeping every unrelated matcher and option. */
export function updateRuntimeHooks(
	config,
	client,
	hookPath,
	node = process.execPath,
	clientBuild,
	generation,
	selectionId,
	metadataVersion = 1,
) {
	if (
		config.hooks !== undefined &&
		(!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))
	)
		throw new Error("Invalid native hook configuration.");
	const hooks = { ...(config.hooks ?? {}) };
	const marker =
		!hookPath && runtimeUuid(generation)
			? new RegExp(` '${generation}'(?: '[0-9a-f-]{36}')? ${MARKER}$`)
			: OWNED;
	let changed = false;
	for (const [event, groups] of Object.entries(hooks)) {
		if (!Array.isArray(groups)) throw new Error("Invalid native hook configuration.");
		hooks[event] = groups.flatMap((group) => {
			if (!Array.isArray(group?.hooks)) throw new Error("Invalid native hook configuration.");
			const kept = group.hooks.filter((handler) => !marker.test(String(handler?.command ?? "")));
			if (kept.length === group.hooks.length) return [group];
			changed = true;
			return kept.length ? [{ ...group, hooks: kept }] : [];
		});
		if (groups.length && !hooks[event].length) delete hooks[event];
	}
	if (hookPath) {
		const claude = client === "claude-code";
		if (!runtimeUuid(generation)) throw new Error("Invalid runtime hook generation.");
		const command = `${[node, hookPath, client].map(shellWord).join(" ")} ${shellWord(generation)}${runtimeUuid(selectionId) ? ` ${shellWord(selectionId)}` : ""} ${MARKER}`;
		const events = [
			...COMMON,
			...(claude ? ["PreToolUse", "PostToolUseFailure", "StopFailure"] : ["Interrupt"]),
		];
		if (metadataVersion === 2 && claude && atLeast(clientBuild, [2, 1, 251]))
			events.push("PostModelSwitch");
		if (claude && atLeast(clientBuild, [2, 1, 69])) events.push("InstructionsLoaded");
		// 2.1.318 is a documented-current baseline, not a claim about introduction.
		if (claude && atLeast(clientBuild, [2, 1, 318])) events.push("UserPromptExpansion");
		if (!claude && atLeast(clientBuild, [0, 164, 0])) events.push("PostModelRequest");
		for (const event of events) {
			const matcher = {
				PreToolUse: "^Skill$",
				PostToolUse: `^(?:${claude ? "Skill|" : ""}${TOOL_NAMES})$`,
				PostToolUseFailure: `^${TOOL_NAMES}$`,
				UserPromptExpansion:
					"^pharaoh:(?:pharaoh|plan|review|refactor|debug|verify|brainstorm|tdd)$",
			}[event];
			hooks[event] = [
				...(hooks[event] ?? []),
				{ ...(matcher && { matcher }), hooks: [{ type: "command", command, timeout: 3 }] },
			];
		}
	}
	if (!hookPath && !changed) return config;
	return { ...config, hooks };
}

/** Resolve the active native settings file without creating or reading it. */
export function runtimeSettingsPath(client, options = {}) {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const directory =
		(client === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR) ??
		join(home, client === "codex" ? ".codex" : ".claude");
	if (!isAbsolute(directory)) throw new Error("Unsupported native hook configuration.");
	return resolve(directory, client === "codex" ? "hooks.json" : "settings.json");
}

function settingsIdentity(stat) {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function currentSettingsIdentity(path) {
	try {
		return settingsIdentity(lstatSync(path));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return null;
	}
}

function readHookSettings(client, path, removalMarker, local = false) {
	const root = dirname(path);
	const windows = local && process.platform === "win32";
	if (
		!isAbsolute(path) ||
		basename(path) !== (client === "codex" ? "hooks.json" : "settings.json") ||
		!["claude-code", "codex"].includes(client) ||
		(!windows && typeof process.getuid !== "function")
	)
		throw new Error("Unsupported native hook configuration.");
	try {
		const stat = windows ? privatePath(root, true) : lstatSync(root);
		if (!stat.isDirectory() || (!windows && stat.uid !== process.getuid()))
			throw new Error("Native settings directory is not owner-controlled.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return { config: {}, exists: false, identity: null };
	}
	let config = {};
	let identity = null;
	try {
		const stat = windows ? privatePath(path) : lstatSync(path);
		if (!stat.isFile() || (!windows && stat.uid !== process.getuid()) || stat.size > 262_144)
			throw new Error("Unsafe native hook settings.");
		identity = settingsIdentity(stat);
		const source = readFileSync(path, "utf8");
		// A removal needs to parse only settings that can contain a command we wrote.
		if (removalMarker && !source.includes(removalMarker)) return { config, exists: true, identity };
		config = JSON.parse(source);
		if (!config || typeof config !== "object" || Array.isArray(config))
			throw new Error("Invalid native hook settings.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return { config, exists: true, identity };
}

function acceptsAutomaticHooks(config, client) {
	return (
		!(client === "claude-code" && config.disableAllHooks === true) &&
		updateRuntimeHooks(config, client, null) === config
	);
}

/** Check that automatic enrollment can add hooks without replacing a previous observer. */
export function supportsAutomaticRuntimeHooks(client, options) {
	return acceptsAutomaticHooks(
		readHookSettings(client, runtimeSettingsPath(client, options)).config,
		client,
	);
}

/** Install/remove independently marked user hooks without following configuration symlinks. */
export function syncRuntimeHooks(client, hookPath, options = {}) {
	const path = options.settingsPath ?? runtimeSettingsPath(client, options);
	const { config, exists, identity } = readHookSettings(client, path);
	if (hookPath && client === "claude-code" && config.disableAllHooks === true)
		throw new Error("Claude Code hooks are disabled.");
	if (hookPath && options.automatic && !acceptsAutomaticHooks(config, client))
		throw new Error("Native hook settings changed during setup.");
	const next = updateRuntimeHooks(
		config,
		client,
		hookPath,
		options.node,
		options.clientBuild,
		options.generation,
		undefined,
		options.metadataVersion,
	);
	writeHookSettings(path, config, next, exists, identity);
}

function writeHookSettings(path, config, next, exists, identity, windows = false) {
	if (JSON.stringify(next) === JSON.stringify(config)) return;
	if (!exists) {
		if (windows) ensurePrivateDirectory(dirname(path));
		else mkdirSync(dirname(path), { mode: 0o700 });
	}
	const temporary = join(dirname(path), `${randomUUID()}.runtime.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
		if (windows) privatePath(temporary);
		if (currentSettingsIdentity(path) !== identity)
			throw new Error("Native hook settings changed during setup.");
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

const LOCAL_MARKER = "--pharaoh-local-worktree-v1";
const LOCAL_MCP_TOOLS =
	"^mcp__pharaoh__(?:get_blast_radius|pharaoh_local_worktree_status|pharaoh_memory_(?:recall|expand|capture|feedback))$";
const powerShellWord = (value) => `'${String(value).replaceAll("'", "''")}'`;

function ownsLocalHandler(handler) {
	return (
		String(handler?.command ?? "").endsWith(` ${LOCAL_MARKER}`) ||
		(Array.isArray(handler?.args) &&
			handler.args.length === 3 &&
			handler.args[2] === LOCAL_MARKER &&
			String(handler.args[0]).endsWith("local-worktree-hook.mjs"))
	);
}

function localHandler(client, hookPath, node) {
	const base = { type: "command", timeout: 3 };
	if (process.platform === "win32" && client === "claude-code")
		return { ...base, command: node, args: [hookPath, client, LOCAL_MARKER] };
	const command = `${[node, hookPath, client].map(shellWord).join(" ")} ${LOCAL_MARKER}`;
	if (process.platform === "win32")
		return {
			...base,
			command,
			commandWindows: `& ${[node, hookPath, client].map(powerShellWord).join(" ")} ${LOCAL_MARKER}`,
		};
	return { ...base, command };
}

/** Merge or remove only Pharaoh's local-readiness hooks; native trust remains with the client. */
export function syncLocalWorktreeHooks(client, hookPath, options = {}) {
	const path = options.settingsPath ?? runtimeSettingsPath(client, options);
	const { config, exists, identity } = readHookSettings(
		client,
		path,
		hookPath ? undefined : LOCAL_MARKER,
		true,
	);
	if (hookPath && client === "claude-code" && config.disableAllHooks === true)
		throw new Error("Claude Code hooks are disabled.");
	if (
		config.hooks !== undefined &&
		(!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))
	)
		throw new Error("Invalid native hook configuration.");

	const hooks = { ...(config.hooks ?? {}) };
	let changed = false;
	for (const [event, groups] of Object.entries(hooks)) {
		if (!Array.isArray(groups)) throw new Error("Invalid native hook configuration.");
		hooks[event] = groups.flatMap((group) => {
			if (!Array.isArray(group?.hooks)) throw new Error("Invalid native hook configuration.");
			const kept = group.hooks.filter((handler) => !ownsLocalHandler(handler));
			if (kept.length === group.hooks.length) return [group];
			changed = true;
			return kept.length ? [{ ...group, hooks: kept }] : [];
		});
		if (groups.length && !hooks[event].length) delete hooks[event];
	}
	if (hookPath) {
		const handler = localHandler(client, hookPath, options.node ?? process.execPath);
		const events =
			client === "claude-code"
				? [
						"SessionStart",
						"UserPromptSubmit",
						"PreToolUse",
						"Stop",
						"StopFailure",
						"SessionEnd",
						"CwdChanged",
					]
				: ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "Interrupt", "SessionEnd"];
		for (const event of events) {
			const matcher = event === "PreToolUse" ? LOCAL_MCP_TOOLS : undefined;
			hooks[event] = [
				...(hooks[event] ?? []),
				{
					...(matcher && { matcher }),
					hooks: [handler],
				},
			];
		}
		const editMatcher = client === "claude-code" ? "^(?:Edit|Write|MultiEdit)$" : "^apply_patch$";
		for (const event of ["PreToolUse", "PostToolUse"]) {
			hooks[event] = [...(hooks[event] ?? []), { matcher: editMatcher, hooks: [handler] }];
		}
		changed = true;
	}
	if (!changed) return;
	writeHookSettings(
		path,
		config,
		{ ...config, hooks },
		exists,
		identity,
		process.platform === "win32",
	);
}
