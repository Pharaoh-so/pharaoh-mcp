/** Canonical native wire types; validation is implemented once in runtime-contract.mjs. */
export const RUNTIME_POLICY_VERSION: "runtime-v1";
export const RUNTIME_MODELS: readonly string[];
export const RUNTIME_PROFILES: readonly string[];
export const EXPLORATION_MODELS: readonly string[];
/** Finite v2 provenance, separately negotiated from the unchanged v1 policy. */
export interface RuntimeExplorationMetadata {
	/** Metadata wire version. */
	version: 2;
	/** Registered exact model identifier; recognition does not grant calibration. */
	modelId: string | null;
	/** Missing and unrecognized identifiers remain distinct. */
	modelState: "known" | "absent" | "unrecognized";
	/** Anchored family for technical reach diagnostics. */
	modelFamily: "opus" | "gpt6" | "other" | "unknown";
	/** Session-selected models are not request execution attestations. */
	modelBasis: "session_selected" | "request_observed" | "unknown";
	/** Generation-scoped HMAC of local selection identity. */
	selectionGeneration: string | null;
	/** Capability established at hook registration, not from model naming. */
	capability: "claude-session-switch-v2" | "codex-uncorrelated-v2" | "unsupported";
	/** Build evidence is installation discovery only. */
	buildBasis: "installation_observed" | "unknown";
	/** Discovery time, expires after one day. */
	buildObservedAt: string | null;
	/** Installed executable build or unknown; never inferred from a Desktop label. */
	clientBuild: string;
	/** Observed installing/proxy package build or unknown. */
	proxyBuild: string;
	/** Emitting adapter contract. */
	adapterVersion: "native-v2";
}
export interface RuntimeEvent {
	eventId: string;
	observedAt: string;
	sessionRef: string;
	episodeRef: string;
	kind:
		| "episode_start"
		| "episode_end"
		| "instruction_load"
		| "skill_request"
		| "skill_success"
		| "skill_expansion_request"
		| "tool_call"
		| "model_request"
		| "session_state";
	/** Optional negotiated v2 metadata; absence remains legacy evidence. */
	exploration?: RuntimeExplorationMetadata;
	/** Previous ambiguous selection to invalidate, never retroactively reattribute. */
	invalidateGeneration?: string;
	/** Conservative consent-generation fence when bounded local invalidations overflow. */
	invalidateAll?: true;
	/** Finite lifecycle transition; contains no native input. */
	lifecycle?: "start" | "switch" | "end" | "expired" | "evicted" | "ambiguous";
	ancestry: "root" | "child" | "unknown";
	parentRef?: string;
	nativeCallRef?: string;
	receipt?: string;
	profileId?: string;
	controlRef?: string;
	clientBuild?: string;
	proxyBuild?: string;
	model?: string;
	outcome?:
		| "completed"
		| "failed"
		| "cancelled"
		| "interrupted"
		| "session_end"
		| "stop_observed"
		| "unknown";
	instructionScope?: "User" | "Project" | "Local" | "Managed" | "unknown";
	loadReason?:
		| "session_start"
		| "nested_traversal"
		| "path_glob_match"
		| "include"
		| "compact"
		| "unknown";
	marker?: "exact" | "mention" | "none" | "unknown";
	skill?: "pharaoh" | "plan" | "review" | "refactor" | "debug" | "verify" | "brainstorm" | "tdd";
	tokens?: null | {
		input: number | null;
		cachedInput: number | null;
		cacheWriteInput: number | null;
		output: number | null;
		reasoningOutput: number | null;
		total: number | null;
	};
}
export function parseRuntimeEvent(raw: unknown): Readonly<RuntimeEvent>;
