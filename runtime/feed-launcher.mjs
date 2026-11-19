/** Start bounded feed maintenance separately from identity lookup and synchronous context delivery. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFeedRoot, feedHash, feedLock, readFeedJSON, writeFeedJSON } from "./feed-io.mjs";

/** Schedule at most one maintenance job per cohort every five seconds; never wait for it. */
export function launchFeedMaintenance(job, now = Date.now()) {
	try {
		const root = ensureFeedRoot(job);
		const name = `maintenance-${feedHash(job.cohort)}.json`;
		return (
			feedLock(
				root,
				() => {
					const prior = readFeedJSON(join(root, name), 1024);
					if (prior && now - prior.startedAt < 5000) return false;
					writeFeedJSON(root, name, { startedAt: now }, 1024);
					const child = spawn(
						process.execPath,
						[fileURLToPath(new URL("./feed-maintenance.mjs", import.meta.url))],
						{
							cwd: root,
							detached: true,
							stdio: ["pipe", "ignore", "ignore"],
							env: {
								PATH: process.env.PATH ?? "",
								HOME: process.env.HOME ?? "",
								SYSTEMROOT: process.env.SYSTEMROOT ?? "",
							},
						},
					);
					child.on("error", () => {});
					child.stdin.on("error", () => {});
					child.stdin.end(JSON.stringify(job));
					child.unref();
					return true;
				},
				"maintenance.lock",
				now,
			) ?? false
		);
	} catch {
		return false;
	}
}
