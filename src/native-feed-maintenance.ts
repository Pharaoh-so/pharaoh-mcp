/** Bounded background preparation for native context; no source bytes leave this process. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	deriveFeedCohortKey,
	feedCheckoutIdentity,
	feedServerOrigin,
	readFeedSignInGeneration,
	resolveFeedCheckout,
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
	feedPayloadBytes,
	formatFeedEvent,
} from "../runtime/feed-store.mjs";
import { readCredentials } from "./credentials.js";
import type { VerifiedCheckout } from "./local/dispatch.js";
import { fingerprintLocalSources, resolveLocalCheckout } from "./local/scope.js";
import { installedLocalAnalyzer } from "./local/worker-host.js";

const hasControl = (value: string) => [...value].some((character) => character.charCodeAt(0) < 32);
const MAX_JOB_BYTES = 16_384;
const RUN_MS = 5_000;
const REFRESH_MS = 30_000;
const PROOF_MS = 60_000;
const RESPONSE_BYTES = 1_024;
const MAX_WATCHED = 32;
const PRODUCER_PART_BYTES = 24 * 1024;
const BATCH_SIZE = 4;
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
	/** Verified checkout resolver; production uses the pinned local reader. */
	resolveCheckout?: (cwd: string) => VerifiedCheckout | null;
	/** Confined content hashes only; production never retains returned source bytes. */
	fingerprint?: (
		checkout: VerifiedCheckout,
		paths: string[],
		deadline: number,
	) => Map<string, string | null> | undefined;
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
}

interface PendingTransition {
	id: string;
	rootId: string;
	agentId: string;
	path: string;
	hash: string | null;
	head: string;
	branch: string | null;
}

