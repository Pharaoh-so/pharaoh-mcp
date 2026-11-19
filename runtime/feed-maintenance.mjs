/** Bounded installed worker entry; trusted package code is the only module loaded. */
let input = "";
const timer = setTimeout(() => process.exit(0), 5_000);
const MAINTENANCE = new URL("../dist/native-feed-maintenance.js", import.meta.url);
try {
	for await (const chunk of process.stdin) {
		input += chunk.toString("utf8");
		if (Buffer.byteLength(input) > 16_384) process.exit(0);
	}
	const job = JSON.parse(input);
	const { runFeedMaintenance } = await import(MAINTENANCE.href);
	await runFeedMaintenance(job);
} catch {
	// A background preparation failure never prints repository or credential data.
} finally {
	clearTimeout(timer);
}
