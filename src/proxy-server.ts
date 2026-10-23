/**
 * ProxyServer — owns the stdio MCP Server and delegates tool calls through a
 * mutable Backend reference. The whole point of this abstraction is that we
 * can swap the backend under a running server without restarting stdio, which
 * means Claude Code never has to reconnect.
 *
 * Two entry points cover the interesting startup shapes:
 *
 * - startInAuthRequiredMode: cold start, no (or expired-refresh) credentials.
 *   Spins up a gateway, wraps it in AuthRequiredBackend, starts the server.
 *   The caller supplies an `onAuthorized` callback that fires from inside the
 *   backend the moment device flow completes — the callback swaps ProxyServer
 *   over to an SseProxyBackend in place.
 *
 * - startInSseMode: happy path — valid credentials are already on disk. Starts
 *   the server directly with an SSE backend.
 *
 * Lifecycle:
 * - `waitForLifetime()` is the single awaitable the main loop blocks on. It
 *   resolves when Claude Code disconnects (stdio transport closed) and rejects
 *   with typed errors when the active backend hits a terminal failure. Backend
 *   swaps happen internally via callbacks; the main loop does NOT re-await.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	type ClientCapabilities,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	AuthRequiredBackend,
	type Backend,
	createSseBackend,
	type DownstreamClient,
} from "./backend.js";
import { loadBundledCatalog } from "./catalog.js";
import type { Credentials } from "./credentials.js";
import { createGateway, type DeviceFlowGateway } from "./gateway.js";
import { claudePluginState } from "./install-skills.js";
import { TenantSuspendedError, TokenExpiredError } from "./proxy.js";
import { registerTraceResource } from "./trace-resource.js";
import { getPackageVersion } from "./version.js";

/**
 * Stdio MCP server with a swappable backend. The Server instance is
 * long-lived across backend swaps; only the Backend reference moves.
 */
export class ProxyServer {
	private server: Server;
	private transport: StdioServerTransport | null = null;
	private backend: Backend;
	private started = false;
	private stopping = false;
	private clientCapabilities: ClientCapabilities = {};
	private clientInitialized = false;
	private downstream: DownstreamClient | null = null;
	private capabilityUpdate: Promise<void> = Promise.resolve();
	private transportClosed: Promise<void>;
	private transportClosedResolve!: () => void;

	constructor(initialBackend: Backend) {
		this.backend = initialBackend;
		this.server = new Server(
			{ name: "pharaoh-proxy", version: getPackageVersion() },
			{
				// tools.listChanged is required for sendToolListChanged() not
				// to throw; the SDK's assertNotificationCapability gates it.
				capabilities: { tools: { listChanged: true } },
				// Same instructions the remote server sends. initialize happens
				// before any backend is connected, so they come from the bundle.
				instructions: loadBundledCatalog().instructions,
			},
		);
		this.transportClosed = new Promise<void>((resolve) => {
			this.transportClosedResolve = resolve;
		});
		this.registerHandlers();
		registerTraceResource(this.server);
		this.server.oninitialized = () => {
			if (this.clientInitialized) return;
			this.clientInitialized = true;
			const info = this.server.getClientVersion();
			const downstream: DownstreamClient = {
				client: { name: info?.name, version: info?.version },
				plugin: claudePluginState(),
			};
			this.downstream = downstream;
			this.clientCapabilities = this.server.getClientCapabilities() ?? {};
			const next = this.backend.withClientCapabilities?.(this.clientCapabilities) ?? this.backend;
			// Only the backend that serves this client is told about it: a warm
			// session replaced below never takes a tool call. setBackend names the
			// client to its replacement once that has started.
			if (next === this.backend) {
				this.backend.identifyClient?.(downstream);
				return;
			}
			// Warm startup happens before the frontend initializes. Replace that
			// conservative connection only when real UI support is negotiated.
			this.capabilityUpdate = this.setBackend(next).catch((error) => {
				if (error instanceof TokenExpiredError || error instanceof TenantSuspendedError)
					throw error;
				// UI negotiation is optional: keep the already-started plain-text
				// backend healthy when its replacement hits a transient failure.
				this.backend.identifyClient?.(downstream);
				process.stderr.write(
					"Pharaoh: compact UI negotiation unavailable; continuing with text responses.\n",
				);
			});
			this.capabilityUpdate.catch(() => {
				// Tool handlers and waitForLifetime consume this error, including
				// typed auth failures that must reach the existing recovery loop.
			});
			this.backendSwappedSignal();
		};
	}

