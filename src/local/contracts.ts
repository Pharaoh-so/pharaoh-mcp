/** Private dispatch boundary. No hosted backend can be passed to the local runner. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LocalMemoryBinding } from "../../runtime/local-worktree-hook.mjs";
import type { Credentials } from "../credentials.js";
import type { RefreshOutcome } from "../refresh.js";
import type { BlastRoute, CheckoutEvidence, VerifiedCheckout } from "./dispatch.js";

/** Settle only after the answer was successfully written to its client. */
export type LocalDelivery = (written: boolean) => Promise<void>;

/** The saved Pharaoh sign-in, as the proxy reads and renews it. */
export interface LocalSignIn {
	/** The saved sign-in, or null when there is none. */
	read(): Credentials | null;
	/** Whether `current` is still exactly `original`: the same tokens for the same server. */
	same(current: Credentials | null, original: Credentials): boolean;
	/** Renew `creds` against `server` alone, only while the saved sign-in is still `creds`. */
	renew(creds: Credentials, server: string): Promise<RefreshOutcome>;
}

/**
 * What local answers need from the proxy around them. The composition root
 * (src/local-host.ts) supplies it, so src/local imports nothing above it.
 */
export interface LocalHost {
	readonly signIn: LocalSignIn;
	/** Bound installation checkout, independent of the repository's GitHub authorization. */
	readonly scope?: { kind: "global" } | { kind: "local"; root: string };
	/** The launch entry client registrations name: the launcher that started this process, or dist/index.js. */
	readonly entry: string;
	/** The coding clients whose registration runs exactly `entry`. */
	managedClients(): ReadonlyArray<"claude-code" | "codex">;
}

/** Execution of an already-claimed local request. */
export interface LocalBlastRuntime {
	/** Trusted CLI invocation evidence. Stdio calls use a native hook claim. */
	readonly invocation: CheckoutEvidence;
	/** Startup hint for a managed native launch. Local calls still require a claim. */
	canDeferHostedStartup?(): boolean;
	/** Observe an actual stdio connection and its workspace upper bound. */
	connect?(client: string | undefined): void;
	/** Whether the attached transport can participate in the harmless readiness check. */
	canCheckReadiness?(): boolean;
	/** Bind one exact native challenge to the active transport. */
	checkReadiness?(args: Readonly<Record<string, unknown>>): CallToolResult;
	/** Use null for a proven hosted transport, undefined for unavailable binding. */
	memoryBinding?(): LocalMemoryBinding | null | undefined;
	/** Consume a permission-neutral native proof for one unbound memory call. */
	authorizeMemory?(
		name: string,
		args: Readonly<Record<string, unknown>>,
	): (() => boolean) | undefined;
	/** Revoke the connection generation on disconnect. */
	disconnect?(): void;
	/** Claim a native hook marker for exactly the received arguments. */
	consume(
		client: string | undefined,
		token: string,
		args: Readonly<Record<string, unknown>>,
	): VerifiedCheckout | undefined;
	/** Answer the immutable claim locally. */
	answer(
		route: Extract<BlastRoute, { kind: "local" }>,
		signal: AbortSignal,
		onDelivery: (settle: LocalDelivery) => void,
	): Promise<CallToolResult>;
}

const REFUSAL =
	"Pharaoh could not verify this saved-worktree request. Make a fresh local call, or choose hosted scope for a default-branch answer.";

/**
 * Return a fixed local refusal without any input or diagnostic values.
 * @param code - Finite internal outcome code
 * @param text - Trusted static guidance, never raw errors
 * @returns Local-only failure response
 */
export function localRefusal(code: string, text = REFUSAL): CallToolResult {
	return {
		isError: code !== "plan_wall:map_only",
		content: [{ type: "text", text }],
		_meta: { errorCode: code, pharaohScope: { scope: "local", status: "refused" } },
	};
}
