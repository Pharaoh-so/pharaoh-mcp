import { createHash } from "node:crypto";
import { shellWord } from "./local.mjs";

const EVENTS = {
	"claude-code": ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"],
	codex: ["UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"],
};
const GLOBAL_MARKER = "# pharaoh-project-memory:user-v1";
const LEGACY_MARKER = / # pharaoh-project-memory:[a-f0-9]{64}$/;

function isObject(value) {
	return value && typeof value === "object" && !Array.isArray(value);
}

function legacyMarker(client, root) {
	return `# pharaoh-project-memory:${createHash("sha256").update(`${client}\0${root}`).digest("hex")}`;
}

function hookCommand(entry) {
	return entry?.type === "command" && typeof entry.command === "string" ? entry.command : "";
}

/** Keep unrelated handlers even when they share an event group with ours. */
function replaceHooks(config, client, matches, command) {
	if (!isObject(config) || (config.hooks !== undefined && !isObject(config.hooks))) {
		throw new Error("The existing hooks configuration is not a JSON object.");
	}
	const hooks = { ...config.hooks };
	for (const event of EVENTS[client]) {
		const current = hooks[event];
		if (current === undefined && !command) continue;
		if (
			current !== undefined &&
			(!Array.isArray(current) || current.some((group) => !Array.isArray(group?.hooks)))
		) {
			throw new Error(`The existing ${event} configuration is invalid.`);
		}
		const kept = (current ?? []).flatMap((group) => {
			const rest = group.hooks.filter((entry) => !matches(hookCommand(entry)));
			if (rest.length === group.hooks.length) return [group];
			return rest.length ? [{ ...group, hooks: rest }] : [];
		});
		if (command) kept.push({ hooks: [{ type: "command", command, timeout: 3 }] });
		if (kept.length) hooks[event] = kept;
		else delete hooks[event];
	}
	return config.hooks === undefined && Object.keys(hooks).length === 0
		? config
		: { ...config, hooks };
}

export function updateHooks(config, client, target, remove, hookPath, node = process.execPath) {
	const marker = legacyMarker(client, target.root);
	if (!remove && !hookPath) throw new Error("A pinned project memory hook is required.");
	const command = remove
		? null
		: `${[node, hookPath, client, target.root, target.repo].map(shellWord).join(" ")} ${marker}`;
	return replaceHooks(config, client, (value) => value.endsWith(` ${marker}`), command);
}

export function updateUserHooks(config, client, hookPath, node = process.execPath) {
	const command = hookPath
		? `${[node, hookPath, client, "--user"].map(shellWord).join(" ")} ${GLOBAL_MARKER}`
		: null;
	return replaceHooks(
		config,
		client,
		(value) =>
			value.endsWith(` ${GLOBAL_MARKER}`) ||
			(value.includes("pharaoh-memory-hook.mjs") && LEGACY_MARKER.test(value)),
		command,
	);
}

export function hasLegacyHooks(config, client, root) {
	const suffix = ` ${legacyMarker(client, root)}`;
	return EVENTS[client].some((event) => {
		const groups = config?.hooks?.[event];
		return (
			Array.isArray(groups) &&
			groups.some(
				(group) =>
					Array.isArray(group?.hooks) &&
					group.hooks.some((entry) => {
						const command = hookCommand(entry);
						return command.includes("pharaoh-memory-hook.mjs") && command.endsWith(suffix);
					}),
			)
		);
	});
}
