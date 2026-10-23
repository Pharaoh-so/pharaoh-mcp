/**
 * Tests for --install-skills: the Claude Code plugin (a local marketplace
 * installed through `claude plugin`), OpenClaw install, detection, config
 * merging, and backward compat of parseArgs.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/helpers.js";
import {
	allowReadTools,
	installSkills,
	mergeOpenClawConfig,
	PHARAOH_ALLOW_RULES,
	PHARAOH_COMMAND_MARKER,
	runInstallSkills,
	uninstallClaudePlugin,
} from "../src/install-skills.js";

/** Read the package version from package.json (mirrors internal getPackageVersion). */
function readPackageVersion(): string {
	const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
		version?: string;
	};
	return pkg.version ?? "0.0.0";
}

/** SC-2: every registration the installer writes runs the version that wrote it. */
const PINNED_SPEC = `@pharaoh-so/mcp@${readPackageVersion()}`;

/** Create a fresh temp directory for each test. */
function makeTempHome(): string {
	return mkdtempSync(join(tmpdir(), "pharaoh-install-skills-"));
}

/** Every test that doesn't check registration runs without a `claude` CLI. */
const NO_CLI = { claude: () => false };

/** A stand-in for the `claude` CLI that records the commands it was asked to run. */
function recordingClaude(succeeds = true): { calls: string[]; run: (args: string[]) => boolean } {
	const calls: string[] = [];
	return {
		calls,
		run: (args) => {
			calls.push(args.join(" "));
			return succeeds;
		},
	};
}

/** Where the installer keeps Pharaoh's local Claude Code marketplace, and the plugin in it. */
const marketplaceDir = (home: string) => join(home, ".pharaoh", "claude-marketplace");
const pluginDir = (home: string) => join(marketplaceDir(home), "pharaoh");

// ── Claude Code plugin (tested through runInstallSkills) ────────────
//
// Breaks when: the plugin stops being a marketplace Claude Code can install
// (manifests, skills, the Grep routing hook), registration stops going through
// `claude plugin`, an enabled or user-disabled plugin is registered again, a
// version change leaves removed skills behind, or the old install that Claude
// Code never loaded is left in place. The SC-6/SC-7/SC-8 cases are the
// 2026-10-17 security review's PoCs: each asserts the secure behaviour.

