/** Read-only local inspection of authorized native context delivery, without telemetry or value claims. */
import { opendirSync } from "node:fs";
import { join } from "node:path";
import {
	readFeedRegistration,
	readFeedSignInGeneration,
	resolveFeedProfile,
} from "../runtime/feed-identity.mjs";
import { feedRoot, privateFeedPath, readFeedJSON } from "../runtime/feed-io.mjs";
import {
	createFeedStore,
	type FeedAccessProof,
	feedProofIdentity,
} from "../runtime/feed-store.mjs";

const MAX_COHORTS = 32;
const MAX_DIRECTORY_ENTRIES = 64;
const MAX_RESULT_BYTES = 65_536;
const RETENTION_MS = 30 * 60_000;
const HASH = /^[a-f0-9]{64}$/;
const KINDS = new Set(["reported", "proposed", "invalidation", "fact"]);

type RecordValue = Record<string, unknown>;
/** References from one retained event; free-form report text is deliberately excluded. */
export interface NativeFeedStatusEvent {
	/** Finite event kind. */ kind: string;
	/** Repository-relative referenced files. */ references: string[];
	/** Local event creation timestamp. */ createdAt: number;
}
/** Current, authorized local delivery counts for one cohort. */
export interface NativeFeedStatusCohort {
	/** Opaque local routing key. */ cohort: string;
	/** Currently authorized canonical repository. */ repo: string;
	/** Local compatibility coverage, not proof of model receipt. */ compatibility:
		| "eligible"
		| "unavailable"
		| "unknown";
	/** Retained events; events may already have been claimed by a recipient. */ queuedEvents: number;
	/** Recipients active within local retention. */ recipients: number;
	/** Event claims across recipients, counted once per recipient. */ claimedEvents: number;
	/** Output packets acknowledged by the local transport. */ emittedPackets: number;
	/** Claims whose output handoff has not been acknowledged. */ pendingClaims: number;
	/** Recent bounded event references without report contents. */ events: NativeFeedStatusEvent[];
	/** Additional event references were omitted from this view. */ detailsTruncated: boolean;
}
/** Bounded result of local native context inspection. */
export interface NativeFeedStatus {
	/** Local status contract version. */ version: 1;
	/** Availability of authorized state, independent of whether an agent is working. */ status:
		| "available"
		| "partial"
		| "empty"
		| "unavailable";
	/** Time this view was read. */ observedAt: number;
	/** Current authorized cohorts only. */ cohorts: NativeFeedStatusCohort[];
	/** State unavailable because of missing proof, unsafe files, or malformed data. */ unavailableCohorts: number;
	/** A fixed read/output bound stopped inspection. */ truncated: boolean;
	/** Counting semantics; no inference of model consumption or benefit. */ semantics: {
		queued: string;
		claimed: string;
		emitted: string;
	};
}

function record(value: unknown): value is RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function paths(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 16 &&
		value.every(
			(entry) =>
				typeof entry === "string" &&
				entry.length > 0 &&
				entry.length <= 512 &&
				!entry.startsWith("/") &&
				!/^[A-Za-z]:|\\/.test(entry) &&
				[...entry].every((character) => character.charCodeAt(0) >= 32) &&
				!entry.split("/").includes(".."),
		)
	);
}
function claims(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 128 &&
		value.every((entry) => typeof entry === "string" && /^[a-f0-9-]{36}$/.test(entry))
	);
}
function current(value: RecordValue, field: string, now: number): boolean {
	return (
		typeof value[field] === "number" && value[field] > now - RETENTION_MS && value[field] <= now
	);
}
function viewState(
	cohort: string,
	value: unknown,
	proof: FeedAccessProof,
	now: number,
): NativeFeedStatusCohort | null {
	if (
		!record(value) ||
		value.version !== 1 ||
		value.cohort !== cohort ||
		value.proofIdentity !== feedProofIdentity(proof) ||
		!Array.isArray(value.events) ||
		value.events.length > 128 ||
		!Array.isArray(value.recipients) ||
		value.recipients.length > 64
	)
		return null;
	const events: NativeFeedStatusEvent[] = [];
	for (const entry of value.events) {
		if (
			!record(entry) ||
			!KINDS.has(String(entry.kind)) ||
			!paths(entry.references) ||
			!integer(entry.createdAt)
		)
			return null;
		if (String(entry.epoch) !== String(proof.epoch) || !current(entry, "createdAt", now)) continue;
		events.push({
			kind: String(entry.kind),
			references: entry.references.slice(0, 4),
			createdAt: entry.createdAt,
		});
	}
	let recipients = 0,
		claimedEvents = 0,
		emittedPackets = 0,
		pendingClaims = 0;
	for (const entry of value.recipients) {
		if (
			!record(entry) ||
			!integer(entry.lastSeen) ||
			!claims(entry.claimed) ||
			!claims(entry.pendingClaims) ||
			(entry.emitted !== undefined && !integer(entry.emitted))
		)
			return null;
		if (!current(entry, "lastSeen", now)) continue;
		recipients++;
		claimedEvents += new Set(entry.claimed).size;
		emittedPackets += Number(entry.emitted ?? 0);
		pendingClaims += new Set(entry.pendingClaims).size;
	}
	return {
		cohort,
		repo: proof.repo,
		compatibility: "unknown",
		queuedEvents: events.length,
		recipients,
		claimedEvents,
		emittedPackets,
		pendingClaims,
		events: events.slice(-4),
		detailsTruncated:
			events.length > 4 ||
			value.events.some(
				(entry) => record(entry) && Array.isArray(entry.references) && entry.references.length > 4,
			),
	};
}
function compatibility(
	value: unknown,
	now: number,
	options: { home?: string; credentialsPath?: string },
	cohort: string,
): NativeFeedStatusCohort["compatibility"] {
	if (
		!record(value) ||
		value.version !== 1 ||
		!Array.isArray(value.connections) ||
		value.connections.length > 32
	)
		return "unknown";
	if (value.suppressed === true) return "unavailable";
	const live = value.connections.filter(
		(entry) =>
			record(entry) && typeof entry.leaseExpiresAt === "number" && entry.leaseExpiresAt > now,
	);
	if (!live.length) return "unknown";
	const client = record(live[0]) ? live[0].client : null;
	if (client !== "codex" && client !== "claude-code") return "unavailable";
	const registration = readFeedRegistration({ ...options, client });
	if (!registration) return "unavailable";
	return resolveFeedProfile({ ...options, cohort, client, registration, event: "PostToolUse", now })
		.admit
		? "eligible"
		: "unavailable";
}

