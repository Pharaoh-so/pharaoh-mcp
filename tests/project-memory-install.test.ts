import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { worktreeCue } from "../project-memory/graph-cues.mjs";
import { readHookPreferences, resetHookPreferences } from "../project-memory/preferences.mjs";
import {
	applyMemoryHookChoices,
	chooseMemoryHooks,
	syncMemoryHooks,
} from "../project-memory/setup.mjs";
import { type Credentials, writeCredentials } from "../src/credentials.js";
import { tokenToCredentials } from "../src/helpers.js";

const repo = "fixture/project";
const require = createRequire(import.meta.url);
let home: string;
let checkout: string;
let packageRoot: URL;
let credentials: Credentials;

function git(...args: string[]): string {
	return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
}

function commitFixture() {
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"--allow-empty",
		"-qm",
		"seed",
	);
}

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "pharaoh-memory-install-")));
	checkout = join(home, "checkout");
	mkdirSync(checkout);
	git("init", "-q");
	git("remote", "add", "origin", `https://github.com/${repo}.git`);
	commitFixture();
	const pkg = join(home, "package");
	packageRoot = pathToFileURL(`${pkg}/`);
	mkdirSync(join(pkg, "dist"), { recursive: true });
	cpSync(new URL("../project-memory/", import.meta.url), join(pkg, "project-memory"), {
		recursive: true,
	});
	mkdirSync(join(pkg, "hooks"));
	cpSync(new URL("../hooks/route-grep.mjs", import.meta.url), join(pkg, "hooks/route-grep.mjs"));
	writeFileSync(join(pkg, "dist/refresh.js"), "export function originBoundRefresh() {}\n");
	writeFileSync(
		join(pkg, "dist/credentials.js"),
		`
		import { readFileSync } from "node:fs";
		import { homedir } from "node:os";
		export const CREDENTIALS_PATH = homedir() + "/.pharaoh/credentials.json";
		export function readCredentials() { return JSON.parse(readFileSync(CREDENTIALS_PATH)); }
	`,
	);
	credentials = {
		version: 2,
		access_token: "fixture",
		refresh_token: "fixture",
		expires_at: "2030-01-01",
		refresh_expires_at: "2030-01-01",
		expires_in: 3600,
		sse_url: "https://mcp.pharaoh.so/sse",
		github_login: "owner",
		tenant_name: null,
		repos: [repo],
		project_memory: [{ repo, revision: git("rev-parse", "HEAD") }],
	};
	writeCredentials(credentials, join(home, ".pharaoh/credentials.json"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function configure(options: Partial<Parameters<typeof syncMemoryHooks>[0]> = {}) {
	return syncMemoryHooks({
		home,
		cwd: checkout,
		env: {},
		packageRoot,
		credentials,
		clients: ["claude-code", "codex"],
		...options,
	});
}

function hookCommand(settings: string, event: string): string {
	const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks[event];
	return hooks.find((group: { hooks: Array<{ command?: string }> }) =>
		group.hooks[0]?.command?.endsWith("# pharaoh-project-memory:user-v1"),
	).hooks[0].command;
}

function prompt(
	settings: string,
	cwd: string,
	env: NodeJS.ProcessEnv = {},
	event = "UserPromptSubmit",
) {
	return execFileSync("/bin/sh", ["-c", hookCommand(settings, "UserPromptSubmit")], {
		cwd,
		env: { ...process.env, HOME: home, ...env },
		encoding: "utf8",
		input: JSON.stringify({
			hook_event_name: event,
			cwd,
			prompt: "Investigate a real project issue",
			session_id: "fixture-session",
			turn_id: "fixture-turn",
		}),
	});
}

it("runs the worktree cue from the installed, activated bundle", () => {
	writeCredentials(
		{ ...credentials, project_memory_session: "79d35b00-e832-4b5b-972d-acbb9ec59622" },
		join(home, ".pharaoh/credentials.json"),
	);
	configure({ enable: true, clients: ["codex"], graphClients: ["codex"] });
	const settings = join(home, ".codex/hooks.json");
	const run = (command: string, env: NodeJS.ProcessEnv = {}) =>
		execFileSync("/bin/sh", ["-c", hookCommand(settings, "PreToolUse")], {
			cwd: checkout,
			env: { ...process.env, HOME: home, ...env },
			encoding: "utf8",
			input: JSON.stringify({
				hook_event_name: "PreToolUse",
				cwd: checkout,
				session_id: "graph-session",
				tool_name: "Bash",
				tool_input: { command },
			}),
		});
	const trace = join(home, "git-started");
	const probe = join(home, "probe.cjs");
	writeFileSync(
		probe,
		`require("node:child_process").execFileSync = () => {
		require("node:fs").writeFileSync(${JSON.stringify(trace)}, "started");
		throw new Error("Unexpected subprocess");
	};
	require("node:module").syncBuiltinESMExports();`,
	);
	for (const search of [
		"pwd",
		"rg -F 'function readWidget'",
		"rg 'function readWidget' -F",
		"rg 'readWidget'",
		"rg 'function readWidget' docs/",
		"rg 'function readWidget' app.config.ts",
		"rg 'function readWidget' ../another-repo",
		"rg 'function readWidget' | head",
		"rg -g '*.{ts,json}' 'function readWidget'",
	])
		expect(run(search, { NODE_OPTIONS: `--require="${probe}"` })).toBe("");
	expect(existsSync(trace)).toBe(false);
	const command = "rg -n 'function readWidget'";
	expect(JSON.parse(run(command)).hookSpecificOutput).toEqual({
		hookEventName: "PreToolUse",
		additionalContext: expect.stringContaining("search_functions"),
	});
	expect(run(command)).toBe("");
	resetHookPreferences(true, home);
	expect(run("rg 'function anotherWidget'")).toBe("");
});

it.each([false, true])("advises safely after a map with short request=%s", (short) => {
	const file = "secret-path.ts";
	writeFileSync(join(checkout, file), "export function temporary() {}\n");
	git("add", file);
	commitFixture();
	const revision = git("rev-parse", "HEAD");
	const filter = join(home, "filter-started");
	git("config", "filter.pilot.clean", `touch "${filter}" && cat`);
	writeFileSync(join(checkout, ".gitattributes"), `${file} filter=pilot\n`);
	const stateDirectory = join(home, ".pharaoh/project-memory-client");
	const options = {
		client: "codex",
		target: { root: checkout, repo },
		binding: "fixture",
		repos: [repo],
		stateDirectory,
	};
	const cue = (input: object, overrides = {}) =>
		worktreeCue(
			{ hook_event_name: "PostToolUse", session_id: "same-session", cwd: checkout, ...input },
			{ ...options, ...overrides },
		);
	const map = {
		tool_name: "mcp__pharaoh__get_codebase_map",
		tool_input: { repo: short ? "project" : repo },
		tool_response: {
			content: [
				{
					type: "text",
					text: `# ${short ? repo : "project"} Codebase Map\nIndexed commit: ${revision}`,
				},
			],
		},
	};
	const patch = (path: string) => ({
		tool_name: "apply_patch",
		tool_input: { command: `*** Begin Patch\n*** Update File: ${path}\n*** End Patch\n` },
		tool_response: "Success. Updated the following files:",
	});
	writeFileSync(join(checkout, file), "export function temporary() { return 1; }\n");
	cue({ ...map, tool_input: { repo: "other/project" } });
	for (const text of [
		`# project Codebase Map\nIndexed commit: ${revision}`,
		`# other/project Codebase Map\nIndexed commit: ${revision}`,
		`# ${repo} Codebase Map\n# other/project Codebase Map\nIndexed commit: ${revision}`,
		`# ${repo} Codebase Map\nIndexed commit: ${revision}\nIndexed commit: ${revision}`,
		`# ${repo} Codebase Map\nIndexed commit: unknown`,
	])
		cue({
			...map,
			tool_input: { repo: "project" },
			tool_response: { content: [{ type: "text", text }] },
		});
	cue({
		...map,
		tool_response: { content: [...map.tool_response.content, ...map.tool_response.content] },
	});
	cue({ ...map, tool_response: { ...map.tool_response, isError: true } });
	expect(cue(patch(file))).toBeUndefined();
	// Canonical output is sufficient with absent or misleading personal repo hints.
	cue(map, { repos: short ? ["other/project"] : [] });
	expect(cue({ ...patch(file), tool_response: "Failed to apply patch" })).toBeUndefined();
	expect(cue(patch("unchanged.ts"))).toBeUndefined();
	expect(
		cue(patch(file), {
			git: (_cwd: string, deadline: number) => {
				expect(deadline - performance.now()).toBeLessThanOrEqual(300);
				throw new Error("Git timeout");
			},
		}),
	).toBeUndefined();
	expect(cue(patch(file))?.hookSpecificOutput.additionalContext).toContain(revision.slice(0, 12));
	expect(cue(patch(file))).toBeUndefined();
	writeFileSync(join(checkout, "new.ts"), "export {}\n");
	expect(cue(patch("new.ts"))?.hookSpecificOutput.hookEventName).toBe("PostToolUse");
	expect(cue(patch("settings.json"))).toBeUndefined();
	expect(existsSync(filter)).toBe(false);
	expect(readFileSync(join(stateDirectory, "worktree-cues.json"), "utf8")).not.toContain(file);
});

function commandHook(command: string) {
	return { type: "command", command };
}

function legacySettings() {
	const path = join(checkout, ".codex/hooks.json");
	mkdirSync(join(checkout, ".codex"));
	writeFileSync(join(checkout, ".git/info/exclude"), "/.codex/hooks.json\n");
	const marker = createHash("sha256").update(`codex\0${checkout}`).digest("hex");
	writeFileSync(
		path,
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							commandHook(`/old/pharaoh-memory-hook.mjs # pharaoh-project-memory:${marker}`),
							commandHook("keep-checkout-hook"),
						],
					},
				],
			},
		}),
	);
	return path;
}