describe("runInstallSkills — Claude Code plugin", () => {
	let home: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".claude"), { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("writes a one-plugin local marketplace: manifests, skills and the Grep routing hook", () => {
		runInstallSkills(home, NO_CLI);

		const marketplace = JSON.parse(
			readFileSync(join(marketplaceDir(home), ".claude-plugin", "marketplace.json"), "utf-8"),
		);
		const plugin = JSON.parse(
			readFileSync(join(pluginDir(home), ".claude-plugin", "plugin.json"), "utf-8"),
		);
		const hooks = JSON.parse(readFileSync(join(pluginDir(home), "hooks", "hooks.json"), "utf-8"));
		expect(marketplace.name).toBe("pharaoh");
		expect(marketplace.plugins).toEqual([
			expect.objectContaining({
				name: "pharaoh",
				source: "./pharaoh",
				version: readPackageVersion(),
			}),
		]);
		expect(plugin).toEqual(
			expect.objectContaining({ name: "pharaoh", version: readPackageVersion() }),
		);
		expect(existsSync(join(pluginDir(home), "skills", "pharaoh", "SKILL.md"))).toBe(true);
		expect(existsSync(join(pluginDir(home), "skills", "plan", "SKILL.md"))).toBe(true);
		expect(hooks.hooks.PreToolUse[0].matcher).toBe("Grep");
		expect(existsSync(join(pluginDir(home), "hooks", "route-grep.mjs"))).toBe(true);
		// The MCP server is registered with `claude mcp add`; a plugin copy would start a second one.
		expect(existsSync(join(pluginDir(home), ".mcp.json"))).toBe(false);
	});

	it("installs the plugin through the claude CLI", () => {
		const claude = recordingClaude();

		runInstallSkills(home, { claude: claude.run });

		expect(claude.calls).toEqual([
			`plugin marketplace add ${marketplaceDir(home)}`,
			"plugin install pharaoh@pharaoh",
		]);
	});

	it("leaves an enabled plugin alone, and never re-enables one the user disabled", () => {
		const claude = recordingClaude();
		const settings = join(home, ".claude", "settings.json");

		writeFileSync(settings, JSON.stringify({ enabledPlugins: { "pharaoh@pharaoh": true } }));
		runInstallSkills(home, { claude: claude.run });
		writeFileSync(settings, JSON.stringify({ enabledPlugins: { "pharaoh@pharaoh": false } }));
		runInstallSkills(home, { claude: claude.run });

		expect(claude.calls).toEqual([]);
	});

	it("still writes the plugin when the claude CLI can't install it", () => {
		expect(() => runInstallSkills(home, { claude: recordingClaude(false).run })).not.toThrow();

		expect(existsSync(join(pluginDir(home), "hooks", "route-grep.mjs"))).toBe(true);
	});

	it("rewrites the plugin when the package version changes, dropping skills that were cut", () => {
		runInstallSkills(home, NO_CLI);
		const cut = join(pluginDir(home), "skills", "cut-skill");
		mkdirSync(cut);
		writeFileSync(join(cut, "SKILL.md"), "---\nname: cut-skill\n---\n");
		const manifest = join(pluginDir(home), ".claude-plugin", "plugin.json");
		writeFileSync(manifest, JSON.stringify({ name: "pharaoh", version: "0.0.1" }));

		runInstallSkills(home, NO_CLI);

		expect(existsSync(cut)).toBe(false);
		expect(JSON.parse(readFileSync(manifest, "utf-8")).version).toBe(readPackageVersion());
	});

	it("removes the old install, which Claude Code never loaded", () => {
		const legacy = join(home, ".claude", "plugins", "data", "pharaoh");
		mkdirSync(join(legacy, ".claude-plugin"), { recursive: true });
		writeFileSync(join(legacy, ".claude-plugin", "plugin.json"), "{}");
		const registry = join(home, ".claude", "plugins", "installed_plugins.json");
		writeFileSync(
			registry,
			JSON.stringify({ version: 2, plugins: { "pharaoh@pharaoh-so": [{}], "other@market": [{}] } }),
		);

		runInstallSkills(home, NO_CLI);

		expect(existsSync(legacy)).toBe(false);
		expect(Object.keys(JSON.parse(readFileSync(registry, "utf-8")).plugins)).toEqual([
			"other@market",
		]);
	});

	it("installs bundled slash commands to ~/.claude/commands/", () => {
		runInstallSkills(home, NO_CLI);

		const commandsDir = join(home, ".claude", "commands");
		expect(existsSync(commandsDir)).toBe(true);
		expect(existsSync(join(commandsDir, "plan.md"))).toBe(true);
		expect(existsSync(join(commandsDir, "review.md"))).toBe(true);

		// Both slash commands ship as "fat" inline bodies — their full
		// skill content is inlined so the command expansion becomes the user
		// prompt directly, rather than a thin wrapper that calls the Skill
		// tool. Thin wrappers were a ship mode we retired in 2026-04-10 after
		// `Skill(pharaoh-*)` stopped resolving entirely for plugins installed
		// under ~/.claude/plugins/data/ — at which point the weak-binding
		// failure mode that motivated /plan's inline body for the MANDATORY
		// gate became a hard "Unknown skill" error for every other wrapper.
		const planCmd = readFileSync(join(commandsDir, "plan.md"), "utf-8");
		expect(planCmd).toContain("MANDATORY — ask before proceeding");
		expect(planCmd).toContain("BIG CHANGE or SMALL CHANGE");
		expect(planCmd).toContain("Garry Tan");
		expect(planCmd).toContain("Pharaoh Reconnaissance");
		expect(planCmd).toContain("$ARGUMENTS");

		// review.md must carry the full five-phase workflow body, not just a
		// "pharaoh-review" delegation string. The SHIP/BLOCK verdict line and
		// the Phase 0 git-context heading are load-bearing signals that the
		// fat body landed.
		const reviewCmd = readFileSync(join(commandsDir, "review.md"), "utf-8");
		expect(reviewCmd).toContain("Review with Pharaoh");
		expect(reviewCmd).toContain("SHIP");
		expect(reviewCmd).toContain("BLOCK");
		expect(reviewCmd).toContain("Phase 0");
		expect(reviewCmd).toContain("$ARGUMENTS");
		expect(reviewCmd).not.toMatch(/Invoke the `pharaoh-review` skill/);
	});

	it("SC-7: keeps a user-authored ~/.claude/commands/plan.md and reports it", () => {
		const commandsDir = join(home, ".claude", "commands");
		mkdirSync(commandsDir, { recursive: true });
		writeFileSync(join(commandsDir, "plan.md"), "# my own /plan\nUSER CONTENT\n");

		const result = runInstallSkills(home, NO_CLI);

		expect(readFileSync(join(commandsDir, "plan.md"), "utf-8")).toContain("USER CONTENT");
		expect(result.keptCommands).toEqual(["plan.md"]);
		expect(existsSync(join(commandsDir, "review.md"))).toBe(true);
	});

	it("SC-7: installed command files carry the Pharaoh marker inside their front-matter", () => {
		runInstallSkills(home, NO_CLI);

		const planCmd = readFileSync(join(home, ".claude", "commands", "plan.md"), "utf-8");
		const frontmatter = planCmd.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
		expect(frontmatter).toContain(PHARAOH_COMMAND_MARKER);
		expect(frontmatter).toMatch(/^description: /m);
		expect(planCmd).toContain("$ARGUMENTS");
	});

	it("SC-7: rewrites its own command files — marked ones and those from the pre-marker installer", () => {
		const commandsDir = join(home, ".claude", "commands");
		mkdirSync(commandsDir, { recursive: true });
		writeFileSync(
			join(commandsDir, "plan.md"),
			`---\ndescription: old\n${PHARAOH_COMMAND_MARKER}\n---\nstale marked body\n`,
		);
		// Every installer before the marker shipped exactly this header and footer.
		writeFileSync(
			join(commandsDir, "review.md"),
			"---\ndescription: Architecture-aware code review with Pharaoh\n---\n\nstale body\n---\n\nHere is the task to review:\n\n$ARGUMENTS\n",
		);

		const result = runInstallSkills(home, NO_CLI);

		expect(result.keptCommands).toEqual([]);
		expect(readFileSync(join(commandsDir, "plan.md"), "utf-8")).toContain("Pharaoh Reconnaissance");
		expect(readFileSync(join(commandsDir, "review.md"), "utf-8")).toContain("Phase 0");
	});

	it("SC-7: does not write through a symlink at the destination", () => {
		const commandsDir = join(home, ".claude", "commands");
		mkdirSync(commandsDir, { recursive: true });
		const target = join(home, "elsewhere.md");
		writeFileSync(target, `${PHARAOH_COMMAND_MARKER}\nLINK TARGET\n`);
		symlinkSync(target, join(commandsDir, "review.md"));

		const result = runInstallSkills(home, NO_CLI);

		expect(readFileSync(target, "utf-8")).toContain("LINK TARGET");
		expect(result.keptCommands).toEqual(["review.md"]);
	});

	it("SC-7: removes its own retired sessions.md, never a user's file or a symlink", () => {
		const commandsDir = join(home, ".claude", "commands");
		const sessions = join(commandsDir, "sessions.md");
		mkdirSync(commandsDir, { recursive: true });
		writeFileSync(sessions, `---\ndescription: old\n${PHARAOH_COMMAND_MARKER}\n---\nbody\n`);

		runInstallSkills(home, NO_CLI);
		expect(existsSync(sessions)).toBe(false);

		writeFileSync(sessions, "# my own /sessions\nUSER CONTENT\n");
		runInstallSkills(home, NO_CLI);
		expect(readFileSync(sessions, "utf-8")).toContain("USER CONTENT");

		rmSync(sessions);
		const target = join(home, "elsewhere.md");
		writeFileSync(target, `${PHARAOH_COMMAND_MARKER}\nLINK TARGET\n`);
		symlinkSync(target, sessions);
		runInstallSkills(home, NO_CLI);
		expect(readFileSync(sessions, "utf-8")).toContain("LINK TARGET");
	});

	it("SC-8: creates ~/.pharaoh with mode 0700 and repairs a looser mode on the next run", () => {
		expect(existsSync(join(home, ".pharaoh"))).toBe(false);

		runInstallSkills(home, NO_CLI);
		expect((statSync(join(home, ".pharaoh")).mode & 0o777).toString(8)).toBe("700");

		chmodSync(join(home, ".pharaoh"), 0o755);
		runInstallSkills(home, NO_CLI);
		expect((statSync(join(home, ".pharaoh")).mode & 0o777).toString(8)).toBe("700");
	});

	it("leaves unrelated slash command files in ~/.claude/commands/ untouched", () => {
		const commandsDir = join(home, ".claude", "commands");
		mkdirSync(commandsDir, { recursive: true });
		writeFileSync(join(commandsDir, "my-custom-command.md"), "user's custom content");

		runInstallSkills(home, NO_CLI);

		const untouched = readFileSync(join(commandsDir, "my-custom-command.md"), "utf-8");
		expect(untouched).toBe("user's custom content");
	});
});

