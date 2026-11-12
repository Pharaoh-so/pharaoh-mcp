import { createHash } from "node:crypto";
import { shellWord } from "./local.mjs";

const EVENTS = {
	"claude-code": ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"],
	codex: ["UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"],
};
const GLOBAL_MARKER = "# pharaoh-project-memory:user-v1";
const LEGACY_MARKER = / # pharaoh-project-memory:[a-f0-9]{64}$/;
const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];

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
	capture = true,
) {
	const additions = {};
	const add = (event, entry) => {
		additions[event] = additions[event] ? [additions[event], entry].flat() : entry;
	};
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
		// The memory cue (records that cite an edited file) is part of project memory, so
		// its edit hook comes with the reminder. The structural cues (a Pharaoh query for a
		// code grep, a note after the map) stay a separate choice: graphCues.
		const graph = command("--graph");
		const edit = client === "codex" ? "apply_patch" : "Edit|Write|MultiEdit";
		if (graphCues) additions.PreToolUse = group(graph, "^Bash$");
		const graphGroup = group(
			graph,
			graphCues ? `^(?:${edit}|mcp__pharaoh__get_codebase_map)$` : `^(?:${edit})$`,
		);
		add("PostToolUse", graphGroup);
		if (capture) {
			// Automatic capture (capture.mjs): log code edits and checks, decide at Stop.
			const recorder = command("--capture");
			const shell = client === "codex" ? "Bash|exec_command|functions\\.exec_command" : "Bash";
			add("PostToolUse", group(recorder, `^(?:${edit}|${shell})$`));
			if (client === "claude-code") add("PostToolUseFailure", group(recorder, "^Bash$"));
			add("Stop", group(recorder));
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

/** Whether Pharaoh's edit-time memory cue (a PostToolUse `--graph` entry) is installed. */
export function hasMemoryCueHook(config) {
	return hasUserHookMode(config, ["PostToolUse"], "--graph");
}

/** Whether Pharaoh's automatic capture (a Stop `--capture` entry) is installed. */
export function hasCaptureHook(config) {
	return hasUserHookMode(config, ["Stop"], "--capture");
}

/** Whether a Pharaoh user hook in one mode (`--graph`, `--capture`, `--diagnostics`) runs on `events`. */
export function hasUserHookMode(config, events, mode) {
	const flag = shellWord(mode);
	return hasHooks(config, events, (command) => matchesUserHook(command) && command.includes(flag));
}

/**
 * Whether both structural cue hooks are installed: the PreToolUse grep hook and the
 * PostToolUse group that also follows the codebase map. Removing either turns them off.
 */
export function hasStructuralCueHooks(config, client) {
	const cue = shellWord("--graph");
	const graph = (command) => matchesUserHook(command) && command.includes(cue);
	return (
		hasUserHooks({ hooks: { PreToolUse: config?.hooks?.PreToolUse } }, client) &&
		Array.isArray(config?.hooks?.PostToolUse) &&
		config.hooks.PostToolUse.some(
			(group) =>
				typeof group?.matcher === "string" &&
				group.matcher.includes("mcp__pharaoh__get_codebase_map") &&
				Array.isArray(group.hooks) &&
				group.hooks.some((entry) => graph(hookCommand(entry))),
		)
	);
}
