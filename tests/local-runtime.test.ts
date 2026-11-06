import { describe, expect, it, vi } from "vitest";
import { createLocalAuthorization } from "../src/local/authorization.js";
import type { LocalDelivery } from "../src/local/contracts.js";
import { createLocalBlastRuntime } from "../src/local/runtime.js";
import { captureLocalSnapshot, type LocalSnapshot } from "../src/local/snapshot.js";
import { installedLocalAnalyzer, runLocalAnalyzer } from "../src/local/worker-host.js";

vi.mock("../src/local/authorization.js", async (original) => ({
	...(await original<typeof import("../src/local/authorization.js")>()),
	createLocalAuthorization: vi.fn(),
}));
vi.mock("../src/local/snapshot.js", () => ({ captureLocalSnapshot: vi.fn() }));
vi.mock("../src/local/worker-host.js", () => ({
	installedLocalAnalyzer: vi.fn(),
	runLocalAnalyzer: vi.fn(),
}));

function snapshot(caller: string): LocalSnapshot {
	return {
		sources: new Map([["src/saved.ts", Buffer.from(caller)]]),
		configFiles: new Map(),
		incomplete: false,
		fingerprint: caller,
		capturedAt: Date.now(),
	};
}

describe("saved-worktree delivery freshness", () => {
	it.each([1, 2])("handles %i saves while authorization is in flight", async (changes) => {
		const checkout = {
			repoSlug: "example/work",
			root: "/checkouts/work",
			worktreeId: "verified-1",
			device: "1",
			inode: "2",
		};
		const permit = { requestId: "request", permitId: "permit", expiresAt: Date.now() + 60_000 };
		let current = snapshot("callerBefore");
		let edits = 0;
		const confirm = vi.fn(async () => {
			await Promise.resolve();
			if (edits < changes) current = snapshot(`callerAfter${++edits}`);
		});
		const commit = vi.fn().mockResolvedValue(undefined);
		const abort = vi.fn().mockResolvedValue(undefined);
		vi.mocked(createLocalAuthorization).mockReturnValue({
			assertCurrentSignIn: vi.fn(),
			reserve: vi.fn().mockResolvedValue(permit),
			confirm,
			commit,
			abort,
		});
		vi.mocked(installedLocalAnalyzer).mockReturnValue({
			root: "/analyzer",
			entry: "worker",
			reader: "reader",
		});
		vi.mocked(captureLocalSnapshot).mockImplementation(async () => current);
		vi.mocked(runLocalAnalyzer).mockImplementation(async (_analyzer, captured) => ({
			status: "answered",
			coverage: "complete",
			depth: 1,
			targets: [],
			callers: [
				{ uid: "caller", name: captured.fingerprint, file: "src/saved.ts", module: "src", depth: 1 },
			],
		}));

		const runtime = createLocalBlastRuntime("https://mcp.example.com");
		if (!runtime) throw new Error("Missing staged local runtime");
		const onDelivery = vi.fn<(settle: LocalDelivery) => void>();
		const result = await runtime.answer(
			{
				kind: "local",
				checkout,
				query: { entity: "target", entityType: "function", depth: 1 },
			},
			new AbortController().signal,
			onDelivery,
		);
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(commit).not.toHaveBeenCalled();
		if (changes === 1) {
			expect(result.isError).toBeUndefined();
			expect(JSON.stringify(result.content)).toContain("callerAfter1");
			expect(JSON.stringify(result.content)).not.toContain("callerBefore");
			expect(onDelivery).toHaveBeenCalledTimes(1);
			expect(abort).not.toHaveBeenCalled();
			await onDelivery.mock.calls[0][0](true);
			expect(commit).toHaveBeenCalledWith(permit, "answered", expect.any(AbortSignal));
		} else {
			expect(result.isError).toBe(true);
			expect(result._meta?.errorCode).toBe("worktree_changed");
			expect(onDelivery).not.toHaveBeenCalled();
			expect(abort).toHaveBeenCalledWith(permit, "error");
		}
	});
});
