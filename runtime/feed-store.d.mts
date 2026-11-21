/** Public native feed contracts; compatibility metadata never grants repository access. */
export interface FeedOptions {
	/** Scratch or installed home. */
	home?: string;
	/** Credential file defining the installation. */
	credentialsPath?: string;
	/** Clock used by lifecycle tests. */
	now?: () => number;
}
export interface FeedConnection {
	/** Opaque unique record identity. */
	id: string;
	/** Hash of the exact local installation and checkout scope. */
	cohort: string;
	/** Explicit registered native adapter. */
	client: "codex" | "claude-code";
	/** Committed local sign-in generation UUID. */
	signIn: string;
	/** Canonical worktree directory. */
	checkout: string;
	/** Whether native MCP metadata has arrived. */
	state: "pending" | "initialized";
	/** Client name from MCP initialization. */
	name?: string;
	/** Client version from this connection, never an installed-version guess. */
	clientVersion?: string;
}
export interface FeedAccessProof {
	/** Local access proof schema. */
	version: 1;
	/** Configured server origin that authorized this proof. */
	issuer: string;
	/** Authenticated GitHub person ID. */
	actor: number;
	/** Owning tenant identity. */
	owner: number | string;
	/** Canonical owner/repository slug. */
	repo: string;
	/** Current server repository access epoch. */
	epoch: number | string;
	/** Committed local sign-in generation UUID. */
	signIn: string;
	/** Canonical worktree directory. */
	checkout: string;
	/** Hash of verified physical checkout and repository identity. */
	checkoutIdentity: string;
	/** Local request start in milliseconds. */
	requestedAt: number;
	/** At most sixty seconds after request start. */
	expiresAt: number;
}
export interface FeedScope {
	/** Hash of the exact installation and checkout. */ cohort: string;
	/** Native root tree identity. */ rootId: string;
	/** Actual native child identity. */ agentId: string;
}
export interface FeedFinding extends FeedScope {
	/** Requires explicit preview enrollment at delivery. */
	previewOnly?: true;
	/** Stable hash identifying one producer transition retry. */
	dedupeKey?: string;
	/** Whether this is a worker assertion or a verified structural observation. */
	kind: "reported" | "proposed" | "invalidation" | "fact";
	/** Bounded data-only sentence, without source or credential shapes. */
	summary?: string;
	/** Safe repository-relative paths relevant to the event. */
	references: string[];
	/** Revision labels supporting this event. */
	provenance?: FeedProvenance;
	/** Captured before asynchronous analysis; stale work cannot publish. */
	authorizationIdentity?: string;
}
/** Revision metadata permitted alongside a bounded data event. */
export interface FeedProvenance {
	/** Branch containing the observed change. */
	branch?: string;
	/** Git revision when the observation was prepared. */
	head?: string;
	/** Saved snapshot hash; never source content. */
	fingerprint?: string;
}
export interface FeedEvent extends FeedFinding {
	/** Event UUID used by deduplicated claims. */ id: string;
	/** Monotonic sequence within this cohort. */ sequence: number;
	/** Creation time in milliseconds. */ createdAt: number;
}
export interface FeedObservation extends FeedScope {
	/** Observation UUID for producer acknowledgements. */ id: string;
	/** Structured repository-relative paths, never command text. */ paths: string[];
	/** Read or edit boundary. */ kind: string;
	/** Observation time in milliseconds. */ createdAt: number;
}
export interface FeedStore {
	recordFeedConnection(connection: FeedConnection): boolean;
	renewFeedConnection(id: string): boolean;
	removeFeedConnection(id: string): boolean;
	readCohort(cohort: string): unknown;
	registerFeedRoot(input: {
		cohort: string;
		rootId: string;
		checkout: string;
		basis?: string;
		exactVersion?: string;
	}): boolean;
	registerRecipient(input: FeedScope & { checkout: string; interests?: string[] }): boolean;
	recipientCapability(input: FeedScope): string | null;
	recordObservation(input: FeedScope & { paths: string[]; kind?: string }): boolean;
	publishFinding(input: FeedFinding): FeedEvent | null;
	/** Publish one author's verified reference for matching siblings, or identify a terminal or retryable outcome. */
	publishOverlap(
		input: FeedScope & {
			observationId: string;
			path: string;
			provenance: FeedProvenance & { head: string; fingerprint: string };
			authorizationIdentity: string;
		},
	): "published" | "irrelevant" | "retry";
	drainRecipient(
		input: FeedScope & {
			maxChars?: number;
			seedChars?: number;
			gapChars?: number;
			preview?: boolean;
		},
	): {
		events: FeedEvent[];
		gap: boolean;
		seedNeeded: boolean;
		claimId: string | null;
		authorizationIdentity: string;
	} | null;
	markEmitted(input: FeedScope & { claimId: string; authorizationIdentity?: string }): boolean;
	readScopeRevision(input: { cohort: string }): string | null;
	currentAuthorizationIdentity(input: { cohort: string }): string | null;
	putAccessProof(input: {
		cohort: string;
		proof: FeedAccessProof;
		expectedRevision?: string;
	}): boolean;
	readAccessProof(input: { cohort: string }): FeedAccessProof | null;
	readObservations(input: { cohort: string }): FeedObservation[];
	acknowledgeObservations(input: {
		cohort: string;
		ids: string[];
		authorizationIdentity?: string;
	}): boolean;
	readProducerState(input: { cohort: string }): Record<string, unknown> | null;
	updateProducerState(input: {
		cohort: string;
		state: Record<string, unknown>;
		signIn: string;
		authorizationIdentity?: string;
	}): boolean;
	createShareReceipt(input: {
		cohort: string;
		recipientToken: string;
		finding: Omit<FeedFinding, "cohort" | "rootId" | "agentId">;
	}): string | null;
	consumeShareReceipt(input: FeedScope & { receiptId: string }): FeedEvent | null;
	clearFeedScope(input?: {
		cohort?: string;
		signIn?: string;
		expectedRevision?: string;
		authorizationIdentity?: string;
	}): boolean;
	pruneExpired(input?: { limit?: number }): number;
	suppressCohort(input: { cohort: string }): boolean;
}
/** Create bounded private state operations for one credential installation. */
export function createFeedStore(options?: FeedOptions): FeedStore;
/** Canonical stable proof scope shared by inspection and delivery. */
export function feedProofIdentity(proof: FeedAccessProof): string;
/** Render only useful event data using the same representation as byte admission. */
export function formatFeedEvent(event: FeedEvent): string;
/** Maximum encoded native packet size. */
export const FEED_PACKET_BYTES: number;
/** Maximum encoded normal event size. */
export const FEED_EVENT_BYTES: number;
/** UTF-8 byte size for actual output admission. */
export function feedPayloadBytes(value: string): number;
