/** Local enrollment, profile selection and bounded native event transport. */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	parseRuntimeEvent,
	RUNTIME_POLICY_VERSION,
	RUNTIME_PROFILES,
} from "./runtime-contract.mjs";
import {
	runtimeSettingsPath,
	supportsAutomaticRuntimeHooks,
	syncRuntimeHooks,
	updateRuntimeHooks,
} from "./runtime-hooks.mjs";
import {
	EVENT_TTL_MS,
	extractRuntimeReceipt,
	nativeIdentifier,
	nativeObservation,
	RUNTIME_CLIENTS,
	runtimeBuild,
	runtimeClient,
	runtimeRef,
	runtimeUuid,
} from "./runtime-native.mjs";
import { nativeRegistration, updateNativeSessionState } from "./runtime-metadata.mjs";
import {
	ensureRuntimeRoot,
	privatePath,
	readRuntimeJSON,
	runtimeLock,
	runtimeRoot,
	writeRuntimeJSON,
} from "./runtime-storage.mjs";
import {
	runtimeProfileId,
	runtimeProfilePath,
	runtimeScope,
	runtimeScopeMatches,
	runtimeTargetId,
} from "./runtime-scope.mjs";

const STATE = "state.json";
const STATUS = "status.json";
const QUEUE = "queue.json";
const LEASE = "delivery.json";
const MAX_QUEUE = 256;
const MAX_INVALIDATIONS = 16;
const MAX_QUEUE_BYTES = 1_048_576;
const MAX_SESSIONS = 32;
const BATCH_SIZE = 20;
const BATCH_BYTES = 12_000;
const SEND_TIMEOUT = 2_000;
const APPROVAL_TTL = 600_000;
const APPROVAL_POLL = 2_000;
const DELIVERY_RETRY_MS = [1_000, 3_000, 8_000];
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const KEY = /^[a-f0-9]{64}$/;
const REF = /^[a-f0-9]{64}$/;
const time = (options) => options.now ?? Date.now();
const root = (options) => runtimeRoot(options.home);
const clientDirectory = (client, options) => {
	const base = join(root(options), client);
	const profile = runtimeProfileId(client, options);
	if (!profile) return base;
	const legacy = readRuntimeJSON(join(base, STATE), 65_536);
	return legacy?.settingsPath === runtimeProfilePath(client, options)
		? base
		: join(root(options), "profiles", `${client}-${profile}`);
};
const validClient = (client) => RUNTIME_CLIENTS.includes(client);
function pendingName(client, options) {
	const profile = runtimeProfileId(client, options);
	const name = `revoke-${client}${profile ? `-${profile}` : ""}.json`;
	const legacy = `revoke-${client}.json`;
	return profile &&
		!pathExists(join(root(options), name)) &&
		pathExists(join(root(options), legacy))
		? legacy
		: name;
}
function choiceName(client, options) {
	const profile = runtimeProfileId(client, options);
	const name = `choice-${client}${profile ? `-${profile}` : ""}.json`;
	const legacy = `choice-${client}.json`;
	return profile &&
		!pathExists(join(root(options), name)) &&
		readRuntimeJSON(join(root(options), legacy), 256)?.disabled === true
		? legacy
		: name;
}
const iso = (value) => new Date(value).toISOString();
const wait = (ms, options) => (options.wait ?? sleep)(ms);
const MAX_TARGETS = 64;

function targetId(client, options) {
	return options.targetId ?? runtimeTargetId(client, options);
}

function targetDescriptor(client, options) {
	return {
		id: runtimeTargetId(client, options),
		scope: runtimeScope(options),
		settingsPath: runtimeSettingsPath(client, options),
	};
}

function targetStateName(id) {
	return `target-${id}.json`;
}
function statusName(client, options) {
	if (options.scope?.kind === "global") return STATUS;
	return runtimeScope(options).kind === "local" || options.targetId
		? `status-${targetId(client, options)}.json`
		: STATUS;
}

function activation(base, client, options) {
	const id = targetId(client, options);
	if (typeof id !== "string" || !REF.test(id)) return null;
	const targets = base.targets;
	const legacy =
		!targets && id === runtimeTargetId(client, { ...options, scope: { kind: "global" } });
	const descriptor = legacy
		? targetDescriptor(client, { ...options, scope: { kind: "global" } })
		: targets?.[id];
	if (
		!descriptor ||
		descriptor.id !== id ||
		descriptor.committed === false ||
		!["global", "local"].includes(descriptor.scope?.kind)
	)
		return null;
	if (
		descriptor.scope.kind === "local" &&
		(typeof descriptor.scope.root !== "string" || !isAbsolute(descriptor.scope.root))
	)
		return null;
	if (
		runtimeTargetId(client, { ...options, scope: descriptor.scope }) !== id ||
		runtimeSettingsPath(client, { ...options, scope: descriptor.scope }) !== descriptor.settingsPath
	)
		return null;
	if (options.scope && runtimeTargetId(client, options) !== id) return null;
	return descriptor;
}

function writeState(directory, state) {
	if (state.scope?.kind === "local") {
		const {
			targets: _targets,
			credential: _credential,
			hashKey: _key,
			signInRef: _signIn,
			...target
		} = state;
		writeRuntimeJSON(directory, targetStateName(state.targetId), target);
	} else writeRuntimeJSON(directory, STATE, state);
}

function scopedOptions(state, options) {
	return { ...options, scope: state.scope ?? { kind: "global" }, targetId: state.targetId };
}

function observesHere(state, options, input) {
	return runtimeScopeMatches(state.scope, { cwd: options.cwd, inputCwd: input?.cwd });
}

function invalidateMovedContext(client, options) {
	const state = readState(client, options);
	if (state?.scope.kind !== "local") return;
	try {
		const now = time(options);
		const events = Object.entries(state.nativeSessions ?? {}).flatMap(([sessionRef, selected]) => {
			if (!selected?.generation) return [];
			return [
				parseRuntimeEvent({
					eventId: randomUUID(),
					observedAt: iso(now),
					sessionRef,
					episodeRef: runtimeRef(state.hashKey, "native-lifecycle", randomUUID()),
					kind: "session_state",
					ancestry: "unknown",
					invalidateGeneration: selected.generation,
					lifecycle: "ambiguous",
				}),
			];
		});
		// Separate tombstone fences an observer that currently holds the shared lock.
		writeRuntimeJSON(clientDirectory(client, options), `context-${state.targetId}.json`, {
			revision: randomUUID(),
			events: retainInvalidations(state.pendingInvalidations, events),
		});
	} catch {
		/* Unsafe private storage is already unavailable to readState. */
	}
}

function existingTargets(base, client, options) {
	if (base.targets && typeof base.targets === "object" && !Array.isArray(base.targets))
		return { ...base.targets };
	const global = targetDescriptor(client, { ...options, scope: { kind: "global" } });
	return { [global.id]: global };
}

function ensureClientParent(client, options) {
	const profile = runtimeProfileId(client, options);
	if (!profile) return;
	for (const path of [join(root(options), "profiles")]) {
		if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
		privatePath(path, true);
	}
}

