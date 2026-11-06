/** Reduce native hook input to finite observations; never retain the input envelope. */
import { createHmac } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RUNTIME_MODELS } from "./runtime-contract.mjs";

export const RUNTIME_META = "pharaoh/runtime";
export const RUNTIME_CLIENTS = ["claude-code", "codex"];
export const EVENT_TTL_MS = 86_400_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const BUILD = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,40})?$/;
export const RUNTIME_TOOL_NAMES = [
	"get_codebase_map",
	"get_module_context",
	"search_functions",
	"pharaoh_recon",
	"get_blast_radius",
	"get_unused_code",
];
const TOOL = new RegExp(`^mcp__pharaoh__(?:${RUNTIME_TOOL_NAMES.join("|")})$`);
const SKILL = /^pharaoh:(pharaoh|plan|review|refactor|debug|verify|brainstorm|tdd)$/;
const FIRST_LINE =
	"In repos Pharaoh has mapped, before searching or reading files, ask Pharaoh where the relevant code is, what calls it, and whether what you need already exists.";
const finite = (value, choices) => (choices.includes(value) ? value : "unknown");
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/** Recognize only a bounded native identifier; it is hashed before leaving memory. */
export function nativeIdentifier(value) {
	return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

/** Validate opaque UUID fields without coercing arbitrary inputs. */
export function runtimeUuid(value) {
	return typeof value === "string" && UUID.test(value);
}

/** Preserve only a known finite native client family. */
export function runtimeClient(name) {
	const normalized = typeof name === "string" ? name.toLowerCase() : "";
	if (["claude-code", "claude code", "claude-cli"].includes(normalized)) return "claude-code";
	if (["codex", "codex-mcp-client", "codex_cli_rs", "codex-desktop"].includes(normalized))
		return "codex";
	return null;
}

/** Bound version provenance without accepting arbitrary client strings. */
export function runtimeBuild(value) {
	return typeof value === "string" && BUILD.test(value) ? value : "unknown";
}

/** Key native identifiers to a consent generation; never persist raw IDs. */
export function runtimeRef(key, namespace, value) {
	return createHmac("sha256", key).update(`${namespace}\0${value}`).digest("hex");
}

/** Extract a current receipt from exactly the reserved structured result metadata. */
export function extractRuntimeReceipt(result, now = Date.now()) {
	const value = result?._meta?.[RUNTIME_META];
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== 2 ||
		!runtimeUuid(value.receipt) ||
		typeof value.expiresAt !== "string"
	)
		return null;
	const expiry = Date.parse(value.expiresAt);
	return expiry > now && expiry - now <= EVENT_TTL_MS + 5 * 60_000
		? { receipt: value.receipt, expiresAt: value.expiresAt }
		: null;
}

/** Strip reserved server fields except a validated opaque receipt on an enrolled call. */
export function sanitizeRuntimeResult(result, enrolled) {
	if (!result?._meta || !Object.hasOwn(result._meta, RUNTIME_META)) return result;
	const { [RUNTIME_META]: _runtime, ...meta } = result._meta;
	const receipt = enrolled ? extractRuntimeReceipt(result) : null;
	return { ...result, _meta: { ...meta, ...(receipt && { [RUNTIME_META]: receipt }) } };
}

function recognizedInstruction(input, scope, home, env) {
	const { file_path: file, cwd } = input;
	if (typeof file !== "string" || !isAbsolute(file) || file.length > 4_096) return null;
	const config = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
	const base = scope === "User" ? config : ["Project", "Local"].includes(scope) ? cwd : null;
	if (typeof base !== "string" || !isAbsolute(base)) return null;
	const path = resolve(file);
	const rel = relative(resolve(base), path).split(sep).join("/");
	if (scope === "Local") return rel === "CLAUDE.local.md" ? path : null;
	if (scope === "User")
		return rel === "CLAUDE.md" || /^rules\/(?:[\w.-]+\/)*[\w.-]+\.md$/.test(rel) ? path : null;
	return /^(?:(?:[\w.-]+\/)*CLAUDE\.md|(?:[\w.-]+\/)*\.claude\/rules\/(?:[\w.-]+\/)*[\w.-]+\.md)$/.test(
		rel,
	) && !rel.startsWith("../")
		? path
		: null;
}

