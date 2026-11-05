import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleEvent, memoryReminder, skipMemoryPrompt } from "./hook-events.mjs";
import { readStdin } from "./local.mjs";
import {
	activeMemoryRuntime,
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
	if (root === "--user") {
		const runtime = dirname(fileURLToPath(import.meta.url));
		if (!activeMemoryRuntime(client, runtime)) process.exit(0);
		if (input?.hook_event_name !== "UserPromptSubmit" || skipMemoryPrompt(input.prompt))
			process.exit(0);
		const eligible = await resolveMemoryHookTarget(
			client,
			input?.cwd,
			await readMemoryCredentials(),
			true,
			deadline,
		);
		if (eligible && performance.now() < deadline) result = memoryReminder(eligible.repo);
	} else {
		result = handleEvent(input, {
			client,
			root,
			repo,
			credentials: await readMemoryCredentials(),
			deadline,
		});
	}
	if (result) process.stdout.write(JSON.stringify(result));
} catch {
	// Project memory never blocks ordinary work or opens a continuation.
} finally {
	clearTimeout(exitQuietly);
}
