/** Native command hook: only bounded finite observations reach the private spool. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claimRuntimeDelivery, flushRuntimeQueue, recordRuntimeHook } from "./runtime-client.mjs";
import { runtimeUuid } from "./runtime-native.mjs";

const hookPath = fileURLToPath(import.meta.url);
const [client, mode, reference, marker] = process.argv.slice(2);
const HOOK_MARKER = "--pharaoh-runtime-v1";
try {
	if (mode === "--deliver" && runtimeUuid(reference))
		await flushRuntimeQueue(client, marker, { hookPath, generation: reference });
	else if (runtimeUuid(mode) && (marker === HOOK_MARKER || reference === HOOK_MARKER)) {
		const generation = mode;
		const deadline = setTimeout(() => process.exit(0), 2_400);
		try {
			let size = 0;
			const chunks = [];
			for await (const chunk of process.stdin) {
				size += chunk.length;
				if (size > 1_048_576) break;
				chunks.push(chunk);
			}
			if (size <= 1_048_576 && chunks.length) {
				recordRuntimeHook(client, JSON.parse(Buffer.concat(chunks).toString("utf8")), {
					hookPath,
					generation,
					selectionId: marker === HOOK_MARKER ? reference : undefined,
				});
				const delivery = claimRuntimeDelivery(client, { hookPath, generation });
				if (delivery) {
					const sender = spawn(
						process.execPath,
						[hookPath, client, "--deliver", generation, delivery],
						{
							detached: true,
							stdio: "ignore",
						},
					);
					sender.on("error", () => {
						/* The short delivery lease expires on launch failure. */
					});
					sender.unref();
				}
			}
		} finally {
			clearTimeout(deadline);
		}
	}
} catch {
	/* Optional observation never delays or blocks ordinary agent work. */
}
