/**
 * Regression tests for SseProxyBackend's reconnect retry budget — specifically
 * that the loop attempts exactly BACKOFF_MS.length reconnects before giving up.
 *
 * H3 (PR review of #884): the original loop had two `attempt++` sites (one in
 * the try block after waitForClose, one in the catch block after a failed
 * reconnectAfter). A single failed reconnect consumed TWO slots of the retry
 * budget, so only ~3 of 5 attempts actually fired and the 4s and 16s delays
 * were skipped entirely. This test pins the correct attempt count so a future
 * refactor can't regress back to the double-count.
 *
 * Test strategy: mock `waitForClose` and `reconnectAfter` on the instance so
 * the loop logic runs in isolation from the MCP SDK, EventSource, and real
 * timers. We care about the attempt counter, not the network plumbing — the
 * full-stack behavior is covered by backend.integration.test.ts + Session C's
 * auth-flow-e2e suite.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_MS, SseProxyBackend } from "../src/backend.js";
import { TenantSuspendedError, TokenExpiredError } from "../src/proxy.js";

describe("SseProxyBackend reconnect retry budget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A transport that dies on an auth error leaves the loop through its catch,
	// and recovery swaps backends; the dead client must get no report meanwhile.
	// Breaks when the connected client is cleared only after a clean close.
	it("reports nothing on a client whose transport failed with an auth error", async () => {
		const backend = new SseProxyBackend("http://fake.local/sse", "fake-token");
		const notification = vi.fn().mockResolvedValue(undefined);
		const transport: { onclose?: () => void; onerror?: (e: Error) => void } = {};
		Object.assign(backend, {
			client: { notification },
			connectedClient: { notification },
			transport,
		});
		const closed = (backend as unknown as { waitForClose(): Promise<void> }).waitForClose();
		transport.onerror?.(Object.assign(new Error("Unauthorized"), { code: 401 }));
		await expect(closed).rejects.toBeInstanceOf(TokenExpiredError);
		backend.identifyClient({ client: { name: "claude-code" }, plugin: "absent" });
		expect(notification).not.toHaveBeenCalled();
	});

	it("calls reconnectAfter exactly BACKOFF_MS.length times before giving up", async () => {
		const backend = new SseProxyBackend("http://fake.local/sse", "fake-token");

		// waitForClose resolves immediately — simulates "connection dropped"
		// on every iteration. Without this the loop would block on a real
		// EventSource close event.
		vi.spyOn(
			backend as unknown as { waitForClose(): Promise<void> },
			"waitForClose",
		).mockResolvedValue(undefined);

		// Every reconnect attempt fails — the loop's exit condition becomes
		// "ran out of retry budget." Before the fix this bailed after ~3
		// calls; after the fix it bails after BACKOFF_MS.length.
		const reconnectSpy = vi
			.spyOn(backend as unknown as { reconnectAfter(n: number): Promise<void> }, "reconnectAfter")
			.mockRejectedValue(new Error("simulated reconnect failure"));

		// Silence stderr output the loop writes ("Pharaoh: connected", etc).
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await expect(
			(backend as unknown as { runReconnectLoop(): Promise<void> }).runReconnectLoop(),
		).rejects.toThrow(/simulated reconnect failure|maximum retries/);

		expect(reconnectSpy).toHaveBeenCalledTimes(BACKOFF_MS.length);
		// And the delays passed in are the full sequence — not skipping any.
		const attempts = reconnectSpy.mock.calls.map((c) => c[0]);
		expect(attempts).toEqual(Array.from({ length: BACKOFF_MS.length }, (_, i) => i + 1));
	});

	it("resets the retry budget after a successful reconnect", async () => {
		const backend = new SseProxyBackend("http://fake.local/sse", "fake-token");

		vi.spyOn(
			backend as unknown as { waitForClose(): Promise<void> },
			"waitForClose",
		).mockResolvedValue(undefined);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		// Script: fail once, succeed once (resets counter), fail all remaining
		// BACKOFF_MS.length times before giving up.
		let calls = 0;
		const reconnectSpy = vi
			.spyOn(backend as unknown as { reconnectAfter(n: number): Promise<void> }, "reconnectAfter")
			.mockImplementation(async () => {
				calls++;
				if (calls === 2) return; // Second call succeeds → attempt = 0
				throw new Error("simulated reconnect failure");
			});

		await expect(
			(backend as unknown as { runReconnectLoop(): Promise<void> }).runReconnectLoop(),
		).rejects.toThrow();

		// Expected call sequence of attempt numbers:
		//   1 (fail) → 2 (success, reset) → 1 (fail) → 2 (fail) → … → 5 (fail) → give up
		const attempts = reconnectSpy.mock.calls.map((c) => c[0]);
		expect(attempts).toEqual([1, 2, 1, 2, 3, 4, 5]);
	});

	it("does not reconnect a superseded backend after stop closes its transport", async () => {
		const backend = new SseProxyBackend("http://fake.local/sse", "fake-token");
		let close!: () => void;
		vi.spyOn(
			backend as unknown as { waitForClose(): Promise<void> },
			"waitForClose",
		).mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					close = resolve;
				}),
		);
		const reconnect = vi.spyOn(
			backend as unknown as { reconnectAfter(n: number): Promise<void> },
			"reconnectAfter",
		);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const loop = (backend as unknown as { runReconnectLoop(): Promise<void> }).runReconnectLoop();
		await backend.stop();
		close();
		await loop;
		expect(reconnect).not.toHaveBeenCalled();
	});

	it("does not reconnect if stopped during backoff", async () => {
		vi.useFakeTimers();
		try {
			const backend = new SseProxyBackend("http://fake.local/sse", "fake-token");
			const connect = vi
				.spyOn(backend as unknown as { connectOnce(): Promise<void> }, "connectOnce")
				.mockResolvedValue();
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const pending = (
				backend as unknown as { reconnectAfter(n: number): Promise<void> }
			).reconnectAfter(1);
			await backend.stop();
			await vi.runAllTimersAsync();
			await pending;
			expect(connect).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	// Session C regression: the merge resolution in runReconnectLoop combined
	// the no-double-increment fix (from #884 post-review) with a new call to
	// classifySSEError on the caught error. When connectOnce() inside
	// reconnectAfter rejects with a 401-coded error, the typed error must
	// propagate out of the loop so the session supervisor can swap backends —
	// NOT be treated as a transient reconnect failure that burns retry slots.
	it("propagates TokenExpiredError when reconnectAfter rejects with a 401-coded error", async () => {
		const backend = new SseProxyBackend("http://fake.local/sse", "fake-token");
		vi.spyOn(
			backend as unknown as { waitForClose(): Promise<void> },
			"waitForClose",
		).mockResolvedValue(undefined);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		// SseError-shaped rejection: the classifier keys off the `.code` property
		// first, so we mirror the SDK's actual error shape.
		const sseError = Object.assign(new Error("SSE error: 401 Unauthorized"), { code: 401 });
		const reconnectSpy = vi
			.spyOn(backend as unknown as { reconnectAfter(n: number): Promise<void> }, "reconnectAfter")
			.mockRejectedValue(sseError);

		await expect(
			(backend as unknown as { runReconnectLoop(): Promise<void> }).runReconnectLoop(),
		).rejects.toThrow(TokenExpiredError);

		// The key assertion: we bailed out on the FIRST reconnect attempt, not
		// after burning the whole retry budget. If classifySSEError were removed
		// from the catch block, this would instead run BACKOFF_MS.length times
		// and reject with the generic "maximum retries" error.
		expect(reconnectSpy).toHaveBeenCalledTimes(1);
	});

	// Same path, 403 shape — asserts tenant suspension escapes the retry loop
	// immediately rather than looping through all 5 slots.
	it("propagates TenantSuspendedError when reconnectAfter rejects with a 403-coded error", async () => {
		const backend = new SseProxyBackend("http://fake.local/sse", "fake-token");
		vi.spyOn(
			backend as unknown as { waitForClose(): Promise<void> },
			"waitForClose",
		).mockResolvedValue(undefined);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const sseError = Object.assign(new Error("tenant suspended"), { code: 403 });
		const reconnectSpy = vi
			.spyOn(backend as unknown as { reconnectAfter(n: number): Promise<void> }, "reconnectAfter")
			.mockRejectedValue(sseError);

		await expect(
			(backend as unknown as { runReconnectLoop(): Promise<void> }).runReconnectLoop(),
		).rejects.toThrow(TenantSuspendedError);
		expect(reconnectSpy).toHaveBeenCalledTimes(1);
	});
});