function choose(options: Partial<Parameters<typeof chooseMemoryHooks>[0]> = {}) {
	return chooseMemoryHooks({
		credentials,
		clients: ["codex"],
		home,
		env: {},
		ask: async () => {
			throw new Error("Unexpected prompt");
		},
		...options,
	});
}

it("remembers the recommended memory choice and offers independent default-no worktree cues", async () => {
	const defaults: boolean[] = [];
	const decision = await choose({
		ask: async (_, defaultAnswer) => {
			defaults.push(defaultAnswer);
			return defaultAnswer;
		},
	});
	expect(defaults).toEqual([true, false]);
	expect(decision).toMatchObject({ accepted: ["codex"], declined: [], graphClients: [] });
	configure({ enable: true, clients: decision.accepted, graphClients: decision.graphClients });
	expect(await choose()).toEqual(decision);
});

function applyChoice(decision: Awaited<ReturnType<typeof choose>>, creds = credentials) {
	return applyMemoryHookChoices(decision, {
		home,
		cwd: checkout,
		env: {},
		credentials: creds,
		packageRoot,
	});
}

it("honors an opt-out saved after setup answers and re-offers cues only when requested", async () => {
	const accepted = await choose({ ask: async () => true });
	resetHookPreferences(true, home);
	applyChoice(accepted);
	expect(existsSync(join(home, ".codex/hooks.json"))).toBe(false);
	expect((await choose()).declined).toEqual(["codex"]);
	applyChoice(await choose({ requested: true, ask: async () => true }));
	const path = join(home, ".codex/hooks.json");
	const config = JSON.parse(readFileSync(path, "utf8"));
	expect(config.hooks.PreToolUse).toHaveLength(1);
	const unrelated = [{ hooks: [commandHook("keep-unrelated-cue")] }];
	config.hooks.PostToolUse = unrelated;
	writeFileSync(path, JSON.stringify(config));
	applyChoice(await choose({ ask: async () => null }));
	const hooks = JSON.parse(readFileSync(path, "utf8")).hooks;
	expect(hooks.PreToolUse).toBeUndefined();
	expect(hooks.PostToolUse).toEqual(unrelated);
	expect(hooks.UserPromptSubmit).toHaveLength(1);
});

