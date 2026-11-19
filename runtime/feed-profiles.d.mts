/** A release-proven native additionalContext contract. */
export interface FeedProfile {
	client: string;
	name: string;
	version: string;
	contract: string;
	events: readonly string[];
}
export const TESTED_FEED_PROFILES: readonly FeedProfile[];
export function classifyFeedProfile(
	name: unknown,
	version: unknown,
	event: unknown,
	contract?: string,
): FeedProfile | null;
