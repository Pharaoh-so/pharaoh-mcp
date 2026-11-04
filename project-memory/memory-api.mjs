export const PROJECT_MEMORY_ORIGIN = "https://mcp.pharaoh.so";
const READY_TIMEOUT_MS = 1_200;
const BUILD = new URL("runtime/refresh.js", import.meta.url);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const STATUS = new Set(["candidate", "approved", "superseded", "retracted"]);

export class PilotError extends Error {}

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
export async function requestMemoryReadiness(repo, credentials) {
	const expiresAt = Date.parse(credentials?.expires_at);
	if (typeof credentials?.access_token !== "string" || !(expiresAt > Date.now())) return;
	try {
		if (new URL(credentials.sse_url).origin !== PROJECT_MEMORY_ORIGIN) return;
		const response = await fetch(`${PROJECT_MEMORY_ORIGIN}/api/project-memory/readiness`, {
			method: "POST",
			redirect: "error",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${credentials.access_token}`,
			},
			body: JSON.stringify({ repo }),
			signal: AbortSignal.timeout(READY_TIMEOUT_MS),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return;
		}
		const result = await responseJson(response);
		return result?.revision;
	} catch {
		// Pending, denied, unavailable and timed-out lookups leave hooks dormant.
	}
}

export async function requestMemory(operation, payload, { fetcher = fetch, helper } = {}) {
	if (!["recall", "capture", "expand"].includes(operation))
		throw new PilotError("Unknown memory request.");
	const { originBoundRefresh } = helper ?? (await refreshHelper());
	const refresh = originBoundRefresh(PROJECT_MEMORY_ORIGIN);
	const outcome = await refresh.load();
	if (!outcome?.ok)
		throw new PilotError(
			"Connect to Pharaoh with its device sign-in, or retry if sign-in is temporarily unavailable.",
		);
	const send = async (creds) => {
		try {
			return await fetcher(`${PROJECT_MEMORY_ORIGIN}/api/project-memory/${operation}`, {
				method: "POST",
				redirect: "error",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${creds.access_token}`,
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(12_000),
			});
		} catch {
			throw new PilotError(
				operation === "capture"
					? "Pharaoh did not confirm whether this capture was saved. Check the project memory inspector before retrying."
					: "Pharaoh project memory could not respond before the request ended.",
			);
		}
	};
	const response = await send(outcome.creds);
	if (!response.ok) {
		await response.body?.cancel();
		// The shared credential file can now name a different OAuth session. Do
		// not reuse an already prepared operation under newly loaded credentials.
		if (response.status === 401)
			throw new PilotError("Pharaoh rejected this sign-in. Reconnect before trying again.");
		if (response.status === 404)
			throw new PilotError("Project memory is unavailable for this repository or account.");
		if (response.status === 400 || response.status === 413)
			throw new PilotError(
				"Pharaoh rejected the memory payload. Check its shape, size, and sensitive content.",
			);
		if (response.status === 409)
			throw new PilotError(
				"Pharaoh could not save this candidate because the operation conflicts or the project log is full.",
			);
		if (response.status === 429)
			throw new PilotError("Pharaoh project memory reached its request limit.");
		if (operation === "capture" && response.status >= 500) {
			throw new PilotError(
				"Pharaoh did not confirm whether this capture was saved. Check the project memory inspector before retrying.",
			);
		}
		throw new PilotError("Pharaoh project memory is temporarily unavailable.");
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
		return { records: result.records, graph: result.graph };
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
			...(Number.isInteger(omitted) && omitted >= 0 && { omittedHistoricalEvidence: omitted }),
		};
	}
	if (
		operation === "capture" &&
		typeof result?.record?.id === "string" &&
		UUID.test(result.record.id)
	) {
		return { record: { id: result.record.id, status: result.record.status } };
	}
	if (operation === "capture")
		throw new PilotError(
			"Pharaoh did not confirm whether this capture was saved. Check the project memory inspector before retrying.",
		);
	throw new PilotError("Pharaoh returned an incomplete response.");
}