/** Attach a scope to an already approved enrollment; no browser or server request is made. */
export async function attachRuntimeTarget(client, hookPath, options = {}) {
	if (!validClient(client) || typeof hookPath !== "string" || options.canActivate?.() === false)
		return false;
	const base = readEnrollment(client, options);
	if (!base) return false;
	const directory = clientDirectory(client, options);
	try {
		return (
			(await withChoiceLock(client, options, () =>
				runtimeLock(
					directory,
					() => {
						const current = readEnrollment(client, options);
						if (
							!current ||
							current.generation !== base.generation ||
							options.canActivate?.() === false
						)
							return false;
						const descriptor = targetDescriptor(client, options);
						const targets = existingTargets(current, client, options);
						if (!targets[descriptor.id] && Object.keys(targets).length >= MAX_TARGETS) return false;
						const previous = readState(client, options);
						const unchanged =
							previous?.hookPath === hookPath &&
							previous.node === (options.node ?? process.execPath) &&
							previous.clientBuild === runtimeBuild(options.clientBuild) &&
							previous.proxyBuild === runtimeBuild(options.proxyBuild);
						const target = {
							...(previous ?? {}),
							installationId: current.installationId,
							generation: current.generation,
							client,
							policyVersion: current.policyVersion,
							server: current.server,
							activatedAt: current.activatedAt,
							expiresAt: current.expiresAt,
							metadataVersion: current.metadataVersion,
							targetId: descriptor.id,
							scope: descriptor.scope,
							settingsPath: descriptor.settingsPath,
							hookPath,
							node: options.node ?? process.execPath,
							clientBuild: runtimeBuild(options.clientBuild),
							proxyBuild: runtimeBuild(options.proxyBuild),
							...(unchanged
								? {}
								: {
										nativeRegistration: nativeRegistration(
											client,
											runtimeBuild(options.clientBuild),
											runtimeBuild(options.proxyBuild),
											time(options),
											current.metadataVersion,
										),
										nativeSessions: {},
										sessions: {},
									}),
						};
						const before = { ...targets };
						targets[descriptor.id] = descriptor;
						if (descriptor.scope.kind === "local") writeState(directory, target);
						// Ownership is durable before the native hook can become active.
						writeRuntimeJSON(directory, STATE, {
							...current,
							...(descriptor.scope.kind === "global" ? target : {}),
							targets,
						});
						try {
							syncRuntimeHooks(client, hookPath, {
								...options,
								settingsPath: descriptor.settingsPath,
								targetId: descriptor.scope.kind === "local" ? descriptor.id : undefined,
								generation: current.generation,
								metadataVersion: current.metadataVersion,
							});
						} catch (error) {
							writeRuntimeJSON(directory, STATE, { ...current, targets: before });
							if (descriptor.scope.kind === "local") {
								if (previous) writeState(directory, previous);
								else rmSync(join(directory, targetStateName(descriptor.id)), { force: true });
							}
							throw error;
						}
						writeRuntimeJSON(
							directory,
							descriptor.scope.kind === "local" ? `status-${descriptor.id}.json` : STATUS,
							{
								installationId: current.installationId,
								generation: current.generation,
								expiresAt: current.expiresAt,
							},
						);
						return true;
					},
					time(options),
				),
			)) === true
		);
	} catch {
		return false;
	}
}

function serverOrigin(value) {
	try {
		const url = new URL(value);
		const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		return !url.username &&
			!url.password &&
			(url.protocol === "https:" || (local && url.protocol === "http:"))
			? url.origin
			: null;
	} catch {
		return null;
	}
}

function validIdentity(value) {
	return (
		value &&
		runtimeUuid(value.installationId) &&
		runtimeUuid(value.generation) &&
		validClient(value.client) &&
		serverOrigin(value.server) === value.server
	);
}

function readOAuthCredentials(options) {
	return options.readOAuthCredentials
		? options.readOAuthCredentials()
		: readRuntimeJSON(join(options.home ?? homedir(), ".pharaoh", "credentials.json"), 65_536);
}

function matchesSignIn(state, credentials) {
	return (
		runtimeUuid(credentials?.runtime_session) &&
		serverOrigin(credentials.sse_url) === state.server &&
		runtimeRef(state.hashKey, "sign-in", credentials.runtime_session) === state.signInRef
	);
}

function pathExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return false;
	}
}

function readChoice(client, options) {
	const path = join(root(options), choiceName(client, options));
	if (!pathExists(path)) return null;
	const choice = readRuntimeJSON(path, 256);
	if (!runtimeUuid(choice?.revision) || typeof choice.disabled !== "boolean")
		throw new Error("Unsafe runtime choice.");
	return choice;
}

/** Hold the choice lock only for synchronous local transitions, never for HTTP. */
async function withChoiceLock(client, options, operation) {
	for (let attempt = 0; attempt < 4; attempt++) {
		const result = runtimeLock(
			root(options),
			operation,
			Date.now(),
			60_000,
			`choice-${client}.lock`,
		);
		if (result !== null) return result;
		if (attempt < 3) await sleep(20);
	}
	return null;
}

function automaticRuntimeAvailable(client, options) {
	for (const directory of [join(options.home ?? homedir(), ".pharaoh"), root(options)]) {
		if (pathExists(directory)) privatePath(directory, true);
	}
	return (
		!readChoice(client, options) &&
		!pathExists(clientDirectory(client, options)) &&
		!pathExists(join(root(options), pendingName(client, options))) &&
		supportsAutomaticRuntimeHooks(client, options)
	);
}

/** Prepare one exact in-memory device intent without creating any local state or hooks. */
export function automaticRuntimeIntent(client, options = {}) {
	if (
		!validClient(client) ||
		typeof process.getuid !== "function" ||
		!["darwin", "linux"].includes(process.platform)
	)
		return null;
	try {
		return automaticRuntimeAvailable(client, options)
			? control({ client, installationId: randomUUID(), generation: randomUUID() })
			: null;
	} catch {
		return null;
	}
}

// Cleanup needs ownership even after the enrollment can no longer collect.
function readOwnedEnrollment(client, options) {
	if (!validClient(client)) return null;
	try {
		privatePath(join(options.home ?? homedir(), ".pharaoh"), true);
		privatePath(root(options), true);
		const directory = clientDirectory(client, options);
		privatePath(directory, true);
		const value = readRuntimeJSON(join(directory, STATE), 65_536);
		return validIdentity(value) &&
			value.client === client &&
			(options.generation === undefined || options.generation === value.generation) &&
			(value.profileSettingsPath ?? value.settingsPath) === runtimeProfilePath(client, options)
			? value
			: null;
	} catch {
		return null;
	}
}

function readEnrollment(client, options) {
	try {
		const value = readOwnedEnrollment(client, options);
		if (
			!value ||
			readChoice(client, options)?.disabled ||
			value.policyVersion !== RUNTIME_POLICY_VERSION ||
			typeof value.credential !== "string" ||
			!SECRET.test(value.credential) ||
			typeof value.hashKey !== "string" ||
			!KEY.test(value.hashKey) ||
			!matchesSignIn(value, readOAuthCredentials(options)) ||
			!Number.isFinite(Date.parse(value.activatedAt)) ||
			(value.expiresAt !== null && !(Date.parse(value.expiresAt) > time(options)))
		)
			return null;
		if (options.generation !== undefined && options.generation !== value.generation) return null;
		const pending = readRuntimeJSON(join(root(options), pendingName(client, options)));
		return pending?.generation === value.generation ? null : value;
	} catch {
		return null;
	}
}

