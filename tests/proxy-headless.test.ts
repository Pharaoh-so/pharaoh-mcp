/**
 * Headless-environment invariant: when openBrowser is a noop or throws (SSH,
 * containers, CI runners with no DE), the auth URL MUST still surface in both
 * content[0].text (for text-only clients) and _meta.auth_url (for MCP clients
 * that parse structured metadata). This is the guarantee that makes the proxy
 * work on servers where `open` / `xdg-open` silently fail.
 *
 * One-shot per path — tighter than gateway.integration.test.ts's full state
 * machine suite, focused on the "browser side effect is optional" property.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../src/gateway.js";

// Stub openBrowser at the module boundary so mutated fallbacks can never
// reach the real execFile("open", ...) call during mutation testing.
vi.mock("../src/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../src/auth.js")>("../src/auth.js");
	return { ...actual, openBrowser: vi.fn() };
});

function startDeviceCodeServer(): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer((_req, res) => {
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify({
					device_code: "dev_headless_fixture",
					user_code: "ZZZZ-YYYY",
					verification_uri: "https://mcp.pharaoh.so/activate",
					verification_uri_complete: "https://mcp.pharaoh.so/activate?code=ZZZZ-YYYY",
					expires_in: 300,
					interval: 5,
				}),
			);
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${addr.port}`,
				close: () =>
					new Promise<void>((r) => {
						server.close(() => r());
					}),
			});
		});
		server.on("error", reject);
	});
}

describe("gateway in headless environment", () => {
	let server: Awaited<ReturnType<typeof startDeviceCodeServer>>;
	let dir: string;
	let credsPath: string;

	beforeEach(async () => {
		server = await startDeviceCodeServer();
		dir = mkdtempSync(join(tmpdir(), "pharaoh-headless-"));
		credsPath = join(dir, "credentials.json");
	});

	afterEach(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("surfaces auth URL in both content and _meta when openBrowser is a noop", async () => {
		const gateway = createGateway({
			server: server.url,
			credentialsPath: credsPath,
			openBrowser: () => {
				// noop — simulates a headless environment with no `open`/`xdg-open`
			},
		});

		const response = await gateway.handleToolCall();
		if (response === null) throw new Error("expected auth response, got null");

		// Structured path — MCP clients that read _meta can act on this directly.
		expect(response._meta.auth_url).toBe("https://mcp.pharaoh.so/activate?code=ZZZZ-YYYY");
		expect(response._meta.user_code).toBe("ZZZZ-YYYY");
		expect(response._meta.expires_in_seconds).toBe(300);
		// Text path — agents / clients that only surface content[0].text still
		// see the full URL so the user can copy-paste.
		expect(response.content[0]?.text).toContain(
			"https://mcp.pharaoh.so/activate?code=ZZZZ-YYYY",
		);
		expect(response.content[0]?.text).toContain("ZZZZ-YYYY");
	});

	it("still surfaces auth URL when openBrowser throws (xdg-open not installed)", async () => {
		const gateway = createGateway({
			server: server.url,
			credentialsPath: credsPath,
			openBrowser: () => {
				throw new Error("xdg-open: command not found");
			},
		});

		// A throw from openBrowser must not propagate — the gateway should
		// swallow it and still return the auth response.
		const response = await gateway.handleToolCall();
		if (response === null) throw new Error("expected auth response, got null");

		expect(response._meta.auth_url).toBe("https://mcp.pharaoh.so/activate?code=ZZZZ-YYYY");
		expect(response.content[0]?.text).toContain(
			"https://mcp.pharaoh.so/activate?code=ZZZZ-YYYY",
		);
	});
});