function transitionFinding(
	transition: PendingTransition,
	cohort: string,
	authorizationIdentity: string,
): FeedFinding {
	return {
		cohort,
		authorizationIdentity,
		rootId: transition.rootId,
		agentId: transition.agentId,
		kind: "invalidation",
		summary:
			transition.agentId === "unknown"
				? "Saved file changed. Author unknown."
				: "Saved file changed.",
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
			if (prior && (prior.inFlightUntil > now || prior.startedAt > now - RUN_MS)) return null;
			if (!prior && entries.length >= 64) return null;
			const canRefresh =
				refresh && (!prior?.refreshAttemptAt || prior.refreshAttemptAt <= now - REFRESH_MS);
			const entry: Admission = {
				cohort,
				signIn,
				id: randomUUID(),
				startedAt: now,
				inFlightUntil: now + RUN_MS,
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

async function boundedResponse(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > RESPONSE_BYTES) return null;
			chunks.push(next.value);
		}
		return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
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
		.slice(-MAX_WATCHED);
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

function prepareUpdates(
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
			.slice(0, MAX_WATCHED);
	}
	const observations = store.readObservations({ cohort });
	for (const observation of observations) {
		for (const path of observation.paths) {
			if (!watched.some((entry) => entry.rootId === observation.rootId && entry.path === path))
				watched.push({ rootId: observation.rootId, path, sampledAt: 0 });
		}
	}
	const selected = watched.slice(-MAX_WATCHED);
	while (Buffer.byteLength(JSON.stringify(selected), "utf8") > PRODUCER_PART_BYTES) {
		selected.shift();
		gap = true;
	}
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
	const hashes = paths.length
		? fingerprint(checkout, paths, deadline)
		: new Map<string, string | null>();
	if (!hashes || !current() || performance.now() >= deadline) return;
	const afterRevision = provenance(checkout, deadline);
	if (
		!afterRevision ||
		afterRevision.branch !== revision.branch ||
		afterRevision.head !== revision.head
	) {
		store.clearFeedScope({ cohort, authorizationIdentity });
		return;
	}
	for (const entry of selected) {
		if (!hashes.has(entry.path)) continue;
		const hash = hashes.get(entry.path);
		if (hash === undefined) continue;
		const edit = pendingEdit(entry);
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
			const rendered = formatFeedEvent({
				...transitionFinding(transition, cohort, authorizationIdentity),
				id: transition.id,
				sequence: 0,
				createdAt: now(),
			});
			if (feedPayloadBytes(rendered) > FEED_EVENT_BYTES) {
				// An impossible packet is a coverage gap, not a perpetually retrying item.
				gap = true;
				entry.hash = hash;
				entry.sampledAt = now();
				continue;
			}
			if (
				Buffer.byteLength(JSON.stringify([...pending, transition]), "utf8") > PRODUCER_PART_BYTES
			) {
				gap = true;
				continue;
			}
			pending.push(transition);
		}
		entry.hash = hash;
		entry.sampledAt = now();
	}
	// A transition and its new baseline persist together before publication. Its
	// stable attempt ID survives failure, but a later recurrence gets a new ID.
	const persist = () =>
		current() &&
		store.updateProducerState({
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
	if (!persist()) return;
	for (const transition of [...pending]) {
		if (!current() || performance.now() >= deadline) return;
		const event = store.publishFinding(
			transitionFinding(transition, cohort, authorizationIdentity),
		);
		if (!event) continue;
		pending = pending.filter((entry) => entry.id !== transition.id);
		if (!persist()) return;
	}
	if (!current()) return;
	const completed = observations.filter(
		(observation) =>
			observation.kind === "read" ||
			observation.paths.every((path) =>
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
	let root: string | undefined;
	let admission: ReturnType<typeof claimRun> = null;
	let disposeRequest: (() => void) | undefined;
	const now = options.now ?? Date.now;
	try {
		if (!validJob(job)) return false;
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
		const registration = readFeedJSON(join(root, `registration-${job.client}.json`), 2_048) as {
			registration?: unknown;
		} | null;
		if (registration?.registration !== job.registration) return false;
		const current = () =>
			readFeedSignInGeneration(scopeOptions) === signIn &&
			feedCheckoutIdentity(job.checkout) === checkoutIdentity &&
			feedServerOrigin(readCredentials(credentialsPath)?.sse_url) === issuer &&
			!options.signal?.aborted;
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
		const deadline = performance.now() + RUN_MS;
		const analyzer =
			options.resolveCheckout && options.fingerprint ? undefined : installedLocalAnalyzer();
		const resolveCheckout: NonNullable<FeedMaintenanceOptions["resolveCheckout"]> =
			options.resolveCheckout ??
			((cwd: string) => {
				if (!analyzer) return null;
				const evidence = resolveLocalCheckout(cwd, analyzer.reader);
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
			if (!current() || store.readScopeRevision({ cohort }) !== expectedRevision) return true;
			if ([401, 402, 403, 409, 410].includes(response.status)) {
				void response.body?.cancel().catch(() => {});
				store.clearFeedScope({ cohort, expectedRevision });
				return true;
			}
			if (response.status === 200) {
				const access = parseAccess(await boundedResponse(response), checkout.repoSlug);
				if (!current() || !access || now() >= requestStartedAt + PROOF_MS) return true;
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
		const proof = store.readAccessProof({ cohort });
		const authorizationIdentity = store.currentAuthorizationIdentity({ cohort });
		if (
			!current() ||
			!proof ||
			proof.checkoutIdentity !== checkoutIdentity ||
			proof.repo.toLowerCase() !== checkout.repoSlug.toLowerCase() ||
			!authorizationIdentity
		)
			return true;
		const fingerprint: NonNullable<FeedMaintenanceOptions["fingerprint"]> =
			options.fingerprint ??
			((verified, paths, until) =>
				analyzer ? fingerprintLocalSources(verified, analyzer.reader, paths, until) : undefined);
		prepareUpdates(
			cohort,
			signIn,
			authorizationIdentity,
			checkout,
			store,
			fingerprint,
			options.provenance ?? readProvenance,
			now,
			() => current() && store.currentAuthorizationIdentity({ cohort }) === authorizationIdentity,
			deadline,
		);
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