it("preserves setup after a temporary eligibility failure and deactivates both clients after grant loss", async () => {
	const clients = ["claude-code", "codex"];
	applyChoice(await choose({ clients, ask: async () => true }));
	const before = readHookPreferences(home);
	const activation = join(home, ".pharaoh/project-memory-client/active.json");
	const noGrant = { ...credentials, project_memory: undefined };
	const unavailable = { ...noGrant, project_memory_status: "unavailable" as const };
	applyChoice(await choose({ clients: ["claude-code"], credentials: unavailable }), unavailable);
	expect(existsSync(activation)).toBe(true);
	applyChoice(await choose({ clients: ["claude-code"], credentials: noGrant }), noGrant);
	expect(existsSync(activation)).toBe(false);
	for (const path of [".codex/hooks.json", ".claude/settings.json"])
		expect(JSON.parse(readFileSync(join(home, path), "utf8")).hooks).toEqual({});
	expect(readHookPreferences(home)).toEqual(before);
});

it("preserves declines through cleanup", async () => {
	const answers = [false, true, true];
	await choose({ clients: ["claude-code", "codex"], ask: async () => answers.shift() ?? null });
	resetHookPreferences(false, home);
	expect(readHookPreferences(home)).toEqual({ "claude-code": { memory: false } });
});