function readState(client, options) {
	const enrollment = readEnrollment(client, options);
	if (!enrollment) return null;
	const descriptor = activation(enrollment, client, options);
	if (!descriptor) return null;
	let state = enrollment;
	if (descriptor.scope.kind === "local") {
		state = readRuntimeJSON(
			join(clientDirectory(client, options), targetStateName(descriptor.id)),
			65_536,
		);
		if (
			!state ||
			state.targetId !== descriptor.id ||
			state.installationId !== enrollment.installationId ||
			state.generation !== enrollment.generation ||
			state.settingsPath !== descriptor.settingsPath
		)
			return null;
		// Distinct references prevent a session/turn identifier from joining evidence in another target.
		const hashKey = runtimeRef(enrollment.hashKey, "activation", descriptor.id);
		state = {
			...state,
			credential: enrollment.credential,
			hashKey,
			signInRef: runtimeRef(hashKey, "sign-in", readOAuthCredentials(options)?.runtime_session),
		};
	}
	if (options.hookPath && options.hookPath !== state.hookPath) return null;
	if (state.settingsPath !== descriptor.settingsPath) return null;
	if (descriptor.scope.kind === "local") {
		const movement = readRuntimeJSON(
			join(clientDirectory(client, options), `context-${descriptor.id}.json`),
		);
		if (runtimeUuid(movement?.revision) && movement.revision !== state.contextRevision)
			state = {
				...state,
				contextRevision: movement.revision,
				sessions: {},
				nativeSessions: {},
				receipts: {},
				selection: undefined,
				pendingInvalidations: retainInvalidations(
					state.pendingInvalidations,
					Array.isArray(movement.events)
						? movement.events.flatMap((event) => {
								try {
									return [parseRuntimeEvent(event)];
								} catch {
									return [];
								}
							})
						: [],
				),
			};
	}
	return { ...state, targetId: descriptor.id, scope: descriptor.scope };
}

function control(state) {
	return {
		installationId: state.installationId,
		generation: state.generation,
		client: state.client,
		policyVersion: RUNTIME_POLICY_VERSION,
	};
}

async function loadOAuthCredentials(server, options) {
	if (options.oauthCredentials) return options.oauthCredentials(server);
	// Detached observation never refreshes or writes OAuth credentials.
	return readOAuthCredentials(options);
}

async function request(server, path, body, options, runtimeCredential, stillActive) {
	const credentials = await loadOAuthCredentials(server, options);
	if (
		!credentials?.access_token ||
		serverOrigin(credentials.sse_url) !== server ||
		!(Date.parse(credentials.expires_at) > Date.now())
	)
		return null;
	// OAuth lookup can yield. Recheck the local generation immediately
	// before dispatch so a detached sender cannot resume after cleanup.
	if (stillActive && !stillActive(credentials)) return null;
	const response = await (options.fetchImpl ?? fetch)(new URL(path, server), {
		method: "POST",
		redirect: "error",
		headers: {
			Authorization: `Bearer ${credentials.access_token}`,
			"Content-Type": "application/json",
			...(runtimeCredential && { "X-Pharaoh-Runtime": runtimeCredential }),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(SEND_TIMEOUT),
	});
	if (response.status === 429) {
		const retry = response.headers.get("retry-after");
		return {
			retryAfterMs: retry && /^\d{1,5}$/.test(retry) ? Number(retry) * 1_000 : SEND_TIMEOUT,
		};
	}
	if (!response.ok) return null;
	// Only bounded trusted API acknowledgements enter private state.
	const reader = response.body?.getReader();
	if (!reader) return {};
	const chunks = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > 65_536) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return length ? JSON.parse(Buffer.concat(chunks, length).toString("utf8")) : {};
}

async function approveInstallation(state, options, stillActive) {
	if (!options.onApproval) return null;
	const approval = await request(
		state.server,
		"/api/runtime/approvals",
		control(state),
		options,
		undefined,
		stillActive,
	);
	if (!REF.test(approval?.approvalId ?? "")) return null;
	const remaining = Date.parse(approval.expiresAt) - time(options);
	if (!(remaining > 0 && remaining <= APPROVAL_TTL + 60_000)) return null;
	const url = new URL(approval.verificationUrl);
	if (
		serverOrigin(url.href) !== state.server ||
		url.pathname !== "/setup/runtime-approval" ||
		url.search !== `?code=${approval.approvalId}` ||
		url.hash ||
		!stillActive()
	)
		return null;
	options.onApproval(url.href, approval.approvalId.slice(0, 8).toUpperCase());
	const body = { ...control(state), enabled: true, approvalId: approval.approvalId };
	const deadline = Date.now() + Math.min(remaining, APPROVAL_TTL);
	for (
		let attempt = 0;
		attempt < Math.ceil(APPROVAL_TTL / APPROVAL_POLL) && Date.now() < deadline;
		attempt++
	) {
		const result = await request(
			state.server,
			"/api/runtime/installations",
			body,
			options,
			undefined,
			stillActive,
		);
		if (result?.error !== "approval_pending" && result?.retryAfterMs === undefined) return result;
		const delay = Math.max(APPROVAL_POLL, result.retryAfterMs ?? 0);
		if (Date.now() + delay >= deadline) return null;
		await wait(delay, options);
	}
	return null;
}

function validDeviceApproval(approval, client, options) {
	if (typeof approval?.expiresAt !== "string") return false;
	const remaining = Date.parse(approval.expiresAt) - time(options);
	return (
		approval?.client === client &&
		runtimeUuid(approval.installationId) &&
		runtimeUuid(approval.generation) &&
		approval.policyVersion === RUNTIME_POLICY_VERSION &&
		typeof approval.approvalId === "string" &&
		REF.test(approval.approvalId) &&
		remaining > 0 &&
		remaining <= APPROVAL_TTL + 60_000
	);
}

/** Read only finite local consent and observation status, without network or writes. */
export function runtimeStatus(client, options = {}) {
	if (!validClient(client) || typeof process.getuid !== "function")
		return { consent: "unsupported", receiptCoverage: "unsupported", tokenCoverage: "unsupported" };
	let state;
	let pending;
	let status;
	let disabled;
	let enrollment;
	try {
		privatePath(join(options.home ?? homedir(), ".pharaoh"), true);
		privatePath(root(options), true);
		pending = readRuntimeJSON(join(root(options), pendingName(client, options)));
		disabled = readChoice(client, options)?.disabled;
		enrollment = readEnrollment(client, options);
		privatePath(clientDirectory(client, options), true);
		status = readRuntimeJSON(join(clientDirectory(client, options), statusName(client, options)));
		if (
			runtimeUuid(status?.installationId) &&
			runtimeUuid(status?.generation) &&
			status.generation !== pending?.generation &&
			readState(client, options)?.generation === status.generation &&
			(status.expiresAt === null || Date.parse(status.expiresAt) > time(options))
		)
			state = status;
	} catch {
		/* Doctor reports finite status only. */
	}
	return {
		consent:
			state || enrollment
				? "active"
				: validIdentity(pending)
					? "revocation_pending"
					: status && !disabled
						? "paused"
						: "off",
		...((state || enrollment) && {
			installationId: (state || enrollment).installationId,
			generation: (state || enrollment).generation,
		}),
		...(enrollment && {
			activation: state ? "active" : "absent",
			activeTargets: Object.values(existingTargets(enrollment, client, options)).filter(
				(target) => target.committed !== false,
			).length,
		}),
		receiptCoverage: state ? (state.receiptObserved ? "observed" : "unobserved") : "unsupported",
		tokenCoverage:
			client === "codex" && state
				? state.usageObserved
					? "observed"
					: "unobserved"
				: "unsupported",
	};
}

