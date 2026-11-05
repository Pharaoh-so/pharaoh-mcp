import { flushDiagnosticQueue, revokeDiagnosticConsent } from "./diagnostics-collector.mjs";
// Independent from the 2.4-second hook deadline; credentials never enter argv or logs.
const timeout = setTimeout(() => process.exit(0), 10_000);
try {
	if (process.argv[3] === "--revoke") await revokeDiagnosticConsent(process.argv[2]);
	else await flushDiagnosticQueue(process.argv[2]);
} catch {
	/* Retain bounded entries for the next native event. */
} finally {
	clearTimeout(timeout);
}
