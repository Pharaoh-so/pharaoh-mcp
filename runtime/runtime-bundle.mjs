/** Pin the standalone native hook closure outside npm's disposable cache. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installMemoryBundle } from "../project-memory/bundle.mjs";
import { ensureRuntimeRoot } from "./runtime-storage.mjs";

const FILES = [
	"runtime-hook.mjs",
	"runtime-client.mjs",
	"runtime-contract.mjs",
	"runtime-hooks.mjs",
	"runtime-native.mjs",
	"runtime-metadata.mjs",
	"runtime-storage.mjs",
	"update-notice.mjs",
];

/** Install the content-addressed, owner-private observer and return its executable path. */
export function installRuntimeBundle(home, packageRoot = new URL("../", import.meta.url)) {
	const files = FILES.map((name) => [
		name,
		readFileSync(new URL(`runtime/${name}`, packageRoot)).toString("base64"),
	]);
	const serialized = JSON.stringify(files);
	if (Buffer.byteLength(serialized) > 262_144)
		throw new Error("Runtime observer bundle is oversized.");
	const sha256 = createHash("sha256").update(serialized).digest("hex");
	return join(
		installMemoryBundle(join(ensureRuntimeRoot(home), "bundles"), null, { files, sha256 }),
		"runtime-hook.mjs",
	);
}
