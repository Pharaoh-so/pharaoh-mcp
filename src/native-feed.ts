/** Binds negotiated native clients to the private feed without changing native agent dispatch. */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
	deriveFeedCohortKey,
	feedServerOrigin,
	readFeedRegistration,
	readFeedSignInGeneration,
	resolveFeedCheckout,
	resolveFeedProfile,
} from "../runtime/feed-identity.mjs";
import { readFeedSignIn } from "../runtime/feed-signin.mjs";
import { createFeedStore, type FeedConnection, type FeedOptions } from "../runtime/feed-store.mjs";
import { type Credentials, readCredentials } from "./credentials.js";
import { sameCredentialSnapshot } from "./refresh.js";

/** The installed wrapper supplies these values; metadata never grants repository access. */
export interface NativeFeedOptions extends FeedOptions {
	/** Managed native adapter. */ client: "codex" | "claude-code";
	/** Stable managed installation UUID. */ registration: string;
	/** Configured service origin. */ server: string;
	/** Exact optional --server pair from the managed launch. */ serverArgv: string[];
	/** Initial backend's authenticated credential snapshot. */ credentials?: Credentials;
	/** Native checkout; default is the proxy startup directory. */ cwd?: string;
}

/** Local, reported findings are ephemeral and do not become accepted decisions. */
export const NATIVE_SHARE_TOOL: Tool = {
	name: "pharaoh_share",
	_meta: { "anthropic/alwaysLoad": true },
	description:
		"CALL THIS WHEN: A concrete finding, interface change or blocker materially affects sibling agents in this native session. Share one short data-only summary and repository-relative file references. Include no source, secrets or instructions. RETURNS: A local validation receipt. The next eligible native hook can attribute this ephemeral update to the child; the receipt does not establish delivery or an accepted decision.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			recipientToken: {
				type: "string",
				pattern: "^[a-f0-9-]{36}$",
				description:
					"The opaque child token in this agent's native context seed. Root calls without a child token are unsupported.",
			},
			kind: { type: "string", enum: ["reported", "proposed"] },
			summary: { type: "string", minLength: 1, maxLength: 240 },
			references: {
				type: "array",
				minItems: 1,
				maxItems: 8,
				items: { type: "string", maxLength: 240 },
			},
		},
		required: ["recipientToken", "kind", "summary", "references"],
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

/** Owns one stdio connection record; a late callback cannot revive a closed connection. */
export class NativeFeedRuntime {
	private readonly store;
	private readonly id = randomUUID();
	private readonly checkout: string | null;
	private readonly credentialsPath: string;
	private connection: FeedConnection | null = null;
	private metadata: { name?: string; version?: string } | null = null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private started = false;
	private closed = false;
	private adoptedGeneration: string | null = null;
	private registered = false;

	constructor(private readonly options: NativeFeedOptions) {
		this.store = createFeedStore(options);
		this.credentialsPath =
			options.credentialsPath ?? join(options.home ?? homedir(), ".pharaoh", "credentials.json");
		this.checkout = resolveFeedCheckout(options.cwd ?? process.cwd());
		if (options.credentials) this.adoptCredentials(options.credentials);
	}

	/** Start only for the actual stdio transport, before initialization can arrive. */
	start(): void {
		if (this.closed || this.started) return;
		this.started = true;
		this.publish();
		this.timer = setInterval(() => this.heartbeat(), 10_000);
		this.timer.unref();
	}

	/** Cache negotiated initialization metadata once, independently of backend replacement. */
	connect(info: { name?: string; version?: string } | undefined): void {
		if (this.closed || !this.started || this.metadata) return;
		this.metadata = { name: info?.name, version: info?.version };
		this.publish();
	}

	/** Adopt identity only after the caller has successfully installed the authenticated backend. */
	adoptCredentials(credentials: Credentials): void {
		if (this.closed || !sameCredentialSnapshot(readCredentials(this.credentialsPath), credentials))
			return;
		const marker = readFeedSignIn(this.credentialsPath);
		if (
			!marker ||
			marker.server !== feedServerOrigin(this.options.server) ||
			marker.server !== feedServerOrigin(credentials.sse_url)
		)
			return;
		this.adoptedGeneration = marker.generation;
		if (this.started) this.publish();
	}