it("requires consent for legacy or missing hooks and respects native disable", async () => {
	configure({ enable: true });
	expect((await choose({ ask: async () => null })).accepted).toEqual([]);
	await choose({ requested: true, ask: async () => false });
	writeFileSync(join(home, ".codex/hooks.json"), '{"hooks":{"Notification":[]}}');
	expect((await choose({ ask: async () => null })).accepted).toEqual([]);
	writeFileSync(join(home, ".claude/settings.json"), '{"disableAllHooks":true}');
	expect((await choose({ clients: ["claude-code"], requested: true })).accepted).toEqual([]);
});

it("removes owned pilot hooks during default setup without changing unrelated settings", () => {
	const codex = join(home, ".codex/hooks.json");
	configure({ enable: true });
	const activation = join(home, ".pharaoh/project-memory-client/active.json");
	expect(existsSync(activation)).toBe(true);
	const old = commandHook("/old/pharaoh-memory-hook.mjs # pharaoh-project-memory:user-v1");
	const keep = commandHook("/user/tool.mjs # pharaoh-project-memory:user-v1");
	const notification = [{ hooks: [commandHook("keep-notification")] }];
	writeFileSync(
		codex,
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [{ hooks: [old, keep] }],
				Stop: [{ hooks: [old] }],
				Interrupt: [{ hooks: [old] }],
				SessionEnd: [],
				Notification: notification,
				StopFailure: [],
			},
			otherSetting: true,
		}),
	);
	const legacy = legacySettings();
	const elsewhere = join(home, "other-checkout");
	git("worktree", "add", "--quiet", "--detach", elsewhere);
	const elsewhereSettings = join(elsewhere, ".codex/hooks.json");
	mkdirSync(join(elsewhere, ".codex"));
	const elsewhereMarker = createHash("sha256").update(`codex\0${elsewhere}`).digest("hex");
	const elsewhereConfig = JSON.stringify({
		hooks: {
			UserPromptSubmit: [
				{
					hooks: [
						commandHook(`/old/pharaoh-memory-hook.mjs # pharaoh-project-memory:${elsewhereMarker}`),
					],
				},
			],
		},
	});
	writeFileSync(elsewhereSettings, elsewhereConfig);
	const credentialsFile = join(home, ".pharaoh/credentials.json");
	const originalCredentials = readFileSync(credentialsFile, "utf8");
	expect(configure({ credentials: undefined })).toEqual([]);
	expect(JSON.parse(readFileSync(codex, "utf8"))).toEqual({
		hooks: {
			UserPromptSubmit: [{ hooks: [keep] }],
			SessionEnd: [],
			Notification: notification,
			StopFailure: [],
		},
		otherSetting: true,
	});
	expect(JSON.parse(readFileSync(legacy, "utf8"))).toEqual({
		hooks: { UserPromptSubmit: [{ hooks: [commandHook("keep-checkout-hook")] }] },
	});
	expect(readFileSync(elsewhereSettings, "utf8")).toBe(elsewhereConfig);
	expect(readFileSync(credentialsFile, "utf8")).toBe(originalCredentials);
	expect(existsSync(activation)).toBe(false);
	expect(configure()).toEqual([]);
});

