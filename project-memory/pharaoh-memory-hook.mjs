import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleEvent } from "./hook-events.mjs";
import { checkout, readStdin } from "./local.mjs";
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
	const credentials = await readMemoryCredentials();
	let target = { root, repo };
	if (root === "--user") {
		const runtime = dirname(fileURLToPath(import.meta.url));
		if (!activeMemoryRuntime(client, runtime)) process.exit(0);
		const isPrompt = input?.hook_event_name === "UserPromptSubmit";
		const eligible = await resolveMemoryHookTarget(
			client,
			input?.cwd,
			credentials,
			isPrompt && typeof input?.prompt === "string" && Boolean(input.prompt.trim()),
			deadline,
		);
		// Cleanup must still close the turn after sign-out or loss of eligibility.
		const resolved = eligible ?? (!isPrompt && checkout(input?.cwd, deadline));
		if (!resolved) process.exit(0);
		target = { ...resolved, runtime };
	}
	const result = handleEvent(input, {
		client,
		...target,
		credentials,
		deadline,
	});
	if (result) process.stdout.write(JSON.stringify(result));
} catch {
	// Project memory never blocks ordinary work or opens a continuation.
} finally {
	clearTimeout(exitQuietly);
}