/** Supply only privately acknowledged metadata for the negotiated client; never trust request input. */
export function runtimeRequestMetadata(clientName, options = {}) {
	const client = runtimeClient(clientName);
	const state = client && readState(client, options);
	if (state && !observesHere(state, options)) {
		invalidateMovedContext(client, options);
		return undefined;
	}
	return state && observesHere(state, options)
		? {
				server: state.server,
				metadata: {
					installationId: state.installationId,
					generation: state.generation,
					credential: state.credential,
				},
			}
		: undefined;
}

/** Bind the exact opaque server receipt to the target that received it. Nothing is sent here. */
export function recordRuntimeReceipt(clientName, result, options = {}) {
	try {
		const client = runtimeClient(clientName);
		const state = client && readState(client, options);
		if (!state || !observesHere(state, options)) return false;
		if (state.scope.kind !== "local") return true;
		const receipt = extractRuntimeReceipt(result, time(options));
		if (!receipt) return false;
		return (
			runtimeLock(
				clientDirectory(client, options),
				() => {
					const current = readState(client, options);
					if (
						!current ||
						current.generation !== state.generation ||
						!observesHere(current, options)
					)
						return false;
					const receipts = Object.fromEntries(
						Object.entries(current.receipts ?? {})
							.filter(([, expires]) => Date.parse(expires) > time(options))
							.slice(-MAX_QUEUE + 1),
					);
					receipts[receipt.receipt] = receipt.expiresAt;
					writeState(clientDirectory(client, options), { ...current, receipts });
					return true;
				},
				time(options),
			) === true
		);
	} catch {
		// Optional receipt storage must not replace an already answered tool call.
		return false;
	}
}

/** Refresh installation evidence outside hooks, at most daily; never upgrade registered capability.
 * @param clientName - Negotiated local client label, not a model-supplied tool argument.
 * @param discover - Bounded executable/package build discovery run only when stale.
 * @param options - Private enrollment location and clock.
 * @returns Whether current installation evidence was refreshed.
 */
export function refreshRuntimeBuildEvidence(clientName, discover, options = {}) {
	const client = runtimeClient(clientName);
	const initial = client && readState(client, options);
	if (!initial || !observesHere(initial, options)) return false;
	return (
		runtimeLock(
			clientDirectory(client, options),
			() => {
				const state = readState(client, options);
				if (!state) return false;
				const at = time(options);
				const previous = state.nativeRegistration;
				const managedCli = [
					"claude-code",
					"claude code",
					"claude-cli",
					"codex",
					"codex_cli_rs",
					"codex-mcp-client",
				].includes(clientName?.toLowerCase());
				if (!managedCli && previous?.capability !== "unsupported") {
					writeState(clientDirectory(client, options), {
						...state,
						nativeRegistration: { ...previous, capability: "unsupported" },
					});
					return false;
				}
				if (previous && at - Date.parse(previous.buildObservedAt) < EVENT_TTL_MS) return false;
				let builds = {};
				try {
					builds = discover(client);
				} catch {
					/* Failed discovery remains explicitly unknown. */
				}
				writeState(clientDirectory(client, options), {
					...state,
					nativeRegistration: {
						...previous,
						id: previous?.id ?? randomUUID(),
						capability: managedCli ? (previous?.capability ?? "unsupported") : "unsupported",
						clientBuild: runtimeBuild(builds.clientBuild),
						proxyBuild: runtimeBuild(builds.proxyBuild),
						buildObservedAt: iso(at),
					},
				});
				return true;
			},
			time(options),
		) === true
	);
}

