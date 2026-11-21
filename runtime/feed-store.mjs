/** Ephemeral local context state with finite leases, authorization checks and atomic per-child claims. */
import { randomUUID } from "node:crypto";
import { existsSync, opendirSync, readdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	feedCheckoutIdentity,
	feedServerOrigin,
	readFeedSignInGeneration,
} from "./feed-identity.mjs";
import {
	ensureFeedDirectory,
	ensureFeedRoot,
	feedHash,
	feedLock,
	feedRoot,
	privateFeedPath,
	readFeedJSON,
	removeFeedFile,
	writeFeedJSON,
} from "./feed-io.mjs";
import { readFeedSignIn } from "./feed-signin.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const COHORT = /^[a-f0-9]{64}$/;
const TTL = 30 * 60_000;
const LEASE = 30_000;
const STATE_LIMIT = 262_144;
const MAX_CONNECTIONS = 1024;
const MAX_EVENTS = 128;
const MAX_PREVIEW_EVENTS = 32;
const GIT_HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/** Hard UTF-8 packet limit shared by native assembly and store admission. */
export const FEED_PACKET_BYTES = 300;
/** Largest normal event, leaving room for a seed or loss notice in the native packet. */
export const FEED_EVENT_BYTES = 160;
/** Measure encoded output rather than JavaScript character count. */
export function feedPayloadBytes(value) {
	return Buffer.byteLength(value, "utf8");
}
const PRIVATE_TEXT =
	/\b(?:ph(?:at|rt)_|gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA|ASIA|glpat-|npm_)|(?:token|secret|passw(?:or)?d|api[_-]?key|auth|credential)\w*\s*[=:]|\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|https?:\/\/[^\s/]+:[^\s/]+@/i;
