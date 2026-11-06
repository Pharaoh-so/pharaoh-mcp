/** Shared content-free wire contract for server intake and bundled native hooks. */
export const RUNTIME_POLICY_VERSION = "runtime-v1";
export const RUNTIME_MODELS = [
	"unknown",
	"claude-opus-5-5",
	"claude-sonnet-4-6",
	"gpt-5.4",
	"gpt-5.5",
	"gpt-6.1",
];
export const RUNTIME_PROFILES = ["module-overview-v1", "callers-depth3-v1"];
/** Recognition candidates, not calibrated cells or verified ordinary-native coverage. */
export const EXPLORATION_MODELS = [
	"claude-opus-5-5",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-6-luna",
];
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const REF = /^[a-f0-9]{64}$/;
const BUILD = /^(?:unknown|\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,40})?)$/;
const COMMON = [
	"eventId",
	"observedAt",
	"sessionRef",
	"episodeRef",
	"kind",
	"ancestry",
	"parentRef",
	"clientBuild",
	"proxyBuild",
	"model",
	"exploration",
];
const FIELDS = {
	episode_start: ["profileId", "controlRef"],
	episode_end: ["outcome"],
	instruction_load: ["instructionScope", "loadReason", "marker"],
	skill_request: ["skill", "nativeCallRef"],
	skill_success: ["skill", "nativeCallRef"],
	skill_expansion_request: ["skill", "nativeCallRef"],
	tool_call: ["receipt", "nativeCallRef", "outcome"],
	model_request: ["nativeCallRef", "outcome", "tokens"],
	session_state: ["invalidateGeneration", "invalidateAll", "lifecycle"],
};
const ENUMS = {
	ancestry: ["root", "child", "unknown"],
	outcome: [
		"completed",
		"failed",
		"cancelled",
		"interrupted",
		"session_end",
		"stop_observed",
		"unknown",
	],
	instructionScope: ["User", "Project", "Local", "Managed", "unknown"],
	loadReason: [
		"session_start",
		"nested_traversal",
		"path_glob_match",
		"include",
		"compact",
		"unknown",
	],
	marker: ["exact", "mention", "none", "unknown"],
	skill: ["pharaoh", "plan", "review", "refactor", "debug", "verify", "brainstorm", "tdd"],
	profileId: RUNTIME_PROFILES,
	model: RUNTIME_MODELS,
	lifecycle: ["start", "switch", "end", "expired", "evicted", "ambiguous"],
};
const TOKENS = ["input", "cachedInput", "cacheWriteInput", "output", "reasoningOutput", "total"];
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const REQUIRED = {
	episode_start: [],
	episode_end: ["outcome"],
	instruction_load: ["instructionScope", "loadReason", "marker"],
	skill_request: ["skill"],
	skill_success: ["skill"],
	skill_expansion_request: ["skill"],
	tool_call: ["outcome"],
	model_request: ["outcome", "tokens"],
	session_state: ["exploration", "lifecycle"],
};

function parseExploration(value) {
	const fields = [
		"version",
		"modelId",
		"modelState",
		"modelFamily",
		"modelBasis",
		"selectionGeneration",
		"capability",
		"buildBasis",
		"buildObservedAt",
		"clientBuild",
		"proxyBuild",
		"adapterVersion",
	];
	if (
		!object(value) ||
		Object.keys(value).length !== fields.length ||
		fields.some((field) => !Object.hasOwn(value, field)) ||
		value.version !== 2 ||
		value.adapterVersion !== "native-v2" ||
		!["known", "absent", "unrecognized"].includes(value.modelState) ||
		!["opus", "gpt6", "other", "unknown"].includes(value.modelFamily) ||
		!["session_selected", "request_observed", "unknown"].includes(value.modelBasis) ||
		!["claude-session-switch-v2", "codex-uncorrelated-v2", "unsupported"].includes(
			value.capability,
		) ||
		!["installation_observed", "unknown"].includes(value.buildBasis) ||
		!matches(BUILD, value.clientBuild) ||
		!matches(BUILD, value.proxyBuild) ||
		(value.selectionGeneration !== null && !matches(REF, value.selectionGeneration)) ||
		(value.modelId !== null && !EXPLORATION_MODELS.includes(value.modelId)) ||
		(value.modelState === "known") !== (value.modelId !== null) ||
		(value.buildObservedAt !== null &&
			(!matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, value.buildObservedAt) ||
				!Number.isFinite(Date.parse(value.buildObservedAt))))
	)
		throw new Error("invalid_runtime_event");
	return Object.freeze({ ...value });
}
/** Reject unknown fields and all content payloads; return a detached finite observation. */
export function parseRuntimeEvent(raw) {
	if (!object(raw) || typeof raw.kind !== "string" || !Object.hasOwn(FIELDS, raw.kind))
		throw new Error("invalid_runtime_event");
	const allowed = new Set([...COMMON, ...FIELDS[raw.kind]]);
	if (
		Object.keys(raw).some((k) => !allowed.has(k)) ||
		REQUIRED[raw.kind].some((k) => raw[k] === undefined)
	)
		throw new Error("invalid_runtime_event");
	if (
		!matches(UUID, raw.eventId) ||
		!matches(REF, raw.sessionRef) ||
		!matches(REF, raw.episodeRef) ||
		!matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, raw.observedAt) ||
		!Number.isFinite(Date.parse(raw.observedAt)) ||
		new Date(raw.observedAt).toISOString() !== raw.observedAt ||
		!ENUMS.ancestry.includes(raw.ancestry)
	)
		throw new Error("invalid_runtime_event");
	for (const field of ["parentRef", "nativeCallRef", "controlRef", "invalidateGeneration"])
		if (raw[field] !== undefined && !matches(REF, raw[field]))
			throw new Error("invalid_runtime_event");
	if (
		raw.invalidateAll !== undefined &&
		(raw.invalidateAll !== true || raw.invalidateGeneration !== undefined)
	)
		throw new Error("invalid_runtime_event");
	if (
		(raw.controlRef !== undefined && raw.profileId === undefined) ||
		(raw.receipt !== undefined && (!matches(UUID, raw.receipt) || raw.nativeCallRef === undefined))
	)
		throw new Error("invalid_runtime_event");
	for (const field of ["clientBuild", "proxyBuild"])
		if (raw[field] !== undefined && (typeof raw[field] !== "string" || !BUILD.test(raw[field])))
			throw new Error("invalid_runtime_event");
	for (const [field, values] of Object.entries(ENUMS))
		if (raw[field] !== undefined && !values.includes(raw[field]))
			throw new Error("invalid_runtime_event");
	if (raw.tokens !== undefined && raw.tokens !== null) {
		if (
			!object(raw.tokens) ||
			Object.keys(raw.tokens).length !== TOKENS.length ||
			TOKENS.some(
				(k) =>
					!Object.hasOwn(raw.tokens, k) ||
					(raw.tokens[k] !== null && (!Number.isSafeInteger(raw.tokens[k]) || raw.tokens[k] < 0)),
			)
		)
			throw new Error("invalid_runtime_event");
	}
	return Object.freeze({
		...raw,
		...(raw.exploration !== undefined && { exploration: parseExploration(raw.exploration) }),
		eventId: raw.eventId.toLowerCase(),
		...(raw.receipt && { receipt: raw.receipt.toLowerCase() }),
		...(raw.tokens && { tokens: Object.freeze({ ...raw.tokens }) }),
	});
}
