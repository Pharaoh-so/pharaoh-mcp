/**
 * Integration tests for refresh.ts — uses a real HTTP server to exercise the
 * device-flow refresh grant round-trip. Mocking the fetch call would only test
 * our mocks; the whole value here is catching a body-shape mismatch or a
 * header typo against a server that behaves like real Pharaoh.
 *
 * NOTE: this test does NOT exercise the REAL server's routing — the fake
 * server below accepts anything and returns whatever the test sets. A separate
 * real-Express integration test lives at tests/web/device-flow.test.ts to
 * verify the endpoint actually exists and doesn't require client_id. That
 * separation is intentional: the fake-server tests here pin client-side
 * behavior (classification, state machine); the real-Express tests pin the
 * server contract.
 *
 * Server contract we simulate:
 *   POST /device/token-refresh with JSON body { refresh_token }
 *   200 → { access_token, refresh_token, expires_in, refresh_token_expires_in }
 *   400 invalid_grant → token revoked/expired/user-not-in-org
 *   503 → transient GitHub API failure
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Credentials, readCredentials, writeCredentials } from "../src/credentials.js";
import { loadAndRefresh, refreshIfNeeded } from "../src/refresh.js";

interface TestServer {
	url: string;
	close: () => Promise<void>;
	lastRequestBody: () => string | null;
}

/** Start a local HTTP server that mimics the Pharaoh /token endpoint. */
function startTestServer(handler: {
	status: number;
	body: Record<string, unknown>;
}): Promise<TestServer> {
	let capturedBody: string | null = null;
	return new Promise((resolve, reject) => {
		const server: Server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				capturedBody = body;
				res.statusCode = handler.status;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify(handler.body));
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${addr.port}`,
				close: () =>
					new Promise<void>((r) => {
						server.close(() => r());
					}),
				lastRequestBody: () => capturedBody,
			});
		});
		server.on("error", reject);
	});
}

/** Credentials fixture with an expired access token and valid refresh token. */
function expiredAccessCreds(overrides: Partial<Credentials> = {}): Credentials {
	return {
		version: 2,
		access_token: "phat_old",
		refresh_token: "phrt_old",
		expires_at: new Date(Date.now() - 3600_000).toISOString(), // 1h ago
		refresh_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString(), // 180d
		expires_in: 604_800,
		sse_url: "https://mcp.pharaoh.so/sse",
		github_login: "alice",
		tenant_name: "acme",
		repos: ["acme/repo-1"],
		...overrides,
	};
}

describe("refreshIfNeeded", () => {
	let server: TestServer;
	let dir: string;
	let credsPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pharaoh-refresh-"));
		credsPath = join(dir, "credentials.json");
	});

	afterEach(async () => {
		await server?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes new credentials on successful refresh", async () => {
		server = await startTestServer({
			status: 200,
			body: {
				access_token: "phat_new",
				refresh_token: "phrt_new",
				token_type: "bearer",
				expires_in: 604_800,
				refresh_token_expires_in: 365 * 24 * 60 * 60,
			},
		});

		const original = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(original));

		const outcome = await refreshIfNeeded(original, server.url, credsPath);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("unreachable");
		expect(outcome.creds.access_token).toBe("phat_new");
		expect(outcome.creds.refresh_token).toBe("phrt_new");
		// Identity fields carry over from the previous credentials — refresh
		// doesn't re-issue them.
		expect(outcome.creds.github_login).toBe("alice");
		expect(outcome.creds.tenant_name).toBe("acme");
		expect(outcome.creds.repos).toEqual(["acme/repo-1"]);
		// Written to disk with the new tokens
		const onDisk: Credentials = JSON.parse(readFileSync(credsPath, "utf-8"));
		expect(onDisk.access_token).toBe("phat_new");
		expect(onDisk.refresh_token).toBe("phrt_new");

		// Request body is JSON with just refresh_token — no client_id, no
		// grant_type (the endpoint IS the grant_type). This is the whole
		// reason /device/token-refresh exists vs. /token.
		const body = server.lastRequestBody();
		expect(body).not.toBeNull();
		const parsed = JSON.parse(body ?? "{}");
		expect(parsed).toEqual({ refresh_token: "phrt_old" });
	});

	it("400 invalid_grant returns action=reauth and removes the rejected credentials", async () => {
		server = await startTestServer({
			status: 400,
			body: {
				error: "invalid_grant",
				error_description: "Invalid or expired refresh token",
			},
		});

		const original = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(original));

		const outcome = await refreshIfNeeded(original, server.url, credsPath);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.action).toBe("reauth");
		// The file still held the rejected token, so refreshIfNeeded removed it
		// (under the credentials lock — see refresh-concurrency.integration.test.ts).
		expect(existsSync(credsPath)).toBe(false);
	});

	it("503 server_error returns action=preserve, creds intact", async () => {
		server = await startTestServer({
			status: 503,
			body: {
				error: "server_error",
				error_description: "Temporary failure verifying org membership",
			},
		});

		const original = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(original));

		const outcome = await refreshIfNeeded(original, server.url, credsPath);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.action).toBe("preserve");
		// Creds preserved — critical for the VestaTech-BV-shaped failure mode.
		const onDisk: Credentials = JSON.parse(readFileSync(credsPath, "utf-8"));
		expect(onDisk.refresh_token).toBe("phrt_old");
	});

	it("network error (server unreachable) returns action=preserve", async () => {
		// No server started — just use a port that's almost certainly not in use.
		const unreachable = "http://127.0.0.1:1";
		const original = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(original));

		const outcome = await refreshIfNeeded(original, unreachable, credsPath);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.action).toBe("preserve");
		// File unchanged
		const onDisk: Credentials = JSON.parse(readFileSync(credsPath, "utf-8"));
		expect(onDisk.refresh_token).toBe("phrt_old");
	});

	it("short-circuits to reauth when refresh token itself is expired", async () => {
		// Server should NEVER be hit in this path — if it is, the test fails
		// because the server response is 200 with a valid refresh.
		server = await startTestServer({
			status: 200,
			body: {
				access_token: "phat_should_not_happen",
				refresh_token: "phrt_should_not_happen",
				expires_in: 604_800,
				refresh_token_expires_in: 365 * 24 * 60 * 60,
			},
		});

		const deadCreds = expiredAccessCreds({
			refresh_expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		writeFileSync(credsPath, JSON.stringify(deadCreds));

		const outcome = await refreshIfNeeded(deadCreds, server.url, credsPath);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.action).toBe("reauth");
		// Server was not hit — request body is null because the fetch never happened
		expect(server.lastRequestBody()).toBeNull();
	});

	it("400 without invalid_grant → transient (unknown error shape)", async () => {
		// invalid_request is an OAuth2 error code but not one the server's
		// refresh handler emits. Classify as transient (preserve creds) rather
		// than reauth — we can't confidently declare the refresh token dead.
		server = await startTestServer({
			status: 400,
			body: { error: "invalid_request", error_description: "missing parameter" },
		});

		const original = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(original));

		const outcome = await refreshIfNeeded(original, server.url, credsPath);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.action).toBe("transient");
		// Creds preserved — this status-error combo doesn't prove the token is dead
		const onDisk: Credentials = JSON.parse(readFileSync(credsPath, "utf-8"));
		expect(onDisk.refresh_token).toBe("phrt_old");
	});

	it("unexpected status (e.g. 403) → transient (catch-all, preserve creds)", async () => {
		// 403 from /token shouldn't happen — it would mean the server thinks
		// our refresh token is forbidden rather than invalid. Don't blow away
		// creds on an unexpected shape; log it and retry on next spawn.
		server = await startTestServer({
			status: 403,
			body: { error: "forbidden" },
		});

		const original = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(original));

		const outcome = await refreshIfNeeded(original, server.url, credsPath);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.action).toBe("transient");
	});

	it("200 with malformed JSON body returns action=transient (Fix 2.2)", async () => {
		// CDN/proxy truncation or connection drop mid-stream can produce a
		// 200-OK with incomplete/non-JSON body. Without the try/catch around
		// res.json(), this threw SyntaxError out of refreshIfNeeded and hit
		// main()'s redact-only catch — user saw "Pharaoh: fatal — SyntaxError"
		// with no classification. Now: classified as transient, creds preserved.
		const brokenServer = await new Promise<TestServer>((resolve, reject) => {
			let captured: string | null = null;
			const s: Server = createServer((req, res) => {
				let body = "";
				req.on("data", (c) => {
					body += c;
				});
				req.on("end", () => {
					captured = body;
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json");
					// Truncated JSON — valid prefix, missing closing brace
					res.end('{"access_token": "phat_truncated"');
				});
			});
			s.listen(0, "127.0.0.1", () => {
				const addr = s.address() as AddressInfo;
				resolve({
					url: `http://127.0.0.1:${addr.port}`,
					close: () =>
						new Promise<void>((r) => {
							s.close(() => r());
						}),
					lastRequestBody: () => captured,
				});
			});
			s.on("error", reject);
		});
		// Close default server so only the broken one runs
		await server?.close();
		server = brokenServer;

		const original = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(original));

		const outcome = await refreshIfNeeded(original, server.url, credsPath);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.action).toBe("transient");
		expect(outcome.message).toMatch(/[Mm]alformed JSON/);
		// Creds preserved — the server response was malformed, not a revocation
		const onDisk: Credentials = JSON.parse(readFileSync(credsPath, "utf-8"));
		expect(onDisk.refresh_token).toBe("phrt_old");
	});

	it("writeCredentials failure returns action=preserve (Fix 2.3)", async () => {
		// Disk errors (EACCES, ENOSPC, EROFS) during credential persistence
		// are real environmental failures — the server already rotated the
		// token, and we need to keep the old creds intact so the user can
		// retry within the 60s grace window.
		server = await startTestServer({
			status: 200,
			body: {
				access_token: "phat_new",
				refresh_token: "phrt_new",
				expires_in: 604_800,
				refresh_token_expires_in: 365 * 24 * 60 * 60,
			},
		});

		const original = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(original));

		// Force the final rename to fail after the server has rotated the token:
		// the target is a directory, so the lock and temp file (siblings) can be
		// created but nothing can replace the target.
		const directoryTarget = join(dir, "is-a-directory");
		mkdirSync(directoryTarget);

		const outcome = await refreshIfNeeded(original, server.url, directoryTarget);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.action).toBe("preserve");
		expect(outcome.message).toMatch(/Could not persist/);
		// No temp file or lock left behind next to the target.
		expect(readdirSync(dir).sort()).toEqual(["credentials.json", "is-a-directory"]);
		// Old creds on disk untouched — user can retry when disk issue resolves
		const onDisk: Credentials = JSON.parse(readFileSync(credsPath, "utf-8"));
		expect(onDisk.refresh_token).toBe("phrt_old");
	});

	it("an unwritable credentials directory fails before contacting the server", async () => {
		// The lock lives next to the credentials file, so a directory we can't
		// write to stops the refresh before the server rotates anything.
		server = await startTestServer({ status: 200, body: {} });
		const original = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(original));
		const insideAFile = join(credsPath, "cannot-create-subpath.json");

		const outcome = await refreshIfNeeded(original, server.url, insideAFile);

		expect(outcome.ok ? "ok" : outcome.action).toBe("transient");
		expect(server.lastRequestBody()).toBeNull();
		const onDisk: Credentials = JSON.parse(readFileSync(credsPath, "utf-8"));
		expect(onDisk.refresh_token).toBe("phrt_old");
	});

	it("200 with incomplete body returns action=transient (not reauth)", async () => {
		// Server returns 200 but forgets refresh_token. Don't delete creds —
		// this is a server bug, not a terminal auth failure.
		server = await startTestServer({
			status: 200,
			body: {
				access_token: "phat_new",
				// refresh_token missing
				expires_in: 604_800,
			},
		});

		const original = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(original));

		const outcome = await refreshIfNeeded(original, server.url, credsPath);

		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.action).toBe("transient");
	});
});

