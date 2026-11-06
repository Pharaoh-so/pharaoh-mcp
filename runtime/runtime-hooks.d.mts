/** Merge the observer's marked groups into a native user hook configuration. */
export function updateRuntimeHooks(
	config: Record<string, unknown>,
	client: "claude-code" | "codex",
	hookPath: string | null,
	node?: string,
	clientBuild?: string,
	generation?: string,
	selectionId?: string,
	metadataVersion?: 1 | 2,
): Record<string, unknown>;
