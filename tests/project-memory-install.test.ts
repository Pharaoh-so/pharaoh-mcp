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
import { syncMemoryHooks } from "../project-memory/setup.mjs";
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

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "pharaoh-memory-install-")));
	checkout = join(home, "checkout");
	mkdirSync(checkout);
	git("init", "-q");
	git("remote", "add", "origin", `https://github.com/${repo}.git`);
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
	const pkg = join(home, "package");
	packageRoot = pathToFileURL(`${pkg}/`);
	mkdirSync(join(pkg, "dist"), { recursive: true });
	cpSync(new URL("../project-memory/", import.meta.url), join(pkg, "project-memory"), {
		recursive: true,
	});
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

it("installs no memory hooks by default even for the pilot", () => {
	expect(configure()).toEqual([]);
	expect(existsSync(join(home, ".claude"))).toBe(false);
	expect(existsSync(join(home, ".codex"))).toBe(false);
	expect(existsSync(join(home, ".pharaoh/project-memory-client"))).toBe(false);
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
	expect(configure({ credentials: undefined, clients: [] })).toEqual([]);
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
	execFileSync("git", ["-C", home, "init", "-q"]);
	execFileSync("git", [
		"-C",
		home,
		"remote",
		"add",
		"origin",
		"https://github.com/fixture/dotfiles.git",
	]);
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
