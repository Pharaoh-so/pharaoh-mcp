/** Run every standalone proxy test, including its realistic auth/SSE integrations. */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
