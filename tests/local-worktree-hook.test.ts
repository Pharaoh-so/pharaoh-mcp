/** Native scope needs a harmless attachment proof and an exact, later local call. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	conversationMemoryBinding,
	markSessionLocal,
	sessionLocalSensitivity,
} from "../project-memory/local.mjs";
import {
	consumeLocalWorktreeContext,
	consumeNativeMemoryCall,
	handleLocalWorktreeHook,
	type LocalRuntimeGeneration,
	localWorktreeBinding,
	localWorktreeClaimCurrent,
	localWorktreeShellReady,
	nativeMemoryCallCurrent,
	nativeMemoryRuntimeBinding,
	observeRuntimeGeneration,
	releaseRuntimeGeneration,
	runtimeConversationBinding,
	verifiedSessionRuntime,
	verifyRuntimeSession,
} from "../runtime/local-worktree-hook.mjs";
import type { CheckoutEvidence } from "../src/local/dispatch.js";

const START = Date.now();
const APPROVAL_MS = 30 * 60_000;
const checkout = {
	root: "/private/worktree",
	repoSlug: "example/work",
	worktreeId: "b".repeat(64),
	device: "1",
	inode: "1",
};
const launch = "/private/managed/dist/index.js";
const credentials = { refresh_token: "test-refresh", sse_url: "https://example.test/sse" };
const query = {
	repo: checkout.repoSlug,
	entity: "src/edited.ts:localOnly",
	entity_type: "function",
};
const turn = { session_id: "session-one", prompt_id: "prompt-one", cwd: checkout.root };
const tool = {
	hook_event_name: "PreToolUse",
	tool_name: "mcp__pharaoh__get_blast_radius",
	tool_use_id: "native-call-one",
	mcp_server: { name: "pharaoh", source: "user" },
};
const status = {
	...tool,
	tool_name: "mcp__pharaoh__pharaoh_local_worktree_status",
	tool_use_id: "native-scope-probe",
};
const memoryTool = {
	...tool,
	tool_name: "mcp__pharaoh__pharaoh_memory_recall",
	tool_use_id: "native-memory-call",
};
type HookOptions = Parameters<typeof handleLocalWorktreeHook>[1];

describe.skipIf(process.platform === "win32")("native local-worktree proof", () => {
	let home: string;
	let evidence: CheckoutEvidence;
	let generation: LocalRuntimeGeneration | undefined;
	const options = (now = START) => ({
		client: "claude-code" as const,
		binding: localWorktreeBinding("claude-code", launch, credentials),
		memoryRuntime: nativeMemoryRuntimeBinding("claude-code", launch),
		resolveCheckout: () => evidence,
		home,
		now,
	});
	const prompt = (identity = turn, now = START) =>
		handleLocalWorktreeHook({ ...identity, hook_event_name: "UserPromptSubmit" }, options(now))
			?.hookSpecificOutput.additionalContext ?? "";
	const getChallenge = (cue: string) => {
		const token = /challenge: "([A-Za-z0-9_-]{43})"/.exec(cue)?.[1];
		if (!token) throw new Error("Native prompt did not produce a readiness challenge.");
		return token;
	};
	const preTool = (args: Record<string, unknown>, now = START, identity = turn) =>
		handleLocalWorktreeHook({ ...identity, ...tool, tool_input: args }, options(now));
	function approveProbe(
		challenge: string,
		identity: { session_id: string; cwd: string },
		hookOptions: HookOptions,
	) {
		expect(
			handleLocalWorktreeHook({ ...identity, ...status, tool_input: { challenge } }, hookOptions),
		).toBeUndefined();
	}
	function attach(cue = prompt()) {
		const challenge = getChallenge(cue);
		approveProbe(challenge, turn, options());
		const ready = verifyRuntimeSession(generation, challenge, { now: START });
		if (!ready) throw new Error("Current connection did not attach to the native turn.");
		return ready;
	}

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pharaoh-local-proof-"));
		evidence = { kind: "checkout", checkout };
		const current = options();
		generation = observeRuntimeGeneration(current.client, current.binding, checkout, current);
	});
	afterEach(() => {
		releaseRuntimeGeneration(generation);
		rmSync(home, { recursive: true, force: true });
	});

	it("requires inactive and readable project memory state for a shell answer", () => {
		const root = join(home, "repo");
		const legacy = join(root, ".claude");
		mkdirSync(legacy, { recursive: true, mode: 0o755 });
		expect(localWorktreeShellReady(root, home)).toBe(true);
		writeFileSync(join(legacy, "settings.local.json"), "{}", { mode: 0o644 });
		expect(localWorktreeShellReady(root, home)).toBe(true);

		const memory = join(home, ".pharaoh", "project-memory-client");
		mkdirSync(memory, { recursive: true, mode: 0o700 });
		const preferences = join(memory, "hook-preferences-v1.json");
		const savePreferences = (clients: object) =>
			writeFileSync(preferences, JSON.stringify({ version: 1, clients }), { mode: 0o600 });
		savePreferences({ codex: { diagnostics: true } });
		expect(localWorktreeShellReady(root, home)).toBe(false);
		savePreferences({ codex: { memory: false, diagnostics: false } });
		expect(localWorktreeShellReady(root, home)).toBe(true);

		const activation = join(memory, "active.json");
		writeFileSync(activation, JSON.stringify({ codex: "a".repeat(64) }), { mode: 0o600 });
		expect(localWorktreeShellReady(root, home)).toBe(false);
		rmSync(activation);
		writeFileSync(preferences, "{invalid");
		expect(localWorktreeShellReady(root, home)).toBe(false);
		rmSync(preferences);

		const marker = createHash("sha256").update(`claude-code\0${root}`).digest("hex");
		const command = `node pharaoh-memory-hook.mjs # pharaoh-project-memory:${marker}`;
		writeFileSync(
			join(legacy, "settings.local.json"),
			JSON.stringify({
				hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] },
			}),
			{ mode: 0o600 },
		);
		expect(localWorktreeShellReady(root, home)).toBe(false);
	});

	it.each(["claude-code", "codex"] as const)(
		"accepts ordinary %s checkout settings and refuses a linked legacy file",
		(client) => {
			const root = join(home, "repo");
			const codex = client === "codex";
			const directory = join(root, codex ? ".codex" : ".claude");
			const settings = join(directory, codex ? "hooks.json" : "settings.local.json");
			const native = { ...options(), client };
			evidence = { kind: "checkout", checkout: { ...checkout, root } };
			mkdirSync(directory, { recursive: true, mode: 0o755 });
			const submit = () =>
				handleLocalWorktreeHook(
					{ ...turn, turn_id: "native-turn", cwd: root, hook_event_name: "UserPromptSubmit" },
					native,
				)?.hookSpecificOutput.additionalContext;
			expect(submit()).toContain("pharaoh_local_worktree_status");
			writeFileSync(settings, "{}", { mode: 0o644 });
			expect(submit()).toContain("pharaoh_local_worktree_status");
			rmSync(settings);
			const other = join(home, "settings.json");
			writeFileSync(other, "{}", { mode: 0o600 });
			symlinkSync(other, settings);
			expect(submit()).toContain("Saved worktree scope is unavailable");
		},
	);

	it("grants scope only after the native probe reaches an initialized connection", () => {
		const cue = prompt();
		expect(cue).not.toContain(checkout.root);
		expect(cue).not.toContain(query.entity);
		expect(cue).not.toContain("local_context");
		const challenge = getChallenge(cue);
		expect(verifyRuntimeSession(generation, challenge, { now: START })).toBeUndefined();
		const ready = attach(cue);
		expect(runtimeConversationBinding(generation)).toEqual(ready.memoryBinding);
		expect(sessionLocalSensitivity(ready.memoryBinding, { home })).toBe("clear");
		expect(verifyRuntimeSession(generation, challenge, { now: START })).toBeUndefined();
		expect(verifiedSessionRuntime(generation, START)).toBe(true);
	});

	it.each([
		"claude-code",
		"codex",
	] as const)("proves ordinary %s memory before readiness without altering arguments or permissions", (client) => {
		const unsigned = {
			...options(),
			client,
			binding: undefined,
			memoryRuntime: nativeMemoryRuntimeBinding(client, launch),
		};
		const identity = { ...turn, turn_id: "turn-one" };
		handleLocalWorktreeHook({ ...identity, hook_event_name: "UserPromptSubmit" }, unsigned);
		const connection = observeRuntimeGeneration(unsigned.client, undefined, checkout, unsigned);
		const args = {
			repo: checkout.repoSlug,
			terms: ["stable"],
			diagnostics: { taskSummary: "look up a decision" },
		};
		const request = {
			...identity,
			...memoryTool,
			mcp_server: client === "claude-code" ? memoryTool.mcp_server : undefined,
			tool_input: args,
		};
		expect(
			consumeNativeMemoryCall(connection, "pharaoh_memory_recall", args, { now: START }),
		).toBeUndefined();
		expect(handleLocalWorktreeHook(request, unsigned)).toBeUndefined();
		expect(
			consumeNativeMemoryCall(
				connection,
				"pharaoh_memory_recall",
				{ ...args, terms: ["other"] },
				{ now: START },
			),
		).toBeUndefined();
		const reordered = { diagnostics: args.diagnostics, terms: args.terms, repo: args.repo };
		const proof = consumeNativeMemoryCall(connection, "pharaoh_memory_recall", reordered, {
			now: START,
		});
		expect(nativeMemoryCallCurrent(proof, { now: START })).toBe(true);
		expect(runtimeConversationBinding(connection)).toBeUndefined();
		expect(
			consumeNativeMemoryCall(connection, "pharaoh_memory_recall", args, { now: START }),
		).toBeUndefined();
		expect(handleLocalWorktreeHook(request, unsigned)?.hookSpecificOutput.permissionDecision).toBe(
			"deny",
		);
		handleLocalWorktreeHook({ ...identity, hook_event_name: "Stop" }, unsigned);
		expect(nativeMemoryCallCurrent(proof, { now: START })).toBe(false);
		releaseRuntimeGeneration(connection);
	});

	it("rejects ambiguous concurrent memory proofs and prevents tainted arguments at older proxies", () => {
		const args = { repo: checkout.repoSlug, terms: ["same exact request"] };
		const sibling = { ...turn, session_id: "concurrent-memory" };
		for (const identity of [turn, sibling]) {
			prompt(identity);
			expect(
				handleLocalWorktreeHook({ ...identity, ...memoryTool, tool_input: args }, options()),
			).toBeUndefined();
		}
		expect(
			consumeNativeMemoryCall(generation, "pharaoh_memory_recall", args, { now: START }),
		).toBeUndefined();
		handleLocalWorktreeHook({ ...sibling, hook_event_name: "SessionEnd" }, options());
		const proof = consumeNativeMemoryCall(generation, "pharaoh_memory_recall", args, {
			now: START,
		});
		expect(nativeMemoryCallCurrent(proof, { now: START })).toBe(true);
		const binding = conversationMemoryBinding("claude-code", turn.session_id);
		expect(markSessionLocal(binding, { home })).toBe(true);
		expect(nativeMemoryCallCurrent(proof, { now: START })).toBe(false);
		const older = { ...options(), binding: undefined, memoryRuntime: undefined };
		expect(
			handleLocalWorktreeHook({ ...turn, ...memoryTool, tool_input: args }, older)
				?.hookSpecificOutput.permissionDecision,
		).toBe("deny");
		expect(
			handleLocalWorktreeHook(
				{ ...turn, ...memoryTool, session_id: undefined, tool_input: args },
				older,
			)?.hookSpecificOutput.permissionDecision,
		).toBe("deny");
	});

	it("accepts one exact call after an ordinary delayed native approval", () => {
		const { token, memoryBinding } = attach();
		const args = { ...query, local_context: token };
		expect(consumeLocalWorktreeContext(token, args, { ...options(), generation })).toBeUndefined();
		expect(preTool(args, START + 500)).toBeUndefined();
		expect(sessionLocalSensitivity(memoryBinding, { home })).toBe("local");
		const delayed = { ...options(START + APPROVAL_MS), generation };
		expect(consumeLocalWorktreeContext(token, { ...args, depth: 1 }, delayed)).toBeUndefined();
		expect(
			consumeLocalWorktreeContext(token, args, { ...delayed, binding: "a".repeat(64) }),
		).toBeUndefined();
		const claimed = consumeLocalWorktreeContext(token, args, delayed);
		expect(claimed).toEqual(checkout);
		expect(consumeLocalWorktreeContext(token, args, delayed)).toBeUndefined();
		if (!claimed) throw new Error("Native claim was unavailable.");
		expect(localWorktreeClaimCurrent(claimed, delayed.now)).toBe(true);
		const memory = join(home, ".pharaoh", "project-memory-client");
		mkdirSync(memory, { mode: 0o700 });
		const preferences = join(memory, "hook-preferences-v1.json");
		writeFileSync(
			preferences,
			JSON.stringify({ version: 1, clients: { "claude-code": { diagnostics: true } } }),
			{ mode: 0o600 },
		);
		expect(localWorktreeClaimCurrent(claimed, delayed.now)).toBe(false);
		rmSync(preferences);
		expect(localWorktreeClaimCurrent(claimed, delayed.now)).toBe(true);
		handleLocalWorktreeHook({ ...turn, hook_event_name: "Stop" }, delayed);
		expect(localWorktreeClaimCurrent(claimed, delayed.now)).toBe(false);
	});

	it("denies a copied proof in another session and revokes pending approval on a new prompt", () => {
		const { token } = attach();
		const args = { ...query, local_context: token };
		expect(
			preTool(args, START + 1, { ...turn, session_id: "session-two" })?.hookSpecificOutput
				.permissionDecision,
		).toBe("deny");
		expect(preTool(args, START + 2)).toBeUndefined();
		prompt({ ...turn, prompt_id: "prompt-two" }, START + 3);
		expect(
			consumeLocalWorktreeContext(token, args, { ...options(START + 4), generation }),
		).toBeUndefined();
	});

	it("preserves hosted blast and recon, and denies an unproved or shadowed local tool", () => {
		const { token } = attach();
		expect(preTool({ ...query, scope: "hosted" })).toBeUndefined();
		expect(preTool(query)).toBeUndefined();
		expect(preTool({ ...query, repo: "other/work" })).toBeUndefined();
		expect(preTool({ ...query, scope: "local" })?.hookSpecificOutput.permissionDecision).toBe(
			"deny",
		);
		expect(
			handleLocalWorktreeHook(
				{
					...turn,
					...tool,
					tool_name: "mcp__pharaoh__pharaoh_recon",
					tool_input: { repo: checkout.repoSlug, blast_radius: [{ entity: "stable" }] },
				},
				options(),
			),
		).toBeUndefined();
		expect(
			handleLocalWorktreeHook(
				{
					...turn,
					...tool,
					mcp_server: { name: "pharaoh", source: "project" },
					tool_input: { ...query, local_context: token },
				},
				options(),
			)?.hookSpecificOutput.permissionDecision,
		).toBe("deny");
	});

	it("keeps Codex transport proofs in simultaneous sibling worktrees separate", () => {
		const sibling = { ...checkout, root: "/private/sibling", worktreeId: "d".repeat(64) };
		const codex = {
			...options(),
			client: "codex" as const,
			binding: localWorktreeBinding("codex", launch, credentials),
			resolveCheckout: (cwd: string): CheckoutEvidence => ({
				kind: "checkout",
				checkout: cwd === sibling.root ? sibling : checkout,
			}),
		};
		const sessions = [
			{ session_id: "codex-one", turn_id: "turn-one", cwd: checkout.root },
			{ session_id: "codex-two", turn_id: "turn-two", cwd: sibling.root },
		];
		const connections = [checkout, sibling].map((root) =>
			observeRuntimeGeneration(codex.client, codex.binding, root, codex),
		);
		const challenges = sessions.map((session) => {
			const cue =
				handleLocalWorktreeHook({ ...session, hook_event_name: "UserPromptSubmit" }, codex)
					?.hookSpecificOutput.additionalContext ?? "";
			const challenge = getChallenge(cue);
			approveProbe(challenge, session, codex);
			return challenge;
		});
		expect(verifyRuntimeSession(connections[0], challenges[1], { now: START })).toBeUndefined();
		const args = challenges.map((challenge, index) => {
			const ready = verifyRuntimeSession(connections[index], challenge, { now: START });
			if (!ready) throw new Error("Codex connection did not attach to its own worktree.");
			const args = { ...query, local_context: ready.token };
			expect(
				handleLocalWorktreeHook({ ...sessions[index], ...tool, tool_input: args }, codex),
			).toBeUndefined();
			return args;
		});
		expect(
			consumeLocalWorktreeContext(args[1].local_context, args[1], {
				...codex,
				generation: connections[0],
			}),
		).toBeUndefined();
		for (const [index, root] of [checkout, sibling].entries()) {
			expect(
				consumeLocalWorktreeContext(args[index].local_context, args[index], {
					...codex,
					generation: connections[index],
				}),
			).toEqual(root);
			releaseRuntimeGeneration(connections[index]);
		}
	});

	it("keeps conversation provenance after disconnection and refuses stale local proof", () => {
		const { token, memoryBinding } = attach();
		const args = { ...query, local_context: token };
		expect(preTool(args)).toBeUndefined();
		releaseRuntimeGeneration(generation);
		expect(verifiedSessionRuntime(generation, START)).toBe(false);
		expect(runtimeConversationBinding(generation)).toEqual(memoryBinding);
		expect(consumeLocalWorktreeContext(token, args, { ...options(), generation })).toBeUndefined();
	});

	it("refreshes a connection's sign-in binding only through a new native proof", () => {
		const prior = attach();
		const identity = { ...turn, prompt_id: "new-prompt" };
		const rotated = { ...options(), binding: "e".repeat(64) };
		const cue = handleLocalWorktreeHook(
			{ ...identity, hook_event_name: "UserPromptSubmit" },
			rotated,
		)?.hookSpecificOutput.additionalContext;
		const challenge = getChallenge(cue ?? "");
		approveProbe(challenge, identity, rotated);
		expect(verifyRuntimeSession(generation, challenge, { now: START })).toBeUndefined();
		const ready = verifyRuntimeSession(generation, challenge, {
			now: START,
			binding: rotated.binding,
		});
		expect(ready?.memoryBinding).toEqual(prior.memoryBinding);
		expect(ready?.token).not.toEqual(prior.token);
	});

	it("refuses approval after expiry or a worktree identity change", () => {
		const { token } = attach();
		const args = { ...query, local_context: token };
		expect(preTool(args)).toBeUndefined();
		expect(
			consumeLocalWorktreeContext(token, args, { ...options(START + APPROVAL_MS + 1), generation }),
		).toBeUndefined();
		evidence = { kind: "checkout", checkout: { ...checkout, worktreeId: "c".repeat(64) } };
		expect(
			consumeLocalWorktreeContext(token, args, { ...options(START + 1000), generation }),
		).toBeUndefined();
	});
});
