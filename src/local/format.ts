/** Presents saved-worktree scope and coverage without implying hosted risk detection. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LocalSnapshot } from "./snapshot.js";
import type { LocalAnalysisResult } from "./worker-host.js";

const MAX_CALLERS = 60;

const OUTCOME = {
	answered: "Known production callers",
	empty: "No known production callers in the captured scope",
	// The saved-worktree reader captures these languages only (snapshot.ts SOURCE_EXTENSIONS)
	missing:
		"The target was not found in the captured scope. Local scope reads TypeScript, JavaScript, Vue and Python files only.",
	ambiguous: "More than one target matches. Use an exact file-qualified function name.",
	incomplete: "Coverage is incomplete. Omitted or unresolved code may contain other callers.",
} as const;

/**
 * Format one private result for the requesting client.
 * @param result - Validated result from the confined analyzer
 * @param snapshot - Capture time and covered source inventory
 * @returns A model-visible text result and finite scope metadata
 */
export function formatLocalBlastRadius(
	result: LocalAnalysisResult,
	snapshot: LocalSnapshot,
): CallToolResult {
	const captured = new Date(snapshot.capturedAt).toISOString();
	const lines = [
		"Scope: local saved worktree",
		`Captured ${captured}. ${snapshot.sources.size} saved source files. Coverage: ${result.coverage}.`,
		OUTCOME[result.status],
	];
	for (const caller of result.callers.slice(0, MAX_CALLERS)) {
		lines.push(`- ${JSON.stringify(`${caller.file}:${caller.name}`)} (${caller.depth} hops)`);
	}
	if (result.callers.length > MAX_CALLERS)
		lines.push(`${result.callers.length - MAX_CALLERS} more callers omitted.`);
	if (result.status === "ambiguous") {
		for (const target of result.targets.slice(0, MAX_CALLERS))
			lines.push(`- ${JSON.stringify(`${target.file}:${target.name}`)}`);
	}
	lines.push("Risk, endpoint, cron, and database impact are not computed locally.");
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		_meta: {
			pharaohScope: {
				scope: "local",
				status: result.status,
				capturedAt: captured,
				coverage: result.coverage,
				risk: null,
				endpoints: "not_computed",
				crons: "not_computed",
				database: "not_computed",
			},
		},
	};
}
