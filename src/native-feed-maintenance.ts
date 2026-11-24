/** Bounded background preparation for native context; no source bytes leave this process. */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	deriveFeedCohortKey,
	feedCheckoutIdentity,
	feedServerOrigin,
	nativeFeedPreviewEnabled,
	readFeedSignInGeneration,
	resolveFeedCheckout,
	resolveFeedProfile,
} from "../runtime/feed-identity.mjs";
import {
	ensureFeedRoot,
	feedHash,
	feedLock,
	readFeedJSON,
	writeFeedJSON,
} from "../runtime/feed-io.mjs";
import {
	createFeedStore,
	FEED_EVENT_BYTES,
	type FeedAccessProof,
	type FeedFinding,
	type FeedObservation,
	feedPayloadBytes,
	formatFeedEvent,
	type HostedFeedPublication,
	safeFeedText,
} from "../runtime/feed-store.mjs";
import { readCredentials } from "./credentials.js";
import type { VerifiedCheckout } from "./local/dispatch.js";
import { fingerprintLocalSources, resolveLocalCheckout } from "./local/scope.js";
import { isLocalSourcePath } from "./local/snapshot.js";
import {
	installedLocalAnalyzer,
	LOCAL_EXPORT_LIMITS,
	type LocalExportInput,
	type LocalExportResult,
	type LocalExportSymbol,
	runLocalExportInventory,
	validLocalExportResult,
} from "./local/worker-host.js";

const hasControl = (value: string) => [...value].some((character) => character.charCodeAt(0) < 32);
const MAX_JOB_BYTES = 16_384;
const LEASE_MS = 5_000;
const RUN_MS = 4_600;
const PERSIST_RESERVE_MS = 400;
// A worker must leave time for one confined rehash and the two fixed Git reads.
const REHASH_RESERVE_MS = 300;
const PROVENANCE_RESERVE_MS = 300;
const CONSENT_POLL_MS = 100;
const REFRESH_MS = 30_000;
const PROOF_MS = 60_000;
const RESPONSE_BYTES = 1_024;
const PUBLICATION_BYTES = 16_384;
const PUBLICATION_INTERVAL_MS = 60_000;
const PUBLICATION_WAITER_TTL_MS = PUBLICATION_INTERVAL_MS + 30_000;
const PUBLICATION_BUDGET_BYTES = 32_768;
const MAX_PUBLICATION_IDENTITIES = 128;
const MAX_PUBLICATION_WAITERS = 64;
const MAX_WATCHED = 32;
const PRODUCER_PART_BYTES = 24 * 1024;
const BATCH_SIZE = 4;
const INVENTORY_LIMIT = 8;
const INVENTORY_BYTES = 12 * 1024;
const INVENTORY_TTL_MS = 30 * 60_000;
const SLUG = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;

/** Trusted installed hook inputs. Local paths are never serialized in an HTTP request. */
export interface FeedMaintenanceJob {
	/** Registered native adapter. */
	client: "codex" | "claude-code";
	/** Opaque managed registration UUID. */
	registration: string;
	/** Sign-in that queued this job; replacement invalidates queued work. */
	signIn: string;
	/** Exact cohort that queued this job, never recomputed into another scope. */
	cohort: string;
	/** Configured service, validated independently of repository contents. */
	server: string;
	/** Exact configured server option tokens, including explicit default. */
	serverArgv: string[];
	/** Canonical checkout selected by the native hook. */
	checkout: string;
	/** Native root tree whose hook requested maintenance. */
	rootId: string;
	/** Optional isolated installation home. */
	home?: string;
	/** Optional isolated credential file. */
	credentialsPath?: string;
}

/** Injectable IO boundaries for deterministic source-clean tests. */
export interface FeedMaintenanceOptions {
	/** HTTP transport; production uses fetch with redirects disabled. */
	fetch?: typeof fetch;
	/** Wall clock for leases and proof expiry. */
	now?: () => number;
	/** Cancellation inherited from the bounded native launcher. */
	signal?: AbortSignal;
	/** Same-process monotonic deadline, taken before launcher input/import. */
	deadline?: number;
	/** Verified checkout resolver; production uses the pinned local reader. */
	resolveCheckout?: (cwd: string) => VerifiedCheckout | null;
	/** Hash a confined capture, optionally visiting the exact transient bytes hashed. */
	fingerprint?: (
		checkout: VerifiedCheckout,
		paths: string[],
		deadline: number,
		visit?: (path: string, bytes: Buffer, sha256: string) => void,
	) => Map<string, string | null> | undefined;
	/** Optional verified export worker; injectable without loading real native assets in tests. */
	exportInventory?: (
		files: LocalExportInput[],
		signal: AbortSignal,
	) => Promise<LocalExportResult[] | undefined>;
	/** Fixed Git metadata only; absence or changes suppress this snapshot. */
	provenance?: (checkout: VerifiedCheckout, deadline: number) => FeedProvenance | undefined;
	/** Real private store with optional failure injection in source-clean tests. */
	store?: ReturnType<typeof createFeedStore>;
}

interface FeedProvenance {
	/** Exact commit read from the verified checkout's HEAD. */
	head: string;
	/** Current branch, or null for a detached HEAD. */
	branch: string | null;
}

interface Admission {
	cohort: string;
	signIn: string;
	id: string;
	startedAt: number;
	inFlightUntil: number;
	refreshAttemptAt: number | null;
}

interface WatchedPath {
	path: string;
	rootId: string;
	hash?: string | null;
	sampledAt: number;
	inventory?: SavedExportReceipt;
}

interface SavedExportReceipt {
	version: 1;
	authorizationIdentity: string;
	head: string;
	capturedAt: number;
	result: LocalExportResult;
}

interface PendingTransition {
	id: string;
	rootId: string;
	agentId: string;
	path: string;
	hash: string | null;
	head: string;
	branch: string | null;
	fact?: string;
}

function transitionFinding(
	transition: PendingTransition,
	cohort: string,
	authorizationIdentity: string,
	fact?: string,
): FeedFinding {
	return {
		cohort,
		authorizationIdentity,
		rootId: transition.rootId,
		agentId: transition.agentId,
		kind: fact ? "fact" : "invalidation",
		...(fact ? { previewOnly: true as const } : {}),
		summary:
			fact ??
			(transition.agentId === "unknown"
				? "Saved file changed. Author unknown."
				: "Saved file changed."),
		references: [transition.path],
		provenance: {
			head: transition.head,
			...(transition.branch ? { branch: transition.branch } : {}),
			...(transition.hash ? { fingerprint: transition.hash } : {}),
		},
		dedupeKey: feedHash(`transition:${transition.id}`),
	};
}

function validJob(value: FeedMaintenanceJob): boolean {
	return Boolean(
		value &&
			JSON.stringify(value).length <= MAX_JOB_BYTES &&
			["codex", "claude-code"].includes(value.client) &&
			typeof value.registration === "string" &&
			validScopeIds(value) &&
			typeof value.checkout === "string" &&
			validRootId(value.rootId) &&
			feedServerOrigin(value.server) &&
			Array.isArray(value.serverArgv),
	);
}

function validScopeIds(value: FeedMaintenanceJob): boolean {
	return /^[a-f0-9-]{36}$/.test(value.signIn ?? "") && /^[a-f0-9]{64}$/.test(value.cohort ?? "");
}

function validRootId(rootId: unknown): boolean {
	return (
		typeof rootId === "string" && rootId.length > 0 && rootId.length <= 256 && !hasControl(rootId)
	);
}