it("deactivates loaded user hooks and leaves tracked checkout settings alone", () => {
	configure({ enable: true });
	const codex = join(home, ".codex/hooks.json");
	const activation = join(home, ".pharaoh/project-memory-client/active.json");
	const legacy = legacySettings();
	git("add", "--force", ".codex/hooks.json");
	const original = readFileSync(legacy, "utf8");
	writeFileSync(codex, "invalid settings");
	expect(configure().join(" ")).toContain("could not update codex project memory hooks");
	expect(existsSync(activation)).toBe(false);
	expect(readFileSync(codex, "utf8")).toBe("invalid settings");
	expect(readFileSync(legacy, "utf8")).toBe(original);
	configure({ env: { CODEX_HOME: join(checkout, ".codex") } });
	expect(readFileSync(legacy, "utf8")).toBe(original);
});

it("protects tracked checkout hooks when CODEX_HOME points through a linked ancestor", () => {
	const legacy = legacySettings();
	git("add", "--force", ".codex/hooks.json");
	const original = readFileSync(legacy, "utf8");
	const alias = join(home, "linked-checkout");
	symlinkSync(checkout, alias, "dir");
	const env = { CODEX_HOME: join(alias, ".codex") };
	expect(configure({ env }).join(" ")).toContain("could not update codex project memory hooks");
	expect(readFileSync(legacy, "utf8")).toBe(original);
});

it("keeps working settings and checkout hooks until a replacement is active", () => {
	configure({ enable: true });
	const codex = join(home, ".codex/hooks.json");
	const activation = join(home, ".pharaoh/project-memory-client/active.json");
	const originalSettings = readFileSync(codex, "utf8");
	const originalActivation = readFileSync(activation, "utf8");
	const legacy = legacySettings();
	const originalLegacy = readFileSync(legacy, "utf8");

	expect(
		configure({
			enable: true,
			credentials: { ...credentials, project_memory_status: "unavailable" },
		}).join(" "),
	).toContain("eligibility could not be checked");
	expect(
		configure({
			enable: true,
			packageRoot: new URL("missing/", packageRoot),
		}).join(" "),
	).toContain("reminders unavailable");
	expect(readFileSync(codex, "utf8")).toBe(originalSettings);
	expect(readFileSync(activation, "utf8")).toBe(originalActivation);
	expect(readFileSync(legacy, "utf8")).toBe(originalLegacy);

	appendFileSync(
		new URL("project-memory/pharaoh-memory-hook.mjs", packageRoot),
		"// replacement\n",
	);
	const alias = join(home, "linked-codex");
	symlinkSync(join(home, ".codex"), alias, "dir");
	expect(
		configure({
			enable: true,
			clients: ["codex"],
			env: { CODEX_HOME: alias },
		}).join(" "),
	).toContain("could not update codex project memory hooks");
	expect(readFileSync(codex, "utf8")).toBe(originalSettings);
	expect(readFileSync(activation, "utf8")).toBe(originalActivation);
	expect(readFileSync(legacy, "utf8")).toBe(originalLegacy);

	expect(configure({ enable: true, clients: ["codex"] }).join(" ")).toContain("review and trust");
	expect(readFileSync(activation, "utf8")).not.toBe(originalActivation);
	expect(prompt(codex, checkout)).toContain("pharaoh_memory_recall");
	expect(readFileSync(legacy, "utf8")).not.toContain("pharaoh-project-memory");
});

