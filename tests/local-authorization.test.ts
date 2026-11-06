import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Credentials, writeCredentials } from "../src/credentials.js";
import { createLocalAuthorization } from "../src/local/authorization.js";
import { renewOriginBoundSignIn } from "../src/refresh.js";

const SERVER = "https://pharaoh.example";
const NOW = Date.parse("2026-11-05T18:00:00.000Z");
const PERMIT = "9a258767-b52d-4125-a63c-a774582a010d";

let directory: string;
let credentialsPath: string;
let credentials: Credentials;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pharaoh-local-authorization-"));
	credentialsPath = join(directory, "credentials.json");
	const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
	credentials = {
		version: 2,
		sse_url: `${SERVER}/sse`,
		access_token: "phat_old",
		refresh_token: "phrt_old",
		expires_in: 3_600,
		expires_at: expiresAt,
		refresh_expires_at: expiresAt,
		github_login: "alice",
		tenant_name: "team",
		repos: ["team/project"],
	};
	writeCredentials(credentials, credentialsPath);
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function reservation(permitId = PERMIT, expiresAt = NOW + 60_000) {
	return Response.json(
		{
			version: 1,
			permitId,
			expiresAt: new Date(expiresAt).toISOString(),
		},
		{ status: 201 },
	);
}

function authorize(fetchReceipt: typeof fetch, server = SERVER) {
	return createLocalAuthorization({
		server,
		credentialsPath,
		fetch: fetchReceipt,
		now: () => NOW,
	});
}

it("sends only versioned receipt metadata and repeats an ambiguous commit with the same IDs", async () => {
	const fetchReceipt = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(reservation())
		.mockRejectedValueOnce(new Error("PRIVATE_RESPONSE_SENTINEL"))
		.mockResolvedValueOnce(new Response(null, { status: 204 }));
	const client = authorize(fetchReceipt);
	const permit = await client.reserve("team/project");
	await client.commit(permit, "valid_empty");

	const reserveBody = {
		version: 1,
		requestId: permit.requestId,
		repoSlug: "team/project",
		tool: "get_blast_radius",
	};
	const commitBody = {
		version: 1,
		requestId: permit.requestId,
		permitId: PERMIT,
		outcome: "valid_empty",
	};
	expect(
		fetchReceipt.mock.calls.map(([url, options]) => [
			String(url),
			JSON.parse(String(options?.body)),
		]),
	).toEqual([
		[`${SERVER}/api/local/v1/reserve`, reserveBody],
		[`${SERVER}/api/local/v1/commit`, commitBody],
		[`${SERVER}/api/local/v1/commit`, commitBody],
	]);
	for (const [, options] of fetchReceipt.mock.calls) {
		expect(options).toMatchObject({
			method: "POST",
			redirect: "error",
			cache: "no-store",
			headers: { Authorization: "Bearer phat_old", "Content-Type": "application/json" },
		});
	}
});

it("refuses cross-origin credentials and a changed sign-in without replaying a receipt", async () => {
	const fetchReceipt = vi.fn<typeof fetch>().mockResolvedValueOnce(reservation());
	await expect(
		authorize(fetchReceipt, "https://different.example").reserve("team/project"),
	).rejects.toMatchObject({ code: "sign_in_changed" });
	expect(fetchReceipt).not.toHaveBeenCalled();

	const client = authorize(fetchReceipt);
	const permit = await client.reserve("team/project");
	const replacement = { ...credentials, access_token: "phat_new", refresh_token: "phrt_new" };
	writeCredentials(replacement, credentialsPath);
	await expect(client.commit(permit, "answered")).rejects.toMatchObject({
		code: "sign_in_changed",
	});
	expect(fetchReceipt).toHaveBeenCalledTimes(1);
	// The existing hosted refresh path would adopt this current, unexpired token.
	// The opt-in local fence rejects it even when it is for the same login and origin.
	await expect(renewOriginBoundSignIn(credentials, SERVER, credentialsPath)).resolves.toMatchObject(
		{
			ok: false,
			action: "reauth",
		},
	);
});

