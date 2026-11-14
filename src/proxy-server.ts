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
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	type ClientCapabilities,
	type JSONRPCMessage,
	ListToolsRequestSchema,
	type RequestId,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { memoryEgressDecision } from "../project-memory/local.mjs";
import {
	memoryDiagnosticsForClient,
	memoryHookStateForClient,
} from "../project-memory/preferences.mjs";
import { ensureMemoryHooks } from "../project-memory/setup.mjs";
import { runtimeRequestMetadata } from "../runtime/runtime-client.mjs";
import { RUNTIME_TOOL_NAMES, sanitizeRuntimeResult } from "../runtime/runtime-native.mjs";
import { ensurePrivateDirectory, privatePath } from "../runtime/runtime-storage.mjs";
import {
	AuthRequiredBackend,
	type Backend,
	createSseBackend,
	type DownstreamClient,
} from "./backend.js";
import { loadBundledCatalog } from "./catalog.js";
import type { Credentials } from "./credentials.js";
import { createGateway, type DeviceFlowGateway } from "./gateway.js";
import { claudePluginState, instructionStates } from "./install-skills.js";
import { type LocalBlastRuntime, type LocalDelivery, localRefusal } from "./local/contracts.js";
import { selectBlastRoute } from "./local/dispatch.js";
import { createLocalBlastRuntime } from "./local/runtime.js";
import { TenantSuspendedError, TokenExpiredError } from "./proxy.js";
import { registerTraceResource } from "./trace-resource.js";
import { getPackageVersion } from "./version.js";

const MEMORY_OPERATIONS = new Map<string, "recall" | "expand" | "capture" | "feedback">([
	["pharaoh_memory_recall", "recall"],
	["pharaoh_memory_expand", "expand"],
	["pharaoh_memory_capture", "capture"],
	["pharaoh_memory_feedback", "feedback"],
]);
const MEMORY_PROTECTED: CallToolResult = {
	isError: true,
	content: [
		{
			type: "text",
			text: "Pharaoh withheld this automatic project memory request to protect saved-worktree details.",
		},
	],
};
const WORKTREE_STORAGE = { ensurePrivateDirectory, privatePath };
const LOCAL_READINESS: Tool = {
	name: "pharaoh_local_worktree_status",
	_meta: { "anthropic/alwaysLoad": true },
	annotations: { readOnlyHint: true },
	description:
		"Verify the active local worktree connection using only the opaque challenge from the current Pharaoh hook. Returns whether saved files are available before you submit a caller or blast-radius selector.",
	inputSchema: {
		type: "object",
		properties: { challenge: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } },
		required: ["challenge"],
		additionalProperties: false,
	},
};

function writeLocalStdioReply(message: JSONRPCMessage): Promise<void> {
	return new Promise((resolve, reject) => {
		process.stdout.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
	});
}

function withoutMemoryFeedback(result: CallToolResult): CallToolResult {
	const content = result.content.map((block) => {
		if (block.type !== "text") return block;
		try {
			const packet = JSON.parse(block.text);
			if (!packet || typeof packet !== "object" || !Object.hasOwn(packet, "feedbackRequest"))
				return block;
			delete packet.feedbackRequest;
			return { ...block, text: JSON.stringify(packet) };
		} catch {
			return block;
		}
	});
	if (!result._meta) return { ...result, content };
	const { feedbackRequest: _feedbackRequest, ...metadata } = result._meta;
	return { ...result, content, _meta: metadata };
}

const deferredBackends = new WeakSet<Backend>();

