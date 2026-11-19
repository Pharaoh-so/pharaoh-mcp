/** Explicit activation boundary, independent of shared credentials and runtime binaries. */
export type NativeFeedHookScope = { kind: "global" } | { kind: "local"; root: string };
/** Marker identifying only Pharaoh's automatically installed native context handlers. */
export const NATIVE_FEED_MARKER: string;
/** Obtain or create a stable adapter registration in the selected private home. */
export function nativeFeedRegistration(
	client: "claude-code" | "codex",
	options?: { home?: string },
): string;
/** Install/remove native feed hooks without changing trust or other hook definitions. */
export function syncNativeFeedHooks(
	client: "claude-code" | "codex",
	hookPath: string | null,
	options?: {
		node?: string;
		settingsPath?: string;
		home?: string;
		env?: NodeJS.ProcessEnv;
		viaLauncher?: boolean;
		registration?: string;
		serverArgv?: string[];
		scope?: NativeFeedHookScope;
	},
): void;
/** Read the independent native context opt-out without changing it. */
export function nativeFeedEnabled(
	client: "claude-code" | "codex",
	options?: { home?: string },
): boolean;
/** Save an explicit independent native context choice. */
export function setNativeFeedEnabled(
	client: "claude-code" | "codex",
	enabled: boolean,
	options?: { home?: string },
): void;
/** Resolve the native hook settings file in the configured client home. */
export function nativeFeedSettingsPath(
	client: "claude-code" | "codex",
	options?: { home?: string; env?: NodeJS.ProcessEnv; scope?: NativeFeedHookScope },
): string;
