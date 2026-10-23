/**
 * Backend interface — the abstraction the ProxyServer delegates tool calls to.
 *
 * Two concrete implementations:
 *
 * 1. AuthRequiredBackend — advertises the real tool catalog (bundled at build
 *    time, see catalog.ts) and turns every invocation into a device-flow state
 *    step. Used while the proxy is waiting for the user to authorize.
 *
 * 2. SseProxyBackend (returned by createSseBackend) — wraps an MCP Client
 *    connected to the remote Pharaoh SSE server. Forwards list/call requests
 *    verbatim and preserves the ghost-session reconnect fix from proxy.ts.
 *
 * ProxyServer swaps between the two by reassigning a reference. The SDK
 * resolves each tool call's handler at request-arrival time, so in-flight
 * calls complete against whichever backend started them.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { CallToolResult, ClientCapabilities, Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadBundledCatalog } from "./catalog.js";
import type { DeviceFlowGateway } from "./gateway.js";
import { classifySSEError, TenantSuspendedError, TokenExpiredError } from "./proxy.js";
import { TRACE_MIME_TYPE } from "./trace-resource.js";
import { getPackageVersion } from "./version.js";

/**
 * Notification that tells Pharaoh which client the proxy serves. Pharaoh sees
 * the proxy itself as `pharaoh-proxy`; this lands on the session's row.
 * Mirrors PROXY_CLIENT_NOTIFICATION in src/mcp/server.ts.
 */
export const CLIENT_NOTIFICATION = "notifications/pharaoh/client";

/** What the proxy reports about the client behind it. */
export type DownstreamClient = {
	/** The client's own `initialize` clientInfo (e.g. claude-code 2.1.3). */
	client: { name?: string; version?: string };
	/** Pharaoh's Claude Code plugin as ~/.claude/settings.json lists it. */
	plugin: "enabled" | "disabled" | "absent";
};

/** The contract ProxyServer uses to delegate tool handling. */
export interface Backend {
	readonly name: "auth-required" | "sse";
	listTools(): Promise<Tool[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
	/** Optional one-time startup (e.g. connect SSE). Idempotent. */
	start?(): Promise<void>;
	/** Optional teardown (e.g. close SSE). Idempotent. */
	stop?(): Promise<void>;
	/**
	 * Optional long-running promise that completes on clean exit or rejects with
	 * a typed error (TokenExpiredError, TenantSuspendedError) the main loop can
	 * act on. Backends without a supervisor loop (AuthRequiredBackend) omit this.
	 */
	waitForExit?(): Promise<void>;
	/** Return an unstarted replacement only if the negotiated UI support changed. */
	withClientCapabilities?(capabilities: ClientCapabilities): Backend;
	/** Report the client behind the proxy to every upstream session, reconnects included. */
	identifyClient?(downstream: DownstreamClient): void;
}

/**
 * Pre-auth backend. Every tool call triggers a device-flow state step via the
 * gateway; returns a structured auth-required response. Once the gateway
 * reports the user has authorized (handleToolCall returns null), this backend
 * invokes the onAuthorized callback so the caller (index.ts main loop) can
 * swap the ProxyServer over to an SseProxyBackend. The backend itself does NOT
 * swap — callbacks keep the ownership of the proxy reference in one place.
 */
export class AuthRequiredBackend implements Backend {
	readonly name = "auth-required" as const;
	constructor(
		private readonly gateway: DeviceFlowGateway,
		private readonly onAuthorized?: () => Promise<void>,
	) {}

	/**
	 * The real catalog (bundled at build time), so the agent learns every tool
	 * — and Claude Code loads the always-load ones — before sign-in. Each call
	 * returns the sign-in steps until the user authorizes.
	 */
	async listTools(): Promise<Tool[]> {
		return loadBundledCatalog().tools;
	}

	async callTool(_name: string, _args: Record<string, unknown>): Promise<CallToolResult> {
		const response = await this.gateway.handleToolCall();
		if (response === null) {
			// Credentials just became valid. Fire the authorization callback
			// BEFORE returning success so the caller's backend swap is in place
			// by the time the next tool call arrives.
			if (this.onAuthorized) {
				try {
					await this.onAuthorized();
				} catch (err) {
					// TenantSuspendedError from the post-auth SSE handshake means
					// the tenant was suspended between authorize and swap. Rethrow
					// so the supervisor exits cleanly instead of looping in
					// auth-required mode forever.
					if (err instanceof TenantSuspendedError) throw err;
					// Any other swap failure (SSE start rejected, gateway returned
					// no creds, network blip) must surface as an error to the
					// agent. Returning success would leave the proxy in a zombie
					// state — this backend still active, onAuthorized already
					// fired, every subsequent tool call burning a fresh device
					// flow cycle. isError:true lets the agent see the failure and
					// retry the tool call, which will re-enter the gateway's post-
					// auth branch and attempt the swap again.
					const msg = err instanceof Error ? err.message : String(err);
					process.stderr.write(`Pharaoh: onAuthorized callback failed — ${msg}\n`);
					return {
						content: [
							{
								type: "text",
								text: `Pharaoh: authenticated but backend swap failed — ${msg}. Retry the tool call.`,
							},
						],
						isError: true,
					};
				}
			}
			return {
				content: [
					{
						type: "text",
						// ProxyServer re-runs the call on the new backend; this text
						// only reaches the agent if no backend swap happened.
						text: "Pharaoh: authenticated. Call the tool again.",
					},
				],
				isError: false,
			};
		}
		// The gateway response shape is CallToolResult-compatible (content,
		// isError, _meta) — the MCP SDK accepts it verbatim.
		return response as unknown as CallToolResult;
	}
}

/** Backoff schedule for reconnect attempts (milliseconds). Exported for tests. */
export const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000];