function readAdmissions(root: string, now: number): Admission[] {
	const raw = readFeedJSON(join(root, "maintenance.json"), MAX_JOB_BYTES) as {
		version?: unknown;
		entries?: unknown;
	} | null;
	if (!raw) return [];
	if (raw.version !== 1 || !Array.isArray(raw.entries) || raw.entries.length > 64)
		throw new Error("Invalid maintenance state.");
	return (raw.entries as Admission[]).filter(
		(entry) =>
			entry &&
			typeof entry.cohort === "string" &&
			typeof entry.signIn === "string" &&
			typeof entry.id === "string" &&
			Number.isFinite(entry.startedAt) &&
			Number.isFinite(entry.inFlightUntil) &&
			(entry.refreshAttemptAt === null || Number.isFinite(entry.refreshAttemptAt)) &&
			Math.max(entry.startedAt, entry.refreshAttemptAt ?? 0) > now - PROOF_MS,
	);
}

function claimRun(root: string, cohort: string, signIn: string, refresh: boolean, now: number) {
	return feedLock(
		root,
		() => {
			const entries = readAdmissions(root, now);
			const prior = entries.find((entry) => entry.cohort === cohort && entry.signIn === signIn);
			if (prior && (prior.inFlightUntil > now || prior.startedAt > now - LEASE_MS)) return null;
			if (!prior && entries.length >= 64) return null;
			const canRefresh =
				refresh && (!prior?.refreshAttemptAt || prior.refreshAttemptAt <= now - REFRESH_MS);
			const entry: Admission = {
				cohort,
				signIn,
				id: randomUUID(),
				startedAt: now,
				inFlightUntil: now + LEASE_MS,
				refreshAttemptAt: canRefresh ? now : (prior?.refreshAttemptAt ?? null),
			};
			writeFeedJSON(
				root,
				"maintenance.json",
				{ version: 1, entries: [...entries.filter((item) => item !== prior), entry] },
				MAX_JOB_BYTES,
			);
			return { entry, refresh: canRefresh };
		},
		"maintenance.lock",
		now,
	);
}

function releaseRun(root: string, owned: Admission, now: number) {
	feedLock(
		root,
		() => {
			const entries = readAdmissions(root, now);
			const entry = entries.find((item) => item.id === owned.id && item.cohort === owned.cohort);
			if (!entry) return;
			entry.inFlightUntil = 0;
			writeFeedJSON(root, "maintenance.json", { version: 1, entries }, MAX_JOB_BYTES);
		},
		"maintenance.lock",
		now,
	);
}

function ownsRun(root: string, owned: Admission, now: number): boolean {
	return readAdmissions(root, now).some(
		(entry) => entry.id === owned.id && entry.cohort === owned.cohort && entry.inFlightUntil > now,
	);
}

async function boundedResponse(response: Response, limit = RESPONSE_BYTES): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > limit) return null;
			chunks.push(next.value);
		}
		return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

interface PublicationWaiter {
	cohort: string;
	seenAt: number;
}

interface PublicationBudget {
	identity: string;
	at: number | null;
	waiters: PublicationWaiter[];
}

function reservePublicationAttempt(
	root: string,
	proof: FeedAccessProof,
	cohort: string,
	now: number,
) {
	const identity = feedHash(
		JSON.stringify([proof.issuer, proof.repo, proof.owner, proof.actor, proof.epoch, proof.signIn]),
	);
	const name = "publication-attempts.json";
	return feedLock(
		root,
		() => {
			const saved = readFeedJSON(join(root, name), PUBLICATION_BUDGET_BYTES) as {
				version?: unknown;
				clock?: unknown;
				entries?: unknown;
			} | null;
			if (!saved && existsSync(join(root, name))) return false;
			if (
				saved &&
				(saved.version !== 1 ||
					!Array.isArray(saved.entries) ||
					saved.entries.length > MAX_PUBLICATION_IDENTITIES ||
					(saved.clock !== undefined &&
						(typeof saved.clock !== "number" ||
							!Number.isSafeInteger(saved.clock) ||
							saved.clock > now)))
			)
				return false;
			const records = (saved?.entries ?? []) as PublicationBudget[];
			const entries: PublicationBudget[] = [];
			for (const record of records) {
				if (typeof record?.identity !== "string" || !/^[a-f0-9]{64}$/.test(record.identity))
					continue;
				const at =
					typeof record.at === "number" &&
					Number.isSafeInteger(record.at) &&
					record.at > now - PUBLICATION_INTERVAL_MS
						? record.at
						: null;
				// V1 rows written before scheduling had an attempt timestamp but no waiters.
				if (at !== null && at > now) return false;
				const waiters = Array.isArray(record.waiters)
					? record.waiters.filter(
							(waiter) =>
								typeof waiter?.cohort === "string" &&
								/^[a-f0-9]{64}$/.test(waiter.cohort) &&
								Number.isSafeInteger(waiter.seenAt) &&
								waiter.seenAt <= now &&
								waiter.seenAt > now - PUBLICATION_WAITER_TTL_MS,
						)
					: [];
				if (at !== null || waiters.length) entries.push({ identity: record.identity, at, waiters });
			}
			let budget = entries.find((entry) => entry.identity === identity);
			if (!budget) {
				if (entries.length >= MAX_PUBLICATION_IDENTITIES) return false;
				budget = { identity, at: null, waiters: [] };
				entries.push(budget);
			}
			const waiting = budget.waiters.find((waiter) => waiter.cohort === cohort);
			if (waiting) waiting.seenAt = now;
			else {
				const waiterCount = entries.reduce((total, entry) => total + entry.waiters.length, 0);
				if (waiterCount >= MAX_PUBLICATION_WAITERS) return false;
				budget.waiters.push({ cohort, seenAt: now });
			}
			// Every eligible poll clocks in. Only the oldest still-live waiter may take the next turn.
			const granted = budget.at === null && budget.waiters[0]?.cohort === cohort;
			if (granted) {
				budget.waiters.shift();
				budget.at = now;
			}
			// A rollback cannot reclaim a slot whose earlier history was already pruned.
			writeFeedJSON(root, name, { version: 1, clock: now, entries }, PUBLICATION_BUDGET_BYTES);
			return granted;
		},
		"maintenance.lock",
		now,
	);
}

function publicationResponse(
	value: unknown,
	proof: FeedAccessProof,
	modules: string[],
): HostedFeedPublication | "scope-changed" | null | undefined {
	if (!isRecord(value) || !Object.hasOwn(value, "publication")) return undefined;
	const { publication, ...scope } = value as Record<string, unknown> & {
		publication?: HostedFeedPublication | null;
	};
	const access = parseAccess(scope, proof.repo);
	if (!access || access.actor !== proof.actor || access.repo !== proof.repo) return undefined;
	if (access.owner !== proof.owner || access.epoch !== proof.epoch) return "scope-changed";
	if (publication === null) return null;
	return coversModules(publication, modules) ? publication : undefined;
}

