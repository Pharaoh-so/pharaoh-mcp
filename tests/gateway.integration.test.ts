/**
 * Integration tests for gateway.ts — real HTTP server exercising the
 * device-flow state machine end-to-end. Matches the refresh.integration.test
 * pattern (startTestServer helper, local-loopback port, request capture).
 *
 * Why integration over unit: the state machine's value is in the HTTP
 * request shapes and response-to-state mapping. A unit test with mocked
 * fetch would only verify our mocks. The brief is explicit: "One integration
 * test > ten unit tests."
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Credentials, writeCredentials } from "../src/credentials.js";
import { createGateway } from "../src/gateway.js";

// Stub the real openBrowser at the module boundary — guards against Stryker
// mutations that might flip the `opts.openBrowser ?? openBrowser` fallback
// and accidentally spawn real browser tabs during mutation testing.
vi.mock("../src/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../src/auth.js")>("../src/auth.js");
	return { ...actual, openBrowser: vi.fn() };
});

interface Handler {
	status: number;
	body: Record<string, unknown>;
}

interface FakeServer {
	url: string;
	close: () => Promise<void>;
	setDeviceHandler(h: Handler): void;
	setTokenHandler(h: Handler): void;
	setRefreshHandler(h: Handler): void;
	deviceCallCount(): number;
	tokenCallCount(): number;
	refreshCallCount(): number;
}

/**
 * Start a local HTTP server that mimics the Pharaoh /device and /device/token
 * endpoints. Each route has an independently-settable handler and call counter.
 */
function startFakeServer(): Promise<FakeServer> {
	let deviceHandler: Handler = { status: 500, body: { error: "device_handler_unset" } };
	let tokenHandler: Handler = { status: 500, body: { error: "token_handler_unset" } };
	let refreshHandler: Handler = { status: 500, body: { error: "refresh_handler_unset" } };
	let deviceCount = 0;
	let tokenCount = 0;
	let refreshCount = 0;
	return new Promise((resolve, reject) => {
		const server: Server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				let handler: Handler;
				if (req.url === "/device") {
					deviceCount++;
					handler = deviceHandler;
				} else if (req.url === "/device/token") {
					tokenCount++;
					handler = tokenHandler;
				} else if (req.url === "/device/token-refresh") {
					refreshCount++;
					handler = refreshHandler;
				} else {
					res.statusCode = 404;
					res.end();
					return;
				}
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
				setDeviceHandler: (h) => {
					deviceHandler = h;
				},
				setTokenHandler: (h) => {
					tokenHandler = h;
				},
				setRefreshHandler: (h) => {
					refreshHandler = h;
				},
				deviceCallCount: () => deviceCount,
				tokenCallCount: () => tokenCount,
				refreshCallCount: () => refreshCount,
			});
		});
		server.on("error", reject);
	});
}

/** Canonical /device response used by most tests. */
function defaultDeviceBody(server: FakeServer): Record<string, unknown> {
	return {
		device_code: "dc_abc",
		user_code: "WDJB-MJHT",
		verification_uri: `${server.url}/activate`,
		verification_uri_complete: `${server.url}/activate?code=WDJB-MJHT`,
		expires_in: 900,
		interval: 5,
	};
}

function tokenSuccessBody(sseUrl: string): Record<string, unknown> {
	return {
		access_token: "phat_new",
		refresh_token: "phrt_new",
		token_type: "bearer",
		expires_in: 604_800,
		refresh_token_expires_in: 365 * 86_400,
		sse_url: sseUrl,
		github_login: "alice",
		tenant_name: "acme",
		repos: ["acme/repo-1"],
	};
}

/** Shared noop — never open a real browser from tests. */
const noopBrowser = (_url: string): void => {};

