/** One real checkout exercises native review state and actual Vitest differential proofs. */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as review from "../project-memory/change-review.mjs";
import { runChangeReview } from "../project-memory/change-review-proof.mjs";
import { setChangeReview } from "../project-memory/preferences.mjs";

vi.setConfig({ testTimeout: 60000 });
let home: string, root: string, runId: string;
let options: Parameters<typeof review.beginReviewTurn>[1];
let input: Record<string, unknown>;
const source = "src/total.js",
	testFile = "tests/discount.test.ts",
	regression = "tests/existing.test.ts";
const name = "discount retains ten percent";
const good = "export function total(price) { return price * .9; }\n";
const content = (...texts: string[]) => texts.map((text) => ({ type: "text", text }));
const graphAnswer = "# Blast Radius: total\nCaller: src/checkout.js";
const warning =
	"Pharaoh: automatic memory-hook repair was skipped because this session has no matching managed activation.";
const testProgram = (title: string, assertion: string, skip = false) =>
	`import { expect, it } from "vitest"; import { total } from "../src/total.js"; it${skip ? ".skip" : ""}(${JSON.stringify(title)}, () => { ${assertion} });\n`;
const test = testProgram(name, "expect(total(100)).toBe(90)");
const conditional = (suite: string) => suite.replace("it(", "if (total(100) === 99) it(");
const beforeArgs = Object.entries({
	test: testFile,
	name,
	finding: "incorrect discount",
	repair: source,
	regression,
}).flatMap(([key, value]) => [`--${key}`, value]);
const put = (path: string, text: string) => fs.writeFileSync(join(root, path), text);
const json = (path: string, value?: unknown) =>
	value === undefined
		? JSON.parse(fs.readFileSync(path, "utf8"))
		: fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
const event = (extra = {}) => ({ ...input, cwd: root, ...extra });
const stop = (extra = {}) =>
	review.reviewStop(event({ hook_event_name: "Stop", ...extra }), options);
const run = () => review.readReviewRun(options.directory, runId);
const args = (operation: string, extra: string[] = []) => [
	operation,
	runId,
	"--directory",
	options.directory,
	...extra,
];
const command = (operation: string, extra: string[] = [], cwd = root) =>
	runChangeReview(args(operation, extra), { cwd });
const commit = () => {
	git("add", ".");
	git("-c", "user.email=f@x", "-c", "user.name=f", "commit", "-qm", "fixture");
};
const proofScript = fileURLToPath(
	new URL("../project-memory/change-review-proof.mjs", import.meta.url),
);
// Use the installed copy in both the pnpm workspace and the standalone npm export.
const vitestDependencies = dirname(
	dirname(fs.realpathSync(createRequire(import.meta.url).resolve("vitest/package.json"))),
);
function graph(parts = [graphAnswer], tool = "get_blast_radius", extra = {}) {
	review.observeReviewTool(
		event({
			hook_event_name: "PostToolUse",
			tool_name: `mcp__pharaoh__${tool}`,
			tool_input: { repo: "owner/repo" },
			mcp_server: { name: "pharaoh", source: "dynamic" },
			tool_response: [
				...content(...parts),
				{ type: "resource_link", name: "Trace", uri: "ui://pharaoh/trace" },
			],
			...extra,
		}),
		options,
	);
}
function reserve() {
	review.beginReviewTurn(event(), options);
	put(source, "export function total(price) { return price - 1; }\n");
	const cue = stop();
	runId = cue?.reason.match(/snapshot '([a-f0-9-]{36})'/)?.[1] ?? "";
}
async function prepare(contents = test, observe = true) {
	reserve();
	await command("snapshot");
	if (observe) graph();
	put(testFile, contents);
}
async function before(contents = test) {
	await prepare(contents);
	return command("before", beforeArgs);
}