function coversModules(publication: HostedFeedPublication | undefined, modules: string[]): boolean {
	const rows = publication?.modules;
	return (
		Array.isArray(rows) &&
		rows.length === modules.length &&
		modules.every((module) => rows.some((row) => row?.module === module))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface PublicationRefresh {
	job: FeedMaintenanceJob;
	root: string;
	credentialsPath: string;
	proof: FeedAccessProof;
	authorizationIdentity: string;
	store: ReturnType<typeof createFeedStore>;
	deadline: number;
	current: () => boolean;
	now: () => number;
	options: FeedMaintenanceOptions;
}

async function refreshWatchedPublication(refresh: PublicationRefresh) {
	const { job, credentialsPath, proof, store, deadline, current, now, options } = refresh;
	const scope = { cohort: job.cohort, authorizationIdentity: refresh.authorizationIdentity };
	const eligible = () =>
		current() &&
		nativeFeedPreviewEnabled(job.client, job) &&
		resolveFeedProfile({ ...job, credentialsPath, event: "PostToolUse", now: now() }).admit;
	let disposeRequest: (() => void) | undefined;
	try {
		const ready = publicationPreflight(refresh, scope, eligible);
		if (!ready) return;
		const request = requestSignal(options.signal, ready.timeout);
		disposeRequest = request.dispose;
		const response = await (options.fetch ?? fetch)(
			new URL("/api/local/v1/feed-publication", proof.issuer),
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${ready.credentials.access_token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ version: 1, repoSlug: proof.repo, modules: ready.modules }),
				redirect: "error",
				cache: "no-store",
				signal: request.signal,
			},
		);
		const stale = () => request.signal.aborted || performance.now() >= deadline || !current();
		if (stale()) {
			void response.body?.cancel().catch(() => {});
			return;
		}
		if (response.status !== 200) {
			refusePublication(response, store, scope, eligible);
			return;
		}
		const publication = publicationResponse(
			await boundedResponse(response, PUBLICATION_BYTES),
			proof,
			ready.modules,
		);
		if (stale()) return;
		settlePublication(publication, store, scope, eligible);
	} catch {
		// Optional publication requests leave ordinary worktree handling operational.
		return;
	} finally {
		disposeRequest?.();
	}
}

/** The watched modules, credentials and request timeout once a publication request may go out. */
function publicationPreflight(
	{ job, root, credentialsPath, proof, store, deadline, current, now }: PublicationRefresh,
	scope: { cohort: string; authorizationIdentity: string },
	eligible: () => boolean,
) {
	if (!nativeFeedPreviewEnabled(job.client, job) || !current()) return;
	const modules = store.readHostedModuleWatches(scope);
	if (!modules.length || !eligible()) return;
	const credentials = readCredentials(credentialsPath);
	if (
		!credentials ||
		deadline - performance.now() < 150 ||
		!reservePublicationAttempt(root, proof, job.cohort, now()) ||
		!eligible()
	)
		return;
	const timeout = Math.min(2_000, Math.floor(deadline - performance.now() - 50));
	if (timeout < 100) return;
	return { modules, credentials, timeout };
}

function refusePublication(
	response: Response,
	store: ReturnType<typeof createFeedStore>,
	scope: { cohort: string; authorizationIdentity: string },
	eligible: () => boolean,
) {
	void response.body?.cancel().catch(() => {});
	if ([401, 402, 403].includes(response.status)) store.clearFeedScope(scope);
	else if (response.status === 409 && eligible()) store.retireHostedModuleNotices(scope);
}

function settlePublication(
	publication: ReturnType<typeof publicationResponse>,
	store: ReturnType<typeof createFeedStore>,
	scope: { cohort: string; authorizationIdentity: string },
	eligible: () => boolean,
) {
	if (publication === "scope-changed") {
		store.clearFeedScope(scope);
		return;
	}
	if (!eligible()) return;
	if (publication === null) store.retireHostedModuleNotices(scope);
	else if (publication) store.applyHostedModulePublication({ ...scope, publication });
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number) {
	const timed = AbortSignal.timeout(timeoutMs);
	const controller = new AbortController();
	const abort = () => controller.abort();
	timed.addEventListener("abort", abort, { once: true });
	parent?.addEventListener("abort", abort, { once: true });
	if (timed.aborted || parent?.aborted) abort();
	return {
		abort,
		signal: controller.signal,
		dispose() {
			timed.removeEventListener("abort", abort);
			parent?.removeEventListener("abort", abort);
		},
	};
}

function parseAccess(
	value: unknown,
	repo: string,
): Pick<FeedAccessProof, "actor" | "owner" | "repo" | "epoch"> | null {
	if (!isRecord(value)) return null;
	const row = value;
	if (
		Object.keys(row).sort().join() !== "accessEpoch,githubUserId,repoSlug,tenantId,version" ||
		row.version !== 1 ||
		!isPositiveInteger(row.githubUserId) ||
		!isTenantId(row.tenantId) ||
		!isRepoSlugFor(row.repoSlug, repo) ||
		!isPositiveInteger(row.accessEpoch)
	)
		return null;
	return {
		actor: Number(row.githubUserId),
		owner: row.tenantId,
		repo: row.repoSlug,
		epoch: Number(row.accessEpoch),
	};
}

function isPositiveInteger(value: unknown): boolean {
	return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isTenantId(value: unknown): value is string {
	return typeof value === "string" && Boolean(value) && value.length <= 128;
}

function isRepoSlugFor(value: unknown, repo: string): value is string {
	return (
		typeof value === "string" && SLUG.test(value) && value.toLowerCase() === repo.toLowerCase()
	);
}

function watchers(value: unknown): WatchedPath[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is WatchedPath =>
			Boolean(
				entry &&
					typeof entry.path === "string" &&
					entry.path.length <= 512 &&
					!entry.path.includes("\\") &&
					!hasControl(entry.path) &&
					!entry.path.startsWith("/") &&
					entry.path.split("/").every((part: string) => part && part !== "." && part !== "..") &&
					typeof entry.rootId === "string" &&
					entry.rootId.length <= 256 &&
					Number.isFinite(entry.sampledAt) &&
					(entry.hash === undefined || entry.hash === null || /^[a-f0-9]{64}$/.test(entry.hash)),
			),
		)
		.slice(-MAX_WATCHED)
		.map(({ path, rootId, hash, sampledAt, inventory }) => ({
			path,
			rootId,
			hash,
			sampledAt,
			inventory,
		}));
}

function exportReceipt(
	entry: WatchedPath,
	authorizationIdentity: string,
	head: string,
	now: number,
): SavedExportReceipt | undefined {
	const value = entry.inventory;
	if (
		!value ||
		Object.keys(value).sort().join() !== "authorizationIdentity,capturedAt,head,result,version" ||
		value.version !== 1 ||
		value.authorizationIdentity !== authorizationIdentity ||
		value.head !== head ||
		staleCapture(value.capturedAt, now) ||
		!matchesWatch(value.result, entry)
	)
		return;
	return value;
}

function staleCapture(capturedAt: number, now: number): boolean {
	return !Number.isFinite(capturedAt) || capturedAt > now || capturedAt <= now - INVENTORY_TTL_MS;
}

function matchesWatch(result: unknown, entry: WatchedPath): boolean {
	return (
		validLocalExportResult(result) && result.sha256 === entry.hash && result.path === entry.path
	);
}

/** The receipt cap must never displace an existing fingerprint-only watch. */
function trimInventories(watches: WatchedPath[]): void {
	const receipts = watches
		.filter((entry) => entry.inventory !== undefined)
		.sort((a, b) => (a.inventory?.capturedAt ?? 0) - (b.inventory?.capturedAt ?? 0));
	let bytes = receipts.reduce((sum, entry) => sum + receiptBytes(entry), 0);
	while (receipts.length > INVENTORY_LIMIT || bytes > INVENTORY_BYTES) {
		const entry = receipts.shift();
		if (!entry) break;
		bytes -= receiptBytes(entry);
		delete entry.inventory;
	}
}

function receiptBytes(entry: WatchedPath): number {
	return feedPayloadBytes(JSON.stringify({ inventory: entry.inventory }));
}

function watchBytes(watches: WatchedPath[]): number {
	return feedPayloadBytes(JSON.stringify(watches));
}

function trimWatches(watches: WatchedPath[]): boolean {
	trimInventories(watches);
	if (watchBytes(watches) <= PRODUCER_PART_BYTES) return false;
	const oldest = watches
		.filter((entry) => entry.inventory !== undefined)
		.sort((a, b) => (a.inventory?.capturedAt ?? 0) - (b.inventory?.capturedAt ?? 0));
	for (const entry of oldest) {
		delete entry.inventory;
		if (watchBytes(watches) <= PRODUCER_PART_BYTES) return false;
	}
	while (watchBytes(watches) > PRODUCER_PART_BYTES) watches.shift();
	return true;
}

