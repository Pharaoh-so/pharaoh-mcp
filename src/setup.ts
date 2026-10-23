/**
 * --setup implementation for the Pharaoh MCP proxy CLI.
 *
 * Full automated install: authenticates via device flow, removes stale MCP
 * entries, registers Pharaoh as a global stdio MCP server, and installs skills.
 * One command does everything: `npx @pharaoh-so/mcp`
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NPX_COMMAND, printLines } from "./helpers.js";
import { pinnedPackageSpec } from "./version.js";

/** Runs one `claude` CLI command; true on success. */
export type ClaudeCli = (args: string[]) => boolean;

/** Anthropic's Claude Code CLI install page: every platform and install method. */
export const CLAUDE_CLI_SETUP_URL = "https://code.claude.com/docs/en/setup";

/** Pharaoh's setup guide for agents other than Claude Code (stdio server, sign-in on first call). */
const HEADLESS_SETUP_URL = "https://pharaoh.so/docs/connect/headless";

/**
 * Whether a `claude` CLI on PATH starts. It is launched the way `runClaude`
 * launches it, so the check and the commands agree, with no `which` (minimal
 * containers lack it). The Claude desktop app's bundled copy isn't on PATH.
 *
 * @returns True when `claude --version` runs.
 */
export function hasClaude(): boolean {
	try {
		execFileSync("claude", ["--version"], { stdio: "pipe", timeout: 10_000 });
		return true;
	} catch {
		// A `claude` that can't be started is one setup can't use either.
		return false;
	}
}

/**
 * What setup prints when no `claude` CLI is on PATH: npx registers everything
 * through that CLI, the desktop app's copy doesn't count, and the CLI shares
 * ~/.claude with the desktop app, so installing it covers the Code tab too.
 *
 * @param platform - Picks the one-line installer (PowerShell on Windows).
 * @returns The lines to print.
 */
export function claudeCliMissing(platform: NodeJS.Platform = process.platform): string[] {
	// The shell goes in the label: anything after the command gets pasted with it.
	const [shell, installer] =
		platform === "win32"
			? [" (PowerShell)", "irm https://claude.ai/install.ps1 | iex"]
			: ["", "curl -fsSL https://claude.ai/install.sh | bash"];
	return [
		"Pharaoh: the claude command isn't on your PATH, so setup stopped.",
		"",
		"npx adds Pharaoh to Claude Code through the Claude Code CLI. The desktop app runs its own copy of Claude Code, and that copy isn't on your PATH.",
		"",
		`  Install the CLI${shell}: ${installer}`,
		`  Other ways: ${CLAUDE_CLI_SETUP_URL}`,
		`  Then, in a new terminal: ${NPX_COMMAND}`,
		"",
		"The CLI and the desktop app share ~/.claude, so the desktop app's Code tab gets Pharaoh too.",
		`Not using Claude Code? OpenClaw: ${NPX_COMMAND} --install-skills. Other agents: ${HEADLESS_SETUP_URL}`,
		"",
	];
}

/** Run a claude CLI command, returning true on success. Surfaces stderr on failure. */
function runClaude(args: string[], env: NodeJS.ProcessEnv = process.env): boolean {
	try {
		execFileSync("claude", args, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 30_000,
			env,
		});
		return true;
	} catch (err: unknown) {
		if (err && typeof err === "object" && "stderr" in err) {
			const stderr = (err as { stderr: Buffer | string }).stderr?.toString().trim();
			if (stderr) printLines(`  claude ${args.slice(0, 3).join(" ")}: ${stderr}`);
		}
		return false;
	}
}

/**
 * A `claude` CLI runner for the Claude Code config under `home`: true when the
 * command succeeded, false when it failed or `claude` isn't installed. Another
 * home (tests) gets its own CLAUDE_CONFIG_DIR, so the real config is untouched.
 *
 * @param home - Home whose `.claude` config the commands act on.
 */
export function claudeCliFor(home = homedir()): ClaudeCli {
	const env =
		home === homedir() ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: join(home, ".claude") };
	return (args) => hasClaude() && runClaude(args, env);
}

/** Shape of a project/workspace entry in ~/.claude.json. */
interface ClaudeProject {
	mcpServers?: Record<string, unknown>;
	disabledMcpServers?: string[];
	[key: string]: unknown;
}