// ── runInstallSkills — both platforms ────────────────────────────────

describe("runInstallSkills — both platforms", () => {
	let home: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".claude"), { recursive: true });
		mkdirSync(join(home, ".openclaw"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("installs to both Claude Code and OpenClaw when both exist", () => {
		runInstallSkills(home, NO_CLI);

		expect(existsSync(join(pluginDir(home), "skills", "plan", "SKILL.md"))).toBe(true);
		expect(existsSync(join(home, ".openclaw", "skills", "pharaoh", "SKILL.md"))).toBe(true);
		expect(existsSync(join(home, ".openclaw", "skills", "pharaoh-plan", "SKILL.md"))).toBe(true);
	});
});

// Breaks when the Codex install writes more than review, keeps the bare `name:`, or runs
// the OpenClaw path's bare-name cleanup in ~/.agents/skills/, which other tools share.
describe("runInstallSkills — Codex", () => {
	let home: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".codex"));
		for (const own of ["review", "plan"]) {
			mkdirSync(join(home, ".agents", "skills", own), { recursive: true });
			writeFileSync(join(home, ".agents", "skills", own, "SKILL.md"), "the user's own skill");
		}
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("installs only review, as pharaoh-review, and leaves the user's skills alone", () => {
		runInstallSkills(home, NO_CLI);

		const skills = join(home, ".agents", "skills");
		expect(readFileSync(join(skills, "pharaoh-review", "SKILL.md"), "utf-8")).toMatch(
			/^---\nname: pharaoh-review\n/,
		);
		expect(existsSync(join(skills, "pharaoh-plan"))).toBe(false);
		expect(existsSync(join(skills, "pharaoh"))).toBe(false);
		expect(readFileSync(join(skills, "review", "SKILL.md"), "utf-8")).toBe("the user's own skill");
		expect(readFileSync(join(skills, "plan", "SKILL.md"), "utf-8")).toBe("the user's own skill");
	});

	// Breaks when a Codex install error escapes: interactive setup would stop before
	// it replaces the blanket mcp__pharaoh permission rule (SC-6).
	it("reports a Codex install error instead of throwing", () => {
		rmSync(join(home, ".agents"), { recursive: true, force: true });
		writeFileSync(join(home, ".agents"), "not a directory");

		expect(() => runInstallSkills(home, { ...NO_CLI, silent: true })).not.toThrow();
	});
});