function exportChanges(
	before: LocalExportSymbol[],
	after: LocalExportSymbol[],
): string | undefined {
	const prior = new Map(before.map(({ name, kind }) => [name, kind]));
	const next = new Map(after.map(({ name, kind }) => [name, kind]));
	const changes: string[] = [];
	for (const name of [...new Set([...prior.keys(), ...next.keys()])].sort()) {
		const oldKind = prior.get(name);
		const newKind = next.get(name);
		if (oldKind === newKind) continue;
		if (!oldKind) changes.push(`added ${name} (${newKind})`);
		else if (!newKind) changes.push(`removed ${name} (${oldKind})`);
		else changes.push(`changed ${name} (${oldKind} to ${newKind})`);
	}
	return changes.length ? `Saved exports ${changes.join(", ")}.` : undefined;
}

interface WatchedCapture {
	checkout: VerifiedCheckout;
	paths: string[];
	watches: WatchedPath[];
	fingerprint: NonNullable<FeedMaintenanceOptions["fingerprint"]>;
	exportInventory?: FeedMaintenanceOptions["exportInventory"];
	current: () => boolean;
	previewCurrent: () => boolean;
	deadline: number;
	signal?: AbortSignal;
}

/** Capture bytes when selected by the existing sampler and rehash after an asynchronous parse. */
async function captureWatchedExportInventories(input: WatchedCapture): Promise<
	| {
			hashes: Map<string, string | null>;
			inventories: Map<string, LocalExportResult>;
			raced: Set<string>;
			provenanceDeadline?: number;
	  }
	| undefined
> {
	const { exportInventory, current, previewCurrent, deadline } = input;
	const inventories = new Map<string, LocalExportResult>();
	const raced = new Set<string>();
	const files: LocalExportInput[] = [];
	const provenanceDeadline = deadline - PERSIST_RESERVE_MS;
	const rehashDeadline = provenanceDeadline - PROVENANCE_RESERVE_MS;
	const latestWorkerStart = rehashDeadline - REHASH_RESERVE_MS - LOCAL_EXPORT_LIMITS.runMs;
	const hashes = sampledHashes(input, captureVisitor(input, latestWorkerStart, files));
	if (!hashes || !current() || performance.now() >= deadline) return;
	const due = files.filter((file) => hashes.get(file.path) === file.sha256);
	const started = performance.now();
	if (!exportInventory || !due.length || started >= latestWorkerStart || !previewCurrent())
		return { hashes, inventories, raced };
	await collectInventories(input, exportInventory, due, started, inventories);
	if (!current() || performance.now() >= deadline) return;
	dropRacedHashes(input, rehashDeadline, hashes, inventories, raced);
	return { hashes, inventories, raced, provenanceDeadline };
}

function sampledHashes(
	{ checkout, paths, fingerprint, deadline }: WatchedCapture,
	visit: ((path: string, bytes: Buffer, sha256: string) => void) | undefined,
) {
	return paths.length
		? fingerprint(checkout, paths, deadline, visit)
		: new Map<string, string | null>();
}

/** Keep the exact bytes of a selected TypeScript source while it is hashed, within the batch caps. */
function captureVisitor(
	{ exportInventory, previewCurrent, watches }: WatchedCapture,
	latestWorkerStart: number,
	files: LocalExportInput[],
) {
	if (!(exportInventory && performance.now() < latestWorkerStart && previewCurrent())) return;
	let bytesHeld = 0;
	return (path: string, bytes: Buffer, sha256: string) => {
		if (skipCapture(path, bytes, sha256, watches, bytesHeld)) return;
		// Do not serialize a Buffer view whose backing allocation also held other captured files.
		files.push({ path, sha256, bytes: Uint8Array.from(bytes) });
		bytesHeld += bytes.byteLength;
	};
}

function skipCapture(
	path: string,
	bytes: Buffer,
	sha256: string,
	watches: WatchedPath[],
	bytesHeld: number,
): boolean {
	return (
		!isLocalSourcePath(path) ||
		!/\.(?:ts|tsx|mts)$/.test(path) ||
		Buffer.byteLength(path) > 240 ||
		/[:\p{Cc}]/u.test(path) ||
		!safeFeedText(path) ||
		!watches.some((watch) => watch.path === path && watch.inventory?.result.sha256 !== sha256) ||
		bytes.byteLength > LOCAL_EXPORT_LIMITS.fileBytes ||
		bytesHeld + bytes.byteLength > LOCAL_EXPORT_LIMITS.batchBytes
	);
}

async function collectInventories(
	{ signal, current, previewCurrent }: WatchedCapture,
	exportInventory: NonNullable<WatchedCapture["exportInventory"]>,
	due: LocalExportInput[],
	started: number,
	inventories: Map<string, LocalExportResult>,
) {
	const workerDeadline = started + LOCAL_EXPORT_LIMITS.runMs;
	const request = requestSignal(signal, LOCAL_EXPORT_LIMITS.runMs);
	const consentTimer = setInterval(() => {
		try {
			if (previewCurrent() && current()) return;
		} catch {
			// Unavailable consent or authorization also stops optional work.
		}
		request.abort();
	}, CONSENT_POLL_MS);
	try {
		const result = await exportInventory(due, request.signal);
		if (
			!request.signal.aborted &&
			performance.now() < workerDeadline &&
			previewCurrent() &&
			current()
		)
			keepVerified(result, due, inventories);
	} catch {
		// Analyzer failure has no semantic evidence; a verified hash can still invalidate.
	} finally {
		clearInterval(consentTimer);
		request.dispose();
	}
}

function keepVerified(
	result: LocalExportResult[] | undefined,
	due: LocalExportInput[],
	inventories: Map<string, LocalExportResult>,
) {
	for (const item of result ?? []) {
		if (
			validLocalExportResult(item) &&
			due.some((file) => file.path === item.path && file.sha256 === item.sha256)
		)
			inventories.set(item.path, item);
	}
}

/** Rehash the sample; a path whose bytes changed during the parse is raced and keeps no evidence. */
function dropRacedHashes(
	{ checkout, paths, fingerprint }: WatchedCapture,
	rehashDeadline: number,
	hashes: Map<string, string | null>,
	inventories: Map<string, LocalExportResult>,
	raced: Set<string>,
) {
	const sampled =
		performance.now() < rehashDeadline ? fingerprint(checkout, paths, rehashDeadline) : undefined;
	const checked = performance.now() < rehashDeadline ? sampled : undefined;
	for (const [path, oldHash] of hashes) {
		if (checked?.get(path) !== oldHash) {
			hashes.delete(path);
			inventories.delete(path);
			raced.add(path);
		}
	}
}

function readProvenance(checkout: VerifiedCheckout, deadline: number): FeedProvenance | undefined {
	const git = (args: string[]) => {
		const remaining = Math.floor(deadline - performance.now());
		if (remaining < 10) return;
		return spawnSync(
			"/usr/bin/git",
			["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", ...args],
			{
				cwd: checkout.root,
				env: {
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_NO_LAZY_FETCH: "1",
					GIT_TERMINAL_PROMPT: "0",
					GIT_ALLOW_PROTOCOL: "",
				},
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				shell: false,
				timeout: Math.min(500, remaining),
				killSignal: "SIGKILL",
				maxBuffer: 4_096,
			},
		);
	};
	const head = git(["rev-parse", "--verify", "HEAD"]);
	if (
		!head ||
		head.error ||
		head.status !== 0 ||
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n$/.test(head.stdout)
	)
		return;
	const branch = branchName(git(["symbolic-ref", "--quiet", "--short", "HEAD"]));
	if (branch === undefined) return;
	return { head: head.stdout.trim(), branch };
}