it("refuses a response with unexpected or oversized fields using a fixed message", async () => {
	const fetchReceipt = vi.fn<typeof fetch>().mockResolvedValueOnce(
		Response.json({
			version: 1,
			permitId: PERMIT,
			expiresAt: new Date(NOW + 60_000).toISOString(),
			details: "PRIVATE_RESPONSE_SENTINEL".repeat(100),
		}),
	);
	await expect(authorize(fetchReceipt).reserve("team/project")).rejects.toMatchObject({
		code: "unavailable",
		message: "Local authorization is unavailable. Retry the local query.",
	});
});

it("sends neither an invalid slug nor a permit minted for a different invocation", async () => {
	const fetchReceipt = vi.fn<typeof fetch>().mockResolvedValueOnce(reservation());
	const client = authorize(fetchReceipt);
	await expect(client.reserve("../PRIVATE_SELECTOR_SENTINEL")).rejects.toMatchObject({
		code: "invalid_request",
	});
	expect(fetchReceipt).not.toHaveBeenCalled();

	const permit = await client.reserve("team/project");
	await expect(authorize(fetchReceipt).abort(permit, "cancelled")).rejects.toMatchObject({
		code: "permit_invalid",
	});
	expect(fetchReceipt).toHaveBeenCalledTimes(1);
});

it("reconfirms the exact reservation without committing usage", async () => {
	const fetchReceipt = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(reservation())
		.mockResolvedValueOnce(reservation());
	const client = authorize(fetchReceipt);
	const permit = await client.reserve("team/project");
	await client.confirm(permit);
	expect(fetchReceipt).toHaveBeenCalledTimes(2);
	const [[reserveUrl, reserve], [confirmUrl, confirm]] = fetchReceipt.mock.calls;
	expect(String(reserveUrl)).toBe(`${SERVER}/api/local/v1/reserve`);
	expect(String(confirmUrl)).toBe(String(reserveUrl));
	expect(confirm?.body).toBe(reserve?.body);
});

it.each([
	[
		"a replaced permit",
		() => reservation("afba80ee-289c-42c0-91c3-628fdccbd240"),
		"permit_invalid",
	],
	["a changed expiry", () => reservation(PERMIT, NOW + 55_000), "permit_invalid"],
	["revoked access", () => new Response(null, { status: 403 }), "access_denied"],
] as const)("refuses confirmation with %s", async (_reason, response, code) => {
	const fetchReceipt = vi.fn<typeof fetch>().mockResolvedValueOnce(reservation());
	fetchReceipt.mockResolvedValueOnce(response());
	const client = authorize(fetchReceipt);
	const permit = await client.reserve("team/project");
	await expect(client.confirm(permit)).rejects.toMatchObject({ code });
	expect(fetchReceipt.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
		"/api/local/v1/reserve",
		"/api/local/v1/reserve",
	]);
});

it("refuses a confirmation after permit expiry before sending", async () => {
	const fetchReceipt = vi.fn<typeof fetch>().mockResolvedValueOnce(reservation());
	let now = NOW;
	const client = createLocalAuthorization({
		server: SERVER,
		credentialsPath,
		fetch: fetchReceipt,
		now: () => now,
	});
	const permit = await client.reserve("team/project");
	now += 60_000;
	await expect(client.confirm(permit)).rejects.toMatchObject({ code: "permit_expired" });
	expect(fetchReceipt).toHaveBeenCalledTimes(1);
});

it("refuses delivery when sign-in changed after a successful confirmation", async () => {
	const fetchReceipt = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(reservation())
		.mockResolvedValueOnce(reservation());
	const client = authorize(fetchReceipt);
	const permit = await client.reserve("team/project");
	await client.confirm(permit);
	expect(() => client.assertCurrentSignIn()).not.toThrow();

	writeCredentials(
		{ ...credentials, access_token: "phat_other", refresh_token: "phrt_other" },
		credentialsPath,
	);
	expect(() => client.assertCurrentSignIn()).toThrow("Pharaoh sign-in changed.");
	expect(fetchReceipt).toHaveBeenCalledTimes(2);
});