describe("runInstallSkills — no platform", () => {
	let home: string;

	beforeEach(() => {
		home = makeTempHome();
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("does not create any directories when no platform detected", () => {
		expect(() => runInstallSkills(home, NO_CLI)).not.toThrow();

		expect(existsSync(join(home, ".claude"))).toBe(false);
		expect(existsSync(join(home, ".openclaw"))).toBe(false);
		expect(existsSync(join(home, ".agents"))).toBe(false);
		expect(existsSync(join(home, ".pharaoh"))).toBe(false);
	});
});

describe("uninstallClaudePlugin", () => {
	let home: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".claude"), { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("uninstalls through the claude CLI and removes the local marketplace", () => {
		runInstallSkills(home, NO_CLI);
		const claude = recordingClaude();

		uninstallClaudePlugin(home, claude.run);

		expect(claude.calls).toEqual([
			"plugin uninstall pharaoh@pharaoh",
			"plugin marketplace remove pharaoh",
		]);
		expect(existsSync(marketplaceDir(home))).toBe(false);
	});
});

// ── OpenClaw skill install ──────────────────────────────────────────

describe("installSkills", () => {
	let home: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".openclaw"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("copies all 8 skill directories to ~/.openclaw/skills/ with pharaoh- prefix", () => {
		const skillsDir = join(home, ".openclaw", "skills");
		expect(existsSync(skillsDir)).toBe(false);
		const count = installSkills(home);
		expect(count).toBe(8);

		// Core skill stays unprefixed (no pharaoh-pharaoh); the others get the prefix.
		const core = readFileSync(join(skillsDir, "pharaoh", "SKILL.md"), "utf-8");
		expect(core).toMatch(/^---\n[\s\S]*?name:\s*pharaoh\n/);
		expect(existsSync(join(skillsDir, "pharaoh-pharaoh"))).toBe(false);
		expect(existsSync(join(skillsDir, "pharaoh-tdd", "SKILL.md"))).toBe(true);
		// Only `name:` is rewritten; prompt-name and the body are copied verbatim.
		const plan = readFileSync(join(skillsDir, "pharaoh-plan", "SKILL.md"), "utf-8");
		const source = readFileSync(join(__dirname, "..", "skills", "plan", "SKILL.md"), "utf-8");
		const stripName = (s: string) => s.replace(/^name:\s*.+$/m, "");
		expect(plan).toMatch(/^---\n[\s\S]*?name:\s*pharaoh-plan\n/);
		expect(stripName(plan)).toBe(stripName(source));
		// The vision skill was removed with the vision tools.
		expect(existsSync(join(skillsDir, "pharaoh-vision"))).toBe(false);
		// Bare-name variants must not exist.
		expect(existsSync(join(skillsDir, "plan"))).toBe(false);
		expect(existsSync(join(skillsDir, "tdd"))).toBe(false);
	});

	it("overwrites existing skill files on reinstall", () => {
		installSkills(home);

		const skillFile = join(home, ".openclaw", "skills", "pharaoh", "SKILL.md");
		writeFileSync(skillFile, "tampered content");
		expect(readFileSync(skillFile, "utf-8")).toBe("tampered content");

		installSkills(home);
		expect(readFileSync(skillFile, "utf-8")).not.toBe("tampered content");
	});
});

// ── OpenClaw config merge ───────────────────────────────────────────

describe("mergeOpenClawConfig", () => {
	let home: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".openclaw"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("creates openclaw.json with pharaoh entry when file does not exist", () => {
		const configPath = join(home, ".openclaw", "openclaw.json");
		expect(existsSync(configPath)).toBe(false);

		const updated = mergeOpenClawConfig(home);
		expect(updated).toBe(true);
		expect(existsSync(configPath)).toBe(true);

		const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers).toBeDefined();
		expect(config.mcpServers.pharaoh).toEqual({ command: "npx", args: [PINNED_SPEC] });
	});

	it("merges pharaoh entry into existing config without overwriting other keys", () => {
		const configPath = join(home, ".openclaw", "openclaw.json");
		const existing = {
			theme: "dark",
			mcpServers: {
				other: { command: "node", args: ["other.js"] },
			},
		};
		writeFileSync(configPath, JSON.stringify(existing));

		const updated = mergeOpenClawConfig(home);
		expect(updated).toBe(true);

		const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
			theme: string;
			mcpServers: Record<string, unknown>;
		};

		expect(config.theme).toBe("dark");
		expect(config.mcpServers.other).toEqual({ command: "node", args: ["other.js"] });
		expect(config.mcpServers.pharaoh).toEqual({ command: "npx", args: [PINNED_SPEC] });
	});

	it("SC-2: re-pins an entry an earlier version wrote, so an upgrade moves OpenClaw with it", () => {
		const configPath = join(home, ".openclaw", "openclaw.json");
		writeFileSync(
			configPath,
			JSON.stringify({ mcpServers: { pharaoh: { command: "npx", args: ["@pharaoh-so/mcp"] } } }),
		);

		expect(mergeOpenClawConfig(home)).toBe(true);

		const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers.pharaoh).toEqual({ command: "npx", args: [PINNED_SPEC] });
	});

	it("does not overwrite existing pharaoh entry and returns false", () => {
		const configPath = join(home, ".openclaw", "openclaw.json");
		const existing = {
			mcpServers: {
				pharaoh: { command: "node", args: ["custom.js"] },
			},
		};
		writeFileSync(configPath, JSON.stringify(existing));

		const updated = mergeOpenClawConfig(home);
		expect(updated).toBe(false);

		const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(config.mcpServers.pharaoh).toEqual({ command: "node", args: ["custom.js"] });
	});

	it("refuses to overwrite corrupted openclaw.json and returns false", () => {
		const configPath = join(home, ".openclaw", "openclaw.json");
		writeFileSync(configPath, "not valid json {{{");

		const updated = mergeOpenClawConfig(home);
		expect(updated).toBe(false);

		expect(readFileSync(configPath, "utf-8")).toBe("not valid json {{{");
	});
});

