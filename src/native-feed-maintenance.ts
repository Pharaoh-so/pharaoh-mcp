/** Bounded background preparation for native context; no source bytes leave this process. */
import { spawnSync } from "node:child_process";
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
			/^[a-f0-9-]{36}$/.test(value.signIn ?? "") &&
			/^[a-f0-9]{64}$/.test(value.cohort ?? "") &&
			typeof value.checkout === "string" &&
			typeof value.rootId === "string" &&
			value.rootId.length > 0 &&
			value.rootId.length <= 256 &&
			!hasControl(value.rootId) &&
			feedServerOrigin(value.server) &&
			Array.isArray(value.serverArgv),
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
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { publication, ...scope } = value as Record<string, unknown> & {
		publication?: HostedFeedPublication | null;
	};
	if (!Object.hasOwn(value, "publication")) return undefined;
	const access = parseAccess(scope, proof.repo);
	if (!access || access.actor !== proof.actor || access.repo !== proof.repo) return undefined;
	if (access.owner !== proof.owner || access.epoch !== proof.epoch) return "scope-changed";
	if (publication === null) return null;
	const rows = publication?.modules;
	if (
		!Array.isArray(rows) ||
		rows.length !== modules.length ||
		!modules.every((module) => rows.some((row) => row?.module === module))
	)
		return undefined;
	return publication;
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

async function refreshWatchedPublication({
	job,
	root,
	credentialsPath,
	proof,
	authorizationIdentity,
	store,
	deadline,
	current,
	now,
	options,
}: PublicationRefresh) {
	const scope = { cohort: job.cohort, authorizationIdentity };
	const eligible = () =>
		current() &&
		nativeFeedPreviewEnabled(job.client, job) &&
		resolveFeedProfile({ ...job, credentialsPath, event: "PostToolUse", now: now() }).admit;
	let disposeRequest: (() => void) | undefined;
	try {
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
		const request = requestSignal(options.signal, timeout);
		disposeRequest = request.dispose;
		const response = await (options.fetch ?? fetch)(
			new URL("/api/local/v1/feed-publication", proof.issuer),
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.access_token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ version: 1, repoSlug: proof.repo, modules }),
				redirect: "error",
				cache: "no-store",
				signal: request.signal,
			},
		);
		if (request.signal.aborted || performance.now() >= deadline || !current()) {
			void response.body?.cancel().catch(() => {});
			return;
		}
		if (response.status !== 200) {
			void response.body?.cancel().catch(() => {});
			if ([401, 402, 403].includes(response.status)) store.clearFeedScope(scope);
			else if (response.status === 409 && eligible()) store.retireHostedModuleNotices(scope);
			return;
		}
		const publication = publicationResponse(
			await boundedResponse(response, PUBLICATION_BYTES),
			proof,
			modules,
		);
		if (request.signal.aborted || performance.now() >= deadline || !current()) return;
		if (publication === "scope-changed") {
			store.clearFeedScope(scope);
			return;
		}
		if (!eligible()) return;
		if (publication === null) store.retireHostedModuleNotices(scope);
		else if (publication) store.applyHostedModulePublication({ ...scope, publication });
	} catch {
		// Optional publication requests leave ordinary worktree handling operational.
		return;
	} finally {
		disposeRequest?.();
	}
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
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	if (
		Object.keys(row).sort().join() !== "accessEpoch,githubUserId,repoSlug,tenantId,version" ||
		row.version !== 1 ||
		!Number.isSafeInteger(row.githubUserId) ||
		Number(row.githubUserId) < 1 ||
		typeof row.tenantId !== "string" ||
		!row.tenantId ||
		row.tenantId.length > 128 ||
		typeof row.repoSlug !== "string" ||
		!SLUG.test(row.repoSlug) ||
		row.repoSlug.toLowerCase() !== repo.toLowerCase() ||
		!Number.isSafeInteger(row.accessEpoch) ||
		Number(row.accessEpoch) < 1
	)
		return null;
	return {
		actor: Number(row.githubUserId),
		owner: row.tenantId,
		repo: row.repoSlug,
		epoch: Number(row.accessEpoch),
	};
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
		!Number.isFinite(value.capturedAt) ||
		value.capturedAt > now ||
		value.capturedAt <= now - INVENTORY_TTL_MS ||
		!validLocalExportResult(value.result) ||
		value.result.sha256 !== entry.hash ||
		value.result.path !== entry.path
	)
		return;
	return value;
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
	const {
		checkout,
		paths,
		watches,
		fingerprint,
		exportInventory,
		current,
		previewCurrent,
		deadline,
		signal,
	} = input;
	const inventories = new Map<string, LocalExportResult>();
	const raced = new Set<string>();
	const files: LocalExportInput[] = [];
	let bytesHeld = 0;
	const provenanceDeadline = deadline - PERSIST_RESERVE_MS;
	const rehashDeadline = provenanceDeadline - PROVENANCE_RESERVE_MS;
	const latestWorkerStart = rehashDeadline - REHASH_RESERVE_MS - LOCAL_EXPORT_LIMITS.runMs;
	const visit =
		exportInventory && performance.now() < latestWorkerStart && previewCurrent()
			? (path: string, bytes: Buffer, sha256: string) => {
					if (
						!isLocalSourcePath(path) ||
						!/\.(?:ts|tsx|mts)$/.test(path) ||
						Buffer.byteLength(path) > 240 ||
						/[:\p{Cc}]/u.test(path) ||
						!safeFeedText(path) ||
						!watches.some(
							(watch) => watch.path === path && watch.inventory?.result.sha256 !== sha256,
						) ||
						bytes.byteLength > LOCAL_EXPORT_LIMITS.fileBytes ||
						bytesHeld + bytes.byteLength > LOCAL_EXPORT_LIMITS.batchBytes
					)
						return;
					// Do not serialize a Buffer view whose backing allocation also held other captured files.
					files.push({ path, sha256, bytes: Uint8Array.from(bytes) });
					bytesHeld += bytes.byteLength;
				}
			: undefined;
	const hashes = paths.length
		? fingerprint(checkout, paths, deadline, visit)
		: new Map<string, string | null>();
	if (!hashes || !current() || performance.now() >= deadline) return;
	const due = files.filter((file) => hashes.get(file.path) === file.sha256);
	const started = performance.now();
	if (!exportInventory || !due.length || started >= latestWorkerStart || !previewCurrent())
		return { hashes, inventories, raced };
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
		) {
			for (const item of result ?? []) {
				if (
					validLocalExportResult(item) &&
					due.some((file) => file.path === item.path && file.sha256 === item.sha256)
				)
					inventories.set(item.path, item);
			}
		}
	} catch {
		// Analyzer failure has no semantic evidence; a verified hash can still invalidate.
	} finally {
		clearInterval(consentTimer);
		request.dispose();
	}
	if (!current() || performance.now() >= deadline) return;
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
	return { hashes, inventories, raced, provenanceDeadline };
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
	const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (!branch || branch.error || ![0, 1].includes(branch.status ?? -1)) return;
	const name = branch.status === 1 ? null : branch.stdout.trim();
	if (name !== null && (!name || name.length > 256 || hasControl(name))) return;
	return { head: head.stdout.trim(), branch: name };
}

