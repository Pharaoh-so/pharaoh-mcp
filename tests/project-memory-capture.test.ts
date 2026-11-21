/**
 * Automatic capture (project-memory/capture.mjs): a turn saves only when it edited code
 * and a check then passed; the agent is asked once; the procedure comes from observed
 * events only. VISION.md § Memory saves what a turn proved, without asking.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	beginTurn,
	captureDirectory,
	checkCommand,
	deferCaptureForReview,
	recordToolEvent,
	sendCapture,
	stopDecision,
	undoLastCapture,
} from "../project-memory/capture.mjs";
import { setMemoryCapture } from "../project-memory/preferences.mjs";

const repo = "Pharaoh-so/fixture";
const memorySession = "8b24e18d-4541-4da3-941e-ce145b7cb53e";
const credentials = {
	access_token: "fixture",
	expires_at: "2099-01-01T00:00:00Z",
	project_memory_session: memorySession,
};
let home: string;
let root: string;
let directory: string;
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
const commit = (...args: string[]) =>
	git("-c", "user.email=f@x", "-c", "user.name=f", "commit", "-q", ...args, "-m", "fixture");

function context(client: "claude-code" | "codex", session: string, turn: string, ref = "a") {
	return {
		input: {
			session_id: session,
			cwd: root,
			[client === "codex" ? "turn_id" : "prompt_id"]: turn,
		},
		options: {
			client,
			target: { root, repo },
			directory,
			memorySession,
			binding: { client, sessionRef: ref.repeat(64) },
		},
	};
}

beforeEach(() => {
	home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pharaoh-capture-")));
	root = join(home, "repo");
	fs.mkdirSync(join(root, "src"), { recursive: true });
	fs.writeFileSync(join(root, "src/math.js"), "export const median = () => 0;\n");
	git("init", "-q");
	commit("--allow-empty");
	directory = captureDirectory(join(home, ".pharaoh", "project-memory-client"));
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run(client: "claude-code" | "codex", events: Record<string, unknown>[], launch = vi.fn()) {
	const { input: identity, options } = context(
		client,
		`session-${client}`,
		client === "codex" ? "turn-1" : "prompt-1",
	);
	const outputs = events.map((event) => {
		const input = { ...identity, ...event };
		if (event.hook_event_name !== "Stop") return recordToolEvent(input, options);
		return stopDecision(input, { ...options, launch });
	});
	return { outputs, launch };
}

const bash = (command: string, extra = {}) => ({
	hook_event_name: "PostToolUse",
	tool_name: "Bash",
	tool_input: { command },
	tool_response: { stdout: "", stderr: "", interrupted: false },
	...extra,
});
const edit = (path: string) => ({
	hook_event_name: "PostToolUse",
	tool_name: "Edit",
	tool_input: { file_path: join(root, path) },
	tool_response: { filePath: join(root, path) },
});
const stop = (message?: string) => ({
	hook_event_name: "Stop",
	stop_hook_active: message !== undefined,
	last_assistant_message: message,
});
const note =
	"Fixed it.\n\nPharaoh memory: Sort numbers with a comparator in median.\nWhy: Default sort compares text, so 10 sorted before 9.";

it.each([
	["npm test", "", { command: "npm test", piped: false }],
	[
		"node node_modules/vitest/vitest.mjs run tests/check.test.ts",
		"",
		{ command: "node node_modules/vitest/vitest.mjs run tests/check.test.ts", piped: false },
	],
	["node scripts/arbitrary.mjs", "", undefined],
	["npm test 2>&1 | tail -30", "", { command: "npm test", piped: true }],
	[
		'npm test 2>&1 | grep -E "^# (pass|fail)"',
		"",
		{ command: "npm test", piped: true, narrowed: true },
	],
	["npm test | head -20", "", { command: "npm test", piped: true, narrowed: true }],
	["npm ci && npm test", "", { command: "npm test", piped: false }],
	// A procedure leaves the machine: no inline environment, no credential-shaped text.
	[
		"CI=1 GITHUB_TOKEN=ghp_Zx81kLm2Qp9vRt7Yw3Nb npm test",
		"",
		{ command: "npm test", piped: false },
	],
	["npm test -- --password=hunter2hunter2", "", undefined],
	["pytest --key 9f8e7d6c5b4a39281706f5e4d3c2b1a0", "", undefined],
	["npm test -- --reporter=sk-proj-abcdefghijklmnopqrstu", "", undefined],
	["npm test && npm run lint", "", { command: "npm run lint", piped: false }],
	["npm test | grep -v fail", "", undefined],
	[
		"cd packages/api && pnpm test -- --run",
		"",
		{ command: "cd packages/api && pnpm test -- --run", piped: false },
	],
	["npm test && git diff --check", "", { command: "npm test", piped: false }],
	["pytest -q", "server", { command: "cd server && pytest -q", piped: false }],
	["npm test || true", "", undefined],
	["npm test; echo done", "", undefined],
	["cd /tmp/x && npm test", "", undefined],
	["pnpm vitest run --token=$TOKEN", "", undefined],
	["git status", "", undefined],
])("keeps only a provable check from %j", (command, prefix, expected) => {
	expect(checkCommand(command, prefix)).toEqual(expected);
});

it("asks once when a check proves the edit, then saves the note and the observed procedure, with an undo", async () => {
	const { outputs, launch } = run("claude-code", [
		{ ...bash("npm test"), hook_event_name: "PostToolUseFailure", error: "Exit code 1" },
		edit("src/math.js"),
		bash("npm test"),
		bash("npm test"),
		{ ...stop(note), stop_hook_active: false },
		stop(note),
	]);
	// The ask rides on the proving check; the final reply carries the note, so Stop never blocks.
	expect(outputs[2]).toContain("changed src/math.js and `npm test` then passed");
	expect(outputs[3]).toBeUndefined();
	expect((outputs[4] as { systemMessage?: string })?.systemMessage).toContain(
		"Undo: npx @pharaoh-so/mcp --undo-memory",
	);
	expect(outputs[5]).toBeUndefined();
	expect(launch).toHaveBeenCalledTimes(1);

	// A throttled send keeps the save for a later Stop, with the same operation IDs.
	const pending = launch.mock.calls[0][0];
	const throttled = vi.fn(async (_operation: string, _payload: { operationId?: string }) => {
		throw Object.assign(new Error("rate limited"), { rejected: true, status: 429 });
	});
	await sendCapture(pending, { request: throttled, credentials });
	const retry = vi.fn();
	run("claude-code", [stop(note)], retry);
	expect(retry).not.toHaveBeenCalled();
	const request = vi.fn(async (operation: string, payload: { operationId?: string }) =>
		operation === "capture"
			? { record: { id: payload.operationId, status: "candidate", version: 1 } }
			: { forgotten: true },
	);
	await sendCapture(pending, { request, credentials, now: Date.now() + 31_000 });
	expect(fs.existsSync(pending)).toBe(false);
	const saved = request.mock.calls.map(([, payload]) => payload);
	expect(saved[0].operationId).toBe(throttled.mock.calls[0]?.[1].operationId);
	expect(saved).toMatchObject([
		{
			repo,
			client: "claude-code",
			kind: "lesson",
			summary: "Sort numbers with a comparator in median.",
			detail: "Default sort compares text, so 10 sorted before 9.",
			verification: expect.stringContaining("`npm test` exited 0 after the change"),
			refs: [expect.objectContaining({ path: "src/math.js" })],
			gitRev: expect.stringMatching(/^[a-f0-9]{40}$/),
		},
		{ kind: "observation", summary: "To check a change to math.js, run `npm test`." },
	]);
	// A record already gone (a shared procedure undone earlier) doesn't stop the rest.
	request.mockRejectedValueOnce(Object.assign(new Error("gone"), { rejected: true }));
	// Rate limited: the receipt stays, so the undo can run again.
	const limited = vi.fn(async () => {
		throw Object.assign(new Error("rate limited"), { rejected: true, status: 429 });
	});
	await expect(undoLastCapture({ request: limited, home })).rejects.toThrow("rate limited");
	expect(await undoLastCapture({ request, home })).toEqual({ undone: 1, repo });
	expect(request).toHaveBeenLastCalledWith(
		"forget",
		{ repo, id: saved[1].operationId, version: 1 },
		{ binding: null, home, helper: undefined },
	);
	expect(await undoLastCapture({ request, home })).toEqual({ undone: 0, repo: undefined });
});

it("saves nothing without proof: read-only, unproven, stale or declined turns", () => {
	const passing = { tool_response: "TAP version 13\n# pass 3\n# fail 0\n" };
	// Codex hooks report no exit status: only the runner's own summary proves a pass.
	const codex = (events: Record<string, unknown>[]) => run("codex", events).outputs.at(-1);
	expect(codex([bash("npm test", passing), stop()])).toBeUndefined();
	const patch = {
		hook_event_name: "PostToolUse",
		tool_name: "apply_patch",
		tool_input: { command: "*** Begin Patch\n*** Update File: src/math.js\n@@\n*** End Patch" },
		tool_response: "Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM src/math.js\n",
	};
	expect(codex([patch, bash("npm test", { tool_response: "done" }), stop()])).toBeUndefined();
	expect(codex([patch, bash("npm test", passing), stop()])).toMatchObject({ decision: "block" });
	const claude = (events: Record<string, unknown>[]) => run("claude-code", events);
	const turnOf = (id: string, events: Record<string, unknown>[]) =>
		claude(events.map((event) => ({ ...event, prompt_id: id }))).outputs.at(-1);
	expect(claude([bash("npm test"), edit("src/math.js"), stop()]).outputs.at(-1)).toBeUndefined();
	expect(claude([edit("README.md"), bash("npm test"), stop()]).outputs.at(-1)).toBeUndefined();
	// Behind grep or head, only a visible zero-failure total proves a pass.
	const grepped = (stdout: string) =>
		bash('npm test 2>&1 | grep -E "^# (pass|fail)"', { tool_response: { stdout } });
	expect(turnOf("g1", [edit("src/math.js"), grepped("# pass 3"), stop()])).toBeUndefined();
	expect(turnOf("g2", [edit("src/math.js"), grepped("# pass 3\n# fail 0"), stop()])).toMatchObject({
		decision: "block",
	});
	const piped = bash("npm test 2>&1 | tail -5", {
		tool_response: { stdout: "Tests  2 failed | 1 passed" },
	});
	expect(claude([edit("src/math.js"), piped, stop()]).outputs.at(-1)).toBeUndefined();
	const declined = claude([
		edit("src/math.js"),
		bash("npm test"),
		stop(),
		stop("Pharaoh memory: none"),
	]);
	expect(declined.outputs[2]).toMatchObject({ decision: "block" });
	expect(declined.outputs[3]).toBeUndefined();
	expect(declined.launch).not.toHaveBeenCalled();
	// A background command reports before it finishes; a pasted code line hides in a Why paragraph.
	const turn = (id: string, events: Record<string, unknown>[]) =>
		claude(events.map((event) => ({ ...event, prompt_id: id })));
	const background = bash("npm test", {
		tool_input: { command: "npm test", run_in_background: true },
	});
	expect(turn("p2", [edit("src/math.js"), background, stop()]).outputs.at(-1)).toBeUndefined();
	const pasted =
		"Pharaoh memory: Fixed median.\nWhy: The sort was wrong:\nconst sorted = values.sort();";
	const hidden = turn("p3", [edit("src/math.js"), bash("npm test"), stop(pasted)]);
	expect(hidden.outputs.at(-1)).toBeUndefined();
	expect(hidden.launch).not.toHaveBeenCalled();
});

it("undoes only the newest save, and turning capture off drops what was not sent", async () => {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const write = (name: string, data: object) =>
		fs.writeFileSync(join(directory, name), JSON.stringify(data), { mode: 0o600 });
	const pending = `pending-${memorySession}.json`;
	write("last.json", { repo, records: [{ id: memorySession, version: 1 }], at: 1 });
	write(pending, { repo, createdAt: 2, records: [{ operationId: "a" }], done: [] });
	const request = vi.fn();
	expect(await undoLastCapture({ request, home })).toEqual({ undone: 1, repo });
	expect(request).not.toHaveBeenCalled();
	expect(fs.existsSync(join(directory, "last.json"))).toBe(true);
	write(pending, { repo, createdAt: 3, records: [], done: [] });
	setMemoryCapture(false, home);
	expect([
		fs.existsSync(join(directory, pending)),
		fs.existsSync(join(directory, "last.json")),
	]).toEqual([false, true]);
});

it("sees an edit made without an edit tool, and voids the proof when one follows the check", () => {
	const { input, options } = context("codex", "session-shell", "turn-shell", "b");
	const t0 = Date.now() - 60_000;
	const touch = (at: number) => {
		fs.writeFileSync(join(root, "src/math.js"), `export const median = () => ${at};\n`);
		fs.utimesSync(join(root, "src/math.js"), at / 1000, at / 1000);
	};
	// Tracked, so git reports it as " M src/math.js": the leading space must survive.
	git("add", "-A");
	commit();
	beginTurn({ ...input, hook_event_name: "UserPromptSubmit" }, { ...options, now: t0 });
	touch(t0 + 1_000); // python3 fix.py: no edit hook fires
	const check = {
		...input,
		hook_event_name: "PostToolUse",
		tool_name: "Bash",
		tool_input: { command: "npm test" },
		tool_response: "# pass 2\n# fail 0\n",
	};
	expect(recordToolEvent(check, { ...options, now: t0 + 2_000 })).toContain("changed src/math.js");
	touch(t0 + 3_000);
	const stop = { ...input, hook_event_name: "Stop", last_assistant_message: note };
	expect(stopDecision(stop, { ...options, now: t0 + 4_000, launch: vi.fn() })).toBeUndefined();
});

it("defers memory to the review continuation and consumes fresh verifier evidence without a second block", () => {
	const { input, options } = context("claude-code", "review-capture", "turn-review");
	beginTurn({ ...input, hook_event_name: "UserPromptSubmit" }, options);
	expect(deferCaptureForReview(input, options)).toContain("After review and all tools finish");
	// Review may end inconclusively: even a client omitting stop_hook_active cannot request a second continuation.
	expect(
		stopDecision(
			{ ...input, hook_event_name: "Stop", last_assistant_message: "No finding." },
			options,
		)?.decision,
	).toBeUndefined();
	const launch = vi.fn();
	const saved = stopDecision(
		{ ...input, hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: note },
		{
			...options,
			launch,
			verifiedCheck: {
				paths: ["src/math.js"],
				check: "vitest run tests/math.test.ts",
				evidence: "1 behavioral test passed",
			},
		},
	);
	expect(saved?.systemMessage).toContain("Pharaoh is saving");
	expect(saved?.decision).toBeUndefined();
	expect(launch).toHaveBeenCalledTimes(1);
});

it("never repeats an earlier memory cue and still observes review edits and checks", () => {
	const { input, options } = context("claude-code", "review-after-cue", "same-turn");
	beginTurn({ ...input, hook_event_name: "UserPromptSubmit" }, options);
	recordToolEvent({ ...input, ...edit("src/math.js") }, options);
	expect(recordToolEvent({ ...input, ...bash("npm test") }, options)).toContain("Pharaoh memory:");
	expect(deferCaptureForReview(input, options)).toBeUndefined();
	recordToolEvent({ ...input, ...edit("src/math.js") }, options);
	const launch = vi.fn();
	fs.writeFileSync(join(root, "src/worker.js"), "export const worker = () => true;\n");
	recordToolEvent({ ...input, ...edit("src/worker.js") }, options);
	recordToolEvent(
		{ ...input, ...bash("npm run lint"), hook_event_name: "PostToolUseFailure" },
		options,
	);
	// The prior cue controls prompting only; this new check must still be recorded.
	expect(recordToolEvent({ ...input, ...bash("npm run lint") }, options)).toBeUndefined();
	expect(
		stopDecision({ ...input, ...stop(note) }, { ...options, launch })?.systemMessage,
	).toContain("Pharaoh is saving");
	expect(launch).toHaveBeenCalledTimes(1);
	const saved = JSON.parse(fs.readFileSync(launch.mock.calls[0][0], "utf8"));
	expect(JSON.stringify(saved.records)).toContain("npm run lint");
	expect(JSON.stringify(saved.records)).toContain("src/worker.js");
});