// ── parseArgs backward compat ───────────────────────────────────────

describe("parseArgs backward compat — --install-skills is not a parseArgs concern", () => {
	it("parseArgs ignores unknown flags without throwing", () => {
		expect(() => parseArgs(["--server", "https://mcp.pharaoh.so"])).not.toThrow();
	});

	it("parseArgs returns defaults when called with no args", () => {
		const result = parseArgs([]);
		expect(result.logout).toBe(false);
		expect(result.server).toBe("https://mcp.pharaoh.so");
	});

	it("parseArgs still handles --logout correctly", () => {
		const result = parseArgs(["--logout"]);
		expect(result.logout).toBe(true);
	});

	it("parseArgs still handles --server correctly", () => {
		const result = parseArgs(["--server", "https://custom.example.com"]);
		expect(result.server).toBe("https://custom.example.com");
	});
});

// ── Claude Code permissions (SC-6) ──────────────────────────────────
//
// Breaks when: a proxy start touches permissions.allow again, the installer
// creates settings.json, a blanket `mcp__pharaoh` rule (which also covers
// account deletion and admin tools) is written or left in place, or the
// explicit list drifts from the bundled catalog.

describe("SC-6: runInstallSkills never edits Claude Code permissions", () => {
	let home: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".claude"), { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("leaves permissions.allow alone (a destructive tool must still prompt)", () => {
		const settingsPath = join(home, ".claude", "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));

		runInstallSkills(home, NO_CLI);

		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			permissions?: { allow?: string[] };
		};
		expect(settings.permissions?.allow).toEqual(["Bash(ls:*)"]);
	});

	it("does not create ~/.claude/settings.json just to add an allow rule", () => {
		runInstallSkills(home, NO_CLI);

		expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
	});
});

