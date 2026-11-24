import { diagnosticEventForEgress, memoryEgressDecision } from "./local.mjs";

export const PROJECT_MEMORY_ORIGIN = "https://mcp.pharaoh.so";
const READY_TIMEOUT_MS = 1_200;
const REQUEST_TIMEOUT_MS = 12_000;
const BUILD = new URL("runtime/refresh.js", import.meta.url);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const STATUS = new Set(["candidate", "approved", "superseded", "retracted", "archived"]);
const UNCONFIRMED_CAPTURE =
	"Pharaoh did not confirm whether this capture was saved. Check the project memory inspector before retrying.";
const UNAVAILABLE = "Pharaoh project memory is temporarily unavailable.";
const PAYLOAD_REJECTED =
	"Pharaoh rejected the memory payload. Check its shape, size, and sensitive content.";
/** Refusals by HTTP status: the message, and the status a caller can act on. All are rejections. */
const REFUSALS = new Map([
	// The shared credential file can now name a different OAuth session. Do
	// not reuse an already prepared operation under newly loaded credentials.
	[401, ["Pharaoh rejected this sign-in. Reconnect before trying again.", 401]],
	[404, ["Project memory is unavailable for this repository or account.", 404]],
	[400, [PAYLOAD_REJECTED]],
	[413, [PAYLOAD_REJECTED]],
	[
		409,
		[
			"Pharaoh could not save this candidate because the operation conflicts or the project log is full.",
		],
	],
	[429, ["Pharaoh project memory reached its request limit.", 429]],
]);

export class PilotError extends Error {
	constructor(message, rejected = false, status = undefined) {
		super(message);
		this.rejected = rejected;
		/** The HTTP status Pharaoh answered, when it answered. */
		this.status = status;
	}
}

