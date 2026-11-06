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

/** Install or remove the managed local-worktree hooks without changing client trust. */
export function syncLocalWorktreeHooks(
	client: "claude-code" | "codex",
	hookPath: string | null,
	options?: { node?: string; settingsPath?: string },
): void;