describe("SC-6: allowReadTools (interactive setup only)", () => {
	let home: string;
	let settingsPath: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".claude"), { recursive: true });
		settingsPath = join(home, ".claude", "settings.json");
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	const readAllow = () =>
		(JSON.parse(readFileSync(settingsPath, "utf-8")) as { permissions: { allow: string[] } })
			.permissions.allow;

	it("allow-lists the read tools and pharaoh_account by full name, never a prefix or a destructive tool", () => {
		writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));

		expect(allowReadTools(home)).toBe("added");

		expect(readAllow()).toEqual(["Bash(ls:*)", ...PHARAOH_ALLOW_RULES]);
		expect(PHARAOH_ALLOW_RULES).toEqual([
			"mcp__pharaoh__get_codebase_map",
			"mcp__pharaoh__get_module_context",
			"mcp__pharaoh__search_functions",
			"mcp__pharaoh__get_blast_radius",
			"mcp__pharaoh__get_unused_code",
			"mcp__pharaoh__pharaoh_recon",
			"mcp__pharaoh__pharaoh_account",
		]);
	});

	it("names only tools in the bundled catalog, none of them destructive", () => {
		const catalog = JSON.parse(
			readFileSync(join(__dirname, "..", "inspect-tools.json"), "utf-8"),
		) as { tools: { name: string; annotations?: { destructiveHint?: boolean } }[] };
		const byName = new Map(catalog.tools.map((t) => [`mcp__pharaoh__${t.name}`, t]));
		for (const rule of PHARAOH_ALLOW_RULES) {
			expect(byName.get(rule), rule).toBeDefined();
			expect(byName.get(rule)?.annotations?.destructiveHint, rule).toBe(false);
		}
	});

	it("does not create settings.json when the user has none", () => {
		expect(allowReadTools(home)).toBe("no-settings");
		expect(existsSync(settingsPath)).toBe(false);
	});

	it("replaces the blanket mcp__pharaoh rule an earlier version wrote", () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({ permissions: { allow: ["Bash(ls:*)", "mcp__pharaoh", "mcp__pencil"] } }),
		);

		expect(allowReadTools(home)).toBe("migrated");

		expect(readAllow()).toEqual(["Bash(ls:*)", "mcp__pencil", ...PHARAOH_ALLOW_RULES]);
	});

	it("is idempotent and preserves every other setting", () => {
		const existing = {
			hooks: { PreToolUse: [{ matcher: "Grep", hooks: [] }] },
			permissions: { allow: ["mcp__pencil"], deny: ["Bash(rm -rf)"] },
			enabledPlugins: { "some-plugin": true },
			effortLevel: "high",
		};
		writeFileSync(settingsPath, JSON.stringify(existing));

		expect(allowReadTools(home)).toBe("added");
		expect(allowReadTools(home)).toBe("current");

		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as typeof existing;
		expect(settings.hooks).toEqual(existing.hooks);
		expect(settings.permissions.allow).toEqual(["mcp__pencil", ...PHARAOH_ALLOW_RULES]);
		expect(settings.permissions.deny).toEqual(["Bash(rm -rf)"]);
		expect(settings.enabledPlugins).toEqual({ "some-plugin": true });
		expect(settings.effortLevel).toBe("high");
	});

	it("leaves a corrupted settings.json alone", () => {
		writeFileSync(settingsPath, "not valid json {{{");

		expect(allowReadTools(home)).toBe("error");
		expect(readFileSync(settingsPath, "utf-8")).toBe("not valid json {{{");
	});
});

