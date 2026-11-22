/** Native hook boundary tests use sanitized interactive profiles and real isolated feed state. */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	nativeFeedRegistration,
	setNativeFeedEnabled,
	setNativeFeedPreviewEnabled,
} from "../runtime/feed-hooks.mjs";
import {
	deriveFeedCohortKey,
	feedCheckoutIdentity,
	readFeedSignInGeneration,
	resolveFeedProfile,
} from "../runtime/feed-identity.mjs";
import { feedRoot } from "../runtime/feed-io.mjs";
import {
	createFeedStore,
	type FeedAccessProof,
	hostedModuleWatchText,
} from "../runtime/feed-store.mjs";
import { confirmNativeFeedEmission, runNativeFeedHook } from "../runtime/native-feed-hook.mjs";
import { readCredentials, saveAuthorizedCredentials } from "../src/credentials.js";
import { NativeFeedRuntime } from "../src/native-feed.js";

type Client = "codex" | "claude-code";
interface Fixture {
	clientInfo: { name: string; version: string };
	start: Record<string, unknown>;
	checkpoint: Record<string, unknown>;
}
const profiles = [
	{ client: "codex" as Client, file: "codex-0.166.0.json" },
	{ client: "claude-code" as Client, file: "claude-code-2.1.328.json" },
	{ client: "claude-code" as Client, file: "claude-code-2.1.327.json" },
];
const homes: string[] = [];
const SERVER = "https://mcp.pharaoh.so";
const REPO = "fixture/native-feed";
const PATH = "src/example.ts";
const SIBLING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRIVATE_DELTA = "The shared validator changed its return contract.";
const text = (output: ReturnType<typeof runNativeFeedHook>) =>
	output?.hookSpecificOutput.additionalContext ?? "";

/** Simulate the native transport accepting the returned JSON before marking emission. */
function deliver(payload: unknown, options: Parameters<typeof runNativeFeedHook>[1]) {
	const output = runNativeFeedHook(payload, options);
	if (output) confirmNativeFeedEmission(output);
	return output;
}

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function context(client: Client, file: string, withProof = true) {
	const fixture: Fixture = JSON.parse(
		readFileSync(join(__dirname, "fixtures", "native-feed", file), "utf8"),
	);
	const home = mkdtempSync(join(tmpdir(), "pharaoh-native-feed-hook-"));
	homes.push(home);
	mkdirSync(join(home, ".pharaoh"), { mode: 0o700 });
	mkdirSync(join(home, "repo", ".git"), { recursive: true });
	const checkout = realpathSync(join(home, "repo"));
	const credentialsPath = join(home, ".pharaoh", "credentials.json");
	await saveAuthorizedCredentials(
		{
			version: 2,
			access_token: "fixture-access",
			refresh_token: "fixture-refresh",
			expires_at: "2999-01-01T00:00:00Z",
			refresh_expires_at: "2999-02-01T00:00:00Z",
			expires_in: 604800,
			sse_url: `${SERVER}/sse/fixture`,
			github_login: "fixture",
			tenant_name: "fixture",
			repos: [REPO],
		},
		credentialsPath,
	);
	let clock = Date.now();
	const registration = nativeFeedRegistration(client, { home });
	const signIn = readFeedSignInGeneration({ home, credentialsPath })!;
	const cohort = deriveFeedCohortKey({
		client,
		registration,
		server: SERVER,
		serverArgv: [],
		signIn,
		checkout,
	})!;
	const store = createFeedStore({ home, credentialsPath, now: () => clock });
	const connection = {
		id: randomUUID(),
		cohort,
		client,
		signIn,
		checkout,
		state: "initialized" as const,
		name: fixture.clientInfo.name,
		clientVersion: fixture.clientInfo.version,
	};
	expect(store.recordFeedConnection(connection)).toBe(true);
	const proof = (): FeedAccessProof => ({
		version: 1,
		issuer: SERVER,
		actor: 123,
		owner: 456,
		repo: REPO,
		epoch: 1,
		signIn,
		checkout,
		checkoutIdentity: feedCheckoutIdentity(checkout)!,
		requestedAt: clock,
		expiresAt: clock + 60_000,
	});
	if (withProof) expect(store.putAccessProof({ cohort, proof: proof() })).toBe(true);
	const launch = vi.fn();
	const options = {
		client,
		registration,
		server: SERVER,
		serverArgv: [],
		home,
		credentialsPath,
		now: () => clock,
		launch,
	};
	const start = { ...fixture.start, cwd: checkout };
	const checkpoint = {
		...fixture.checkpoint,
		cwd: checkout,
		...(client === "claude-code" ? { tool_input: { file_path: join(checkout, PATH) } } : {}),
	};
	return {
		home,
		checkout,
		fixture,
		connection,
		cohort,
		store,
		proof,
		options,
		start,
		checkpoint,
		launch,
		rootId: String(start.session_id),
		agentId: String(start.agent_id),
		advance(ms: number) {
			clock += ms;
		},
	};
}

