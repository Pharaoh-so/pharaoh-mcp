/** Local enrollment, profile selection and bounded native event transport. */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
const clientDirectory = (client, options) => join(root(options), client);
const validClient = (client) => RUNTIME_CLIENTS.includes(client);
const pendingName = (client) => `revoke-${client}.json`;
const choiceName = (client) => `choice-${client}.json`;
const iso = (value) => new Date(value).toISOString();
const wait = (ms, options) => (options.wait ?? sleep)(ms);

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
	const path = join(root(options), choiceName(client));
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
		!pathExists(join(root(options), pendingName(client))) &&
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

function readState(client, options) {
	if (!validClient(client)) return null;
	try {
		privatePath(join(options.home ?? homedir(), ".pharaoh"), true);
		privatePath(root(options), true);
		if (readChoice(client, options)?.disabled) return null;
		const directory = clientDirectory(client, options);
		privatePath(directory, true);
		const value = readRuntimeJSON(join(directory, STATE), 65_536);
		if (
			!validIdentity(value) ||
			value.policyVersion !== RUNTIME_POLICY_VERSION ||
			value.client !== client ||
			typeof value.credential !== "string" ||
			!SECRET.test(value.credential) ||
			typeof value.hashKey !== "string" ||
			!KEY.test(value.hashKey) ||
			value.settingsPath !== runtimeSettingsPath(client, options) ||
			!matchesSignIn(value, readOAuthCredentials(options)) ||
			!Number.isFinite(Date.parse(value.activatedAt)) ||
			(value.expiresAt !== null && !(Date.parse(value.expiresAt) > time(options)))
		)
			return null;
		if (options.hookPath && options.hookPath !== value.hookPath) return null;
		if (options.generation !== undefined && options.generation !== value.generation) return null;
		const pending = readRuntimeJSON(join(root(options), pendingName(client)));
		return pending?.generation === value.generation ? null : value;
	} catch {
		return null;
	}
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
	try {
		privatePath(join(options.home ?? homedir(), ".pharaoh"), true);
		privatePath(root(options), true);
		pending = readRuntimeJSON(join(root(options), pendingName(client)));
		disabled = readChoice(client, options)?.disabled;
		privatePath(clientDirectory(client, options), true);
		status = readRuntimeJSON(join(clientDirectory(client, options), STATUS));
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
		consent: state
			? "active"
			: validIdentity(pending)
				? "revocation_pending"
				: status && !disabled
					? "paused"
					: "off",
		...(state && { installationId: state.installationId, generation: state.generation }),
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
	return state
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

/** Refresh installation evidence outside hooks, at most daily; never upgrade registered capability.
 * @param clientName - Negotiated local client label, not a model-supplied tool argument.
 * @param discover - Bounded executable/package build discovery run only when stale.
 * @param options - Private enrollment location and clock.
 * @returns Whether current installation evidence was refreshed.
 */
export function refreshRuntimeBuildEvidence(clientName, discover, options = {}) {
	const client = runtimeClient(clientName);
	if (!client || !readState(client, options)) return false;
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
					writeRuntimeJSON(clientDirectory(client, options), STATE, {
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
				writeRuntimeJSON(clientDirectory(client, options), STATE, {
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
								writeRuntimeJSON(directory, STATE, {
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
				};
				const hashKey = randomBytes(32).toString("hex");
				const signInRef = runtimeRef(hashKey, "sign-in", credentials.runtime_session);
				const bound = { ...state, hashKey, signInRef };
				const pending = join(root(options), pendingName(client));
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
						writeRuntimeJSON(root(options), pendingName(client), { ...state, enabling: true });
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
						writeRuntimeJSON(directory, STATE, {
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
						});
						syncRuntimeHooks(client, hookPath, {
							...options,
							automatic,
							settingsPath,
							generation: state.generation,
							metadataVersion: answer.metadataVersion === 2 ? 2 : 1,
						});
						writeRuntimeJSON(directory, STATUS, {
							installationId: state.installationId,
							generation: state.generation,
							expiresAt: answer.expiresAt,
						});
						rmSync(pending, { force: true });
						if (!automatic && choice !== null)
							writeRuntimeJSON(root(options), choiceName(client), {
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
	const path = join(root(options), pendingName(client));
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
	const pending = join(root(options), pendingName(client));
	if (!existsSync(directory) && !existsSync(pending)) return true;
	try {
		privatePath(join(options.home ?? homedir(), ".pharaoh"), true);
		privatePath(root(options), true);
		const pendingControl = readRuntimeJSON(pending);
		let owned =
			validIdentity(pendingControl) && pendingControl.client === client ? pendingControl : null;
		if (owned?.enabling === true) {
			owned = { ...owned, enabling: false };
			writeRuntimeJSON(root(options), pendingName(client), owned);
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
				};
				writeRuntimeJSON(root(options), pendingName(client), owned);
			}
			rmSync(directory, { recursive: true, force: true });
		}
		if (owned)
			syncRuntimeHooks(client, null, {
				...options,
				settingsPath: owned.settingsPath,
				generation: owned.generation,
			});
		return true;
	} catch {
		return false;
	}
}

/** Immediately discard local observation data and keys, then try remote revocation. */
export async function revokeRuntime(client, options = {}) {
	if (!validClient(client)) return false;
	try {
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
			writeRuntimeJSON(root(options), choiceName(client), {
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
			writeRuntimeJSON(directory, STATE, {
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
					const event = parseRuntimeEvent(value);
					return [event];
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
		const lost = parsed
			.filter((event) => !kept.has(event.eventId))
			.flatMap((event) => invalidationForDropped(event, now));
		const state = readRuntimeJSON(join(directory, STATE), 65_536);
		if (state && lost.length)
			writeRuntimeJSON(directory, STATE, {
				...state,
				pendingInvalidations: retainInvalidations(state.pendingInvalidations, lost),
			});
		writeRuntimeJSON(directory, QUEUE, queue, MAX_QUEUE_BYTES);
	}
	return queue;
}

/** Convert one native callback into a bounded private event, never a transcript record. */
export function recordRuntimeHook(client, input, options = {}) {
	const now = time(options);
	if (!validClient(client) || !readState(client, options)) return false;
	const nativeSession = nativeIdentifier(input?.session_id);
	if (!nativeSession) return false;
	const directory = clientDirectory(client, options);
	return (
		runtimeLock(
			directory,
			() => {
				let state = readState(client, options);
				if (!state) return false;
				const observation = nativeObservation(input, client, state.hashKey, now, options);
				if (!observation) return false;
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
					writeRuntimeJSON(directory, STATE, state);
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
					writeRuntimeJSON(directory, STATE, { ...state, sessions });
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
				queue.push(event);
				if (queue.length > MAX_QUEUE) {
					const oldest = queue.reduce(
						(index, item, position) =>
							item.observedAt < queue[index].observedAt ? position : index,
						0,
					);
					const dropped = queue.splice(oldest, 1)[0];
					state = {
						...state,
						pendingInvalidations: retainInvalidations(
							state.pendingInvalidations,
							invalidationForDropped(dropped, now),
						),
					};
				}
				const receiptObserved = state.receiptObserved || Boolean(event.receipt);
				const usageObserved =
					state.usageObserved ||
					Boolean(event.tokens && Object.values(event.tokens).some((value) => value !== null));
				// Consume selection before the spool write. An interrupted write may lose coverage,
				// but cannot attach the same owner selection to a second episode.
				writeRuntimeJSON(directory, STATE, {
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
					writeRuntimeJSON(directory, STATUS, {
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
	if (!validClient(client) || !readState(client, options)) return null;
	const directory = clientDirectory(client, options);
	return runtimeLock(
		directory,
		() => {
			const state = readState(client, options);
			if (!state) return null;
			const now = time(options);
			const lease = readRuntimeJSON(join(directory, LEASE));
			if (lease?.expires > now) return null;
			const ordinary = readQueue(directory, now, true);
			if (!ordinary.length && !readState(client, options)?.pendingInvalidations?.length)
				return null;
			const id = randomUUID();
			writeRuntimeJSON(directory, LEASE, { id, expires: now + 60_000 });
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
	if (!state || readRuntimeJSON(join(directory, LEASE))?.id !== leaseId) return;
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
					const ordinary = readQueue(directory, time(options), true);
					return [...(readState(client, options)?.pendingInvalidations ?? []), ...ordinary];
				},
				time(options),
			);
			for (const event of (queue ?? []).slice(0, BATCH_SIZE)) {
				body.events.push(event);
				if (Buffer.byteLength(JSON.stringify(body)) > BATCH_BYTES) {
					body.events.pop();
					break;
				}
			}
			const { events } = body;
			if (!events.length) return;
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
							writeRuntimeJSON(directory, STATE, {
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