// ── Manifest-based cleanup (regression armor for #788) ──────────────
//
// Pre-fix: `cleanupBareNameSkills` was forward-only — it could only remove
// bare-name dirs matching CURRENT source skills, so skills that were cut
// between versions (audit-tests, debt, execute, etc. from the 24→10 cut)
// kept accumulating in the installed skills dir. Dan's own machine had
// 28 dead dirs after upgrading from the pre-cut bundle, burning ~6K
// tokens/session via passive skill-description loading.
//
// Post-fix: every install writes a `.pharaoh-manifest.json` listing the
// bare names of skills installed in that run. The next install diffs
// the old manifest against current source and removes everything that
// was dropped between versions — both bare-name and `pharaoh-` prefixed
// variants. Backward-compatible: first run after the fix has no
// manifest, falls back to the legacy cleanup and writes a fresh one.

/**
 * Skills dir the manifest cleanup manages: OpenClaw's. (The Claude Code plugin
 * is rewritten whole on each version, so cut skills can't linger there.)
 */
function claudeCodeSkillsDir(home: string): string {
	return join(home, ".openclaw", "skills");
}

/** Read and parse the manifest. Throws if missing or malformed — tests use
 * this when they expect the file to exist. */
function readManifestOrThrow(home: string): {
	version: number;
	installedAt: string;
	skills: string[];
} {
	const manifestPath = join(claudeCodeSkillsDir(home), ".pharaoh-manifest.json");
	return JSON.parse(readFileSync(manifestPath, "utf-8")) as {
		version: number;
		installedAt: string;
		skills: string[];
	};
}

describe("manifest-based cleanup — first run (no manifest)", () => {
	let home: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".openclaw"), { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("writes a fresh manifest on first install", () => {
		runInstallSkills(home, NO_CLI);

		const manifest = readManifestOrThrow(home);
		expect(manifest.version).toBe(1);
		expect(typeof manifest.installedAt).toBe("string");
		expect(new Date(manifest.installedAt).toString()).not.toBe("Invalid Date");
		expect(Array.isArray(manifest.skills)).toBe(true);
		// The manifest tracks BARE source names so rename/cut diffs are
		// comparable against the source dir listing without prefix logic.
		expect(manifest.skills).toContain("pharaoh");
		expect(manifest.skills).toContain("plan");
		expect(manifest.skills).toContain("review");
		expect(manifest.skills).not.toContain("pharaoh-plan");

		// A repeat install with no source change keeps the same skill set.
		runInstallSkills(home, NO_CLI);
		expect(readManifestOrThrow(home).skills).toEqual(manifest.skills);
	});

	it("missing manifest + stale bare-name skill from legacy layout → legacy cleanup still runs", () => {
		// Regression armor for the legacy dual-layout migration that
		// `cleanupBareNameSkills` was originally built for. When a CURRENT
		// source skill has a bare-name variant left behind, it still gets
		// removed on first-run-after-fix. The manifest path is a pure
		// additive improvement — it doesn't disable this path.
		const skillsDir = claudeCodeSkillsDir(home);
		mkdirSync(join(skillsDir, "plan"), { recursive: true });
		writeFileSync(join(skillsDir, "plan", "SKILL.md"), "---\nname: plan\n---\n");
		// Another plugin's skill in the same dir: with no manifest, nothing says it is ours.
		const unrelated = join(skillsDir, "superpowers-writing-skills", "SKILL.md");
		mkdirSync(dirname(unrelated), { recursive: true });
		writeFileSync(unrelated, "unrelated plugin content");

		runInstallSkills(home, NO_CLI);

		expect(existsSync(join(skillsDir, "plan"))).toBe(false);
		expect(existsSync(join(skillsDir, "pharaoh-plan", "SKILL.md"))).toBe(true);
		expect(readFileSync(unrelated, "utf-8")).toBe("unrelated plugin content");
		// Manifest gets written even though only legacy cleanup ran
		expect(existsSync(join(skillsDir, ".pharaoh-manifest.json"))).toBe(true);
	});

	it("corrupted manifest → treated as missing, fresh one written", () => {
		// Pre-create a garbage manifest. The install must not crash and must
		// replace the file with a valid one.
		const skillsDir = claudeCodeSkillsDir(home);
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, ".pharaoh-manifest.json"), "not json {{{");

		expect(() => runInstallSkills(home, NO_CLI)).not.toThrow();

		const manifest = readManifestOrThrow(home);
		expect(manifest.version).toBe(1);
		expect(manifest.skills).toContain("plan");
	});
});

