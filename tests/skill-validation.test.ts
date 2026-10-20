/**
 * Validates ALL SKILL.md files in the skills/ directory.
 *
 * Enforces structure requirements for OpenClaw-compatible skill manifests:
 * valid YAML frontmatter, required fields, no multiline values, and
 * consistency between graph-powered skills and their MCP prompt names.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "..", "skills");

/** Expected total number of skill directories. */
const EXPECTED_SKILL_COUNT = 10;

/**
 * Graph-powered skills that must have a corresponding MCP prompt name.
 * Key = skill directory name, Value = expected MCP prompt name.
 *
 * Only kept skills appear here — skills removed from the bundle (audit-tests,
 * debt, execute, explore, finish, health, investigate, onboard, orchestrate,
 * pr, review-codex, review-receive, wiring, worktree) are no longer part of
 * the Pharaoh toolkit and their prompt-name mappings are dropped.
 */
const GRAPH_SKILL_TO_PROMPT: Record<string, string> = {
	plan: "plan-with-pharaoh",
	review: "review-with-pharaoh",
	refactor: "safe-refactor",
};

/** Semver pattern: major.minor.patch */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Parses YAML frontmatter from a markdown string.
 *
 * Extracts key-value pairs between the first pair of `---` markers.
 * Handles quoted values by stripping surrounding single or double quotes.
 * Does NOT support multiline values — each line must be `key: value`.
 *
 * @param content - Full markdown file content.
 * @returns Parsed key-value record, or null if no valid frontmatter block found.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
	const lines = content.split("\n");

	// Must start with ---
	if (lines[0]?.trim() !== "---") {
		return null;
	}

	const fields: Record<string, string> = {};
	let closingFound = false;

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) break;

		if (line.trim() === "---") {
			closingFound = true;
			break;
		}

		// Each line must be key: value (colon required)
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) {
			// Non-key:value line inside frontmatter — skip blank lines
			if (line.trim() !== "") {
				// Return a special sentinel so callers can detect multiline violations
				fields.__multiline_violation__ = line.trim();
			}
			continue;
		}

		const key = line.slice(0, colonIdx).trim();
		let value = line.slice(colonIdx + 1).trim();

		// Strip surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		fields[key] = value;
	}

	if (!closingFound) {
		return null;
	}

	return fields;
}

/**
 * Returns all immediate subdirectory names in the skills/ directory.
 */
function getSkillDirs(): string[] {
	const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
	return entries
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("skill-validation", () => {
	const skillDirs = getSkillDirs();

	it(`has exactly ${EXPECTED_SKILL_COUNT} skill directories`, () => {
		expect(skillDirs.length).toBe(EXPECTED_SKILL_COUNT);
	});

	describe.each(skillDirs.map((dir) => ({ dir })))("$dir/SKILL.md", ({ dir }) => {
		const skillPath = join(SKILLS_DIR, dir, "SKILL.md");
		let content: string;

		try {
			content = readFileSync(skillPath, "utf-8");
		} catch {
			// Surface missing file as a test failure
			it("exists", () => {
				expect.fail(`Missing SKILL.md in skills/${dir}/`);
			});
			return;
		}

		const frontmatter = parseFrontmatter(content);

		it("has valid YAML frontmatter (between --- markers)", () => {
			expect(frontmatter).not.toBeNull();
		});

		if (!frontmatter) return;

		it("has no multiline frontmatter values (OpenClaw requirement)", () => {
			expect(frontmatter.__multiline_violation__).toBeUndefined();
		});

		it(`has 'name' field matching directory name '${dir}'`, () => {
			expect(frontmatter.name).toBe(dir);
		});

		it("has 'description' field (non-empty, >10 chars)", () => {
			expect(frontmatter.description).toBeTruthy();
			expect((frontmatter.description ?? "").length).toBeGreaterThan(10);
		});

		it("has 'version' field matching semver (e.g. 0.2.0)", () => {
			expect(frontmatter.version).toMatch(SEMVER_RE);
		});

		it("has a '## When to Use' section in the markdown body", () => {
			expect(content).toMatch(/^##\s+When to Use/m);
		});
	});

	describe("graph-powered skill → MCP prompt consistency", () => {
		for (const [skillName, expectedPrompt] of Object.entries(GRAPH_SKILL_TO_PROMPT)) {
			it(`${skillName} references MCP prompt '${expectedPrompt}'`, () => {
				const skillPath = join(SKILLS_DIR, skillName, "SKILL.md");
				let content: string;
				try {
					content = readFileSync(skillPath, "utf-8");
				} catch {
					expect.fail(`Missing SKILL.md for graph skill '${skillName}'`);
				}

				expect(content).toContain(expectedPrompt);
			});
		}
	});
});