/** Shape of ~/.claude.json (partial — only the keys we touch). */
interface ClaudeJson {
	mcpServers?: Record<string, unknown>;
	projects?: Record<string, ClaudeProject>;
	[key: string]: unknown;
}

/**
 * Remove all traces of pharaoh from Claude Code's internal config (~/.claude.json).
 *
 * The `claude mcp remove` CLI only removes the server definition from one scope
 * at a time and does NOT clear:
 * - `disabledMcpServers` arrays (set when user disables via UI)
 * - Project-scoped `mcpServers.pharaoh` entries in other workspaces
 *
 * This function handles what the CLI cannot — a true clean slate.
 */
export function cleanSlate(home = homedir()): void {
	const claudeJsonPath = join(home, ".claude.json");
	if (!existsSync(claudeJsonPath)) return;

	let raw: string;
	let data: ClaudeJson;
	try {
		raw = readFileSync(claudeJsonPath, "utf-8");
		data = JSON.parse(raw) as ClaudeJson;
	} catch {
		// Corrupt or unreadable — don't risk making it worse
		return;
	}

	let changed = false;

	// Remove global User MCP server definition
	if (data.mcpServers?.pharaoh) {
		delete data.mcpServers.pharaoh;
		changed = true;
	}

	// Walk all project/workspace entries
	if (data.projects) {
		for (const proj of Object.values(data.projects)) {
			// Remove project-scoped pharaoh server definitions
			if (proj.mcpServers?.pharaoh) {
				delete proj.mcpServers.pharaoh;
				changed = true;
			}

			// Remove pharaoh from disabled lists (UI "disable" state).
			// filter() handles duplicates — indexOf+splice would leave extras.
			if (Array.isArray(proj.disabledMcpServers)) {
				const before = proj.disabledMcpServers.length;
				proj.disabledMcpServers = proj.disabledMcpServers.filter((s) => s !== "pharaoh");
				if (proj.disabledMcpServers.length !== before) changed = true;
			}
		}
	}

	if (changed) {
		try {
			writeFileSync(claudeJsonPath, JSON.stringify(data, null, "  "));
		} catch {
			// Read-only file or permissions issue — fall through to CLI removal
		}
	}
}

/**
 * Full automated setup: clean slate removal, then register the MCP server
 * globally as `npx @pharaoh-so/mcp@<this version>`, so a new release on npm
 * runs only after the user upgrades on purpose (security review SC-2).
 * Requires valid credentials (caller handles auth first).
 *
 * @param options.silent - Print nothing on success.
 * @param options.home - Home whose Claude Code config is edited (tests).
 * @param options.claude - `claude` CLI runner (defaults to the real CLI for `home`).
 * @returns true if setup succeeded, false if Claude CLI not found or registration failed.
 */
export function runSetup(options?: {
	silent?: boolean;
	home?: string;
	claude?: ClaudeCli;
}): boolean {
	const silent = options?.silent ?? false;
	const home = options?.home ?? homedir();

	if (!options?.claude && !hasClaude()) {
		printLines(...claudeCliMissing());
		return false;
	}
	const claude = options?.claude ?? claudeCliFor(home);

	if (!silent) printLines("Pharaoh: setting up...");

	// Step 1: Clean slate — remove pharaoh from all scopes, disabled lists,
	// and project-scoped configs. Direct file edit handles what CLI cannot.
	cleanSlate(home);

	// Step 2: Belt-and-suspenders — also remove via CLI (both scopes)
	claude(["mcp", "remove", "pharaoh", "-s", "user"]);
	claude(["mcp", "remove", "pharaoh", "-s", "project"]);

	// Step 3: Register as global stdio MCP server, pinned to the running version
	const spec = pinnedPackageSpec();
	const addArgs = ["mcp", "add", "--scope", "user", "pharaoh", "--", "npx", spec];

	if (!claude(addArgs)) {
		printLines(
			"Pharaoh: failed to register MCP server.",
			`Try manually: claude ${addArgs.join(" ")}`,
			"",
		);
		return false;
	}

	if (!silent) printLines(`Pharaoh: registered as global MCP server (scope: user) running ${spec}`);

	return true;
}
