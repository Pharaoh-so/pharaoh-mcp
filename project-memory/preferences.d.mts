export type MemoryHookClient = "claude-code" | "codex";
export type HookPreferences = Partial<
	Record<MemoryHookClient, { memory?: boolean; graph?: boolean }>
>;
export const MEMORY_HOOK_CLIENTS: readonly MemoryHookClient[];
export function readHookPreferences(home?: string): HookPreferences;
export function writeHookPreferences(
	clients: HookPreferences,
	home?: string,
	expected?: HookPreferences,
): void;
export function resetHookPreferences(disable: boolean, home?: string): void;
