/**
 * Client installation exports and legacy cleanup used only by explicit clean/logout.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { printLines } from "./helpers.js";

export {
	cleanupManagedClients,
	configureClients,
	discoverClients,
	legacyMigrations,
	verifiedCodingClients,
} from "./client-install.js";
export type {
	ClientId,
	ClientInstallOptions,
	ClientOutcome,
	ClientTarget,
	LaunchConfig,
	LegacyMigration,
} from "./install-types.js";

/** Runs one `claude` CLI command; true on success. */
export type ClaudeCli = (args: string[]) => boolean;

/** Anthropic's Claude Code CLI install page: every platform and install method. */
export const CLAUDE_CLI_SETUP_URL = "https://code.claude.com/docs/en/setup";

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

/** Detect the local Codex CLI before touching any settings. */
function hasCodex(): boolean {
	try {
		execFileSync("codex", ["--version"], { stdio: "pipe", timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

function codexMcp(args: string[]): string {
	return execFileSync("codex", ["mcp", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	});
}

function configuredCodexPharaoh(): { owned: boolean; enabled?: boolean } | null {
	try {
		const { transport, enabled } = JSON.parse(codexMcp(["get", "pharaoh", "--json"]));
		return {
			owned:
				transport?.type === "stdio" &&
				transport.command === "npx" &&
				transport.args?.length === 1 &&
				/^@pharaoh-so\/mcp@\d+\.\d+\.\d+$/.test(transport.args[0]) &&
				!transport.env &&
				!transport.env_vars?.length &&
				!transport.cwd,
			enabled,
		};
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"stderr" in error &&
			typeof error.stderr === "string" &&
			error.stderr.includes("No MCP server named 'pharaoh' found.")
		)
			return null;
		throw error;
	}
}

export function cleanCodexSetup(): void {
	if (!hasCodex()) return;
	try {
		if (configuredCodexPharaoh()?.owned) codexMcp(["remove", "pharaoh"]);
	} catch {
		printLines("Pharaoh: Codex setup could not remove its MCP registration.");
	}
}