type Context = Awaited<ReturnType<typeof context>>;
function interest(ctx: Context, rootId = ctx.rootId, agentId = ctx.agentId) {
	expect(ctx.store.registerFeedRoot({ cohort: ctx.cohort, rootId, checkout: ctx.checkout })).toBe(
		true,
	);
	expect(
		ctx.store.registerRecipient({
			cohort: ctx.cohort,
			rootId,
			agentId,
			checkout: ctx.checkout,
			interests: [PATH],
		}),
	).toBe(true);
}
function publish(ctx: Context, summary = PRIVATE_DELTA, rootId = ctx.rootId) {
	interest(ctx, rootId, SIBLING);
	expect(
		ctx.store.publishFinding({
			cohort: ctx.cohort,
			rootId,
			agentId: SIBLING,
			kind: "reported",
			summary,
			references: [PATH],
			provenance: { head: "1234567890abcdef", fingerprint: "fixture-fingerprint" },
		}),
	).not.toBeNull();
}

describe.each(profiles)("native $file context delivery", ({ client, file }) => {
	it("seeds a native child, delivers a later sibling update, and does not repeat it", async () => {
		const ctx = await context(client, file);
		const seed = deliver(ctx.start, ctx.options);
		expect(seed?.hookSpecificOutput.hookEventName).toBe("SubagentStart");
		expect(text(seed)).toContain(REPO);
		expect(text(seed).length).toBeLessThanOrEqual(1100);
		interest(ctx);
		publish(ctx);
		const update = deliver(ctx.checkpoint, ctx.options);
		expect(update?.hookSpecificOutput.hookEventName).toBe("PostToolUse");
		expect(text(update)).toContain(PRIVATE_DELTA);
		expect(text(update)).toContain(PATH);
		expect(text(update).length).toBeLessThanOrEqual(1100);
		expect(text(deliver(ctx.checkpoint, ctx.options))).not.toContain(PRIVATE_DELTA);
	});

	it("keeps another native root and root-only events out of child delivery", async () => {
		const ctx = await context(client, file);
		deliver(ctx.start, ctx.options);
		interest(ctx);
		publish(ctx);
		const otherRoot = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		interest(ctx, otherRoot);
		expect(text(deliver({ ...ctx.checkpoint, session_id: otherRoot }, ctx.options))).not.toContain(
			PRIVATE_DELTA,
		);
		expect(deliver({ ...ctx.checkpoint, agent_id: undefined }, ctx.options)).toBeNull();
		expect(text(deliver(ctx.checkpoint, ctx.options))).toContain(PRIVATE_DELTA);
	});

	it("suppresses an unknown negotiated profile and a saved opt-out", async () => {
		const ctx = await context(client, file);
		deliver(ctx.start, ctx.options);
		interest(ctx);
		publish(ctx);
		expect(ctx.store.recordFeedConnection({ ...ctx.connection, clientVersion: "999.0.0" })).toBe(
			true,
		);
		expect(deliver(ctx.checkpoint, ctx.options)).toBeNull();
		expect(ctx.store.recordFeedConnection(ctx.connection)).toBe(true);
		setNativeFeedEnabled(client, false, { home: ctx.home });
		expect(deliver(ctx.checkpoint, ctx.options)).toBeNull();
	});

	it("does not emit scoped data without current proof or after proof expiration", async () => {
		const ctx = await context(client, file, false);
		expect(text(deliver(ctx.start, ctx.options))).not.toContain(REPO);
		expect(ctx.store.putAccessProof({ cohort: ctx.cohort, proof: ctx.proof() })).toBe(true);
		deliver(ctx.start, ctx.options);
		interest(ctx);
		publish(ctx);
		ctx.advance(60_001);
		expect(ctx.store.recordFeedConnection(ctx.connection)).toBe(true);
		expect(text(deliver(ctx.checkpoint, ctx.options))).not.toContain(PRIVATE_DELTA);
	});

	it("supplies a cold-start seed at the first later authorized boundary", async () => {
		const ctx = await context(client, file, false);
		expect(deliver(ctx.start, ctx.options)).toBeNull();
		expect(ctx.store.putAccessProof({ cohort: ctx.cohort, proof: ctx.proof() })).toBe(true);
		expect(text(deliver(ctx.checkpoint, ctx.options))).toContain(REPO);
	});

	it("does not wake or schedule a completed worker from SubagentStop", async () => {
		const ctx = await context(client, file);
		expect(deliver({ ...ctx.start, hook_event_name: "SubagentStop" }, ctx.options)).toBeNull();
		expect(ctx.launch).not.toHaveBeenCalled();
	});
});

