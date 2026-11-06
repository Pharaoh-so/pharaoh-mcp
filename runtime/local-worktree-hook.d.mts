import type { CheckoutEvidence, VerifiedCheckout } from "../src/local/dispatch.js";

/** Opaque identity of one initialized managed stdio connection. */
export interface LocalRuntimeGeneration {
	readonly client: "claude-code" | "codex";
}

/** Private native conversation reference shared with project-memory egress checks. */
export interface LocalMemoryBinding {
	readonly client: "claude-code" | "codex";
	readonly sessionRef: string;
}

/** Native managed runtime identity and trusted checkout resolver. */
interface LocalWorktreeHookOptions {
	/** Negotiated native client family. */
	client: "claude-code" | "codex";
	/** Local hash of the exact managed runtime and current sign-in. */
	binding?: string;
	/** Stable identity of the exact managed launch for ordinary native memory calls. */
	memoryRuntime?: string;
	/** Resolver called only on native or previously verified directories. */
	resolveCheckout(cwd: string): CheckoutEvidence;
	/** Eligibility shared with saved-source snapshots. */
	isSourcePath?(path: string): boolean;
	/** Confined source fingerprints. Null is proven absence, missing entries are uncertain. */
	readSourceFingerprints?(
		checkout: VerifiedCheckout,
		paths: readonly string[],
		visit?: (path: string, bytes: Buffer) => void,
	): ReadonlyMap<string, string | null> | undefined;
	/** The confined index and nonignored untracked inventory for additional source. */
	visibleSourcePaths?(checkout: VerifiedCheckout): readonly string[] | undefined;
	/** Override for the private state home. */
	home?: string;
	/** Override for the clock. */
	now?: number;
}

/** Derive the opaque, local-only grant generation. */
export function localWorktreeBinding(
	client: string,
	launchEntry: string,
	credentials: { refresh_token: string; sse_url: string } | null | undefined,
): string | undefined;

/** Derive a stable managed launch reference that survives normal sign-in replay. */
export function nativeMemoryRuntimeBinding(client: string, launchEntry: string): string | undefined;

/** Evaluate one native command hook event. */
export function handleLocalWorktreeHook(
	input: unknown,
	options: LocalWorktreeHookOptions,
):
	| {
			hookSpecificOutput: {
				hookEventName: string;
				additionalContext?: string;
				permissionDecision?: "deny";
				permissionDecisionReason?: string;
			};
	  }
	| undefined;

/** Observe the exact initialized local connection and its checkout upper bound. */
export function observeRuntimeGeneration(
	client: "claude-code" | "codex",
	binding: string | undefined,
	checkout: VerifiedCheckout,
	options: Pick<LocalWorktreeHookOptions, "resolveCheckout" | "home" | "memoryRuntime">,
): LocalRuntimeGeneration | undefined;

/** Finish the harmless readiness probe using the actual local connection. */
export function verifyRuntimeSession(
	generation: LocalRuntimeGeneration | undefined,
	challenge: unknown,
	options?: { binding?: string; now?: number },
): { checkout: VerifiedCheckout; token: string; memoryBinding: LocalMemoryBinding } | undefined;

/** Check that the observed connection still owns the current native turn. */
export function verifiedSessionRuntime(
	generation: LocalRuntimeGeneration | undefined,
	now?: number,
): boolean;

/** Retain the conversation association for egress protection after binding loss. */
export function runtimeConversationBinding(
	generation: LocalRuntimeGeneration | undefined,
): LocalMemoryBinding | undefined;

declare const memoryCallProof: unique symbol;
export interface NativeMemoryCallProof {
	readonly [memoryCallProof]: true;
}

/** Claim a single exact native memory call for this initialized runtime. */
export function consumeNativeMemoryCall(
	generation: LocalRuntimeGeneration | undefined,
	name: string,
	args: Readonly<Record<string, unknown>>,
	options?: { now?: number },
): NativeMemoryCallProof | undefined;

/** Recheck a native memory proof before first send or retry. */
export function nativeMemoryCallCurrent(
	proof: NativeMemoryCallProof | undefined,
	options?: { now?: number },
): boolean;

/** Revoke an observed connection when its transport disconnects. */
export function releaseRuntimeGeneration(generation: LocalRuntimeGeneration | undefined): void;

/** Consume one marker for an exact managed MCP invocation. */
export function consumeLocalWorktreeContext(
	token: string,
	args: Readonly<Record<string, unknown>>,
	options: LocalWorktreeHookOptions & { generation: LocalRuntimeGeneration | undefined },
): VerifiedCheckout | undefined;

/** Check the diagnostic privacy prerequisites without writing a fence. */
export function localWorktreeDiagnosticsReady(home?: string): boolean;

/** Require proof that automatic memory hooks are inactive before a local shell answer. */
export function localWorktreeShellReady(root: string, home?: string): boolean;

/** Check whether an already consumed native proof remains current. */
export function localWorktreeClaimCurrent(checkout: VerifiedCheckout, now?: number): boolean;

/** Remember bounded fingerprints for an answer delivered through a live native claim. */
export function recordDeliveredLocalWorktreeAnswer(
	checkout: VerifiedCheckout,
	target: string,
	paths: readonly string[],
	sources: ReadonlyMap<string, Uint8Array>,
	capturedAt: number,
	now?: number,
): "recorded" | "skipped" | "unavailable";
