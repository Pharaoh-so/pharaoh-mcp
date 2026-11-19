/** Local extras stay in their checkout and retain user-owned files and choices. */
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	syncLocalWorktreeHooks,
	syncRuntimeHooks,
	syncUpdateNoticeHook,
} from "../runtime/runtime-hooks.mjs";
import { configureClients } from "../src/client-install.js";
import {
	allowReadTools,
	cleanupInstallExtras,
	PHARAOH_ALLOW_RULES,
	preflightInstallExtras,
	runInstallSkills,
} from "../src/install-skills.js";
import type { InstallScope } from "../src/install-types.js";

describe("checkout-local skills and extras", () => {
	let home: string;
	let root: string;
	let scope: InstallScope;
	const clients = ["claude-code", "codex"] as const;

	function git(...args: string[]) {
		const env = { ...process.env };
		delete env.GIT_DIR;
		delete env.GIT_WORK_TREE;
		delete env.GIT_INDEX_FILE;
		return execFileSync("git", ["-C", root, ...args], {
			env,
			encoding: "utf8",
			stdio: "pipe",
			timeout: 5_000,
		});
	}

	beforeEach(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "pharaoh-local-extras-")));
		root = join(home, "Project With Spaces");
		mkdirSync(root);
		git("init", "--quiet");
		scope = { kind: "local", root };
		vi.stubEnv("CODEX_HOME", undefined);
		vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("installs root-bound loose skills without touching global plugin or settings", () => {
		mkdirSync(join(home, ".claude"));
		mkdirSync(join(home, ".codex"));
		const globalSettings = '{"theme":"dark","enabledPlugins":{"other@example":true}}';
		writeFileSync(join(home, ".claude", "settings.json"), globalSettings);
		writeFileSync(join(home, ".codex", "hooks.json"), '{"hooks":{}}');
		const claude = vi.fn(() => true);

		const result = runInstallSkills(home, { scope, clients, claude, silent: true });

		expect(result.errors).toEqual([]);
		expect(claude).not.toHaveBeenCalled();
		for (const directory of [".claude", ".agents"]) {
			const skill = readFileSync(
				join(root, directory, "skills", "pharaoh-plan", "SKILL.md"),
				"utf8",
			);
			expect(skill).toContain(JSON.stringify(root));
			expect(skill).toContain("including a sibling or linked worktree, ignore this skill");
		}
		expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(globalSettings);
		expect(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).toBe('{"hooks":{}}');
		expect(existsSync(join(home, ".agents", "skills"))).toBe(false);
		expect(existsSync(join(home, ".pharaoh", "claude-marketplace"))).toBe(false);
		expect(result.warnings.join(" ")).toContain("Grep-routing plugin is not installed");
	});

	it("keeps generated configuration out of Git staging without ignoring neighboring user files", () => {
		expect(runInstallSkills(home, { scope, clients, silent: true }).errors).toEqual([]);
		expect(allowReadTools(home, { scope })).toBe("added");
		const launch = { command: process.execPath, args: [join(home, "launcher-v1.mjs")] };
		expect(
			configureClients(
				[
					{
						client: "codex",
						path: join(home, ".codex", "config.toml"),
						cli: "codex",
						version: "0.166.0",
					},
				],
				launch,
				{ home, env: {}, scope },
			)[0].status,
		).toBe("configured");
		for (const client of clients) {
			const options = { home, env: {}, scope, generation: "11111111-1111-4111-8111-111111111111" };
			syncRuntimeHooks(client, join(home, "runtime-hook.mjs"), options);
			syncLocalWorktreeHooks(client, join(home, "local-worktree-hook.mjs"), options);
			syncUpdateNoticeHook(client, join(home, "update-notice.mjs"), options);
		}
		const neighbor = join(root, ".claude", "skills", "mine", "SKILL.md");
		mkdirSync(join(root, ".claude", "skills", "mine"));
		writeFileSync(neighbor, "My shared skill");
		git("add", ".");
		expect(git("diff", "--cached", "--name-only").trim()).toBe(".claude/skills/mine/SKILL.md");
		expect(existsSync(join(root, ".gitignore"))).toBe(false);
		expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toContain("launcher-v1.mjs");
	});

	it("writes private untracked commands, preserving edits and tracked files", () => {
		const first = runInstallSkills(home, { scope, clients: ["claude-code"], silent: true });
		expect(first.keptCommands).toEqual([]);
		expect(existsSync(join(root, ".claude", "commands", "plan.md"))).toBe(true);
		const plan = join(root, ".claude", "commands", "plan.md");
		const review = join(root, ".claude", "commands", "review.md");
		writeFileSync(plan, "My tracked plan");
		git("add", "--force", ".claude/commands/plan.md");
		vi.stubEnv("GIT_DIR", join(home, "wrong-repository"));
		vi.stubEnv("GIT_WORK_TREE", home);
		const second = runInstallSkills(home, { scope, clients: ["claude-code"], silent: true });
		expect(second.errors).toEqual([]);
		expect(second.keptCommands).toContain("plan.md");
		expect(readFileSync(plan, "utf8")).toBe("My tracked plan");
		expect(readFileSync(review, "utf8")).toContain(JSON.stringify(root));
		appendFileSync(review, "\nMy review rule.\n");
		runInstallSkills(home, { scope, clients: ["claude-code"], silent: true });
		cleanupInstallExtras(scope, ["claude-code"], home);
		expect(readFileSync(plan, "utf8")).toBe("My tracked plan");
		expect(readFileSync(review, "utf8")).toContain("My review rule.");
	});

	it("preserves skills whose ownership marker is tracked and reports unsafe private exclusions", () => {
		runInstallSkills(home, { scope, clients: ["codex"], silent: true });
		const directory = join(root, ".agents", "skills", "pharaoh-plan");
		const marker = join(directory, ".pharaoh-managed-skill.json");
		const original = readFileSync(marker, "utf8");
		git("add", "--force", ".agents/skills/pharaoh-plan/.pharaoh-managed-skill.json");
		const retry = runInstallSkills(home, { scope, clients: ["codex"], silent: true });
		expect(retry.warnings.join(" ")).toContain("pharaoh-plan");
		cleanupInstallExtras(scope, ["codex"], home);
		expect(readFileSync(marker, "utf8")).toBe(original);
		expect(existsSync(join(directory, "SKILL.md"))).toBe(true);
		const outside = join(home, "exclude");
		writeFileSync(outside, "keep\n");
		const exclude = join(root, ".git", "info", "exclude");
		for (const link of [symlinkSync, linkSync]) {
			rmSync(exclude);
			link(outside, exclude);
			const unsafe = runInstallSkills(home, { scope, clients: ["claude-code"], silent: true });
			expect(unsafe.warnings.join(" ")).toContain("could not be kept private");
			expect(readFileSync(outside, "utf8")).toBe("keep\n");
			expect(allowReadTools(home, { scope })).toBe("error");
		}
		rmSync(exclude);
		writeFileSync(exclude, "");
		const sharedSettings = join(home, "shared-settings.json");
		writeFileSync(sharedSettings, "{}");
		linkSync(sharedSettings, join(root, ".claude", "settings.local.json"));
		expect(allowReadTools(home, { scope })).toBe("error");
		expect(() =>
			syncLocalWorktreeHooks("claude-code", join(home, "hook.mjs"), { home, env: {}, scope }),
		).toThrow();
		expect(readFileSync(sharedSettings, "utf8")).toBe("{}");
	});

	it("scopes permission receipts and cleanup to one checkout", () => {
		mkdirSync(join(root, ".claude"));
		const settings = join(root, ".claude", "settings.local.json");
		writeFileSync(
			settings,
			JSON.stringify({ permissions: { allow: [PHARAOH_ALLOW_RULES[0], "Read"] }, theme: "dark" }),
		);
		expect(allowReadTools(home, { scope })).toBe("added");
		const sibling = join(home, "Another Checkout");
		mkdirSync(sibling);
		execFileSync("git", ["-C", sibling, "init", "--quiet"], { stdio: "pipe" });
		const other: InstallScope = { kind: "local", root: sibling };
		expect(allowReadTools(home, { scope: other })).toBe("added");
		const siblingSettings = readFileSync(join(sibling, ".claude", "settings.local.json"), "utf8");
		expect(cleanupInstallExtras(scope, ["claude-code"], home)).toEqual([]);
		expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
			permissions: { allow: [PHARAOH_ALLOW_RULES[0], "Read"] },
			theme: "dark",
		});
		expect(readFileSync(join(sibling, ".claude", "settings.local.json"), "utf8")).toBe(
			siblingSettings,
		);
		expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
	});

	it("preserves an installed Local command after the user tracks it", () => {
		writeFileSync(join(root, ".gitignore"), ".claude/commands/*\n");
		runInstallSkills(home, { scope, clients: ["claude-code"], silent: true });
		const command = join(root, ".claude", "commands", "review.md");
		const before = readFileSync(command, "utf8");
		git("add", "--force", ".claude/commands/review.md");
		cleanupInstallExtras(scope, ["claude-code"], home);
		expect(readFileSync(command, "utf8")).toBe(before);
		// Retain ownership so a later untrack and explicit cleanup can remove it.
		git("rm", "--cached", "--force", ".claude/commands/review.md");
		cleanupInstallExtras(scope, ["claude-code"], home);
		expect(existsSync(command)).toBe(false);
	});

	it("keeps separate root bindings and removes only the selected linked worktree's skills", () => {
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"--allow-empty",
			"-m",
			"fixture",
		);
		const sibling = join(home, "Linked");
		git("worktree", "add", "--quiet", "--detach", sibling);
		const other: InstallScope = { kind: "local", root: sibling };
		runInstallSkills(home, { scope, clients: ["codex"], silent: true });
		runInstallSkills(home, { scope: other, clients: ["codex"], silent: true });
		const mainSkill = join(root, ".agents", "skills", "pharaoh", "SKILL.md");
		const otherSkill = join(sibling, ".agents", "skills", "pharaoh", "SKILL.md");
		expect(readFileSync(mainSkill, "utf8")).toContain(JSON.stringify(root));
		expect(readFileSync(otherSkill, "utf8")).toContain(JSON.stringify(sibling));
		execFileSync("git", ["-C", sibling, "add", "."], { stdio: "pipe" });
		expect(
			execFileSync("git", ["-C", sibling, "diff", "--cached", "--name-only"], { encoding: "utf8" }),
		).toBe("");
		cleanupInstallExtras(other, ["codex"], home);
		expect(existsSync(otherSkill)).toBe(false);
		expect(existsSync(mainSkill)).toBe(true);
	});

	it("detects residual active hooks and plugins in both directions without counting disabled choices", () => {
		mkdirSync(join(home, ".claude"));
		const settings = join(home, ".claude", "settings.json");
		const hook = { command: "node hook.mjs # pharaoh-project-memory:user-v1" };
		writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } }));
		expect(preflightInstallExtras(scope, ["claude-code"], home).join(" ")).toContain(settings);
		writeFileSync(
			settings,
			JSON.stringify({
				enabledPlugins: { "pharaoh@pharaoh": false },
				hooks: { Stop: [{ hooks: [{ ...hook, enabled: false }] }] },
				permissions: { allow: PHARAOH_ALLOW_RULES },
			}),
		);
		expect(preflightInstallExtras(scope, ["claude-code"], home)).toEqual([]);
		writeFileSync(
			settings,
			JSON.stringify({ disableAllHooks: true, hooks: { Stop: [{ hooks: [hook] }] } }),
		);
		expect(preflightInstallExtras(scope, ["claude-code"], home)).toEqual([]);
		writeFileSync(
			settings,
			JSON.stringify({
				disableAllHooks: true,
				enabledPlugins: { "pharaoh@pharaoh": true },
				hooks: { Stop: [{ hooks: [hook] }] },
			}),
		);
		expect(preflightInstallExtras(scope, ["claude-code"], home).join(" ")).toContain(settings);
		mkdirSync(join(root, ".codex"));
		writeFileSync(
			join(root, ".codex", "config.toml"),
			'[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "node runtime --pharaoh-runtime-v1"\n',
		);
		expect(preflightInstallExtras({ kind: "global" }, ["codex"], home, [root]).join(" ")).toContain(
			join(root, ".codex", "config.toml"),
		);
	});

	it("rejects a linked project settings directory before creating skills or permissions", () => {
		const outside = join(home, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(root, ".claude"), "dir");
		expect(
			runInstallSkills(home, { scope, clients: ["claude-code"], silent: true }).errors,
		).toHaveLength(1);
		expect(allowReadTools(home, { scope })).toBe("error");
		expect(existsSync(join(outside, "skills"))).toBe(false);
		expect(existsSync(join(outside, "settings.local.json"))).toBe(false);
	});

	it("preflights tracked native settings in a repo with no remote before any Local writes", () => {
		mkdirSync(join(root, ".claude"));
		mkdirSync(join(root, ".codex"));
		writeFileSync(join(root, ".claude", "settings.local.json"), "{}");
		writeFileSync(join(root, ".codex", "hooks.json"), "{}");
		git("add", ".claude/settings.local.json", ".codex/hooks.json");
		const problems = preflightInstallExtras(scope, clients, home);
		expect(problems).toHaveLength(2);
		expect(problems.join(" ")).toContain("settings.local.json");
		expect(problems.join(" ")).toContain("hooks.json");
		expect(existsSync(join(home, ".pharaoh"))).toBe(false);
		expect(existsSync(join(root, ".agents"))).toBe(false);
	});
});