	private publish(): void {
		try {
			const signIn = readFeedSignInGeneration(this.options);
			if (
				this.closed ||
				!this.started ||
				!this.checkout ||
				!signIn ||
				signIn !== this.adoptedGeneration ||
				readFeedRegistration({ ...this.options, client: this.options.client }) !==
					this.options.registration
			) {
				if (this.connection) this.store.removeFeedConnection(this.id);
				this.connection = null;
				return;
			}
			const cohort = deriveFeedCohortKey({ ...this.options, signIn, checkout: this.checkout });
			if (!cohort) return;
			if (this.connection && this.connection.cohort !== cohort)
				this.store.removeFeedConnection(this.id);
			this.connection = {
				id: this.id,
				cohort,
				client: this.options.client,
				signIn,
				checkout: this.checkout,
				state: this.metadata ? "initialized" : "pending",
				name: this.metadata?.name,
				clientVersion: this.metadata?.version,
			};
			this.registered = this.store.recordFeedConnection(this.connection);
			if (!this.registered) this.store.suppressCohort({ cohort });
		} catch {
			this.registered = false;
			try {
				if (this.connection) this.store.suppressCohort({ cohort: this.connection.cohort });
			} catch {
				/* Optional storage is unavailable. */
			}
		}
	}

	private heartbeat(): void {
		try {
			if (readFeedSignInGeneration(this.options) !== this.adoptedGeneration) {
				if (this.connection) this.store.removeFeedConnection(this.id);
				this.connection = null;
				return;
			}
			if (this.connection?.state === "initialized" && this.registered)
				this.registered = this.store.renewFeedConnection(this.id);
			if (!this.registered) this.publish();
			this.store.pruneExpired({ limit: 8 });
		} catch {
			/* Lease expiry is the failure path. */
		}
	}

	/** Expose a tool only after initialization and current sign-in adoption. */
	available(): boolean {
		if (
			this.closed ||
			!this.registered ||
			this.connection?.state !== "initialized" ||
			readFeedSignInGeneration(this.options) !== this.adoptedGeneration
		)
			return false;
		return resolveFeedProfile({
			...this.options,
			cohort: this.connection.cohort,
			event: "PostToolUse",
			exactConnectionId: this.id,
			now: (this.options.now ?? Date.now)(),
		}).admit;
	}

	/** Validate a bounded report and issue a one-use receipt; only a native child hook publishes it. */
	share(input: Record<string, unknown>): CallToolResult {
		const refused = {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: "Native context sharing is unavailable or the report is invalid.",
				},
			],
		};
		if (
			!this.available() ||
			!this.connection ||
			Object.keys(input).some(
				(key) => !["recipientToken", "kind", "summary", "references"].includes(key),
			) ||
			typeof input.recipientToken !== "string" ||
			(input.kind !== "reported" && input.kind !== "proposed") ||
			typeof input.summary !== "string" ||
			!input.summary.trim() ||
			input.summary.length > 240 ||
			/[\r\n`{}]|(?:Bearer\s|(?:phat|phrt|ghp|gho|ghs|ghu)_)/i.test(input.summary) ||
			!Array.isArray(input.references) ||
			input.references.length < 1 ||
			input.references.length > 8 ||
			!input.references.every(
				(value): value is string =>
					typeof value === "string" &&
					value.length <= 240 &&
					/^[\w.@+ /-]+$/.test(value) &&
					!value.startsWith("/") &&
					!value.split("/").includes(".."),
			)
		)
			return refused;
		try {
			const receiptId = this.store.createShareReceipt({
				cohort: this.connection.cohort,
				recipientToken: input.recipientToken,
				finding: { kind: input.kind, summary: input.summary.trim(), references: input.references },
			});
			return receiptId
				? {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ version: 1, state: "awaiting_child_hook", receiptId }),
							},
						],
					}
				: refused;
		} catch {
			return refused;
		}
	}

	/** Remove exactly this connection and stop renewal on transport close or shutdown. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		try {
			this.store.removeFeedConnection(this.id);
		} catch {
			/* The lease also expires. */
		}
		this.connection = null;
		this.registered = false;
	}
}
