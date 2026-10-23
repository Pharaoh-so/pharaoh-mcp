/**
 * End-to-end integration test for the auth-required → SSE swap flow.
 *
 * Spawns the real proxy as a child process (via tsx so we can run from source
 * without a prior build) and drives it through three scenarios that together
 * prove the "session never disconnects" property:
 *
 *   1. Cold start with empty credentials → proxy serves shim catalog → mock
 *      server authorizes the device code → swap to SSE → next tool call goes
 *      through the real MCP client → success.
 *   2. Refresh-expired creds (refresh_expires_at in past) → identical flow,
 *      verifying that a dead refresh token short-circuits cleanly into the
 *      auth-required mode instead of a process exit.
 *   3. Mid-session swap-back (LOAD-BEARING): start with valid creds → first
 *      tool call succeeds over real SSE → force the next SSE connection to
 *      401 → proxy swaps to AuthRequiredBackend without killing stdio →
 *      simulate user authorization → proxy swaps back to SSE → tool call
 *      succeeds again. This is the one that proves the "Claude Code stays
 *      connected the whole time" guarantee.
 *
 * Every child_process.spawn sets PHARAOH_MCP_DISABLE_BROWSER=1 as a belt-and-
 * suspenders guard on top of gateway.ts's dependency-injection — child processes
 * bypass vi.mock entirely, so the env kill switch in auth.ts is what actually
 * prevents real browser tabs from opening. Zero browser tabs during the suite
 * is a contract, not an aspiration. See CLAUDE.md for the rationale.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
	CallToolRequestSchema,
	type ClientCapabilities,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Point at the package source via an absolute path so tsx can run index.ts
// directly, no prior build required. Using pathResolve so the test passes
// regardless of where vitest was invoked from.
const INDEX_PATH = pathResolve(__dirname, "..", "src", "index.ts");

/** A single ISO timestamp expiry helper for fixtures. */
function iso(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

/** Signed-in credentials for alice@acme, pointing the proxy at the mock server. */
function writeValidCredentials(homeDir: string, serverUrl: string): void {
	writeFileSync(
		join(homeDir, ".pharaoh", "credentials.json"),
		JSON.stringify({
			version: 2,
			access_token: "phat_initial",
			refresh_token: "phrt_initial",
			expires_at: iso(3600_000),
			refresh_expires_at: iso(180 * 86_400_000),
			expires_in: 3600,
			sse_url: `${serverUrl}/sse`,
			github_login: "alice",
			tenant_name: "acme",
			repos: [],
		}),
	);
}

// ── Mock Pharaoh server ────────────────────────────────────────────────────

/**
 * State knobs for the mock server. Each request handler reads these at call
 * time so tests can flip behavior between calls without rebuilding the server.
 */
interface MockState {
	/** If set, /device/token returns authorized with this token response. */
	authorizeOnPoll: boolean;
	/** If set, /device/token-refresh returns invalid_grant → action=reauth. */
	refreshInvalidGrant: boolean;
	/** If set, /device/token-refresh returns 200 with fresh tokens. */
	refreshSuccess: boolean;
	/** Fail the N-th SSE GET request with 401 (1-indexed). 0 = never fail. */
	failSseGetAttempt: number;
	failSseGetStatus: number;
	/** How many /sse GETs have been served so far. */
	sseGetCount: number;
	/** The access tokens we've issued, in order. */
	issuedAccessTokens: string[];
	/** Capabilities actually negotiated by each upstream MCP connection. */
	initializedCapabilities: ClientCapabilities[];
	/** Params of each notifications/pharaoh/client the proxy sent, in order. */
	clientReports: unknown[];
	/** The upstream session each of those reports arrived on. */
	clientReportSessions: string[];
	/** If set, the server rejects notifications/pharaoh/client with a 500. */
	failClientReport: boolean;
}

interface MockServer {
	url: string;
	state: MockState;
	close: () => Promise<void>;
	/** Current MCP server — reset between connections. */
	mcpSession: { server: McpServer; transport: SSEServerTransport } | null;
}

/**
 * Start a mock Pharaoh server that handles:
 *   POST /device                 → device code
 *   POST /device/token           → polling; authorized once state.authorizeOnPoll flips
 *   POST /device/token-refresh   → silent refresh grant
 *   GET  /sse                    → real MCP SSE transport
 *   POST /sse/messages           → MCP message POST
 */
async function startMockServer(): Promise<MockServer> {
	const state: MockState = {
		authorizeOnPoll: false,
		refreshInvalidGrant: false,
		refreshSuccess: false,
		failSseGetAttempt: 0,
		failSseGetStatus: 401,
		sseGetCount: 0,
		issuedAccessTokens: [],
		initializedCapabilities: [],
		clientReports: [],
		clientReportSessions: [],
		failClientReport: false,
	};

	const ctx: { mcpSession: MockServer["mcpSession"]; baseUrl: string } = {
		mcpSession: null,
		baseUrl: "",
	};

	const httpServer: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		// Read body for POST; needed for /device/token's POST-messages handling.
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", async () => {
			try {
				if (req.method === "POST" && url.pathname === "/device") {
					const deviceCode = `dev_code_${Date.now()}`;
					const userCode = "TEST-CODE";
					const payload = {
						device_code: deviceCode,
						user_code: userCode,
						verification_uri: `${ctx.baseUrl}/activate`,
						verification_uri_complete: `${ctx.baseUrl}/activate?code=${userCode}`,
						expires_in: 300,
						interval: 1,
					};
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify(payload));
					return;
				}

				if (req.method === "POST" && url.pathname === "/device/token") {
					if (state.authorizeOnPoll) {
						const accessToken = `phat_issued_${state.issuedAccessTokens.length + 1}`;
						state.issuedAccessTokens.push(accessToken);
						const payload = {
							access_token: accessToken,
							refresh_token: `phrt_issued_${state.issuedAccessTokens.length}`,
							token_type: "bearer",
							expires_in: 604_800,
							refresh_token_expires_in: 180 * 24 * 60 * 60,
							sse_url: `${ctx.baseUrl}/sse`,
							github_login: "alice",
							tenant_name: "acme",
							repos: ["acme/repo-1"],
						};
						res.statusCode = 200;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify(payload));
						return;
					}
					// Still pending
					res.statusCode = 400;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ error: "authorization_pending" }));
					return;
				}

				if (req.method === "POST" && url.pathname === "/device/token-refresh") {
					if (state.refreshInvalidGrant) {
						res.statusCode = 400;
						res.setHeader("Content-Type", "application/json");
						res.end(
							JSON.stringify({
								error: "invalid_grant",
								error_description: "refresh token rejected",
							}),
						);
						return;
					}
					if (state.refreshSuccess) {
						const accessToken = `phat_refreshed_${state.issuedAccessTokens.length + 1}`;
						state.issuedAccessTokens.push(accessToken);
						const payload = {
							access_token: accessToken,
							refresh_token: `phrt_refreshed_${state.issuedAccessTokens.length}`,
							expires_in: 604_800,
							refresh_token_expires_in: 180 * 24 * 60 * 60,
						};
						res.statusCode = 200;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify(payload));
						return;
					}
					res.statusCode = 500;
					res.end(JSON.stringify({ error: "refresh_not_configured" }));
					return;
				}

				if (req.method === "GET" && url.pathname === "/sse") {
					state.sseGetCount++;
					if (state.failSseGetAttempt > 0 && state.sseGetCount === state.failSseGetAttempt) {
						// Simulate token rejection — the proxy's classifier looks at
						// SseError.code === 401 to throw TokenExpiredError.
						res.statusCode = state.failSseGetStatus;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: "token_rejected" }));
						return;
					}
					// Real MCP SSE session. Build a small server that advertises a
					// single tool and returns a canned result.
					const mcp = new McpServer(
						{ name: "mock-pharaoh", version: "0.0.0" },
						{ capabilities: { tools: { listChanged: true } } },
					);
					mcp.oninitialized = () => {
						state.initializedCapabilities.push(mcp.getClientCapabilities() ?? {});
					};
					mcp.fallbackNotificationHandler = async (n) => {
						if (n.method !== "notifications/pharaoh/client") return;
						state.clientReports.push(n.params);
						state.clientReportSessions.push(transport.sessionId);
					};
					mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
						tools: [
							{
								name: "get_codebase_map",
								description: "mock real tool",
								inputSchema: { type: "object" },
								_meta: { "anthropic/alwaysLoad": true },
							},
						],
					}));
					mcp.setRequestHandler(CallToolRequestSchema, async (req2) => ({
						content: [
							{
								type: "text",
								text: `mock pharaoh: tool=${req2.params.name}`,
							},
						],
						isError: false,
						...(Array.isArray(
							mcp.getClientCapabilities()?.extensions?.["io.modelcontextprotocol/ui"]?.mimeTypes,
						) &&
						(
							mcp.getClientCapabilities()?.extensions?.["io.modelcontextprotocol/ui"]
								?.mimeTypes as string[]
						).includes("text/html;profile=mcp-app")
							? { _meta: { test_trace: { version: "1.1", label: "module" }, empty: false } }
							: {}),
					}));
					const transport = new SSEServerTransport("/sse/messages", res);
					ctx.mcpSession = { server: mcp, transport };
					await mcp.connect(transport);
					return;
				}

				if (req.method === "POST" && url.pathname.startsWith("/sse/messages")) {
					if (!ctx.mcpSession) {
						res.statusCode = 500;
						res.end("No active MCP session");
						return;
					}
					// Hand-parse the body JSON (we already drained the stream above)
					const message = JSON.parse(body);
					if (state.failClientReport && message.method === "notifications/pharaoh/client") {
						res.statusCode = 500;
						res.end("report rejected");
						return;
					}
					await ctx.mcpSession.transport.handlePostMessage(req, res, message);
					return;
				}

				res.statusCode = 404;
				res.end();
			} catch (err) {
				res.statusCode = 500;
				res.end(String(err));
			}
		});
	});

	return new Promise<MockServer>((resolve, reject) => {
		httpServer.listen(0, "127.0.0.1", () => {
			const addr = httpServer.address() as AddressInfo;
			ctx.baseUrl = `http://127.0.0.1:${addr.port}`;
			resolve({
				url: ctx.baseUrl,
				state,
				close: () =>
					new Promise<void>((r) => {
						ctx.mcpSession?.transport.close().catch(() => {});
						ctx.mcpSession = null;
						httpServer.close(() => r());
					}),
				get mcpSession() {
					return ctx.mcpSession;
				},
			});
		});
		httpServer.on("error", reject);
	});
}