/** The checked-out branch, null for a detached HEAD, or undefined when Git's answer is unusable. */
function branchName(branch: SpawnSyncReturns<string> | undefined): string | null | undefined {
	if (!branch || branch.error || ![0, 1].includes(branch.status ?? -1)) return;
	const name = branch.status === 1 ? null : branch.stdout.trim();
	if (name !== null && (!name || name.length > 256 || hasControl(name))) return;
	return name;
}

function deriveOverlapNotices(
	watched: readonly WatchedPath[],
	paths: readonly string[],
	hashes: ReadonlyMap<string, string | null>,
	raced: ReadonlySet<string>,
	observations: readonly FeedObservation[],
	publish: (read: FeedObservation, path: string, hash: string) => boolean,
) {
	const sample = {
		active: new Set(watched.map(({ rootId, path }) => `${rootId}\0${path}`)),
		paths,
		hashes,
		raced,
		publish,
		attempts: 0,
	};
	const settled = new Set<string>();
	for (const read of observations)
		if (read.kind === "read" && readCovered(read, sample)) settled.add(read.id);
	return settled;
}

/** Whether every eligible path of one read reached a terminal overlap outcome. */
function readCovered(
	read: FeedObservation,
	sample: {
		active: Set<string>;
		paths: readonly string[];
		hashes: ReadonlyMap<string, string | null>;
		raced: ReadonlySet<string>;
		publish: (read: FeedObservation, path: string, hash: string) => boolean;
		attempts: number;
	},
): boolean {
	let complete = true;
	for (const path of read.paths) {
		// Ineligible or evicted paths cannot be covered by this bounded producer.
		if (!sample.active.has(`${read.rootId}\0${path}`) || !isLocalSourcePath(path)) continue;
		// A failed rehash invalidates this sample, but is not evidence that the path is ineligible.
		if (!sample.paths.includes(path) || sample.raced.has(path)) {
			complete = false;
			continue;
		}
		const hash = sample.hashes.get(path);
		if (typeof hash !== "string") continue;
		if (sample.attempts >= BATCH_SIZE || !sample.publish(read, path, hash)) complete = false;
		sample.attempts++;
	}
	return complete;
}

/** One producer pass over a checkout's watches, shared by its steps. */
interface ProducerPass {
	cohort: string;
	signIn: string;
	authorizationIdentity: string;
	store: ReturnType<typeof createFeedStore>;
	revision: FeedProvenance;
	current: () => boolean;
	previewCurrent: () => boolean;
	deadline: number;
	selected: WatchedPath[];
	pending: PendingTransition[];
	observations: FeedObservation[];
	pendingEdit: (entry: WatchedPath) => FeedObservation | undefined;
	paths: string[];
	cursor: number;
	sampledAt: number;
	gap: boolean;
}

async function prepareUpdates(
	cohort: string,
	signIn: string,
	authorizationIdentity: string,
	checkout: VerifiedCheckout,
	store: ReturnType<typeof createFeedStore>,
	fingerprint: NonNullable<FeedMaintenanceOptions["fingerprint"]>,
	provenance: NonNullable<FeedMaintenanceOptions["provenance"]>,
	now: () => number,
	current: () => boolean,
	deadline: number,
	previewCurrent: () => boolean,
	analysis: Pick<WatchedCapture, "exportInventory" | "signal">,
) {
	if (!current()) return;
	const before = store.readProducerState({ cohort });
	const revision = provenance(checkout, deadline);
	if (!revision) return;
	if (branchMoved(before, revision)) {
		store.clearFeedScope({ cohort, authorizationIdentity });
		return;
	}
	const watched = restoredWatches(before, analysis, authorizationIdentity, revision.head, now);
	let gap = before?.publicationGap === true;
	const pending = restoredTransitions(before?.pendingTransitions, analysis.exportInventory);
	const observations = store.readObservations({ cohort });
	addObservedWatches(watched, observations);
	const selected = watched.slice(-MAX_WATCHED);
	gap = trimWatches(selected) || gap;
	const pendingEdit = (entry: WatchedPath) => latestEdit(observations, entry);
	const cursor = savedCursor(before);
	const paths = samplePaths(selected, pendingEdit, cursor);
	if (performance.now() >= deadline) return;
	const sampledAt = now();
	const capture = await captureWatchedExportInventories({
		checkout,
		paths,
		watches: selected,
		fingerprint,
		current,
		previewCurrent,
		deadline,
		...analysis,
	});
	if (!capture || !current() || performance.now() >= deadline) return;
	const pass: ProducerPass = {
		cohort,
		signIn,
		authorizationIdentity,
		store,
		revision,
		current,
		previewCurrent,
		deadline,
		selected,
		pending,
		observations,
		pendingEdit,
		paths,
		cursor,
		sampledAt,
		gap,
	};
	applySample(
		pass,
		capture,
		recheckRevision(provenance, checkout, pass, capture.provenanceDeadline),
	);
}

function branchMoved(
	before: ReturnType<ReturnType<typeof createFeedStore>["readProducerState"]>,
	revision: FeedProvenance,
): boolean {
	return Object.hasOwn(before ?? {}, "branch") && before?.branch !== revision.branch;
}

/** Saved watches, keeping an export receipt only while it still matches this head and sign-in. */
function restoredWatches(
	before: ReturnType<ReturnType<typeof createFeedStore>["readProducerState"]>,
	analysis: Pick<WatchedCapture, "exportInventory">,
	authorizationIdentity: string,
	head: string,
	now: () => number,
): WatchedPath[] {
	const watched = watchers(before?.watched);
	const baselineTime = now();
	for (const entry of watched) {
		if (
			!analysis.exportInventory ||
			!exportReceipt(entry, authorizationIdentity, head, baselineTime)
		)
			delete entry.inventory;
	}
	return watched;
}

/** Saved transitions that still parse; a preview fact survives only with an export analyzer. */
function restoredTransitions(
	value: unknown,
	exportInventory: WatchedCapture["exportInventory"],
): PendingTransition[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(isPendingTransition)
		.slice(0, MAX_WATCHED)
		.map(({ id, rootId, agentId, path, hash, head, branch, fact }) => ({
			id,
			rootId,
			agentId,
			path,
			hash,
			head,
			branch,
			...(exportInventory &&
			safeFeedText(fact) &&
			feedPayloadBytes(fact) <= FEED_EVENT_BYTES &&
			fact.startsWith("Saved exports ")
				? { fact }
				: {}),
		}));
}

function isPendingTransition(entry: PendingTransition): entry is PendingTransition {
	return Boolean(
		entry &&
			/^[a-f0-9-]{36}$/.test(entry.id) &&
			(entry.hash === null ||
				(typeof entry.hash === "string" && /^[a-f0-9]{64}$/.test(entry.hash))) &&
			watchers([{ path: entry.path, rootId: entry.rootId, hash: entry.hash, sampledAt: 0 }])
				.length === 1 &&
			validAgentId(entry.agentId) &&
			/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.head) &&
			validBranch(entry.branch),
	);
}

function validAgentId(agentId: unknown): boolean {
	return (
		typeof agentId === "string" &&
		agentId.length > 0 &&
		agentId.length <= 256 &&
		!hasControl(agentId)
	);
}

function validBranch(branch: unknown): boolean {
	return (
		branch === null || (typeof branch === "string" && branch.length <= 256 && !hasControl(branch))
	);
}

