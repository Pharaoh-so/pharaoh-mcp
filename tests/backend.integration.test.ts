/**
 * Integration tests for ProxyServer ↔ Backend — uses the MCP SDK's in-memory
 * transport to wire a real Client to a real Server within the same process.
 * The value is catching SDK-contract bugs that mocks wouldn't surface:
 * did we register the right request schema, does sendToolListChanged actually
 * traverse the transport, does the Backend swap take effect at the SDK level.
 *
 * What this file does NOT cover: SseProxyBackend's SSE wiring. That's tested
 * implicitly by the proxy.ts reconnect logic (preserved verbatim from
 * the old startProxy) and end-to-end in Session C's auth-flow-e2e suite.
 * Here we substitute a stub Backend so the test stays fast and deterministic.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	type CallToolResult,
	type ClientCapabilities,
	type Tool,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredBackend, type Backend } from "../src/backend.js";
import { loadBundledCatalog } from "../src/catalog.js";

// Stub openBrowser — this test uses a stub gateway so the real import is
// never called, but belt-and-suspenders against Stryker mutations that
// might execute unexpected code paths.
vi.mock("../src/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../src/auth.js")>("../src/auth.js");
	return { ...actual, openBrowser: vi.fn() };
});

import type { DeviceFlowGateway, ToolAuthResponse } from "../src/gateway.js";
import { TenantSuspendedError, TokenExpiredError } from "../src/proxy.js";
import { ProxyServer } from "../src/proxy-server.js";

/**
 * Gateway stub that returns a canned ToolAuthResponse on the first call and
 * null afterwards. Tracks call count for assertions. Kept inline instead of
 * pulling createGateway because the value here is exercising the Backend
 * contract, not the state machine (which gateway.integration.test.ts covers).
 */
function stubGateway(
	options: { authResponse?: ToolAuthResponse; authOnSecondCall?: boolean } = {},
) {
	const authResponse: ToolAuthResponse = options.authResponse ?? {
		content: [{ type: "text", text: "Pharaoh auth required — visit https://example/activate" }],
		isError: true,
		_meta: {
			auth_url: "https://example/activate?code=ABCD-EFGH",
			user_code: "ABCD-EFGH",
			expires_in_seconds: 300,
		},
	};
	let calls = 0;
	const gateway: DeviceFlowGateway = {
		async handleToolCall() {
			calls++;
			if (options.authOnSecondCall && calls >= 2) return null;
			return authResponse;
		},
		hasValidCredentials: () => false,
		getCredentials: () => null,
	};
	return { gateway, calls: () => calls, authResponse };
}

/** Backend stub that returns a configurable tool catalog and a canned result. */
class StubBackend implements Backend {
	readonly name = "sse" as const;
	constructor(
		private readonly tools: Tool[],
		private readonly result: CallToolResult,
	) {}
	async listTools(): Promise<Tool[]> {
		return this.tools;
	}
	async callTool(): Promise<CallToolResult> {
		return this.result;
	}
}

/** Wire a ProxyServer to an in-memory Client. Returns both for test assertions. */
async function wireClientAndServer(
	initial: Backend,
	capabilities: ClientCapabilities = {},
): Promise<{
	client: Client;
	proxy: ProxyServer;
	closeAll: () => Promise<void>;
}> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const proxy = new ProxyServer(initial);
	// biome-ignore lint/suspicious/noExplicitAny: InMemoryTransport doesn't match StdioServerTransport nominally but implements Transport
	await proxy.startWithTransport(serverTransport as any);
	const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities });
	await client.connect(clientTransport);
	return {
		client,
		proxy,
		closeAll: async () => {
			await client.close().catch(() => {});
			await proxy.stop().catch(() => {});
		},
	};
}