it("disables quietly with unrelated linked settings and fails for known linked hooks", () => {
	const external = join(home, "user-settings.json");
	const unrelated = '{"hooks":{"Notification":[]}}\n';
	writeFileSync(external, unrelated);
	const codex = join(home, ".codex");
	mkdirSync(codex);
	symlinkSync(external, join(codex, "hooks.json"));
	mkdirSync(join(checkout, ".claude"));
	symlinkSync(external, join(checkout, ".claude/settings.local.json"));
	expect(configure({ credentials: undefined })).toEqual([]);

	function disable() {
		return spawnSync(
			process.execPath,
			[
				require.resolve("tsx/cli"),
				fileURLToPath(new URL("../src/index.ts", import.meta.url)),
				"--disable-memory-hooks",
			],
			{
				cwd: checkout,
				env: {
					...process.env,
					HOME: home,
					CODEX_HOME: codex,
					CLAUDE_CONFIG_DIR: join(home, ".claude"),
				},
				encoding: "utf8",
				timeout: 5_000,
			},
		);
	}
	const clean = disable();
	expect(clean).toMatchObject({ status: 0, stdout: "", stderr: "" });
	expect(readFileSync(external, "utf8")).toBe(unrelated);
	expect(readHookPreferences(home)).toEqual({
		"claude-code": { memory: false, graph: false },
		codex: { memory: false, graph: false },
	});

	const managed = JSON.stringify({
		hooks: {
			Stop: [
				{ hooks: [commandHook("/old/pharaoh-memory-hook.mjs # pharaoh-project-memory:user-v1")] },
			],
		},
	});
	writeFileSync(external, managed);
	const blocked = disable();
	expect(blocked.status).toBe(1);
	expect(blocked.stderr + blocked.stdout).toContain("could not update codex project memory hooks");
	expect(readFileSync(external, "utf8")).toBe(managed);
}, 15_000);

it("opts in to one MCP reminder per client and scopes it to eligible worktrees", () => {
	const claude = join(home, ".claude/settings.json");
	const codex = join(home, ".codex/hooks.json");
	expect(configure({ enable: true }).join(" ")).toContain("review and trust");
	const first = readFileSync(codex, "utf8");
	configure({ enable: true });
	expect(readFileSync(codex, "utf8")).toBe(first);
	const worktree = join(home, "worktree");
	git("worktree", "add", "--quiet", "--detach", worktree);
	for (const file of [claude, codex]) {
		expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).hooks)).toEqual(["UserPromptSubmit"]);
		const reminder = prompt(file, worktree);
		expect(reminder).toContain("pharaoh_memory_recall");
		expect(reminder).toContain("pharaoh_memory_expand");
		expect(reminder).toContain("pharaoh_memory_capture");
		expect(reminder).not.toContain("--turn");
		expect(prompt(file, worktree, {}, "Stop")).toBe("");
		expect(prompt(file, home)).toBe("");
	}
	// A similarly named origin without the mapped object must not enroll.
	const spoof = join(home, "spoof");
	execFileSync("git", ["init", "-q", spoof]);
	execFileSync("git", ["-C", spoof, "remote", "add", "origin", `https://github.com/${repo}.git`]);
	expect(prompt(codex, spoof)).toBe("");
	writeCredentials(
		{ ...credentials, project_memory: undefined },
		join(home, ".pharaoh/credentials.json"),
	);
	expect(prompt(codex, worktree)).toBe("");
	expect(existsSync(join(home, ".pharaoh/project-memory-turns-v2"))).toBe(false);
});