	/**
	 * Wire up list/call handlers. Each handler reads this.backend fresh at
	 * dispatch time — do NOT hoist the reference into a local, or setBackend()
	 * won't take effect for subsequent calls. This is the core property that
	 * makes mutable-backend swaps safe.
	 */
	private registerHandlers(): void {
		this.server.setRequestHandler(ListToolsRequestSchema, async () => {
			await this.capabilityUpdate;
			return { tools: await this.backend.listTools() };
		});
		this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
			await this.capabilityUpdate;
			const { name } = req.params;
			const args = req.params.arguments ?? {};
			const backend = this.backend;
			const result = await backend.callTool(name, args);
			// The call that completed sign-in swapped in the real backend — answer
			// it from there instead of asking the agent to call again.
			if (backend.name === "auth-required" && this.backend !== backend && !result.isError) {
				return (await this.backend.callTool(name, args)) as CallToolResult;
			}
			return result as CallToolResult;
		});
	}

	/**
	 * Start the backend (if it has a start hook) and connect stdio. Idempotent.
	 * Tests inject an alternate transport via startWithTransport().
	 */
	async start(): Promise<void> {
		if (this.started) return;
		if (this.backend.start) await this.backend.start();
		this.transport = new StdioServerTransport();
		await this.server.connect(this.transport);
		// Server.connect() wraps transport.onclose; use the Protocol-level hook
		// instead so we don't clobber the SDK's chain. Fires when the transport
		// closes cleanly (client disconnect) — not on error paths, which surface
		// through backend.waitForExit() and the server's own onerror plumbing.
		this.server.onclose = () => this.transportClosedResolve();
		this.started = true;
	}

	/**
	 * Test hook: start with a caller-supplied transport (e.g. InMemoryTransport).
	 * Kept separate from start() so the stdio wiring stays implicit in prod.
	 */
	async startWithTransport(transport: StdioServerTransport): Promise<void> {
		if (this.started) return;
		if (this.backend.start) await this.backend.start();
		this.transport = transport;
		// biome-ignore lint/suspicious/noExplicitAny: test transport is a Transport, but the type import chain is awkward here
		await this.server.connect(transport as any);
		this.server.onclose = () => this.transportClosedResolve();
		this.started = true;
	}

	/**
	 * Block until either (a) the stdio transport closes cleanly (Claude Code
	 * disconnected) or (b) the current backend's supervisor promise rejects
	 * with a terminal error. Returns when the transport closes. Throws when
	 * a backend's waitForExit rejects.
	 *
	 * Swap-aware: if setBackend() is called while waitForLifetime is blocked,
	 * the old backend's exit promise is abandoned and the new backend's is
	 * awaited. This matters for "SSE → auth-required → SSE2" flows where we
	 * want errors from SSE2 to bubble up, not the already-dead SSE1.
	 */
	async waitForLifetime(): Promise<void> {
		while (true) {
			const swapSignal = new Promise<"swap">((resolve) => {
				this.backendSwappedSignal = () => resolve("swap");
			});
			const backendExit = this.backend.waitForExit?.() ?? new Promise<void>(() => {});
			const outcome = await Promise.race<"swap" | "closed" | "exit">([
				this.transportClosed.then(() => "closed" as const),
				backendExit.then(() => "exit" as const),
				swapSignal,
				// A successful negotiation is not the end of the connection. Its
				// failure must still reach the supervisor if no tool is in flight.
				this.capabilityUpdate.then(() => new Promise<never>(() => {})),
			]);
			if (outcome === "swap") continue; // re-sample waitForExit against the new backend
			return; // "closed" or "exit" (the backend's waitForExit resolved cleanly)
		}
	}

	/**
	 * Used by setBackend to wake waitForLifetime so it can re-sample. Default
	 * no-op so a swap fired before waitForLifetime's first iteration (e.g. an
	 * onAuthorized that completes between proxy.start() and the first
	 * waitForLifetime call) doesn't crash. The missed wake is harmless — the
	 * next waitForLifetime iteration samples this.backend directly.
	 */
	private backendSwappedSignal: () => void = () => {};

	/**
	 * Swap the backend reference and fire a tools/list_changed notification so
	 * the client re-fetches. No in-flight tracking — the SDK routes each call
	 * to whichever backend is current at dispatch time.
	 */
	async setBackend(next: Backend): Promise<void> {
		next = next.withClientCapabilities?.(this.clientCapabilities) ?? next;
		const prev = this.backend;
		// Start the new backend BEFORE swapping the reference. If start() rejects
		// (e.g. SSE connect fails), `prev` stays active — otherwise the proxy
		// would be wedged with a not-yet-started backend that throws on every
		// list/call until the caller tried again. This ordering also closes the
		// race window where an in-flight request could arrive between the
		// reference swap and a slow SSE handshake.
		if (next.start) await next.start();
		if (this.stopping) {
			await next.stop?.();
			return;
		}
		this.backend = next;
		// Read the client after start: it may have initialized during the await.
		if (this.downstream) next.identifyClient?.(this.downstream);
		this.capabilityUpdate = Promise.resolve();
		// Fire the notification after the swap so a client that races a list
		// request against it sees the new catalog.
		await this.server.sendToolListChanged();
		// Wake any in-flight waitForLifetime so it re-samples the new backend's
		// waitForExit. Without this, SSE2 errors after a swap-back would be lost.
		this.backendSwappedSignal();
		// Fire-and-forget stop of the old backend. The swap has already happened
		// so stop failures can't break the running session — but log them so
		// resource leaks (file descriptors, keepalive timers, EventSource auto-
		// reconnect surviving a failed close) are visible.
		if (prev !== next && prev.stop) {
			prev.stop().catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`Pharaoh: previous backend stop() failed — ${msg}\n`);
			});
		}
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.backend.stop) {
			await this.backend.stop().catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`Pharaoh: backend stop() failed during shutdown — ${msg}\n`);
			});
		}
		if (this.transport) {
			await this.server.close().catch(() => {});
			this.transport = null;
		}
		this.started = false;
	}

	getBackend(): Backend {
		return this.backend;
	}
}