/** Redeem a device grant or obtain a manual approval before installing native hooks. */
export async function enableRuntime(client, server, hookPath, options = {}) {
	if (!validClient(client) || !serverOrigin(server) || typeof hookPath !== "string") return false;
	server = serverOrigin(server);
	const approval = options.deviceApproval;
	const automatic = approval !== undefined;
	if (automatic && !validDeviceApproval(approval, client, options)) return false;
	if (!automatic && readEnrollment(client, options) && !readState(client, options))
		return attachRuntimeTarget(client, hookPath, options);
	const launch = {
		hookPath,
		node: options.node ?? process.execPath,
		clientBuild: runtimeBuild(options.clientBuild),
		proxyBuild: runtimeBuild(options.proxyBuild),
	};
	const settingsPath = runtimeSettingsPath(client, options);
	const credentials = readOAuthCredentials(options);
	if (
		!runtimeUuid(credentials?.runtime_session) ||
		serverOrigin(credentials.sse_url) !== server ||
		(automatic && credentials.runtime_session !== options.expectedRuntimeSession)
	)
		return false;
	ensureRuntimeRoot(options.home);
	ensureClientParent(client, options);
	return (
		(await runtimeLock(
			root(options),
			async () => {
				const directory = clientDirectory(client, options);
				const choice = readChoice(client, options)?.revision ?? null;
				const sameChoice = () => (readChoice(client, options)?.revision ?? null) === choice;
				const current = readState(client, options);
				if (current) {
					if (automatic || current.server !== server) return false;
					return withChoiceLock(client, options, () =>
						runtimeLock(
							directory,
							() => {
								const state = readState(client, options);
								if (!sameChoice() || state?.generation !== current.generation) return false;
								syncRuntimeHooks(client, hookPath, {
									...options,
									settingsPath,
									generation: state.generation,
									metadataVersion: state.metadataVersion,
								});
								writeState(directory, {
									...state,
									...launch,
									nativeRegistration: nativeRegistration(
										client,
										launch.clientBuild,
										launch.proxyBuild,
										time(options),
										state.metadataVersion,
									),
									nativeSessions: {},
								});
								return true;
							},
							time(options),
						),
					);
				}
				if (!automatic && !(await revokeRuntime(client, options))) return false;
				const state = {
					installationId: approval?.installationId ?? randomUUID(),
					generation: approval?.generation ?? randomUUID(),
					client,
					server,
					settingsPath,
					profileSettingsPath: runtimeProfilePath(client, options),
				};
				const hashKey = randomBytes(32).toString("hex");
				const signInRef = runtimeRef(hashKey, "sign-in", credentials.runtime_session);
				const bound = { ...state, hashKey, signInRef };
				const pending = join(root(options), pendingName(client, options));
				const available = () => !automatic || options.canActivate?.() !== false;
				const stillActive = (currentCredentials = readOAuthCredentials(options)) => {
					const reservation = readRuntimeJSON(pending);
					return (
						reservation?.generation === state.generation &&
						reservation.installationId === state.installationId &&
						reservation.settingsPath === settingsPath &&
						reservation.enabling === true &&
						existsSync(directory) &&
						sameChoice() &&
						runtimeSettingsPath(client, options) === settingsPath &&
						(!automatic || validDeviceApproval(approval, client, options)) &&
						available() &&
						matchesSignIn(bound, currentCredentials) &&
						matchesSignIn(bound, readOAuthCredentials(options))
					);
				};
				let active = false;
				let reserved = false;
				try {
					const ready = await withChoiceLock(client, options, () => {
						if (!sameChoice() || !matchesSignIn(bound, readOAuthCredentials(options))) return false;
						if (!available() || (automatic && !automaticRuntimeAvailable(client, options)))
							return false;
						// Keep the exact undo identity before any request could create server state.
						writeRuntimeJSON(root(options), pendingName(client, options), {
							...state,
							enabling: true,
						});
						reserved = true;
						mkdirSync(directory, { mode: 0o700 });
						return true;
					});
					if (!ready) return false;
					const answer = automatic
						? await request(
								state.server,
								"/api/runtime/installations",
								{ ...control(state), enabled: true, approvalId: approval.approvalId },
								options,
								undefined,
								stillActive,
							)
						: await approveInstallation(state, options, stillActive);
					if (
						!answer ||
						answer.policyVersion !== RUNTIME_POLICY_VERSION ||
						answer.installationId !== state.installationId ||
						answer.generation !== state.generation ||
						typeof answer.credential !== "string" ||
						!SECRET.test(answer.credential) ||
						!Number.isFinite(Date.parse(answer.activatedAt)) ||
						(answer.expiresAt !== null && !(Date.parse(answer.expiresAt) > time(options)))
					)
						return false;
					return await withChoiceLock(client, options, () => {
						if (!stillActive()) return false;
						const enrolled = {
							...bound,
							policyVersion: RUNTIME_POLICY_VERSION,
							credential: answer.credential,
							activatedAt: answer.activatedAt,
							expiresAt: answer.expiresAt,
							metadataVersion: answer.metadataVersion === 2 ? 2 : 1,
							...launch,
							nativeRegistration: nativeRegistration(
								client,
								launch.clientBuild,
								launch.proxyBuild,
								time(options),
								answer.metadataVersion === 2 ? 2 : 1,
							),
							sessions: {},
						};
						const descriptor = targetDescriptor(client, options);
						writeRuntimeJSON(directory, STATE, {
							...enrolled,
							targets: { [descriptor.id]: descriptor },
						});
						if (descriptor.scope.kind === "local")
							writeState(directory, {
								...enrolled,
								scope: descriptor.scope,
								targetId: descriptor.id,
							});
						syncRuntimeHooks(client, hookPath, {
							...options,
							automatic,
							settingsPath,
							generation: state.generation,
							metadataVersion: answer.metadataVersion === 2 ? 2 : 1,
						});
						writeRuntimeJSON(directory, statusName(client, options), {
							installationId: state.installationId,
							generation: state.generation,
							expiresAt: answer.expiresAt,
						});
						rmSync(pending, { force: true });
						if (!automatic && choice !== null)
							writeRuntimeJSON(root(options), choiceName(client, options), {
								revision: randomUUID(),
								disabled: false,
							});
						active = true;
						return true;
					});
				} catch {
					return false;
				} finally {
					if (reserved && !active) await revokeRuntime(client, options);
				}
			},
			time(options),
			APPROVAL_TTL + 120_000,
		)) === true
	);
}

async function finishRevocation(client, options, hooksRemoved) {
	try {
		privatePath(join(options.home ?? homedir(), ".pharaoh"), true);
		privatePath(root(options), true);
	} catch (error) {
		return error.code === "ENOENT";
	}
	const path = join(root(options), pendingName(client, options));
	const pending = readRuntimeJSON(path);
	if (!validIdentity(pending) || pending.client !== client) return !existsSync(path);
	try {
		const acknowledgment = await request(
			pending.server,
			"/api/runtime/installations",
			{ ...control(pending), enabled: false },
			options,
		);
		if (
			acknowledgment?.revoked === true &&
			acknowledgment.installationId === pending.installationId &&
			acknowledgment.generation === pending.generation &&
			acknowledgment.policyVersion === RUNTIME_POLICY_VERSION
		) {
			return (
				!hooksRemoved ||
				(await withChoiceLock(client, options, () => {
					if (readRuntimeJSON(path)?.generation === pending.generation)
						rmSync(path, { force: true });
					return true;
				})) === true
			);
		}
	} catch {
		/* Offline: retain only the pending control record. */
	}
	return false;
}

function removeRuntimeLocally(client, options) {
	const directory = clientDirectory(client, options);
	const pending = join(root(options), pendingName(client, options));
	if (!existsSync(directory) && !existsSync(pending)) return true;
	try {
		privatePath(join(options.home ?? homedir(), ".pharaoh"), true);
		privatePath(root(options), true);
		const pendingControl = readRuntimeJSON(pending);
		let owned =
			validIdentity(pendingControl) && pendingControl.client === client ? pendingControl : null;
		if (owned?.enabling === true) {
			owned = { ...owned, enabling: false };
			writeRuntimeJSON(root(options), pendingName(client, options), owned);
		}
		if (existsSync(directory)) {
			privatePath(directory, true);
			// Expired or otherwise inactive credentials still identify a generation
			// whose server-side enrollment needs to be revoked.
			const state = readRuntimeJSON(join(directory, STATE), 65_536);
			if (validIdentity(state) && state.client === client) {
				owned = {
					installationId: state.installationId,
					generation: state.generation,
					client,
					server: state.server,
					settingsPath: state.settingsPath,
					targets: Object.values(existingTargets(state, client, options)),
				};
				writeRuntimeJSON(root(options), pendingName(client, options), owned);
			}
			rmSync(directory, { recursive: true, force: true });
		}
		if (owned) {
			for (const target of owned.targets ?? [{ settingsPath: owned.settingsPath }])
				syncRuntimeHooks(client, null, {
					...options,
					scope: target.scope,
					settingsPath: target.settingsPath,
					generation: owned.generation,
				});
		}
		return true;
	} catch {
		return false;
	}
}

/** Detach one activation, fencing its sender and deleting only its unsent observations. */
export async function detachRuntimeTarget(client, options = {}) {
	if (!validClient(client)) return false;
	let retire = false;
	try {
		const directory = clientDirectory(client, options);
		if (!existsSync(directory)) return await revokeRuntime(client, options);
		const changed = await withChoiceLock(client, options, () =>
			runtimeLock(
				directory,
				() => {
					const base = readOwnedEnrollment(client, options);
					if (!base) return false;
					const id = targetId(client, options);
					const targets = existingTargets(base, client, options);
					const descriptor = targets[id];
					if (!descriptor) {
						retire = Object.keys(targets).length === 0;
						return !retire || removeRuntimeLocally(client, options);
					}
					targets[descriptor.id] = { ...descriptor, committed: false };
					// Remove ownership from committed state first: new intake cannot revive this target.
					writeRuntimeJSON(directory, STATE, { ...base, targets });
					writeRuntimeJSON(
						directory,
						QUEUE,
						readQueue(directory, time(options)).filter(
							(event) =>
								!isTargetEvent(event, { targetId: descriptor.id, scope: descriptor.scope }),
						),
						MAX_QUEUE_BYTES,
					);
					const lease = readRuntimeJSON(join(directory, LEASE));
					if (lease?.targetId === descriptor.id) rmSync(join(directory, LEASE), { force: true });
					if (descriptor.scope.kind === "local") {
						rmSync(join(directory, targetStateName(descriptor.id)), { force: true });
						rmSync(join(directory, `context-${descriptor.id}.json`), { force: true });
					}
					rmSync(
						join(
							directory,
							descriptor.scope.kind === "local" ? `status-${descriptor.id}.json` : STATUS,
						),
						{ force: true },
					);
					syncRuntimeHooks(client, null, {
						...options,
						scope: descriptor.scope,
						settingsPath: descriptor.settingsPath,
						generation: base.generation,
					});
					delete targets[descriptor.id];
					writeRuntimeJSON(directory, STATE, { ...base, targets });
					retire = Object.keys(targets).length === 0;
					// Retire under the same choice lock: an attach cannot be accepted
					// between removing the last target and fencing this generation.
					return !retire || removeRuntimeLocally(client, options);
				},
				time(options),
			),
		);
		if (!retire) return changed === true;
		return (await finishRevocation(client, options, changed === true)) && changed === true;
	} catch {
		return false;
	}
}

