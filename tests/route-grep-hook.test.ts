/**
 * The Claude Code plugin's Grep hook: a structural search for a code symbol is
 * sent to Pharaoh once per session, and text searches always run.
 *
 * Breaks when:
 * - a symbol-shaped Grep over code isn't redirected while Pharaoh is signed in
 * - a text, config or non-code search is redirected
 * - the same symbol is refused twice in one session (agents get stuck on
 *   unmapped repos and unpushed code)
 * - the script stops being runnable on its own, or its reply stops being a
 *   PreToolUse deny Claude Code understands
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CREDENTIALS_FILE,
	type GrepHookInput,
	routeGrep,
	symbolSearched,
} from "../hooks/route-grep.mjs";
import { CREDENTIALS_PATH } from "../src/credentials.js";

/** The hook as hooks/hooks.json runs it: plain `node`, no loader. */
const HOOK_SCRIPT = join(__dirname, "..", "hooks", "route-grep.mjs");

describe("symbolSearched", () => {
	it.each([
		["resolveWidget", "resolveWidget"],
		["\\bresolveWidget\\b", "resolveWidget"],
		["function resolveWidget", "resolveWidget"],
		["export async function\\s+resolveWidget", "resolveWidget"],
		["class\\s+TenantStore", "TenantStore"],
		["def load_config", "load_config"],
		["resolveWidget\\(", "resolveWidget"],
		["get_blast_radius", "get_blast_radius"],
		["ResolveResult", "ResolveResult"],
	])("finds the symbol in %s", (pattern, symbol) => {
		expect(symbolSearched(pattern)).toBe(symbol);
	});

	it.each([
		"TODO",
		"API_KEY",
		"error",
		"Error",
		"session expired",
		"Pharaoh authentication required",
		"foo.*bar",
		"^import .* from",
		"[A-Z]+_TOKEN",
		"abc",
	])("treats %s as text", (pattern) => {
		expect(symbolSearched(pattern)).toBeNull();
	});
});

describe("routeGrep", () => {
	const grep = (tool_input: GrepHookInput["tool_input"], session_id = "s1"): GrepHookInput => ({
		session_id,
		tool_name: "Grep",
		tool_input,
	});

	it("redirects a symbol search over code to Pharaoh, naming the symbol and the tools", () => {
		const reason = routeGrep(grep({ pattern: "resolveWidget" }), true, new Set());

		expect(reason).toContain("`resolveWidget`");
		expect(reason).toContain("search_functions");
		expect(reason).toContain("get_blast_radius");
		// A rename needs every text reference, which Pharaoh's call graph doesn't hold:
		// the agent is told to repeat the Grep (benchmark: rename plans ran slower with Pharaoh).
		expect(reason).toMatch(/renam[^.]*run this Grep again/i);
	});

	it("lets the repeat through: once per symbol per session", () => {
		const seen = new Set<string>();
		routeGrep(grep({ pattern: "resolveWidget" }), true, seen);

		expect(routeGrep(grep({ pattern: "function resolveWidget" }), true, seen)).toBeNull();
		expect(routeGrep(grep({ pattern: "loadConfig" }), true, seen)).not.toBeNull();
	});

	it("doesn't redirect when Pharaoh isn't signed in", () => {
		expect(routeGrep(grep({ pattern: "resolveWidget" }), false, new Set())).toBeNull();
	});

	it.each([
		{ pattern: "resolveWidget", glob: "*.md" },
		{ pattern: "resolveWidget", glob: "**/*.{json,yaml}" },
		{ pattern: "resolveWidget", type: "md" },
		{ pattern: "resolveWidget", path: "docs/guide.md" },
		{ pattern: "resolveWidget", path: "package.json" },
	])("doesn't redirect searches of non-code files (%o)", (input) => {
		expect(routeGrep(grep(input), true, new Set())).toBeNull();
	});

	it.each([
		{ pattern: "resolveWidget", glob: "*.ts" },
		{ pattern: "resolveWidget", type: "py" },
		{ pattern: "resolveWidget", path: "src/widgets.tsx" },
		{ pattern: "resolveWidget", path: "src" },
	])("redirects searches of code (%o)", (input) => {
		expect(routeGrep(grep(input), true, new Set())).not.toBeNull();
	});

	it("ignores other tools", () => {
		const input = { ...grep({ pattern: "resolveWidget" }), tool_name: "Glob" };

		expect(routeGrep(input, true, new Set())).toBeNull();
	});
});

describe("route-grep-hook as Claude Code runs it", () => {
	let stateDir: string;
	let home: string;
	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "route-grep-state-"));
		home = mkdtempSync(join(tmpdir(), "route-grep-home-"));
	});
	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	/** Run the hook script with a PreToolUse payload on stdin; returns its stdout. */
	function runHook(input: GrepHookInput, signedIn: boolean): string {
		if (signedIn) {
			mkdirSync(join(home, ".pharaoh"), { recursive: true });
			writeFileSync(join(home, ".pharaoh", "credentials.json"), "{}");
		}
		const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
			input: JSON.stringify(input),
			encoding: "utf-8",
			env: { ...process.env, HOME: home, PHARAOH_ROUTE_GREP_STATE_DIR: stateDir },
		});
		expect(res.status).toBe(0);
		return res.stdout;
	}

	it("denies the first symbol search with a reason, then allows the retry", () => {
		const input: GrepHookInput = {
			session_id: "abc-123",
			tool_name: "Grep",
			tool_input: { pattern: "resolveWidget" },
		};

		const first = JSON.parse(runHook(input, true));
		const second = runHook(input, true);

		expect(first.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(first.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(first.hookSpecificOutput.permissionDecisionReason).toContain("`resolveWidget`");
		expect(second).toBe("");
	});

	it("allows everything when signed out, and on input it can't read", () => {
		const input: GrepHookInput = {
			session_id: "abc-123",
			tool_name: "Grep",
			tool_input: { pattern: "resolveWidget" },
		};
		const garbage = spawnSync(process.execPath, [HOOK_SCRIPT], {
			input: "not json",
			encoding: "utf-8",
			env: { ...process.env, HOME: home },
		});

		expect(runHook(input, false)).toBe("");
		expect(garbage.status).toBe(0);
		expect(garbage.stdout).toBe("");
	});

	it("checks the same credentials file the proxy writes", () => {
		expect(CREDENTIALS_FILE.join("/")).toBe(".pharaoh/credentials.json");
		expect(CREDENTIALS_PATH.endsWith(join(...CREDENTIALS_FILE))).toBe(true);
	});

	it("imports nothing but Node built-ins, so the plugin runs it as is", () => {
		const source = readFileSync(HOOK_SCRIPT, "utf-8");
		const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);

		expect(imports.length).toBeGreaterThan(0);
		expect(imports.filter((spec) => !spec.startsWith("node:"))).toEqual([]);
	});
});
