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

/** Check if `claude` CLI is available in PATH. */
function hasClaude(): boolean {
	try {
		const which = process.platform === "win32" ? "where" : "which";
		execFileSync(which, ["claude"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
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
		printLines(
			"Pharaoh: Claude Code CLI not found.",
			"",
			"Install Claude Code first: https://claude.ai/download",
			`Then re-run: ${NPX_COMMAND}`,
			"",
		);
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
	const added = claude(["mcp", "add", "--scope", "user", "pharaoh", "--", "npx", spec]);

	if (!added) {
		printLines("Pharaoh: failed to register MCP server.", `Try manually: ${NPX_COMMAND}`, "");
		return false;
	}

	if (!silent) printLines(`Pharaoh: registered as global MCP server (scope: user) running ${spec}`);

	return true;
}
