/** Independently managed native hooks; memory and unrelated hook definitions are preserved. */

import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ensureLocalPrivatePaths } from "../project-memory/install-scope.mjs";
import { RUNTIME_TOOL_NAMES, runtimeUuid } from "./runtime-native.mjs";
import { ensurePrivateDirectory, privatePath } from "./runtime-storage.mjs";
import { UPDATE_NOTICE_HOOK, UPDATE_NOTICE_MARKER } from "./update-notice.mjs";
import { runtimeProfilePath, runtimeScopeArguments, runtimeTargetId } from "./runtime-scope.mjs";
export { runtimeScopeMatches, runtimeScopeFromArguments } from "./runtime-scope.mjs";

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
	targetId,
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
		const selector =
			typeof targetId === "string" && /^[a-f0-9]{64}$/.test(targetId)
				? ` --target ${shellWord(targetId)}`
				: "";
		const command = `${[node, hookPath, client].map(shellWord).join(" ")}${selector} ${shellWord(generation)}${runtimeUuid(selectionId) ? ` ${shellWord(selectionId)}` : ""} ${MARKER}`;
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
	if (options.scope?.kind === "local") {
		if (!isAbsolute(options.scope.root)) throw new Error("Invalid local runtime root.");
		return resolve(
			options.scope.root,
			client === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json",
		);
	}
	return runtimeProfilePath(client, options);
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
		!(client === "codex" ? ["hooks.json"] : ["settings.json", "settings.local.json"]).includes(
			basename(path),
		) ||
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
	if (hookPath) ensureLocalPrivatePaths(options.scope, [path]);
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
		options.targetId ??
			(options.scope?.kind === "local" ? runtimeTargetId(client, options) : undefined),
	);
	writeHookSettings(path, config, next, exists, identity, false, options.scope);
}

function writeHookSettings(path, config, next, exists, identity, windows = false, scope) {
	if (JSON.stringify(next) === JSON.stringify(config)) return;
	const temporary = join(dirname(path), `${randomUUID()}.runtime.tmp`);
	ensureLocalPrivatePaths(scope, [path, temporary]);
	if (!exists) {
		if (windows) ensurePrivateDirectory(dirname(path));
		else mkdirSync(dirname(path), { mode: 0o700 });
	}
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

/** A handler this hook family wrote: its command ends with the marker, or (Windows) its args do. */
function ownsHandler(handler, marker, script) {
	const command = String(handler?.command ?? "");
	const markerAt = command.lastIndexOf(` ${marker}`);
	const suffix = markerAt < 0 ? null : command.slice(markerAt + marker.length + 1);
	const scoped =
		typeof suffix === "string" &&
		/^(?: '--server' '(?:[^']|'\\'')*')?(?: '--install-scope' 'local' '--install-root' '(?:[^']|'\\'')*')?$/.test(
			suffix,
		);
	return (
		command.endsWith(` ${marker}`) ||
		scoped ||
		(Array.isArray(handler?.args) &&
			(handler.args.length === 3 ||
				(handler.args.length === 5 &&
					handler.args[3] === "--server" &&
					typeof handler.args[4] === "string") ||
				([7, 9].includes(handler.args.length) &&
					(handler.args.length === 7 ||
						(handler.args[3] === "--server" && typeof handler.args[4] === "string")) &&
					handler.args.at(-4) === "--install-scope" &&
					handler.args.at(-3) === "local" &&
					handler.args.at(-2) === "--install-root" &&
					isAbsolute(handler.args.at(-1)))) &&
			handler.args[2] === marker &&
			String(handler.args[0]).endsWith(script))
	);
}

/**
 * One hook handler. `mode` runs the stable launcher's hook mode instead of a script directly
 * (`hookPath` is then the launcher), so the command never changes when Pharaoh updates.
 */
