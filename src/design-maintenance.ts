import { authorizedRequest, DesignError } from "./design-projection.js";

/** Machine-readable opt-in only. Paths, selectors, findings and saved files stay in the checkout. */
export async function setMappedMaintenance(
	origin: string,
	repoId: string,
	enabled: boolean,
	signal: AbortSignal,
) {
	if (process.env.CI || process.env.GITHUB_ACTIONS)
		throw new DesignError(2, "Configure design maintenance from an authorized developer checkout.");
	const result = await authorizedRequest(
		origin,
		`/api/design/repos/${repoId}/maintenance`,
		signal,
		{ enabled },
	);
	if (result?.enabled !== enabled)
		throw new DesignError(2, "Maintenance change was not confirmed.");
	return enabled
		? `Pharaoh will suggest design rules from the mapped default branch. Review them at ${origin}/setup/design/${repoId}`
		: "Automatic design suggestions are disabled for this repository.";
}
