/** Native installation scope and bounded lookup. */
export interface FeedIdentityOptions {
	home?: string;
	credentialsPath?: string;
}
export function readFeedSignInGeneration(options?: FeedIdentityOptions): string | null;
export function feedServerOrigin(value: unknown): string | null;
export function resolveFeedCheckout(cwd: unknown): string | null;
/** Physical worktree and captured remote-configuration identity; source bytes are never included. */
export function feedCheckoutIdentity(checkout: string): string | null;
/** Stable local branch, detached HEAD (null), or unavailable metadata (undefined). */
export function readFeedBranch(checkout: unknown): string | null | undefined;
export function deriveFeedCohortKey(scope: {
	client: string;
	registration: string;
	server: string;
	serverArgv?: string[];
	signIn: string;
	checkout: string;
}): string | null;
export function readFeedRegistration(
	options: FeedIdentityOptions & { client: string },
): string | null;
export function resolveFeedProfile(
	options: FeedIdentityOptions & {
		cohort: string;
		event: string;
		client: string;
		registration: string;
		exactConnectionId?: string;
		now?: number;
	},
): { admit: boolean; basis: string; exactVersion: string; reason: string; contract?: string };
/** Read explicit per-client enrollment for feed features awaiting wider qualification. */
export function nativeFeedPreviewEnabled(
	client: "codex" | "claude-code",
	options?: { home?: string },
): boolean;