function addObservedWatches(watched: WatchedPath[], observations: FeedObservation[]) {
	for (const observation of observations) {
		for (const path of observation.paths) {
			if (!watched.some((entry) => entry.rootId === observation.rootId && entry.path === path))
				watched.push({ rootId: observation.rootId, path, sampledAt: 0 });
		}
	}
}

/** The newest edit of a watch that came after its last sample. */
function latestEdit(observations: FeedObservation[], entry: WatchedPath) {
	return [...observations]
		.reverse()
		.find(
			(observation) =>
				observation.kind === "edit" &&
				observation.rootId === entry.rootId &&
				observation.paths.includes(entry.path) &&
				observation.createdAt > entry.sampledAt,
		);
}

function savedCursor(before: ReturnType<ReturnType<typeof createFeedStore>["readProducerState"]>) {
	return Number.isSafeInteger(before?.cursor) ? Number(before?.cursor) : 0;
}

/** Up to a batch of paths: pending edits first, then the watches in rotation from the cursor. */
function samplePaths(
	selected: WatchedPath[],
	pendingEdit: (entry: WatchedPath) => FeedObservation | undefined,
	cursor: number,
): string[] {
	const rotated = selected.length
		? [...selected.slice(cursor % selected.length), ...selected.slice(0, cursor % selected.length)]
		: [];
	const ordered = [...selected.filter(pendingEdit), ...rotated];
	return [...new Set(ordered.map((entry) => entry.path))].slice(0, BATCH_SIZE);
}

/** After the capture: whether the checkout still has the sampled revision. Undefined when unknown. */
function recheckRevision(
	provenance: NonNullable<FeedMaintenanceOptions["provenance"]>,
	checkout: VerifiedCheckout,
	{ revision, current, deadline }: ProducerPass,
	provenanceDeadline: number | undefined,
): "same" | "moved" | undefined {
	const recheckUntil = provenanceDeadline ?? deadline;
	if (performance.now() >= recheckUntil) return;
	const afterRevision = provenance(checkout, recheckUntil);
	if (!current() || performance.now() >= recheckUntil) return;
	// A bounded post-parse check can time out. Only a valid mismatch clears scope.
	if (!afterRevision && provenanceDeadline !== undefined) return;
	if (
		!afterRevision ||
		afterRevision.branch !== revision.branch ||
		afterRevision.head !== revision.head
	)
		return "moved";
	return "same";
}

/** Record the sample's transitions and baselines, persist them, publish, then acknowledge reads. */
function applySample(
	pass: ProducerPass,
	capture: NonNullable<Awaited<ReturnType<typeof captureWatchedExportInventories>>>,
	recheck: "same" | "moved" | undefined,
) {
	if (!recheck) return;
	if (recheck === "moved") {
		pass.store.clearFeedScope({
			cohort: pass.cohort,
			authorizationIdentity: pass.authorizationIdentity,
		});
		return;
	}
	const { hashes, inventories, raced } = capture;
	const discardPreview = () => {
		for (const entry of pass.selected) delete entry.inventory;
		for (const transition of pass.pending) delete transition.fact;
	};
	if (!pass.previewCurrent()) {
		inventories.clear();
		discardPreview();
	}
	recordTransitions(pass, hashes, inventories);
	pass.gap = trimWatches(pass.selected) || pass.gap;
	const persist = () => persistProducerState(pass, discardPreview);
	if (!persist() || !publishTransitions(pass, persist)) return;
	acknowledgeSettled(pass, hashes, raced);
}

/** Queue a transition for each changed watch and move its baseline to this sample. */
function recordTransitions(
	pass: ProducerPass,
	hashes: Map<string, string | null>,
	inventories: Map<string, LocalExportResult>,
) {
	for (const entry of pass.selected) {
		if (!hashes.has(entry.path)) continue;
		const hash = hashes.get(entry.path);
		if (hash === undefined) continue;
		const edit = pass.pendingEdit(entry);
		const next = inventories.get(entry.path);
		if (entry.hash !== undefined ? entry.hash !== hash : Boolean(edit)) {
			const queued = queueTransition(pass, entry, hash, edit, next);
			if (queued !== "queued") pass.gap = true;
			if (queued === "deferred") continue;
		}
		if (hash !== entry.hash) delete entry.inventory;
		if (next)
			entry.inventory = {
				version: 1,
				authorizationIdentity: pass.authorizationIdentity,
				head: pass.revision.head,
				capturedAt: pass.sampledAt,
				result: next,
			};
		entry.hash = hash;
		entry.sampledAt = pass.sampledAt;
	}
}

/** "deferred" keeps the old baseline so the change is seen again; "gap" moves it on. */
function queueTransition(
	pass: ProducerPass,
	entry: WatchedPath,
	hash: string | null,
	edit: FeedObservation | undefined,
	next: LocalExportResult | undefined,
): "queued" | "gap" | "deferred" {
	if (pass.pending.length >= MAX_WATCHED) return "deferred";
	const transition: PendingTransition = {
		id: randomUUID(),
		rootId: entry.rootId,
		agentId: edit?.agentId ?? "unknown",
		path: entry.path,
		hash,
		head: pass.revision.head,
		branch: pass.revision.branch,
	};
	const fact = exportFact(entry.inventory?.result, next);
	if (fact) transition.fact = fact;
	if (
		transition.fact &&
		!fitsTransition(transition, pass.cohort, pass.authorizationIdentity, transition.fact)
	)
		delete transition.fact;
	// An impossible packet is a coverage gap, not a perpetually retrying item.
	if (!fitsTransition(transition, pass.cohort, pass.authorizationIdentity)) return "gap";
	if (
		Buffer.byteLength(JSON.stringify([...pass.pending, transition]), "utf8") > PRODUCER_PART_BYTES
	)
		return "deferred";
	pass.pending.push(transition);
	return "queued";
}

function exportFact(
	previous: LocalExportResult | undefined,
	next: LocalExportResult | undefined,
): string | undefined {
	if (previous?.status !== "complete" || next?.status !== "complete") return;
	const fact = exportChanges(previous.exports, next.exports);
	return fact && safeFeedText(fact) ? fact : undefined;
}

// A transition and its new baseline persist together before publication. Its
// stable attempt ID survives failure, but a later recurrence gets a new ID.
function persistProducerState(pass: ProducerPass, discardPreview: () => void) {
	if (!pass.current() || performance.now() >= pass.deadline) return false;
	if (!pass.previewCurrent()) discardPreview();
	return pass.store.updateProducerState({
		cohort: pass.cohort,
		signIn: pass.signIn,
		authorizationIdentity: pass.authorizationIdentity,
		state: {
			version: 1,
			branch: pass.revision.branch,
			head: pass.revision.head,
			watched: pass.selected,
			cursor: (pass.cursor + BATCH_SIZE) % Math.max(pass.selected.length, 1),
			pendingTransitions: pass.pending,
			publicationGap: pass.gap,
		},
	});
}

/** Publish pending transitions in order. False when the pass must stop. */
function publishTransitions(pass: ProducerPass, persist: () => boolean): boolean {
	for (const transition of [...pass.pending]) {
		if (!pass.current() || performance.now() >= pass.deadline) return false;
		const published = publishTransition(pass, transition);
		if (published === "stop") return false;
		if (!published) continue;
		pass.pending = pass.pending.filter((entry) => entry.id !== transition.id);
		if (!persist()) return false;
	}
	return true;
}