// ── Proxy harness — spawn the real index.ts as a child process ─────────────

interface ProxyHarness {
	stdout: string[];
	stderr: string[];
	writeMessage(msg: unknown): void;
	/** Wait for a JSON-RPC response with the given id. */
	waitForResponse(id: number, timeoutMs?: number): Promise<Record<string, unknown>>;
	kill(): Promise<void>;
}

function spawnProxy(opts: { serverUrl: string; homeDir: string }): ProxyHarness {
	const require = createRequire(import.meta.url);
	const tsxCli = require.resolve("tsx/cli");
	const child: ChildProcess = spawn(
		process.execPath,
		[tsxCli, INDEX_PATH, "--server", opts.serverUrl],
		{
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				// Primary kill switch — the only guard that works for child
				// processes, since vi.mock can't intercept a separate module graph.
				PHARAOH_MCP_DISABLE_BROWSER: "1",
				BROWSER: "none",
				// Isolate credentials to the test's tempdir so we don't read or
				// write the developer's ~/.pharaoh/credentials.json.
				HOME: opts.homeDir,
				// Suppress skill-install chatter during tests — not load-bearing
				// for the flow, noisy in stderr.
				PHARAOH_DEBUG: "0",
			},
		},
	);

	const stdoutBuf: string[] = [];
	const stderrBuf: string[] = [];
	// Line buffer for JSON-RPC on stdout.
	let stdoutLineBuf = "";
	// Pending waiters indexed by response id.
	const pending = new Map<number, (msg: Record<string, unknown>) => void>();

	child.stdout?.setEncoding("utf-8");
	child.stdout?.on("data", (chunk: string) => {
		stdoutBuf.push(chunk);
		stdoutLineBuf += chunk;
		// Process complete lines.
		let idx = stdoutLineBuf.indexOf("\n");
		while (idx !== -1) {
			const line = stdoutLineBuf.slice(0, idx).trim();
			stdoutLineBuf = stdoutLineBuf.slice(idx + 1);
			if (line) {
				try {
					const parsed = JSON.parse(line) as Record<string, unknown>;
					if (typeof parsed.id === "number") {
						const waiter = pending.get(parsed.id);
						if (waiter) {
							pending.delete(parsed.id);
							waiter(parsed);
						}
					}
				} catch {
					// non-JSON lines are ignored; the proxy writes only valid JSON-RPC
				}
			}
			idx = stdoutLineBuf.indexOf("\n");
		}
	});
	child.stderr?.setEncoding("utf-8");
	child.stderr?.on("data", (chunk: string) => {
		stderrBuf.push(chunk);
	});

	function writeMessage(msg: unknown): void {
		child.stdin?.write(`${JSON.stringify(msg)}\n`);
	}

	function waitForResponse(id: number, timeoutMs = 10_000): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`timeout waiting for response id=${id}: stderr=${stderrBuf.join("")}`));
			}, timeoutMs);
			pending.set(id, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
		});
	}

	async function kill(): Promise<void> {
		if (child.exitCode === null && !child.killed) {
			child.kill("SIGTERM");
			await new Promise<void>((r) => {
				const t = setTimeout(() => {
					child.kill("SIGKILL");
					r();
				}, 1000);
				child.once("exit", () => {
					clearTimeout(t);
					r();
				});
			});
		}
	}

	return {
		stdout: stdoutBuf,
		stderr: stderrBuf,
		writeMessage,
		waitForResponse,
		kill,
	};
}