function markedHandler(client, hookPath, node, marker, mode = [], scope, server) {
	const base = { type: "command", timeout: 3 };
	const scopeArgs = [...(server ? ["--server", server] : []), ...runtimeScopeArguments(scope)];
	if (process.platform === "win32" && client === "claude-code")
		return { ...base, command: node, args: [hookPath, client, marker, ...scopeArgs] };
	const command = `${[node, hookPath, ...mode, client].map(shellWord).join(" ")} ${marker}${scopeArgs.length ? ` ${scopeArgs.map(shellWord).join(" ")}` : ""}`;
	if (process.platform === "win32")
		return {
			...base,
			command,
			commandWindows: `& ${[node, hookPath, client].map(powerShellWord).join(" ")} ${marker}${scopeArgs.length ? ` ${scopeArgs.map(powerShellWord).join(" ")}` : ""}`,
		};
	return { ...base, command };
}

/**
 * Read a client's user hook settings with this family's handlers taken out.
 * @returns The settings as read, their hooks without ours, and whether any were removed
 */
function settingsWithoutHandlers(client, path, adding, marker, script) {
	const { config, exists, identity } = readHookSettings(
		client,
		path,
		adding ? undefined : marker,
		true,
	);
	if (adding && client === "claude-code" && config.disableAllHooks === true)
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
			const kept = group.hooks.filter((handler) => !ownsHandler(handler, marker, script));
			if (kept.length === group.hooks.length) return [group];
			changed = true;
			return kept.length ? [{ ...group, hooks: kept }] : [];
		});
		if (groups.length && !hooks[event].length) delete hooks[event];
	}
	return { config, exists, identity, hooks, changed };
}

/** Merge or remove only Pharaoh's local-readiness hooks; native trust remains with the client. */
export function syncLocalWorktreeHooks(client, hookPath, options = {}) {
	const path = options.settingsPath ?? runtimeSettingsPath(client, options);
	if (hookPath) ensureLocalPrivatePaths(options.scope, [path]);
	const { config, exists, identity, hooks, ...removal } = settingsWithoutHandlers(
		client,
		path,
		Boolean(hookPath),
		LOCAL_MARKER,
		"local-worktree-hook.mjs",
	);
	let changed = removal.changed;
	if (hookPath) {
		const handler = markedHandler(
			client,
			hookPath,
			options.node ?? process.execPath,
			LOCAL_MARKER,
			options.viaLauncher === true ? ["hook", "local-worktree"] : [],
			options.scope,
			options.server,
		);
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
		options.scope,
	);
}

/**
 * Add or remove the session-start update notice (runtime/update-notice.mjs): one
 * SessionStart handler, beside every unrelated hook. Codex asks the person to
 * trust it once; the command stays the same across updates.
 * @param {"claude-code" | "codex"} client
 * @param {string | null} hookPath - The hook's stable copy, or null to remove it
 * @param {{ node?: string, settingsPath?: string, home?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function syncUpdateNoticeHook(client, hookPath, options = {}) {
	const path = options.settingsPath ?? runtimeSettingsPath(client, options);
	if (hookPath) ensureLocalPrivatePaths(options.scope, [path]);
	const { config, exists, identity, hooks, changed } = settingsWithoutHandlers(
		client,
		path,
		Boolean(hookPath),
		UPDATE_NOTICE_MARKER,
		UPDATE_NOTICE_HOOK,
	);
	if (hookPath) {
		const handler = markedHandler(
			client,
			hookPath,
			options.node ?? process.execPath,
			UPDATE_NOTICE_MARKER,
			[],
			options.scope,
		);
		// Already in place: keep its position, since Codex records trust by position.
		const owned = Object.values(config.hooks ?? {})
			.flat()
			.flatMap((group) => group.hooks)
			.filter((entry) => ownsHandler(entry, UPDATE_NOTICE_MARKER, UPDATE_NOTICE_HOOK));
		const current = JSON.stringify(handler);
		if (
			owned.length === 1 &&
			JSON.stringify(owned[0]) === current &&
			config.hooks.SessionStart?.some((group) => group.hooks.includes(owned[0]))
		)
			return;
		hooks.SessionStart = [...(hooks.SessionStart ?? []), { hooks: [handler] }];
	} else if (!changed) return;
	writeHookSettings(
		path,
		config,
		{ ...config, hooks },
		exists,
		identity,
		process.platform === "win32",
		options.scope,
	);
}