/** Only a hosted operation starts SSE; its availability cannot block local dispatch. */
function deferHostedBackend(backend: Backend): Backend {
	if (backend.name !== "sse" || deferredBackends.has(backend)) return backend;
	let started: Promise<void> | undefined;
	let stopped = false;
	let finish!: () => void;
	let fail!: (error: unknown) => void;
	const exit = new Promise<void>((resolve, reject) => {
		finish = resolve;
		fail = reject;
	});
	// The supervisor attaches when stdio is ready.
	void exit.catch(() => {});

	const ensureStarted = () => {
		if (stopped) return Promise.reject(new Error("Hosted connection has closed"));
		started ??= Promise.resolve()
			.then(() => backend.start?.())
			.then(
				() => {
					if (stopped) return backend.stop?.();
					const lifetime = backend.waitForExit?.();
					if (lifetime) void lifetime.then(finish, fail);
				},
				(error: unknown) => {
					started = undefined;
					if (error instanceof TokenExpiredError || error instanceof TenantSuspendedError)
						fail(error);
					throw error;
				},
			);
		return started;
	};

	const deferred: Backend = {
		name: "sse",
		async listTools(options) {
			try {
				await ensureStarted();
				return await backend.listTools(options);
			} catch {
				options?.signal?.throwIfAborted();
				return loadBundledCatalog().tools;
			}
		},
		async callTool(name, args, options) {
			await ensureStarted();
			options?.signal?.throwIfAborted();
			return backend.callTool(name, args, options);
		},
		identifyClient: (client) => backend.identifyClient?.(client),
		withClientCapabilities(capabilities) {
			const next = backend.withClientCapabilities?.(capabilities) ?? backend;
			return next === backend ? deferred : deferHostedBackend(next);
		},
		waitForExit: () => exit,
		async stop() {
			stopped = true;
			try {
				await backend.stop?.();
			} finally {
				finish();
			}
		},
	};
	deferredBackends.add(deferred);
	return deferred;
}

/**
 * Stdio MCP server with a swappable backend. The Server instance is
 * long-lived across backend swaps; only the Backend reference moves.
 */
export class ProxyServer {
	private server: Server;
	private transport: Transport | null = null;
	private backend: Backend;
	private started = false;
	private stopping = false;
	private clientCapabilities: ClientCapabilities = {};
	private clientInitialized = false;
	private downstream: DownstreamClient | null = null;
	/** Sign-in whose memory hint decides start-time hooks; set by index.ts, never read from disk here. */
	private memoryCredentials: Credentials | null = null;
	/** Lines for the user after hooks were turned on, carried by the next answered tool call. */
	private memoryNotice: string[] = [];
	private capabilityUpdate: Promise<void> = Promise.resolve();
	private localDeliveries = new Map<RequestId, { settle: LocalDelivery; detach: () => void }>();
	private deliverySettlements = new Set<Promise<void>>();
	private transportClosed: Promise<void>;
	private transportClosedResolve!: () => void;
	private readonly deferHosted: boolean;

