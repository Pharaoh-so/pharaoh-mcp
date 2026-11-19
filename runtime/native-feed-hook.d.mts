/** Validated native event adapter; unknown events produce no context. */
export function runNativeFeedHook(
	payload: unknown,
	options: {
		client: "codex" | "claude-code";
		registration: string;
		server: string;
		serverArgv?: string[];
		home?: string;
		credentialsPath?: string;
		now?: () => number;
		startedAt?: number;
		launch?: (job: Record<string, unknown>, now?: number) => unknown;
	},
): { hookSpecificOutput: { hookEventName: string; additionalContext: string } } | null;
/** Confirm a successful output handoff once, without claiming model consumption. */
export function confirmNativeFeedEmission(output: object): boolean;
