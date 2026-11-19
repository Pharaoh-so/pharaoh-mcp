/** Owner-private committed identity returned to the native feed. */
export interface FeedSignIn {
	generation: string;
	server: string;
	root: string;
}
/** Pending publication held under the credential lock. */
export interface PendingFeedSignIn {
	version: number;
	state: string;
	generation: string;
	server: string;
	credentialPath: string;
}
/** Isolated feed root belonging to a credential file. */
export function feedRootForCredentials(path?: string): string;
/** Read only an active, internally consistent lifecycle marker. */
export function readFeedSignIn(path?: string): FeedSignIn | null;
/** Invalidate the old generation and begin explicit authorization. Caller holds the credential lock. */
export function beginFeedSignIn(
	server: string,
	path?: string,
	generation?: string,
): PendingFeedSignIn;
/** Commit the pending generation after credentials were successfully persisted. */
export function commitFeedSignIn(pending: PendingFeedSignIn, path?: string): string;
/** Withdraw all access through the active generation; caller holds the credential lock. */
export function withdrawFeedSignIn(path?: string): void;
/** Bootstrap absent legacy state after install validated the sign-in and acquired its lock. */
export function bootstrapFeedSignIn(
	server: string,
	path?: string,
	persistGeneration?: (generation: string) => void,
): string | null;
