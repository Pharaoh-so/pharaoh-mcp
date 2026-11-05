import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleEvent, memoryReminder, skipMemoryPrompt } from "./hook-events.mjs";
import { readStdin } from "./local.mjs";
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
	if (root === "--user" || root === "--graph") {
		const reminder = root === "--user";
		const event = input?.hook_event_name;
		if (
			reminder
				? event !== "UserPromptSubmit" || skipMemoryPrompt(input.prompt)
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
		if (choice?.memory === false || (!reminder && choice?.graph === false)) process.exit(0);
		const credentials = await readMemoryCredentials();
		const eligible = await resolveMemoryHookTarget(
			client,
			input?.cwd,
			credentials,
			reminder,
			deadline,
		);
		if (!eligible || performance.now() >= deadline) process.exit(0);
		if (reminder) result = memoryReminder(eligible.repo);
		else {
			const { worktreeCue } = await import("./graph-cues.mjs");
			result = worktreeCue(input, {
				client,
				target: eligible,
				binding: projectMemorySession(credentials),
				stateDirectory: memoryClientRoot(),
				structuralSearch,
				deadline,
			});
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
