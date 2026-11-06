import type { Stats } from "node:fs";

/** Opaque reference derived from a native client and conversation ID. */
export interface ConversationMemoryBinding {
	readonly client: "claude-code" | "codex";
	readonly sessionRef: string;
}

interface ConversationStateOptions {
	home?: string;
	storage?: {
		privatePath(path: string, directory: boolean): Pick<Stats, "size" | "nlink">;
		ensurePrivateDirectory(path: string): void;
	};
}

export function conversationMemoryBinding(
	client: string,
	sessionId: unknown,
): ConversationMemoryBinding | undefined;

export function markSessionLocal(
	binding: ConversationMemoryBinding | undefined,
	options?: ConversationStateOptions,
): boolean;

/** `null` means verified hosted; `undefined` means identity is unavailable. */
export function sessionLocalSensitivity(
	binding: ConversationMemoryBinding | null | undefined,
	options?: ConversationStateOptions,
): "clear" | "local" | "unknown";

export function memoryEgressDecision(
	binding: ConversationMemoryBinding | null | undefined,
	operation: string,
	options?: ConversationStateOptions,
): "normal" | "metadata" | "blocked";

export function diagnosticEventForEgress(
	client: string,
	event: unknown,
	options?: ConversationStateOptions & { metadataOnly?: boolean },
): unknown;

export function turnStore(
	home?: string,
	now?: () => number,
): {
	begin(
		key: string | undefined,
		target: { root: string; repo: string; runtime?: string },
		client: string,
		nativeTurn: string | null,
		options: { skip: boolean; readOnly: boolean; memorySession?: string },
	): { token?: string; degraded?: "overlap" | "busy" } | undefined;
};
