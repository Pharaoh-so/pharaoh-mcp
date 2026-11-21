import type { Stats } from "node:fs";

/** Raw Git output constrained by an absolute performance.now deadline. */
export function gitRawBefore(
	cwd: string,
	maxBuffer: number,
	deadline: number,
	...command: string[]
): string;

/** Quote one value as a literal POSIX shell argument. */
export function shellWord(value: string): string;

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
