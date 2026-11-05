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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type JSONRPCRequest, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKOFF_MS, SseProxyBackend } from "../src/backend.js";
import { TenantSuspendedError, TokenExpiredError } from "../src/proxy.js";

function disconnectedBackend() {
	const backend = new SseProxyBackend("http://fake.local/sse", "fake-token");
	const client = {
		listTools: vi.fn().mockResolvedValue({ tools: [] }),
		callTool: vi.fn().mockResolvedValue({ content: [] }),
		close: vi.fn().mockResolvedValue(undefined),
	};
	const attach = () => {
		Object.assign(backend, { client });
	};
	return { backend, client, attach };
}

describe("SseProxyBackend reconnect retry budget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	// A transport that dies on an auth error leaves the loop through its catch,
	// and recovery swaps backends; the dead client must get no report meanwhile.
	// Breaks when the connected client is cleared only after a clean close.
	it("reports nothing on a client whose transport failed with an auth error", async () => {
		const backend = new SseProxyBackend("http://fake.local/sse", "fake-token");
		const notification = vi.fn().mockResolvedValue(undefined);
		const client = { notification };
		const transport = {
			onclose: undefined as (() => void) | undefined,
			onerror: undefined as ((e: Error) => void) | undefined,
			close: vi.fn(async () => transport.onclose?.()),
		};
		Object.assign(backend, {
			client,
			connectedClient: client,
			transport,
		});
		const closed = (backend as unknown as { waitForClose(): Promise<void> }).waitForClose();
		transport.onerror?.(Object.assign(new Error("Unauthorized"), { code: 401 }));
		await expect(closed).rejects.toBeInstanceOf(TokenExpiredError);
		backend.identifyClient({ client: { name: "claude-code" }, plugin: "absent" });
		expect(notification).not.toHaveBeenCalled();
	});

	// A late reply to a canceled upstream request is a protocol diagnostic, not a dropped SSE stream.
	it("keeps a concurrent request connected after a canceled request receives a late reply", async () => {
		const [transport, peer] = InMemoryTransport.createLinkedPair();
		const calls: JSONRPCRequest[] = [];
		peer.onmessage = async (message) => {
			if (!("method" in message) || !("id" in message)) return;
			if (message.method === "initialize") {
				await peer.send({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fixture", version: "1" },
					},
				});
			} else if (message.method === "tools/call") calls.push(message);
		};
		const client = new Client({ name: "fixture", version: "1" });
		const backend = new SseProxyBackend("http://fake.local/sse", "fake-token");
		vi.spyOn(
			backend as unknown as { connectOnce(): Promise<void> },
			"connectOnce",
		).mockImplementation(async () => {
			Object.assign(backend, { client, connectedClient: client, transport });
		});
		const reconnect = vi
			.spyOn(backend as unknown as { reconnectAfter(n: number): Promise<void> }, "reconnectAfter")
			.mockRejectedValue(new Error("Unexpected reconnect"));
		try {
			await client.connect(transport);
			await backend.start();
			const controller = new AbortController();
			const canceled = expect(
				backend.callTool("pharaoh_memory_expand", {}, { signal: controller.signal }),
			).rejects.toThrow("user canceled");
			const concurrent = backend
				.callTool("get_codebase_map", {})
				.catch((error: unknown) => ({ error }));
			await expect.poll(() => calls.length).toBe(2);
			controller.abort(new Error("user canceled"));
			await canceled;
			await peer.send({ jsonrpc: "2.0", id: calls[0].id, result: { content: [] } });
			const result = { content: [{ type: "text", text: "still connected" }] };
			await peer.send({ jsonrpc: "2.0", id: calls[1].id, result });
			expect(await concurrent).toEqual(result);
			expect(reconnect).not.toHaveBeenCalled();
		} finally {
			await backend.stop();
			await peer.close();
		}
	});

	it("bounds a disconnected read to 15 seconds without dispatching it later", async () => {
		vi.useFakeTimers();
		const { backend, client, attach } = disconnectedBackend();
		attach();
		let settled = false;
		const failure = expect(
			backend.listTools().finally(() => {
				settled = true;
			}),
		).rejects.toThrow("still recovering");
		await vi.advanceTimersByTimeAsync(14_999);
		expect(settled).toBe(false);
		expect(client.listTools).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await failure;
		Object.assign(backend, { connectedClient: client });
		expect(await backend.listTools()).toEqual([]);
		expect(client.listTools).toHaveBeenCalledTimes(1);
	});

	it.each([
		"cancel",
		"stop",
	])("settles a waiting capture on %s without dispatch", async (action) => {
		const { backend, client, attach } = disconnectedBackend();
		attach();
		const controller = new AbortController();
		const failure = expect(
			backend.callTool("pharaoh_memory_capture", {}, { signal: controller.signal }),
		).rejects.toThrow(action === "cancel" ? "user canceled" : "connection stopped");
		if (action === "cancel") controller.abort(new Error("user canceled"));
		else await backend.stop();
		await failure;
		Object.assign(backend, { connectedClient: client });
		if (action === "cancel") expect(await backend.listTools()).toEqual([]);
		else await expect(backend.listTools()).rejects.toThrow("connection stopped");
		expect(client.callTool).not.toHaveBeenCalled();
	});

	it("calls reconnectAfter exactly BACKOFF_MS.length times before giving up", async () => {
		const { backend, client, attach } = disconnectedBackend();
		vi.spyOn(
			backend as unknown as { connectOnce(): Promise<void> },
			"connectOnce",
		).mockImplementation(async () => attach());

		const reconnectSpy = vi
			.spyOn(backend as unknown as { reconnectAfter(n: number): Promise<void> }, "reconnectAfter")
			.mockRejectedValue(new Error("simulated reconnect failure"));
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await backend.start();
		await Promise.all([
			expect(backend.waitForExit()).rejects.toThrow(/simulated reconnect failure|maximum retries/),
			expect(backend.listTools()).rejects.toThrow(/simulated reconnect failure|maximum retries/),
		]);
		expect(client.listTools).not.toHaveBeenCalled();
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

	// Typed auth failures must settle waiting requests and reach the supervisor
	// on the first attempt, leaving auth recovery to the existing backend swap.
	it.each([401, 403])("settles waiting calls with the typed %s recovery failure", async (code) => {
		const { backend, client, attach } = disconnectedBackend();
		vi.spyOn(
			backend as unknown as { connectOnce(): Promise<void> },
			"connectOnce",
		).mockImplementation(async () => attach());
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const reconnectSpy = vi
			.spyOn(backend as unknown as { reconnectAfter(n: number): Promise<void> }, "reconnectAfter")
			.mockRejectedValue(Object.assign(new Error("SSE authorization failed"), { code }));
		const typed = code === 401 ? TokenExpiredError : TenantSuspendedError;
		await backend.start();
		await Promise.all([
			expect(backend.waitForExit()).rejects.toBeInstanceOf(typed),
			expect(backend.callTool("pharaoh_memory_expand", {})).rejects.toBeInstanceOf(typed),
		]);
		expect(client.callTool).not.toHaveBeenCalled();
		expect(reconnectSpy).toHaveBeenCalledTimes(1);
	});
});