describe("ProxyServer with AuthRequiredBackend", () => {
	let harness: Awaited<ReturnType<typeof wireClientAndServer>>;
	let gatewayCalls: () => number;
	let canonicalAuth: ToolAuthResponse;

	beforeEach(async () => {
		const stub = stubGateway();
		gatewayCalls = stub.calls;
		canonicalAuth = stub.authResponse;
		const backend = new AuthRequiredBackend(stub.gateway);
		harness = await wireClientAndServer(backend);
	});

	afterEach(async () => {
		await harness.closeAll();
	});

	// Before sign-in the agent must already see the real tools (and Claude Code
	// must load the always-load ones). Breaks when the pre-auth catalog differs
	// from the bundled one.
	it("lists the bundled tool catalog before sign-in", async () => {
		const res = await harness.client.listTools();
		expect(res.tools).toEqual(loadBundledCatalog().tools);
	});

	// Resource reads must never start device auth or forward arbitrary URIs.
	it("serves only the bundled static Trace shell before and after sign-in", async () => {
		const uri = "ui://pharaoh/trace/v1.1.html";
		const listed = await harness.client.listResources();
		expect(listed.resources).toEqual([
			expect.objectContaining({ uri, mimeType: "text/html;profile=mcp-app" }),
		]);
		const shell = await harness.client.readResource({ uri });
		expect(shell.contents[0]).toMatchObject({
			uri,
			mimeType: "text/html;profile=mcp-app",
			text: readFileSync(join(import.meta.dirname, "../trace-app.html"), "utf8"),
			_meta: {
				ui: {
					csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
					permissions: {},
				},
			},
		});
		for (const rejected of ["file:///etc/passwd", "https://example.com/", `${uri}?repo=private`]) {
			await expect(harness.client.readResource({ uri: rejected })).rejects.toThrow(/resource/i);
		}
		expect(gatewayCalls()).toBe(0);
		await harness.proxy.setBackend(new StubBackend([], { content: [] }));
		expect(await harness.client.readResource({ uri })).toEqual(shell);
	});

	it("propagates the gateway auth response with _meta intact", async () => {
		const res = await harness.client.callTool({
			name: "get_codebase_map",
			arguments: { repo: "acme/example" },
		});
		expect(res.isError).toBe(true);
		// Content text is preserved verbatim.
		expect(res.content).toEqual(canonicalAuth.content);
		// _meta survives the SDK round-trip.
		const meta = (res as { _meta?: Record<string, unknown> })._meta;
		expect(meta).toBeDefined();
		expect(meta?.auth_url).toBe(canonicalAuth._meta.auth_url);
		expect(meta?.user_code).toBe(canonicalAuth._meta.user_code);
		expect(meta?.expires_in_seconds).toBe(canonicalAuth._meta.expires_in_seconds);
		expect(gatewayCalls()).toBe(1);
	});

	it("routes unknown tool names through the same gateway call", async () => {
		// The backend handles any tool call by delegating to the gateway, even
		// a name outside the catalog, so the agent's first call never hits
		// "tool not found".
		const res = await harness.client.callTool({ name: "search_functions", arguments: {} });
		expect(res.isError).toBe(true);
		expect(gatewayCalls()).toBe(1);
	});
});

