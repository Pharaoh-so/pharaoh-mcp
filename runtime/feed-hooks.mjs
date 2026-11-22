/** Managed native context hooks and stable, per-adapter registration identities. */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ensureLocalPrivatePaths } from "../project-memory/install-scope.mjs";
import { runtimeSettingsPath } from "./runtime-hooks.mjs";
import {
	ensurePrivateDirectory,
	readRuntimeJSON,
	runtimeLock,
	writeRuntimeJSON,
} from "./runtime-storage.mjs";

export const NATIVE_FEED_MARKER = "--pharaoh-native-feed-v1";
const CLIENTS = ["claude-code", "codex"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const word = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function settingsRoot(options = {}) {
	const home = resolve(options.home ?? homedir());
	return join(home, ".pharaoh", "private", "feed");
}

function ensureSettingsRoot(options = {}) {
	const root = settingsRoot(options);
	for (const directory of [dirname(dirname(root)), dirname(root), root])
		ensurePrivateDirectory(directory);
	return root;
}

/** Read the saved feed choice; a missing choice enables setup and malformed state disables it. */
export function nativeFeedEnabled(client, options = {}) {
	if (!CLIENTS.includes(client)) return false;
	const path = join(settingsRoot(options), `choice-${client}.json`);
	const value = readRuntimeJSON(path, 1024);
	if (value?.version === 1 && typeof value.enabled === "boolean") return value.enabled;
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		return error.code === "ENOENT";
	}
}

/** Persist an explicit feed choice independently of memory and runtime analytics. */
export function setNativeFeedEnabled(client, enabled, options = {}) {
	if (!CLIENTS.includes(client) || typeof enabled !== "boolean" || process.platform === "win32")
		throw new Error("Native context preferences are unavailable for this client.");
	const root = ensureSettingsRoot(options);
	writeRuntimeJSON(root, `choice-${client}.json`, { version: 1, enabled }, 1024);
}

/** Persist the preview choice without changing native hook trust or the base feed choice. */
export function setNativeFeedPreviewEnabled(client, enabled, options = {}) {
	if (!CLIENTS.includes(client) || typeof enabled !== "boolean" || process.platform === "win32")
		throw new Error("Native context preview is unavailable for this client.");
	writeRuntimeJSON(
		ensureSettingsRoot(options),
		`preview-${client}.json`,
		{ version: 1, enabled },
		256,
	);
}

/** Resolve the native settings file shared by this adapter's managed feed hooks. */
export function nativeFeedSettingsPath(client, options = {}) {
	return runtimeSettingsPath(client, options);
}

