/** The local query is never an input to this transport. */
import { randomUUID } from "node:crypto";
import { type Credentials, readCredentials } from "../credentials.js";
import { renewOriginBoundSignIn, sameCredentialSnapshot } from "../refresh.js";

const VERSION = 1;
const PATH = "/api/local/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;
const TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 1_024;
const MAX_PERMIT_MS = 65_000; // 60 seconds server-side, with modest clock skew.
const ERROR_TEXT = {
	invalid_request: "Local authorization request is invalid.",
	sign_in_required: "Sign in to Pharaoh to use local worktree answers.",
	sign_in_changed: "Pharaoh sign-in changed. Retry the local query.",
	"plan_wall:map_only": "This needs Pro: the repository's plan allows only codebase maps.",
	access_denied: "Pharaoh could not authorize this repository for local worktree answers.",
	rate_limited: "Pharaoh rate limit reached. Retry the local query later.",
	permit_invalid: "Local authorization is no longer valid. Retry the local query.",
	permit_expired: "Local authorization expired. Retry the local query.",
	unavailable: "Local authorization is unavailable. Retry the local query.",
	cancelled: "Local worktree query was cancelled.",
} as const;

export class LocalAuthorizationError extends Error {
	constructor(readonly code: keyof typeof ERROR_TEXT) {
		super(ERROR_TEXT[code]);
		this.name = "LocalAuthorizationError";
	}
}

