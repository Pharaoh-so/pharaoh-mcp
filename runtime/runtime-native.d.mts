/** Reserved proxy-owned metadata namespace. */
export const RUNTIME_META: "pharaoh/runtime";
export const RUNTIME_CLIENTS: readonly ["claude-code", "codex"];
export const RUNTIME_TOOL_NAMES: readonly string[];
export const EVENT_TTL_MS: number;
export function runtimeClient(name?: string): "claude-code" | "codex" | null;
export function runtimeBuild(value: unknown): string;
export function runtimeUuid(value: unknown): value is string;
export function extractRuntimeReceipt(
	result: unknown,
	now?: number,
): { receipt: string; expiresAt: string } | null;
export function sanitizeRuntimeResult<T>(result: T, enrolled: boolean): T;
