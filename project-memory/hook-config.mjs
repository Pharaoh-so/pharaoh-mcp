import { createHash } from "node:crypto";
import { shellWord } from "./local.mjs";

const EVENTS = {
	"claude-code": ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"],
	codex: ["UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"],
};
const GLOBAL_MARKER = "# pharaoh-project-memory:user-v1";
const LEGACY_MARKER = / # pharaoh-project-memory:[a-f0-9]{64}$/;
const TOOL_EVENTS = ["PreToolUse", "PostToolUse"];

function isObject(value) {
	return value && typeof value === "object" && !Array.isArray(value);
}

function legacyMarker(client, root) {
	return `# pharaoh-project-memory:${createHash("sha256").update(`${client}\0${root}`).digest("hex")}`;
}

function hookCommand(entry) {
	return entry?.type === "command" && typeof entry.command === "string" ? entry.command : "";
}

function matchesLegacyHook(client, root) {
	const suffix = ` ${legacyMarker(client, root)}`;
	return (value) => value.includes("pharaoh-memory-hook.mjs") && value.endsWith(suffix);
}

function matchesUserHook(value) {
	return (
		value.includes("pharaoh-memory-hook.mjs") &&
		(value.endsWith(` ${GLOBAL_MARKER}`) || LEGACY_MARKER.test(value))
	);
}

/** Keep unrelated handlers even when they share an event group with ours. */
function replaceHooks(config, events, matches, additions) {
	if (!isObject(config) || (config.hooks !== undefined && !isObject(config.hooks))) {
		throw new Error("The existing hooks configuration is not a JSON object.");
	}
	const hooks = { ...config.hooks };
	for (const event of events) {
		const current = hooks[event];
		const install = additions[event];
		if (!install && (current === undefined || (Array.isArray(current) && !current.length)))
			continue;
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
		if (install) kept.push(...(Array.isArray(install) ? install : [install]));
		if (kept.length) hooks[event] = kept;
		else delete hooks[event];
	}
	return config.hooks === undefined && Object.keys(hooks).length === 0
		? config
		: { ...config, hooks };
}

function group(command, matcher) {
	return { ...(matcher && { matcher }), hooks: [{ type: "command", command, timeout: 3 }] };
}

export function updateHooks(config, client, target, remove, hookPath, node = process.execPath) {
	const marker = legacyMarker(client, target.root);
	if (!remove && !hookPath) throw new Error("A pinned project memory hook is required.");
	const command = remove
		? null
		: `${[node, hookPath, client, target.root, target.repo].map(shellWord).join(" ")} ${marker}`;
	const events = EVENTS[client];
	const additions = command
		? Object.fromEntries(events.map((event) => [event, group(command)]))
		: {};
	return replaceHooks(config, events, matchesLegacyHook(client, target.root), additions);
}

export function updateUserHooks(
	config,
	client,
	hookPath,
	node = process.execPath,
	graphCues = false,
	diagnostics = false,
) {
	const additions = {};
	if (hookPath) {
		const command = (mode) =>
			`${[node, hookPath, client, mode].map(shellWord).join(" ")} ${GLOBAL_MARKER}`;
		additions.UserPromptSubmit = group(command("--user"));
		if (diagnostics) {
			const diagnostic = command("--diagnostics");
			for (const event of EVENTS[client])
				if (event !== "UserPromptSubmit") additions[event] = group(diagnostic);
			const edit = client === "codex" ? "apply_patch" : "Edit|Write|MultiEdit";
			additions.PostToolUse = group(
				diagnostic,
				`^(?:${edit}|Bash|exec_command|functions\\.exec_command|mcp__.*__pharaoh_memory_(?:recall|expand|capture|feedback))$`,
			);
		}
		if (graphCues) {
			const graph = command("--graph");
			const edit = client === "codex" ? "apply_patch" : "Edit|Write|MultiEdit";
			additions.PreToolUse = group(graph, "^Bash$");
			const graphGroup = group(graph, `^(?:${edit}|mcp__pharaoh__get_codebase_map)$`);
			if (additions.PostToolUse) additions.PostToolUse = [additions.PostToolUse, graphGroup];
			else additions.PostToolUse = graphGroup;
		}
	}
	const toolEvents = TOOL_EVENTS.filter(
		(event) => additions[event] || hasHooks(config, [event], matchesUserHook),
	);
	return replaceHooks(config, [...EVENTS[client], ...toolEvents], matchesUserHook, additions);
}

function hasHooks(config, events, matches) {
	return events.some((event) => {
		const groups = config?.hooks?.[event];
		return (
			Array.isArray(groups) &&
			groups.some(
				(group) =>
					Array.isArray(group?.hooks) && group.hooks.some((entry) => matches(hookCommand(entry))),
			)
		);
	});
}

export function hasLegacyHooks(config, client, root) {
	return hasHooks(config, EVENTS[client], matchesLegacyHook(client, root));
}

export function hasUserHooks(config, client) {
	return hasHooks(config, [...EVENTS[client], ...TOOL_EVENTS], matchesUserHook);
}
