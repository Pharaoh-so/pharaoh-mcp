import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleEvent, memoryReminder, skipMemoryPrompt } from "./hook-events.mjs";
import { conversationMemoryBinding, protectLocalShellAttempt, readStdin } from "./local.mjs";
import {
	activeMemoryRuntime,
	memoryClientRoot,
	projectMemorySession,
	readMemoryCredentials,
	resolveMemoryHookTarget,
} from "./user-target.mjs";

// Leave margin inside the client's three-second hook timeout. The process
// clock includes startup and imports, and no late network request can start.
const deadline = 2_400;
const exitQuietly = setTimeout(() => process.exit(0), Math.max(0, deadline - performance.now()));
try {
	const [client, root, repo] = process.argv.slice(2);
	const input = await readStdin(1024 * 1024);
	let result;
	if (root === "--user" || root === "--graph" || root === "--diagnostics") {
		const reminder = root === "--user";
		const diagnosticOnly = root === "--diagnostics";
		const event = input?.hook_event_name;
		if (
			reminder
				? event !== "UserPromptSubmit"
				: diagnosticOnly
					? !["PostToolUse", "Stop", "StopFailure", "Interrupt", "SessionEnd"].includes(event)
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
		if (!activeMemoryRuntime(client, runtime)) process.exit(0);
		const { readHookPreferences } = await import("./preferences.mjs");
		const choice = readHookPreferences()[client];
		if (
			choice?.memory === false ||
			(diagnosticOnly ? choice?.diagnostics !== true : !reminder && choice?.graph === false)
		)
			process.exit(0);
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
		if ((reminder || diagnosticOnly) && choice?.diagnostics === true) {
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
			if (skipMemoryPrompt(input.prompt)) process.exit(0);
			// Clients with edit cues get the records that cite a file fetched ahead of the first edit.
			if (choice?.graph === true)
				(await import("./graph-cues.mjs")).primeAnchoredMemory(eligible.repo, cue);
			result = memoryReminder(eligible.repo, conversationMemoryBinding(client, input.session_id));
		} else {
			const { memoryCue, worktreeCue } = await import("./graph-cues.mjs");
			const outputs = [
				worktreeCue(input, { ...cue, structuralSearch, deadline }),
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
	// Project memory never blocks ordinary work or opens a continuation.
} finally {
	clearTimeout(exitQuietly);
}