beforeEach(() => {
	home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pharaoh-review-")));
	root = join(home, "repo");
	runId = "";
	fs.mkdirSync(join(root, "src"), { recursive: true });
	fs.mkdirSync(join(root, "tests"));
	const files = {
		".gitignore": "node_modules/\n",
		"package.json": '{"type":"module"}',
		[source]: "export function total(price) { return price; }\n",
		"tests/helper.js": "export const expected = 90;",
		"src/expectations.js": "export const expected = 90;",
		[regression]: testProgram("nonnegative", "expect(total(100)).toBeGreaterThan(0)"),
	};
	for (const [path, text] of Object.entries(files)) put(path, text);
	git("init", "-q");
	commit();
	fs.symlinkSync(vitestDependencies, join(root, "node_modules"), "dir");
	setChangeReview(true, home);
	input = { session_id: "native-session" };
	options = {
		client: "claude-code",
		target: { root, repo: "owner/repo" },
		directory: review.changeReviewDirectory(join(home, ".pharaoh")),
		home,
	};
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

it("supports native-ID-free turns and requests at most one review after an edit", () => {
	const nonce = review.beginReviewTurn(event(), options);
	expect(nonce).toMatch(/^[a-f0-9-]{36}$/);
	expect(review.reviewTurnInput(event(), options).prompt_id).toBe(nonce);
	expect(stop()).toBeUndefined();
	put(source, good);
	expect(stop()?.decision).toBe("block");
	expect(stop()).toBeUndefined();
	expect(stop({ stop_hook_active: true })).toBeUndefined();
});
it("requires matching native prompt, session and worktree identity", () => {
	input.prompt_id = "p1";
	review.beginReviewTurn(event(), options);
	put(source, good);
	for (const other of [{ prompt_id: "p2" }, { session_id: "other" }, { cwd: home }])
		expect(stop(other)).toBeUndefined();
	expect(stop()?.decision).toBe("block");
});
it("stays quiet for disabled review, documentation only and hidden index flags", () => {
	setChangeReview(false, home);
	expect(review.beginReviewTurn(event(), options)).toBeUndefined();
	setChangeReview(true, home);
	review.beginReviewTurn(event(), options);
	put("notes.md", "documentation only");
	expect(stop()).toBeUndefined();
	put(source, good);
	git("update-index", "--assume-unchanged", source);
	expect(stop()).toBeUndefined();
});
it("retries through an aliased subdirectory and delivers one verified receipt", async () => {
	await expect(before('import "../missing.js";')).rejects.toThrow("did not fail");
	put(testFile, test);
	const alias = join(home, "state-alias");
	fs.symlinkSync(dirname(options.directory), alias, "dir");
	const reproduction = await runChangeReview(
		["before", runId, "--directory", join(alias, "change-review"), ...beforeArgs],
		{ cwd: join(root, "src") },
	);
	expect(reproduction).toMatchObject({ status: "reproduced" });
	expect(reproduction).not.toHaveProperty("failure");
	put(source, good);
	const result = await command("after", [], join(root, "src"));
	expect(result.status).toBe("verified");
	const proof = json(String(result.proof));
	expect(proof.before.failure).toBe(true);
	expect(proof.after.pass).toBe(true);
	expect(fs.existsSync(join(options.directory, `files-${runId}`))).toBe(false);
	const consume = (extra = {}) =>
		review.consumeReviewReceipt(event({ hook_event_name: "Stop", ...extra }), options);
	for (const other of [{ session_id: "other" }, { prompt_id: "other" }])
		expect(consume(other)).toBeUndefined();
	setChangeReview(false, home);
	expect(consume()).toBeUndefined();
	setChangeReview(true, home);
	put(source, "export const changed = true;");
	expect(consume()).toBeUndefined();
	put(source, good);
	expect(consume()?.message).toContain("Pharaoh caught");
	expect(consume()).toBeUndefined();
});
it.each([
	["absent graph", "before", "No successful Pharaoh", undefined],
	["early production edit", "before", "Production changed before", source],
	["unlisted test helper", "before", "unlisted test-side", "tests/helper.js"],
	["changed reproduced test", "after", "inputs changed", testFile],
	["unlisted source helper", "after", "unlisted source inputs changed", "src/expectations.js"],
])("rejects %s", async (_, phase, message, path) => {
	await prepare(test, path !== undefined);
	if (phase === "after") {
		await command("before", beforeArgs);
		put(source, good);
	}
	if (path) put(path, "// changed input");
	await expect(command(phase, phase === "before" ? beforeArgs : [])).rejects.toThrow(message);
	expect(run().phase).toBe(phase === "after" ? "reproduced" : "snapshotted");
});
it.each([
	["loader error", 'import "../missing.js";\n'],
	["skipped assertion", testProgram(name, "", true)],
	["unrelated assertion", testProgram("different", "expect(1).toBe(2)")],
])("does not count %s as the selected behavior", async (_, contents) => {
	await expect(before(contents)).rejects.toThrow("did not fail the selected behavioral assertion");
	expect(run().phase).toBe("snapshotted");
});
it("records only post-snapshot native-array provenance and preserves valid footer answers", async () => {
	reserve();
	graph();
	expect(run().graph).toBeUndefined();
	await command("snapshot");
	const commit = "0123456789012345678901234567890123456789";
	const refreshedAt = "2026-11-19T12:00:00Z";
	graph([`Indexed commit: ${commit}\nLast refreshed: ${refreshedAt}`, graphAnswer]);
	expect(run().graph).toMatchObject({
		scope: "hosted-default-branch",
		indexedCommit: commit,
		refreshedAt,
	});
	graph(["Scope: local saved worktree", graphAnswer]);
	expect(run().graph).toMatchObject({
		scope: "local-saved-worktree",
		indexedCommit: null,
		refreshedAt: null,
	});
	for (const [tool, footer] of [
		["get_blast_radius", warning],
		["pharaoh_recon", `No matching functions found.\n${warning}`],
		["get_blast_radius", "Upgrade your plan to Pro for more coverage."],
	]) {
		graph([graphAnswer, footer], tool);
		expect(run().graph).toMatchObject({
			tool: `mcp__pharaoh__${tool}`,
			scope: "hosted-default-branch",
		});
	}
});

it.each([
	"commit",
	"restore",
	"remove new",
	"raw bytes",
])("sees %s source changes during the turn", (kind) => {
	if (kind === "remove new") put("src/new.js", "export const added = 1;");
	review.beginReviewTurn(event(), options);
	if (kind === "remove new") fs.unlinkSync(join(root, "src/new.js"));
	else {
		put(source, kind === "raw bytes" ? "export function total(price) { return price; }\r\n" : good);
		if (kind === "commit") {
			commit();
		}
	}
	expect(stop()?.decision).toBe("block");
});
it.each([
	"assertion",
	"regression",
])("rejects a repaired run omitting the exact %s", async (missing) => {
	if (missing === "regression") {
		put(regression, conditional(testProgram("existing", "expect(true).toBe(true)")));
		commit();
	}
	const disappearing = `${conditional(test)} else it("other", () => expect(true).toBe(true));`;
	await before(missing === "assertion" ? disappearing : test);
	put(source, good);
	await expect(command("after")).rejects.toThrow(
		missing === "assertion" ? "identical assertion" : "regression suite",
	);
});
it("recovers only dead owned locks and refuses live workspace dependency links", async () => {
	reserve();
	const lock = join(options.directory, `operation-${runId}.lock`);
	fs.mkdirSync(lock, { mode: 0o700 });
	const ownerPath = join(lock, `owner-${runId}.json`);
	json(ownerPath, {
		owner: runId,
		pid: process.pid,
		reviewId: runId,
		createdAt: Date.now() - 2000,
	});
	await expect(command("snapshot")).rejects.toThrow("already running");
	json(ownerPath, { ...json(ownerPath), pid: 2147483647 });
	expect((await command("snapshot")).status).toBe("snapshotted");
	fs.unlinkSync(join(root, "node_modules"));
	fs.mkdirSync(join(root, "node_modules"));
	fs.symlinkSync(join(root, "src"), join(root, "node_modules", "workspace"));
	input.prompt_id = "new";
	put(source, good);
	reserve();
	await expect(command("snapshot")).rejects.toThrow("workspace dependency");
});

it("recovers an interrupted empty lock and cancels the owned test process after parent death", async () => {
	reserve();
	const lock = join(options.directory, `operation-${runId}.lock`);
	fs.mkdirSync(lock, { mode: 0o700 });
	fs.utimesSync(lock, 1, 1);
	await command("snapshot");
	graph();
	const marker = join(home, "child-pid");
	put(
		testFile,
		`import { writeFileSync } from "node:fs"; import { it } from "vitest"; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); it(${JSON.stringify(name)}, async () => { await new Promise(() => {}); });`,
	);
	const child = spawn(process.execPath, [proofScript, ...args("before", beforeArgs)], {
		cwd: root,
		stdio: "ignore",
	});
	const closed = new Promise((done) => child.once("close", done));
	try {
		await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 15000 });
		const pid = Number(fs.readFileSync(marker, "utf8"));
		child.kill("SIGKILL");
		await closed;
		await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10000 });
		await new Promise((done) => setTimeout(done, 1100));
		put(testFile, test);
		expect((await command("before", beforeArgs)).status).toBe("reproduced");
	} finally {
		child.kill("SIGKILL");
	}
});

it.each([
	...[
		'No functions matching "missing" found.',
		"No matching functions found.",
		"Trial expired. Upgrade your plan to continue.",
		"This needs Pro: the account is limited. get_codebase_map still answers for this repo.",
	].map((text) => ({
		tool_name: "mcp__pharaoh__search_functions",
		tool_response: content(text),
	})),

	{ tool_input: { repo: "repo" } },
	{ tool_name: "mcp__other__get_blast_radius" },
	{ mcp_server: { name: "other" } },
	{
		tool_response: {
			content: content(graphAnswer),
			structuredContent: { status: "upgrade_required" },
		},
	},
	{
		tool_response: content(graphAnswer, '{"error":"trial expired"}'),
	},
])("rejects mismatched or refused graph result %j", async (extra) => {
	await prepare(test, false);
	graph([graphAnswer], "get_blast_radius", extra);
	expect(run().graph).toBeUndefined();
});
