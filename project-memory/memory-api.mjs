import { diagnosticEventForEgress, memoryEgressDecision } from "./local.mjs";

export const PROJECT_MEMORY_ORIGIN = "https://mcp.pharaoh.so";
const READY_TIMEOUT_MS = 1_200;
const REQUEST_TIMEOUT_MS = 12_000;
const BUILD = new URL("runtime/refresh.js", import.meta.url);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const STATUS = new Set(["candidate", "approved", "superseded", "retracted", "archived"]);

export class PilotError extends Error {
	constructor(message, rejected = false) {
		super(message);
		this.rejected = rejected;
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
			"expand",
			"diagnostics",
			"diagnostics/control",
			"feedback",
		].includes(operation)
	)
		throw new PilotError("Unknown memory request.");
	const privacy = { home };
	requireMemoryEgress(binding, operation, privacy);
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
	if (["recall", "expand", "capture"].includes(operation) && (client || payload.client)) {
		const { memoryDiagnosticsForClient } = await import("./preferences.mjs");
		const diagnostic = memoryDiagnosticsForClient({ name: client ?? payload.client }, home);
		if (diagnostic || payload.diagnostics) {
			const claimed = payload.diagnostics;
			const baseline = Object.fromEntries(
				["taskSummary", "intendedNextAction", "turnRef", "sessionRef", "recallId"].flatMap((key) =>
					claimed?.[key] === undefined ? [] : [[key, claimed[key]]],
				),
			);
			payload = { ...payload, diagnostics: { ...baseline, ...diagnostic } };
		}
	}
	requireMemoryEgress(binding, operation, privacy);
	if (operation === "diagnostics") {
		const events = (Array.isArray(payload.events) ? payload.events : []).flatMap((event) => {
			const safe = diagnosticEventForEgress(payload.client, event, privacy);
			return safe ? [safe] : [];
		});
		if (!events.length) return { acceptedEventIds: [], rejectedEventIds: [] };
		payload = { ...payload, events };
	}
	let response;
	try {
		response = await fetcher(`${PROJECT_MEMORY_ORIGIN}/api/project-memory/${operation}`, {
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
				? "Pharaoh did not confirm whether this capture was saved. Check the project memory inspector before retrying."
				: "Pharaoh project memory could not respond before the request ended.",
		);
	}
	if (!response.ok) {
		await response.body?.cancel();
		// The shared credential file can now name a different OAuth session. Do
		// not reuse an already prepared operation under newly loaded credentials.
		if (response.status === 401)
			throw new PilotError("Pharaoh rejected this sign-in. Reconnect before trying again.", true);
		if (response.status === 404)
			throw new PilotError("Project memory is unavailable for this repository or account.", true);
		if (response.status === 400 || response.status === 413)
			throw new PilotError(
				"Pharaoh rejected the memory payload. Check its shape, size, and sensitive content.",
				true,
			);
		if (response.status === 409)
			throw new PilotError(
				"Pharaoh could not save this candidate because the operation conflicts or the project log is full.",
				true,
			);
		if (response.status === 429)
			throw new PilotError("Pharaoh project memory reached its request limit.", true);
		if (operation === "capture" && response.status >= 500) {
			throw new PilotError(
				"Pharaoh did not confirm whether this capture was saved. Check the project memory inspector before retrying.",
			);
		}
		throw new PilotError(
			"Pharaoh project memory is temporarily unavailable.",
			response.status >= 400 && response.status < 500,
		);
	}
	let result;
	try {
		result = await responseJson(response);
	} catch (error) {
		if (operation === "capture")
			throw new PilotError(
				"Pharaoh did not confirm whether this capture was saved. Check the project memory inspector before retrying.",
			);
		throw error;
	}
	if (["diagnostics", "diagnostics/control", "feedback"].includes(operation)) return result;
	if (operation === "anchored" && Array.isArray(result?.records))
		return { records: result.records.filter((record) => UUID.test(record?.id ?? "")) };
	if (
		result &&
		typeof result === "object" &&
		memoryEgressDecision(binding, operation, privacy) === "blocked"
	) {
		delete result.feedbackRequest;
	}
	if (
		operation === "recall" &&
		Array.isArray(result?.records) &&
		result.records.length <= 5 &&
		result.records.every((record) => typeof record?.id === "string" && UUID.test(record.id))
	) {
		if (payload.format === "compact-v1") {
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
		return { records: result.records, graph: result.graph, ...diagnosticResponseFields(result) };
	}
	if (
		operation === "expand" &&
		result?.record?.id === payload.id &&
		result.record.version === payload.version &&
		STATUS.has(result.record.status) &&
		Number.isInteger(result.current?.version) &&
		result.current.version >= payload.version &&
		STATUS.has(result.current.status)
	) {
		const omitted = result.omittedHistoricalEvidence;
		return {
			record: result.record,
			current: result.current,
			...diagnosticResponseFields(result),
			...(Number.isInteger(omitted) && omitted >= 0 && { omittedHistoricalEvidence: omitted }),
		};
	}
	if (
		operation === "capture" &&
		typeof result?.record?.id === "string" &&
		UUID.test(result.record.id)
	) {
		return {
			record: { id: result.record.id, status: result.record.status },
			...diagnosticResponseFields(result),
		};
	}
	if (operation === "capture")
		throw new PilotError(
			"Pharaoh did not confirm whether this capture was saved. Check the project memory inspector before retrying.",
		);
	throw new PilotError("Pharaoh returned an incomplete response.");
}