async function responseJson(response) {
	if (!response.body) throw new PilotError("Pharaoh returned an incomplete response.");
	const chunks = [];
	let bytes = 0;
	for await (const chunk of response.body) {
		bytes += chunk.length;
		if (bytes > 32_768) throw new PilotError("Pharaoh returned an oversized response.");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function refreshHelper() {
	try {
		const helper = await import(BUILD.href);
		if (typeof helper.originBoundRefresh === "function") return helper;
	} catch {
		// Missing or incomplete build.
	}
	throw new PilotError(
		"The installed project memory bundle has no compatible refresh helper. Rerun normal Pharaoh setup.",
	);
}

/** Check only mapping metadata using the current device session. Normal proxy
 * startup handles token refresh; the prompt hook never waits on a refresh lock. */
export async function requestMemoryReadiness(
	repo,
	credentials,
	deadline = Infinity,
	clientName,
	metadata = false,
) {
	const expiresAt = Date.parse(credentials?.expires_at);
	if (typeof credentials?.access_token !== "string" || !(expiresAt > Date.now())) return;
	const timeout = Math.min(READY_TIMEOUT_MS, Math.floor(deadline - performance.now()));
	if (timeout < 1) return;
	try {
		if (new URL(credentials.sse_url).origin !== PROJECT_MEMORY_ORIGIN) return;
		const response = await fetch(`${PROJECT_MEMORY_ORIGIN}/api/project-memory/readiness`, {
			method: "POST",
			redirect: "error",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${credentials.access_token}`,
			},
			body: JSON.stringify({ repo, ...(clientName && { clientName }) }),
			signal: AbortSignal.timeout(timeout),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return;
		}
		const result = await responseJson(response);
		return metadata ? result : result?.revision;
	} catch {
		// Pending, denied, unavailable and timed-out lookups leave hooks dormant.
	}
}

/** Server policy is independent of local consent; absent policy never enables collection. */
export async function requestMemoryPolicy(repo, credentials, deadline = Infinity, clientName) {
	const result = await requestMemoryReadiness(repo, credentials, deadline, clientName, true);
	const policy = result?.diagnosticsPolicy;
	if (!policy || typeof policy !== "object") return;
	if (!clientName) return policy;
	const control = result?.diagnosticsControl;
	return {
		...policy,
		generation: control?.enabled === true ? control.generation : undefined,
		control,
	};
}

function diagnosticResponseFields(result) {
	return {
		...(result?.recallId === null ||
		(typeof result?.recallId === "string" && UUID.test(result.recallId))
			? { recallId: result.recallId }
			: {}),
		...(typeof result?.collection === "string" && { collection: result.collection }),
		...(result?.feedbackRequest &&
			typeof result.feedbackRequest === "object" && { feedbackRequest: result.feedbackRequest }),
	};
}

export function requireMemoryEgress(binding, operation, options) {
	if (memoryEgressDecision(binding, operation, options) === "blocked") {
		throw new PilotError(
			"Project Memory is paused for this conversation's local worktree context.",
			true,
		);
	}
}

/** Send one project memory operation and return Pharaoh's answer once it has the operation's shape. */
export async function requestMemory(
	operation,
	payload,
	{
		fetcher = fetch,
		helper,
		credentials,
		client,
		binding,
		home,
		timeoutMs = REQUEST_TIMEOUT_MS,
	} = {},
) {
	if (
		![
			"recall",
			"anchored",
			"capture",
			"forget",
			"expand",
			"diagnostics",
			"diagnostics/control",
			"feedback",
		].includes(operation)
	)
		throw new PilotError("Unknown memory request.");
	const privacy = { home };
	requireMemoryEgress(binding, operation, privacy);
	const session = await signedIn(credentials, helper);
	payload = await withClientDiagnostics(operation, payload, client, home);
	requireMemoryEgress(binding, operation, privacy);
	if (operation === "diagnostics") {
		payload = diagnosticsForEgress(payload, privacy);
		if (!payload) return { acceptedEventIds: [], rejectedEventIds: [] };
	}
	const response = await send(fetcher, operation, payload, session, timeoutMs);
	if (!response.ok) throw await refusal(response, operation);
	const result = await answer(response, operation);
	return checkedAnswer(operation, payload, result, () =>
		memoryEgressDecision(binding, operation, privacy),
	);
}

async function signedIn(credentials, helper) {
	// Capture supplies its session snapshot so dispatch cannot adopt a different sign-in.
	if (!credentials) {
		const { originBoundRefresh } = helper ?? (await refreshHelper());
		const outcome = await originBoundRefresh(PROJECT_MEMORY_ORIGIN).load();
		if (outcome?.ok) credentials = outcome.creds;
	}
	if (!credentials)
		throw new PilotError(
			"Connect to Pharaoh with its device sign-in, or retry if sign-in is temporarily unavailable.",
		);
	return credentials;
}

async function withClientDiagnostics(operation, payload, client, home) {
	if (!["recall", "expand", "capture"].includes(operation) || !(client || payload.client))
		return payload;
	const { memoryDiagnosticsForClient } = await import("./preferences.mjs");
	const diagnostic = memoryDiagnosticsForClient({ name: client ?? payload.client }, home);
	if (!diagnostic && !payload.diagnostics) return payload;
	const claimed = payload.diagnostics;
	const baseline = Object.fromEntries(
		["taskSummary", "intendedNextAction", "turnRef", "sessionRef", "recallId"].flatMap((key) =>
			claimed?.[key] === undefined ? [] : [[key, claimed[key]]],
		),
	);
	return { ...payload, diagnostics: { ...baseline, ...diagnostic } };
}

function diagnosticsForEgress(payload, privacy) {
	const events = (Array.isArray(payload.events) ? payload.events : []).flatMap((event) => {
		const safe = diagnosticEventForEgress(payload.client, event, privacy);
		return safe ? [safe] : [];
	});
	return events.length ? { ...payload, events } : null;
}

async function send(fetcher, operation, payload, credentials, timeoutMs) {
	try {
		return await fetcher(`${PROJECT_MEMORY_ORIGIN}/api/project-memory/${operation}`, {
			method: "POST",
			redirect: "error",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${credentials.access_token}`,
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs))),
		});
	} catch {
		throw new PilotError(
			operation === "capture"
				? UNCONFIRMED_CAPTURE
				: "Pharaoh project memory could not respond before the request ended.",
		);
	}
}