/**
 * Initialize the MCP session with the proxy (required before any tool call).
 * Returns the initialize result (serverInfo, capabilities, instructions).
 */
async function initializeProxy(
	harness: ProxyHarness,
	capabilities: ClientCapabilities = {},
	clientInfo = { name: "e2e-test", version: "0.0.0" },
): Promise<Record<string, unknown>> {
	harness.writeMessage({
		jsonrpc: "2.0",
		id: 0,
		method: "initialize",
		params: { protocolVersion: "2024-11-05", capabilities, clientInfo },
	});
	const res = await harness.waitForResponse(0);
	expect(res.result).toBeDefined();
	// initialized notification (fire and forget)
	harness.writeMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return res.result as Record<string, unknown>;
}

/** The instructions and tool catalog bundled into the package at build time. */
function bundledCatalog(): { instructions: string; tools: Array<Record<string, unknown>> } {
	return JSON.parse(readFileSync(pathResolve(__dirname, "..", "inspect-tools.json"), "utf-8"));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("auth-flow E2E", () => {
	let mockServer: MockServer;
	let homeDir: string;
	let harness: ProxyHarness | null;

	beforeEach(async () => {
		mockServer = await startMockServer();
		homeDir = mkdtempSync(join(tmpdir(), "pharaoh-e2e-"));
		// Ensure the ~/.pharaoh directory exists so the proxy's writeCredentials
		// doesn't race on mkdirSync-recursive timing.
		mkdirSync(join(homeDir, ".pharaoh"), { recursive: true, mode: 0o700 });
		harness = null;
	});

	afterEach(async () => {
		if (harness) await harness.kill();
		await mockServer.close();
		rmSync(homeDir, { recursive: true, force: true });
	});

	// Claude Code reads server instructions and the tool list once, at connect —
	// before the user has signed in. A proxy that answers with a stub teaches the
	// agent nothing about Pharaoh for the whole session (VISION.md § Every
	// connection path delivers the same instructions and tool metadata).
	// Breaks when: the proxy stops sending the bundled instructions, or the
	// pre-auth tool list differs from the real catalog (names, alwaysLoad _meta).
	it("scenario 0 — before sign-in the proxy already serves Pharaoh's instructions and tools", async () => {
		harness = spawnProxy({ serverUrl: mockServer.url, homeDir });
		const bundle = bundledCatalog();

		const init = await initializeProxy(harness);
		harness.writeMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		const list = (await harness.waitForResponse(1)).result as {
			tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
		};

		expect(init.instructions).toBe(bundle.instructions);
		expect(init.instructions).toContain("get_blast_radius");
		expect(list.tools.map((t) => t.name)).toEqual(bundle.tools.map((t) => t.name));
		const blast = list.tools.find((t) => t.name === "get_blast_radius");
		expect(blast?._meta?.["anthropic/alwaysLoad"]).toBe(true);
	}, 30_000);

	it("scenario 1 — cold start with no credentials swaps to SSE after authorization", async () => {
		// Start proxy with empty credentials. Should enter auth-required mode.
		harness = spawnProxy({ serverUrl: mockServer.url, homeDir });
		await initializeProxy(harness, {
			extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
		});

		// First tool call: proxy is in auth-required mode, returns the auth URL.
		harness.writeMessage({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const authResponse = await harness.waitForResponse(1);
		// Shape assertion: isError true, auth_url present in _meta.
		const result = authResponse.result as Record<string, unknown>;
		expect(result.isError).toBe(true);
		const meta = result._meta as Record<string, unknown>;
		expect(meta.auth_url).toContain("/activate?code=TEST-CODE");

		// Flip mock server to authorize on next poll.
		mockServer.state.authorizeOnPoll = true;

		// Gateway rate-limits polls by the server-specified interval (1s here).
		// Wait past the interval so the next tool call actually polls /device/token.
		await new Promise((r) => setTimeout(r, 1200));

		// Second tool call triggers the next poll; gateway sees "authorized",
		// onAuthorized callback fires → proxy.setBackend(SSE), and the proxy
		// answers this same call from the real server — no "call it again".
		harness.writeMessage({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const authorizedResponse = await harness.waitForResponse(2);
		const authorizedResult = authorizedResponse.result as Record<string, unknown>;
		expect(authorizedResult.isError).toBe(false);
		const authorizedContent = authorizedResult.content as Array<{ text: string }>;
		// Mock server's response text proves we're talking to it, not the shim.
		expect(authorizedContent[0].text).toContain("mock pharaoh: tool=get_codebase_map");
		expect(authorizedResult._meta).toEqual({
			test_trace: { version: "1.1", label: "module" },
			empty: false,
		});

		// The real server's tool metadata (alwaysLoad) reaches the client unchanged.
		harness.writeMessage({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
		const list = (await harness.waitForResponse(3)).result as {
			tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
		};
		expect(list.tools.find((t) => t.name === "get_codebase_map")?._meta).toEqual({
			"anthropic/alwaysLoad": true,
		});
		// The backend swapped in after sign-in names the client to its session.
		expect(mockServer.state.clientReports).toEqual([
			{ client: { name: "e2e-test", version: "0.0.0" }, plugin: "absent" },
		]);
	}, 30_000);

	// A warm proxy connects upstream before front initialization. It must not
	// claim UI support early, and must negotiate it before forwarding tool calls.
	it.each([
		true,
		false,
	])("negotiates warm UI support=%s, names its client upstream, and keeps both across reconnect", async (ui) => {
		// Pharaoh sees the proxy as pharaoh-proxy, so each upstream session that
		// serves the client (negotiated, then reconnected) hears which client the
		// proxy serves and whether Pharaoh's Claude Code plugin is enabled. Breaks
		// when a serving session misses that report, a replaced warm session gets
		// one, or the plugin state is misread.
		writeValidCredentials(homeDir, mockServer.url);
		mkdirSync(join(homeDir, ".claude"), { recursive: true });
		writeFileSync(
			join(homeDir, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "pharaoh@pharaoh": true } }),
		);
		const report = { client: { name: "claude-code", version: "2.1.3" }, plugin: "enabled" };
		harness = spawnProxy({ serverUrl: mockServer.url, homeDir });
		await initializeProxy(
			harness,
			{
				extensions: {
					"io.modelcontextprotocol/ui": {
						mimeTypes: [ui ? "text/html;profile=mcp-app" : "text/html"],
					},
					"not-forwarded": {},
				},
				sampling: {},
			},
			report.client,
		);
		// Duplicate initialized notifications must not fan out upstream sessions
		// while the first negotiated connection is still being established.
		harness.writeMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
		harness.writeMessage({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const result = (await harness.waitForResponse(1)).result as Record<string, unknown>;
		expect(result.content).toEqual([{ type: "text", text: "mock pharaoh: tool=get_codebase_map" }]);
		const negotiated = ui
			? {
					extensions: {
						"io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
					},
				}
			: {};
		const resultMeta = ui
			? { test_trace: { version: "1.1", label: "module" }, empty: false }
			: undefined;
		expect(result._meta).toEqual(resultMeta);
		expect(mockServer.state.initializedCapabilities).toEqual(ui ? [{}, negotiated] : [{}]);
		// Only the session that serves the client hears about it: the warm one a UI
		// swap replaces never takes a tool call, so reporting it would halve pickup.
		await expect.poll(() => mockServer.state.clientReports).toEqual([report]);

		await mockServer.mcpSession?.transport.close();
		await expect
			.poll(() => mockServer.state.initializedCapabilities.length, { timeout: 8000 })
			.toBe(ui ? 3 : 2);
		expect(mockServer.state.initializedCapabilities.at(-1)).toEqual(negotiated);
		await expect.poll(() => mockServer.state.clientReports).toEqual([report, report]);
		expect(new Set(mockServer.state.clientReportSessions).size).toBe(2);
		harness.writeMessage({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const reconnected = (await harness.waitForResponse(2)).result as Record<string, unknown>;
		expect(reconnected.content).toEqual(result.content);
		expect(reconnected._meta).toEqual(resultMeta);
	});

	it("scenario 2 — refresh-expired credentials trigger auth-required mode cleanly", async () => {
		// Seed creds with a refresh_expires_at in the past → loadAndRefresh
		// should short-circuit to action=reauth and the main loop should
		// enter auth-required mode without exiting.
		const deadCreds = {
			version: 2,
			access_token: "phat_dead",
			refresh_token: "phrt_dead",
			expires_at: iso(-3600_000),
			refresh_expires_at: iso(-3600_000),
			expires_in: 604_800,
			sse_url: `${mockServer.url}/sse`,
			github_login: "alice",
			tenant_name: "acme",
			repos: [],
		};
		writeFileSync(join(homeDir, ".pharaoh", "credentials.json"), JSON.stringify(deadCreds));

		harness = spawnProxy({ serverUrl: mockServer.url, homeDir });
		await initializeProxy(harness);

		harness.writeMessage({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const authResponse = await harness.waitForResponse(1);
		const result = authResponse.result as Record<string, unknown>;
		expect(result.isError).toBe(true);
		const meta = result._meta as Record<string, unknown>;
		expect(meta.auth_url).toContain("/activate?code=TEST-CODE");

		// Authorize and swap to SSE — same verification as scenario 1.
		mockServer.state.authorizeOnPoll = true;
		// Wait past the poll interval (1s) to avoid gateway rate-limiting.
		await new Promise((r) => setTimeout(r, 1200));
		harness.writeMessage({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const authorizedResponse = await harness.waitForResponse(2);
		expect((authorizedResponse.result as Record<string, unknown>).isError).toBe(false);

		harness.writeMessage({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const sseResponse = await harness.waitForResponse(3);
		const sseContent = (sseResponse.result as { content: Array<{ text: string }> }).content;
		expect(sseContent[0].text).toContain("mock pharaoh");
	}, 30_000);

	it("recovers a 401 during warm UI negotiation without disconnecting stdio", async () => {
		writeValidCredentials(homeDir, mockServer.url);
		mockServer.state.failSseGetAttempt = 2;
		mockServer.state.refreshInvalidGrant = true;
		harness = spawnProxy({ serverUrl: mockServer.url, homeDir });
		await initializeProxy(harness, {
			extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
		});
		await expect
			.poll(() => harness?.stderr.join(""), { timeout: 5000 })
			.toContain("re-authentication required");
		harness.writeMessage({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const result = (await harness.waitForResponse(1)).result as Record<string, unknown>;
		expect((result._meta as Record<string, unknown>).auth_url).toContain("/activate");
		expect(mockServer.state.sseGetCount).toBe(2);
	});

	it("keeps a healthy warm text backend when the optional UI connection fails", async () => {
		writeValidCredentials(homeDir, mockServer.url);
		mockServer.state.failSseGetAttempt = 2;
		mockServer.state.failSseGetStatus = 500;
		harness = spawnProxy({ serverUrl: mockServer.url, homeDir });
		await initializeProxy(harness, {
			extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
		});
		harness.writeMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		expect(((await harness.waitForResponse(1)).result as { tools: unknown[] }).tools).toHaveLength(
			1,
		);
		harness.writeMessage({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const result = (await harness.waitForResponse(2)).result as Record<string, unknown>;
		expect(result.content).toEqual([{ type: "text", text: "mock pharaoh: tool=get_codebase_map" }]);
		expect(result._meta).toBeUndefined();
		expect(harness.stderr.join("")).toContain("continuing with text responses");
		// Keep the process alive past EventSource's default retry delay: a failed
		// optional connection must be closed and repeated init must not retry it.
		harness.writeMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
		await new Promise((resolve) => setTimeout(resolve, 3300));
		expect(mockServer.state.sseGetCount).toBe(2);
		expect(mockServer.state.initializedCapabilities).toEqual([{}]);
		// The warm backend that keeps serving names the client after all.
		expect(mockServer.state.clientReports).toEqual([
			{ client: { name: "e2e-test", version: "0.0.0" }, plugin: "absent" },
		]);
	});

	// The SDK hands a failed POST to the transport's onerror, which reconnects,
	// and every new session would report (and fail) again. Breaks when the proxy
	// keeps reporting after the server rejected a report.
	it("costs one reconnect, not a loop, when the server rejects the client report", async () => {
		writeValidCredentials(homeDir, mockServer.url);
		mockServer.state.failClientReport = true;
		harness = spawnProxy({ serverUrl: mockServer.url, homeDir });
		await initializeProxy(harness);
		await new Promise((resolve) => setTimeout(resolve, 5000));
		expect(mockServer.state.sseGetCount).toBe(2);
		harness.writeMessage({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const result = (await harness.waitForResponse(1)).result as Record<string, unknown>;
		expect(result.content).toEqual([{ type: "text", text: "mock pharaoh: tool=get_codebase_map" }]);
	}, 30_000);

	it("scenario 3 — mid-session 401 swaps to auth-required and back to SSE without disconnecting", async () => {
		// Valid creds + mock server configured to 401 the NEXT SSE GET after
		// the initial successful connection.
		const validCreds = {
			version: 2,
			access_token: "phat_initial",
			refresh_token: "phrt_initial",
			expires_at: iso(3600_000),
			refresh_expires_at: iso(180 * 86_400_000),
			expires_in: 3600,
			sse_url: `${mockServer.url}/sse`,
			github_login: "alice",
			tenant_name: "acme",
			repos: ["acme/repo-1"],
		};
		writeFileSync(join(homeDir, ".pharaoh", "credentials.json"), JSON.stringify(validCreds));

		// Fail the THIRD SSE GET. First GET is the conservative warm connection;
		// the second negotiates UI after frontend initialization. We
		// then tear down the SSE session from the server side to trigger the
		// proxy's reconnect, which hits GET #3 and gets 401 → TokenExpiredError.
		// Also arm refresh to fail with invalid_grant so the proxy routes
		// through swapToAuthRequired (not silent refresh).
		mockServer.state.failSseGetAttempt = 3;
		mockServer.state.refreshInvalidGrant = true;

		harness = spawnProxy({ serverUrl: mockServer.url, homeDir });
		await initializeProxy(harness, {
			extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
		});

		// First call goes through real SSE.
		harness.writeMessage({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const sseOk = await harness.waitForResponse(1, 15_000);
		const sseOkContent = (sseOk.result as { content: Array<{ text: string }> }).content;
		expect(sseOkContent[0].text).toContain("mock pharaoh");
		expect((sseOk.result as Record<string, unknown>)._meta).toEqual({
			test_trace: { version: "1.1", label: "module" },
			empty: false,
		});

		// Force a reconnect by tearing down the server-side SSE session. The
		// proxy's SSE transport will see the stream end and try to reconnect,
		// which triggers GET #3 → 401 → TokenExpiredError → recoverFromTokenExpired.
		// With refreshInvalidGrant=true, recovery swaps to AuthRequiredBackend.
		await mockServer.mcpSession?.transport.close().catch(() => {});

		// Poll for swap: each tool call during the swap window either returns
		// the SSE error (connection lost) or the new auth-required response.
		// We retry up to ~5s to let the proxy's reconnect loop fire, hit 401,
		// swap backends, and the next tool call reach AuthRequiredBackend.
		let authPromptSeen = false;
		for (let attempt = 2; attempt <= 10; attempt++) {
			harness.writeMessage({
				jsonrpc: "2.0",
				id: attempt,
				method: "tools/call",
				params: { name: "get_codebase_map", arguments: {} },
			});
			const response = await harness.waitForResponse(attempt, 10_000);
			const r = response.result as Record<string, unknown> | undefined;
			const meta = r?._meta as Record<string, unknown> | undefined;
			if (meta && typeof meta.auth_url === "string" && meta.auth_url.includes("/activate")) {
				authPromptSeen = true;
				break;
			}
			// Still the old SSE backend during reconnect window — wait a beat.
			await new Promise((r2) => setTimeout(r2, 500));
		}
		if (!authPromptSeen) {
			// Fail loud with the proxy's stderr so the diagnostic surface is
			// the actual root cause (did the 401 fire? did the swap run?).
			throw new Error(`auth prompt never surfaced. proxy stderr:\n${harness.stderr.join("")}`);
		}
		expect(authPromptSeen).toBe(true);

		// Now authorize the device code — onAuthorized fires → swap back to
		// a new SSE backend. Also clear the 401 gate so SSE GETs succeed.
		mockServer.state.authorizeOnPoll = true;
		mockServer.state.failSseGetAttempt = 0;
		mockServer.state.refreshInvalidGrant = false;

		// Wait past the device-flow poll interval (1s) so the next tool call
		// actually polls /device/token instead of returning the cached
		// "authorization pending" response.
		await new Promise((r) => setTimeout(r, 1200));

		// Next tool call triggers the poll that returns authorized → swap, and
		// is answered by the new SSE backend.
		const postAuthId = 100;
		harness.writeMessage({
			jsonrpc: "2.0",
			id: postAuthId,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const swapResponse = await harness.waitForResponse(postAuthId, 10_000);
		const swapResult = swapResponse.result as Record<string, unknown>;
		expect(swapResult.isError).toBe(false);
		const swapContent = swapResult.content as Array<{ text: string }>;
		expect(swapContent[0].text).toContain("mock pharaoh: tool=get_codebase_map");

		// Tool call AFTER re-auth should now reach the mock SSE server again.
		const finalId = 101;
		harness.writeMessage({
			jsonrpc: "2.0",
			id: finalId,
			method: "tools/call",
			params: { name: "get_codebase_map", arguments: {} },
		});
		const finalResponse = await harness.waitForResponse(finalId, 10_000);
		const finalResult = finalResponse.result as Record<string, unknown>;
		const finalContent = finalResult.content as Array<{ text: string }>;
		expect(finalContent[0].text).toContain("mock pharaoh: tool=get_codebase_map");
		expect(finalResult._meta).toEqual({
			test_trace: { version: "1.1", label: "module" },
			empty: false,
		});
		// Sanity: we never exited. The harness child is still alive.
	}, 60_000);
});