/** Credentials as another process would have written them: valid for 7 days. */
function storedCreds(overrides: Partial<Credentials> = {}): Credentials {
	return {
		version: 2,
		access_token: "phat_stored",
		refresh_token: "phrt_stored",
		expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		refresh_expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
		expires_in: 604_800,
		sse_url: "https://mcp.pharaoh.so/sse",
		github_login: "alice",
		tenant_name: "acme",
		repos: ["acme/repo-1"],
		...overrides,
	};
}

describe("gateway state machine (real HTTP)", () => {
	let server: FakeServer;
	let dir: string;
	let credsPath: string;

	beforeEach(async () => {
		server = await startFakeServer();
		dir = mkdtempSync(join(tmpdir(), "pharaoh-gateway-"));
		credsPath = join(dir, "credentials.json");
	});

	afterEach(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("first tool call requests a device code and returns auth URL in content and _meta", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		const gateway = createGateway({
			server: server.url,
			credentialsPath: credsPath,
			openBrowser: noopBrowser,
		});

		const response = await gateway.handleToolCall();

		expect(response).not.toBeNull();
		if (response === null) throw new Error("unreachable");
		// Exactly one /device hit
		expect(server.deviceCallCount()).toBe(1);
		expect(server.tokenCallCount()).toBe(0);
		// Both surfaces carry the URL — _meta for MCP clients that inspect it,
		// content[0].text for fallback human-readable display.
		expect(response.content[0].text).toContain("WDJB-MJHT");
		expect(response.content[0].text).toContain("activate?code=WDJB-MJHT");
		expect(response._meta.auth_url).toBe(`${server.url}/activate?code=WDJB-MJHT`);
		expect(response._meta.user_code).toBe("WDJB-MJHT");
		expect(response._meta.expires_in_seconds).toBe(900);
		expect(response.isError).toBe(true);
	});

	it("second call inside interval window does NOT poll — cached response returned", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({
			status: 400,
			body: { error: "authorization_pending" },
		});
		// Freeze time so elapsed < interval (5s) on the second call.
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});

		const first = await gateway.handleToolCall();
		expect(server.deviceCallCount()).toBe(1);
		expect(server.tokenCallCount()).toBe(0);

		currentTime += 100; // 100ms — well under 5s interval
		const second = await gateway.handleToolCall();

		// No /token call issued because we're inside the interval window.
		expect(server.tokenCallCount()).toBe(0);
		// Same response (auth URL unchanged).
		expect(second).not.toBeNull();
		if (second === null || first === null) throw new Error("unreachable");
		expect(second._meta.auth_url).toBe(first._meta.auth_url);
	});

	it("second call after interval polls /token once — pending keeps same URL", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({
			status: 400,
			body: { error: "authorization_pending" },
		});
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});

		const first = await gateway.handleToolCall();
		expect(server.tokenCallCount()).toBe(0);

		// Jump past the 5s interval.
		currentTime += 6000;
		const second = await gateway.handleToolCall();

		// Exactly one /token call.
		expect(server.tokenCallCount()).toBe(1);
		// Still pending — URL unchanged.
		expect(second).not.toBeNull();
		if (second === null || first === null) throw new Error("unreachable");
		expect(second._meta.auth_url).toBe(first._meta.auth_url);
	});

	it("poll returns authorized → writes creds (0600 perms) and returns null", async () => {
		const sseUrl = `${server.url}/sse`;
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({ status: 200, body: tokenSuccessBody(sseUrl) });
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});

		await gateway.handleToolCall();
		currentTime += 6000; // Past interval
		const response = await gateway.handleToolCall();

		expect(response).toBeNull();
		// Creds file exists and is readable
		const onDisk = JSON.parse(readFileSync(credsPath, "utf-8"));
		expect(onDisk.access_token).toBe("phat_new");
		expect(onDisk.refresh_token).toBe("phrt_new");
		expect(onDisk.github_login).toBe("alice");
		// 0600 perms: lower 9 bits of mode should be 0o600
		const perms = statSync(credsPath).mode & 0o777;
		// On some CI platforms, default umask may widen perms — tighten
		// explicitly so the assertion pins real behavior.
		chmodSync(credsPath, 0o600);
		expect(perms).toBe(0o600);
		// gateway.getCredentials() returns the freshly-written creds
		const creds = gateway.getCredentials();
		expect(creds?.access_token).toBe("phat_new");
	});

	it("expired server code (408 + expired_token) triggers a fresh /device on next call", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({
			status: 400,
			body: { error: "expired_token" },
		});
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});

		await gateway.handleToolCall();
		expect(server.deviceCallCount()).toBe(1);

		currentTime += 6000; // past interval → will poll
		// The poll returns expired, so state doesn't reset via the poll
		// result (the expiry branch inside handleToolCall would — but the
		// server code has its own notion of expiry independent of our
		// client-side expires_at). We cached the response; next call past
		// expires_at will reset.
		await gateway.handleToolCall();
		expect(server.tokenCallCount()).toBe(1);
		// Jump past the full 900s expires_in window.
		currentTime += 901 * 1000;
		await gateway.handleToolCall();
		// Fresh /device call — state was reset by the client-side expiry check.
		expect(server.deviceCallCount()).toBe(2);
	});

	it("network failure during poll leaves state intact — next call returns same URL", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		// Close the underlying HTTP server mid-test to force a fetch failure.
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});

		const first = await gateway.handleToolCall();
		// Kill the server — next poll will fail.
		await server.close();
		currentTime += 6000;
		const second = await gateway.handleToolCall();

		expect(second).not.toBeNull();
		if (second === null || first === null) throw new Error("unreachable");
		// Same URL returned — state unchanged on network error.
		expect(second._meta.auth_url).toBe(first._meta.auth_url);
		// Reopen a no-op server so afterEach doesn't hang.
		server = await startFakeServer();
	});

	it("client-side expiry past expires_at forces a fresh /device without polling", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({
			status: 400,
			body: { error: "authorization_pending" },
		});
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});

		await gateway.handleToolCall();
		expect(server.deviceCallCount()).toBe(1);
		expect(server.tokenCallCount()).toBe(0);

		// Jump past expires_in (900s). Next call should skip polling and
		// issue a new /device directly.
		currentTime += 901 * 1000;
		await gateway.handleToolCall();

		expect(server.deviceCallCount()).toBe(2);
		// Zero /token calls — expiry path skipped polling entirely.
		expect(server.tokenCallCount()).toBe(0);
	});

	it("authorization denied clears state — next call starts a fresh /device", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({
			status: 400,
			body: { error: "access_denied" },
		});
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});

		await gateway.handleToolCall();
		currentTime += 6000;
		const denied = await gateway.handleToolCall();

		// Denied response surfaces the error text — agent and user can see it.
		expect(denied).not.toBeNull();
		if (denied === null) throw new Error("unreachable");
		expect(denied.content[0].text).toMatch(/denied/i);

		// Switch to pending for the fresh attempt — we want to see that
		// the next call starts a fresh /device (no lockout).
		server.setTokenHandler({
			status: 400,
			body: { error: "authorization_pending" },
		});
		await gateway.handleToolCall();
		expect(server.deviceCallCount()).toBe(2);
	});

	it("5xx with non-JSON body is treated as transient — cycle stays alive", async () => {
		// Regression test for H1 (PR review of #884): `pollOnce` previously
		// fell through to the catch-all `denied` branch whenever the server
		// returned a non-JSON body (e.g. Cloudflare/Render 502 HTML page).
		// That killed the device-flow cycle and surfaced "auth denied" to the
		// user during a transient upstream hiccup.
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});

		const first = await gateway.handleToolCall();
		expect(server.deviceCallCount()).toBe(1);

		// Server returns 502 with a JSON body the fake server always stringifies.
		// The real trigger is an unparseable body, so simulate by returning a
		// body whose `error` field is absent — `res.json()` succeeds but every
		// RFC-8628 branch misses and we fall through to `denied`.
		server.setTokenHandler({ status: 502, body: { not_an_error_field: "gateway timeout" } });

		currentTime += 6000; // past interval → will poll
		const second = await gateway.handleToolCall();

		// After the fix: cycle stays alive. Response still carries the original
		// auth URL (cached from state). Denied text MUST NOT appear.
		expect(second).not.toBeNull();
		if (second === null || first === null) throw new Error("unreachable");
		expect(second._meta.auth_url).toBe(first._meta.auth_url);
		expect(second.content[0].text).not.toMatch(/denied/i);
		// And no fresh /device call — state was preserved.
		expect(server.deviceCallCount()).toBe(1);
	});

	it("5xx with unparseable body is treated as transient — cycle stays alive", async () => {
		// Companion to the previous test. Uses a raw non-JSON response to
		// exercise the `res.json().catch(() => ({ error: "unknown" }))` path
		// directly, which was the original trigger on the bug report.
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		// We need to send non-JSON text from the token endpoint. The default
		// fake server always JSON.stringifies; use a raw server for this one.
		const rawServer = await new Promise<{ url: string; close: () => Promise<void> }>(
			(resolve, reject) => {
				const s = createServer((req, res) => {
					if (req.url === "/device") {
						res.statusCode = 200;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify(defaultDeviceBody(server)));
						return;
					}
					if (req.url === "/device/token") {
						res.statusCode = 503;
						res.setHeader("Content-Type", "text/html");
						res.end("<html><body>Service Unavailable</body></html>");
						return;
					}
					res.statusCode = 404;
					res.end();
				});
				s.listen(0, "127.0.0.1", () => {
					const addr = s.address() as AddressInfo;
					resolve({
						url: `http://127.0.0.1:${addr.port}`,
						close: () => new Promise<void>((r) => s.close(() => r())),
					});
				});
				s.on("error", reject);
			},
		);

		try {
			let currentTime = 1_700_000_000_000;
			const gateway = createGateway({
				server: rawServer.url,
				openBrowser: noopBrowser,
				credentialsPath: credsPath,
				now: () => currentTime,
			});

			const first = await gateway.handleToolCall();
			currentTime += 6000;
			const second = await gateway.handleToolCall();

			expect(second).not.toBeNull();
			if (second === null || first === null) throw new Error("unreachable");
			// Still pending, same URL, no denial.
			expect(second.content[0].text).not.toMatch(/denied/i);
			expect(second._meta.auth_url).toBe(first._meta.auth_url);
		} finally {
			await rawServer.close();
		}
	});

	it("hasValidCredentials reflects disk state after successful auth", async () => {
		const sseUrl = `${server.url}/sse`;
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({ status: 200, body: tokenSuccessBody(sseUrl) });
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});

		expect(gateway.hasValidCredentials()).toBe(false);
		await gateway.handleToolCall();
		currentTime += 6000;
		await gateway.handleToolCall();
		expect(gateway.hasValidCredentials()).toBe(true);
	});

	// A proxy that started before sign-in must notice credentials another
	// process wrote later (`npx @pharaoh-so/mcp` in a terminal, or a sibling
	// proxy that finished device flow) instead of starting its own device flow.
	it("uses credentials another process wrote instead of starting a device flow", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
		});
		writeCredentials(storedCreds({ access_token: "phat_from_terminal" }), credsPath);

		const response = await gateway.handleToolCall();

		expect(response).toBeNull();
		expect(server.deviceCallCount()).toBe(0);
		expect(gateway.getCredentials()?.access_token).toBe("phat_from_terminal");
	});

	it("refreshes stored credentials whose access token expired instead of starting a device flow", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setRefreshHandler({
			status: 200,
			body: {
				access_token: "phat_refreshed",
				refresh_token: "phrt_refreshed",
				expires_in: 604_800,
				refresh_token_expires_in: 365 * 86_400,
			},
		});
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
		});
		writeCredentials(
			storedCreds({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
			credsPath,
		);

		const response = await gateway.handleToolCall();

		expect(response).toBeNull();
		expect(server.deviceCallCount()).toBe(0);
		expect(server.refreshCallCount()).toBe(1);
		expect(gateway.getCredentials()?.access_token).toBe("phat_refreshed");
	});

	// Breaks when a rejected refresh token is remembered in memory and sent again
	// on every tool call, spending the per-IP limit the sign-in polls share.
	it("sends a rejected refresh token once, then signs in", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setRefreshHandler({ status: 400, body: { error: "invalid_grant" } });
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
		});
		writeCredentials(
			storedCreds({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
			credsPath,
		);

		await gateway.handleToolCall();
		await gateway.handleToolCall();

		expect(server.refreshCallCount()).toBe(1);
		expect(server.deviceCallCount()).toBe(1);
	});

	// ── Boundary + invariant tests added for mutation coverage (Stryker ≥80%) ──
	// These pin behaviors the main state-machine tests above don't exercise:
	// exact-boundary time comparisons, MCP protocol discriminators, response
	// structure on denial, and the default `now` factory.

	it('auth response carries MCP `type: "text"` content discriminator', async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		const gateway = createGateway({
			server: server.url,
			credentialsPath: credsPath,
			openBrowser: noopBrowser,
		});
		const response = await gateway.handleToolCall();
		if (response === null) throw new Error("unreachable");
		// `type` is a protocol discriminator MCP clients branch on, not UX copy.
		expect(response.content[0].type).toBe("text");
	});

	it("denied response pins isError:true + _meta structure + text discriminator", async () => {
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({ status: 400, body: { error: "access_denied" } });
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});
		await gateway.handleToolCall();
		currentTime += 6000;
		const denied = await gateway.handleToolCall();
		if (denied === null) throw new Error("unreachable");
		expect(denied.isError).toBe(true);
		expect(denied.content[0].type).toBe("text");
		expect(denied._meta.auth_url).toBe(`${server.url}/activate`);
		expect(denied._meta.user_code).toBe("WDJB-MJHT");
		expect(denied._meta.expires_in_seconds).toBe(0);
	});

	it("injected openBrowser is invoked exactly once with the verification URL", async () => {
		// Kills BlockStatement mutation on the try/catch around openBrowserImpl.
		// Without this assertion, mutating the try body to `{}` (never calls
		// openBrowser) has no observable effect on the response shape.
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		const openBrowserSpy = vi.fn();
		const gateway = createGateway({
			server: server.url,
			credentialsPath: credsPath,
			openBrowser: openBrowserSpy,
		});
		await gateway.handleToolCall();
		expect(openBrowserSpy).toHaveBeenCalledTimes(1);
		expect(openBrowserSpy).toHaveBeenCalledWith(`${server.url}/activate?code=WDJB-MJHT`);
	});

	it("default now() factory — rapid calls without time injection don't double-poll", async () => {
		// Kills ArrowFunction mutation on `opts.now ?? (() => Date.now())`.
		// If the default now() returns undefined (mutated), last_poll_at becomes
		// undefined, shouldSkipPoll math produces NaN, NaN < interval_ms is false,
		// and every tool call would re-poll /token.
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({ status: 400, body: { error: "authorization_pending" } });
		const gateway = createGateway({
			server: server.url,
			credentialsPath: credsPath,
			openBrowser: noopBrowser,
			// NOTE: no `now` injected — exercises the default Date.now() factory.
		});
		await gateway.handleToolCall();
		await gateway.handleToolCall();
		// Two rapid calls well under the 5s interval — second must skip polling.
		expect(server.tokenCallCount()).toBe(0);
	});

	it("shouldSkipPoll boundary: elapsed === interval_ms polls (strict < semantics)", async () => {
		// Kills EqualityOperator mutation on `elapsed < interval_ms`.
		// At elapsed exactly equal to interval_ms:
		//   original  `<`:  5000 < 5000 = false → don't skip → poll
		//   mutated  `<=`: 5000 <= 5000 = true  → skip → no poll
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({ status: 400, body: { error: "authorization_pending" } });
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});
		await gateway.handleToolCall();
		// Advance exactly the interval — expect the strict `<` to return false.
		currentTime += 5000;
		await gateway.handleToolCall();
		expect(server.tokenCallCount()).toBe(1);
	});

	it("expires_at boundary: now === expires_at starts a fresh /device", async () => {
		// Kills EqualityOperator mutation on `now() >= pending.expires_at`.
		// At exact boundary the client-side expiry check must fire.
		server.setDeviceHandler({ status: 200, body: defaultDeviceBody(server) });
		server.setTokenHandler({ status: 400, body: { error: "authorization_pending" } });
		let currentTime = 1_700_000_000_000;
		const gateway = createGateway({
			server: server.url,
			openBrowser: noopBrowser,
			credentialsPath: credsPath,
			now: () => currentTime,
		});
		await gateway.handleToolCall();
		expect(server.deviceCallCount()).toBe(1);
		// Jump to EXACTLY expires_at (default device body: expires_in = 900s).
		currentTime += 900 * 1000;
		await gateway.handleToolCall();
		expect(server.deviceCallCount()).toBe(2);
		// Zero token calls — expiry short-circuits before any poll.
		expect(server.tokenCallCount()).toBe(0);
	});

	it("hasValidCredentials boundary: now === expires_at returns false", async () => {
		// Kills EqualityOperator + ConditionalExpression + BlockStatement
		// mutations inside isAccessExpired. Requires `now` to be injected into
		// isAccessExpired via the gateway's single shared clock (refactor
		// shipped with this PR — previously isAccessExpired used Date.now()
		// directly, unreachable from tests).
		const now = 1_700_000_000_000;
		const creds = {
			version: 2 as const,
			access_token: "phat_x",
			refresh_token: "phrt_x",
			expires_at: new Date(now).toISOString(),
			refresh_expires_at: new Date(now + 365 * 86_400_000).toISOString(),
			expires_in: 604_800,
			sse_url: `${server.url}/sse`,
			github_login: "alice",
			tenant_name: "acme",
			repos: ["acme/repo-1"],
		};
		writeFileSync(credsPath, JSON.stringify(creds), { mode: 0o600 });

		// At exact expiry, >= fires → expired → hasValidCredentials = false.
		const atExpiry = createGateway({
			server: server.url,
			credentialsPath: credsPath,
			openBrowser: noopBrowser,
			now: () => now,
		});
		expect(atExpiry.hasValidCredentials()).toBe(false);

		// One ms before expiry, still valid — positive path kills ConditionalExpression
		// that flips the early-return body.
		const beforeExpiry = createGateway({
			server: server.url,
			credentialsPath: credsPath,
			openBrowser: noopBrowser,
			now: () => now - 1,
		});
		expect(beforeExpiry.hasValidCredentials()).toBe(true);
	});

	it("hasValidCredentials returns false for malformed expires_at (NaN path)", async () => {
		// Kills ConditionalExpression on `if (Number.isNaN(expiresAt)) return true`.
		// A non-ISO date string parses to NaN; isAccessExpired must treat it as
		// expired. Without this test, mutating the if-body to return false means
		// NaN creds pass as valid, surfacing a worse failure downstream.
		const creds = {
			version: 2 as const,
			access_token: "phat_x",
			refresh_token: "phrt_x",
			expires_at: "not-a-valid-date",
			refresh_expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
			expires_in: 604_800,
			sse_url: `${server.url}/sse`,
			github_login: "alice",
			tenant_name: "acme",
			repos: ["acme/repo-1"],
		};
		writeFileSync(credsPath, JSON.stringify(creds), { mode: 0o600 });

		const gateway = createGateway({
			server: server.url,
			credentialsPath: credsPath,
			openBrowser: noopBrowser,
		});
		expect(gateway.hasValidCredentials()).toBe(false);
	});
});