async function refusal(response, operation) {
	if (response.status === 403) {
		// The repo's plan keeps memories without giving them back: show Pharaoh's one line.
		const body = await responseJson(response).catch(() => null);
		const locked = body?.error === "locked" && typeof body.message === "string";
		return locked
			? new PilotError(body.message.slice(0, 500), true, 403)
			: new PilotError(UNAVAILABLE, true);
	}
	await response.body?.cancel();
	const known = REFUSALS.get(response.status);
	if (known) return new PilotError(known[0], true, known[1]);
	if (operation === "capture" && response.status >= 500) return new PilotError(UNCONFIRMED_CAPTURE);
	return new PilotError(UNAVAILABLE, response.status >= 400 && response.status < 500);
}

async function answer(response, operation) {
	try {
		return await responseJson(response);
	} catch (error) {
		if (operation === "capture") throw new PilotError(UNCONFIRMED_CAPTURE);
		throw error;
	}
}

/** `egress` is asked only once an answer may carry a feedback request. */
function checkedAnswer(operation, payload, result, egress) {
	if (["diagnostics", "diagnostics/control", "feedback"].includes(operation)) return result;
	if (operation === "forget") return { forgotten: result?.forgotten === true };
	if (operation === "anchored" && Array.isArray(result?.records))
		return { records: result.records.filter((record) => UUID.test(record?.id ?? "")) };
	if (result && typeof result === "object" && egress() === "blocked") delete result.feedbackRequest;
	const shaped = shapedAnswer(operation, payload, result);
	if (shaped) return shaped;
	throw new PilotError(
		operation === "capture" ? UNCONFIRMED_CAPTURE : "Pharaoh returned an incomplete response.",
	);
}

function shapedAnswer(operation, payload, result) {
	if (operation === "recall" && isRecall(result)) return recallAnswer(payload, result);
	if (operation === "expand" && isExpansion(payload, result)) return expansionAnswer(result);
	if (
		operation === "capture" &&
		typeof result?.record?.id === "string" &&
		UUID.test(result.record.id)
	)
		return captureAnswer(result);
}

function isRecall(result) {
	return (
		Array.isArray(result?.records) &&
		result.records.length <= 5 &&
		result.records.every((record) => typeof record?.id === "string" && UUID.test(record.id))
	);
}

function recallAnswer(payload, result) {
	if (payload.format !== "compact-v1")
		return { records: result.records, graph: result.graph, ...diagnosticResponseFields(result) };
	if (
		result.format === "compact-v1" &&
		typeof result.repo === "string" &&
		result.repo.toLowerCase() === payload.repo.toLowerCase() &&
		typeof result.moreMatches === "boolean" &&
		Number.isInteger(result.omittedRecords) &&
		result.omittedRecords >= 0 &&
		result.records.every(
			(record) =>
				Number.isInteger(record.version) &&
				record.version >= 1 &&
				record.version <= 1_000_000 &&
				STATUS.has(record.status),
		)
	)
		return result;
	throw new PilotError("Pharaoh returned an incomplete compact recall packet.");
}

function isExpansion(payload, result) {
	return (
		result?.record?.id === payload.id &&
		result.record.version === payload.version &&
		STATUS.has(result.record.status) &&
		Number.isInteger(result.current?.version) &&
		result.current.version >= payload.version &&
		STATUS.has(result.current.status)
	);
}

function expansionAnswer(result) {
	const omitted = result.omittedHistoricalEvidence;
	return {
		record: result.record,
		current: result.current,
		...diagnosticResponseFields(result),
		...(Number.isInteger(omitted) && omitted >= 0 && { omittedHistoricalEvidence: omitted }),
	};
}

function captureAnswer(result) {
	return {
		record: {
			id: result.record.id,
			status: result.record.status,
			...(Number.isInteger(result.record.version) && { version: result.record.version }),
		},
		...diagnosticResponseFields(result),
	};
}