function deriveOverlapNotices(
	watched: readonly WatchedPath[],
	paths: readonly string[],
	hashes: ReadonlyMap<string, string | null>,
	raced: ReadonlySet<string>,
	observations: readonly FeedObservation[],
	publish: (read: FeedObservation, path: string, hash: string) => boolean,
) {
	let attempts = 0;
	const settled = new Set<string>();
	const active = new Set(watched.map(({ rootId, path }) => `${rootId}\0${path}`));
	for (const read of observations) {
		if (read.kind !== "read") continue;
		let complete = true;
		for (const path of read.paths) {
			// Ineligible or evicted paths cannot be covered by this bounded producer.
			if (!active.has(`${read.rootId}\0${path}`) || !isLocalSourcePath(path)) continue;
			// A failed rehash invalidates this sample, but is not evidence that the path is ineligible.
			if (!paths.includes(path) || raced.has(path)) {
				complete = false;
				continue;
			}
			const hash = hashes.get(path);
			if (typeof hash !== "string") continue;
			if (attempts >= BATCH_SIZE || !publish(read, path, hash)) complete = false;
			attempts++;
		}
		if (complete) settled.add(read.id);
	}
	return settled;
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
	if (Object.hasOwn(before ?? {}, "branch") && before?.branch !== revision.branch) {
		store.clearFeedScope({ cohort, authorizationIdentity });
		return;
	}
	const watched = watchers(before?.watched);
	const baselineTime = now();
	for (const entry of watched) {
		if (
			!analysis.exportInventory ||
			!exportReceipt(entry, authorizationIdentity, revision.head, baselineTime)
		)
			delete entry.inventory;
	}
	let gap = before?.publicationGap === true;
	let pending: PendingTransition[] = [];
	if (Array.isArray(before?.pendingTransitions)) {
		pending = before.pendingTransitions
			.filter((entry): entry is PendingTransition =>
				Boolean(
					entry &&
						/^[a-f0-9-]{36}$/.test(entry.id) &&
						(entry.hash === null ||
							(typeof entry.hash === "string" && /^[a-f0-9]{64}$/.test(entry.hash))) &&
						watchers([{ path: entry.path, rootId: entry.rootId, hash: entry.hash, sampledAt: 0 }])
							.length === 1 &&
						typeof entry.agentId === "string" &&
						entry.agentId.length > 0 &&
						entry.agentId.length <= 256 &&
						!hasControl(entry.agentId) &&
						/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.head) &&
						(entry.branch === null ||
							(typeof entry.branch === "string" &&
								entry.branch.length <= 256 &&
								!hasControl(entry.branch))),
				),
			)
			.slice(0, MAX_WATCHED)
			.map(({ id, rootId, agentId, path, hash, head, branch, fact }) => ({
				id,
				rootId,
				agentId,
				path,
				hash,
				head,
				branch,
				...(analysis.exportInventory &&
				safeFeedText(fact) &&
				feedPayloadBytes(fact) <= FEED_EVENT_BYTES &&
				fact.startsWith("Saved exports ")
					? { fact }
					: {}),
			}));
	}
	const observations = store.readObservations({ cohort });
	for (const observation of observations) {
		for (const path of observation.paths) {
			if (!watched.some((entry) => entry.rootId === observation.rootId && entry.path === path))
				watched.push({ rootId: observation.rootId, path, sampledAt: 0 });
		}
	}
	const selected = watched.slice(-MAX_WATCHED);
	gap = trimWatches(selected) || gap;
	const pendingEdit = (entry: WatchedPath) =>
		[...observations]
			.reverse()
			.find(
				(observation) =>
					observation.kind === "edit" &&
					observation.rootId === entry.rootId &&
					observation.paths.includes(entry.path) &&
					observation.createdAt > entry.sampledAt,
			);
	const cursor = Number.isSafeInteger(before?.cursor) ? Number(before?.cursor) : 0;
	const rotated = selected.length
		? [...selected.slice(cursor % selected.length), ...selected.slice(0, cursor % selected.length)]
		: [];
	const ordered = [...selected.filter(pendingEdit), ...rotated];
	const paths = [...new Set(ordered.map((entry) => entry.path))].slice(0, BATCH_SIZE);
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
	const { hashes, inventories, raced, provenanceDeadline } = capture;
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
	) {
		store.clearFeedScope({ cohort, authorizationIdentity });
		return;
	}
	const discardPreview = () => {
		for (const entry of selected) delete entry.inventory;
		for (const transition of pending) delete transition.fact;
	};
	if (!previewCurrent()) {
		inventories.clear();
		discardPreview();
	}
	for (const entry of selected) {
		if (!hashes.has(entry.path)) continue;
		const hash = hashes.get(entry.path);
		if (hash === undefined) continue;
		const edit = pendingEdit(entry);
		const next = inventories.get(entry.path);
		const previous = entry.inventory?.result;
		if (entry.hash !== undefined ? entry.hash !== hash : Boolean(edit)) {
			if (pending.length >= MAX_WATCHED) {
				gap = true;
				continue;
			}
			const transition: PendingTransition = {
				id: randomUUID(),
				rootId: entry.rootId,
				agentId: edit?.agentId ?? "unknown",
				path: entry.path,
				hash,
				head: revision.head,
				branch: revision.branch,
			};
			if (previous?.status === "complete" && next?.status === "complete") {
				const fact = exportChanges(previous.exports, next.exports);
				if (fact && safeFeedText(fact)) transition.fact = fact;
			}
			if (
				transition.fact &&
				!fitsTransition(transition, cohort, authorizationIdentity, transition.fact)
			)
				delete transition.fact;
			if (!fitsTransition(transition, cohort, authorizationIdentity)) {
				// An impossible packet is a coverage gap, not a perpetually retrying item.
				gap = true;
			} else if (
				Buffer.byteLength(JSON.stringify([...pending, transition]), "utf8") > PRODUCER_PART_BYTES
			) {
				gap = true;
				continue;
			} else pending.push(transition);
		}
		if (hash !== entry.hash) delete entry.inventory;
		if (next)
			entry.inventory = {
				version: 1,
				authorizationIdentity,
				head: revision.head,
				capturedAt: sampledAt,
				result: next,
			};
		entry.hash = hash;
		entry.sampledAt = sampledAt;
	}
	gap = trimWatches(selected) || gap;
	// A transition and its new baseline persist together before publication. Its
	// stable attempt ID survives failure, but a later recurrence gets a new ID.
	const persist = () => {
		if (!current() || performance.now() >= deadline) return false;
		if (!previewCurrent()) discardPreview();
		return store.updateProducerState({
			cohort,
			signIn,
			authorizationIdentity,
			state: {
				version: 1,
				branch: revision.branch,
				head: revision.head,
				watched: selected,
				cursor: (cursor + BATCH_SIZE) % Math.max(selected.length, 1),
				pendingTransitions: pending,
				publicationGap: gap,
			},
		});
	};
	if (!persist()) return;
	for (const transition of [...pending]) {
		if (!current() || performance.now() >= deadline) return;
		const invalidation = store.publishFinding(
			transitionFinding(transition, cohort, authorizationIdentity),
		);
		if (!invalidation) continue;
		if (transition.fact && previewCurrent()) {
			if (!current() || performance.now() >= deadline) return;
			const enriched = store.publishFinding(
				transitionFinding(transition, cohort, authorizationIdentity, transition.fact),
			);
			if (!enriched) continue;
		}
		pending = pending.filter((entry) => entry.id !== transition.id);
		if (!persist()) return;
	}
	const settledReads = previewCurrent()
		? deriveOverlapNotices(selected, paths, hashes, raced, observations, (read, path, hash) => {
				if (!current() || !previewCurrent() || performance.now() >= deadline) return false;
				return (
					store.publishOverlap({
						cohort,
						rootId: read.rootId,
						agentId: read.agentId,
						observationId: read.id,
						path,
						provenance: {
							head: revision.head,
							branch: revision.branch ?? undefined,
							fingerprint: hash,
						},
						authorizationIdentity,
					}) !== "retry"
				);
			})
		: null;
	if (!current()) return;
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
	store.acknowledgeObservations({
		cohort,
		authorizationIdentity,
		ids: completed.map((entry) => entry.id),
	});
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
	let disposeRequest: (() => void) | undefined;
	const now = options.now ?? Date.now;
	try {
		if (!validJob(job) || performance.now() >= deadline || options.signal?.aborted) return false;
		const credentialsPath =
			job.credentialsPath ?? join(job.home ?? homedir(), ".pharaoh", "credentials.json");
		const scopeOptions = { home: job.home, credentialsPath, now };
		const signIn = readFeedSignInGeneration(scopeOptions);
		const issuer = feedServerOrigin(job.server);
		if (
			!signIn ||
			signIn !== job.signIn ||
			!issuer ||
			resolveFeedCheckout(job.checkout) !== job.checkout
		)
			return false;
		const cohort = deriveFeedCohortKey({ ...job, signIn });
		if (!cohort || cohort !== job.cohort) return false;
		const checkoutIdentity = feedCheckoutIdentity(job.checkout);
		if (!checkoutIdentity) return false;
		root = ensureFeedRoot(scopeOptions);
		const current = () =>
			performance.now() < deadline &&
			readFeedSignInGeneration(scopeOptions) === signIn &&
			feedCheckoutIdentity(job.checkout) === checkoutIdentity &&
			feedServerOrigin(readCredentials(credentialsPath)?.sse_url) === issuer &&
			!options.signal?.aborted &&
			resolveFeedProfile({
				...scopeOptions,
				client: job.client,
				registration: job.registration,
				cohort,
				event: "PostToolUse",
				now: now(),
			}).admit;
		if (!current()) return false;
		const store = options.store ?? createFeedStore(scopeOptions);
		let priorProof = store.readAccessProof({ cohort });
		const priorAuthorization = store.currentAuthorizationIdentity({ cohort });
		if (priorProof && priorProof.checkoutIdentity !== checkoutIdentity) {
			if (priorAuthorization)
				store.clearFeedScope({ cohort, authorizationIdentity: priorAuthorization });
			priorProof = null;
		}
		admission = claimRun(
			root,
			cohort,
			signIn,
			!priorProof || priorProof.expiresAt - now() <= REFRESH_MS,
			now(),
		);
		if (!admission) return false;
		const owned = admission.entry;
		const leaseCurrent = () => root !== undefined && ownsRun(root, owned, now());
		const analyzer =
			options.resolveCheckout && options.fingerprint ? undefined : installedLocalAnalyzer();
		const resolveCheckout: NonNullable<FeedMaintenanceOptions["resolveCheckout"]> =
			options.resolveCheckout ??
			((cwd: string) => {
				if (!analyzer) return null;
				const evidence = resolveLocalCheckout(cwd, analyzer.reader, deadline);
				return evidence.kind === "checkout" ? evidence.checkout : null;
			});
		const checkout = resolveCheckout(job.checkout);
		if (!checkout || checkout.root !== job.checkout || !SLUG.test(checkout.repoSlug) || !current())
			return true;
		if (priorProof && priorProof.repo.toLowerCase() !== checkout.repoSlug.toLowerCase()) {
			if (priorAuthorization)
				store.clearFeedScope({ cohort, authorizationIdentity: priorAuthorization });
			return true;
		}
		if (admission.refresh) {
			const credentials = readCredentials(credentialsPath);
			if (!credentials || !current() || performance.now() >= deadline) return true;
			const requestStartedAt = now();
			const expectedRevision = store.readScopeRevision({ cohort });
			if (!expectedRevision) return true;
			const request = requestSignal(
				options.signal,
				Math.max(1, Math.min(2_000, Math.floor(deadline - performance.now()))),
			);
			const signal = request.signal;
			disposeRequest = request.dispose;
			const response = await (options.fetch ?? fetch)(
				new URL("/api/local/v1/feed-access", issuer),
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${credentials.access_token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ version: 1, repoSlug: checkout.repoSlug }),
					redirect: "error",
					cache: "no-store",
					signal,
				},
			);
			if (!current() || !leaseCurrent() || store.readScopeRevision({ cohort }) !== expectedRevision)
				return true;
			if ([401, 402, 403, 409, 410].includes(response.status)) {
				void response.body?.cancel().catch(() => {});
				store.clearFeedScope({ cohort, expectedRevision });
				return true;
			}
			if (response.status === 200) {
				const access = parseAccess(await boundedResponse(response), checkout.repoSlug);
				if (!current() || !leaseCurrent() || !access || now() >= requestStartedAt + PROOF_MS)
					return true;
				const published = store.putAccessProof({
					cohort,
					expectedRevision,
					proof: {
						version: 1,
						...access,
						issuer,
						signIn,
						checkout: checkout.root,
						checkoutIdentity,
						requestedAt: requestStartedAt,
						expiresAt: requestStartedAt + PROOF_MS,
					},
				});
				if (!published) return true;
			} else void response.body?.cancel().catch(() => {});
		}
		const authorizationIdentity = store.currentAuthorizationIdentity({ cohort });
		const proof = store.readAccessProof({ cohort });
		if (
			!current() ||
			!proof ||
			proof.checkoutIdentity !== checkoutIdentity ||
			proof.repo.toLowerCase() !== checkout.repoSlug.toLowerCase() ||
			!authorizationIdentity
		)
			return true;
		const currentScope = () =>
			current() &&
			leaseCurrent() &&
			store.currentAuthorizationIdentity({ cohort }) === authorizationIdentity;
		const fingerprint: NonNullable<FeedMaintenanceOptions["fingerprint"]> =
			options.fingerprint ??
			((verified, paths, until, visit) =>
				analyzer
					? fingerprintLocalSources(verified, analyzer.reader, paths, until, visit)
					: undefined);
		const previewCurrent = () => nativeFeedPreviewEnabled(job.client, scopeOptions);
		const exportInventory =
			options.exportInventory ??
			(analyzer?.savedExportInventoryV1
				? (files: LocalExportInput[], signal: AbortSignal) =>
						runLocalExportInventory(analyzer, files, signal)
				: undefined);
		await prepareUpdates(
			cohort,
			signIn,
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
			credentialsPath,
			proof,
			authorizationIdentity,
			store,
			deadline,
			current: currentScope,
			now,
			options,
		});
		return true;
	} catch {
		return false;
	} finally {
		disposeRequest?.();
		if (root && admission) {
			try {
				releaseRun(root, admission.entry, now());
			} catch {
				/* Optional work must not affect the client. */
			}
		}
	}
}
