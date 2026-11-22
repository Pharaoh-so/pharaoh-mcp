// Replaced only in the owned, opt-in Claude plugin with the installed Node, hook and scope.
const launch = null;

async function bridge($, operation, fields) {
	try {
		const session_id = await $.session.id();
		const cwd = await $.session.root();
		const result = await $.process.run(
			[launch.node, launch.hook, "claude-code", operation, ...launch.scope],
			{ stdin: JSON.stringify({ session_id, cwd, ...fields }), timeoutMs: 1200 },
		);
		if (result.exitCode === 0 && result.stdout && result.stdout.length <= 8192)
			return JSON.parse(result.stdout);
	} catch {
		// A disabled, unavailable or obsolete local runtime earns no visible receipt.
	}
	return null;
}

/** Only a completed, still-current main turn can show the verified line. */
export function register(on) {
	if (!launch) return;
	let submitted;
	let active;

	on("prompt.submit", async ($, event, next) => {
		const overlapping = Boolean(submitted || event.turnId);
		submitted = undefined;
		active = undefined;
		if (!overlapping && event.origin?.kind === "composer" && !event.command) {
			const submission = {};
			submitted = submission;
			const boundary = await bridge($, "--completion-boundary", {});
			if (boundary?.previousReviewTurn === null || typeof boundary?.previousReviewTurn === "string")
				submission.previous = boundary.previousReviewTurn;
		}
		return next(event);
	});

	on("turn.start", async ($, event, next) => {
		if (!event.agentId) {
			const submission = submitted;
			submitted = undefined;
			active = undefined;
			if (event.turnId && submission && "previous" in submission) {
				const turn = { id: event.turnId };
				active = turn;
				const binding = await bridge($, "--completion-bind", {
					completion_turn_id: turn.id,
					previous_review_turn: submission.previous,
				});
				if (typeof binding?.reviewTurn === "string") turn.nonce = binding.reviewTurn;
			}
		}
		return next(event);
	});

	on("turn.complete", async ($, event, next) => {
		const turn = active;
		const previous = await next(event);
		if (event.agentId || !turn || turn.consuming || active !== turn || turn.id !== event.turnId)
			return previous;
		if (
			!turn.nonce ||
			event.isAborted ||
			event.reason !== "answer" ||
			!event.answer?.trim() ||
			(previous?.text && previous.text !== event.answer)
		) {
			active = undefined;
			return previous;
		}
		turn.consuming = true;
		const receipt = await bridge($, "--completion-receipt", {
			completion_turn_id: turn.id,
			review_turn: turn.nonce,
		});
		if (active !== turn) return previous;
		active = undefined;
		return typeof receipt?.message === "string" && receipt.message
			? { ...previous, text: receipt.message }
			: previous;
	});
}