/** The invalidation, then its preview fact. True once both that apply are published. */
function publishTransition(pass: ProducerPass, transition: PendingTransition): boolean | "stop" {
	const { cohort, authorizationIdentity } = pass;
	if (!pass.store.publishFinding(transitionFinding(transition, cohort, authorizationIdentity)))
		return false;
	if (!transition.fact || !pass.previewCurrent()) return true;
	if (!pass.current() || performance.now() >= pass.deadline) return "stop";
	return Boolean(
		pass.store.publishFinding(
			transitionFinding(transition, cohort, authorizationIdentity, transition.fact),
		),
	);
}

function acknowledgeSettled(
	pass: ProducerPass,
	hashes: Map<string, string | null>,
	raced: Set<string>,
) {
	const { selected, observations } = pass;
	const settledReads = pass.previewCurrent()
		? deriveOverlapNotices(selected, pass.paths, hashes, raced, observations, (read, path, hash) =>
				publishOverlap(pass, read, path, hash),
			)
		: null;
	if (!pass.current()) return;
	// Base reads only register bounded interests. Preview reads also need a terminal
	// overlap outcome, while an edit needs evidence from a non-raced sample.
	const completed = observations.filter((observation) =>
		observation.kind === "read"
			? settledReads === null || settledReads.has(observation.id)
			: observation.paths.every(
					(path) =>
						!raced.has(path) &&
						selected.some(
							(entry) =>
								entry.rootId === observation.rootId &&
								entry.path === path &&
								entry.sampledAt >= observation.createdAt,
						),
				),
	);
	pass.store.acknowledgeObservations({
		cohort: pass.cohort,
		authorizationIdentity: pass.authorizationIdentity,
		ids: completed.map((entry) => entry.id),
	});
}

function publishOverlap(
	pass: ProducerPass,
	read: FeedObservation,
	path: string,
	hash: string,
): boolean {
	if (!pass.current() || !pass.previewCurrent() || performance.now() >= pass.deadline) return false;
	return (
		pass.store.publishOverlap({
			cohort: pass.cohort,
			rootId: read.rootId,
			agentId: read.agentId,
			observationId: read.id,
			path,
			provenance: {
				head: pass.revision.head,
				branch: pass.revision.branch ?? undefined,
				fingerprint: hash,
			},
			authorizationIdentity: pass.authorizationIdentity,
		}) !== "retry"
	);
}

function fitsTransition(
	transition: PendingTransition,
	cohort: string,
	authorizationIdentity: string,
	fact?: string,
): boolean {
	return (
		feedPayloadBytes(
			formatFeedEvent({
				...transitionFinding(transition, cohort, authorizationIdentity, fact),
				id: transition.id,
				sequence: 0,
				createdAt: 0,
			}),
		) <= FEED_EVENT_BYTES
	);
}

/** A maintenance run's admitted scope, shared by its steps. */
interface MaintenanceRun {
	job: FeedMaintenanceJob;
	options: FeedMaintenanceOptions;
	deadline: number;
	now: () => number;
	credentialsPath: string;
	scopeOptions: { home?: string; credentialsPath: string; now: () => number };
	signIn: string;
	issuer: string;
	cohort: string;
	checkoutIdentity: string;
	current: () => boolean;
}

type Analyzer = ReturnType<typeof installedLocalAnalyzer>;

/**
 * Refresh one checkout's short-lived authorization and prepare at most four
 * confined hashes. Failure is quiet and cannot restore a replaced sign-in.
 * @param job Inputs from a registered native hook, validated again here.
 * @param options Deterministic test boundaries; production uses pinned local IO.
 * @returns Whether this run held the maintenance lease; not a delivery receipt.
 */
export async function runFeedMaintenance(
	job: FeedMaintenanceJob,
	options: FeedMaintenanceOptions = {},
): Promise<boolean> {
	const deadline = Math.min(options.deadline ?? Infinity, performance.now() + RUN_MS);
	let root: string | undefined;
	let admission: ReturnType<typeof claimRun> = null;
	const request: { dispose?: () => void } = {};
	const now = options.now ?? Date.now;
	try {
		const admitted = admittedJob(job, options, deadline, now);
		if (!admitted) return false;
		root = ensureFeedRoot(admitted.scopeOptions);
		const run: MaintenanceRun = { ...admitted, current: currentCheck(admitted) };
		if (!run.current()) return false;
		const store = feedStore(run);
		const prior = priorAccess(run, store);
		admission = claimMaintenance(root, run, prior.proof);
		if (!admission) return false;
		const owned = admission.entry;
		const leaseCurrent = () => root !== undefined && ownsRun(root, owned, now());
		await maintainCheckout(run, store, prior, admission.refresh, leaseCurrent, request, root);
		return true;
	} catch {
		return false;
	} finally {
		request.dispose?.();
		if (root && admission) {
			try {
				releaseRun(root, admission.entry, now());
			} catch {
				/* Optional work must not affect the client. */
			}
		}
	}
}

/** The job's scope once its sign-in, server, checkout and cohort still match; otherwise null. */
function admittedJob(
	job: FeedMaintenanceJob,
	options: FeedMaintenanceOptions,
	deadline: number,
	now: () => number,
): Omit<MaintenanceRun, "current"> | null {
	if (blocked(job, options, deadline)) return null;
	const credentialsPath = credentialsFile(job);
	const scopeOptions = { home: job.home, credentialsPath, now };
	const signIn = readFeedSignInGeneration(scopeOptions);
	const issuer = feedServerOrigin(job.server);
	if (
		!signIn ||
		signIn !== job.signIn ||
		!issuer ||
		resolveFeedCheckout(job.checkout) !== job.checkout
	)
		return null;
	const cohort = deriveFeedCohortKey({ ...job, signIn });
	if (!cohort || cohort !== job.cohort) return null;
	const checkoutIdentity = feedCheckoutIdentity(job.checkout);
	if (!checkoutIdentity) return null;
	return {
		job,
		options,
		deadline,
		now,
		credentialsPath,
		scopeOptions,
		signIn,
		issuer,
		cohort,
		checkoutIdentity,
	};
}

function blocked(
	job: FeedMaintenanceJob,
	options: FeedMaintenanceOptions,
	deadline: number,
): boolean {
	return !validJob(job) || performance.now() >= deadline || Boolean(options.signal?.aborted);
}

function feedStore({ options, scopeOptions }: MaintenanceRun) {
	return options.store ?? createFeedStore(scopeOptions);
}

/** Take the run's lease; it may refresh access when no proof is saved or it is due to expire. */
function claimMaintenance(
	root: string,
	{ cohort, signIn, now }: MaintenanceRun,
	proof: FeedAccessProof | null,
) {
	return claimRun(root, cohort, signIn, !proof || proof.expiresAt - now() <= REFRESH_MS, now());
}

function credentialsFile(job: FeedMaintenanceJob): string {
	return job.credentialsPath ?? join(job.home ?? homedir(), ".pharaoh", "credentials.json");
}

/** Whether the run may still act: time, sign-in, checkout, server, cancellation and profile. */
function currentCheck(run: Omit<MaintenanceRun, "current">): () => boolean {
	const { job, options, deadline, now, credentialsPath, scopeOptions, signIn, issuer } = run;
	return () =>
		performance.now() < deadline &&
		readFeedSignInGeneration(scopeOptions) === signIn &&
		feedCheckoutIdentity(job.checkout) === run.checkoutIdentity &&
		feedServerOrigin(readCredentials(credentialsPath)?.sse_url) === issuer &&
		!options.signal?.aborted &&
		resolveFeedProfile({
			...scopeOptions,
			client: job.client,
			registration: job.registration,
			cohort: run.cohort,
			event: "PostToolUse",
			now: now(),
		}).admit;
}

