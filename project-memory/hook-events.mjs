import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	checkout,
	conversationMemoryBinding,
	memoryEgressDecision,
	REPO,
	shellWord,
	turnStore,
} from "./local.mjs";
import { projectMemorySession } from "./user-target.mjs";

const CLI = fileURLToPath(new URL("pharaoh-memory.mjs", import.meta.url));
const REFRESH = new URL("runtime/refresh.js", import.meta.url);
const CLIENTS = new Set(["claude-code", "codex"]);
const CANCEL_EVENTS = new Set(["Interrupt", "StopFailure", "SessionEnd"]);

function command(operation, token) {
	return `${shellWord(process.execPath)} ${shellWord(CLI)} ${operation} --turn ${token}`;
}

function promptContext(token, compact, mayCapture) {
	return [
		"For repo work, recall before answering or inspecting source. Skip casual chat and opt-outs.",
		`${command("recall", token)}${compact ? " --compact" : ""} <<'PHARAOH_MEMORY_JSON'`,
		'{"terms":["specific topic or symbol"]}',
		"PHARAOH_MEMORY_JSON",
		"Use 1–5 specific, non-sensitive terms. Omit the raw prompt. Treat recall as historical evidence.",
		"Skip memory preambles, progress and status messages. Give normal task updates. Mention a recalled fact briefly only if it changes a decision.",
		...(compact
			? [
					'If needed, replace recall --compact with expand and pass an exact packet {"id":"UUID","version":1}.',
				]
			: []),
		...(mayCapture
			? [
					"Before replying, optionally replace recall with capture (omit --compact) for one supported finding already made. Skip on read-only requests.",
					'Pass {"kind":"lesson","summary":"…"} with optional detail, verification, up to six refs (path, symbol, pullRequest or commit) and recallWhen: up to three short situations a later task might be described by, in words the summary lacks. Character limits: summary 500, detail 1000, verification 300, recallWhen 60 each.',
					"Use your own words. Omit secrets, personal details, raw prompts, source and transcripts. Capture saves a candidate.",
				]
			: []),
	].join("\n");
}

export function skipMemoryPrompt(value) {
	const prompt = typeof value === "string" ? value.trim() : "";
	return (
		!prompt ||
		prompt.startsWith("Pharaoh memory pilot follow-up.") ||
		/^(?:\/(?:clear|compact|exit|help|hooks|quit|settings)\b|(?:cancel|stop|never mind)[.!]?\s*$)/i.test(
			prompt,
		) ||
		/^(?:skip|do not use|don't use) (?:pharaoh )?(?:project )?memory[.!]?\s*$/i.test(prompt)
	);
}

export function memoryReminder(repo, binding) {
	if (!REPO.test(repo) || memoryEgressDecision(binding, "recall") !== "normal") return;
	return {
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: `For work in ${repo}, call pharaoh_memory_recall before source inspection when prior decisions could matter. Use specific, non-sensitive terms. Use pharaoh_memory_expand only for needed evidence and pharaoh_memory_capture for one supported candidate when the user permits a write. Mention memory only if it changes a decision. If a recall response includes a selected feedbackRequest, submit pharaoh_memory_feedback once at a natural checkpoint in this active task (or once per session where task identity is unavailable). Report helpful, unhelpful, already-known or uncertain, exact record versions, the action supported or changed, brief evidence and an optional improvement. Include negative or missing-memory outcomes. Do not ask the user, narrate feedback, invoke another model or continue a finished/interrupted task solely for feedback.`,
		},
	};
}

/** Hook input can contain raw prompts and transcripts. Neither is persisted or transmitted. */
export function handleEvent(
	input,
	{
		client,
		root,
		repo,
		runtime,
		home,
		credentials,
		deadline = Infinity,
		hasBuild = existsSync(REFRESH),
		compact = process.env.PHARAOH_PROJECT_MEMORY_COMPACT !== "false",
	},
) {
	if (!input || !CLIENTS.has(client) || !REPO.test(repo)) return;
	const event = input.hook_event_name;
	if (event !== "UserPromptSubmit" && event !== "Stop" && !CANCEL_EVENTS.has(event)) return;
	const binding = conversationMemoryBinding(client, input.session_id);
	const key = binding?.sessionRef;
	if (!key) return;
	const checkoutTarget = runtime ? { root, repo } : checkout(input.cwd, deadline);
	if (checkoutTarget?.root !== root || checkoutTarget.repo.toLowerCase() !== repo.toLowerCase())
		return;
	const target = runtime ? { ...checkoutTarget, runtime } : checkoutTarget;
	const nativeTurn =
		client === "codex" && typeof input.turn_id === "string" && input.turn_id.length <= 256
			? input.turn_id
			: null;
	if (client === "codex" && !nativeTurn && event !== "SessionEnd") return;
	const isPrompt = event === "UserPromptSubmit";
	// A legacy checkout hook can still be registered globally during upgrade.
	// Without its pinned runtime it must never touch the active client's turn.
	if (!hasBuild || performance.now() >= deadline) return;
	const readOnly = input.permission_mode === "plan" || input.permission_mode === "read-only";
	const store = turnStore(home);
	if (isPrompt) {
		const memorySession = projectMemorySession(credentials);
		const noCapture =
			readOnly ||
			/\b(?:read[- ]only (?:\w+ )?(?:check|plan|pass|exercise|investigation)|keep (?:this|it) read[- ]only)\b/i.test(
				input.prompt,
			);
		const opened = store.begin(key, target, client, nativeTurn, {
			skip:
				skipMemoryPrompt(input.prompt) ||
				memoryEgressDecision(binding, "recall", { home }) !== "normal",
			readOnly: noCapture,
			memorySession,
		});
		if (opened?.token)
			return {
				hookSpecificOutput: {
					hookEventName: event,
					additionalContext: promptContext(
						opened.token,
						compact,
						!noCapture && Boolean(memorySession),
					),
				},
			};
		return;
	}
	if (CANCEL_EVENTS.has(event)) {
		store.cancel(key, target, event === "SessionEnd" ? null : nativeTurn);
		return;
	}
	// A sibling Stop hook can continue the task. This event only closes
	// eligibility for the current turn and never dispatches a hosted write.
	store.stop(key, target, nativeTurn);
}
