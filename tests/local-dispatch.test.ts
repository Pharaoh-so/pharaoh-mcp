/** Verify the local blast-radius claim can never become an upstream route on failure. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { selectBlastRoute } from "../src/local/dispatch.js";
import { installedLocalAnalyzer, localAnalyzerInstallStatus } from "../src/local/worker-host.js";
import { ProxyServer } from "../src/proxy-server.js";

const checkout = {
	repoSlug: "example/work",
	root: "/checkouts/work",
	worktreeId: "verified-1",
	device: "1",
	inode: "2",
};
const local = { kind: "checkout", checkout } as const;
const hosted = { kind: "hosted-only" } as const;
const query = { repo: "example/work", entity: "src/local.ts:privateEdit", entity_type: "function" };
const name = "get_blast_radius";
const noMarker = () => undefined;

describe("saved-worktree routing", () => {
	it("keeps an exact pinned Linux analyzer hosted-only without a supported glibc runtime", () => {
		const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pharaoh-linux-reader-")));
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
		const report = vi.spyOn(process.report, "getReport");
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "linux" });
			Object.defineProperty(process, "arch", { ...arch, value: "x64" });
			const proxy = join(scratch, "mcp");
			const analyzer = join(scratch, "local-analyzer");
			const reader = join(analyzer, "dist", "bin", "linux-x64", "capture");
			mkdirSync(proxy);
			mkdirSync(dirname(reader), { recursive: true });
			writeFileSync(
				join(proxy, "package.json"),
				JSON.stringify({ optionalDependencies: { "@pharaoh-so/local-analyzer": "1.2.3" } }),
			);
			writeFileSync(
				join(analyzer, "package.json"),
				JSON.stringify({ name: "@pharaoh-so/local-analyzer", version: "1.2.3" }),
			);
			writeFileSync(join(analyzer, "dist", "analyzer.mjs"), "");
			writeFileSync(reader, "");

			for (const glibcVersionRuntime of [undefined, "2.9", "2.33", "invalid"]) {
				report.mockReturnValue({ header: { glibcVersionRuntime } });
				expect(localAnalyzerInstallStatus(proxy)).toBe("hosted-only");
				expect(installedLocalAnalyzer(proxy)).toBeUndefined();
			}
			report.mockReturnValue({ header: { glibcVersionRuntime: "2.34" } });
			expect(localAnalyzerInstallStatus(proxy)).toBe("ready");
			expect(installedLocalAnalyzer(proxy)?.reader).toBe(reader);
			rmSync(reader);
			expect(localAnalyzerInstallStatus(proxy)).toBe("repair-needed");
		} finally {
			report.mockRestore();
			Object.defineProperty(process, "platform", platform);
			Object.defineProperty(process, "arch", arch);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("defaults to local for a matching checkout and accepts a verified native claim", () => {
		const route = {
			kind: "local",
			checkout,
			query: { entity: "src/local.ts:privateEdit", entityType: "function", depth: 3 },
		};
		expect(selectBlastRoute(name, query, local, noMarker)).toEqual(route);
		expect(
			selectBlastRoute(name, { ...query, local_context: "a".repeat(43) }, hosted, () => checkout),
		).toEqual(route);
	});

	it("preserves initial hosted access for a hosted client or a different full repo", () => {
		expect(selectBlastRoute(name, query, hosted, noMarker)).toEqual({ kind: "hosted" });
		expect(selectBlastRoute(name, { ...query, repo: "other/work" }, local, noMarker)).toEqual({
			kind: "hosted",
		});
		expect(selectBlastRoute(name, { ...query, scope: "hosted" }, local, noMarker)).toEqual({
			kind: "hosted",
		});
	});

	it("never classifies a malformed, expired, mismatched, or conflicting proof as hosted", () => {
		for (const args of [
			{ ...query, local_context: "" },
			{ ...query, local_context: "a".repeat(43) },
			{ ...query, local_context: "a".repeat(43), scope: "hosted" },
			{ ...query, scope: "local", repo: "other/work" },
			{ ...query, scope: "local", entity_type: "file", entity: "../private.ts" },
		]) {
			expect(selectBlastRoute(name, args, local, noMarker).kind).toBe("refused");
		}
		expect(selectBlastRoute(name, { ...query, scope: "local" }, hosted, noMarker)).toEqual({
			kind: "refused",
			code: "unverified_worktree",
		});
	});

	it("rejects selectors above the analyzer's 512-character limit during routing", () => {
		expect(
			selectBlastRoute(name, { ...query, entity: "a".repeat(512) }, local, noMarker).kind,
		).toBe("local");
		expect(selectBlastRoute(name, { ...query, entity: "a".repeat(513) }, local, noMarker)).toEqual({
			kind: "refused",
			code: "invalid_local_request",
		});
	});

	it("keeps hosted startup eager when the local runtime has no eligible worktree", async () => {
		const start = vi.fn(async () => {});
		const proxy = new ProxyServer(
			{ name: "sse", start, listTools: async () => [], callTool: async () => ({ content: [] }) },
			undefined,
			{ invocation: hosted, consume: noMarker, answer: async () => ({ content: [] }) },
		);
		const [, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await proxy.startWithTransport(serverTransport);
			expect(start).toHaveBeenCalledOnce();
			await proxy.setBackend({
				name: "sse",
				start,
				listTools: async () => [],
				callTool: async () => ({ content: [] }),
			});
			expect(start).toHaveBeenCalledTimes(2);
		} finally {
			await proxy.stop();
		}
	});

	it("serves a local answer even when hosted startup fails", async () => {
		let forwarded = 0;
		let written = false;
		let settleAnswer!: (value: boolean) => void;
		const delivery = new Promise<boolean>((resolve) => {
			settleAnswer = resolve;
		});
		const proxy = new ProxyServer(
			{
				name: "sse",
				start: async () => {
					throw new Error("Upstream unavailable");
				},
				listTools: async () => [],
				callTool: async () => {
					forwarded++;
					throw new Error("Local request went upstream");
				},
			},
			undefined,
			{
				invocation: local,
				consume: noMarker,
				answer: async (_route, _signal, onDelivery) => {
					onDelivery(async (delivered) => settleAnswer(delivered && written));
					return { content: [{ type: "text", text: "local result" }] };
				},
			},
		);
		const client = new Client({ name: "worktree-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const send = serverTransport.send.bind(serverTransport);
		serverTransport.send = async (message, options) => {
			await send(message, options);
			if ("result" in message && Object.hasOwn(message.result, "content")) written = true;
		};
		try {
			await proxy.startWithTransport(serverTransport);
			await client.connect(clientTransport);
			const { tools } = await client.listTools();
			expect(tools.some((tool) => tool.name === name)).toBe(true);
			const answer = await client.callTool({ name, arguments: query });
			expect(answer.content).toEqual([{ type: "text", text: "local result" }]);
			expect(await delivery).toBe(true);
			expect(forwarded).toBe(0);
		} finally {
			await client.close().finally(() => proxy.stop());
		}
	});

	/** Also breaks when: pharaoh_update is forwarded to the hosted server instead of answered here. */
	it("keeps readiness local and continues to serve ordinary hosted recon", async () => {
		const forwarded: string[] = [];
		const proxy = new ProxyServer({
			name: "sse",
			listTools: async () => [],
			callTool: async (tool) => {
				forwarded.push(tool);
				return { content: [{ type: "text", text: "hosted" }] };
			},
		});
		const client = new Client({ name: "worktree-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await proxy.startWithTransport(serverTransport);
			await client.connect(clientTransport);
			const status = await client.callTool({
				name: "pharaoh_local_worktree_status",
				arguments: { challenge: "a".repeat(43) },
			});
			expect(status.isError).toBe(true);
			expect(forwarded).toEqual([]);
			// The proxy verifies and stages updates itself (here its child can't run); the hosted tool is never asked.
			const update = await client.callTool({ name: "pharaoh_update", arguments: {} });
			expect(update.content).toEqual([
				{ type: "text", text: expect.stringContaining("Pharaoh did not stage the update") },
			]);
			expect(forwarded).toEqual([]);
			for (const claim of [{ scope: "local" }, { local_context: "unverified" }]) {
				const refused = await client.callTool({
					name: "pharaoh_recon",
					arguments: {
						repo: "example/work",
						blast_radius: [{ entity: "existing" }, { ...query, ...claim }],
					},
				});
				expect(refused.isError).toBe(true);
				expect(refused._meta?.errorCode).toBe("invalid_local_request");
			}
			expect(forwarded).toEqual([]);
			await client.callTool({
				name: "pharaoh_recon",
				arguments: { repo: "example/work", blast_radius: [{ entity: "existing" }] },
			});
			expect(forwarded).toEqual(["pharaoh_recon"]);
		} finally {
			await client.close().finally(() => proxy.stop());
		}
	});

	it("rechecks a native memory proof after waiting for hosted readiness", async () => {
		let proofCurrent = true;
		let forwarded = 0;
		const proxy = new ProxyServer(
			{
				name: "sse",
				listTools: async () => [],
				callTool: async (_name, _args, options) => {
					proofCurrent = false;
					const refusal = options?.beforeSend?.();
					if (refusal) return refusal;
					forwarded++;
					return { content: [{ type: "text", text: "hosted" }] };
				},
			},
			undefined,
			{
				invocation: hosted,
				consume: noMarker,
				answer: async () => ({ content: [] }),
				memoryBinding: () => undefined,
				authorizeMemory: () => () => proofCurrent,
			},
		);
		const client = new Client({ name: "worktree-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await proxy.startWithTransport(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool({
				name: "pharaoh_memory_recall",
				arguments: { repo: "example/work", terms: ["private canary"] },
			});
			expect(result.isError).toBe(true);
			expect(forwarded).toBe(0);
		} finally {
			await client.close().finally(() => proxy.stop());
		}
	});
});
