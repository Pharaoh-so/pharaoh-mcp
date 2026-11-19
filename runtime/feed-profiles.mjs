/** Exact native event/output contracts established by isolated interactive release fixtures. */
const EVENTS = Object.freeze(["SessionStart", "UserPromptSubmit", "SubagentStart", "PostToolUse"]);
/** Eligible versions are exact: a future client release requires its own transport fixture. */
export const TESTED_FEED_PROFILES = Object.freeze([
	Object.freeze({
		client: "codex",
		name: "codex-mcp-client",
		version: "0.166.0",
		contract: "additional-context-v1",
		events: EVENTS,
	}),
	Object.freeze({
		client: "claude-code",
		name: "claude-code",
		version: "2.1.327",
		contract: "additional-context-v1",
		events: EVENTS,
	}),
	Object.freeze({
		client: "claude-code",
		name: "claude-code",
		version: "2.1.328",
		contract: "additional-context-v1",
		events: EVENTS,
	}),
]);
/** Select only a recorded exact native version that supports this event/output contract. */
export function classifyFeedProfile(name, version, event, contract = "additional-context-v1") {
	if (typeof name !== "string" || typeof version !== "string" || typeof event !== "string")
		return null;
	return (
		TESTED_FEED_PROFILES.find(
			(profile) =>
				profile.name === name &&
				profile.version === version &&
				profile.contract === contract &&
				profile.events.includes(event),
		) ?? null
	);
}
