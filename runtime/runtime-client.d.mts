/** A native client whose local command hooks can be configured. */
export type RuntimeClient = "claude-code" | "codex";
export interface RuntimeOAuthCredentials {
	access_token: string;
	expires_at: string;
	sse_url: string;
	runtime_session?: string;
}
/** Dependencies injected by setup and isolated fixtures. */
export interface RuntimeOptions {
	home?: string;
	env?: NodeJS.ProcessEnv;
	now?: number;
	hookPath?: string;
	generation?: string;
	node?: string;
	clientBuild?: string;
	proxyBuild?: string;
	controlled?: boolean;
	selectionId?: string;
	deviceApproval?: RuntimeDeviceApproval;
	expectedRuntimeSession?: string;
	canActivate?: () => boolean;
	readOAuthCredentials?: () => RuntimeOAuthCredentials | null;
	onApproval?: (url: string, reference: string) => void;
	wait?: (milliseconds: number) => Promise<void>;
	oauthCredentials?: (
		server: string,
	) => Promise<RuntimeOAuthCredentials | null> | RuntimeOAuthCredentials | null;
	fetchImpl?: typeof fetch;
}
export interface RuntimeIdentity {
	installationId: string;
	generation: string;
}
export interface RuntimeEnrollmentIntent extends RuntimeIdentity {
	client: RuntimeClient;
	policyVersion: typeof import("./runtime-contract.mjs").RUNTIME_POLICY_VERSION;
}
export interface RuntimeDeviceApproval extends RuntimeEnrollmentIntent {
	approvalId: string;
	expiresAt: string;
}
export interface RuntimeRequestMetadata {
	server: string;
	metadata: RuntimeIdentity & { credential: string };
}
export interface RuntimeProfileSelection extends RuntimeIdentity {
	selectionId: string;
	profileId: string;
	expiresAt: string;
}
export type RuntimeProfileReceipt = RuntimeProfileSelection & {
	episodeRef: string;
	controlRef?: string;
};
export interface RuntimeStatus extends Partial<RuntimeIdentity> {
	consent: "active" | "off" | "paused" | "revocation_pending" | "unsupported";
	receiptCoverage: "observed" | "unobserved" | "unsupported";
	tokenCoverage: "observed" | "unobserved" | "unsupported";
}
export function runtimeStatus(client: string, options?: RuntimeOptions): RuntimeStatus;
export function automaticRuntimeIntent(
	client: RuntimeClient,
	options?: RuntimeOptions,
): RuntimeEnrollmentIntent | null;
export function runtimeRequestMetadata(
	clientName?: string,
	options?: RuntimeOptions,
): RuntimeRequestMetadata | undefined;
/** Refresh bounded installation discovery outside hooks without changing hook registration. */
export function refreshRuntimeBuildEvidence(
	clientName: string | undefined,
	discover: (client: RuntimeClient) => { clientBuild: string; proxyBuild: string },
	options?: RuntimeOptions,
): boolean;
export function enableRuntime(
	client: RuntimeClient,
	server: string,
	hookPath: string,
	options?: RuntimeOptions,
): Promise<boolean>;
export function revokeRuntime(client: RuntimeClient, options?: RuntimeOptions): Promise<boolean>;
export type RuntimeDisableResult = "disabled" | "cleanup_pending" | "not_saved" | "unsupported";
export function disableRuntime(
	client: RuntimeClient,
	options?: RuntimeOptions,
): Promise<RuntimeDisableResult>;
export function selectRuntimeProfile(
	client: RuntimeClient,
	profileId: string,
	options?: RuntimeOptions,
): RuntimeProfileSelection | null;
export function runtimeProfileReceipt(
	client: RuntimeClient,
	selectionId: string,
	options?: RuntimeOptions,
): RuntimeProfileReceipt | null;
export function configuredRuntimeHooks(
	client: RuntimeClient,
	options?: RuntimeOptions,
): { hooks: Record<string, unknown> } | null;
export function recordRuntimeHook(
	client: RuntimeClient,
	input: unknown,
	options?: RuntimeOptions,
): boolean;
export function claimRuntimeDelivery(
	client: RuntimeClient,
	options?: RuntimeOptions,
): string | null;
export function flushRuntimeQueue(
	client: RuntimeClient,
	leaseId: string,
	options?: RuntimeOptions,
): Promise<void>;