describe("loadAndRefresh", () => {
	let server: TestServer;
	let dir: string;
	let credsPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pharaoh-load-"));
		credsPath = join(dir, "credentials.json");
	});

	afterEach(async () => {
		await server?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when no credentials file exists", async () => {
		// No server started — if the code tries to fetch, it'll fail obviously.
		const outcome = await loadAndRefresh("http://127.0.0.1:1", credsPath);
		expect(outcome).toBeNull();
	});

	it("returns creds without refreshing when access token is still fresh", async () => {
		// Start a server that would fail the test if hit
		server = await startTestServer({
			status: 500,
			body: { error: "should_not_be_called" },
		});

		const fresh: Credentials = {
			version: 2,
			access_token: "phat_fresh",
			refresh_token: "phrt_fresh",
			expires_at: new Date(Date.now() + 3600_000).toISOString(),
			refresh_expires_at: new Date(Date.now() + 180 * 86_400_000).toISOString(),
			expires_in: 3600,
			sse_url: "https://mcp.pharaoh.so/sse",
			github_login: "alice",
			tenant_name: "acme",
			repos: [],
		};
		writeFileSync(credsPath, JSON.stringify(fresh));

		const outcome = await loadAndRefresh(server.url, credsPath);

		expect(outcome).not.toBeNull();
		if (outcome === null || !outcome.ok) throw new Error("unreachable");
		expect(outcome.creds.access_token).toBe("phat_fresh");
		// Server never received a request — access token wasn't expired
		expect(server.lastRequestBody()).toBeNull();
	});

	it("refreshes when access is expired but refresh is valid", async () => {
		server = await startTestServer({
			status: 200,
			body: {
				access_token: "phat_renewed",
				refresh_token: "phrt_renewed",
				expires_in: 604_800,
				refresh_token_expires_in: 365 * 24 * 60 * 60,
			},
		});

		const expired = expiredAccessCreds();
		writeFileSync(credsPath, JSON.stringify(expired));

		const outcome = await loadAndRefresh(server.url, credsPath);

		expect(outcome).not.toBeNull();
		if (outcome === null || !outcome.ok) throw new Error("unreachable");
		expect(outcome.creds.access_token).toBe("phat_renewed");
		// Server received the refresh request (JSON body, not form-encoded)
		const body = JSON.parse(server.lastRequestBody() ?? "{}");
		expect(body).toEqual({ refresh_token: "phrt_old" });
	});
});

