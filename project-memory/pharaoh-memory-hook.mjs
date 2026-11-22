import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryClientRoot } from "./client-settings.mjs";
import { handleEvent, memoryReminder, skipMemoryPrompt } from "./hook-events.mjs";
import { memoryScopeMatches, setMemoryInstallScope } from "./install-scope.mjs";
import { conversationMemoryBinding, protectLocalShellAttempt, readStdin } from "./local.mjs";
import {
	activeMemoryRuntime,
	projectMemorySession,
	readMemoryCredentials,
	resolveMemoryHookTarget,
} from "./user-target.mjs";

// Leave margin inside the client's three-second hook timeout. The process
// clock includes startup and imports, and no late network request can start.
const deadline = 2_400;
const exitQuietly = setTimeout(() => process.exit(0), Math.max(0, deadline - performance.now()));
// One shared optional-review budget per native event, leaving time for existing memory behavior.
let reviewDeadline;
function reviewCall(runtime, method, input, options) {
	if (!runtime) return;
	reviewDeadline ??= Math.min(performance.now() + 350, deadline - 700);
	if (performance.now() >= reviewDeadline) return;
	try {
		return runtime[method](input, { ...options, deadline: reviewDeadline });
	} catch {
		return undefined;
	}
}

try {
	const [client, root, repo] = process.argv.slice(2);
	const input = await readStdin(1024 * 1024);
	const scopeIndex = process.argv.indexOf("--install-root");
	const scope = scopeIndex < 0 ? undefined : { kind: "local", root: process.argv[scopeIndex + 1] };
	setMemoryInstallScope(scope);
	if (!memoryScopeMatches(input?.cwd, scope)) process.exit(0);
	let result;
	if (["--user", "--graph", "--diagnostics", "--capture", "--review"].includes(root)) {
		const reminder = root === "--user";
		const diagnosticOnly = root === "--diagnostics";
		const capture = root === "--capture";
		const reviewOnly = root === "--review";
		const event = input?.hook_event_name;
		if (
			reviewOnly
				? event !== "PostToolUse"
				: reminder
					? event !== "UserPromptSubmit"
					: diagnosticOnly
						? !["PostToolUse", "Stop", "StopFailure", "Interrupt", "SessionEnd"].includes(event)
						: capture
							? !["PostToolUse", "PostToolUseFailure", "Stop"].includes(event)
							: event !== "PreToolUse" && event !== "PostToolUse"
		)
			process.exit(0);
		let structuralSearch;
		if (event === "PreToolUse") {
			if (input.tool_name !== "Bash") process.exit(0);
			const { classifyBashGrep } = await import("./route-grep.mjs");
			structuralSearch = classifyBashGrep(input.tool_input?.command);
			if (!structuralSearch) process.exit(0);
		}
		const runtime = dirname(fileURLToPath(import.meta.url));
		if (!activeMemoryRuntime(client, runtime, undefined, scope)) process.exit(0);
		const { readHookPreferences, changeReviewEnabled } = await import("./preferences.mjs");
		const choice = readHookPreferences()[client];
		const review =
			client === "claude-code" && choice?.graph !== false && changeReviewEnabled(undefined, scope);
		const captureEnabled = choice?.capture !== false;
		if (reviewOnly && !review) process.exit(0);
		if (
			choice?.memory === false ||
			(diagnosticOnly && choice?.diagnostics !== true) ||
			(capture && !captureEnabled && !(review && event === "Stop"))
		)
			process.exit(0);
		// The memory cue is part of project memory; the structural cues are their own choice.
		const structural = choice?.graph === true;
		if (event === "PreToolUse" && !structural) process.exit(0);
		if (
			capture &&
			event !== "Stop" &&
			["Bash", "exec_command", "functions.exec_command"].includes(input.tool_name)
		) {
			// Most shell commands are not checks: leave before reading git or the sign-in.
			const { checkCommand } = await import("./capture.mjs");
			if (!checkCommand(input.tool_input?.command ?? input.tool_input?.cmd)) process.exit(0);
		}
		if (diagnosticOnly) protectLocalShellAttempt(client, input);
		const credentials = await readMemoryCredentials();
		const eligible = await resolveMemoryHookTarget(
			client,
			input?.cwd,
			credentials,
			reminder,
			deadline,
		);
		if (!eligible || performance.now() >= deadline) process.exit(0);
		let reviewRuntime;
		let reviewOptions;
		if (review && (reminder || capture || reviewOnly) && performance.now() < deadline - 700) {
			try {
				reviewRuntime = await import("./change-review.mjs");
			} catch {
				/* Review failure must not suppress memory. */
			}
			if (reviewRuntime)
				reviewOptions = {
					client,
					target: eligible,
					directory: reviewRuntime.changeReviewDirectory(memoryClientRoot()),
					home: homedir(),
					scope,
					expectedServer: "pharaoh",
				};
		}
		if (reviewOnly) {
			reviewCall(reviewRuntime, "observeReviewTool", input, reviewOptions);
			process.exit(0);
		}
		if (capture) {
			const { captureDirectory, deferCaptureForReview, recordToolEvent, stopDecision } =
				await import("./capture.mjs");
			const options = {
				client,
				target: eligible,
				directory: captureDirectory(memoryClientRoot()),
				memorySession: projectMemorySession(credentials),
				binding: conversationMemoryBinding(client, input.session_id),
			};
			const captureInput =
				reviewCall(reviewRuntime, "reviewTurnInput", input, reviewOptions) ?? input;
			if (event === "Stop") {
				const continuation = reviewCall(reviewRuntime, "reviewStop", input, reviewOptions);
				if (continuation?.decision === "block") {
					let memoryCue;
					try {
						memoryCue =
							captureEnabled && options.memorySession
								? deferCaptureForReview(captureInput, options)
								: undefined;
					} catch {
						/* An optional memory write cannot suppress review's continuation. */
					}
					result = {
						...continuation,
						reason: [continuation.reason, memoryCue].filter(Boolean).join("\n\n"),
					};
				} else {
					const receipt = reviewCall(reviewRuntime, "consumeReviewReceipt", input, reviewOptions);
					let saved;
					try {
						saved = captureEnabled
							? stopDecision(captureInput, { ...options, verifiedCheck: receipt?.finalCheck })
							: undefined;
					} catch {
						/* Keep a verified local receipt visible even if optional capture cannot write. */
					}
					const message = [receipt?.message, saved?.systemMessage].filter(Boolean).join("\n");
					result = message ? { ...(saved ?? {}), systemMessage: message } : saved;
				}
			} else if (captureEnabled) {
				const ask = recordToolEvent(captureInput, options);
				if (ask) result = { hookSpecificOutput: { hookEventName: event, additionalContext: ask } };
			}
		} else if ((reminder || diagnosticOnly) && choice?.diagnostics === true) {
			const { requestMemoryPolicy } = await import("./memory-api.mjs");
			const { collectDiagnosticEvent } = await import("./diagnostics-collector.mjs");
			const policy = await requestMemoryPolicy(eligible.repo, credentials, deadline, client);
			if (performance.now() < deadline)
				collectDiagnosticEvent(input, { client, target: eligible, credentials, policy, runtime });
		}
		if (diagnosticOnly) process.exit(0);
		const cue = {
			client,
			target: eligible,
			binding: projectMemorySession(credentials),
			stateDirectory: memoryClientRoot(),
		};
		if (reminder) {
			if (choice?.capture !== false) {
				// Automatic capture needs the turn's start to see edits no edit hook reports.
				const { beginTurn, captureDirectory } = await import("./capture.mjs");
				beginTurn(input, {
					client,
					target: eligible,
					directory: captureDirectory(memoryClientRoot()),
				});
			}
			if (skipMemoryPrompt(input.prompt)) process.exit(0);
			// The records that cite a file are fetched ahead of the first edit, for its memory cue.
			const { primeAnchoredMemory, retrievalLocked } = await import("./graph-cues.mjs");
			primeAnchoredMemory(eligible.repo, cue);
			// A plan that keeps memories without giving them back gets no reminder; capture ran above.
			if (!retrievalLocked(eligible.repo, cue))
				result = memoryReminder(eligible.repo, conversationMemoryBinding(client, input.session_id));
			// Establish the ordinary cue first; a bounded review failure leaves it intact.
			reviewCall(reviewRuntime, "beginReviewTurn", input, reviewOptions);
			if (captureEnabled && !input.prompt_id && !input.turn_id && reviewRuntime) {
				const { beginTurn, captureDirectory } = await import("./capture.mjs");
				beginTurn(reviewCall(reviewRuntime, "reviewTurnInput", input, reviewOptions) ?? input, {
					client,
					target: eligible,
					directory: captureDirectory(memoryClientRoot()),
				});
			}
		} else if (!capture) {
			const { memoryCue, worktreeCue } = await import("./graph-cues.mjs");
			const outputs = [
				structural ? worktreeCue(input, { ...cue, structuralSearch, deadline }) : undefined,
				memoryCue(input, cue),
			].flatMap((output) => output?.hookSpecificOutput.additionalContext ?? []);
			if (outputs.length)
				result = {
					hookSpecificOutput: { hookEventName: event, additionalContext: outputs.join("\n\n") },
				};
		}
	} else {
		result = handleEvent(input, {
			client,
			root,
			repo,
			credentials: await readMemoryCredentials(),
			deadline,
		});
	}
	if (result && performance.now() < deadline) process.stdout.write(JSON.stringify(result));
} catch {
	// An unavailable optional hook never blocks ordinary work.
} finally {
	clearTimeout(exitQuietly);
}