	constructor(
		initialBackend: Backend,
		private readonly requestTimeout?: number,
		private readonly localBlast?: LocalBlastRuntime,
	) {
		this.deferHosted =
			localBlast?.invocation.kind === "checkout" || localBlast?.canDeferHostedStartup?.() === true;
		this.backend = this.deferHosted ? deferHostedBackend(initialBackend) : initialBackend;
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
			this.ensureHooks(info);
			const downstream: DownstreamClient = {
				client: { name: info?.name, version: info?.version },
				plugin: claudePluginState(),
				memoryHooks: memoryHookStateForClient(info),
				instructions: instructionStates(info?.name),
			};
			this.downstream = downstream;
			if (this.transport instanceof StdioServerTransport) this.localBlast?.connect?.(info?.name);
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
		this.server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
			await this.capabilityUpdate;
			extra.signal.throwIfAborted();
			const tools = await this.backend.listTools({ signal: extra.signal });
			return {
				tools: this.localBlast?.canCheckReadiness?.() ? [...tools, LOCAL_READINESS] : tools,
			};
		});
		this.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
			extra.signal.throwIfAborted();
			const { name } = req.params;
			let args = req.params.arguments ?? {};
			if (name === LOCAL_READINESS.name)
				return this.localBlast?.checkReadiness?.(args) ?? localRefusal("unverified_worktree");
			// The hosted tool describes; this proxy verifies and stages the update itself (update.ts).
			if (name === "pharaoh_update") {
				const { updateFromTool } = await import("./update.js");
				const { text, isError } = await updateFromTool(extra.signal);
				return { isError, content: [{ type: "text", text }] };
			}
			const route = selectBlastRoute(
				name,
				args,
				this.localBlast?.invocation ?? { kind: "hosted-only" },
				(token, input) => this.localBlast?.consume(this.downstream?.client.name, token, input),
			);
			if (route.kind === "refused") return localRefusal(route.code);
			if (route.kind === "local")
				return (
					this.localBlast?.answer(route, extra.signal, (settle) =>
						this.trackLocalDelivery(extra.requestId, extra.signal, settle),
					) ?? localRefusal("local_unavailable")
				);

			// Hosted-only below here, including post-sign-in replay.
			await this.capabilityUpdate;
			extra.signal.throwIfAborted();
			const operation = MEMORY_OPERATIONS.get(name);
			const nativeProof =
				operation && this.localBlast?.memoryBinding && this.localBlast.memoryBinding() === undefined
					? this.localBlast.authorizeMemory?.(name, args)
					: undefined;
			const allowMemory = () => {
				if (!operation || !this.localBlast?.memoryBinding) return true;
				const binding = this.localBlast.memoryBinding();
				if (binding === undefined && nativeProof) return nativeProof();
				return (
					memoryEgressDecision(binding, operation, {
						storage: WORKTREE_STORAGE,
					}) === "normal"
				);
			};
			if (!allowMemory()) return MEMORY_PROTECTED;
			const memoryTool = operation && operation !== "feedback";
			if (memoryTool) {
				const diagnostics = memoryDiagnosticsForClient(this.downstream?.client ?? {});
				const claimed =
					args.diagnostics &&
					typeof args.diagnostics === "object" &&
					!Array.isArray(args.diagnostics)
						? (args.diagnostics as Record<string, unknown>)
						: undefined;
				if (diagnostics || claimed) {
					const baseline = Object.fromEntries(
						["taskSummary", "intendedNextAction", "turnRef", "sessionRef", "recallId"].flatMap(
							(key) => (claimed?.[key] === undefined ? [] : [[key, claimed[key]]]),
						),
					);
					// Native consent controls identity/version; agent baselines never restore an opted-out generation.
					args = { ...args, diagnostics: { ...baseline, ...diagnostics } };
				}
			}
			const backend = this.backend;
			if (RUNTIME_TOOL_NAMES.includes(name)) {
				const { refreshManagedRuntimeBuild } = await import("./runtime-command.js");
				refreshManagedRuntimeBuild(this.downstream?.client.name);
			}
			// Caller _meta never supplies installation identity; only the private
			// consent record for this negotiated local client can add it upstream.
			const runtime = RUNTIME_TOOL_NAMES.includes(name)
				? runtimeRequestMetadata(this.downstream?.client.name)
				: undefined;
			// The CLI's longer deadline must reach the upstream SDK request too.
			const beforeSend = operation
				? () => (allowMemory() ? undefined : MEMORY_PROTECTED)
				: undefined;
			const options = { signal: extra.signal, timeout: this.requestTimeout, runtime, beforeSend };
			const hostedCall = (target: Backend) =>
				allowMemory() ? target.callTool(name, args, options) : Promise.resolve(MEMORY_PROTECTED);
			const cleanMemoryResult = (result: CallToolResult) =>
				memoryTool && !allowMemory() ? withoutMemoryFeedback(result) : result;
			const result = await hostedCall(backend);
			// The call that completed sign-in swapped in the real backend — answer
			// it from there instead of asking the agent to call again.
			if (backend.name === "auth-required" && this.backend !== backend && !result.isError) {
				extra.signal.throwIfAborted();
				return this.withMemoryNotice(
					sanitizeRuntimeResult(
						cleanMemoryResult(await hostedCall(this.backend)),
						Boolean(runtime),
					) as CallToolResult,
				);
			}
			return this.withMemoryNotice(
				sanitizeRuntimeResult(
					cleanMemoryResult(result),
					backend.name === "sse" && Boolean(runtime),
				) as CallToolResult,
			);
		});
	}

	/**
	 * Use `creds` for start-time memory hooks: at sign-in, after a swap, or once
	 * memory-hint.ts stored a newer hint. Installs for an already-identified client.
	 */
	setMemoryCredentials(creds: Credentials | null): void {
		this.memoryCredentials = creds;
		if (this.clientInitialized) this.ensureHooks(this.server.getClientVersion());
	}

	/** Never prompts and never writes to stdout, which carries MCP. */
	private ensureHooks(info: { name?: string; version?: string } | undefined): void {
		if (!this.memoryCredentials) return;
		let lines: string[] = [];
		try {
			lines = ensureMemoryHooks(info, this.memoryCredentials);
		} catch {
			// ALLOWED-CATCH: memory hooks are optional; MCP keeps working without them
		}
		if (!lines.length) return;
		this.memoryNotice.push(...lines);
		process.stderr.write(`${lines.join("\n")}\n`);
		// The next upstream session reports the new state; this one already reported.
		if (this.downstream) this.downstream.memoryHooks = memoryHookStateForClient(info);
	}

	private withMemoryNotice(result: CallToolResult): CallToolResult {
		if (!this.memoryNotice.length || result.isError) return result;
		const text = `\n---\n${this.memoryNotice.join("\n")}`;
		this.memoryNotice = [];
		return { ...result, content: [...(result.content ?? []), { type: "text", text }] };
	}

	private takeLocalDelivery(id: RequestId): LocalDelivery | undefined {
		const delivery = this.localDeliveries.get(id);
		if (!delivery) return;
		this.localDeliveries.delete(id);
		delivery.detach();
		return delivery.settle;
	}

	private trackLocalDelivery(id: RequestId, signal: AbortSignal, settle: LocalDelivery): void {
		void this.takeLocalDelivery(id)?.(false);
		if (signal.aborted) {
			void settle(false);
			return;
		}
		const cancel = () => {
			void this.takeLocalDelivery(id)?.(false);
		};
		signal.addEventListener("abort", cancel, { once: true });
		this.localDeliveries.set(id, {
			settle,
			detach: () => signal.removeEventListener("abort", cancel),
		});
	}

	private wireLocalDelivery(
		transport: Transport,
		writeLocal?: (message: JSONRPCMessage) => Promise<void>,
	): void {
		const write = transport.send.bind(transport);
		transport.send = async (message, options) => {
			const isReply = "result" in message || "error" in message;
			const id = isReply ? message.id : undefined;
			const settle =
				typeof id === "string" || typeof id === "number" ? this.takeLocalDelivery(id) : undefined;
			let written = false;
			try {
				if (settle && writeLocal) await writeLocal(message);
				else await write(message, options);
				written = "result" in message;
			} finally {
				if (settle) {
					const completion = settle(written);
					this.deliverySettlements.add(completion);
					try {
						await completion;
					} finally {
						this.deliverySettlements.delete(completion);
					}
				}
			}
		};
	}

	private watchTransport(): void {
		// Use the protocol-level hook so the SDK transport chain remains intact.
		this.server.onclose = () => {
			this.localBlast?.disconnect?.();
			for (const id of this.localDeliveries.keys()) void this.takeLocalDelivery(id)?.(false);
			this.transportClosedResolve();
		};
		this.started = true;
	}

	/**
	 * Start the backend (if it has a start hook) and connect stdio. Idempotent.
	 * Tests inject an alternate transport via startWithTransport().
	 */
	async start(): Promise<void> {
		if (this.started) return;
		if (this.backend.start) await this.backend.start();
		this.transport = new StdioServerTransport();
		this.wireLocalDelivery(this.transport, writeLocalStdioReply);
		await this.server.connect(this.transport);
		this.watchTransport();
	}

	/**
	 * Start with a caller-supplied transport, including the CLI's in-memory pair.
	 * @param transport - The MCP transport to connect after starting the backend.
	 * @returns When the proxy is ready to accept client requests.
	 */
	async startWithTransport(transport: Transport): Promise<void> {
		if (this.started) return;
		if (this.backend.start) await this.backend.start();
		this.transport = transport;
		this.wireLocalDelivery(transport);
		await this.server.connect(transport);
		this.watchTransport();
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
		if (this.deferHosted) next = deferHostedBackend(next);
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
		this.localBlast?.disconnect?.();
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
		await Promise.allSettled(this.deliverySettlements);
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
	const proxy = new ProxyServer(backend, undefined, createLocalBlastRuntime(server));
	await proxy.start();
	return { proxy, gateway };
}

/**
 * Happy-path entry point. Credentials are fresh — start directly with the
 * SSE backend. Returned proxy is running and ready for tool calls.
 */
export async function startInSseMode(creds: Credentials): Promise<ProxyServer> {
	const proxy = new ProxyServer(
		createSseBackend(creds.sse_url, creds.access_token),
		undefined,
		createLocalBlastRuntime(new URL(creds.sse_url).origin),
	);
	await proxy.start();
	return proxy;
}

/**
 * Build the shared SSE dispatch path for stdio and one-shot CLI clients.
 * @param creds - Credentials used to authenticate the upstream connection.
 * @param requestTimeout - Optional upstream request deadline in milliseconds.
 * @returns An unstarted proxy; the caller supplies its transport and lifetime.
 */
export function createSseProxyServer(creds: Credentials, requestTimeout?: number): ProxyServer {
	return new ProxyServer(createSseBackend(creds.sse_url, creds.access_token), requestTimeout);
}
