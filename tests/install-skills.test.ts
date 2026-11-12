/**
 * Tests for --install-skills: the Claude Code plugin (a local marketplace
 * installed through `claude plugin`), OpenClaw install, detection, config
 * merging, and backward compat of parseArgs.
 */
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
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
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureClients, verifiedCodingClients } from "../src/client-install.js";
import { askChoice, askYesNo, parseArgs } from "../src/helpers.js";
import {
	allowReadTools,
	CODEX_SKILLS,
	claudePluginState,
	describeAgentInstructionOutcome,
	describeClaudeMdOutcome,
	installSkills,
	instructionStates,
	mergeOpenClawConfig,
	offerAgentInstructionLines,
	offerClaudeMdLine,
	PHARAOH_ALLOW_RULES,
	PHARAOH_COMMAND_MARKER,
	runInstallSkills,
	uninstallClaudePlugin,
} from "../src/install-skills.js";
import type { ClientInstallOptions, ClientTarget, LaunchConfig } from "../src/install-types.js";

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

	// The proxy reports this state to Pharaoh. Breaks when a disabled plugin reads
	// as enabled, or a settings file that doesn't list it (or none) reads as anything but absent.
	it("reads the plugin's state from settings.json", () => {
		const settings = join(home, ".claude", "settings.json");
		const states = [claudePluginState(home)];
		writeFileSync(settings, JSON.stringify({ permissions: { allow: [] } }));
		states.push(claudePluginState(home));
		writeFileSync(settings, JSON.stringify({ enabledPlugins: { "pharaoh@pharaoh": false } }));
		states.push(claudePluginState(home));
		writeFileSync(settings, JSON.stringify({ enabledPlugins: { "pharaoh@pharaoh": true } }));
		states.push(claudePluginState(home));

		expect(states).toEqual(["absent", "absent", "disabled", "enabled"]);
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

// Breaks when Codex receives Claude-only activation rules or an install overwrites
// user skills in the shared ~/.agents/skills directory.
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

	it("installs the portable skills with Codex names and preserves the user's skills", () => {
		runInstallSkills(home, NO_CLI);

		const skills = join(home, ".agents", "skills");
		expect(readFileSync(join(skills, "pharaoh-review", "SKILL.md"), "utf-8")).toMatch(
			/^---\nname: pharaoh-review\n/,
		);
		for (const name of CODEX_SKILLS) {
			const installed = name === "pharaoh" ? name : `pharaoh-${name}`;
			expect(readFileSync(join(skills, installed, "SKILL.md"), "utf-8")).toMatch(
				new RegExp(`^---\\nname: ${installed}\\n`),
			);
		}
		const guide = readFileSync(join(skills, "pharaoh", "SKILL.md"), "utf-8");
		expect(guide).toContain("invoke it as `$pharaoh`");
		expect(guide).not.toContain("This skill loads automatically");
		expect(readFileSync(join(skills, "pharaoh-plan", "SKILL.md"), "utf-8")).not.toContain(
			"AskUserQuestion",
		);
		expect(readFileSync(join(skills, "review", "SKILL.md"), "utf-8")).toBe("the user's own skill");
		expect(readFileSync(join(skills, "plan", "SKILL.md"), "utf-8")).toBe("the user's own skill");
	});

	it("keeps custom prefixed skills and modifications to an installed skill", () => {
		const skills = join(home, ".agents", "skills");
		mkdirSync(join(skills, "pharaoh-plan"));
		writeFileSync(join(skills, "pharaoh-plan", "SKILL.md"), "My own planning skill.");
		runInstallSkills(home, NO_CLI);
		expect(readFileSync(join(skills, "pharaoh-plan", "SKILL.md"), "utf-8")).toBe(
			"My own planning skill.",
		);
		const review = join(skills, "pharaoh-review", "SKILL.md");
		appendFileSync(review, "\nMy own addition.\n");
		const changed = readFileSync(review, "utf-8");
		runInstallSkills(home, NO_CLI);
		expect(readFileSync(review, "utf-8")).toBe(changed);
	});

	it("cleanup removes unmodified owned skills and preserves custom or edited skills", () => {
		runInstallSkills(home, NO_CLI);
		const skills = join(home, ".agents", "skills");
		const edited = join(skills, "pharaoh-plan", "SKILL.md");
		appendFileSync(edited, "\nMy addition.\n");
		const before = readFileSync(edited, "utf-8");
		uninstallClaudePlugin(home, NO_CLI.claude);
		expect(existsSync(join(skills, "pharaoh-review"))).toBe(false);
		expect(readFileSync(edited, "utf-8")).toBe(before);
		expect(readFileSync(join(skills, "plan", "SKILL.md"), "utf-8")).toBe("the user's own skill");
	});

	it("recognizes the exact legacy review and records ownership without replacing custom files", () => {
		const review = join(home, ".agents", "skills", "pharaoh-review");
		mkdirSync(review);
		const source = readFileSync(join(__dirname, "..", "npx-skills", "review", "SKILL.md"), "utf-8");
		writeFileSync(
			join(review, "SKILL.md"),
			source.replace(/^name: review$/m, "name: pharaoh-review"),
		);
		runInstallSkills(home, NO_CLI);
		expect(existsSync(join(review, ".pharaoh-managed-skill.json"))).toBe(true);
		const once = readFileSync(join(review, "SKILL.md"), "utf-8");
		runInstallSkills(home, NO_CLI);
		expect(readFileSync(join(review, "SKILL.md"), "utf-8")).toBe(once);
	});

	it("detects CODEX_HOME while keeping personal skills in ~/.agents/skills", () => {
		const configured = join(home, "codex-profile");
		mkdirSync(configured);
		rmSync(join(home, ".codex"), { recursive: true });
		vi.stubEnv("CODEX_HOME", configured);
		try {
			runInstallSkills(home, NO_CLI);
			expect(existsSync(join(home, ".agents", "skills", "pharaoh", "SKILL.md"))).toBe(true);
			expect(existsSync(join(configured, "skills"))).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("continues Codex skill setup when optional Claude Code setup fails", () => {
		mkdirSync(join(home, ".claude"));
		writeFileSync(join(home, ".claude", "commands"), "not a directory");
		const result = runInstallSkills(home, {
			...NO_CLI,
			silent: true,
			clients: ["claude-code", "codex"],
		});
		expect(result.errors).toHaveLength(1);
		expect(existsSync(join(home, ".agents", "skills", "pharaoh-plan", "SKILL.md"))).toBe(true);
	});

	it("limits interactive skill setup to the verified enabled clients", () => {
		mkdirSync(join(home, ".claude"));
		runInstallSkills(home, { ...NO_CLI, clients: ["codex"] });
		expect(existsSync(join(home, ".agents", "skills", "pharaoh-plan", "SKILL.md"))).toBe(true);
		expect(existsSync(marketplaceDir(home))).toBe(false);
		expect(existsSync(join(home, ".claude", "commands"))).toBe(false);
	});

	// Breaks when a Codex install error escapes: interactive setup would stop before
	// it replaces the blanket mcp__pharaoh permission rule (SC-6).
	it("reports a Codex install error instead of throwing", () => {
		rmSync(join(home, ".agents"), { recursive: true, force: true });
		writeFileSync(join(home, ".agents"), "not a directory");

		expect(() => runInstallSkills(home, { ...NO_CLI, silent: true })).not.toThrow();
	});
});

describe("automatic skill setup for verified coding clients", () => {
	let home: string;
	let launch: LaunchConfig;
	let options: ClientInstallOptions;
	let targets: ClientTarget[];
	beforeEach(() => {
		home = makeTempHome();
		vi.stubEnv("CODEX_HOME", undefined);
		vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
		mkdirSync(join(home, ".claude"));
		mkdirSync(join(home, ".codex"));
		mkdirSync(join(home, "runtime", "dist"), { recursive: true });
		const entry = join(home, "runtime", "dist", "index.js");
		writeFileSync(entry, "// installed runtime fixture\n");
		launch = { command: process.execPath, args: [entry] };
		options = {
			home,
			env: { PATH: "" },
			platform: "linux",
			execute: () => {
				throw new Error("CLI unavailable");
			},
		};
		targets = [
			{ client: "claude-code", path: join(home, ".claude.json") },
			{ client: "codex", path: join(home, ".codex", "config.toml") },
		];
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("directory presence and custom or disabled registrations never authorize startup writes", () => {
		writeFileSync(
			targets[0].path,
			JSON.stringify({ mcpServers: { pharaoh: { url: "https://custom.example/mcp" } } }),
		);
		writeFileSync(targets[1].path, '[mcp_servers.pharaoh]\ncommand = "custom"\nenabled = false\n');
		const clients = verifiedCodingClients({ ...options, runningLaunch: launch });
		expect(clients).toEqual([]);
		runInstallSkills(home, { ...NO_CLI, silent: true, clients });
		expect(existsSync(join(home, ".claude", "commands"))).toBe(false);
		expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
		expect(existsSync(marketplaceDir(home))).toBe(false);
		expect(existsSync(join(home, ".agents"))).toBe(false);
	});

	it("updates owned Codex skills while preserving an excluded Claude configuration", () => {
		expect(configureClients(targets, launch, options).map(({ status }) => status)).toEqual([
			"configured",
			"configured",
		]);
		const claude = JSON.stringify({
			mcpServers: { pharaoh: { url: "https://custom.example/mcp" } },
			disabledMcpServers: ["pharaoh"],
		});
		writeFileSync(targets[0].path, claude);
		const clients = verifiedCodingClients({ ...options, runningLaunch: launch });
		expect(clients).toEqual(["codex"]);
		runInstallSkills(home, { ...NO_CLI, silent: true, clients });
		expect(existsSync(join(home, ".agents", "skills", "pharaoh-review", "SKILL.md"))).toBe(true);
		expect(readFileSync(targets[0].path, "utf-8")).toBe(claude);
		expect(existsSync(join(home, ".claude", "commands"))).toBe(false);
		expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
		expect(existsSync(marketplaceDir(home))).toBe(false);
	});

	it("skips even owned registrations when the running runtime does not match", () => {
		configureClients(targets, launch, options);
		const other = { ...launch, args: [join(home, "other-runtime", "index.js")] };
		const clients = verifiedCodingClients({ ...options, runningLaunch: other });
		expect(clients).toEqual([]);
		runInstallSkills(home, { ...NO_CLI, silent: true, clients });
		expect(existsSync(join(home, ".agents"))).toBe(false);
		expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
		expect(existsSync(marketplaceDir(home))).toBe(false);
	});
});

describe("personal Claude Code skills without its CLI", () => {
	let home: string;
	beforeEach(() => {
		home = makeTempHome();
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("installs supported personal skills for a verified desktop-only coding client", () => {
		const result = runInstallSkills(home, { ...NO_CLI, silent: true, clients: ["claude-code"] });
		expect(result.errors).toEqual([]);
		expect(result.warnings.join(" ")).toContain("plugin hooks are inactive");
		for (const name of CODEX_SKILLS) {
			const installed = name === "pharaoh" ? name : `pharaoh-${name}`;
			expect(existsSync(join(home, ".claude", "skills", installed, "SKILL.md"))).toBe(true);
		}
		expect(readFileSync(join(home, ".claude", "skills", "pharaoh", "SKILL.md"), "utf-8")).toContain(
			"invoke it as `/pharaoh`",
		);
		expect(existsSync(join(home, ".agents"))).toBe(false);
		uninstallClaudePlugin(home, NO_CLI.claude);
		expect(existsSync(join(home, ".claude", "skills", "pharaoh-plan"))).toBe(false);
	});

	it("keeps a user's personal workflow skill when fallback installation runs", () => {
		const own = join(home, ".claude", "skills", "pharaoh-plan");
		mkdirSync(own, { recursive: true });
		writeFileSync(join(own, "SKILL.md"), "My planning workflow.");
		runInstallSkills(home, { ...NO_CLI, silent: true, clients: ["claude-code"] });
		expect(readFileSync(join(own, "SKILL.md"), "utf-8")).toBe("My planning workflow.");
		uninstallClaudePlugin(home, NO_CLI.claude);
		expect(readFileSync(join(own, "SKILL.md"), "utf-8")).toBe("My planning workflow.");
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
		// Only `name:` is rewritten; the rest is npx's render, copied verbatim (never the
		// source in skills/, whose channel markers and connector text would reach the user).
		const review = readFileSync(join(skillsDir, "pharaoh-review", "SKILL.md"), "utf-8");
		const source = readFileSync(join(__dirname, "..", "npx-skills", "review", "SKILL.md"), "utf-8");
		const stripName = (s: string) => s.replace(/^name:\s*.+$/m, "");
		expect(review).toMatch(/^---\n[\s\S]*?name:\s*pharaoh-review\n/);
		expect(stripName(review)).toBe(stripName(source));
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

	it("allow-lists the read-only tools by full name, never a prefix or a tool that changes something", () => {
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
			"mcp__pharaoh__pharaoh_setup",
		]);
	});

	// Breaks when a tool that changes something (pharaoh_manage_repo) is
	// allow-listed, or a read-only tool is left out and prompts for nothing.
	it("allow-lists exactly the bundled catalog's read-only tools", () => {
		const catalog = JSON.parse(
			readFileSync(join(__dirname, "..", "inspect-tools.json"), "utf-8"),
		) as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
		const readOnly = catalog.tools
			.filter((t) => t.annotations?.readOnlyHint === true)
			.map((t) => `mcp__pharaoh__${t.name}`);
		expect([...PHARAOH_ALLOW_RULES].sort()).toEqual(readOnly.sort());
		expect(catalog.tools.map((t) => t.name)).toContain("pharaoh_manage_repo");
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

describe("the shared coding-agent instruction consent", () => {
	const line =
		"In repos Pharaoh has mapped, before searching or reading files, ask Pharaoh where the relevant code is, what calls it, and whether what you need already exists.";
	let home: string;
	beforeEach(() => {
		home = makeTempHome();
		vi.stubEnv("CODEX_HOME", undefined);
		vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("asks once for both verified clients and preserves their existing instructions", async () => {
		mkdirSync(join(home, ".claude"));
		mkdirSync(join(home, ".codex"));
		const claude = join(home, ".claude", "CLAUDE.md");
		const codex = join(home, ".codex", "AGENTS.md");
		writeFileSync(claude, "My Claude rules.\n");
		writeFileSync(codex, "My Codex rules.");
		const ask = vi.fn(async () => true);
		const results = await offerAgentInstructionLines(["claude-code", "codex"], ask, true, home);
		expect(ask).toHaveBeenCalledTimes(1);
		expect(ask).toHaveBeenCalledWith(
			`Add this Pharaoh line to your global agent instructions?\n  ${claude} and ${codex}\n  "${line}"\n[Y/n] `,
		);
		expect(results.map((result) => result.outcome)).toEqual(["added", "added"]);
		expect(readFileSync(claude, "utf-8")).toContain(`My Claude rules.\n<!-- pharaoh-mcp:start`);
		expect(readFileSync(codex, "utf-8")).toContain(`My Codex rules.\n<!-- pharaoh-mcp:start+nl`);
		expect(readFileSync(codex, "utf-8")).toContain(line);
		ask.mockClear();
		expect(
			(await offerAgentInstructionLines(["claude-code", "codex"], ask, true, home)).map(
				(result) => result.outcome,
			),
		).toEqual(["current", "current"]);
		expect(ask).not.toHaveBeenCalled();
		uninstallClaudePlugin(home, NO_CLI.claude);
		expect(readFileSync(claude, "utf-8")).toBe("My Claude rules.\n");
		expect(readFileSync(codex, "utf-8")).toBe("My Codex rules.");
	});

	it("honors CODEX_HOME and only touches requested clients", async () => {
		const configured = join(home, "codex-config");
		vi.stubEnv("CODEX_HOME", configured);
		const result = await offerAgentInstructionLines(["codex"], async () => true, true, home);
		expect(result[0]).toMatchObject({
			client: "codex",
			path: join(configured, "AGENTS.md"),
			outcome: "added",
		});
		expect(readFileSync(join(configured, "AGENTS.md"), "utf-8")).toContain(line);
		expect(existsSync(join(home, ".codex"))).toBe(false);
		expect(existsSync(join(home, ".claude"))).toBe(false);
	});

	it("writes to a nonempty Codex global override without changing AGENTS.md", async () => {
		mkdirSync(join(home, ".codex"));
		const agents = join(home, ".codex", "AGENTS.md");
		const override = join(home, ".codex", "AGENTS.override.md");
		writeFileSync(agents, "Regular rules.\n");
		writeFileSync(override, "Override rules.\n");
		const ask = vi.fn(async (_question: string) => true);
		const result = await offerAgentInstructionLines(["codex"], ask, true, home);
		expect(result[0]).toMatchObject({ path: override, outcome: "added" });
		expect(ask.mock.calls[0][0]).toContain(override);
		expect(readFileSync(override, "utf-8")).toContain(line);
		expect(readFileSync(agents, "utf-8")).toBe("Regular rules.\n");
	});

	it.each(["", " \n\t"])("falls back to AGENTS.md for an empty override %j", async (contents) => {
		mkdirSync(join(home, ".codex"));
		const override = join(home, ".codex", "AGENTS.override.md");
		writeFileSync(override, contents);
		const result = await offerAgentInstructionLines(["codex"], async () => true, true, home);
		expect(result[0]).toMatchObject({ path: join(home, ".codex", "AGENTS.md"), outcome: "added" });
		expect(readFileSync(override, "utf-8")).toBe(contents);
	});

	it("preserves an unsafe override and reports attention instead of trusting AGENTS.md", async () => {
		mkdirSync(join(home, ".codex"));
		const agents = join(home, ".codex", "AGENTS.md");
		const override = join(home, ".codex", "AGENTS.override.md");
		const target = join(home, "override.md");
		writeFileSync(agents, line + "\n");
		writeFileSync(target, "Private override rules.\n");
		symlinkSync(target, override);
		const ask = vi.fn(async () => true);
		const result = await offerAgentInstructionLines(["codex"], ask, true, home);
		expect(result[0]).toMatchObject({ path: override, outcome: "kept" });
		expect(describeAgentInstructionOutcome(result[0])).toContain("need attention");
		expect(ask).not.toHaveBeenCalled();
		expect(readFileSync(agents, "utf-8")).toBe(line + "\n");
		expect(readFileSync(target, "utf-8")).toBe("Private override rules.\n");
	});

	it.skipIf(process.getuid?.() === 0)(
		"preserves an unreadable higher-priority override",
		async () => {
			mkdirSync(join(home, ".codex"));
			const override = join(home, ".codex", "AGENTS.override.md");
			writeFileSync(override, "Private override rules.\n");
			chmodSync(override, 0o000);
			try {
				const ask = vi.fn(async () => true);
				expect((await offerAgentInstructionLines(["codex"], ask, true, home))[0]).toMatchObject({
					path: override,
					outcome: "kept",
				});
				expect(ask).not.toHaveBeenCalled();
				expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
			} finally {
				chmodSync(override, 0o600);
			}
			expect(readFileSync(override, "utf-8")).toBe("Private override rules.\n");
		},
	);

	it("cleans unchanged managed blocks from both global filenames when selection changes", async () => {
		mkdirSync(join(home, ".codex"));
		const agents = join(home, ".codex", "AGENTS.md");
		const override = join(home, ".codex", "AGENTS.override.md");
		writeFileSync(agents, "Regular rules.\n");
		await offerAgentInstructionLines(["codex"], async () => true, true, home);
		writeFileSync(override, "Override rules.\n");
		const ask = vi.fn(async () => true);
		expect((await offerAgentInstructionLines(["codex"], ask, true, home))[0]).toMatchObject({
			path: override,
			outcome: "added",
		});
		expect(ask).toHaveBeenCalledTimes(1);
		uninstallClaudePlugin(home, NO_CLI.claude);
		expect(readFileSync(agents, "utf-8")).toBe("Regular rules.\n");
		expect(readFileSync(override, "utf-8")).toBe("Override rules.\n");
	});

	it("does not add an inert cue if override precedence changes during consent", async () => {
		mkdirSync(join(home, ".codex"));
		const agents = join(home, ".codex", "AGENTS.md");
		const override = join(home, ".codex", "AGENTS.override.md");
		writeFileSync(agents, "Regular rules.\n");
		const result = await offerAgentInstructionLines(
			["codex"],
			async () => {
				writeFileSync(override, "New effective override.\n");
				return true;
			},
			true,
			home,
		);
		expect(result[0].outcome).toBe("kept");
		expect(readFileSync(agents, "utf-8")).toBe("Regular rules.\n");
		expect(readFileSync(override, "utf-8")).toBe("New effective override.\n");
	});

	it("records separate declines and never writes without interactive consent", async () => {
		const ask = vi.fn(async () => false);
		expect(
			(await offerAgentInstructionLines(["claude-code", "codex"], ask, false, home)).map(
				(result) => result.outcome,
			),
		).toEqual(["no-terminal", "no-terminal"]);
		expect(ask).not.toHaveBeenCalled();
		expect(existsSync(join(home, ".pharaoh"))).toBe(false);
		expect(
			(await offerAgentInstructionLines(["claude-code", "codex"], ask, true, home)).map(
				(result) => result.outcome,
			),
		).toEqual(["declined", "declined"]);
		expect(ask).toHaveBeenCalledTimes(1);
		ask.mockClear();
		expect(
			(await offerAgentInstructionLines(["codex", "claude-code"], ask, true, home)).map(
				(result) => result.outcome,
			),
		).toEqual(["answered", "answered"]);
		expect(ask).not.toHaveBeenCalled();
		expect(existsSync(join(home, ".codex"))).toBe(false);
	});

	it("preserves symlinks, invalid UTF-8 and broken managed blocks", async () => {
		mkdirSync(join(home, ".codex"));
		const agents = join(home, ".codex", "AGENTS.md");
		const target = join(home, "mine.md");
		writeFileSync(target, "mine\n");
		symlinkSync(target, agents);
		const ask = vi.fn(async () => true);
		expect((await offerAgentInstructionLines(["codex"], ask, true, home))[0].outcome).toBe("kept");
		expect(readFileSync(target, "utf-8")).toBe("mine\n");
		rmSync(agents);
		for (const content of [
			Buffer.from([0xff, 0xfe]),
			Buffer.from("<!-- pharaoh-mcp:start -->\nMissing end.\n"),
		]) {
			writeFileSync(agents, content);
			expect((await offerAgentInstructionLines(["codex"], ask, true, home))[0].outcome).toBe(
				"kept",
			);
			expect(readFileSync(agents)).toEqual(content);
		}
		expect(ask).not.toHaveBeenCalled();
	});

	it("cleanup preserves a changed Codex managed block and the user's lines around it", async () => {
		await offerAgentInstructionLines(["codex"], async () => true, true, home);
		const agents = join(home, ".codex", "AGENTS.md");
		const changed = `My rules.\n${readFileSync(agents, "utf-8").replace(line, "My own Pharaoh instruction.")}Below.\n`;
		writeFileSync(agents, changed);
		uninstallClaudePlugin(home, NO_CLI.claude);
		expect(readFileSync(agents, "utf-8")).toBe(changed);
	});

	it("rereads after the shared question and reports a swapped symlink without changing it", async () => {
		mkdirSync(join(home, ".codex"));
		const agents = join(home, ".codex", "AGENTS.md");
		const target = join(home, "mine.md");
		writeFileSync(agents, "before\n");
		writeFileSync(target, "mine\n");
		const result = await offerAgentInstructionLines(
			["codex"],
			async () => {
				rmSync(agents);
				symlinkSync(target, agents);
				return true;
			},
			true,
			home,
		);
		expect(result[0].outcome).toBe("kept");
		expect(describeAgentInstructionOutcome(result[0])).toContain("preserved");
		expect(readFileSync(target, "utf-8")).toBe("mine\n");
	});
});

// ── The Pharaoh-first line in ~/.claude/CLAUDE.md ───────────────────
//
// Breaks when: the line is written without a yes, on a proxy start or without
// a terminal; a re-run asks again, duplicates the block or ignores a no; the
// user's text around the block changes; a symlink is written through; or
// --clean/--logout (uninstallClaudePlugin) leaves the file other than it was.

describe("the Pharaoh-first line in ~/.claude/CLAUDE.md (interactive setup only)", () => {
	const LINE =
		"In repos Pharaoh has mapped, before searching or reading files, ask Pharaoh where the relevant code is, what calls it, and whether what you need already exists.";
	const START =
		"<!-- pharaoh-mcp:start (managed by npx @pharaoh-so/mcp; --clean or --logout removes it) -->";
	const BLOCK = `${START}\n${LINE}\n<!-- pharaoh-mcp:end -->\n`;
	let home: string;
	let claudeMd: string;
	let answer: string;

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".claude"), { recursive: true });
		claudeMd = join(home, ".claude", "CLAUDE.md");
		answer = join(home, ".pharaoh", "claude-md-answer");
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	/** A prompt stand-in that gives `reply` and counts how often it was asked. */
	const prompt = (reply: boolean | null) => {
		const asked = { count: 0 };
		const ask = async () => {
			asked.count++;
			return reply;
		};
		return { asked, ask };
	};
	const offer = (reply: boolean | null, terminal = true) => {
		const p = prompt(reply);
		return offerClaudeMdLine(p.ask, terminal, home).then((outcome) => ({ outcome, ...p.asked }));
	};
	const clean = () => uninstallClaudePlugin(home, NO_CLI.claude);

	it("asks once and writes the block; a re-run asks nothing and changes nothing", async () => {
		expect(await offer(true)).toEqual({ outcome: "added", count: 1 });
		expect(readFileSync(claudeMd, "utf-8")).toBe(BLOCK);
		expect((statSync(answer).mode & 0o777).toString(8)).toBe("600");

		expect(await offer(true)).toEqual({ outcome: "current", count: 0 });
		expect(readFileSync(claudeMd, "utf-8")).toBe(BLOCK);
	});

	it.each([
		["ending in a newline", "# Mine\n\nKeep this.\n", `# Mine\n\nKeep this.\n${BLOCK}`],
		[
			"with no final newline",
			"Keep this.",
			`Keep this.\n${START.replace("start", "start+nl")}\n${LINE}\n<!-- pharaoh-mcp:end -->\n`,
		],
		["that is empty", "", BLOCK],
	])("keeps the user's file %s, and --clean/--logout restore it byte for byte", async (_, mine, withBlock) => {
		writeFileSync(claudeMd, mine);

		expect((await offer(true)).outcome).toBe("added");
		expect(readFileSync(claudeMd, "utf-8")).toBe(withBlock);

		clean();
		expect(readFileSync(claudeMd, "utf-8")).toBe(mine);
		expect(existsSync(answer)).toBe(false);
	});

	it("replaces a stale block in place without asking, and its removal leaves the text around it", async () => {
		writeFileSync(
			claudeMd,
			"above\n<!-- pharaoh-mcp:start (old) -->\nOld line.\n<!-- pharaoh-mcp:end -->\nbelow\n",
		);

		expect(await offer(false)).toEqual({ outcome: "updated", count: 0 });
		expect(readFileSync(claudeMd, "utf-8")).toBe(
			`above\n<!-- pharaoh-mcp:start (old) -->\n${LINE}\n<!-- pharaoh-mcp:end -->\nbelow\n`,
		);

		clean();
		expect(readFileSync(claudeMd, "utf-8")).toBe("above\nbelow\n");
	});

	it("keeps the user's lines apart when they wrote below a block that added a newline", async () => {
		writeFileSync(claudeMd, "Keep this.");
		await offer(true);
		appendFileSync(claudeMd, "Mine below.\n");

		clean();
		expect(readFileSync(claudeMd, "utf-8")).toBe("Keep this.\nMine below.\n");
	});

	it("reads the file again after the answer: an edit made meanwhile stays, a symlink swapped in is refused", async () => {
		writeFileSync(claudeMd, "before\n");
		const editWhileAsking = async () => {
			appendFileSync(claudeMd, "meanwhile\n");
			return true;
		};
		expect(await offerClaudeMdLine(editWhileAsking, true, home)).toBe("added");
		expect(readFileSync(claudeMd, "utf-8")).toBe(`before\nmeanwhile\n${BLOCK}`);

		clean();
		const target = join(home, "elsewhere.md");
		writeFileSync(target, "target\n");
		const swapWhileAsking = async () => {
			rmSync(claudeMd);
			symlinkSync(target, claudeMd);
			return true;
		};
		writeFileSync(claudeMd, "");
		expect(await offerClaudeMdLine(swapWhileAsking, true, home)).toBe("kept");
		expect(readFileSync(target, "utf-8")).toBe("target\n");
	});

	it.skipIf(process.getuid?.() === 0)(
		"a write error never stops setup, --clean or --logout, and saves no answer",
		async () => {
			chmodSync(join(home, ".claude"), 0o555);
			expect(await offer(true)).toEqual({ outcome: "failed", count: 1 });
			expect(existsSync(answer)).toBe(false);
			expect(describeClaudeMdOutcome("failed")).toContain(LINE);
			chmodSync(join(home, ".claude"), 0o755);

			expect(await offer(true)).toEqual({ outcome: "added", count: 1 });
			chmodSync(claudeMd, 0o444);
			expect(() => clean()).not.toThrow();
			expect(readFileSync(claudeMd, "utf-8")).toBe(BLOCK);
		},
	);

	it("says nothing when the user's own text already has the line", async () => {
		writeFileSync(claudeMd, `My rules.\n${LINE}\n`);

		expect(await offer(true)).toEqual({ outcome: "current", count: 0 });
		clean();
		expect(readFileSync(claudeMd, "utf-8")).toBe(`My rules.\n${LINE}\n`);
	});

	it("SC-7: never writes through a symlink, and leaves a broken block alone", async () => {
		const target = join(home, "dotfiles.md");
		writeFileSync(target, `mine\n${BLOCK}`);
		symlinkSync(target, claudeMd);
		expect(await offer(true)).toEqual({ outcome: "kept", count: 0 });
		expect(describeClaudeMdOutcome("kept")).toContain(LINE);
		clean();
		expect(readFileSync(target, "utf-8")).toBe(`mine\n${BLOCK}`);

		rmSync(claudeMd);
		const END = "<!-- pharaoh-mcp:end -->\n";
		for (const broken of [`${START}\nno end\n`, `${END}x\n${START}\n`, `${BLOCK}${BLOCK}`]) {
			writeFileSync(claudeMd, broken);
			expect(await offer(true)).toEqual({ outcome: "kept", count: 0 });
			clean();
			expect(readFileSync(claudeMd, "utf-8")).toBe(broken);
		}

		const dotfiles = join(home, "dotfiles-claude");
		rmSync(join(home, ".claude"), { recursive: true });
		mkdirSync(dotfiles);
		symlinkSync(dotfiles, join(home, ".claude"));
		expect(await offer(true)).toEqual({ outcome: "kept", count: 0 });
		expect(existsSync(join(dotfiles, "CLAUDE.md"))).toBe(false);
	});

	it("writes nothing on a no, and never asks or suggests the line again", async () => {
		expect(await offer(false)).toEqual({ outcome: "declined", count: 1 });
		expect(existsSync(claudeMd)).toBe(false);

		expect(await offer(true)).toEqual({ outcome: "answered", count: 0 });
		expect(existsSync(claudeMd)).toBe(false);

		symlinkSync(join(home, "elsewhere.md"), claudeMd);
		expect(await offer(true)).toEqual({ outcome: "answered", count: 0 });
	});

	it("asks nothing and writes nothing without a terminal, on EOF, without ~/.claude, or on a proxy start", async () => {
		expect(await offer(true, false)).toEqual({ outcome: "no-terminal", count: 0 });
		expect(await offer(null)).toEqual({ outcome: "cancelled", count: 1 });
		expect(existsSync(claudeMd) || existsSync(answer)).toBe(false);

		runInstallSkills(home, NO_CLI);
		expect(existsSync(claudeMd)).toBe(false);

		rmSync(join(home, ".claude"), { recursive: true });
		expect(await offer(true)).toEqual({ outcome: "no-claude", count: 0 });
		expect(existsSync(join(home, ".claude"))).toBe(false);
	});

	it("askYesNo: Enter is yes, n is no, anything else asks again, EOF is no answer", async () => {
		const reply = async (input: string, end = false, defaultAnswer = true) => {
			const stdin = new PassThrough();
			const answer = askYesNo("Add it? ", stdin, new PassThrough(), defaultAnswer);
			stdin.write(input);
			if (end) stdin.end();
			return answer;
		};
		expect(await reply("\n")).toBe(true);
		expect(await reply("\n", false, false)).toBe(false);
		expect(await reply("N\n")).toBe(false);
		expect(await reply("maybe\n", true)).toBe(null);
		// The numbered pick: Enter is 1, a listed number picks it, n skips, others ask again.
		const pick = async (input: string) => {
			const stdin = new PassThrough();
			const answer = askChoice("Start which? ", 2, stdin, new PassThrough());
			stdin.end(input);
			return answer;
		};
		expect(await pick("\n")).toBe(1);
		expect(await pick("3\n2\n")).toBe(2);
		expect(await pick("no\n")).toBe(0);
		expect(await pick("1.5\n")).toBe(null);
	});

	it("askYesNo on a terminal drops an Enter pressed before the question showed", async () => {
		const tty = Object.assign(new PassThrough(), { isTTY: true });
		tty.write("\n");
		const answer = askYesNo("Add it? [Y/n] ", tty, new PassThrough());
		setTimeout(() => tty.write("n\n"), 150);
		expect(await answer).toBe(false);
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

// ── Instruction state reported to Pharaoh ───────────────────────────
//
// Breaks when: file text leaves in the report, a stale block counts as the
// exact line, a big file or a FIFO stalls initialize instead of reading
// "unknown", a symlinked CLAUDE.md is skipped, or project files are read for a
// client not known to start the proxy in the project folder.

const SUGGESTED_LINE =
	"In repos Pharaoh has mapped, before searching or reading files, ask Pharaoh where the relevant code is, what calls it, and whether what you need already exists.";

describe("instruction state", () => {
	let home: string;
	const claudeMd = () => join(home, ".claude", "CLAUDE.md");
	/** The user-level part of the report; no client reads project files. */
	const user = () => {
		const { user, managed } = instructionStates(undefined, home, home);
		return { user, managed };
	};

	beforeEach(() => {
		home = makeTempHome();
		mkdirSync(join(home, ".claude"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it.each([
		["no file", null, { user: "missing", managed: "absent" }],
		[
			"setup's block",
			`# mine\n<!-- pharaoh-mcp:start (managed) -->\n${SUGGESTED_LINE}\n<!-- pharaoh-mcp:end -->\n`,
			{ user: "exact", managed: "current" },
		],
		[
			"a stale block",
			"<!-- pharaoh-mcp:start (managed) -->\nAsk Pharaoh first.\n<!-- pharaoh-mcp:end -->\n",
			{ user: "mention", managed: "stale" },
		],
		[
			"the user's own routing",
			"## Code navigation: Pharaoh, then Grep\n",
			{ user: "mention", managed: "absent" },
		],
		["no mention", "Use pnpm.\n", { user: "none", managed: "absent" }],
		["text that reads like a state", "missing", { user: "none", managed: "absent" }],
		[
			"an oversized file",
			`pharaoh ${"x".repeat(64 * 1024)}`,
			{ user: "unknown", managed: "unknown" },
		],
	])("reads %s", (_name, text, expected) => {
		if (text !== null) writeFileSync(claudeMd(), text);
		expect(user()).toEqual(expected);
	});

	it("follows a symlink and never blocks on a FIFO", () => {
		const target = join(home, "shared-claude.md");
		writeFileSync(target, `${SUGGESTED_LINE}\n`);
		symlinkSync(target, claudeMd());
		expect(user().user).toBe("exact");
		rmSync(claudeMd());
		execFileSync("mkfifo", [claudeMd()]);
		expect(user()).toEqual({ user: "unknown", managed: "unknown" });
	});

	it("reads project files only at a git root, for a client known to start there, never sending text", () => {
		const project = join(home, "repo");
		const state = () => instructionStates("claude-code", project, home).project;
		mkdirSync(project);
		writeFileSync(join(project, "CLAUDE.md"), "Use pnpm.\n");
		expect(state()).toBe("unknown");
		mkdirSync(join(project, ".git"));
		expect(state()).toBe("none");
		writeFileSync(join(project, "AGENTS.md"), "Check Pharaoh before grepping. SENTINEL\n");
		writeFileSync(claudeMd(), "SENTINEL\n");
		const report = instructionStates("claude-code", project, home);
		expect(report).toEqual({ user: "none", managed: "absent", project: "mention" });
		expect(JSON.stringify(report)).not.toContain("SENTINEL");
		expect(instructionStates("cursor", project, home).project).toBe("unknown");
		expect(instructionStates("claude-code", home, home).project).toBe("unknown");
		// A folder where a file should be can't be read, even by root.
		rmSync(join(project, "AGENTS.md"));
		mkdirSync(join(project, "AGENTS.md"));
		writeFileSync(join(project, "CLAUDE.local.md"), `${SUGGESTED_LINE}\n`);
		expect(state()).toBe("exact");
		rmSync(join(project, "CLAUDE.local.md"));
		expect(state()).toBe("unknown");
		rmSync(join(project, "AGENTS.md"), { recursive: true });
		rmSync(join(project, "CLAUDE.md"));
		expect(state()).toBe("missing");
	});

	it("observes the configured Claude directory and keeps unreadable settings distinct from absence", () => {
		const configured = join(home, "configured-claude");
		mkdirSync(configured);
		writeFileSync(claudeMd(), `${SUGGESTED_LINE}\n`);
		writeFileSync(join(configured, "CLAUDE.md"), "PRIVATE-SENTINEL: Use pnpm.\n");
		const env = { CLAUDE_CONFIG_DIR: configured };
		expect(instructionStates(undefined, home, home, env)).toEqual({
			user: "none",
			managed: "absent",
			project: "unknown",
		});
		expect(claudePluginState(home, env)).toBe("absent");
		for (const settings of [
			"PRIVATE-SENTINEL",
			'{"enabledPlugins":{"pharaoh@pharaoh":"yes"}}',
			"x".repeat(65_537),
		]) {
			writeFileSync(join(configured, "settings.json"), settings);
			expect(claudePluginState(home, env)).toBe("unknown");
		}
		writeFileSync(join(configured, "settings.json"), '{"enabledPlugins":{"pharaoh@pharaoh":true}}');
		expect(claudePluginState(home, env)).toBe("enabled");
		expect(instructionStates(undefined, home, home, { CLAUDE_CONFIG_DIR: "relative" }).user).toBe(
			"unknown",
		);
		expect(claudePluginState(home, { CLAUDE_CONFIG_DIR: "relative" })).toBe("unknown");
	});
});
