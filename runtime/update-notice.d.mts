/** The session-start update notice's state file, hook copy and output. */

/** The stored versions: installed (`version`), npm's latest, and when the release was last fetched. */
export interface UpdateState {
	version?: unknown;
	latest?: unknown;
	release_checked_at?: unknown;
}

/** The marker that ends the hook command. */
export const UPDATE_NOTICE_MARKER: "--pharaoh-update-notice-v1";
/** The hook copy's file name inside ~/.pharaoh. */
export const UPDATE_NOTICE_HOOK: "update-notice-hook.mjs";

/** Whether `candidate` is a newer plain x.y.z than `current`. */
export function newerVersion(candidate: unknown, current: unknown): boolean;

/** The stored versions, or null when missing or malformed. */
export function readUpdateState(directory: string): UpdateState | null;

/** Merge fields into the stored versions atomically; false when it couldn't. */
export function writeUpdateState(
	fields: { version?: string; latest?: string; release_checked_at?: string },
	directory: string,
): boolean;

/** Copy the hook to its stable path; the path, or null when it couldn't. */
export function copyUpdateNoticeHook(directory: string): string | null;

/** One session start's output, or null while the install is current. */
export function updateNotice(
	client: string | undefined,
	options?: { directory?: string; now?: number },
): {
	systemMessage?: string;
	hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
} | null;
