import { createHash, createPublicKey, verify } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DesignRule, validDesignRules } from "../runtime/design-contract.mjs";
import { originBoundRefresh } from "./refresh.js";

export class DesignError extends Error {
	constructor(
		readonly code: 1 | 2 | 3 | 4,
		message: string,
	) {
		super(message);
	}
}
export const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function designOrigin(value: string) {
	const url = new URL(value);
	if (
		url.origin !== value.replace(/\/$/, "") ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
	) {
		throw new DesignError(2, "Use an HTTPS server origin or a loopback development server.");
	}
	return url.origin;
}
export function credentialPath(origin: string) {
	return join(homedir(), ".pharaoh", "design", digest(origin), "credentials.json");
}
export interface Binding {
	repoId: string;
	repoSlug: string;
}
export interface CiBinding extends Binding {
	runId: string;
	runAttempt: string;
	sha: string;
}
export interface Projection extends Binding {
	epoch: string;
	revision: number;
	visionDigest: string;
	visionStatus: "present" | "deleted";
	rules: DesignRule[];
}
export const bundleLimit = 512 * 1024;
async function readResponse(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) throw new DesignError(2, "Pharaoh returned an empty response.");
	const chunks: Buffer[] = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > bundleLimit) {
			await reader.cancel();
			throw new DesignError(2, "Pharaoh response exceeds the protocol limit.");
		}
		chunks.push(Buffer.from(value));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function request(
	origin: string,
	path: string,
	signal: AbortSignal,
	token?: string,
	body?: unknown,
) {
	try {
		return await fetch(origin + path, {
			method: body === undefined ? "GET" : "POST",
			redirect: "error",
			signal,
			headers: {
				...(token && { Authorization: `Bearer ${token}` }),
				...(body !== undefined && { "Content-Type": "application/json" }),
			},
			...(body !== undefined && { body: JSON.stringify(body) }),
		});
	} catch {
		throw new DesignError(3, "Pharaoh is unavailable. Check your connection and retry.");
	}
}
async function checked(response: Response) {
	if (response.status === 401) throw new DesignError(3, "Sign in with pharaoh-mcp design login.");
	if ([403, 404, 409, 410, 422].includes(response.status))
		throw new DesignError(
			4,
			"Design access or an approved revision is unavailable for this repository.",
		);
	if (response.status >= 500 || response.status === 429)
		throw new DesignError(3, "Pharaoh is temporarily unavailable. Retry shortly.");
	if (!response.ok)
		throw new DesignError(2, `Pharaoh rejected the design request (HTTP ${response.status}).`);
	return readResponse(response);
}
export async function authorizedRequest(
	origin: string,
	path: string,
	signal: AbortSignal,
	body?: unknown,
) {
	const rotation = originBoundRefresh(origin, credentialPath(origin));
	const session = await rotation.load();
	if (!session?.ok) throw new DesignError(3, "Sign in with pharaoh-mcp design login.");
	let response = await request(origin, path, signal, session.creds.access_token, body);
	if (response.status === 401) {
		await response.body?.cancel();
		const renewed = await rotation.renew(session.creds);
		if (!renewed.ok)
			throw new DesignError(3, "Design sign-in expired. Run pharaoh-mcp design login.");
		response = await request(origin, path, signal, renewed.creds.access_token, body);
	}
	return checked(response);
}
export async function resolveBinding(
	origin: string,
	slug: string,
	signal: AbortSignal,
): Promise<
	Binding & { visibility: "public" | "private"; workflowSha?: string; revision: number | null }
> {
	const value = await authorizedRequest(
		origin,
		`/api/design/repos/resolve?slug=${encodeURIComponent(slug)}`,
		signal,
	);
	if (
		typeof value?.repoId !== "string" ||
		!/^[1-9]\d*$/.test(value.repoId) ||
		value.repoSlug?.toLowerCase() !== slug.toLowerCase()
	)
		throw new DesignError(2, "Pharaoh returned a different repository binding.");
	if (value.visibility !== "private" && value.visibility !== "public")
		throw new DesignError(2, "Missing GitHub repository visibility.");
	return {
		repoId: value.repoId,
		repoSlug: value.repoSlug,
		visibility: value.visibility,
		workflowSha: value.workflowSha,
		revision: value.revision,
	};
}
const invalid = () => new DesignError(2, "Invalid, stale or mismatched signed design policy.");
export async function verifyProjection(
	origin: string,
	token: unknown,
	binding: Binding,
	signal: AbortSignal,
	ci?: CiBinding,
): Promise<Projection> {
	if (typeof token !== "string" || token.length > bundleLimit) throw invalid();
	const parts = token.split(".");
	if (parts.length !== 3 || !parts.every((p) => /^[a-zA-Z0-9_-]+$/.test(p))) throw invalid();
	const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
	if (
		header?.alg !== "EdDSA" ||
		typeof header.kid !== "string" ||
		!header.kid ||
		Object.keys(header).some((k) => !["alg", "kid", "typ"].includes(k))
	)
		throw invalid();
	const jwks = await checked(await request(origin, "/api/design/keys", signal));
	if (!Array.isArray(jwks?.keys)) throw invalid();
	const keys = jwks.keys.filter((k: { kid?: string }) => k?.kid === header.kid);
	if (
		keys.length !== 1 ||
		keys[0].kty !== "OKP" ||
		keys[0].crv !== "Ed25519" ||
		keys[0].d ||
		(keys[0].alg && keys[0].alg !== "EdDSA")
	)
		throw invalid();
	const key = createPublicKey({ key: keys[0], format: "jwk" });
	if (
		!verify(null, Buffer.from(parts.slice(0, 2).join(".")), key, Buffer.from(parts[2], "base64url"))
	)
		throw invalid();
	const p = JSON.parse(Buffer.from(parts[1], "base64url").toString());
	const now = Math.floor(Date.now() / 1000);
	if (
		p?.schemaVersion !== 1 ||
		p.iss !== origin ||
		p.aud !== "pharaoh-design-lint" ||
		p.repoId !== binding.repoId ||
		p.repoSlug?.toLowerCase() !== binding.repoSlug.toLowerCase() ||
		typeof p.epoch !== "string" ||
		!p.epoch ||
		!Number.isSafeInteger(p.iat) ||
		!Number.isSafeInteger(p.exp) ||
		p.iat > now + 30 ||
		p.exp <= now ||
		p.exp <= p.iat ||
		!Number.isSafeInteger(p.revision) ||
		p.revision < 1 ||
		(p.visionStatus !== undefined &&
			p.visionStatus !== "present" &&
			p.visionStatus !== "deleted") ||
		!/^[a-f0-9]{64}$/.test(p.visionDigest) ||
		!validDesignRules(p.rules)
	)
		throw invalid();
	for (const field of ["runId", "runAttempt", "sha"] as const)
		if (p[field] !== ci?.[field]) throw invalid();
	return {
		repoId: p.repoId,
		repoSlug: p.repoSlug,
		epoch: p.epoch,
		revision: p.revision,
		visionDigest: p.visionDigest,
		visionStatus: p.visionStatus ?? "present",
		rules: p.rules,
	};
}
export async function approvedProjection(origin: string, slug: string, signal: AbortSignal) {
	const binding = await resolveBinding(origin, slug, signal);
	const { bundle } = await authorizedRequest(
		origin,
		`/api/design/repos/${binding.repoId}/projection`,
		signal,
	);
	return verifyProjection(origin, bundle, binding, signal);
}