/**
 * Build the SSEClientTransport with Bearer token auth. Injects the
 * Authorization header into both the SSE connection (via custom fetch) and
 * POST requests (via requestInit).
 */
function createSSETransport(sseUrl: string, token: string): SSEClientTransport {
	const authHeader = `Bearer ${token}`;
	return new SSEClientTransport(new URL(sseUrl), {
		eventSourceInit: {
			fetch: (url, init) => {
				const h = new Headers(init.headers as HeadersInit);
				h.set("Authorization", authHeader);
				return fetch(url, { ...init, headers: h } as RequestInit);
			},
		},
		requestInit: {
			headers: { Authorization: authHeader },
		},
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real SSE-backed backend. Owns an MCP Client + SSEClientTransport and a
 * reconnect loop. Forwards listTools/callTool to the remote server.
 *
 * Reconnect semantics (preserved verbatim from the old startProxy):
 *   EventSource's built-in auto-reconnect creates ghost sessions on the
 *   server (new auth, new session ID per 3s reconnect). On any non-fatal
 *   error we explicitly close() the transport to kill EventSource, then
 *   let this loop create a fresh transport for the next attempt. 5 retries
 *   (2s, 4s, 8s, 16s, 32s) before giving up.
 */
export class SseProxyBackend implements Backend {
	readonly name = "sse" as const;
	private client: Client | null = null;
	private transport: SSEClientTransport | null = null;
	private stopped = false;
	private reconnectPromise: Promise<void> | null = null;
	private readonly clientCapabilities: ClientCapabilities;
	private downstream: DownstreamClient | null = null;
	/** The client whose `connect` has finished; null while connecting or after its transport closed. */
	private connectedClient: Client | null = null;
	/** Set once a report fails; see reportClient. */
	private reportsOff = false;

	constructor(
		private readonly sseUrl: string,
		private readonly token: string,
		capabilities: ClientCapabilities = {},
	) {
		// The proxy can deliver only this static UI extension. Advertising other
		// capabilities (sampling, elicitation, etc.) would promise unsupported RPCs.
		const ui = capabilities.extensions?.["io.modelcontextprotocol/ui"] as
			| { mimeTypes?: unknown }
			| undefined;
		this.clientCapabilities =
			Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(TRACE_MIME_TYPE)
				? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [TRACE_MIME_TYPE] } } }
				: {};
	}

	identifyClient(downstream: DownstreamClient): void {
		this.downstream = downstream;
		void this.reportClient();
	}

	/**
	 * Tell the connected session which client the proxy serves. Never awaited.
	 * The SDK also hands a failed POST to the transport's onerror, which
	 * reconnects, so after one failure this backend stops reporting: a server
	 * that rejects reports costs one reconnect, not a loop.
	 */
	private async reportClient(): Promise<void> {
		const client = this.connectedClient;
		if (!client || !this.downstream || this.reportsOff) return;
		await client
			.notification({ method: CLIENT_NOTIFICATION, params: this.downstream })
			.catch((error: unknown) => {
				// ALLOWED-CATCH: telemetry; reportsOff bounds the reconnect a failed POST triggers
				this.reportsOff = true;
				const msg = error instanceof Error ? error.message : String(error);
				process.stderr.write(`Pharaoh: client report not sent, not retrying (${msg})\n`);
			});
	}

	withClientCapabilities(capabilities: ClientCapabilities): Backend {
		const next = new SseProxyBackend(this.sseUrl, this.token, capabilities);
		return JSON.stringify(next.clientCapabilities) === JSON.stringify(this.clientCapabilities)
			? this
			: next;
	}

	async start(): Promise<void> {
		if (this.client) return; // idempotent
		await this.connectOnce();
		// Keep the reconnect loop alive in the background. It resolves when
		// the SSE stream closes cleanly; on typed errors (401/403) it throws.
		this.reconnectPromise = this.runReconnectLoop();
		// Surface typed errors at the top level so the CLI (or future
		// supervisor) can act on them.
		this.reconnectPromise.catch(() => {
			/* error is retrieved via waitForExit() when needed */
		});
	}

	/**
	 * Expose the long-running reconnect loop so a supervisor can await it.
	 * Session C uses this to bubble TokenExpiredError / TenantSuspendedError
	 * up to the same handler that used to wrap `startProxy`.
	 */
	waitForExit(): Promise<void> {
		return this.reconnectPromise ?? Promise.resolve();
	}

	private async connectOnce(): Promise<void> {
		const transport = createSSETransport(this.sseUrl, this.token);
		const client = new Client(
			{ name: "pharaoh-proxy", version: getPackageVersion() },
			{ capabilities: this.clientCapabilities },
		);
		this.transport = transport;
		this.client = client;
		try {
			await client.connect(transport);
		} catch (error) {
			// A failed warm capability handshake must not leave EventSource's
			// automatic retries alive beside the previous backend.
			await client.close().catch(() => {
				process.stderr.write("Pharaoh: failed SSE connection cleanup\n");
			});
			if (this.transport === transport) this.transport = null;
			if (this.client === client) this.client = null;
			// Initial and negotiated connects need the same typed auth recovery
			// as reconnects. Generic failures still surface to the caller.
			if (error instanceof Error) classifySSEError(error);
			throw error;
		}
		// A stop or a newer connect while this one was in flight owns the backend now.
		if (this.stopped || this.client !== client) return;
		this.connectedClient = client;
		// Every new upstream session (reconnects too) hears which client this is,
		// without holding up startup or reconnect supervision.
		void this.reportClient();
	}

	/** Wait for the current transport to close, then decide what to do. */
	private waitForClose(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (!this.transport) {
				resolve();
				return;
			}
			const sse = this.transport;
			// The client is gone the moment its transport closes or errors,
			// whichever way the loop then leaves (backoff or typed recovery).
			sse.onclose = () => {
				this.connectedClient = null;
				resolve();
			};
			sse.onerror = (err) => {
				this.connectedClient = null;
				try {
					classifySSEError(err);
				} catch (typed) {
					reject(typed);
					return;
				}
				// Non-fatal — explicitly close the transport to kill
				// EventSource's built-in auto-reconnect. Without this,
				// EventSource reconnects every ~3s, creating ghost sessions
				// on the server (100+ auth successes, zero tool calls
				// completing). close() fires onclose which resolves this
				// promise, handing control back to the backoff loop.
				sse.close().catch(() => {});
			};
		});
	}

	private async reconnectAfter(attempt: number): Promise<void> {
		const delay = BACKOFF_MS[attempt - 1];
		process.stderr.write(
			`Pharaoh: reconnecting in ${delay / 1000}s (attempt ${attempt}/${BACKOFF_MS.length})...\n`,
		);
		await sleep(delay);
		if (this.stopped) return;
		await this.connectOnce();
		process.stderr.write("Pharaoh: reconnected\n");
	}

	private async runReconnectLoop(): Promise<void> {
		process.stderr.write("Pharaoh: connected\n");
		let attempt = 0;
		while (!this.stopped) {
			try {
				await this.waitForClose();
				if (this.stopped) return;
				attempt++;
				if (attempt > BACKOFF_MS.length) {
					process.stderr.write("Pharaoh: max reconnect attempts reached — exiting\n");
					throw new Error("SSE connection failed after maximum retries");
				}
				await this.reconnectAfter(attempt);
				attempt = 0;
			} catch (err) {
				if (err instanceof TokenExpiredError || err instanceof TenantSuspendedError) {
					throw err;
				}
				// connectOnce() inside reconnectAfter() can throw an SseError with
				// code === 401 / 403 when the stored token is rejected on
				// reconnect (the common mid-session token-expiry shape). Run it
				// through classifySSEError — that helper throws typed errors,
				// which propagate out of the current catch via the enclosing
				// catch's implicit re-throw. The session supervisor sees the
				// typed error and can swap backends instead of treating it as a
				// transient retry.
				if (err instanceof Error) classifySSEError(err);
				// Do NOT increment attempt here — the try block already incremented
				// it before calling reconnectAfter. A second bump would halve the
				// effective retry budget so only ~3 of the 5 BACKOFF_MS slots
				// would fire (skipping the 4s and 16s delays). The guard below
				// catches the max-retries case where reconnectAfter's own throw
				// arrives after we've already spent the budget in the try block.
				if (attempt > BACKOFF_MS.length) {
					throw err instanceof Error
						? err
						: new Error("SSE connection failed after maximum retries");
				}
			}
		}
	}

	async listTools(): Promise<Tool[]> {
		if (!this.client) throw new Error("SseProxyBackend.listTools() before start()");
		const res = await this.client.listTools();
		return res.tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
		if (!this.client) throw new Error("SseProxyBackend.callTool() before start()");
		const res = await this.client.callTool({ name, arguments: args });
		return res as CallToolResult;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.connectedClient = null;
		if (this.transport) {
			await this.transport.close().catch(() => {});
			this.transport = null;
		}
		if (this.client) {
			await this.client.close().catch(() => {});
			this.client = null;
		}
	}
}

/**
 * Public factory — ProxyServer / Session C build SSE backends via this.
 * Keeps the SseProxyBackend class private so callers can't accidentally
 * depend on its internal reconnect state.
 */
export function createSseBackend(sseUrl: string, token: string): SseProxyBackend {
	return new SseProxyBackend(sseUrl, token);
}