/** The saved proof and authorization; a proof for another checkout identity clears its scope. */
function priorAccess(
	{ cohort, checkoutIdentity }: MaintenanceRun,
	store: ReturnType<typeof createFeedStore>,
) {
	let proof = store.readAccessProof({ cohort });
	const authorization = store.currentAuthorizationIdentity({ cohort });
	if (proof && proof.checkoutIdentity !== checkoutIdentity) {
		if (authorization) store.clearFeedScope({ cohort, authorizationIdentity: authorization });
		proof = null;
	}
	return { proof, authorization };
}

/** Verify the checkout, refresh access when admitted to, then produce from current proof. */
async function maintainCheckout(
	run: MaintenanceRun,
	store: ReturnType<typeof createFeedStore>,
	prior: ReturnType<typeof priorAccess>,
	refresh: boolean,
	leaseCurrent: () => boolean,
	request: { dispose?: () => void },
	root: string,
) {
	const analyzer =
		run.options.resolveCheckout && run.options.fingerprint ? undefined : installedLocalAnalyzer();
	const checkout = verifiedCheckout(run, analyzer);
	if (!checkout || !run.current()) return;
	if (priorRepoMoved(run, store, prior, checkout)) return;
	if (refresh && !(await refreshAccess(run, store, checkout, leaseCurrent, request))) return;
	const access = currentProof(run, store, checkout);
	if (!access) return;
	await produce(run, store, checkout, analyzer, access, leaseCurrent, root);
}

function verifiedCheckout(run: MaintenanceRun, analyzer: Analyzer) {
	const resolveCheckout: NonNullable<FeedMaintenanceOptions["resolveCheckout"]> =
		run.options.resolveCheckout ??
		((cwd: string) => {
			if (!analyzer) return null;
			const evidence = resolveLocalCheckout(cwd, analyzer.reader, run.deadline);
			return evidence.kind === "checkout" ? evidence.checkout : null;
		});
	const checkout = resolveCheckout(run.job.checkout);
	if (!checkout || checkout.root !== run.job.checkout || !SLUG.test(checkout.repoSlug)) return null;
	return checkout;
}

/** A saved proof for another repository clears its scope and ends the run. */
function priorRepoMoved(
	{ cohort }: MaintenanceRun,
	store: ReturnType<typeof createFeedStore>,
	prior: ReturnType<typeof priorAccess>,
	checkout: VerifiedCheckout,
): boolean {
	if (!prior.proof || prior.proof.repo.toLowerCase() === checkout.repoSlug.toLowerCase())
		return false;
	if (prior.authorization)
		store.clearFeedScope({ cohort, authorizationIdentity: prior.authorization });
	return true;
}

/** Ask Pharaoh for fresh access proof. False when the run must stop. */
async function refreshAccess(
	run: MaintenanceRun,
	store: ReturnType<typeof createFeedStore>,
	checkout: VerifiedCheckout,
	leaseCurrent: () => boolean,
	request: { dispose?: () => void },
): Promise<boolean> {
	const { cohort, current, deadline } = run;
	const credentials = readCredentials(run.credentialsPath);
	if (!credentials || !current() || performance.now() >= deadline) return false;
	const requestStartedAt = run.now();
	const expectedRevision = store.readScopeRevision({ cohort });
	if (!expectedRevision) return false;
	const signalled = requestSignal(
		run.options.signal,
		Math.max(1, Math.min(2_000, Math.floor(deadline - performance.now()))),
	);
	request.dispose = signalled.dispose;
	const response = await postFeedAccess(run, credentials.access_token, checkout, signalled.signal);
	if (!current() || !leaseCurrent() || store.readScopeRevision({ cohort }) !== expectedRevision)
		return false;
	if ([401, 402, 403, 409, 410].includes(response.status)) {
		void response.body?.cancel().catch(() => {});
		store.clearFeedScope({ cohort, expectedRevision });
		return false;
	}
	if (response.status !== 200) {
		void response.body?.cancel().catch(() => {});
		return true;
	}
	return publishAccess(
		run,
		store,
		checkout,
		response,
		requestStartedAt,
		expectedRevision,
		leaseCurrent,
	);
}

function postFeedAccess(
	{ issuer, options }: MaintenanceRun,
	accessToken: string,
	checkout: VerifiedCheckout,
	signal: AbortSignal,
) {
	return (options.fetch ?? fetch)(new URL("/api/local/v1/feed-access", issuer), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ version: 1, repoSlug: checkout.repoSlug }),
		redirect: "error",
		cache: "no-store",
		signal,
	});
}

/** Save the access Pharaoh answered as proof. False when the run must stop. */
async function publishAccess(
	run: MaintenanceRun,
	store: ReturnType<typeof createFeedStore>,
	checkout: VerifiedCheckout,
	response: Response,
	requestStartedAt: number,
	expectedRevision: string,
	leaseCurrent: () => boolean,
): Promise<boolean> {
	const access = parseAccess(await boundedResponse(response), checkout.repoSlug);
	if (!run.current() || !leaseCurrent() || !access || run.now() >= requestStartedAt + PROOF_MS)
		return false;
	return Boolean(
		store.putAccessProof({
			cohort: run.cohort,
			expectedRevision,
			proof: {
				version: 1,
				...access,
				issuer: run.issuer,
				signIn: run.signIn,
				checkout: checkout.root,
				checkoutIdentity: run.checkoutIdentity,
				requestedAt: requestStartedAt,
				expiresAt: requestStartedAt + PROOF_MS,
			},
		}),
	);
}

/** The proof and authorization this run produces under, or null when either no longer holds. */
function currentProof(
	{ cohort, current, checkoutIdentity }: MaintenanceRun,
	store: ReturnType<typeof createFeedStore>,
	checkout: VerifiedCheckout,
) {
	const authorizationIdentity = store.currentAuthorizationIdentity({ cohort });
	const proof = store.readAccessProof({ cohort });
	if (
		!current() ||
		!proof ||
		proof.checkoutIdentity !== checkoutIdentity ||
		proof.repo.toLowerCase() !== checkout.repoSlug.toLowerCase() ||
		!authorizationIdentity
	)
		return null;
	return { proof, authorizationIdentity };
}

/** Prepare saved-file updates, then refresh watched hosted publications. */
async function produce(
	run: MaintenanceRun,
	store: ReturnType<typeof createFeedStore>,
	checkout: VerifiedCheckout,
	analyzer: Analyzer,
	{ proof, authorizationIdentity }: NonNullable<ReturnType<typeof currentProof>>,
	leaseCurrent: () => boolean,
	root: string,
) {
	const { job, options, cohort, now, deadline } = run;
	const currentScope = () =>
		run.current() &&
		leaseCurrent() &&
		store.currentAuthorizationIdentity({ cohort }) === authorizationIdentity;
	const fingerprint: NonNullable<FeedMaintenanceOptions["fingerprint"]> =
		options.fingerprint ??
		((verified, paths, until, visit) =>
			analyzer
				? fingerprintLocalSources(verified, analyzer.reader, paths, until, visit)
				: undefined);
	const previewCurrent = () => nativeFeedPreviewEnabled(job.client, run.scopeOptions);
	const exportInventory =
		options.exportInventory ??
		(analyzer?.savedExportInventoryV1
			? (files: LocalExportInput[], signal: AbortSignal) =>
					runLocalExportInventory(analyzer, files, signal)
			: undefined);
	await prepareUpdates(
		cohort,
		run.signIn,
		authorizationIdentity,
		checkout,
		store,
		fingerprint,
		options.provenance ?? readProvenance,
		now,
		currentScope,
		deadline,
		previewCurrent,
		{ exportInventory, signal: options.signal },
	);
	await refreshWatchedPublication({
		job,
		root,
		credentialsPath: run.credentialsPath,
		proof,
		authorizationIdentity,
		store,
		deadline,
		current: currentScope,
		now,
		options,
	});
}