// ── Several proxies sharing one credentials file ─────────────────────────
//
// Every proxy on a machine shares ~/.pharaoh/credentials.json and one OAuth
// session. This fake server follows the real session rules
// (src/auth/token-store.ts refreshSession): one access token per session, a
// refresh with the current refresh token rotates it (the old one stays valid
// 60s as `previous`), a refresh with `previous` replaces the access token but
// hands back the same soon-dead refresh token, anything else is invalid_grant.
//
// Breaks when: concurrent refreshes stop queueing on the credentials lock, a
// proxy refreshes instead of adopting credentials another proxy already wrote,
// or a rejected refresh deletes a credentials file someone else rewrote.

const GRACE_MS = 60_000;

interface RotatingServer {
	url: string;
	refreshCalls: () => number;
	/** Called with each refresh request before the server answers. */
	onRequest: (fn: () => void) => void;
	close: () => Promise<void>;
}

/** Fake /device/token-refresh with the real rotation and grace rules. */
function startRotatingServer(initial: {
	access: string;
	refresh: string;
}): Promise<RotatingServer> {
	let n = Number(initial.refresh.split("_")[1]);
	let currentAccess = initial.access;
	let currentRefresh = initial.refresh;
	let previous: string | null = null;
	let previousExpires = 0;
	let calls = 0;
	let hook: () => void = () => {};

	return new Promise((resolve, reject) => {
		const server: Server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				calls++;
				hook();
				const { refresh_token } = JSON.parse(body) as { refresh_token: string };
				const reply = (status: number, payload: Record<string, unknown>) => {
					// A short delay widens the window in which other refreshes overlap.
					setTimeout(() => {
						res.statusCode = status;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify(payload));
					}, 30);
				};
				if (refresh_token === currentRefresh) {
					previous = currentRefresh;
					previousExpires = Date.now() + GRACE_MS;
					n++;
					currentAccess = `phat_${n}`;
					currentRefresh = `phrt_${n}`;
					reply(200, grant(currentAccess, currentRefresh));
					return;
				}
				if (refresh_token === previous && Date.now() < previousExpires) {
					n++;
					currentAccess = `phat_${n}`;
					reply(200, grant(currentAccess, refresh_token));
					return;
				}
				reply(400, { error: "invalid_grant", error_description: "Invalid refresh token" });
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${addr.port}`,
				refreshCalls: () => calls,
				onRequest: (fn) => {
					hook = fn;
				},
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
		server.on("error", reject);
	});
}

function grant(access: string, refresh: string): Record<string, unknown> {
	return {
		access_token: access,
		refresh_token: refresh,
		expires_in: 604_800,
		refresh_token_expires_in: 365 * 86_400,
	};
}

function creds(access: string, refresh: string, accessExpired: boolean): Credentials {
	return {
		version: 2,
		access_token: access,
		refresh_token: refresh,
		expires_at: new Date(Date.now() + (accessExpired ? -3_600_000 : 6 * 86_400_000)).toISOString(),
		refresh_expires_at: new Date(Date.now() + 300 * 86_400_000).toISOString(),
		expires_in: 604_800,
		sse_url: "https://mcp.pharaoh.so/sse",
		github_login: "alice",
		tenant_name: "acme",
		repos: ["acme/repo"],
	};
}

describe("refreshIfNeeded with several proxies sharing one credentials file", () => {
	let dir: string;
	let path: string;
	let server: RotatingServer | null = null;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pharaoh-refresh-race-"));
		path = join(dir, "credentials.json");
	});

	afterEach(async () => {
		await server?.close();
		server = null;
		rmSync(dir, { recursive: true, force: true });
	});

	it("eight proxies refreshing at once send one refresh and all end on its tokens", async () => {
		const tokenServer = await startRotatingServer({ access: "phat_0", refresh: "phrt_0" });
		server = tokenServer;
		const stale = creds("phat_0", "phrt_0", true);
		writeCredentials(stale, path);

		const outcomes = await Promise.all(
			Array.from({ length: 8 }, () => refreshIfNeeded(stale, tokenServer.url, path)),
		);

		expect(tokenServer.refreshCalls()).toBe(1);
		expect(outcomes.map((o) => (o.ok ? o.creds.access_token : o.action))).toEqual(
			Array(8).fill("phat_1"),
		);
		expect(readCredentials(path)?.refresh_token).toBe("phrt_1");
	});

	it("a proxy whose token was rejected adopts the newer credentials on disk", async () => {
		server = await startRotatingServer({ access: "phat_1", refresh: "phrt_1" });
		writeCredentials(creds("phat_1", "phrt_1", false), path);

		const outcome = await refreshIfNeeded(creds("phat_0", "phrt_0", false), server.url, path);

		expect(outcome.ok && outcome.creds.access_token).toBe("phat_1");
		expect(server.refreshCalls()).toBe(0);
	});

	it("a rejected refresh deletes the file when it still holds the rejected token", async () => {
		server = await startRotatingServer({ access: "phat_9", refresh: "phrt_9" });
		const dead = creds("phat_0", "phrt_0", true);
		writeCredentials(dead, path);

		const outcome = await refreshIfNeeded(dead, server.url, path);

		expect(outcome.ok ? "ok" : outcome.action).toBe("reauth");
		expect(existsSync(path)).toBe(false);
	});

	it("a rejected refresh keeps a file that was rewritten while it was in flight", async () => {
		server = await startRotatingServer({ access: "phat_9", refresh: "phrt_9" });
		const dead = creds("phat_0", "phrt_0", true);
		writeCredentials(dead, path);
		// Someone signs in from a terminal while this refresh is on the wire.
		server.onRequest(() => writeCredentials(creds("phat_new", "phrt_new", false), path));

		const outcome = await refreshIfNeeded(dead, server.url, path);

		expect(outcome.ok && outcome.creds.access_token).toBe("phat_new");
		expect(readCredentials(path)?.access_token).toBe("phat_new");
	});

	it("waits for another proxy's refresh and uses what it wrote", async () => {
		server = await startRotatingServer({ access: "phat_0", refresh: "phrt_0" });
		const stale = creds("phat_0", "phrt_0", true);
		writeCredentials(stale, path);
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, "other-process", { mode: 0o600 });
		setTimeout(() => {
			writeCredentials(creds("phat_other", "phrt_other", false), path);
			rmSync(lockPath);
		}, 200);

		const outcome = await refreshIfNeeded(stale, server.url, path);

		expect(outcome.ok && outcome.creds.access_token).toBe("phat_other");
		expect(server.refreshCalls()).toBe(0);
	});

	it("breaks a lock left behind by a crashed proxy and removes its own lock", async () => {
		server = await startRotatingServer({ access: "phat_0", refresh: "phrt_0" });
		const stale = creds("phat_0", "phrt_0", true);
		writeCredentials(stale, path);
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, "crashed-process", { mode: 0o600 });
		const minuteAgo = new Date(Date.now() - 60_000);
		utimesSync(lockPath, minuteAgo, minuteAgo);

		const outcome = await refreshIfNeeded(stale, server.url, path);

		expect(outcome.ok && outcome.creds.access_token).toBe("phat_1");
		expect(existsSync(lockPath)).toBe(false);
	});

	// Breaks when the refresh request has no deadline: a hung request holds the
	// lock until other proxies judge it stale and refresh the same token again.
	it("gives up on a refresh request that never answers and releases the lock", async () => {
		const hung = createServer(() => {});
		await new Promise<void>((r) => hung.listen(0, "127.0.0.1", () => r()));
		const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}`;
		const stale = creds("phat_0", "phrt_0", true);
		writeCredentials(stale, path);

		const outcome = await refreshIfNeeded(stale, url, path, 200);
		hung.closeAllConnections();
		hung.close();

		expect(outcome.ok).toBe(false);
		expect(!outcome.ok && outcome.action).toBe("preserve");
		expect(readCredentials(path)?.refresh_token).toBe("phrt_0");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it("writes credentials atomically: one 0600 file, no temp files left", async () => {
		writeCredentials(creds("phat_0", "phrt_0", false), path);
		writeCredentials(creds("phat_1", "phrt_1", false), path);

		expect(readdirSync(dir)).toEqual(["credentials.json"]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});
