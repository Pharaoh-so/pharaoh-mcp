/** Run the installed local snapshot/reproduction verifier under ordinary agent command permissions. */
export function runChangeReview(
	args: string[],
	options?: { cwd?: string },
): Promise<Record<string, unknown>>;
