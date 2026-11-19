/** Run every standalone proxy test, including its realistic auth/SSE integrations. */
import { defineConfig } from "vitest/config";

const nativeLatencyTests = "tests/native-feed-hook.test.ts";
const shared = { testTimeout: 30_000, hookTimeout: 30_000 };

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					...shared,
					name: "unit",
					include: ["tests/**/*.test.ts"],
					exclude: [nativeLatencyTests],
					sequence: { groupOrder: 0 },
				},
			},
			{
				test: {
					...shared,
					name: "native-feed-latency",
					include: [nativeLatencyTests],
					// Measure cold Node startup after other test workers finish.
					maxWorkers: 1,
					fileParallelism: false,
					sequence: { groupOrder: 1 },
				},
			},
		],
	},
});