interface LocalAuthorizationOptions {
	readonly server: string;
	readonly credentialsPath?: string;
	/** Credential snapshot verified by the native hook handoff, when present. */
	readonly expectedSignIn?: Credentials;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

interface LocalPermit {
	readonly requestId: string;
	readonly permitId: string;
	readonly expiresAt: number;
}

type Operation = "reserve" | "commit" | "abort";

function origin(value: string): string {
	try {
		const url = new URL(value);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (
			!url.username &&
			!url.password &&
			(url.protocol === "https:" || (url.protocol === "http:" && loopback))
		) {
			return url.origin;
		}
	} catch {
		// Leave the raw URL out of local authorization diagnostics.
	}
	throw new LocalAuthorizationError("unavailable");
}

function requireActive(signal?: AbortSignal): void {
	if (signal?.aborted) throw new LocalAuthorizationError("cancelled");
}

function rejectStatus(status: number): never {
	switch (status) {
		case 401:
			throw new LocalAuthorizationError("sign_in_required");
		case 402:
			throw new LocalAuthorizationError("plan_wall:map_only");
		case 403:
			throw new LocalAuthorizationError("access_denied");
		case 409:
			throw new LocalAuthorizationError("permit_invalid");
		case 410:
			throw new LocalAuthorizationError("permit_expired");
		case 429:
			throw new LocalAuthorizationError("rate_limited");
		default:
			throw new LocalAuthorizationError("unavailable");
	}
}

async function readPermitBody(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new LocalAuthorizationError("unavailable");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) throw new LocalAuthorizationError("unavailable");
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function parsePermit(body: unknown, requestId: string, now: number): LocalPermit {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		throw new LocalAuthorizationError("unavailable");
	const fields = body as Record<string, unknown>;
	if (
		Object.keys(fields).length !== 3 ||
		fields.version !== VERSION ||
		typeof fields.permitId !== "string" ||
		!UUID.test(fields.permitId) ||
		typeof fields.expiresAt !== "string" ||
		!/^[\d-]{10}T[\d:.]{12}Z$/.test(fields.expiresAt)
	) {
		throw new LocalAuthorizationError("unavailable");
	}
	const expiresAt = Date.parse(fields.expiresAt);
	if (
		!Number.isFinite(expiresAt) ||
		expiresAt <= now ||
		expiresAt > now + MAX_PERMIT_MS ||
		new Date(expiresAt).toISOString() !== fields.expiresAt
	) {
		throw new LocalAuthorizationError("unavailable");
	}
	return Object.freeze({ requestId, permitId: fields.permitId, expiresAt });
}

/**
 * Authorize one claimed local invocation. The instance captures the sign-in
 * present at claim time and owns its request and permit IDs until it settles.
 */
export function createLocalAuthorization(options: LocalAuthorizationOptions) {
	const server = origin(options.server);
	const read = () => readCredentials(options.credentialsPath);
	const fetchReceipt = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const requestId = randomUUID();
	let credentials = read();
	if (options.expectedSignIn && !sameCredentialSnapshot(credentials, options.expectedSignIn)) {
		throw new LocalAuthorizationError("sign_in_changed");
	}
	let refreshed = false;
	let reservationBody: string | undefined;
	let permit: LocalPermit | undefined;

	function currentCredentials(): Credentials {
		if (!credentials) throw new LocalAuthorizationError("sign_in_required");
		if (origin(credentials.sse_url) !== server || !sameCredentialSnapshot(read(), credentials)) {
			throw new LocalAuthorizationError("sign_in_changed");
		}
		return credentials;
	}

	async function post(
		operation: Operation,
		body: string,
		accessToken: string,
		signal?: AbortSignal,
	): Promise<{ status: number; permitBody?: unknown }> {
		requireActive(signal);
		const controller = new AbortController();
		const cancel = () => controller.abort();
		const timer = setTimeout(cancel, TIMEOUT_MS);
		timer.unref();
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const response = await fetchReceipt(new URL(`${PATH}/${operation}`, server), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body,
				redirect: "error",
				cache: "no-store",
				signal: controller.signal,
			});
			if (operation === "reserve" && (response.status === 200 || response.status === 201)) {
				return { status: response.status, permitBody: await readPermitBody(response) };
			}
			void response.body?.cancel().catch(() => {});
			return { status: response.status };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
		}
	}

	async function request(operation: Operation, body: string, signal?: AbortSignal) {
		let retryCommit = operation === "commit";
		for (;;) {
			requireActive(signal);
			if (operation === "commit" && permit && now() >= permit.expiresAt) {
				throw new LocalAuthorizationError("permit_expired");
			}
			const before = currentCredentials();
			let reply: Awaited<ReturnType<typeof post>>;
			try {
				reply = await post(operation, body, before.access_token, signal);
			} catch {
				requireActive(signal);
				if (retryCommit) {
					retryCommit = false;
					continue;
				}
				throw new LocalAuthorizationError("unavailable");
			}
			requireActive(signal);
			currentCredentials();
			if (reply.status === 401 && !refreshed) {
				refreshed = true;
				const renewed = await renewOriginBoundSignIn(before, server, options.credentialsPath).catch(
					() => null,
				);
				requireActive(signal);
				if (!renewed?.ok) {
					const after = read();
					const code =
						after && !sameCredentialSnapshot(after, before)
							? "sign_in_changed"
							: !after || renewed?.action === "reauth"
								? "sign_in_required"
								: "unavailable";
					throw new LocalAuthorizationError(code);
				}
				credentials = renewed.creds;
				continue;
			}
			return reply;
		}
	}

	function verifyPermit(candidate: LocalPermit): void {
		if (!permit || permit !== candidate) throw new LocalAuthorizationError("permit_invalid");
	}

	async function requestReservation(body: string, signal?: AbortSignal): Promise<LocalPermit> {
		const reply = await request("reserve", body, signal);
		if (reply.status !== 200 && reply.status !== 201) rejectStatus(reply.status);
		return parsePermit(reply.permitBody, requestId, now());
	}

	return {
		/** Recheck after all asynchronous delivery gates, immediately before returning an answer. */
		assertCurrentSignIn(): void {
			currentCredentials();
		},
		async reserve(repoSlug: string, signal?: AbortSignal): Promise<LocalPermit> {
			if (
				reservationBody ||
				!SLUG.test(repoSlug) ||
				repoSlug.endsWith("/.") ||
				repoSlug.endsWith("/..")
			) {
				throw new LocalAuthorizationError("invalid_request");
			}
			reservationBody = JSON.stringify({
				version: VERSION,
				requestId,
				repoSlug,
				tool: "get_blast_radius",
			});
			permit = await requestReservation(reservationBody, signal);
			return permit;
		},
		/** Recheck server-side access without committing or extending the original reservation. */
		async confirm(candidate: LocalPermit, signal?: AbortSignal): Promise<void> {
			verifyPermit(candidate);
			requireActive(signal);
			if (now() >= candidate.expiresAt) throw new LocalAuthorizationError("permit_expired");
			if (!reservationBody) throw new LocalAuthorizationError("permit_invalid");
			const confirmed = await requestReservation(reservationBody, signal);
			if (confirmed.permitId !== candidate.permitId || confirmed.expiresAt !== candidate.expiresAt)
				throw new LocalAuthorizationError("permit_invalid");
		},
		async commit(
			candidate: LocalPermit,
			outcome: "answered" | "valid_empty",
			signal?: AbortSignal,
		): Promise<void> {
			verifyPermit(candidate);
			if (outcome !== "answered" && outcome !== "valid_empty")
				throw new LocalAuthorizationError("invalid_request");
			const reply = await request(
				"commit",
				JSON.stringify({ version: VERSION, requestId, permitId: candidate.permitId, outcome }),
				signal,
			);
			if (reply.status !== 204) rejectStatus(reply.status);
		},
		async abort(
			candidate: LocalPermit,
			reason: "error" | "cancelled",
			signal?: AbortSignal,
		): Promise<void> {
			verifyPermit(candidate);
			if (reason !== "error" && reason !== "cancelled")
				throw new LocalAuthorizationError("invalid_request");
			const reply = await request(
				"abort",
				JSON.stringify({ version: VERSION, requestId, permitId: candidate.permitId, reason }),
				signal,
			);
			if (reply.status !== 204) rejectStatus(reply.status);
		},
	};
}
