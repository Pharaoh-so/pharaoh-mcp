/** Permission-neutral native handoff. Scope records and dispatch proof stay on-device. */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	conversationMemoryBinding,
	markSessionLocal,
	sessionLocalSensitivity,
} from "../project-memory/local.mjs";
import { readHookPreferences } from "../project-memory/preferences.mjs";
import {
	legacyMemoryHooksMayRun,
	memoryClientRoot,
	readActiveMemoryClients,
} from "../project-memory/user-target.mjs";
import { nativeIdentifier } from "./runtime-native.mjs";
import {
	ensurePrivateDirectory,
	privatePath,
	readRuntimeJSON,
	runtimeLock,
	writeRuntimeJSON,
} from "./runtime-storage.mjs";

const MARKER = "--pharaoh-local-worktree-v1";
const CLIENTS = ["claude-code", "codex"];
const BLAST = "mcp__pharaoh__get_blast_radius";
const STATUS = "mcp__pharaoh__pharaoh_local_worktree_status";
const MEMORY_TOOLS = new Set([
	"pharaoh_memory_recall",
	"pharaoh_memory_expand",
	"pharaoh_memory_capture",
	"pharaoh_memory_feedback",
]);
const MCP_PREFIX = "mcp__pharaoh__";
const RESET = ["SessionStart", "SessionEnd", "Stop", "StopFailure", "Interrupt", "CwdChanged"];
const ARG_KEYS = ["repo", "entity", "entity_type", "depth", "scope", "local_context"];
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/;
const STATE = "grants.json";
const MEMORY_STATE = "memory-calls.json";
const MAX_GRANTS = 32;
const MAX_MARKERS = 16;
const MAX_MEMORY_CALLS = 64;
const MAX_MEMORY_ARGUMENT_BYTES = 32_768;
const STATE_BYTES = 262_144;
const MAX_HOOK_BYTES = 1_048_576;
const GRANT_MS = 5 * 60_000;
const APPROVAL_MS = 30 * 60_000;
const consumedClaims = new WeakMap();
const consumedMemoryCalls = new WeakMap();
const observedRuntimes = new WeakMap();
const conversationStorage = { ensurePrivateDirectory, privatePath };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
const context = (event, text) => ({
	hookSpecificOutput: { hookEventName: event, additionalContext: text },
});
const HOSTED_CUE =
	"Pharaoh's hosted blast radius uses the default branch. Saved worktree scope is unavailable in this turn.";
const RETRY_CUE =
	"Verify Pharaoh scope again before sending a local query. Hosted queries use the default-branch map.";
const MEMORY_REFUSAL = "Pharaoh Project Memory is unavailable for this worktree conversation.";
const deny = (reason = RETRY_CUE) => ({
	hookSpecificOutput: {
		hookEventName: "PreToolUse",
		permissionDecision: "deny",
		permissionDecisionReason: reason,
	},
});

function privateDirectory(home, create) {
	if (!isAbsolute(home)) throw new Error("Private worktree state requires an absolute home.");
	const parent = join(home, ".pharaoh");
	const directory = join(parent, "local-worktree");
	for (const path of [parent, directory]) {
		if (create) ensurePrivateDirectory(path);
		else privatePath(path, true);
	}
	return directory;
}

function epochFile(session) {
	// Fixed slots let a new prompt revoke pending approval despite a busy grant
	// lock, while bounding disk use. A slot collision fails closed.
	return `epoch-${session.slice(0, 2)}.json`;
}

function currentEpoch(directory, session) {
	const value = readRuntimeJSON(join(directory, epochFile(session)), 512);
	return value?.session === session && TOKEN.test(value.epoch ?? "") ? value : undefined;
}

function resetEpoch(directory, session, turn) {
	const epoch = randomToken();
	writeRuntimeJSON(directory, epochFile(session), { session, turn, epoch }, 512);
	return epoch;
}

function active(directory, grant, now) {
	return grant.expiresAt > now && currentEpoch(directory, grant.session)?.epoch === grant.epoch;
}