/** Immediately discard local observation data and keys, then try remote revocation. */
export async function revokeRuntime(client, options = {}) {
	if (!validClient(client)) return false;
	try {
		// A changed profile environment must not strand the only legacy enrollment.
		if (!options.scope && !existsSync(clientDirectory(client, options))) {
			const legacy = readRuntimeJSON(join(root(options), client, STATE), 65_536);
			if (validIdentity(legacy) && legacy.client === client) {
				const profilePath = legacy.profileSettingsPath ?? legacy.settingsPath;
				if (typeof profilePath === "string" && isAbsolute(profilePath))
					options = {
						...options,
						env: {
							...(options.env ?? process.env),
							[client === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: dirname(profilePath),
						},
					};
			}
		}
		if (!pathExists(root(options))) return true;
		privatePath(join(options.home ?? homedir(), ".pharaoh"), true);
		const removed = await withChoiceLock(client, options, () =>
			removeRuntimeLocally(client, options),
		);
		if (removed === null) return false;
		return (await finishRevocation(client, options, removed)) && removed;
	} catch {
		return false;
	}
}

/** Save a user's off switch even without an enrollment, then remove the current generation. */
export async function disableRuntime(client, options = {}) {
	if (!validClient(client)) return "not_saved";
	if (typeof process.getuid !== "function") return "unsupported";
	let saved = false;
	try {
		ensureRuntimeRoot(options.home);
		const removed = await withChoiceLock(client, options, () => {
			writeRuntimeJSON(root(options), choiceName(client, options), {
				revision: randomUUID(),
				disabled: true,
			});
			saved = true;
			return removeRuntimeLocally(client, options);
		});
		if (removed === null) return "not_saved";
		return (await finishRevocation(client, options, removed)) && removed
			? "disabled"
			: "cleanup_pending";
	} catch {
		return saved ? "cleanup_pending" : "not_saved";
	}
}

/** Select a finite owner profile for exactly the next episode start. */
export function selectRuntimeProfile(client, profileId, options = {}) {
	if (!validClient(client) || !RUNTIME_PROFILES.includes(profileId) || !readState(client, options))
		return null;
	const directory = clientDirectory(client, options);
	return runtimeLock(
		directory,
		() => {
			const state = readState(client, options);
			if (!state) return null;
			const selection = {
				selectionId: randomUUID(),
				profileId,
				expiresAt: iso(time(options) + EVENT_TTL_MS),
				installationId: state.installationId,
				generation: state.generation,
			};
			writeState(directory, {
				...state,
				selection: { ...selection, controlled: options.controlled === true },
			});
			return selection;
		},
		time(options),
	);
}

/** Return the exact consumed profile receipt; never correlate by time or path. */
export function runtimeProfileReceipt(client, selectionId, options = {}) {
	const selection = readState(client, options)?.selection;
	if (
		!runtimeUuid(selectionId) ||
		selection?.selectionId !== selectionId ||
		!(Date.parse(selection.expiresAt) > time(options)) ||
		!REF.test(selection.episodeRef ?? "")
	)
		return null;
	const { controlled: _controlled, ...receipt } = selection;
	return receipt;
}

/** Return only our active hooks for a controlled caller's explicit settings. */
export function configuredRuntimeHooks(client, options = {}) {
	const state = readState(client, options);
	if (!state || typeof state.hookPath !== "string" || typeof state.node !== "string") return null;
	const { selectionId } = options;
	if (
		selectionId &&
		(!runtimeUuid(selectionId) ||
			state.selection?.selectionId !== selectionId ||
			!state.selection.controlled ||
			state.selection.episodeRef ||
			!(Date.parse(state.selection.expiresAt) > time(options)))
	)
		return null;
	return updateRuntimeHooks(
		{},
		client,
		state.hookPath,
		state.node,
		state.clientBuild,
		state.generation,
		selectionId,
		state.metadataVersion,
	);
}

function retainInvalidations(previous = [], added = []) {
	const unique = new Map();
	for (const event of [...previous, ...added]) {
		if (event.invalidateAll) return [event];
		if (event.invalidateGeneration && !unique.has(event.invalidateGeneration))
			unique.set(event.invalidateGeneration, event);
	}
	const events = [...unique.values()];
	if (events.length <= MAX_INVALIDATIONS) return events;
	const { invalidateGeneration: _generation, ...last } = events.at(-1);
	return [{ ...last, eventId: randomUUID(), invalidateAll: true, lifecycle: "ambiguous" }];
}

function invalidationForDropped(event, now) {
	if (!event.exploration?.selectionGeneration) return [];
	return [
		parseRuntimeEvent({
			eventId: randomUUID(),
			observedAt: iso(now),
			sessionRef: event.sessionRef,
			episodeRef: event.episodeRef,
			kind: "session_state",
			ancestry: "unknown",
			exploration: event.exploration,
			invalidateGeneration: event.exploration.selectionGeneration,
			lifecycle: "ambiguous",
		}),
	];
}

function readQueue(directory, now, persistPrune = false) {
	const source = readRuntimeJSON(join(directory, QUEUE), MAX_QUEUE_BYTES);
	const parsed = Array.isArray(source)
		? source.flatMap((value) => {
				try {
					const { __targetId, ...wire } = value;
					const event = parseRuntimeEvent(wire);
					return [
						{
							...event,
							...(typeof __targetId === "string" && REF.test(__targetId) ? { __targetId } : {}),
						},
					];
				} catch {
					return [];
				}
			})
		: [];
	const queue = persistPrune
		? parsed
				.filter(
					(event) =>
						event.kind === "session_state" || Date.parse(event.observedAt) > now - EVENT_TTL_MS,
				)
				.slice(-MAX_QUEUE)
		: parsed;
	if (persistPrune && Array.isArray(source) && queue.length !== source.length) {
		const kept = new Set(queue.map((event) => event.eventId));
		for (const event of parsed.filter((entry) => !kept.has(entry.eventId)))
			persistDroppedInvalidation(directory, event, now);
		writeRuntimeJSON(directory, QUEUE, queue, MAX_QUEUE_BYTES);
	}
	return queue;
}

function isTargetEvent(event, state) {
	return event.__targetId ? event.__targetId === state.targetId : state.scope?.kind !== "local";
}

function persistDroppedInvalidation(directory, event, now) {
	const enrollment = readRuntimeJSON(join(directory, STATE), 65_536);
	const descriptor = event.__targetId && enrollment?.targets?.[event.__targetId];
	const local = descriptor?.scope?.kind === "local";
	const state = local
		? readRuntimeJSON(join(directory, targetStateName(event.__targetId)), 65_536)
		: enrollment;
	const invalidations = invalidationForDropped(event, now);
	if (!state || !invalidations.length) return;
	writeState(directory, {
		...state,
		...(local ? { scope: descriptor.scope, targetId: descriptor.id } : {}),
		pendingInvalidations: retainInvalidations(state.pendingInvalidations, invalidations),
	});
}

/** Convert one native callback into a bounded private event, never a transcript record. */
export function recordRuntimeHook(client, input, options = {}) {
	const now = time(options);
	const initial = validClient(client) && readState(client, options);
	if (!initial) return false;
	if (!observesHere(initial, options, input)) {
		invalidateMovedContext(client, options);
		return false;
	}
	const nativeSession = nativeIdentifier(input?.session_id);
	if (!nativeSession) return false;
	const directory = clientDirectory(client, options);
	return (
		runtimeLock(
			directory,
			() => {
				let state = readState(client, options);
				if (!state || !observesHere(state, options, input)) return false;
				const observation = nativeObservation(input, client, state.hashKey, now, options);
				if (!observation) return false;
				if (state.scope.kind === "local" && observation.receipt) {
					const receipts = { ...(state.receipts ?? {}) };
					if (!(Date.parse(receipts[observation.receipt]) > now)) delete observation.receipt;
					else delete receipts[observation.receipt];
					state = { ...state, receipts };
				}
				const sessionRef = runtimeRef(state.hashKey, "session", nativeSession);
				const nativeTurn =
					client === "codex"
						? nativeIdentifier(input.turn_id)
						: state.metadataVersion === 2
							? nativeIdentifier(input.prompt_id)
							: null;
				const turnRef = nativeTurn
					? runtimeRef(state.hashKey, "turn", `${nativeSession}\0${nativeTurn}`)
					: undefined;
				let exploration;
				let queuedInvalidation = false;
				if (state.metadataVersion === 2) {
					const nativeSessions = { ...(state.nativeSessions ?? {}) };
					const transition = updateNativeSessionState(
						client,
						input,
						nativeSessions[sessionRef],
						state.nativeRegistration,
						state.hashKey,
						now,
					);
					exploration = transition.metadata;
					if (client === "claude-code" && !observation.boundary && !nativeTurn)
						exploration = { ...exploration, selectionGeneration: null };
					const invalidations = [];
					if (transition.invalidateGeneration)
						invalidations.push({
							ref: sessionRef,
							generation: transition.invalidateGeneration,
							lifecycle: transition.lifecycle ?? "expired",
						});
					if (transition.selection) nativeSessions[sessionRef] = transition.selection;
					else delete nativeSessions[sessionRef];
					const ordered = Object.entries(nativeSessions).sort((a, b) => b[1].at - a[1].at);
					for (const [ref, selected] of ordered) {
						if (
							now - selected.at < EVENT_TTL_MS &&
							ordered.findIndex(([id]) => id === ref) < MAX_SESSIONS
						)
							continue;
						invalidations.push({
							ref,
							generation: selected.generation,
							lifecycle: now - selected.at >= EVENT_TTL_MS ? "expired" : "evicted",
						});
						delete nativeSessions[ref];
					}
					const lifecycleEvents = invalidations.map((item) =>
						parseRuntimeEvent({
							eventId: randomUUID(),
							observedAt: iso(now),
							sessionRef: item.ref,
							episodeRef: runtimeRef(state.hashKey, "native-lifecycle", randomUUID()),
							kind: "session_state",
							ancestry: "unknown",
							exploration,
							invalidateGeneration: item.generation,
							lifecycle: item.lifecycle,
						}),
					);
					queuedInvalidation = lifecycleEvents.length > 0;
					state = {
						...state,
						nativeSessions,
						pendingInvalidations: retainInvalidations(state.pendingInvalidations, lifecycleEvents),
					};
					writeState(directory, state);
				}
				const sessions = Object.fromEntries(
					Object.entries(state.sessions ?? {})
						.filter(([, session]) => session && session.at > now - EVENT_TTL_MS)
						.sort((a, b) => b[1].at - a[1].at)
						.slice(0, MAX_SESSIONS - 1),
				);
				const previous = sessions[sessionRef];
				if (observation.boundary === "session" || observation.boundary === "switch") {
					// Resume can retain the same native ID; never reuse its earlier turn implicitly.
					delete sessions[sessionRef];
					writeState(directory, { ...state, sessions });
					return queuedInvalidation;
				}
				const start = observation.kind === "episode_start";
				const current = previous && (!turnRef || previous.turnRef === turnRef) ? previous : null;
				if (start && turnRef && current) return queuedInvalidation;
				if (
					observation.kind === "episode_end" &&
					(!current || (input.hook_event_name === "SessionEnd" && current.stopped))
				)
					return queuedInvalidation;
				const episodeRef = start
					? (turnRef ?? runtimeRef(state.hashKey, "episode", randomUUID()))
					: (turnRef ?? current?.episodeRef ?? runtimeRef(state.hashKey, "unbound", nativeSession));
				let selection = state.selection;
				const selectionMatches = selection?.controlled
					? options.selectionId === selection.selectionId
					: !options.selectionId;
				const profile =
					start &&
					observation.ancestry === "root" &&
					selectionMatches &&
					selection &&
					!selection.episodeRef &&
					Date.parse(selection.expiresAt) > now
						? selection.profileId
						: undefined;
				const controlRef =
					profile && selection.controlled
						? runtimeRef(state.hashKey, "control", selection.selectionId)
						: undefined;
				if (profile) selection = { ...selection, episodeRef, ...(controlRef && { controlRef }) };
				if (start || current)
					sessions[sessionRef] = {
						episodeRef,
						at: now,
						...(turnRef && { turnRef }),
						...(observation.kind === "episode_end" && { stopped: true }),
					};
				const event = parseRuntimeEvent({
					...observation,
					eventId: randomUUID(),
					observedAt: iso(now),
					sessionRef,
					episodeRef,
					clientBuild: state.clientBuild,
					proxyBuild: state.proxyBuild,
					...(profile && { profileId: profile }),
					...(controlRef && { controlRef }),
					...(exploration && { exploration }),
				});
				const queue = readQueue(directory, now);
				queue.push({ ...event, __targetId: state.targetId });
				if (queue.length > MAX_QUEUE) {
					const oldest = queue.reduce(
						(index, item, position) =>
							item.observedAt < queue[index].observedAt ? position : index,
						0,
					);
					const dropped = queue.splice(oldest, 1)[0];
					if (isTargetEvent(dropped, state))
						state = {
							...state,
							pendingInvalidations: retainInvalidations(
								state.pendingInvalidations,
								invalidationForDropped(dropped, now),
							),
						};
					else persistDroppedInvalidation(directory, dropped, now);
				}
				const receiptObserved = state.receiptObserved || Boolean(event.receipt);
				const usageObserved =
					state.usageObserved ||
					Boolean(event.tokens && Object.values(event.tokens).some((value) => value !== null));
				// Consume selection before the spool write. An interrupted write may lose coverage,
				// but cannot attach the same owner selection to a second episode.
				writeState(directory, {
					...state,
					sessions,
					selection,
					receiptObserved,
					usageObserved,
				});
				writeRuntimeJSON(directory, QUEUE, queue, MAX_QUEUE_BYTES);
				if (
					receiptObserved !== Boolean(state.receiptObserved) ||
					usageObserved !== Boolean(state.usageObserved)
				)
					writeRuntimeJSON(directory, statusName(client, scopedOptions(state, options)), {
						installationId: state.installationId,
						generation: state.generation,
						expiresAt: state.expiresAt,
						receiptObserved,
						usageObserved,
					});
				return true;
			},
			now,
		) === true
	);
}

/** Claim one short delivery lease without blocking a hook or spawning duplicate senders. */
export function claimRuntimeDelivery(client, options = {}) {
	const initial = validClient(client) && readState(client, options);
	if (!initial || !observesHere(initial, options)) return null;
	const directory = clientDirectory(client, options);
	return runtimeLock(
		directory,
		() => {
			const state = readState(client, options);
			if (!state) return null;
			const now = time(options);
			const lease = readRuntimeJSON(join(directory, LEASE));
			if (lease?.expires > now) return null;
			const ordinary = readQueue(directory, now, true).filter((event) =>
				isTargetEvent(event, state),
			);
			if (!ordinary.length && !readState(client, options)?.pendingInvalidations?.length)
				return null;
			const id = randomUUID();
			writeRuntimeJSON(directory, LEASE, { id, targetId: state.targetId, expires: now + 60_000 });
			return id;
		},
		time(options),
	);
}

/** Retry only queued deliveries; acknowledgment IDs never identify native model attempts. */
export async function flushRuntimeQueue(client, leaseId, options = {}) {
	if (!validClient(client) || !runtimeUuid(leaseId)) return;
	const directory = clientDirectory(client, options);
	const state = readState(client, options);
	if (
		!state ||
		!observesHere(state, options) ||
		readRuntimeJSON(join(directory, LEASE))?.id !== leaseId
	)
		return;
	const stillActive = (credentials) =>
		readState(client, options)?.generation === state.generation &&
		readRuntimeJSON(join(directory, LEASE))?.id === leaseId &&
		(!credentials || matchesSignIn(state, credentials));
	try {
		let failures = 0;
		for (let round = 0; round < 6; round++) {
			if (!stillActive()) return;
			const body = {
				installationId: state.installationId,
				generation: state.generation,
				policyVersion: RUNTIME_POLICY_VERSION,
				events: [],
			};
			const queue = runtimeLock(
				directory,
				() => {
					if (!stillActive()) return null;
					const ordinary = readQueue(directory, time(options), true).filter((event) =>
						isTargetEvent(event, state),
					);
					return [...(readState(client, options)?.pendingInvalidations ?? []), ...ordinary];
				},
				time(options),
			);
			for (const event of (queue ?? []).slice(0, BATCH_SIZE)) {
				const { __targetId: _privateTarget, ...wire } = event;
				body.events.push(wire);
				if (Buffer.byteLength(JSON.stringify(body)) > BATCH_BYTES) {
					body.events.pop();
					break;
				}
			}
			const { events } = body;
			if (!events.length) return;
			// Intake uses a nonblocking lock; never hold it while OAuth or HTTP waits.
			// request rechecks the generation and lease immediately before dispatch.
			const result = await request(
				state.server,
				"/api/runtime/events",
				body,
				options,
				state.credential,
				stillActive,
			).catch(() => null);
			if (!result || result.retryAfterMs !== undefined) {
				const delay = Math.max(
					DELIVERY_RETRY_MS[failures++] ?? Infinity,
					result?.retryAfterMs ?? 0,
				);
				if (delay > DELIVERY_RETRY_MS.at(-1) || !stillActive()) return;
				// The detached worker remains alive for bounded retries after the final native callback.
				await wait(delay, options);
				continue;
			}
			const sent = new Set(events.map((event) => event.eventId));
			const acknowledged = new Set(
				[result.acceptedEventIds, result.rejectedEventIds].flatMap((ids) =>
					Array.isArray(ids) ? ids.filter((id) => sent.has(id)) : [],
				),
			);
			const accepted = new Set(
				Array.isArray(result.acceptedEventIds)
					? result.acceptedEventIds.filter((id) => sent.has(id))
					: [],
			);
			const pending = new Set(
				Array.isArray(result.pendingEventIds)
					? result.pendingEventIds.filter((id) => sent.has(id) && !acknowledged.has(id))
					: [],
			);
			if (!acknowledged.size && !pending.size) return;
			if (
				!runtimeLock(
					directory,
					() => {
						if (!stillActive()) return false;
						const queue = readQueue(directory, time(options));
						const current = readState(client, options);
						if (current) {
							let metadataVersion = result.metadataVersion === 2 ? 2 : 1;
							let registration = current.nativeRegistration;
							const changed = metadataVersion !== (current.metadataVersion ?? 1);
							if (changed) {
								try {
									const clientBuild = registration?.clientBuild ?? current.clientBuild;
									const proxyBuild = registration?.proxyBuild ?? current.proxyBuild;
									syncRuntimeHooks(client, current.hookPath, {
										...options,
										settingsPath: current.settingsPath,
										node: current.node,
										clientBuild,
										generation: current.generation,
										metadataVersion,
									});
									// Installing a newly negotiated hook is not a new build observation.
									const observedAt = Date.parse(
										registration?.buildObservedAt ?? current.activatedAt,
									);
									registration = nativeRegistration(
										client,
										clientBuild,
										proxyBuild,
										observedAt,
										metadataVersion,
									);
								} catch {
									// Keep v1 collection when native settings cannot accept the new hook.
									metadataVersion = 1;
									registration = { ...registration, capability: "unsupported" };
								}
							}
							writeState(directory, {
								...current,
								pendingInvalidations: (current.pendingInvalidations ?? []).filter(
									(event) => !accepted.has(event.eventId),
								),
								metadataVersion,
								nativeRegistration: registration,
								...(changed ? { nativeSessions: {} } : {}),
							});
						}
						// Give newer events a turn across leases as well as within this sender.
						// Preserve pending IDs so their next delivery can join the same receipt.
						writeRuntimeJSON(
							directory,
							QUEUE,
							[
								...queue.filter(
									(event) => !acknowledged.has(event.eventId) && !pending.has(event.eventId),
								),
								...queue.filter((event) => pending.has(event.eventId)),
							],
							MAX_QUEUE_BYTES,
						);
						return true;
					},
					time(options),
				)
			)
				return;
			if (pending.size) await wait(150 * (round + 1), options);
		}
	} catch {
		/* Uncertain delivery stays in the queue with the same IDs. */
	} finally {
		try {
			runtimeLock(
				directory,
				() => {
					if (readRuntimeJSON(join(directory, LEASE))?.id === leaseId)
						rmSync(join(directory, LEASE), { force: true });
				},
				time(options),
			);
		} catch {
			/* A revoked or expired lease cannot resume collection. */
		}
	}
}