describe("ProxyServer.setBackend swap", () => {
	it.each([
		new TokenExpiredError(),
		new TenantSuspendedError("Tenant suspended"),
	])("surfaces a typed warm capability failure %s to recovery", async (failure) => {
		class NegotiatingBackend extends StubBackend {
			withClientCapabilities(): Backend {
				return Object.assign(new StubBackend([], { content: [] }), {
					start: async () => {
						throw failure;
					},
				});
			}
		}
		const initial = new NegotiatingBackend([], { content: [] });
		const { client, proxy, closeAll } = await wireClientAndServer(initial, {
			extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
		});
		try {
			await Promise.all([
				expect(proxy.waitForLifetime()).rejects.toBe(failure),
				expect(client.listTools()).rejects.toThrow(failure.message),
			]);
			expect(proxy.getBackend()).toBe(initial);
			await proxy.setBackend(new AuthRequiredBackend(stubGateway().gateway));
			expect((await client.listTools()).tools).toEqual(loadBundledCatalog().tools);
		} finally {
			await closeAll();
		}
	});

	it("emits exactly one tools/list_changed notification per swap and serves the new catalog", async () => {
		const authStub = stubGateway();
		const initial = new AuthRequiredBackend(authStub.gateway);
		const { client, proxy, closeAll } = await wireClientAndServer(initial);

		let changeCount = 0;
		client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			changeCount++;
		});

		// Pre-swap: the bundled catalog from AuthRequiredBackend.
		const before = await client.listTools();
		expect(before.tools.map((t) => t.name)).toEqual(loadBundledCatalog().tools.map((t) => t.name));

		const newTools: Tool[] = [
			{ name: "get_codebase_map", description: "full", inputSchema: { type: "object" } },
			{ name: "search_functions", description: "full", inputSchema: { type: "object" } },
			{ name: "get_module_context", description: "full", inputSchema: { type: "object" } },
		];
		const swapped = new StubBackend(newTools, {
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});
		await proxy.setBackend(swapped);

		// Give the SDK a tick to deliver the notification — InMemoryTransport
		// resolves send() synchronously but notification dispatch queues on a
		// microtask, so listTools() below also acts as the synchronization point.
		const after = await client.listTools();
		expect(after.tools).toHaveLength(3);
		expect(after.tools.map((t) => t.name)).toEqual([
			"get_codebase_map",
			"search_functions",
			"get_module_context",
		]);

		// One swap, one notification — no diff logic, no de-dup.
		expect(changeCount).toBe(1);

		// Post-swap callTool hits the new backend, not the gateway.
		const callRes = await client.callTool({ name: "get_codebase_map", arguments: {} });
		expect(callRes.isError).toBe(false);
		expect(authStub.calls()).toBe(0); // gateway never saw this call

		await closeAll();
	});

	it("second swap fires another notification", async () => {
		// Guards against "fire-once-then-stop" regressions — the SDK can coalesce
		// notifications silently if the capability isn't declared correctly.
		const first = new AuthRequiredBackend(stubGateway().gateway);
		const { client, proxy, closeAll } = await wireClientAndServer(first);

		let changeCount = 0;
		client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			changeCount++;
		});

		const empty = new StubBackend([], {
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});
		await proxy.setBackend(empty);
		await client.listTools(); // sync point

		const nonEmpty = new StubBackend(
			[{ name: "x", description: "", inputSchema: { type: "object" } }],
			{ content: [{ type: "text", text: "ok" }], isError: false },
		);
		await proxy.setBackend(nonEmpty);
		await client.listTools(); // sync point

		expect(changeCount).toBe(2);

		await closeAll();
	});

	it("does not swap the active backend if next.start() rejects", async () => {
		// Regression test for H2 (PR review of #884): setBackend previously
		// assigned `this.backend = next` BEFORE awaiting `next.start()`. A
		// failing start left the proxy with a started-false backend while
		// handlers were already dispatching to it — list/call would throw
		// "before start()" until someone called setBackend again.
		const initialGateway = stubGateway();
		const initial = new AuthRequiredBackend(initialGateway.gateway);
		const { client, proxy, closeAll } = await wireClientAndServer(initial);

		class FailingStartBackend implements Backend {
			readonly name = "sse" as const;
			startCalls = 0;
			async listTools(): Promise<Tool[]> {
				throw new Error("should not be reachable — start() should have rejected");
			}
			async callTool(): Promise<CallToolResult> {
				throw new Error("should not be reachable — start() should have rejected");
			}
			async start(): Promise<void> {
				this.startCalls++;
				throw new Error("simulated SSE connect failure");
			}
		}
		const failing = new FailingStartBackend();

		await expect(proxy.setBackend(failing)).rejects.toThrow("simulated SSE connect failure");

		// The active backend must still be the original — the failing backend
		// was never installed. Verify by listing tools: the pre-auth catalog
		// should come back.
		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name)).toEqual(loadBundledCatalog().tools.map((t) => t.name));
		expect(proxy.getBackend()).toBe(initial);
		expect(failing.startCalls).toBe(1);

		// Stronger assertion: the session must still route end-to-end through
		// the old backend — not just listTools. Call a tool and verify we get
		// the auth-required shim response. Pre-fix, a failed swap could leave
		// the server wedged even though `this.backend` still pointed at prev.
		const res = await client.callTool({ name: "get_codebase_map", arguments: {} });
		expect(res.isError).toBe(true);

		await closeAll();
	});
});