function validCheckout(checkout) {
	return (
		checkout &&
		typeof checkout.root === "string" &&
		isAbsolute(checkout.root) &&
		checkout.root.length <= 4096 &&
		typeof checkout.repoSlug === "string" &&
		SLUG.test(checkout.repoSlug) &&
		SHA.test(checkout.worktreeId ?? "")
	);
}

function validMarker(marker) {
	return (
		marker &&
		SHA.test(marker.call ?? "") &&
		SHA.test(marker.digest ?? "") &&
		Number.isSafeInteger(marker.expiresAt) &&
		typeof marker.consumed === "boolean"
	);
}

function validAttachment(attachment) {
	return (
		attachment &&
		TOKEN.test(attachment.generation ?? "") &&
		Number.isSafeInteger(attachment.pid) &&
		attachment.pid > 0 &&
		attachment.pid <= 0x7fffffff
	);
}

function attachmentAlive(attachment) {
	if (!validAttachment(attachment)) return false;
	try {
		process.kill(attachment.pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readGrants(directory, now) {
	const data = readRuntimeJSON(join(directory, STATE), STATE_BYTES);
	if (data?.version !== 2 || !Array.isArray(data.grants) || data.grants.length > MAX_GRANTS)
		return [];
	return data.grants.filter(
		(grant) =>
			grant &&
			CLIENTS.includes(grant.client) &&
			SHA.test(grant.session ?? "") &&
			SHA.test(grant.turn ?? "") &&
			SHA.test(grant.binding ?? "") &&
			grant.memoryBinding?.client === grant.client &&
			SHA.test(grant.memoryBinding.sessionRef ?? "") &&
			TOKEN.test(grant.challenge ?? "") &&
			TOKEN.test(grant.token ?? "") &&
			TOKEN.test(grant.epoch ?? "") &&
			(grant.probe === undefined || SHA.test(grant.probe)) &&
			(grant.attachment === undefined || validAttachment(grant.attachment)) &&
			validCheckout(grant.checkout) &&
			Number.isSafeInteger(grant.expiresAt) &&
			grant.expiresAt > now &&
			grant.expiresAt <= now + APPROVAL_MS &&
			Array.isArray(grant.markers) &&
			grant.markers.length <= MAX_MARKERS &&
			grant.markers.every(validMarker),
	);
}

function mutateGrants(directory, now, update) {
	return runtimeLock(directory, () => {
		const grants = readGrants(directory, now);
		const result = update(grants);
		if (result) writeRuntimeJSON(directory, STATE, { version: 2, grants }, STATE_BYTES);
		return result;
	});
}

function mutateMemoryCalls(directory, now, update) {
	return runtimeLock(directory, () => {
		const data = readRuntimeJSON(join(directory, MEMORY_STATE), STATE_BYTES);
		const calls =
			data?.version === 1 && Array.isArray(data.calls) && data.calls.length <= MAX_MEMORY_CALLS
				? data.calls.filter(
						(call) =>
							call &&
							CLIENTS.includes(call.memoryBinding?.client) &&
							SHA.test(call.memoryBinding.sessionRef ?? "") &&
							SHA.test(call.session ?? "") &&
							TOKEN.test(call.epoch ?? "") &&
							SHA.test(call.runtime ?? "") &&
							SHA.test(call.worktreeId ?? "") &&
							SHA.test(call.call ?? "") &&
							SHA.test(call.digest ?? "") &&
							typeof call.consumed === "boolean" &&
							Number.isSafeInteger(call.expiresAt) &&
							call.expiresAt > now &&
							call.expiresAt <= now + APPROVAL_MS,
					)
				: [];
		const result = update(calls);
		if (result) writeRuntimeJSON(directory, MEMORY_STATE, { version: 1, calls }, STATE_BYTES);
		return result;
	});
}

function memoryDigest(name, args) {
	if (!MEMORY_TOOLS.has(name) || !args || typeof args !== "object" || Array.isArray(args)) return;
	try {
		const canonical = JSON.stringify(args, (_key, value) =>
			value && typeof value === "object" && !Array.isArray(value)
				? Object.fromEntries(
						Object.keys(value)
							.sort()
							.map((key) => [key, value[key]]),
					)
				: value,
		);
		if (Buffer.byteLength(canonical) <= MAX_MEMORY_ARGUMENT_BYTES) {
			return hash(JSON.stringify([name, canonical]));
		}
	} catch {
		// Unrepresentable arguments cannot establish a native proof.
	}
}

function requestDigest(args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return;
	const keys = Object.keys(args).sort();
	if (keys.length > ARG_KEYS.length) return;
	for (const key of keys) {
		const value = args[key];
		if (
			!ARG_KEYS.includes(key) ||
			(typeof value === "string" ? value.length > 1024 : !Number.isSafeInteger(value))
		)
			return;
	}
	return hash(JSON.stringify(args, keys));
}

function sameCheckout(left, right) {
	return (
		left.root === right.root &&
		left.repoSlug === right.repoSlug &&
		left.worktreeId === right.worktreeId
	);
}

function matchingRepo(value, repoSlug) {
	if (typeof value !== "string" || value.length > 140) return false;
	const repo = value.toLowerCase();
	return repo === repoSlug || repo === repoSlug.split("/")[1];
}

/**
 * Derive a local proof generation from the managed runtime and current sign-in.
 * @param client - Verified native client family.
 * @param launchEntry - Exact managed proxy entry shared with the calling process.
 * @param credentials - Private credentials; refresh rotates this generation.
 * @returns A local hash, or undefined when the sign-in cannot be bound.
 */
export function localWorktreeBinding(client, launchEntry, credentials) {
	if (
		!CLIENTS.includes(client) ||
		typeof launchEntry !== "string" ||
		!isAbsolute(launchEntry) ||
		typeof credentials?.refresh_token !== "string" ||
		!credentials.refresh_token ||
		credentials.refresh_token.length > 4096
	)
		return;
	try {
		const origin = new URL(credentials.sse_url).origin;
		if (origin !== "null")
			return hash(JSON.stringify([client, launchEntry, origin, credentials.refresh_token]));
	} catch {
		// Malformed or absent credentials do not bind a grant.
	}
}

/** Bind a native memory call to the verified managed launch across normal auth replay. */
export function nativeMemoryRuntimeBinding(client, launchEntry) {
	if (CLIENTS.includes(client) && typeof launchEntry === "string" && isAbsolute(launchEntry)) {
		return hash(JSON.stringify(["pharaoh-native-memory-v1", client, launchEntry]));
	}
}

function newGrant(directory, input, options, session, turn, epoch) {
	const { client, binding, now, resolveCheckout } = options;
	const evidence = typeof input.cwd === "string" ? resolveCheckout(input.cwd) : undefined;
	if (evidence?.kind !== "checkout" || !validCheckout(evidence.checkout)) return;
	if (legacyMemoryHooksMayRun(client, evidence.checkout.root, conversationStorage)) return;
	const memoryBinding = conversationMemoryBinding(client, input.session_id);
	if (!memoryBinding) return;
	const challenge = randomToken();
	const granted = mutateGrants(directory, now, (grants) => {
		if (currentEpoch(directory, session)?.epoch !== epoch) return;
		const prior = grants.findIndex((grant) => grant.session === session);
		if (prior !== -1) grants.splice(prior, 1);
		grants.splice(MAX_GRANTS - 1);
		grants.unshift({
			client,
			session,
			turn,
			epoch,
			binding,
			memoryBinding,
			challenge,
			token: randomToken(),
			checkout: evidence.checkout,
			expiresAt: now + GRANT_MS,
			markers: [],
		});
		return true;
	});
	if (granted) {
		return context(
			"UserPromptSubmit",
			`Before querying Pharaoh for callers or call impact in this project, call pharaoh_local_worktree_status with challenge: "${challenge}". The check uses no code or selector. Hosted queries remain available.`,
		);
	}
}

function claimedTool(input) {
	if (input.tool_name === STATUS) return "probe";
	if (
		typeof input.tool_name === "string" &&
		input.tool_name.startsWith(MCP_PREFIX) &&
		MEMORY_TOOLS.has(input.tool_name.slice(MCP_PREFIX.length))
	)
		return "memory";
	const args = input.tool_input;
	if (
		input.tool_name === BLAST &&
		args &&
		(Object.hasOwn(args, "local_context") || args.scope === "local")
	)
		return "blast";
}

function preToolMemory(directory, input, options, session, turn) {
	const { client, memoryRuntime, home, now, resolveCheckout } = options;
	const memoryBinding = conversationMemoryBinding(client, nativeIdentifier(input.session_id));
	if (sessionLocalSensitivity(memoryBinding, { home, storage: conversationStorage }) !== "clear")
		return deny(MEMORY_REFUSAL);
	// A known clean conversation keeps its existing hosted behavior when the
	// user configured another transport or has no managed runtime to prove.
	if (
		!SHA.test(memoryRuntime ?? "") ||
		(client === "claude-code" &&
			(input.mcp_server?.name !== "pharaoh" || input.mcp_server?.source !== "user"))
	)
		return;
	const evidence = typeof input.cwd === "string" ? resolveCheckout(input.cwd) : undefined;
	if (evidence?.kind !== "checkout" || !validCheckout(evidence.checkout)) return;
	const epoch = directory && session && currentEpoch(directory, session);
	const call = nativeIdentifier(input.tool_use_id);
	const digest = memoryDigest(input.tool_name.slice(MCP_PREFIX.length), input.tool_input);
	if (!epoch || !turn || epoch.turn !== turn || !call || !digest) return deny(MEMORY_REFUSAL);
	const recorded = mutateMemoryCalls(directory, now, (calls) => {
		if (currentEpoch(directory, session)?.epoch !== epoch.epoch) return;
		const callHash = hash(call);
		if (calls.some((previous) => previous.session === session && previous.call === callHash))
			return;
		calls.splice(MAX_MEMORY_CALLS - 1);
		calls.unshift({
			memoryBinding,
			session,
			epoch: epoch.epoch,
			runtime: memoryRuntime,
			worktreeId: evidence.checkout.worktreeId,
			call: callHash,
			digest,
			consumed: false,
			expiresAt: now + APPROVAL_MS,
		});
		return true;
	});
	return recorded ? undefined : deny(MEMORY_REFUSAL);
}

function preTool(directory, input, options, session, turn) {
	const { client, binding, home, now, resolveCheckout } = options;
	const args = input.tool_input;
	const kind = claimedTool(input);
	if (!kind) return;
	if (kind === "memory") return preToolMemory(directory, input, options, session, turn);
	const probe = kind === "probe";
	const evidence =
		binding && typeof input.cwd === "string" ? resolveCheckout(input.cwd) : undefined;
	const checkout = evidence?.kind === "checkout" ? evidence.checkout : undefined;
	const call = nativeIdentifier(input.tool_use_id);
	const digest = probe ? undefined : requestDigest(args);
	const token = probe ? args?.challenge : args?.local_context;
	if (
		!directory ||
		!session ||
		!turn ||
		!call ||
		!checkout ||
		legacyMemoryHooksMayRun(client, checkout.root, conversationStorage) ||
		!binding ||
		typeof token !== "string" ||
		!TOKEN.test(token) ||
		(probe ? Object.keys(args).length !== 1 : !digest || args.scope === "hosted") ||
		(client === "claude-code" &&
			(input.mcp_server?.name !== "pharaoh" || input.mcp_server?.source !== "user"))
	)
		return deny();

	const approved = mutateGrants(directory, now, (grants) => {
		const grant = grants.find(
			(value) =>
				value.client === client &&
				value.session === session &&
				value.turn === turn &&
				value.binding === binding &&
				(probe ? value.challenge : value.token) === token &&
				sameCheckout(value.checkout, checkout) &&
				active(directory, value, now),
		);
		if (!grant) return;
		const callDigest = hash(call);
		if (probe) {
			if (grant.probe === callDigest || grant.attachment) return;
			grant.probe = callDigest;
			grant.expiresAt = now + APPROVAL_MS;
			return true;
		}
		if (
			!matchingRepo(args.repo, grant.checkout.repoSlug) ||
			!attachmentAlive(grant.attachment) ||
			grant.markers.length >= MAX_MARKERS ||
			grant.markers.some(
				(marker) =>
					marker.call === callDigest ||
					(!marker.consumed && marker.expiresAt > now && marker.digest === digest),
			)
		)
			return;
		if (!markSessionLocal(grant.memoryBinding, { home, storage: conversationStorage })) return;
		grant.expiresAt = now + APPROVAL_MS;
		grant.markers.push({ call: callDigest, digest, expiresAt: grant.expiresAt, consumed: false });
		return true;
	});
	// A successful handoff leaves the native permission checks and input intact.
	return approved ? undefined : deny();
}

/**
 * Process a native command hook event.
 * @param input - Host-provided event fields, bounded by the command entry.
 * @param options - Verified runtime, local checkout resolver and optional clock/home.
 * @returns A scoped cue, a local refusal, or no change to the native call.
 */
export function handleLocalWorktreeHook(input, options) {
	const { client, home = homedir(), now = Date.now() } = options;
	const binding = SHA.test(options.binding ?? "") ? options.binding : undefined;
	if (!CLIENTS.includes(client) || !input || typeof input !== "object") return;
	const event = input.hook_event_name;
	if (event === "PreToolUse" && !claimedTool(input)) return;
	const nativeSession = nativeIdentifier(input.session_id);
	const nativeTurn = nativeIdentifier(client === "codex" ? input.turn_id : input.prompt_id);
	const session = nativeSession ? hash(JSON.stringify([client, nativeSession])) : undefined;
	const turn = nativeTurn ? hash(nativeTurn) : undefined;
	let directory;
	try {
		directory = privateDirectory(
			home,
			Boolean((binding || options.memoryRuntime) && session && event === "UserPromptSubmit"),
		);
	} catch {
		// Hosted-only installs need no private directory.
	}

	if (event === "PreToolUse") {
		try {
			return preTool(directory, input, { ...options, binding, home, now }, session, turn);
		} catch {
			return deny(claimedTool(input) === "memory" ? MEMORY_REFUSAL : RETRY_CUE);
		}
	}
	try {
		if (session && directory && RESET.includes(event)) {
			const current = currentEpoch(directory, session);
			if (
				current &&
				(!turn || current.turn === turn || event === "SessionStart" || event === "CwdChanged")
			)
				resetEpoch(directory, session, turn);
		}
		if (event === "SessionStart") return context(event, HOSTED_CUE);
		if (event === "UserPromptSubmit") {
			if (!session || !directory) return context(event, HOSTED_CUE);
			const epoch = resetEpoch(directory, session, turn);
			if (binding && turn) {
				const cue = newGrant(directory, input, { ...options, binding, now }, session, turn, epoch);
				if (cue) return cue;
			}
			return context(event, HOSTED_CUE);
		}
	} catch {
		if (event === "UserPromptSubmit" || event === "SessionStart") return context(event, HOSTED_CUE);
	}
}

/** Observe an initialized local stdio connection before it has a native turn binding. */
export function observeRuntimeGeneration(client, binding, checkout, options) {
	const { home = homedir(), resolveCheckout, memoryRuntime } = options ?? {};
	if (
		!CLIENTS.includes(client) ||
		(binding !== undefined && !SHA.test(binding)) ||
		!validCheckout(checkout) ||
		typeof resolveCheckout !== "function"
	)
		return;
	const generation = Object.freeze({ client });
	observedRuntimes.set(generation, {
		id: randomToken(),
		client,
		binding,
		memoryRuntime: SHA.test(memoryRuntime ?? "") ? memoryRuntime : undefined,
		checkout,
		home,
		resolveCheckout,
		closed: false,
	});
	return generation;
}

/**
 * Bind an actual connection to the exact harmless probe approved by the native host.
 * A new prompt invalidates the old grant and must establish its own readiness.
 */
export function verifyRuntimeSession(generation, challenge, options = {}) {
	const runtime = observedRuntimes.get(generation);
	const binding = Object.hasOwn(options, "binding") ? options.binding : runtime?.binding;
	const { now = Date.now() } = options;
	if (
		!runtime ||
		runtime.closed ||
		!SHA.test(binding ?? "") ||
		typeof challenge !== "string" ||
		!TOKEN.test(challenge)
	)
		return;
	try {
		const directory = privateDirectory(runtime.home, false);
		const evidence = runtime.resolveCheckout(runtime.checkout.root);
		if (evidence?.kind !== "checkout" || !sameCheckout(evidence.checkout, runtime.checkout)) return;
		const grant = mutateGrants(directory, now, (grants) => {
			const candidate = grants.find(
				(value) =>
					value.client === runtime.client &&
					value.binding === binding &&
					value.challenge === challenge &&
					value.probe &&
					!value.attachment &&
					(!runtime.session || value.session === runtime.session) &&
					sameCheckout(value.checkout, runtime.checkout) &&
					active(directory, value, now),
			);
			if (!candidate) return;
			candidate.attachment = { generation: runtime.id, pid: process.pid };
			return candidate;
		});
		if (!grant) return;
		// Retain this binding even if the turn closes or readiness is later lost.
		runtime.session = grant.session;
		runtime.epoch = grant.epoch;
		runtime.memoryBinding = grant.memoryBinding;
		runtime.binding = binding;
		if (currentEpoch(directory, grant.session)?.epoch !== grant.epoch) return;
		return { checkout: evidence.checkout, token: grant.token, memoryBinding: grant.memoryBinding };
	} catch {
		// A failed readiness check never grants local scope.
	}
}

/** Keep the verified conversation identity for egress checks even after turn loss. */
export function runtimeConversationBinding(generation) {
	return observedRuntimes.get(generation)?.memoryBinding;
}

/** Consume one exact, clear native memory call without attaching its conversation. */
export function consumeNativeMemoryCall(generation, name, args, { now = Date.now() } = {}) {
	const runtime = observedRuntimes.get(generation);
	const digest = memoryDigest(name, args);
	if (!runtime?.memoryRuntime || runtime.closed || !digest) return;
	try {
		const directory = privateDirectory(runtime.home, false);
		const evidence = runtime.resolveCheckout(runtime.checkout.root);
		if (evidence?.kind !== "checkout" || !sameCheckout(evidence.checkout, runtime.checkout)) return;
		const call = mutateMemoryCalls(directory, now, (calls) => {
			const candidates = calls.filter(
				(entry) =>
					!entry.consumed &&
					entry.runtime === runtime.memoryRuntime &&
					entry.memoryBinding.client === runtime.client &&
					entry.worktreeId === runtime.checkout.worktreeId &&
					entry.digest === digest &&
					(!runtime.session || entry.session === runtime.session) &&
					currentEpoch(directory, entry.session)?.epoch === entry.epoch,
			);
			const match = candidates.at(-1);
			if (!match || candidates.some((entry) => entry.session !== match.session)) return;
			match.consumed = true;
			return match;
		});
		if (!call) return;
		const proof = Object.freeze({});
		consumedMemoryCalls.set(proof, { runtime, directory, call });
		if (nativeMemoryCallCurrent(proof, { now })) return proof;
	} catch {
		// Ambiguous or unsafe native observations never release memory arguments.
	}
}

/** Recheck the original native epoch and sensitivity before each hosted send. */
export function nativeMemoryCallCurrent(proof, { now = Date.now() } = {}) {
	const consumed = consumedMemoryCalls.get(proof);
	if (!consumed) return false;
	const { runtime, directory, call } = consumed;
	if (
		runtime.closed ||
		call.expiresAt <= now ||
		(runtime.session && runtime.session !== call.session)
	)
		return false;
	try {
		privateDirectory(runtime.home, false);
		return (
			currentEpoch(directory, call.session)?.epoch === call.epoch &&
			sessionLocalSensitivity(call.memoryBinding, {
				home: runtime.home,
				storage: conversationStorage,
			}) === "clear"
		);
	} catch {
		return false;
	}
}

/** Check that the connection still owns an active native-turn attachment. */
export function verifiedSessionRuntime(generation, now = Date.now()) {
	const runtime = observedRuntimes.get(generation);
	if (!runtime?.session || runtime.closed) return false;
	try {
		const directory = privateDirectory(runtime.home, false);
		return readGrants(directory, now).some(
			(grant) => grant.attachment?.generation === runtime.id && active(directory, grant, now),
		);
	} catch {
		return false;
	}
}

/** Revoke a disconnected connection without clearing its memory sensitivity. */
export function releaseRuntimeGeneration(generation) {
	const runtime = observedRuntimes.get(generation);
	if (!runtime || runtime.closed) return;
	runtime.closed = true;
	if (!runtime.session) return;
	try {
		mutateGrants(privateDirectory(runtime.home, false), Date.now(), (grants) => {
			const index = grants.findIndex((grant) => grant.attachment?.generation === runtime.id);
			if (index < 0) return;
			grants.splice(index, 1);
			return true;
		});
	} catch {
		// The in-memory generation remains closed even when local cleanup fails.
	}
}

/**
 * Atomically consume the native marker before upstream serialization.
 * @param token - The opaque token carried by the MCP call.
 * @param args - The exact original tool arguments.
 * @param options - Verified native client binding and checkout resolver.
 * @returns Revalidated checkout evidence, or undefined for a terminal local refusal.
 */
export function consumeLocalWorktreeContext(token, args, options) {
	const {
		client,
		binding,
		generation,
		home = homedir(),
		now = Date.now(),
		resolveCheckout,
	} = options;
	const runtime = observedRuntimes.get(generation);
	if (
		!CLIENTS.includes(client) ||
		!binding ||
		!runtime?.session ||
		runtime.closed ||
		runtime.client !== client ||
		runtime.binding !== binding ||
		runtime.home !== home ||
		typeof token !== "string" ||
		!TOKEN.test(token) ||
		args?.local_context !== token
	)
		return;
	const digest = requestDigest(args);
	if (!digest) return;
	try {
		const directory = privateDirectory(home, false);
		const claimed = mutateGrants(directory, now, (grants) => {
			const grant = grants.find(
				(value) =>
					value.client === client &&
					value.binding === binding &&
					value.token === token &&
					value.session === runtime.session &&
					value.epoch === runtime.epoch &&
					value.attachment?.generation === runtime.id &&
					sameCheckout(value.checkout, runtime.checkout) &&
					active(directory, value, now),
			);
			const marker = grant?.markers.find(
				(value) => !value.consumed && value.digest === digest && value.expiresAt > now,
			);
			if (
				!grant ||
				!marker ||
				sessionLocalSensitivity(grant.memoryBinding, { home, storage: conversationStorage }) !==
					"local"
			)
				return;
			marker.consumed = true;
			return { grant, expiresAt: marker.expiresAt };
		});
		if (!claimed) return;
		const { grant, expiresAt } = claimed;
		const evidence = resolveCheckout(grant.checkout.root);
		if (
			evidence?.kind === "checkout" &&
			sameCheckout(evidence.checkout, grant.checkout) &&
			currentEpoch(directory, grant.session)?.epoch === grant.epoch
		) {
			consumedClaims.set(evidence.checkout, {
				home,
				session: grant.session,
				epoch: grant.epoch,
				expiresAt,
				generation,
			});
			return evidence.checkout;
		}
	} catch {
		// A consumed marker is never restored after a local failure.
	}
}

/**
 * Check a consumed native claim again just before committing or releasing its answer.
 * @param checkout - Exact checkout object returned by the native marker consumer.
 * @param now - Current clock, supplied by fixtures for delayed approval.
 * @returns Whether its originating turn and original approval window are still active.
 */
export function localWorktreeClaimCurrent(checkout, now = Date.now()) {
	const claim = consumedClaims.get(checkout);
	if (!claim || claim.expiresAt <= now || !verifiedSessionRuntime(claim.generation, now))
		return false;
	try {
		return (
			localWorktreeDiagnosticsReady(claim.home) &&
			!legacyMemoryHooksMayRun(claim.generation.client, checkout.root, conversationStorage) &&
			currentEpoch(privateDirectory(claim.home, false), claim.session)?.epoch === claim.epoch
		);
	} catch {
		return false;
	}
}

async function readHookInput() {
	let length = 0;
	const chunks = [];
	for await (const chunk of process.stdin) {
		length += chunk.length;
		if (length > MAX_HOOK_BYTES) return;
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function suppressionCompatible(home) {
	const prefs = readHookPreferences(home);
	const active = readActiveMemoryClients(home);
	const memory = memoryClientRoot(home);
	for (const client of CLIENTS) {
		const runtime = active[client];
		if (!runtime) {
			if (prefs[client]?.diagnostics === true && prefs[client]?.memory !== false) return false;
			continue;
		}
		// An older pinned copy has no marker check. Verify the active files
		// instead of assuming a newer NPX runtime upgraded its memory hooks.
		const directory = join(memory, runtime);
		privatePath(memory, true);
		privatePath(directory, true);
		for (const name of [
			"local.mjs",
			"diagnostics-collector.mjs",
			"memory-api.mjs",
			"hook-events.mjs",
			"execute-turn.mjs",
			"pharaoh-memory-hook.mjs",
		]) {
			const path = join(directory, name);
			if (privatePath(path).size > 262_144) return false;
			const current = readFileSync(new URL(`../project-memory/${name}`, import.meta.url));
			if (!readFileSync(path).equals(current)) return false;
		}
	}
	return true;
}

/** Check the diagnostic privacy prerequisites without changing user state. */
export function localWorktreeDiagnosticsReady(home = homedir()) {
	try {
		return suppressionCompatible(home);
	} catch {
		return false;
	}
}

/** Shell calls cannot mark a native conversation, so they need inactive memory hooks. */
export function localWorktreeShellReady(root, home = homedir()) {
	try {
		if (!isAbsolute(root) || !isAbsolute(home)) return false;
		const memory = memoryClientRoot(home);
		for (const path of [dirname(memory), memory]) {
			if (lstatSync(path, { throwIfNoEntry: false })) privatePath(path, true);
		}
		// An active runtime can outlive its native settings. Unreadable or stale
		// registration is also insufficient evidence that it has stopped.
		if (lstatSync(join(memory, "active.json"), { throwIfNoEntry: false })) return false;
		const prefs = readHookPreferences(home);
		return CLIENTS.every((client) => {
			const choice = prefs[client];
			return (
				choice?.memory !== true &&
				choice?.diagnostics !== true &&
				!legacyMemoryHooksMayRun(client, root, conversationStorage)
			);
		});
	} catch {
		return false;
	}
}

async function runHook(client) {
	if (!CLIENTS.includes(client)) return;
	const input = await readHookInput();
	if (!input) return;
	if (input.hook_event_name === "PreToolUse" && !claimedTool(input)) return;
	const [{ resolveLocalCheckout }, { verifiedCodingClients }, { installedLocalAnalyzer }] =
		await Promise.all([
			import("../dist/local/scope.js"),
			import("../dist/client-install.js"),
			import("../dist/local/worker-host.js"),
		]);
	const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
	const home = homedir();
	const managed = verifiedCodingClients({
		runningLaunch: { command: process.execPath, args: [entry] },
		rejectProjectOverrides: true,
	}).includes(client);
	const verified = managed && installedLocalAnalyzer() && localWorktreeDiagnosticsReady(home);
	const credentials = verified
		? readRuntimeJSON(join(home, ".pharaoh", "credentials.json"), 65_536)
		: undefined;
	const binding = localWorktreeBinding(client, entry, credentials);
	const result = handleLocalWorktreeHook(input, {
		client,
		binding,
		memoryRuntime: managed ? nativeMemoryRuntimeBinding(client, entry) : undefined,
		resolveCheckout: resolveLocalCheckout,
		home,
	});
	if (result) process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const [, , client, marker] = process.argv;
	if (marker === MARKER) {
		try {
			await runHook(client);
		} catch {
			// Native payloads and local errors do not reach transcripts or diagnostics.
		}
	}
}