/** Obtain the install's stable adapter registration; an unsafe or busy store is refused. */
export function nativeFeedRegistration(client, options = {}) {
	if (!CLIENTS.includes(client) || process.platform === "win32")
		throw new Error("Native context hooks are unavailable for this client.");
	const root = ensureSettingsRoot(options);
	const name = `registration-${client}.json`;
	const result = runtimeLock(
		root,
		() => {
			const current = readRuntimeJSON(join(root, name), 1024);
			if (current?.version === 1 && current.client === client && UUID.test(current.registration))
				return current.registration;
			try {
				lstatSync(join(root, name));
				throw new Error("Native context registration is invalid.");
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			const registration = randomUUID();
			writeRuntimeJSON(root, name, { version: 1, client, registration }, 1024);
			return registration;
		},
		Date.now(),
		30_000,
		"registration.lock",
	);
	if (!result) throw new Error("Native context registration is busy. Retry installation.");
	return result;
}

function ownsFeedHandler(entry) {
	return typeof entry?.command === "string" && entry.command.endsWith(` ${NATIVE_FEED_MARKER}`);
}

function desiredFeedHooks(client, hookPath, options) {
	if (!isAbsolute(hookPath) || !UUID.test(options.registration))
		throw new Error("Invalid native context registration.");
	const serverArgv = options.serverArgv ?? [];
	if (
		!(
			serverArgv.length === 0 ||
			(serverArgv.length === 2 && serverArgv[0] === "--server" && typeof serverArgv[1] === "string")
		)
	)
		throw new Error("Invalid native context server arguments.");
	const command =
		[
			options.node ?? process.execPath,
			hookPath,
			...(options.viaLauncher ? ["hook", "native-feed"] : []),
			"--client",
			client,
			"--feed-registration",
			options.registration,
			...serverArgv,
		]
			.map(word)
			.join(" ") + ` ${NATIVE_FEED_MARKER}`;
	return Object.fromEntries(
		["SessionStart", "UserPromptSubmit", "SubagentStart", "PostToolUse"].map((event) => [
			event,
			{
				...(event === "PostToolUse"
					? {
							matcher:
								"^(?:Bash|Read|Edit|Write|MultiEdit|apply_patch|exec_command|mcp__pharaoh__.*)$",
						}
					: {}),
				hooks: [{ type: "command", command, timeout: 1 }],
			},
		]),
	);
}

// Native clients key trust to hook position. A user adding a later handler must not move ours.
function matchingFeedHooks(hooks, desired) {
	const seen = new Set();
	for (const [event, groups] of Object.entries(hooks ?? {})) {
		if (!Array.isArray(groups)) return false;
		for (const group of groups) {
			if (!Array.isArray(group?.hooks)) return false;
			for (const handler of group.hooks) {
				if (!ownsFeedHandler(handler)) continue;
				if (
					!desired[event] ||
					seen.has(event) ||
					group.matcher !== desired[event].matcher ||
					JSON.stringify(handler) !== JSON.stringify(desired[event].hooks[0])
				)
					return false;
				seen.add(event);
			}
		}
	}
	return seen.size === Object.keys(desired).length;
}

/** Read-only proof that the managed registration still has all enabled feed handlers. */
export function nativeFeedHooksReady(client, hookPath, options = {}) {
	try {
		if (process.platform === "win32" || !nativeFeedEnabled(client, options)) return false;
		const registration = readRuntimeJSON(
			join(settingsRoot(options), `registration-${client}.json`),
			1024,
		);
		if (
			registration?.version !== 1 ||
			registration.client !== client ||
			registration.registration !== options.registration
		)
			return false;
		const path = options.settingsPath ?? runtimeSettingsPath(client, options);
		const directory = lstatSync(dirname(path));
		const stat = lstatSync(path);
		if (
			!directory.isDirectory() ||
			directory.uid !== process.getuid() ||
			!stat.isFile() ||
			stat.uid !== process.getuid() ||
			stat.size > 262_144
		)
			return false;
		const config = JSON.parse(readFileSync(path, "utf8"));
		const desired = desiredFeedHooks(client, hookPath, options);
		if (!config || config.disableAllHooks === true || !matchingFeedHooks(config.hooks, desired))
			return false;
		return Object.entries(desired).every(([name]) =>
			config.hooks[name].some(
				(group) =>
					group.enabled !== false &&
					group.disabled !== true &&
					group.hooks.some((handler) => ownsFeedHandler(handler)),
			),
		);
	} catch {
		return false;
	}
}

/** Install/remove only Pharaoh's feed handlers; native trust and unrelated hooks are preserved. */
export function syncNativeFeedHooks(client, hookPath, options = {}) {
	if (process.platform === "win32" && !hookPath) return;
	if (!CLIENTS.includes(client) || process.platform === "win32")
		throw new Error("Native context hooks are unavailable for this client.");
	if (hookPath && !nativeFeedEnabled(client, options)) hookPath = null;
	const path = options.settingsPath ?? runtimeSettingsPath(client, options);
	if (!isAbsolute(path)) throw new Error("Native context settings path is invalid.");
	const parent = dirname(path);
	let config = {};
	let before = null;
	try {
		const directory = lstatSync(parent);
		if (!directory.isDirectory() || directory.uid !== process.getuid())
			throw new Error("Unsafe native settings directory.");
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 262_144)
			throw new Error("Unsafe native settings.");
		before = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		const source = readFileSync(path, "utf8");
		// Removal never needs to parse an unrelated settings file, including malformed JSON.
		if (!hookPath && !source.includes(NATIVE_FEED_MARKER)) return;
		config = JSON.parse(source);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (
		!config ||
		typeof config !== "object" ||
		Array.isArray(config) ||
		(config.hooks !== undefined &&
			(!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)))
	)
		throw new Error("Invalid native hook settings.");
	if (hookPath && config.disableAllHooks === true) throw new Error("Native hooks are disabled.");
	const desired = hookPath ? desiredFeedHooks(client, hookPath, options) : null;
	if (desired && matchingFeedHooks(config.hooks, desired)) return;
	const hooks = {};
	let removed = false;
	for (const [event, groups] of Object.entries(config.hooks ?? {})) {
		if (!Array.isArray(groups)) {
			if (hookPath) throw new Error("Invalid native hook settings.");
			hooks[event] = groups;
			continue;
		}
		hooks[event] = groups.flatMap((group) => {
			if (!Array.isArray(group?.hooks)) {
				if (hookPath) throw new Error("Invalid native hook settings.");
				return [group];
			}
			const kept = group.hooks.filter((entry) => !ownsFeedHandler(entry));
			if (kept.length === group.hooks.length) return [group];
			removed = true;
			return kept.length ? [{ ...group, hooks: kept }] : [];
		});
		if (!hooks[event].length && groups.length) delete hooks[event];
	}
	if (desired) {
		for (const [event, group] of Object.entries(desired))
			hooks[event] = [...(hooks[event] ?? []), group];
	} else if (!removed) return;
	const next = { ...config, hooks };
	if (JSON.stringify(next) === JSON.stringify(config)) return;
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const stat = lstatSync(parent);
	if (!stat.isDirectory() || stat.uid !== process.getuid())
		throw new Error("Unsafe native settings directory.");
	const temporary = join(parent, `.pharaoh-feed-${randomUUID()}.tmp`);
	ensureLocalPrivatePaths(options.scope, [path, temporary]);
	try {
		writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
		let current = null;
		try {
			const stat = lstatSync(path);
			current = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (current !== before) throw new Error("Native hook settings changed during installation.");
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
