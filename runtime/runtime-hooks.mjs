/** Independently managed native hooks; memory and unrelated hook definitions are preserved. */
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RUNTIME_TOOL_NAMES, runtimeUuid } from "./runtime-native.mjs";

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

function readHookSettings(client, path) {
	const root = dirname(path);
	if (
		!isAbsolute(path) ||
		basename(path) !== (client === "codex" ? "hooks.json" : "settings.json") ||
		!["claude-code", "codex"].includes(client) ||
		typeof process.getuid !== "function"
	)
		throw new Error("Unsupported native hook configuration.");
	try {
		const stat = lstatSync(root);
		if (!stat.isDirectory() || stat.uid !== process.getuid())
			throw new Error("Native settings directory is not owner-controlled.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return { config: {}, exists: false, identity: null };
	}
	let config = {};
	let identity = null;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 262_144)
			throw new Error("Unsafe native hook settings.");
		identity = settingsIdentity(stat);
		config = JSON.parse(readFileSync(path, "utf8"));
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
	const root = dirname(path);
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
	if (JSON.stringify(next) === JSON.stringify(config)) return;
	if (!exists) mkdirSync(root, { mode: 0o700 });
	const temporary = join(dirname(path), `${randomUUID()}.runtime.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
		if (currentSettingsIdentity(path) !== identity)
			throw new Error("Native hook settings changed during setup.");
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