/**
 * Cold-start entry point. No credentials (or refresh-expired creds) — start
 * the proxy in auth-required mode so the stdio connection stays alive while
 * the user completes the device flow.
 *
 * The caller supplies `opts.onAuthorized`, which fires from inside the
 * AuthRequiredBackend the moment device flow completes. Typical implementation:
 * swap the ProxyServer over to an SseProxyBackend so the next tool call goes
 * to the real server. This keeps the proxy reference under the caller's
 * control — the backend never imports ProxyServer.
 */
export async function startInAuthRequiredMode(
	server: string,
	opts: { onAuthorized: (creds: Credentials) => Promise<void> },
): Promise<{ proxy: ProxyServer; gateway: DeviceFlowGateway }> {
	const gateway = createGateway({ server });
	const backend = new AuthRequiredBackend(gateway, async () => {
		// Pull fresh creds from the gateway (which just wrote them to disk) so
		// the callback doesn't race a separate disk read. The gateway is the
		// authoritative post-auth source.
		const creds = gateway.getCredentials();
		if (!creds) {
			// Should never happen — gateway.handleToolCall() only returns null
			// after persistAuthorizedToken sets lastCreds. Keep the guard so a
			// future refactor doesn't silently ship a swap-to-nothing bug.
			process.stderr.write("Pharaoh: authorized but no credentials available — skipping swap\n");
			return;
		}
		await opts.onAuthorized(creds);
	});
	const proxy = new ProxyServer(backend);
	await proxy.start();
	return { proxy, gateway };
}

/**
 * Happy-path entry point. Credentials are fresh — start directly with the
 * SSE backend. Returned proxy is running and ready for tool calls.
 */
export async function startInSseMode(creds: Credentials): Promise<ProxyServer> {
	const backend = createSseBackend(creds.sse_url, creds.access_token);
	const proxy = new ProxyServer(backend);
	await proxy.start();
	return proxy;
}
