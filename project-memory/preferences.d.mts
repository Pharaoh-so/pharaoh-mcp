export type MemoryHookClient = "claude-code" | "codex";
export type MemoryHookState = "installed" | "declined" | "absent" | "unsupported" | "unknown";
export type HookPreferences = Partial<
	Record<
		MemoryHookClient,
		{
			memory?: boolean;
			graph?: boolean;
			diagnostics?: boolean;
			diagnosticsPolicyVersion?: string;
			diagnosticsGeneration?: string;
		}
	>
>;
export const MEMORY_HOOK_CLIENTS: readonly MemoryHookClient[];
export function readHookPreferences(home?: string): HookPreferences;
export function writeHookPreferences(
	clients: HookPreferences,
	home?: string,
	expected?: HookPreferences,
): void;
export function resetHookPreferences(disable: boolean, home?: string): void;
export function memoryHookStateForClient(
	info: { name?: string; version?: string } | undefined,
	options?: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): MemoryHookState;
export function memoryDiagnosticsForClient(
	info: { name?: string; version?: string },
	home?: string,
):
	| {
			clientName: MemoryHookClient;
			generation: string;
			versions: {
				clientVersion: string | null;
				collectionPolicyVersion: string;
				collectorVersion: string;
				capabilitySchemaVersion: string;
			};
	  }
	| undefined;
