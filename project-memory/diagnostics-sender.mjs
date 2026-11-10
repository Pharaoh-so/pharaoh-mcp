import { flushDiagnosticQueue, revokeDiagnosticConsent } from "./diagnostics-collector.mjs";

// Independent from the 2.4-second hook deadline; credentials never enter argv or logs.
const timeout = setTimeout(() => process.exit(0), 10_000);
try {
	if (process.argv[2] === "--anchored") {
		// The other detached job of the memory hooks: fetch the records that cite a file.
		const { refreshAnchoredMemory } = await import("./graph-cues.mjs");
		const { requestMemory } = await import("./memory-api.mjs");
		const { memoryClientRoot, projectMemorySession, readMemoryCredentials } = await import(
			"./user-target.mjs"
		);
		// requestMemory loads and refreshes the sign-in itself; the binding names whose list this is.
		const binding = projectMemorySession(await readMemoryCredentials());
		if (binding)
			await refreshAnchoredMemory(process.argv[3], {
				directory: memoryClientRoot(),
				binding,
				request: requestMemory,
			});
	} else if (process.argv[3] === "--revoke") await revokeDiagnosticConsent(process.argv[2]);
	else await flushDiagnosticQueue(process.argv[2]);
} catch {
	/* Retain bounded entries for the next native event. */
} finally {
	clearTimeout(timeout);
}