describe("manifest-based cleanup — cut skills between versions", () => {
	let home: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".openclaw"), { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	/** Install once, then corrupt the manifest to simulate a prior install
	 * that had extra skills cut between versions. Returns paths for assertions. */
	function simulatePriorInstallWithCuts(cutSkills: string[]): {
		skillsDir: string;
		manifestPath: string;
	} {
		runInstallSkills(home, NO_CLI);

		const skillsDir = claudeCodeSkillsDir(home);
		const manifestPath = join(skillsDir, ".pharaoh-manifest.json");

		// Add cut skills to the stored manifest so the NEXT install sees them
		// as "removed between versions" and cleans them up.
		const manifest = readManifestOrThrow(home);
		manifest.skills = [...manifest.skills, ...cutSkills];
		writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));

		return { skillsDir, manifestPath };
	}

	it("removes bare and prefixed copies of every cut or renamed skill, and nothing else", () => {
		// `planning-v2` stands for a rename: the old name is cut, the new one (plan) installed.
		const { skillsDir } = simulatePriorInstallWithCuts(["debt", "execute", "planning-v2"]);
		const stale = ["debt", "pharaoh-debt", "execute", "pharaoh-planning-v2"];
		for (const dir of stale) {
			mkdirSync(join(skillsDir, dir), { recursive: true });
			writeFileSync(join(skillsDir, dir, "SKILL.md"), `---\nname: ${dir}\n---\n`);
		}
		const unrelated = join(skillsDir, "superpowers-writing-skills", "SKILL.md");
		mkdirSync(dirname(unrelated), { recursive: true });
		writeFileSync(unrelated, "unrelated plugin content");

		runInstallSkills(home, NO_CLI);

		for (const dir of stale) expect(existsSync(join(skillsDir, dir)), dir).toBe(false);
		expect(readFileSync(unrelated, "utf-8")).toBe("unrelated plugin content");
		expect(existsSync(join(skillsDir, "pharaoh-plan", "SKILL.md"))).toBe(true);
		expect(readManifestOrThrow(home).skills).not.toContain("debt");
	});

	it("refuses to delete the pharaoh flagship even if listed as cut", () => {
		// Defensive: if someone corrupts the manifest to claim the flagship
		// was cut, we must not delete it. The exempt-name check is the only
		// thing preventing a self-destruct here.
		const { skillsDir, manifestPath } = simulatePriorInstallWithCuts([]);
		const manifest = readManifestOrThrow(home);
		manifest.skills = manifest.skills.filter((s) => s !== "pharaoh");
		// Re-append to force the diff logic to see it as "in oldManifest but
		// not in current source" even though the flagship IS in current source.
		// In practice the flagship is exempt by name, not by source-membership.
		writeFileSync(
			manifestPath,
			JSON.stringify({ ...manifest, skills: [...manifest.skills, "pharaoh"] }, null, "\t"),
		);

		runInstallSkills(home, NO_CLI);

		expect(existsSync(join(skillsDir, "pharaoh", "SKILL.md"))).toBe(true);
	});
});
