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
	targetId?: string,
): Record<string, unknown>;

/** Install or remove the managed local-worktree hooks without changing client trust. */
export function syncLocalWorktreeHooks(
	client: "claude-code" | "codex",
	hookPath: string | null,
	options?: {
		node?: string;
		settingsPath?: string;
		viaLauncher?: boolean;
		scope?: { kind: "global" } | { kind: "local"; root: string };
		/** The explicit server flag in the registered proxy launch, when present. */
		server?: string;
	},
): void;

/** Add or remove the session-start update notice's one SessionStart handler. */
export function syncUpdateNoticeHook(
	client: "claude-code" | "codex",
	hookPath: string | null,
	options?: {
		node?: string;
		settingsPath?: string;
		home?: string;
		env?: NodeJS.ProcessEnv;
		scope?: { kind: "global" } | { kind: "local"; root: string };
	},
): void;

export function runtimeScopeMatches(
	scope: { kind: "global" } | { kind: "local"; root: string },
	options?: { cwd?: string; inputCwd?: string },
): boolean;
export function runtimeScopeFromArguments(
	args: string[],
): { kind: "global" } | { kind: "local"; root: string } | null;