describe("observed native payload contracts", () => {
	it("keeps warmed compatibility and startup-inclusive delivery within their latency budgets", async () => {
		const ctx = await context("codex", "codex-0.166.0.json");
		deliver(ctx.start, ctx.options);
		interest(ctx);
		const lookup: number[] = [];
		for (let index = 0; index < 60; index++) {
			const started = performance.now();
			expect(
				resolveFeedProfile({
					...ctx.options,
					cohort: ctx.cohort,
					event: "PostToolUse",
					now: Date.now(),
				}).admit,
			).toBe(true);
			if (index >= 10) lookup.push(performance.now() - started);
		}
		const module = pathToFileURL(join(import.meta.dirname, "../runtime/native-feed-hook.mjs")).href;
		const driver = `import {readFileSync} from 'node:fs';import {runNativeFeedHook,confirmNativeFeedEmission} from ${JSON.stringify(module)};const {payload,options}=JSON.parse(readFileSync(0,'utf8'));const output=runNativeFeedHook(payload,{...options,launch:()=>{}});if(output){process.stdout.write(JSON.stringify(output));confirmNativeFeedEmission(output);}`;
		const delivery: number[] = [];
		for (let index = 0; index < 24; index++) {
			publish(ctx, `Contract update ${index}.`);
			const started = performance.now();
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
				input: JSON.stringify({ payload: ctx.checkpoint, options: ctx.options }),
				encoding: "utf8",
				timeout: 2_000,
			});
			const elapsed = performance.now() - started;
			expect(child.status, child.stderr).toBe(0);
			expect(child.stdout).toContain(`Contract update ${index}.`);
			if (index >= 4) delivery.push(elapsed);
		}
		const p95 = (values: number[]) =>
			values.sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1];
		expect(p95(lookup)).toBeLessThanOrEqual(2);
		expect(
			p95(delivery),
			`Startup-inclusive delivery samples (ms): ${delivery.map((value) => value.toFixed(3)).join(", ")}`,
		).toBeLessThanOrEqual(75);
	});
	it.each(profiles.slice(0, 2))("shares only through the matching $client child hook", async ({
		client,
		file,
	}) => {
		const ctx = await context(client, file);
		const seed = deliver(ctx.start, ctx.options);
		const recipientToken = /recipientToken=([a-f0-9-]{36})/.exec(text(seed))?.[1];
		if (!recipientToken) throw new Error("Missing native child capability");
		const credentials = readCredentials(ctx.options.credentialsPath);
		if (!credentials) throw new Error("Missing fixture credentials");
		const runtime = new NativeFeedRuntime({ ...ctx.options, cwd: ctx.checkout, credentials });
		try {
			runtime.start();
			runtime.connect(ctx.fixture.clientInfo);
			const report = {
				kind: "reported",
				summary: "Validator contract changed.",
				references: [PATH],
			};
			expect(runtime.share(report).isError).toBe(true);
			const pending = runtime.share({ ...report, recipientToken });
			expect(pending.isError).not.toBe(true);
			const reply = pending.content.find((block) => block.type === "text");
			if (!reply || reply.type !== "text") throw new Error("Missing share receipt");
			expect(JSON.parse(reply.text).state).toBe("awaiting_child_hook");
			deliver(
				{
					...ctx.checkpoint,
					tool_name: "mcp__pharaoh__pharaoh_share",
					tool_response: client === "claude-code" ? pending.content : pending,
				},
				ctx.options,
			);
			interest(ctx, ctx.rootId, SIBLING);
			const sibling = deliver({ ...ctx.checkpoint, agent_id: SIBLING }, ctx.options);
			expect(text(sibling)).toContain("Validator contract changed.");
		} finally {
			runtime.close();
		}
	});
	it("withholds a prior repository after its Git configuration is retargeted", async () => {
		const ctx = await context("codex", "codex-0.166.0.json");
		deliver(ctx.start, ctx.options);
		interest(ctx);
		publish(ctx);
		writeFileSync(
			join(ctx.checkout, ".git", "config"),
			'[remote "origin"]\nurl=https://github.com/other/repo.git\n',
		);
		expect(deliver(ctx.checkpoint, ctx.options)).toBeNull();
	});
	it("withholds prior-branch events before background maintenance catches up", async () => {
		const ctx = await context("codex", "codex-0.166.0.json");
		deliver(ctx.start, ctx.options);
		interest(ctx);
		publish(ctx);
		const signIn = readFeedSignInGeneration(ctx.options);
		if (!signIn) throw new Error("Missing fixture sign-in");
		expect(
			ctx.store.updateProducerState({ cohort: ctx.cohort, signIn, state: { branch: "main" } }),
		).toBe(true);
		writeFileSync(join(ctx.checkout, ".git", "HEAD"), "ref: refs/heads/feature\n");
		expect(deliver(ctx.checkpoint, ctx.options)).toBeNull();
		expect(ctx.store.readAccessProof({ cohort: ctx.cohort })).toBeNull();
	});
	it("budgets the actual seed and gap bytes for a long repository name", async () => {
		const ctx = await context("codex", "codex-0.166.0.json");
		const repo = `${"o".repeat(39)}/${"r".repeat(100)}`;
		expect(ctx.store.putAccessProof({ cohort: ctx.cohort, proof: { ...ctx.proof(), repo } })).toBe(
			true,
		);
		const seed = deliver(ctx.start, ctx.options);
		expect(text(seed)).toContain(repo);
		expect(Buffer.byteLength(text(seed))).toBeLessThanOrEqual(300);
		interest(ctx);
		publish(ctx);
		const update = deliver(ctx.checkpoint, ctx.options);
		expect(text(update)).toContain(PRIVATE_DELTA);
		expect(Buffer.byteLength(text(update))).toBeLessThanOrEqual(300);
	});
	it("records emission only after the native transport handoff is confirmed", async () => {
		const ctx = await context("codex", "codex-0.166.0.json");
		const output = runNativeFeedHook(ctx.start, ctx.options);
		expect(output).not.toBeNull();
		const file = join(feedRoot({ home: ctx.home }), "state", `${ctx.cohort}.json`);
		const before = JSON.parse(readFileSync(file, "utf8"));
		expect(
			before.recipients.find((entry: { agentId: string }) => entry.agentId === ctx.agentId)
				.emitted ?? 0,
		).toBe(0);
		if (output) confirmNativeFeedEmission(output);
		const after = JSON.parse(readFileSync(file, "utf8"));
		expect(
			after.recipients.find((entry: { agentId: string }) => entry.agentId === ctx.agentId).emitted,
		).toBe(1);
	});

	it("uses Codex's observed Bash payload without interpreting shell contents", async () => {
		const ctx = await context("codex", "codex-0.166.0.json");
		expect(ctx.fixture.checkpoint.tool_name).toBe("Bash");
		deliver(ctx.start, ctx.options);
		publish(ctx);
		expect(deliver(ctx.checkpoint, ctx.options)).toBeNull();
		expect(ctx.store.readObservations({ cohort: ctx.cohort })).toEqual([]);
		const structured = {
			...ctx.checkpoint,
			tool_name: "mcp__pharaoh__get_blast_radius",
			tool_input: { repo: REPO, entity_type: "file", entity: PATH },
		};
		expect(
			deliver(
				{ ...structured, tool_input: { ...structured.tool_input, repo: "another/repo" } },
				ctx.options,
			),
		).toBeNull();
		expect(
			deliver(
				{ ...structured, tool_input: { ...structured.tool_input, entity_type: "function" } },
				ctx.options,
			),
		).toBeNull();
		expect(
			text(
				deliver(
					{ ...structured, tool_input: { ...structured.tool_input, repo: "native-feed" } },
					ctx.options,
				),
			),
		).toContain(PRIVATE_DELTA);
	});

	it("uses a verified repo's exact file search to deliver the base feed without preview", async () => {
		const ctx = await context("codex", "codex-0.166.0.json");
		deliver(ctx.start, ctx.options);
		publish(ctx);
		const search = {
			...ctx.checkpoint,
			tool_name: "mcp__pharaoh__search_functions",
			tool_input: { repo: REPO, file: PATH, query: "fixture" },
		};
		expect(
			deliver(
				{ ...search, tool_input: { ...search.tool_input, repo: "another/repo" } },
				ctx.options,
			),
		).toBeNull();
		expect(text(deliver(search, ctx.options))).toContain(PRIVATE_DELTA);
	});

	it("uses structured Claude Read interest for late replay without storing returned file contents", async () => {
		const ctx = await context("claude-code", "claude-code-2.1.328.json");
		deliver(ctx.start, ctx.options);
		publish(ctx);
		const update = deliver(
			{ ...ctx.checkpoint, tool_response: { content: "DO_NOT_PERSIST_FILE_BODY" } },
			ctx.options,
		);
		expect(text(update)).toContain(PRIVATE_DELTA);
		const state = join(feedRoot({ home: ctx.home }), "state");
		const persisted = readdirSync(state)
			.filter((name) => name.endsWith(".json"))
			.map((name) => readFileSync(join(state, name), "utf8"))
			.join("");
		expect(persisted).not.toContain("DO_NOT_PERSIST_FILE_BODY");
	});

	it("requires the current client preview choice to emit a preview notice", async () => {
		const ctx = await context("claude-code", "claude-code-2.1.328.json");
		deliver(ctx.start, ctx.options);
		interest(ctx, ctx.rootId, SIBLING);
		const queue = (summary: string) =>
			ctx.store.publishFinding({
				cohort: ctx.cohort,
				rootId: ctx.rootId,
				agentId: SIBLING,
				previewOnly: true,
				kind: "fact",
				summary,
				references: [PATH],
			});
		expect(queue("First preview")).not.toBeNull();
		setNativeFeedPreviewEnabled("codex", true, { home: ctx.home });
		expect(deliver(ctx.checkpoint, ctx.options)).toBeNull();
		setNativeFeedPreviewEnabled("claude-code", true, { home: ctx.home });
		expect(text(deliver(ctx.checkpoint, ctx.options))).toContain("First preview");
		expect(queue("Second preview")).not.toBeNull();
		setNativeFeedPreviewEnabled("claude-code", false, { home: ctx.home });
		expect(deliver(ctx.checkpoint, ctx.options)).toBeNull();
	});

	it("renders one saved-change notice per packet and keeps the base fallback after opt-out", async () => {
		const ctx = await context("claude-code", "claude-code-2.1.328.json");
		deliver(ctx.start, ctx.options);
		interest(ctx, ctx.rootId, SIBLING);
		const queue = (dedupeKey: string, summary: string) => {
			const transition = {
				cohort: ctx.cohort,
				rootId: ctx.rootId,
				agentId: SIBLING,
				dedupeKey,
				references: [PATH],
			};
			expect(
				ctx.store.publishFinding({
					...transition,
					kind: "invalidation",
					summary: "Saved file changed.",
				}),
			).not.toBeNull();
			expect(
				ctx.store.publishFinding({ ...transition, kind: "fact", previewOnly: true, summary }),
			).not.toBeNull();
		};
		setNativeFeedPreviewEnabled("claude-code", true, { home: ctx.home });
		queue("a".repeat(64), "Saved exports added First (interface).");
		const preview = text(deliver(ctx.checkpoint, ctx.options));
		expect(preview).toContain("Saved exports added First (interface).");
		expect(preview).not.toContain("Saved file changed.");
		expect(deliver(ctx.checkpoint, ctx.options)).toBeNull();

		queue("b".repeat(64), "Saved exports added Second (interface).");
		setNativeFeedPreviewEnabled("claude-code", false, { home: ctx.home });
		const base = text(deliver(ctx.checkpoint, ctx.options));
		expect(base).toContain("Saved file changed.");
		expect(base).not.toContain("Saved exports added Second (interface).");
	});

	it("watches only a bound hosted module success and routes map facts to that preview child", async () => {
		const ctx = await context("codex", "codex-0.166.0.json");
		const scope = { cohort: ctx.cohort, rootId: ctx.rootId, agentId: ctx.agentId };
		const authorizationIdentity = ctx.store.currentAuthorizationIdentity(scope);
		if (!authorizationIdentity) throw new Error("Fixture feed access was unavailable");
		const current = { cohort: ctx.cohort, authorizationIdentity };
		const module = "auth";
		const marker = { version: 1, repo: REPO, module };
		const valid = {
			...ctx.checkpoint,
			tool_name: "mcp__pharaoh__get_module_context",
			tool_input: { repo: REPO, module },
			tool_response: { _meta: { "pharaoh/hosted-module-watch-v1": marker } },
		};
		deliver(ctx.start, ctx.options);
		deliver(valid, ctx.options);
		expect(ctx.store.readHostedModuleWatches(current)).toEqual([]);
		setNativeFeedPreviewEnabled("codex", true, { home: ctx.home });
		for (const event of [
			{ ...valid, tool_response: { content: [{ type: "text", text: JSON.stringify(marker) }] } },
			{ ...valid, tool_response: [{ type: "text", text: hostedModuleWatchText(REPO, module) }] },
			{ ...valid, tool_response: { ...valid.tool_response, isError: true } },
			{ ...valid, tool_input: { repo: "another/repo", module } },
			{ ...valid, tool_input: { repo: REPO, module: "another" } },
			{ ...valid, agent_id: undefined },
		])
			deliver(event, ctx.options);
		expect(ctx.store.readHostedModuleWatches(current)).toEqual([]);
		deliver(valid, ctx.options);
		expect(ctx.store.readHostedModuleWatches(current)).toEqual([module]);

		const publication = {
			commit: "a".repeat(40),
			signature: "a".repeat(16),
			generation: 7,
			time: "2026-11-19T00:00:00Z",
			modules: [{ module, edges: [] }],
		};
		expect(ctx.store.applyHostedModulePublication({ ...current, publication })).toBe(true);
		expect(text(deliver(ctx.checkpoint, ctx.options))).toBe("");
		expect(
			ctx.store.applyHostedModulePublication({
				...current,
				publication: {
					...publication,
					commit: "b".repeat(40),
					time: "2026-11-19T00:01:00Z",
					modules: [{ module, edges: [["auth", "db"]] }],
				},
			}),
		).toBe(true);
		expect(text(deliver({ ...ctx.checkpoint, agent_id: SIBLING }, ctx.options))).not.toContain(
			"Published default branch",
		);
		setNativeFeedPreviewEnabled("codex", false, { home: ctx.home });
		expect(text(deliver(ctx.checkpoint, ctx.options))).toBe("");
		setNativeFeedPreviewEnabled("codex", true, { home: ctx.home });
		expect(text(deliver(ctx.checkpoint, ctx.options))).toContain(
			"Published default branch g7: auth dependencies changed.",
		);
		expect(ctx.store.retireHostedModuleNotices(current)).toBe(true);
		expect(text(deliver(ctx.checkpoint, ctx.options))).toBe("");
	});

	it("admits only an exact standalone hosted success in Claude's content-array response", async () => {
		const ctx = await context("claude-code", "claude-code-2.1.328.json");
		const authorizationIdentity = ctx.store.currentAuthorizationIdentity({ cohort: ctx.cohort });
		if (!authorizationIdentity) throw new Error("Fixture feed access was unavailable");
		const watches = () =>
			ctx.store.readHostedModuleWatches({ cohort: ctx.cohort, authorizationIdentity });
		const body = { type: "text", text: "# Module: auth\n\nHosted result." };
		const receipt = {
			type: "text",
			text: '[pharaoh/hosted-module-watch-v1] {"version":1,"repo":"fixture/native-feed","module":"auth"}',
		};
		const hook = {
			...ctx.checkpoint,
			tool_name: "mcp__pharaoh__get_module_context",
			tool_input: { repo: REPO, module: "auth" },
			tool_response: [body, receipt],
		};
		deliver(ctx.start, ctx.options);
		deliver(hook, ctx.options);
		expect(watches()).toEqual([]);
		setNativeFeedPreviewEnabled("claude-code", true, { home: ctx.home });

		for (const tool_response of [
			[receipt],
			[{ ...body, text: `${body.text}\n${receipt.text}` }],
			[body, { ...receipt, text: `${receipt.text}\n` }],
			[body, { ...receipt, annotations: { audience: ["assistant"] } }],
			[body, { type: "text", text: hostedModuleWatchText("other/repo", "auth") }],
			[body, { type: "text", text: hostedModuleWatchText(REPO, "other") }],
			[body, receipt, receipt],
			[body, receipt, { ...receipt, text: "[pharaoh/hosted-module-watch-v0] {}" }],
			[{ ...body, isError: true }, receipt],
			{ content: [body, receipt] },
		])
			deliver({ ...hook, tool_response }, ctx.options);
		deliver({ ...hook, tool_input: { repo: "native-feed", module: "auth" } }, ctx.options);
		deliver({ ...hook, agent_id: undefined }, ctx.options);
		expect(watches()).toEqual([]);

		deliver(hook, ctx.options);
		expect(watches()).toEqual(["auth"]);
	});
});