// Keep the same source/credential shape boundary as project-memory/execute-turn.mjs
// without importing that network-capable module into the native hook.
const SOURCE_TEXT =
	/```|~~~|=>|[{}]|^\s*(?:assistant|user|system|tool)\s*:|^\s*(?:import\s.+\sfrom\s+["']|(?:const|let|var)\s+\w+\s*=|(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|def\s+\w+\s*\()/im;
const safeText = (value) =>
	typeof value === "string" &&
	!PRIVATE_TEXT.test(value) &&
	!SOURCE_TEXT.test(value) &&
	![...value].some(
		(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
	) &&
	!/\p{Bidi_Control}/u.test(value);
const safeId = (value) =>
	typeof value === "string" && value.length > 0 && value.length <= 256 && safeText(value);
const safePaths = (values) =>
	Array.isArray(values) &&
	values.length <= 16 &&
	values.every(
		(path) =>
			typeof path === "string" &&
			path.length > 0 &&
			path.length <= 512 &&
			!path.startsWith("/") &&
			!/^[A-Za-z]:|\\/.test(path) &&
			!path.split("/").includes("..") &&
			safeText(path),
	);
const boundedInterests = (paths) => {
	const retained = [];
	for (const path of [...new Set(paths)].slice(-32).reverse()) {
		if (feedPayloadBytes(JSON.stringify([path, ...retained])) <= 1024) retained.unshift(path);
	}
	return retained;
};
const containsCapability = (state, value) =>
	state.recipients.some(
		(entry) =>
			UUID.test(entry.capability ?? "") && JSON.stringify(value).includes(entry.capability),
	);
const sameEpoch = (left, right) => String(left) === String(right);
/** Stable authorization scope, excluding renewal time but including physical checkout identity. */
export function feedProofIdentity(value) {
	return feedHash(
		JSON.stringify([
			value.actor,
			value.owner,
			value.repo,
			value.epoch,
			value.signIn,
			value.checkout,
			value.checkoutIdentity,
		]),
	);
}
const proofKey = feedProofIdentity;
const scopeKey = (proofIdentity, revision) => feedHash(JSON.stringify([proofIdentity, revision]));
const attempt = (operation, fallback = false) => {
	try {
		return operation();
	} catch {
		return fallback;
	}
};
const blank = (cohort) => ({
	version: 1,
	cohort,
	sequence: 0,
	revision: randomUUID(),
	updatedAt: Date.now(),
	eviction: 0,
	events: [],
	previewEviction: 0,
	previewEvents: [],
	recipients: [],
	observations: [],
	receipts: [],
	producer: {},
});
const recipientKey = ({ rootId, agentId }) => feedHash(JSON.stringify([rootId, agentId]));

/** Render only useful event data; private routing IDs and timestamps do not consume context. */
export function formatFeedEvent(event) {
	const kind = ["reported", "proposed", "invalidation", "fact"].includes(event?.kind)
		? event.kind
		: "update";
	const author = safeId(event?.agentId) ? event.agentId.slice(-8) : "unknown";
	const refs = safePaths(event?.references) ? event.references.join(",") : "";
	const summary =
		typeof event?.summary === "string"
			? JSON.stringify(event.summary.replace(/\p{Cc}/gu, " "))
			: "";
	const head =
		typeof event?.provenance?.head === "string" ? ` @${event.provenance.head.slice(0, 12)}` : "";
	return `[${kind} ${author}] ${summary}${refs ? ` (${refs})` : ""}${head}`;
}

/** Create a bounded feed store. A busy/unsafe local store quietly refuses optional context work. */
export function createFeedStore(options = {}) {
	const now = options.now ?? Date.now;
	const root = feedRoot(options);
	const directory = (name, create = false) =>
		create ? ensureFeedDirectory(join(ensureFeedRoot(options), name)) : join(root, name);
	const marker = () =>
		readFeedSignIn(
			options.credentialsPath ?? join(options.home ?? homedir(), ".pharaoh", "credentials.json"),
		);
	const statePath = (cohort) => join(directory("state"), `${cohort}.json`);
	function retainedEvent(event) {
		return (
			event &&
			event.createdAt > now() - TTL &&
			safePaths(event.references) &&
			(event.summary === undefined || safeText(event.summary)) &&
			feedPayloadBytes(formatFeedEvent(event)) <= FEED_EVENT_BYTES
		);
	}
	function clearPreview(state) {
		state.previewEvents = [];
		state.previewEviction = 0;
		delete state.previewScope;
		for (const recipient of state.recipients) {
			delete recipient.previewClaimed;
			delete recipient.seenPreviewEviction;
		}
	}
	function load(cohort) {
		const state = readFeedJSON(statePath(cohort), STATE_LIMIT);
		if (!state)
			return existsSync(statePath(cohort)) ? null : { ...blank(cohort), updatedAt: now() };
		if (
			state.version !== 1 ||
			state.cohort !== cohort ||
			!UUID.test(state.revision ?? "") ||
			!Number.isSafeInteger(state.sequence) ||
			!["events", "recipients", "observations", "receipts"].every((key) =>
				Array.isArray(state[key]),
			)
		)
			return null;
		const count = state.events.length;
		// A pre-preview launcher reads only v1 events, so this collection must always be base-only.
		state.events = state.events
			.filter((event) => retainedEvent(event) && event.previewOnly !== true)
			.slice(-MAX_EVENTS);
		if (state.events.length < count) state.eviction = (state.eviction ?? 0) + 1;
		// A v1 fallback can rotate the base proof while preserving unknown preview fields.
		if (
			(state.previewScope !== undefined || state.previewEvents?.length) &&
			(!COHORT.test(state.proofIdentity ?? "") ||
				state.previewScope !== scopeKey(state.proofIdentity, state.revision))
		)
			clearPreview(state);
		const previewEvents = Array.isArray(state.previewEvents) ? state.previewEvents : [];
		if (!Number.isSafeInteger(state.previewEviction) || state.previewEviction < 0)
			state.previewEviction = 0;
		state.previewEvents = previewEvents
			.filter(
				(event) =>
					retainedEvent(event) &&
					event.previewOnly === true &&
					Number.isSafeInteger(event.sequence),
			)
			.slice(-MAX_PREVIEW_EVENTS);
		if (state.previewEvents.length < previewEvents.length)
			state.previewEviction = (state.previewEviction ?? 0) + 1;
		state.recipients = state.recipients.filter((entry) => entry.lastSeen > now() - TTL);
		state.observations = state.observations
			.filter((entry) => entry.createdAt > now() - TTL)
			.slice(-MAX_EVENTS);
		state.receipts = state.receipts.filter((entry) => entry.expiresAt > now()).slice(-64);
		return state;
	}
	function writeState(state, touch = true) {
		if (touch) state.updatedAt = now();
		// Count limits alone are insufficient for long paths or many concurrent workers.
		while (feedPayloadBytes(JSON.stringify(state)) > STATE_LIMIT) {
			if (state.previewEvents.length) {
				state.previewEvents.shift();
				state.previewEviction = (state.previewEviction ?? 0) + 1;
			} else if (state.observations.length) {
				state.observations.shift();
				state.eviction = (state.eviction ?? 0) + 1;
			} else if (state.events.length) {
				state.events.shift();
				state.eviction = (state.eviction ?? 0) + 1;
			} else if (state.receipts.length) state.receipts.shift();
			else if (state.recipients.length) {
				state.recipients.shift();
				state.eviction = (state.eviction ?? 0) + 1;
			} else return false;
		}
		writeFeedJSON(directory("state", true), `${state.cohort}.json`, state, STATE_LIMIT);
		return true;
	}
	function proof(cohort, state) {
		if (!COHORT.test(cohort ?? "")) return null;
		state ??= load(cohort);
		const active = marker();
		const value = readFeedJSON(join(directory("proofs"), `${cohort}.json`), 4096);
		if (
			!active ||
			!state ||
			!value ||
			value.version !== 1 ||
			value.signIn !== active.generation ||
			value.issuer !== active.server ||
			!Number.isSafeInteger(value.actor) ||
			value.actor < 1 ||
			!(
				(typeof value.owner === "string" && value.owner.length > 0) ||
				(Number.isSafeInteger(value.owner) && value.owner > 0)
			) ||
			typeof value.repo !== "string" ||
			!/^[\w.-]+\/[\w.-]+$/.test(value.repo) ||
			!["string", "number"].includes(typeof value.epoch) ||
			typeof value.checkout !== "string" ||
			!COHORT.test(value.checkoutIdentity ?? "") ||
			feedCheckoutIdentity(value.checkout) !== value.checkoutIdentity ||
			value.scopeRevision !== state.revision ||
			state.proofIdentity !== proofKey(value) ||
			!Number.isFinite(value.requestedAt) ||
			!Number.isFinite(value.expiresAt) ||
			value.expiresAt <= now() ||
			value.requestedAt > now() ||
			value.expiresAt > value.requestedAt + 60_000
		)
			return null;
		return value;
	}
	function authorizationIdentity(cohort, state) {
		const access = proof(cohort, state);
		return access ? scopeKey(proofKey(access), access.scopeRevision) : null;
	}
	function mutate(cohort, operation, guard = {}) {
		if (!COHORT.test(cohort ?? "")) return false;
		return attempt(() => {
			const dir = directory("state", true);
			return (
				feedLock(
					dir,
					() => {
						if (
							!existsSync(statePath(cohort)) &&
							boundedNames(dir, MAX_CONNECTIONS + 1).filter((name) => name.endsWith(".json"))
								.length >= MAX_CONNECTIONS
						)
							return false;
						const state = load(cohort);
						if (!state) return false;
						const identity = authorizationIdentity(cohort, state);
						if (
							guard.authorize !== false &&
							(!identity ||
								(guard.authorizationIdentity && identity !== guard.authorizationIdentity))
						)
							return false;
						if (guard.expectedRevision && guard.expectedRevision !== state.revision) return false;
						const result = operation(state);
						if (result === false || result === null) return result;
						if (guard.authorize !== false && authorizationIdentity(cohort, state) !== identity)
							return false;
						if (result === "irrelevant") return result;
						if (!writeState(state)) return false;
						return result;
					},
					`${cohort}.lock`,
					now(),
				) ?? false
			);
		});
	}
	function rootRecord(input) {
		if (!COHORT.test(input.cohort ?? "") || !safeId(input.rootId)) return null;
		const record = readFeedJSON(
			join(directory("roots"), input.cohort, `${feedHash(input.rootId)}.json`),
			4096,
		);
		const access = proof(input.cohort);
		if (
			!record ||
			!access ||
			record.version !== 1 ||
			record.rootId !== input.rootId ||
			record.cohort !== input.cohort ||
			record.lastSeen <= now() - TTL ||
			record.checkout !== access.checkout ||
			record.checkoutIdentity !== access.checkoutIdentity ||
			record.signIn !== access.signIn
		)
			return null;
		return record;
	}
	function authorized(input) {
		return safeId(input.agentId) && rootRecord(input);
	}
	function append(state, input) {
		if (input.dedupeKey !== undefined && !COHORT.test(input.dedupeKey)) return null;
		if (containsCapability(state, { summary: input.summary, references: input.references }))
			return null;
		const preview = input.previewOnly === true;
		const events = preview ? state.previewEvents : state.events;
		if (input.dedupeKey) {
			const existing = events.find(
				(event) => event.rootId === input.rootId && event.dedupeKey === input.dedupeKey,
			);
			if (existing) return existing;
		}
		if (
			!["reported", "proposed", "invalidation", "fact"].includes(input.kind) ||
			!safePaths(input.references) ||
			(input.summary !== undefined &&
				(typeof input.summary !== "string" ||
					feedPayloadBytes(input.summary) > FEED_EVENT_BYTES ||
					!safeText(input.summary)))
		)
			return null;
		const access = proof(input.cohort);
		if (!access) return null;
		const provenance = {};
		for (const key of ["branch", "head", "fingerprint"])
			if (safeId(input.provenance?.[key]) && safeText(input.provenance[key]))
				provenance[key] = input.provenance[key];
		const event = {
			id: randomUUID(),
			...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
			sequence: state.sequence + 1,
			cohort: input.cohort,
			rootId: input.rootId,
			agentId: input.agentId,
			...(preview ? { previewOnly: true } : {}),
			kind: input.kind,
			references: [...new Set(input.references)].slice(0, 8),
			...(input.summary ? { summary: input.summary } : {}),
			provenance,
			createdAt: now(),
			epoch: access.epoch,
		};
		if (feedPayloadBytes(formatFeedEvent(event)) > FEED_EVENT_BYTES) return null;
		if (preview) {
			const previewScope = scopeKey(state.proofIdentity, state.revision);
			// Include the next sequence, touch and eviction counter when checking capacity.
			const kept = [...events, event].slice(-MAX_PREVIEW_EVENTS);
			let evictions = (state.previewEviction ?? 0) + events.length + 1 - kept.length;
			while (
				kept.length &&
				feedPayloadBytes(
					JSON.stringify({
						...state,
						sequence: event.sequence,
						updatedAt: now(),
						previewScope,
						previewEviction: evictions,
						previewEvents: kept,
					}),
				) > STATE_LIMIT
			) {
				kept.shift();
				evictions++;
			}
			if (!kept.length) return null;
			state.previewScope = previewScope;
			state.previewEvents = kept;
			state.previewEviction = evictions;
		} else {
			state.events.push(event);
			state.events = state.events.slice(-MAX_EVENTS);
		}
		state.sequence = event.sequence;
		return event;
	}
	function rebuild(cohort) {
		const dir = directory("cohorts", true);
		const names = readdirSync(directory("connections", true));
		const connections = [];
		let suppressed = names.length > MAX_CONNECTIONS;
		for (const name of names.slice(0, MAX_CONNECTIONS)) {
			if (!/^[a-f0-9-]{36}\.json$/.test(name)) {
				suppressed = true;
				continue;
			}
			const entry = readFeedJSON(join(directory("connections"), name), 2048);
			if (!entry || !COHORT.test(entry.cohort ?? "") || !Number.isFinite(entry.leaseExpiresAt)) {
				suppressed = true;
				continue;
			}
			if (entry.leaseExpiresAt <= now()) {
				attempt(() => removeFeedFile(join(directory("connections"), name)));
				continue;
			}
			if (entry.cohort === cohort) connections.push(entry);
		}
		if (connections.length > 32) suppressed = true;
		const summary = {
			version: 1,
			cohort,
			suppressed,
			connections: suppressed ? [] : connections,
			updatedAt: now(),
		};
		try {
			writeFeedJSON(dir, `${cohort}.json`, summary, 16_384);
		} catch {
			writeFeedJSON(dir, `${cohort}.json`, {
				version: 1,
				cohort,
				suppressed: true,
				connections: [],
				updatedAt: now(),
			});
		}
		return !suppressed;
	}
	function boundedNames(path, max = MAX_CONNECTIONS) {
		let handle;
		const names = [];
		try {
			privateFeedPath(path, true);
			handle = opendirSync(path);
			for (let i = 0; i < max; i++) {
				const entry = handle.readSync();
				if (!entry) break;
				names.push(entry.name);
			}
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		} finally {
			handle?.closeSync();
		}
		return names;
	}
	function pruneExpired(limit) {
		return attempt(() => {
			const candidates = [
				...new Set(
					["state", "proofs", "roots", "cohorts"]
						.flatMap((name) =>
							boundedNames(directory(name)).map((file) => file.replace(/\.json$/, "")),
						)
						.filter((name) => COHORT.test(name)),
				),
			].sort();
			if (!candidates.length) return 0;
			const cursor = readFeedJSON(join(root, "gc.json"), 1024)?.cursor ?? 0;
			let removed = 0;
			for (let i = 0; i < Math.min(limit, candidates.length); i++) {
				const cohort = candidates[(cursor + i) % candidates.length];
				feedLock(
					directory("state", true),
					() => {
						const state = load(cohort);
						const proofFile = join(directory("proofs"), `${cohort}.json`);
						const rawProof = readFeedJSON(proofFile, 4096);
						if (rawProof && rawProof.expiresAt <= now()) {
							removeFeedFile(proofFile);
							removed++;
						}

						const roots = join(directory("roots"), cohort);
						for (const file of boundedNames(roots, 64)) {
							if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
							const record = readFeedJSON(join(roots, file), 4096);
							if (!record || record.lastSeen <= now() - TTL) {
								attempt(() => removeFeedFile(join(roots, file)));
								removed++;
							}
						}
						if (!state || state.updatedAt <= now() - TTL) {
							// Removing a stale state cannot revive its old revision: the next read mints a fresh UUID.
							removeFeedFile(proofFile);
							removeFeedFile(statePath(cohort));
							attempt(() => removeFeedFile(join(directory("cohorts"), `${cohort}.json`)));
							attempt(() => rmdirSync(roots));
							removed++;
						} else {
							if (!proof(cohort, state)) clearPreview(state);
							writeState(state, false);
						}
					},
					`${cohort}.lock`,
					now(),
				);
			}
			writeFeedJSON(
				ensureFeedRoot(options),
				"gc.json",
				{ cursor: (cursor + limit) % candidates.length },
				1024,
			);
			return removed;
		}, 0);
	}

	function registry(operation) {
		return attempt(
			() => feedLock(ensureFeedRoot(options), operation, "registry.lock", now()) ?? false,
		);
	}
	const api = {
		recordFeedConnection(connection) {
			if (
				!connection ||
				!UUID.test(connection.id ?? "") ||
				!COHORT.test(connection.cohort ?? "") ||
				!["codex", "claude-code"].includes(connection.client) ||
				!["pending", "initialized"].includes(connection.state) ||
				connection.signIn !== readFeedSignInGeneration(options) ||
				!safeId(connection.checkout)
			)
				return false;
			return registry(() => {
				const dir = directory("connections", true);
				// Suppress first: a crash cannot leave a summary hiding this new live connection.
				writeFeedJSON(directory("cohorts", true), `${connection.cohort}.json`, {
					version: 1,
					cohort: connection.cohort,
					suppressed: true,
					connections: [],
					updatedAt: now(),
				});
				const record = {
					version: 1,
					id: connection.id,
					cohort: connection.cohort,
					client: connection.client,
					signIn: connection.signIn,
					checkout: connection.checkout,
					state: connection.state,
					name: typeof connection.name === "string" ? connection.name.slice(0, 128) : null,
					clientVersion:
						typeof connection.clientVersion === "string"
							? connection.clientVersion.slice(0, 64)
							: null,
					leaseExpiresAt: now() + LEASE,
				};
				writeFeedJSON(dir, `${connection.id}.json`, record, 2048);
				rebuild(connection.cohort);
				return true;
			});
		},
		renewFeedConnection(id) {
			if (!UUID.test(id ?? "")) return false;
			return registry(() => {
				const dir = directory("connections", true);
				const record = readFeedJSON(join(dir, `${id}.json`), 2048);
				if (
					!record ||
					record.state !== "initialized" ||
					record.signIn !== readFeedSignInGeneration(options)
				)
					return false;
				record.leaseExpiresAt = now() + LEASE;
				writeFeedJSON(dir, `${id}.json`, record, 2048);
				return rebuild(record.cohort);
			});
		},
		removeFeedConnection(id) {
			if (!UUID.test(id ?? "")) return false;
			return registry(() => {
				const file = join(directory("connections", true), `${id}.json`);
				const record = readFeedJSON(file, 2048);
				removeFeedFile(file);
				return record ? rebuild(record.cohort) : true;
			});
		},
		readCohort(cohort) {
			return COHORT.test(cohort ?? "")
				? readFeedJSON(join(directory("cohorts"), `${cohort}.json`))
				: null;
		},
		registerFeedRoot(input) {
			if (!COHORT.test(input.cohort ?? "") || !safeId(input.rootId) || !safeId(input.checkout))
				return false;
			return mutate(
				input.cohort,
				() => {
					const signIn = readFeedSignInGeneration(options),
						checkoutIdentity = feedCheckoutIdentity(input.checkout);
					if (!signIn || !checkoutIdentity) return false;
					const dir = ensureFeedDirectory(join(directory("roots", true), input.cohort));
					if (
						!existsSync(join(dir, `${feedHash(input.rootId)}.json`)) &&
						boundedNames(dir, 65).length >= 64
					)
						return false;
					writeFeedJSON(
						dir,
						`${feedHash(input.rootId)}.json`,
						{
							version: 1,
							cohort: input.cohort,
							rootId: input.rootId,
							checkout: input.checkout,
							checkoutIdentity,
							signIn,
							basis: input.basis === "exact" ? "exact" : "cohort",
							exactVersion:
								input.basis === "exact" && safeId(input.exactVersion)
									? input.exactVersion
									: "unknown",
							lastSeen: now(),
						},
						4096,
					);
					return true;
				},
				{ authorize: false },
			);
		},
		registerRecipient(input) {
			if (!authorized(input) || !safePaths(input.interests ?? [])) return false;
			return mutate(input.cohort, (state) => {
				const key = recipientKey(input);
				let entry = state.recipients.find((item) => item.key === key);
				if (!entry) {
					if (state.recipients.length >= 64) return false;
					entry = {
						key,
						rootId: input.rootId,
						agentId: input.agentId,
						interests: [],
						claimed: [],
						pendingClaims: [],
						lastSeen: now(),
					};
					state.recipients.push(entry);
				}
				entry.proofIdentity = state.proofIdentity;
				entry.interests = boundedInterests([...entry.interests, ...(input.interests ?? [])]);
				entry.lastSeen = now();
				return true;
			});
		},
		recordObservation(input) {
			if (!authorized(input) || !safePaths(input.paths) || !input.paths.length) return false;
			return mutate(input.cohort, (state) => {
				const entry = state.recipients.find((item) => item.key === recipientKey(input));
				if (!entry) return false;
				entry.interests = boundedInterests([...entry.interests, ...input.paths]);
				entry.lastSeen = now();
				state.observations.push({
					id: randomUUID(),
					cohort: input.cohort,
					rootId: input.rootId,
					agentId: input.agentId,
					paths: [...new Set(input.paths)],
					kind: input.kind === "edit" ? "edit" : "read",
					createdAt: now(),
				});
				state.observations = state.observations.slice(-MAX_EVENTS);
				return true;
			});
		},
		publishFinding(input) {
			if (!authorized(input)) return null;
			return (
				mutate(input.cohort, (state) => append(state, input), {
					authorizationIdentity: input.authorizationIdentity,
				}) || null
			);
		},
		publishOverlap(input) {
			const { head, fingerprint } = input.provenance ?? {};
			if (
				!safeId(input.agentId) ||
				!safeId(input.rootId) ||
				!UUID.test(input.observationId ?? "") ||
				!safePaths([input.path]) ||
				!COHORT.test(input.authorizationIdentity ?? "") ||
				typeof fingerprint !== "string" ||
				!COHORT.test(fingerprint) ||
				typeof head !== "string" ||
				!GIT_HEAD.test(head)
			)
				return "irrelevant";
			if (!authorized(input)) return "retry";
			return (
				mutate(
					input.cohort,
					(state) => {
						const observation = state.observations.find(
							(entry) => entry.id === input.observationId,
						);
						if (
							observation?.kind !== "read" ||
							observation.rootId !== input.rootId ||
							observation.agentId !== input.agentId ||
							!observation.paths.includes(input.path) ||
							!state.recipients.some(
								(entry) =>
									entry.rootId === input.rootId &&
									entry.agentId === input.agentId &&
									entry.proofIdentity === state.proofIdentity &&
									entry.interests.includes(input.path),
							) ||
							!state.recipients.some(
								(entry) =>
									entry.rootId === input.rootId &&
									entry.agentId !== input.agentId &&
									entry.proofIdentity === state.proofIdentity &&
									entry.interests.includes(input.path),
							)
						)
							return "irrelevant";
						return append(state, {
							cohort: input.cohort,
							rootId: input.rootId,
							agentId: input.agentId,
							previewOnly: true,
							kind: "fact",
							summary: "Sibling referenced this saved file.",
							references: [input.path],
							provenance: input.provenance,
							dedupeKey: feedHash(
								JSON.stringify(["saved-overlap", input.agentId, input.path, head, fingerprint]),
							),
						})
							? "published"
							: "irrelevant";
					},
					{ authorizationIdentity: input.authorizationIdentity },
				) || "retry"
			);
		},
		drainRecipient(input) {
			if (!authorized(input)) return null;
			return (
				mutate(input.cohort, (state) => {
					const entry = state.recipients.find((item) => item.key === recipientKey(input));
					const access = proof(input.cohort, state);
					if (!entry || !access) return false;
					const identity = authorizationIdentity(input.cohort, state);
					const claimed = new Set(entry.claimed);
					const preview = input.preview === true;
					const previewClaimed = new Set(
						preview && Array.isArray(entry.previewClaimed) ? entry.previewClaimed : [],
					);
					const events = preview
						? [...state.events, ...state.previewEvents].sort((a, b) => a.sequence - b.sequence)
						: state.events;
					const candidates = events.filter(
						(event) =>
							event.rootId === input.rootId &&
							event.agentId !== input.agentId &&
							sameEpoch(event.epoch, access.epoch) &&
							!(event.previewOnly === true ? previewClaimed : claimed).has(event.id) &&
							event.references.some((path) => entry.interests.includes(path)),
					);
					const gap =
						entry.pendingClaims.length > 0 ||
						(entry.seenEviction ?? 0) < (state.eviction ?? 0) ||
						(preview && (entry.seenPreviewEviction ?? 0) < (state.previewEviction ?? 0));
					const seedNeeded = entry.seeded !== true;
					const budget = Math.max(
						0,
						Math.min(input.maxChars ?? FEED_PACKET_BYTES, FEED_PACKET_BYTES) -
							(seedNeeded ? Math.max(0, input.seedChars ?? 0) : 0) -
							(gap ? Math.max(0, input.gapChars ?? 0) : 0),
					);
					const selected = [];
					let size = 0;
					for (const event of candidates) {
						const length = feedPayloadBytes(formatFeedEvent(event)) + 1;
						if (length > budget || size + length > budget) continue;
						selected.push(event);
						size += length;
					}
					const claimId = selected.length || seedNeeded || gap ? randomUUID() : null;
					for (const event of selected) {
						(event.previewOnly === true ? previewClaimed : claimed).add(event.id);
					}
					entry.claimed = [...claimed].slice(-MAX_EVENTS);
					if (preview) {
						entry.previewClaimed = [...previewClaimed].slice(-MAX_PREVIEW_EVENTS);
						entry.seenPreviewEviction = state.previewEviction ?? 0;
					}
					entry.pendingClaims = claimId ? [claimId] : [];
					entry.pendingAuthorization = identity;
					entry.seenEviction = state.eviction ?? 0;
					entry.lastSeen = now();
					return { events: selected, gap, claimId, seedNeeded, authorizationIdentity: identity };
				}) || null
			);
		},
		markEmitted(input) {
			if (!authorized(input) || !UUID.test(input.claimId ?? "")) return false;
			return mutate(
				input.cohort,
				(state) => {
					const entry = state.recipients.find((item) => item.key === recipientKey(input));
					if (
						!entry ||
						!entry.pendingClaims.includes(input.claimId) ||
						entry.pendingAuthorization !== authorizationIdentity(input.cohort, state)
					)
						return false;
					entry.pendingClaims = entry.pendingClaims.filter((id) => id !== input.claimId);
					entry.emitted = (entry.emitted ?? 0) + 1;
					entry.seeded = true;
					return true;
				},
				{ authorizationIdentity: input.authorizationIdentity },
			);
		},
		readScopeRevision({ cohort }) {
			return mutate(cohort, (state) => state.revision, { authorize: false }) || null;
		},
		currentAuthorizationIdentity({ cohort }) {
			return authorizationIdentity(cohort);
		},
		putAccessProof({ cohort, proof: value, expectedRevision }) {
			if (
				!COHORT.test(cohort ?? "") ||
				!value ||
				value.signIn !== readFeedSignInGeneration(options) ||
				feedServerOrigin(value.issuer) !== value.issuer ||
				value.issuer !== marker()?.server ||
				!COHORT.test(value.checkoutIdentity ?? "") ||
				feedCheckoutIdentity(value.checkout) !== value.checkoutIdentity
			)
				return false;
			return mutate(
				cohort,
				(state) => {
					if (
						value.signIn !== readFeedSignInGeneration(options) ||
						feedCheckoutIdentity(value.checkout) !== value.checkoutIdentity
					)
						return false;
					const identity = proofKey(value);
					if (state.proofIdentity !== identity) {
						state.events = [];
						clearPreview(state);
						state.observations = [];
						state.receipts = [];
						state.producer = {};
						state.revision = randomUUID();
						for (const recipient of state.recipients) {
							recipient.seeded = false;
							recipient.claimed = [];
							recipient.pendingClaims = [];
							recipient.capability = null;
							recipient.proofIdentity = identity;
						}
					}
					state.proofIdentity = identity;
					const stored = { ...value, scopeRevision: state.revision };
					writeFeedJSON(directory("proofs", true), `${cohort}.json`, stored, 4096);
					if (!proof(cohort, state)) {
						removeFeedFile(join(directory("proofs"), `${cohort}.json`));
						return false;
					}
					return true;
				},
				{ authorize: false, expectedRevision },
			);
		},
		readAccessProof({ cohort }) {
			return proof(cohort);
		},
		readObservations({ cohort }) {
			const access = proof(cohort);
			const state = access && load(cohort);
			return state && state.proofIdentity === proofKey(access) ? state.observations : [];
		},
		acknowledgeObservations({ cohort, ids, authorizationIdentity: expectedIdentity }) {
			if (!proof(cohort) || !Array.isArray(ids)) return false;
			const completed = new Set(ids);
			return mutate(
				cohort,
				(state) => {
					state.observations = state.observations.filter((entry) => !completed.has(entry.id));
					return true;
				},
				{ authorizationIdentity: expectedIdentity },
			);
		},
		readProducerState({ cohort }) {
			const access = proof(cohort);
			const state = access && load(cohort);
			return state && state.proofIdentity === proofKey(access) ? state.producer : null;
		},
		updateProducerState({ cohort, state: value, signIn, authorizationIdentity: expectedIdentity }) {
			if (
				!proof(cohort) ||
				signIn !== readFeedSignInGeneration(options) ||
				feedPayloadBytes(JSON.stringify(value)) > 65_536
			)
				return false;
			return mutate(
				cohort,
				(state) => {
					state.producer = value;
					return true;
				},
				{ authorizationIdentity: expectedIdentity },
			);
		},
		recipientCapability(input) {
			if (!authorized(input)) return null;
			return (
				mutate(input.cohort, (state) => {
					const entry = state.recipients.find((item) => item.key === recipientKey(input));
					if (!entry || entry.proofIdentity !== state.proofIdentity) return false;
					entry.capability ??= randomUUID();
					return entry.capability;
				}) || null
			);
		},
		createShareReceipt({ cohort, recipientToken, finding }) {
			if (
				!UUID.test(recipientToken ?? "") ||
				!finding ||
				!["reported", "proposed"].includes(finding.kind) ||
				!safePaths(finding.references) ||
				!safeText(finding.summary)
			)
				return null;
			return (
				mutate(cohort, (state) => {
					const recipient = state.recipients.find(
						(item) =>
							item.capability === recipientToken && item.proofIdentity === state.proofIdentity,
					);
					if (
						!recipient ||
						!authorized({ cohort, ...recipient }) ||
						containsCapability(state, finding)
					)
						return false;
					const clean = {
						kind: finding.kind,
						summary: finding.summary,
						references: [...finding.references],
					};
					if (
						feedPayloadBytes(formatFeedEvent({ ...clean, agentId: recipient.agentId })) >
							FEED_EVENT_BYTES ||
						clean.summary.includes(recipientToken)
					)
						return false;
					const receiptId = randomUUID();
					state.receipts.push({
						receiptId,
						finding: clean,
						rootId: recipient.rootId,
						agentId: recipient.agentId,
						recipientToken,
						proofIdentity: state.proofIdentity,
						expiresAt: Math.min(now() + 60_000, proof(cohort, state).expiresAt),
					});
					state.receipts = state.receipts.slice(-64);
					return receiptId;
				}) || null
			);
		},
		consumeShareReceipt(input) {
			if (!authorized(input) || !UUID.test(input.receiptId ?? "")) return null;
			return (
				mutate(input.cohort, (state) => {
					const recipient = state.recipients.find((item) => item.key === recipientKey(input));
					const index = state.receipts.findIndex(
						(entry) =>
							entry.receiptId === input.receiptId &&
							entry.rootId === input.rootId &&
							entry.agentId === input.agentId &&
							entry.recipientToken === recipient?.capability &&
							entry.expiresAt > now() &&
							entry.proofIdentity === state.proofIdentity,
					);
					if (index < 0) return false;
					const [receipt] = state.receipts.splice(index, 1);
					return append(state, { ...receipt.finding, ...input });
				}) || null
			);
		},
		clearFeedScope(input = {}) {
			if (input.cohort) {
				if (!COHORT.test(input.cohort)) return false;
				return attempt(
					() =>
						feedLock(
							directory("state", true),
							() => {
								const current = load(input.cohort);
								if (input.expectedRevision && current?.revision !== input.expectedRevision)
									return false;
								if (
									input.authorizationIdentity &&
									authorizationIdentity(input.cohort, current) !== input.authorizationIdentity
								)
									return false;
								const state = { ...blank(input.cohort), updatedAt: now() };
								// Publish the fence first. Even an unlink failure cannot leave an old proof usable.
								writeState(state);
								removeFeedFile(join(directory("proofs"), `${input.cohort}.json`));
								return true;
							},
							`${input.cohort}.lock`,
							now(),
						) ?? false,
				);
			}
			return attempt(() => {
				const names = boundedNames(directory("state"));
				let cleared = true;
				for (const file of names) {
					if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
					const cohort = file.slice(0, -5);
					const access = readFeedJSON(join(directory("proofs"), file), 4096);
					if (input.signIn && access?.signIn !== input.signIn) continue;
					cleared = api.clearFeedScope({ cohort }) && cleared;
				}
				return cleared;
			});
		},
		suppressCohort({ cohort }) {
			if (!COHORT.test(cohort ?? "")) return false;
			return attempt(() => {
				writeFeedJSON(
					ensureFeedRoot(options),
					`registry-failure-${cohort}.json`,
					{ until: now() + LEASE },
					1024,
				);
				return true;
			});
		},
		pruneExpired({ limit = 32 } = {}) {
			return pruneExpired(Math.min(Math.max(limit, 1), 64));
		},
	};
	return api;
}
