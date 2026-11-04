import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleEvent } from "./hook-events.mjs";
import { readStdin } from "./local.mjs";
import {
	activeMemoryRuntime,
	readMemoryCredentials,
	resolveMemoryHookTarget,
} from "./user-target.mjs";

try {
	const [client, root, repo] = process.argv.slice(2);
	const input = await readStdin(1024 * 1024);
	let target = { root, repo };
	if (root === "--user") {
		const runtime = dirname(fileURLToPath(import.meta.url));
		if (!activeMemoryRuntime(client, runtime)) process.exit(0);
		const eligible = await resolveMemoryHookTarget(
			client,
			input?.cwd,
			await readMemoryCredentials(),
			input?.hook_event_name === "UserPromptSubmit" &&
				typeof input?.prompt === "string" &&
				Boolean(input.prompt.trim()),
		);
		if (!eligible) process.exit(0);
		target = { ...eligible, runtime };
	}
	const result = handleEvent(input, { client, ...target });
	if (result) process.stdout.write(JSON.stringify(result));
} catch {
	// Fail open. handleEvent reports state failures when the prompt is eligible.
}