/** Read bounded local delivery counts for the current sign-in; never creates files or uploads data. */
export function nativeFeedStatus(
	options: { home?: string; credentialsPath?: string } = {},
): NativeFeedStatus {
	const now = Date.now();
	const result: NativeFeedStatus = {
		version: 1,
		status: "unavailable",
		observedAt: now,
		cohorts: [],
		unavailableCohorts: 0,
		truncated: false,
		semantics: {
			queued: "Retained local events; some may already be claimed.",
			claimed: "Per-recipient event claims, not receipt by a model.",
			emitted:
				"Local output packets handed to the transport, not model consumption or improved outcomes.",
		},
	};
	const generation = readFeedSignInGeneration(options);
	if (!generation) return result;
	const root = feedRoot(options);
	const store = createFeedStore(options);
	let directory: ReturnType<typeof opendirSync> | undefined;
	try {
		privateFeedPath(root, true);
		const path = join(root, "state");
		privateFeedPath(path, true);
		directory = opendirSync(path);
		let scanned = 0,
			cohorts = 0;
		while (scanned < MAX_DIRECTORY_ENTRIES && cohorts < MAX_COHORTS) {
			const entry = directory.readSync();
			if (!entry) break;
			scanned++;
			const cohort = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
			if (!HASH.test(cohort)) continue;
			cohorts++;
			const proof = store.readAccessProof({ cohort });
			const authorizationIdentity = store.currentAuthorizationIdentity({ cohort });
			if (!proof || proof.signIn !== generation) {
				result.unavailableCohorts++;
				continue;
			}
			const view = viewState(cohort, readFeedJSON(join(path, entry.name), 262_144), proof, now);
			const after = store.readAccessProof({ cohort });
			if (
				!view ||
				!after ||
				feedProofIdentity(after) !== feedProofIdentity(proof) ||
				authorizationIdentity !== store.currentAuthorizationIdentity({ cohort })
			) {
				result.unavailableCohorts++;
				continue;
			}
			view.compatibility = compatibility(
				readFeedJSON(join(root, "cohorts", entry.name)),
				now,
				options,
				cohort,
			);
			if (
				Buffer.byteLength(JSON.stringify({ ...result, cohorts: [...result.cohorts, view] })) >
				MAX_RESULT_BYTES
			) {
				result.truncated = true;
				break;
			}
			result.cohorts.push(view);
		}
		if (scanned === MAX_DIRECTORY_ENTRIES || cohorts === MAX_COHORTS)
			result.truncated ||= directory.readSync() !== null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.unavailableCohorts++;
	} finally {
		try {
			directory?.closeSync();
		} catch {
			result.unavailableCohorts++;
		}
	}
	if (readFeedSignInGeneration(options) !== generation)
		return { ...result, status: "unavailable", cohorts: [], unavailableCohorts: 0 };
	result.status =
		result.unavailableCohorts || result.truncated
			? result.cohorts.length
				? "partial"
				: "unavailable"
			: result.cohorts.length
				? "available"
				: "empty";
	return result;
}
