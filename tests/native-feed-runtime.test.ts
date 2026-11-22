/** Proxy lifecycle tests exercise real feed records with an isolated home and controlled clock. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	nativeFeedRegistration,
	setNativeFeedEnabled,
	setNativeFeedPreviewEnabled,
} from "../runtime/feed-hooks.mjs";
import { deriveFeedCohortKey, readFeedSignInGeneration } from "../runtime/feed-identity.mjs";
import { feedRoot } from "../runtime/feed-io.mjs";
import {
	createFeedStore,
	type FeedConnection,
	HOSTED_MODULE_WATCH_KEY,
	hostedModuleWatchText,
} from "../runtime/feed-store.mjs";
import {
	type Credentials,
	readCredentials,
	saveAuthorizedCredentials,
	writeCredentials,
} from "../src/credentials.js";
import { NativeFeedRuntime } from "../src/native-feed.js";
import { ProxyServer } from "../src/proxy-server.js";

const SERVER = "https://mcp.pharaoh.so";
const CLIENT = { name: "codex-mcp-client", version: "0.166.0" };
const CREDENTIALS: Credentials = {
	version: 2,
	access_token: "fixture-initial",
	refresh_token: "fixture-initial-refresh",
	expires_in: 604800,
	expires_at: "2999-01-01T00:00:00Z",
	refresh_expires_at: "2999-02-01T00:00:00Z",
	sse_url: `${SERVER}/sse/fixture`,
	github_login: "fixture",
	tenant_name: "fixture",
	repos: ["fixture/repo"],
};
let home: string;
let credentialsPath: string;
let checkout: string;
let registration: string;
let store: ReturnType<typeof createFeedStore>;
const runtimes: NativeFeedRuntime[] = [];
const scope = () => ({
	home,
	credentialsPath,
	client: "codex" as const,
	registration,
	server: SERVER,
	serverArgv: [],
	cwd: checkout,
});
const cohort = () =>
	deriveFeedCohortKey({
		...scope(),
		signIn: readFeedSignInGeneration({ home, credentialsPath })!,
		checkout,
	})!;
const records = (key = cohort()) =>
	(store.readCohort(key) as { connections?: FeedConnection[] } | null)?.connections ?? [];
function runtime(credentials: Credentials | undefined = CREDENTIALS) {
	const value = new NativeFeedRuntime({ ...scope(), credentials });
	runtimes.push(value);
	return value;
}

beforeEach(async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
	home = mkdtempSync(join(tmpdir(), "pharaoh-feed-runtime-"));
	mkdirSync(join(home, ".pharaoh"), { mode: 0o700 });
	mkdirSync(join(home, "repo", ".git"), { recursive: true });
	checkout = realpathSync(join(home, "repo"));
	credentialsPath = join(home, ".pharaoh", "credentials.json");
	await saveAuthorizedCredentials(CREDENTIALS, credentialsPath);
	registration = nativeFeedRegistration("codex", { home });
	store = createFeedStore({ home, credentialsPath });
});
afterEach(() => {
	for (const value of runtimes.splice(0)) value.close();
	vi.useRealTimers();
	rmSync(home, { recursive: true, force: true });
});

describe("native feed proxy lifecycle", () => {
	it.each([
		{
			adapter: "claude-code" as const,
			info: { name: "claude-code", version: "2.1.328" },
			eligible: true,
		},
		{
			adapter: "claude-code" as const,
			info: { name: "claude-code", version: "999.0.0" },
			eligible: false,
		},
		{ adapter: "codex" as const, info: CLIENT, eligible: false },
	])("adds hosted watch text only to eligible preview calls for $info.name $info.version", async ({
		adapter,
		info,
		eligible,
	}) => {
		const value = new NativeFeedRuntime({
			...scope(),
			client: adapter,
			registration: nativeFeedRegistration(adapter, { home }),
			credentials: CREDENTIALS,
		});
		runtimes.push(value);
		value.start();
		value.connect(info);

		const input = { repo: "fixture/repo", module: "auth" };
		const content = [{ type: "text" as const, text: "Hosted module body." }];
		const success = { content, _meta: { [HOSTED_MODULE_WATCH_KEY]: { version: 1, ...input } } };
		let reply: CallToolResult = success;
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const proxy = new ProxyServer(
			{ name: "sse", listTools: async () => [], callTool: async () => reply },
			undefined,
			undefined,
			undefined,
			undefined,
			value,
		);
		const client = new Client(info);
		const call = (name = "get_module_context", args = input) =>
			client.callTool({ name, arguments: args });
		try {
			await proxy.startWithTransport(serverTransport);
			await client.connect(clientTransport);
			expect(await call()).toMatchObject(success);
			setNativeFeedPreviewEnabled(adapter, true, { home });
			const previewBody = eligible
				? [...content, { type: "text", text: hostedModuleWatchText(input.repo, input.module) }]
				: content;
			expect(await call()).toMatchObject({ ...success, content: previewBody });

			expect(await call("search_functions")).toMatchObject(success);
			expect(await call(undefined, { ...input, repo: "other/repo" })).toMatchObject(success);
			expect(await call(undefined, { ...input, module: "another" })).toMatchObject(success);
			reply = { ...success, isError: true };
			expect(await call()).toMatchObject(reply);
			reply = { content };
			expect(await call()).toMatchObject(reply);
			reply = success;
			setNativeFeedEnabled(adapter, false, { home });
			expect(await call()).toMatchObject(success);
		} finally {
			await client.close();
			await proxy.stop();
		}
	});

	it("starts pending, preserves exact negotiated metadata, and renews only initialized connections", () => {
		const value = runtime();
		expect(records()).toEqual([]);
		value.start();
		expect(records()).toMatchObject([{ state: "pending", name: null, clientVersion: null }]);
		expect(value.available()).toBe(false);
		value.connect(CLIENT);
		const initial = records()[0];
		expect(initial).toMatchObject({
			state: "initialized",
			name: "codex-mcp-client",
			clientVersion: "0.166.0",
		});
		value.connect({ name: "codex-mcp-client", version: "999.0.0" });
		vi.advanceTimersByTime(40_000);
		expect(records()[0]).toMatchObject({ id: initial.id, clientVersion: "0.166.0" });
		expect(value.available()).toBe(true);
	});

	it("recovers a failed registry write without admitting an ambiguous cohort", () => {
		const directory = feedRoot({ home, credentialsPath });
		const lock = join(directory, "registry.lock");
		mkdirSync(lock, { mode: 0o700 });
		const value = runtime();
		value.start();
		value.connect(CLIENT);
		expect(value.available()).toBe(false);
		rmSync(lock, { recursive: true });
		vi.advanceTimersByTime(10_000);
		expect(records()).toMatchObject([{ state: "initialized", clientVersion: "0.166.0" }]);
		expect(value.available()).toBe(false);
		vi.advanceTimersByTime(20_000);
		expect(value.available()).toBe(true);
	});
	it("lets a pending lease expire without polling or fabricating a client version", () => {
		const value = runtime();
		value.start();
		const before = store.readCohort(cohort()) as {
			connections: Array<FeedConnection & { leaseExpiresAt: number }>;
		};
		const expires = before.connections[0].leaseExpiresAt;
		vi.advanceTimersByTime(40_000);
		const after = store.readCohort(cohort()) as {
			connections: Array<FeedConnection & { leaseExpiresAt: number }>;
		};
		expect(after.connections[0].leaseExpiresAt).toBe(expires);
		expect(value.available()).toBe(false);
		value.connect(CLIENT);
		expect(value.available()).toBe(true);
	});

	it("keeps the generation and connection stable across ordinary token refresh", () => {
		const value = runtime();
		value.start();
		value.connect(CLIENT);
		const generation = readFeedSignInGeneration({ home, credentialsPath });
		const id = records()[0].id;
		const refreshed = {
			...readCredentials(credentialsPath)!,
			access_token: "fixture-refreshed",
			refresh_token: "fixture-refreshed-refresh",
		};
		writeCredentials(refreshed, credentialsPath);
		vi.advanceTimersByTime(10_000);
		expect(readFeedSignInGeneration({ home, credentialsPath })).toBe(generation);
		expect(value.available()).toBe(true);
		value.adoptCredentials(refreshed);
		expect(records()[0].id).toBe(id);
	});

	it("withdraws after explicit sign-in replacement until the new backend snapshot is adopted", async () => {
		const value = runtime();
		value.start();
		value.connect(CLIENT);
		const previous = cohort();
		const next = {
			...CREDENTIALS,
			access_token: "replacement-person",
			refresh_token: "replacement-refresh",
		};
		await saveAuthorizedCredentials(next, credentialsPath);
		expect(value.available()).toBe(false);
		vi.advanceTimersByTime(10_000);
		expect(records(previous)).toEqual([]);
		value.adoptCredentials(CREDENTIALS);
		expect(value.available()).toBe(false);
		expect(records()).toEqual([]);
		value.adoptCredentials(next);
		expect(value.available()).toBe(true);
		expect(records()).toMatchObject([{ state: "initialized", clientVersion: "0.166.0" }]);
	});

	it("honors opt-out, unknown profiles and unrelated client metadata before exposing the tool", () => {
		const value = runtime();
		value.start();
		value.connect(CLIENT);
		expect(value.available()).toBe(true);
		setNativeFeedEnabled("codex", false, { home });
		expect(value.available()).toBe(false);
		setNativeFeedEnabled("codex", true, { home });
		expect(value.available()).toBe(true);
		value.close();
		const unknown = runtime();
		unknown.start();
		unknown.connect({ name: "codex-mcp-client", version: "999.0.0" });
		expect(unknown.available()).toBe(false);
		unknown.close();
		const unrelated = runtime();
		unrelated.start();
		unrelated.connect({ name: "claude-code", version: "2.1.328" });
		expect(unrelated.available()).toBe(false);
	});

	it("keeps repository authorization independent of native profile availability", () => {
		const value = runtime();
		value.start();
		value.connect(CLIENT);
		expect(value.available()).toBe(true);
		const reply = value.share({
			kind: "reported",
			summary: "The validator contract changed.",
			references: ["src/example.ts"],
		});
		expect(reply.isError).toBe(true);
	});

	it("cannot resurrect a closed connection through timers, connect or credential adoption", () => {
		const value = runtime();
		value.start();
		value.connect(CLIENT);
		value.close();
		vi.advanceTimersByTime(60_000);
		value.connect(CLIENT);
		value.adoptCredentials(CREDENTIALS);
		value.start();
		expect(value.available()).toBe(false);
		expect(records()).toEqual([]);
	});
});