// Session C regression: when onAuthorized throws, AuthRequiredBackend must
// NOT return the "authenticated" success shim — doing so leaves the proxy
// in a zombie state where every subsequent tool call hits AuthRequiredBackend,
// which re-enters the device flow, creating an endless reauth loop. See the
// PR review's critical finding.
describe("AuthRequiredBackend onAuthorized error handling", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let stderrChunks: string[];

	beforeEach(() => {
		stderrChunks = [];
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			return true;
		});
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	it("returns isError:true when onAuthorized rejects (generic error)", async () => {
		const { gateway } = stubGateway({ authOnSecondCall: true });
		const backend = new AuthRequiredBackend(gateway, async () => {
			throw new Error("simulated SSE swap failure");
		});
		const harness = await wireClientAndServer(backend);

		// First call: gateway returns the auth-required shim.
		const first = await harness.client.callTool({ name: "get_codebase_map", arguments: {} });
		expect(first.isError).toBe(true);

		// Second call: gateway returns null (creds materialized), onAuthorized
		// fires and throws. Pre-fix: isError:false with "authenticated" text.
		// Post-fix: isError:true so the agent sees the failure and can retry.
		const second = await harness.client.callTool({ name: "get_codebase_map", arguments: {} });
		expect(second.isError).toBe(true);
		const text = (second.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		expect(text).toMatch(/backend swap failed/);
		expect(text).toMatch(/simulated SSE swap failure/);
		// Stderr diagnostic is also emitted so operators see the error class.
		expect(stderrChunks.join("")).toMatch(/onAuthorized callback failed/);

		await harness.closeAll();
	});

	it("propagates TenantSuspendedError out of callTool (non-recoverable)", async () => {
		const { gateway } = stubGateway({ authOnSecondCall: true });
		const backend = new AuthRequiredBackend(gateway, async () => {
			throw new TenantSuspendedError("Tenant suspended by administrator");
		});
		const harness = await wireClientAndServer(backend);

		// First call primes the gateway so the next returns null.
		await harness.client.callTool({ name: "get_codebase_map", arguments: {} });

		// Second call: onAuthorized throws TenantSuspendedError. Unlike generic
		// errors (which become isError:true), suspension must rethrow so the
		// supervisor's waitForProxyLifetime catch handler can exit the process
		// cleanly. The SDK surfaces the throw as an MCP protocol-level error
		// (JSON-RPC code -32603) which the client rejects on. The important
		// property is that the backend did NOT silently swallow the error into
		// the "authenticated" success shim.
		await expect(
			harness.client.callTool({ name: "get_codebase_map", arguments: {} }),
		).rejects.toThrow(/Tenant suspended by administrator/);

		await harness.closeAll();
	});
});

// Breaks when proxy source uses an API newer than the Node versions the package
// declares: `import.meta.dirname` is undefined before Node 20.11, and the
// catalog loads on every start, so the proxy would crash on launch there.
describe("proxy source runs on every Node it declares", () => {
	it("uses no import.meta.dirname or import.meta.filename while engines allow Node 18", () => {
		const pkgDir = join(import.meta.dirname, "..");
		const engines = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")).engines.node;
		const srcDir = join(pkgDir, "src");
		const offenders = readdirSync(srcDir)
			.filter((f) => f.endsWith(".ts"))
			.filter((f) =>
				/import\.meta\.(dirname|filename)/.test(readFileSync(join(srcDir, f), "utf-8")),
			);

		expect(engines).toBe(">=18");
		expect(offenders).toEqual([]);
	});
});