it("can opt in from an unrelated repository rooted at the user's home", () => {
	const dotfiles = "https://github.com/fixture/dotfiles.git";
	execFileSync("git", ["init", "-q", home]);
	execFileSync("git", ["-C", home, "remote", "add", "origin", dotfiles]);
	expect(configure({ cwd: home, clients: ["codex"], enable: true }).join(" ")).toContain(
		"memory reminders are set up",
	);
	expect(existsSync(join(home, ".codex/hooks.json"))).toBe(true);
});

it("uses only readiness metadata to enable the reminder after first map", () => {
	const revision = git("rev-parse", "HEAD");
	const signIn = (accessToken: string) =>
		tokenToCredentials(
			{
				access_token: accessToken,
				refresh_token: "fixture-refresh",
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token_expires_in: 86400,
				sse_url: credentials.sse_url,
				project_memory: [{ repo, revision: null }],
			},
			credentials.sse_url,
			"https://mcp.pharaoh.so",
		);
	const pending = signIn("fixture");
	expect(pending.project_memory_session).toBeDefined();
	const credentialsFile = join(home, ".pharaoh/credentials.json");
	writeCredentials(pending, credentialsFile);
	const settings = join(home, ".codex/hooks.json");
	expect(configure({ credentials: pending, clients: ["codex"], enable: true }).join(" ")).toContain(
		"still mapping",
	);
	const installed = readFileSync(settings, "utf8");
	// Later prompts run the private installed runtime, independent of the package cache.
	rmSync(packageRoot, { recursive: true });
	const shim = join(home, "readiness-fixture.mjs");
	const requests = join(home, "memory-requests.txt");
	writeFileSync(
		shim,
		`
		import { appendFileSync } from "node:fs";
		const now = Date.now.bind(Date);
		Date.now = () => now() + Number(process.env.FIXTURE_OFFSET ?? 0);
		globalThis.fetch = async (url, options) => {
			appendFileSync(process.env.FIXTURE_REQUESTS, String(url) + "\\n");
			if (String(url) !== "https://mcp.pharaoh.so/api/project-memory/readiness" ||
				options.redirect !== "error" || options.body !== JSON.stringify({repo: "fixture/project"}))
				throw new Error("Unexpected fixture request");
			if (process.env.FIXTURE_STATUS === "denied") return new Response(null, {status: 404});
			return new Response(JSON.stringify({revision: process.env.FIXTURE_REVISION || null}));
		};
	`,
	);
	const env = { NODE_OPTIONS: `--import=${shim}`, FIXTURE_REQUESTS: requests };
	expect(prompt(settings, checkout, { ...env, FIXTURE_STATUS: "denied" })).toBe("");
	expect(prompt(settings, checkout, { ...env, FIXTURE_OFFSET: "16000" })).toBe("");
	const enabled = prompt(settings, checkout, {
		...env,
		FIXTURE_OFFSET: "32000",
		FIXTURE_REVISION: revision,
	});
	expect(enabled).toContain("pharaoh_memory_recall");
	expect(prompt(settings, checkout, env, "Stop")).toBe("");
	expect(readFileSync(settings, "utf8")).toBe(installed);
	const replacement = signIn("new-device-session");
	expect(replacement.project_memory_session).not.toBe(pending.project_memory_session);
	writeCredentials(replacement, credentialsFile);
	expect(
		prompt(settings, checkout, { ...env, FIXTURE_OFFSET: "48000", FIXTURE_STATUS: "denied" }),
	).toBe("");
	expect(readFileSync(requests, "utf8").trim().split("\n")).toEqual(
		Array(4).fill("https://mcp.pharaoh.so/api/project-memory/readiness"),
	);
});