function instructionMarker(input, scope, home, env) {
	let fd;
	try {
		const path = recognizedInstruction(input, scope, home, env);
		// Refuse symlinked ancestors as well as the file. Missing/unreadable is unknown.
		if (!path || realpathSync(path) !== path || typeof process.getuid !== "function")
			return "unknown";
		const before = lstatSync(path);
		if (!before.isFile() || before.uid !== process.getuid() || before.size > 65_536)
			return "unknown";
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > 65_536)
			return "unknown";
		const buffer = Buffer.alloc(65_537);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		if (length > 65_536) return "unknown";
		const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
		return text.includes(FIRST_LINE) ? "exact" : /\bpharaoh\b/i.test(text) ? "mention" : "none";
	} catch {
		return "unknown";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Map one observed hook to a finite payload; absence never means zero or non-use. */
export function nativeObservation(
	input,
	client,
	key,
	now,
	{ home = homedir(), env = process.env } = {},
) {
	const event = input?.hook_event_name;
	const nativeCall = nativeIdentifier(input?.tool_use_id);
	const nativeCallRef = nativeCall ? runtimeRef(key, "call", nativeCall) : undefined;
	const model = finite(input?.model, RUNTIME_MODELS);
	const child = Boolean(nativeIdentifier(input?.agent_id));
	const ancestry = child ? "child" : event === "UserPromptSubmit" ? "root" : "unknown";
	const shared = { ancestry, model };
	if (event === "SessionStart") return { ...shared, boundary: "session" };
	if (client === "claude-code" && event === "PostModelSwitch")
		return { ...shared, boundary: "switch" };
	if (event === "UserPromptSubmit") return { ...shared, kind: "episode_start" };
	if (["Stop", "SessionEnd", "StopFailure", "Interrupt"].includes(event)) {
		const outcome = {
			Stop: "stop_observed",
			SessionEnd: "session_end",
			StopFailure: "failed",
			Interrupt: "interrupted",
		}[event];
		return { ...shared, kind: "episode_end", outcome };
	}
	if (client === "claude-code" && event === "InstructionsLoaded") {
		const instructionScope = finite(input.memory_type, ["User", "Project", "Local", "Managed"]);
		return {
			...shared,
			kind: "instruction_load",
			instructionScope,
			loadReason: finite(input.load_reason, [
				"session_start",
				"nested_traversal",
				"path_glob_match",
				"include",
				"compact",
			]),
			// This marker is the bounded file at observation time, not the loaded bytes.
			marker: instructionMarker(input, instructionScope, home, env),
		};
	}
	if (
		client === "claude-code" &&
		input.tool_name === "Skill" &&
		["PreToolUse", "PostToolUse"].includes(event)
	) {
		const skill =
			typeof input.tool_input?.skill === "string" ? SKILL.exec(input.tool_input.skill)?.[1] : null;
		return skill
			? {
					...shared,
					kind: event === "PreToolUse" ? "skill_request" : "skill_success",
					skill,
					...(nativeCallRef && { nativeCallRef }),
				}
			: null;
	}
	if (
		client === "claude-code" &&
		event === "UserPromptExpansion" &&
		input.expansion_type === "slash_command" &&
		input.command_source === "plugin"
	) {
		const skill =
			typeof input.command_name === "string" ? SKILL.exec(input.command_name)?.[1] : null;
		return skill ? { ...shared, kind: "skill_expansion_request", skill } : null;
	}
	if (
		["PostToolUse", "PostToolUseFailure"].includes(event) &&
		typeof input.tool_name === "string" &&
		TOOL.test(input.tool_name)
	) {
		const receipt = nativeCallRef ? extractRuntimeReceipt(input.tool_response, now) : null;
		return {
			...shared,
			kind: "tool_call",
			outcome: event === "PostToolUse" ? "completed" : "failed",
			...(nativeCallRef && { nativeCallRef }),
			...(receipt && { receipt: receipt.receipt }),
		};
	}
	if (client === "codex" && event === "PostModelRequest") {
		const usage = input.token_usage;
		return {
			...shared,
			kind: "model_request",
			outcome: finite(input.status, ["completed", "failed", "cancelled"]),
			// These are callback observations, not deduplicated native requests.
			tokens:
				usage && typeof usage === "object" && !Array.isArray(usage)
					? {
							input: count(usage.input_tokens),
							cachedInput: count(usage.cached_input_tokens),
							cacheWriteInput: count(usage.cache_write_input_tokens),
							output: count(usage.output_tokens),
							reasoningOutput: count(usage.reasoning_output_tokens),
							total: count(usage.total_tokens),
						}
					: null,
		};
	}
	return null;
}
