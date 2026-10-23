/**
 * --install-skills implementation for the Pharaoh MCP proxy CLI.
 *
 * Installs Pharaoh's Claude Code plugin (skills plus the Grep routing hook,
 * through `claude plugin`), the review skill for Codex in ~/.agents/skills/,
 * and OpenClaw skills in ~/.openclaw/skills/. Also merges the Pharaoh MCP
 * server config into OpenClaw.
 */
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePharaohHome } from "./credentials.js";
import { CLAUDE_CLI_SETUP_URL, type ClaudeCli, claudeCliFor } from "./setup.js";
import { getPackageVersion, PACKAGE_NAME, pinnedPackageSpec } from "./version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the bundled package root (one level up from dist/). */
const PKG_ROOT = join(__dirname, "..");

/** Path to the bundled skills directory. */
const BUNDLED_SKILLS_DIR = join(PKG_ROOT, "skills");

/** Path to the bundled slash commands directory. */
const BUNDLED_COMMANDS_DIR = join(PKG_ROOT, "commands");

/** Path to the bundled Claude Code hooks (hooks.json and the Grep routing hook). */
const BUNDLED_HOOKS_DIR = join(PKG_ROOT, "hooks");

/**
 * Namespace prefix applied to every skill installed for OpenClaw. Prevents
 * collision with other skills that ship same-named bare skills (e.g. `plan`,
 * `review`). Claude Code namespaces plugin skills itself (`pharaoh:plan`), so
 * the Claude Code plugin ships the bare names.
 */
const SKILL_PREFIX = "pharaoh-";

/**
 * Filename of the install manifest written alongside the installed skills.
 * Records which skills we installed in the previous run so the next run can
 * diff against current source and remove skills that were cut or renamed
 * between versions. See `cleanupRemovedSkills` for the diff logic.
 */
const MANIFEST_FILENAME = ".pharaoh-manifest.json";

/** Current manifest format version. Bump on breaking shape changes. */
const MANIFEST_VERSION = 1;

/**
 * Shape of the install manifest file. Tracks the BARE source names (not
 * the prefixed install names) so diffs against the current source dir
 * listing are straightforward.
 *
 * We intentionally keep this narrow: any future fields go in a new version
 * with explicit migration in `readPharaohManifest` rather than creeping
 * into v1.
 */
interface PharaohManifest {
	version: number;
	installedAt: string;
	skills: string[];
}

/** Shape of the mcpServers entry written into config files. */
interface McpServerConfig {
	command: string;
	args: string[];
}

/** Shape of the openclaw.json config file (partial — only the keys we touch). */
interface OpenClawConfig {
	mcpServers?: Record<string, McpServerConfig>;
	[key: string]: unknown;
}

// ── Detection ───────────────────────────────────────────────────────

/**
 * Detect whether Claude Code is installed by checking for ~/.claude/.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @returns True if ~/.claude/ exists.
 */
function detectClaudeCode(home = homedir()): boolean {
	return existsSync(join(home, ".claude"));
}

/**
 * Detect whether Codex is installed by checking for ~/.codex/.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @returns True if ~/.codex/ exists.
 */
function detectCodex(home = homedir()): boolean {
	return existsSync(join(home, ".codex"));
}

/**
 * Detect whether OpenClaw is installed by checking for ~/.openclaw/.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @returns True if ~/.openclaw/ exists.
 */
function detectOpenClaw(home = homedir()): boolean {
	return existsSync(join(home, ".openclaw"));
}

// ── Claude Code plugin ──────────────────────────────────────────────
//
// Claude Code loads a plugin only when it's installed from a marketplace and
// enabled (`claude plugin install`); a plugin directory registered by hand is
// never loaded. The installer keeps a one-plugin local marketplace next to the
// proxy's credentials and installs it through Claude Code's own CLI. A
// directory marketplace's plugin loads in place, so rewriting the directory
// is how the plugin updates.

/** Marketplace name; Claude Code knows the plugin as `pharaoh@pharaoh`. */
const MARKETPLACE_NAME = "pharaoh";

/** Plugin id as Claude Code's `enabledPlugins` and `claude plugin` know it. */
const PLUGIN_ID = `pharaoh@${MARKETPLACE_NAME}`;

/**
 * The local marketplace directory the installer keeps.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 */
function claudeMarketplaceDir(home: string): string {
	return join(home, ".pharaoh", "claude-marketplace");
}

/**
 * Write Pharaoh's plugin as a one-plugin local marketplace: the plugin manifest,
 * the skills, and the Grep routing hook (hooks/). The MCP server isn't part of
 * it: `claude mcp add` registers that, and a plugin copy would start a second
 * one. Skipped when the installed plugin is already this package's version.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @returns Number of skills in the plugin.
 */
function writeClaudeMarketplace(home: string): number {
	const root = claudeMarketplaceDir(home);
	const plugin = join(root, "pharaoh");
	const version = getPackageVersion();
	const skillCount = getSourceSkillNames(BUNDLED_SKILLS_DIR).length;
	if (installedPluginVersion(plugin) === version) return skillCount;

	const manifest = JSON.parse(
		readFileSync(join(PKG_ROOT, ".claude-plugin", "plugin.json"), "utf-8"),
	) as { description?: string };
	// Build beside the live plugin and swap it in, so a session starting
	// mid-install never loads a half-written plugin.
	const staging = `${plugin}.${process.pid}.tmp`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(join(staging, ".claude-plugin"), { recursive: true });
	writeFileSync(
		join(staging, ".claude-plugin", "plugin.json"),
		JSON.stringify({ ...manifest, version }, null, "\t"),
	);
	cpSync(BUNDLED_SKILLS_DIR, join(staging, "skills"), { recursive: true });
	cpSync(BUNDLED_HOOKS_DIR, join(staging, "hooks"), { recursive: true });
	rmSync(plugin, { recursive: true, force: true });
	renameSync(staging, plugin);

	mkdirSync(join(root, ".claude-plugin"), { recursive: true });
	writeFileSync(
		join(root, ".claude-plugin", "marketplace.json"),
		JSON.stringify(
			{
				name: MARKETPLACE_NAME,
				owner: { name: "Pharaoh", url: "https://pharaoh.so" },
				metadata: { description: "Pharaoh's Claude Code plugin, installed by npx @pharaoh-so/mcp" },
				plugins: [
					{ name: "pharaoh", source: "./pharaoh", description: manifest.description, version },
				],
			},
			null,
			"\t",
		),
	);
	return skillCount;
}

/** Version in an installed plugin's manifest, or null when there's no readable plugin. */
function installedPluginVersion(plugin: string): string | null {
	const manifest = join(plugin, ".claude-plugin", "plugin.json");
	if (!existsSync(manifest) || !existsSync(join(plugin, "hooks"))) return null;
	try {
		return (JSON.parse(readFileSync(manifest, "utf-8")) as { version?: string }).version ?? null;
	} catch {
		// ALLOWED-CATCH: an unreadable manifest is rewritten like a missing one
		return null;
	}
}

/**
 * Whether ~/.claude/settings.json lists the plugin, and as enabled or disabled.
 * An unreadable file counts as not listed.
 */
function pluginSetting(home: string): boolean | undefined {
	try {
		const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")) as {
			enabledPlugins?: Record<string, boolean>;
		};
		return settings.enabledPlugins?.[PLUGIN_ID];
	} catch {
		// ALLOWED-CATCH: no settings file yet (or unreadable) — the plugin isn't listed
		return undefined;
	}
}

/**
 * Pharaoh's Claude Code plugin as ~/.claude/settings.json lists it. The proxy
 * reports this to Pharaoh, so adoption can be compared with and without it.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 */
export function claudePluginState(home = homedir()): "enabled" | "disabled" | "absent" {
	const setting = pluginSetting(home);
	if (setting === undefined) return "absent";
	return setting ? "enabled" : "disabled";
}

/**
 * Install the plugin through Claude Code's CLI (both commands are idempotent).
 * Skipped when it's already enabled, and when the user disabled it: that choice stands.
 */
function registerClaudePlugin(
	home: string,
	claude: ClaudeCli,
): "installed" | "current" | "disabled" | "failed" {
	const setting = pluginSetting(home);
	if (setting === true) return "current";
	if (setting === false) return "disabled";
	const ok =
		claude(["plugin", "marketplace", "add", claudeMarketplaceDir(home)]) &&
		claude(["plugin", "install", PLUGIN_ID]);
	return ok ? "installed" : "failed";
}

/**
 * Remove the install of proxy 0.3.39 and earlier, which copied the plugin to
 * ~/.claude/plugins/data/pharaoh and wrote `pharaoh@pharaoh-so` into
 * installed_plugins.json by hand. Claude Code never loaded it.
 */
function removeLegacyClaudePlugin(home: string): void {
	const legacyDir = join(home, ".claude", "plugins", "data", "pharaoh");
	if (existsSync(join(legacyDir, ".claude-plugin", "plugin.json"))) {
		rmSync(legacyDir, { recursive: true, force: true });
	}
	const registryPath = join(home, ".claude", "plugins", "installed_plugins.json");
	try {
		const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as {
			plugins?: Record<string, unknown>;
		};
		if (!registry.plugins?.[LEGACY_PLUGIN_ID]) return;
		delete registry.plugins[LEGACY_PLUGIN_ID];
		writeFileSync(registryPath, JSON.stringify(registry, null, 2));
	} catch {
		// ALLOWED-CATCH: no registry (or unreadable) — nothing of ours to remove
	}
}

/** Plugin id the pre-marketplace installer wrote into installed_plugins.json. */
const LEGACY_PLUGIN_ID = "pharaoh@pharaoh-so";

/**
 * Uninstall Pharaoh's Claude Code plugin: through the CLI, then the local
 * marketplace directory and any pre-marketplace install.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @param claude - `claude` CLI runner (defaults to the real CLI for `home`).
 */
export function uninstallClaudePlugin(
	home = homedir(),
	claude: ClaudeCli = claudeCliFor(home),
): void {
	claude(["plugin", "uninstall", PLUGIN_ID]);
	claude(["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
	rmSync(claudeMarketplaceDir(home), { recursive: true, force: true });
	removeLegacyClaudePlugin(home);
}

/**
 * Copy every skill directory from `srcDir` to `dstDir`, prefixing both the
 * target directory name and the `name:` field in its SKILL.md frontmatter
 * with `prefix`.
 *
 * Exception: a source directory whose name equals the prefix stripped of
 * its trailing dash is copied WITHOUT a double-prefix. Example: with
 * `prefix = "pharaoh-"`, the source dir `pharaoh/` is copied to `pharaoh/`
 * unchanged, not `pharaoh-pharaoh/`. This keeps the flagship skill's name
 * clean.
 *
 * @param srcDir - Source skills directory (bundled with the package).
 * @param dstDir - Destination skills directory (inside the plugin path).
 * @param prefix - Namespace prefix to apply (e.g., `"pharaoh-"`).
 * @param only   - Source skill names to copy; every skill when omitted.
 * @returns Number of skill directories installed.
 */
function installPrefixedSkills(
	srcDir: string,
	dstDir: string,
	prefix: string,
	only?: readonly string[],
): number {
	if (!existsSync(srcDir)) return 0;

	mkdirSync(dstDir, { recursive: true });

	// `pharaoh-` → `pharaoh` — the source directory name that's exempt from
	// the prefix to avoid `pharaoh-pharaoh`.
	const exemptName = prefix.replace(/-$/, "");

	const entries = readdirSync(srcDir, { withFileTypes: true });
	let count = 0;

	for (const entry of entries) {
		if (!entry.isDirectory() || (only && !only.includes(entry.name))) continue;
		const srcSkill = join(srcDir, entry.name);
		const srcSkillMd = join(srcSkill, "SKILL.md");
		if (!existsSync(srcSkillMd)) continue;

		const dstName = entry.name === exemptName ? entry.name : `${prefix}${entry.name}`;
		const dstSkill = join(dstDir, dstName);

		// Copy the full source tree (SKILL.md + any supporting files).
		cpSync(srcSkill, dstSkill, { recursive: true, force: true });

		// Rewrite the frontmatter `name:` field only if we applied the prefix.
		if (dstName !== entry.name) {
			const dstSkillMd = join(dstSkill, "SKILL.md");
			const content = readFileSync(dstSkillMd, "utf-8");
			const rewritten = content.replace(
				/^(---\n[\s\S]*?)(name:\s*).+(\n[\s\S]*?---)/,
				`$1$2${dstName}$3`,
			);
			writeFileSync(dstSkillMd, rewritten);
		}

		count++;
	}

	return count;
}

/**
 * Delete bare-name skill directories from prior installs that used the dual
 * bare+prefixed layout. Only removes directories that match the name of a
 * bundled source skill (so we don't accidentally delete user-installed
 * skills from other sources that happen to share the `pharaoh/skills/`
 * install path).
 *
 * This is the LEGACY cleanup — it only heals the bare+prefixed dual
 * layout for skills that are STILL in source. Skills cut between
 * versions are handled by `cleanupRemovedSkills` via the manifest.
 *
 * @param srcDir - Bundled source skills directory.
 * @param dstDir - Installed skills directory.
 * @returns Number of stale directories removed.
 */
function cleanupBareNameSkills(srcDir: string, dstDir: string): number {
	if (!existsSync(srcDir) || !existsSync(dstDir)) return 0;

	const exemptName = SKILL_PREFIX.replace(/-$/, "");
	const sourceNames = new Set(
		readdirSync(srcDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && e.name !== exemptName)
			.map((e) => e.name),
	);

	let removed = 0;
	for (const name of sourceNames) {
		const staleDir = join(dstDir, name);
		if (existsSync(staleDir)) {
			rmSync(staleDir, { recursive: true, force: true });
			removed++;
		}
	}

	return removed;
}

/**
 * Enumerate the bare source skill names by listing the source skills dir.
 * Returns the names that `installPrefixedSkills` would copy (directory
 * entries that contain a `SKILL.md`). Used by both the manifest writer
 * and the cleanup diff logic so the two stay in lockstep.
 *
 * @param srcDir - Bundled source skills directory.
 * @returns Sorted array of bare skill dir names.
 */
function getSourceSkillNames(srcDir: string): string[] {
	if (!existsSync(srcDir)) return [];
	const names: string[] = [];
	for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!existsSync(join(srcDir, entry.name, "SKILL.md"))) continue;
		names.push(entry.name);
	}
	return names.sort();
}

/**
 * Read `.pharaoh-manifest.json` from the installed skills directory.
 *
 * Returns `null` when:
 * - The file does not exist (first run after this fix shipped)
 * - The file is corrupted or not valid JSON (treated as missing, caller
 *   will write a fresh one on the next install cycle)
 *
 * Corrupted-manifest handling is silent-but-logged: we don't want a bad
 * manifest to crash the install, but we do want a warning on stderr so
 * operators can spot persistent corruption.
 *
 * @param skillsDir - Installed skills directory.
 * @returns The parsed manifest, or `null` if missing/invalid.
 */
function readPharaohManifest(skillsDir: string): PharaohManifest | null {
	const manifestPath = join(skillsDir, MANIFEST_FILENAME);
	if (!existsSync(manifestPath)) return null;
	try {
		const raw = readFileSync(manifestPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<PharaohManifest>;
		// Defensive shape check — a valid-JSON manifest with the wrong
		// shape is as useful as no manifest, so we reject it and let the
		// caller write a fresh one.
		if (
			typeof parsed.version !== "number" ||
			typeof parsed.installedAt !== "string" ||
			!Array.isArray(parsed.skills) ||
			!parsed.skills.every((s) => typeof s === "string")
		) {
			process.stderr.write(
				`Pharaoh: ${MANIFEST_FILENAME} has unexpected shape — treating as missing and writing a fresh one.\n`,
			);
			return null;
		}
		return parsed as PharaohManifest;
	} catch {
		process.stderr.write(
			`Pharaoh: ${MANIFEST_FILENAME} is not valid JSON — treating as missing and writing a fresh one.\n`,
		);
		return null;
	}
}

/**
 * Write a fresh manifest file listing the current install's bare skill
 * names. Overwrites any existing manifest. The caller is responsible for
 * ensuring the parent directory exists — `installPrefixedSkills` already
 * does that as part of its own run, so writing the manifest after the
 * install copy completes is safe.
 *
 * @param skillsDir - Installed skills directory.
 * @param skills    - Bare skill names present in the current source.
 */
function writePharaohManifest(skillsDir: string, skills: readonly string[]): void {
	const manifest: PharaohManifest = {
		version: MANIFEST_VERSION,
		installedAt: new Date().toISOString(),
		skills: [...skills],
	};
	writeFileSync(join(skillsDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, "\t"));
}

/**
 * Diff-based cleanup of skills removed between versions.
 *
 * Reads the old manifest's skill list and removes any entry that's no
 * longer in the current source. For each removed name, we delete BOTH
 * the bare-name and `pharaoh-` prefixed variants — the dual-layout from
 * the pre-prefix era means both can exist on the same machine for the
 * same skill, and leaving either behind burns context on every session.
 *
 * The flagship `pharaoh` skill is exempt from deletion even if a corrupt
 * manifest lists it as removed. Losing the flagship would break every
 * skill slash command, and the exempt-name guard is the only thing
 * preventing an accidental self-destruct.
 *
 * @param srcDir      - Bundled source skills directory.
 * @param dstDir      - Installed skills directory.
 * @param oldManifest - Manifest from the previous install, or `null` for
 *   first-run-after-fix (in which case this is a no-op).
 * @returns Number of directories removed.
 */
function cleanupRemovedSkills(
	srcDir: string,
	dstDir: string,
	oldManifest: PharaohManifest | null,
): number {
	if (!oldManifest || !existsSync(dstDir)) return 0;

	const exemptName = SKILL_PREFIX.replace(/-$/, "");
	const currentSkills = new Set(getSourceSkillNames(srcDir));
	const removed = oldManifest.skills.filter(
		(name) => !currentSkills.has(name) && name !== exemptName,
	);

	let deleted = 0;
	for (const name of removed) {
		for (const variant of [name, `${SKILL_PREFIX}${name}`]) {
			const dir = join(dstDir, variant);
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
				deleted++;
			}
		}
	}
	return deleted;
}

/**
 * Marker the installer writes into the front-matter of every command file it
 * installs, as a YAML comment Claude Code ignores. A file in
 * `~/.claude/commands/` is rewritten only when it is Pharaoh's: it carries
 * this marker, or the exact header and `$ARGUMENTS` footer every installer
 * before the marker shipped. Any other file with the same name is the user's
 * and is left alone (security review SC-7).
 */
export const PHARAOH_COMMAND_MARKER = "# managed-by: pharaoh-mcp";

/**
 * Commands an earlier installer wrote that this version no longer ships. Each
 * is deleted only while it is still Pharaoh's marked file; a user's own file
 * or a symlink with the name stays. A pre-marker copy (0.3.46 and earlier) is
 * left too: without the bundled file there is nothing to prove it is ours.
 */
const RETIRED_COMMANDS: readonly string[] = ["sessions.md"];

/** The full marker line, with the one thing a reader of the file needs to know. */
const COMMAND_MARKER_LINE = `${PHARAOH_COMMAND_MARKER} (rewritten by npx ${PACKAGE_NAME} on upgrade; rename this file to keep your own version)`;

/** The front-matter block of a bundled command, `---` to `---` inclusive. */
function commandHeader(bundled: string): string {
	const closing = bundled.indexOf("\n---\n", 4);
	if (!bundled.startsWith("---\n") || closing === -1) {
		throw new Error("bundled command file has no front-matter — rebuild the package");
	}
	return bundled.slice(0, closing + "\n---\n".length);
}

/** The bundled command with the marker as the last front-matter line. */
function markCommand(bundled: string): string {
	const header = commandHeader(bundled);
	const closingAt = header.length - "---\n".length;
	return `${header.slice(0, closingAt)}${COMMAND_MARKER_LINE}\n${header.slice(closingAt)}${bundled.slice(header.length)}`;
}

/**
 * Whether an existing command file is Pharaoh's and may be rewritten: marked
 * by this installer, or shaped exactly like the file an earlier installer
 * copied (its header and the `$ARGUMENTS` footer the generator appends).
 */
function isPharaohCommand(existing: string, bundled: string): boolean {
	if (existing.includes(PHARAOH_COMMAND_MARKER)) return true;
	return existing.startsWith(commandHeader(bundled)) && existing.trimEnd().endsWith("$ARGUMENTS");
}

/**
 * Install the bundled slash commands (`.md` files in the package's `commands/`
 * directory) to `~/.claude/commands/`. A destination that is missing or is
 * Pharaoh's own file is written; anything else (the user's file, or a symlink,
 * which is never followed) is kept and reported. Pharaoh's copies of
 * `RETIRED_COMMANDS` are removed.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @returns How many commands were written, and the names of the files kept and removed.
 */
function installClaudeCodeCommands(home: string): {
	installed: number;
	kept: string[];
	removed: string[];
} {
	const result = { installed: 0, kept: [] as string[], removed: [] as string[] };
	if (!existsSync(BUNDLED_COMMANDS_DIR)) return result;

	const commandsDst = join(home, ".claude", "commands");
	mkdirSync(commandsDst, { recursive: true });

	for (const entry of readdirSync(BUNDLED_COMMANDS_DIR, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const bundled = readFileSync(join(BUNDLED_COMMANDS_DIR, entry.name), "utf-8");
		const dst = join(commandsDst, entry.name);
		const existing = lstatSync(dst, { throwIfNoEntry: false });
		if (
			existing &&
			(!existing.isFile() || !isPharaohCommand(readFileSync(dst, "utf-8"), bundled))
		) {
			result.kept.push(entry.name);
			continue;
		}
		writeFileSync(dst, markCommand(bundled));
		result.installed++;
	}

	for (const name of RETIRED_COMMANDS) {
		const dst = join(commandsDst, name);
		if (!lstatSync(dst, { throwIfNoEntry: false })?.isFile()) continue;
		if (!readFileSync(dst, "utf-8").includes(PHARAOH_COMMAND_MARKER)) continue;
		rmSync(dst);
		result.removed.push(name);
	}

	return result;
}

/**
 * The one-line notice for command files the installer left alone, or null
 * when there were none.
 *
 * @param kept - File names from `runInstallSkills().keptCommands`.
 */
export function formatKeptCommands(kept: readonly string[]): string | null {
	if (kept.length === 0) return null;
	return `Pharaoh: kept your own ~/.claude/commands/${kept.join(", ")} (not Pharaoh's file). Delete one and re-run to take Pharaoh's version.`;
}

// ── Codex installer ─────────────────────────────────────────────────

/**
 * Skills installed for Codex. Only review: Codex lists every installed skill
 * in each session's context, and the others lean on Claude Code features and
 * are untested in Codex. Add a skill here once it is proven there.
 */
const CODEX_SKILLS: readonly string[] = ["review"];

/**
 * Install `CODEX_SKILLS` to `~/.agents/skills/` (where Codex reads personal
 * skills) as `pharaoh-<name>`, overwriting on reinstall. Other tools share that
 * directory, so the OpenClaw path's bare-name and manifest cleanups never run
 * here: they would delete a user's own `review` or `plan` skill.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @returns Number of skill directories copied.
 */
function installCodexSkills(home: string): number {
	return installPrefixedSkills(
		BUNDLED_SKILLS_DIR,
		join(home, ".agents", "skills"),
		SKILL_PREFIX,
		CODEX_SKILLS,
	);
}

// ── OpenClaw installer ──────────────────────────────────────────────

/**
 * Install bundled skills to `~/.openclaw/skills/` with the same `pharaoh-`
 * prefix that Claude Code installs use. Keeps naming consistent across both
 * platforms and avoids collision with other OpenClaw skills that may ship
 * bare names like `plan` or `review`.
 *
 * Overwrites existing skill dirs on reinstall.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @returns Number of skill directories copied.
 */
export function installSkills(home = homedir()): number {
	const targetDir = join(home, ".openclaw", "skills");

	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
	}

	// Read previous manifest before copying fresh skills (same rationale as
	// the Claude Code path — diff the old state against current source so
	// cut/renamed skills get cleaned up instead of lingering forever).
	const oldManifest = readPharaohManifest(targetDir);

	// Prefix skills for collision safety (same rationale as Claude Code path).
	const count = installPrefixedSkills(BUNDLED_SKILLS_DIR, targetDir, SKILL_PREFIX);

	// Legacy dual-layout cleanup for bare-name stragglers of current skills.
	cleanupBareNameSkills(BUNDLED_SKILLS_DIR, targetDir);

	// Manifest-based cut cleanup for skills removed between versions.
	cleanupRemovedSkills(BUNDLED_SKILLS_DIR, targetDir, oldManifest);

	// Stamp a fresh manifest reflecting current source.
	writePharaohManifest(targetDir, getSourceSkillNames(BUNDLED_SKILLS_DIR));

	return count;
}

/**
 * Read ~/.openclaw/openclaw.json, set the Pharaoh MCP server under `mcpServers`
 * to `npx @pharaoh-so/mcp@<this version>`, and write it back. Creates the file
 * if it does not exist. An existing `pharaoh` entry is re-pinned when it is an
 * `npx @pharaoh-so/mcp` command (extra arguments kept) and left alone when it
 * is anything else.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @returns True if the config was written, false if it was already current or is not ours.
 */
export function mergeOpenClawConfig(home = homedir()): boolean {
	const configPath = join(home, ".openclaw", "openclaw.json");

	let config: OpenClawConfig = {};

	if (existsSync(configPath)) {
		try {
			const raw = readFileSync(configPath, "utf-8");
			config = JSON.parse(raw) as OpenClawConfig;
		} catch {
			process.stderr.write(
				[
					"Pharaoh: ~/.openclaw/openclaw.json exists but is not valid JSON.",
					"Fix or delete it manually, then re-run --install-skills.",
					"",
				].join("\n"),
			);
			return false;
		}
	}

	if (!config.mcpServers) {
		config.mcpServers = {};
	}

	const pinned = pinnedPackageSpec();
	const current = config.mcpServers.pharaoh;
	if (current) {
		const spec = Array.isArray(current.args) ? current.args[0] : undefined;
		const ours =
			current.command === "npx" &&
			(spec === PACKAGE_NAME || (spec?.startsWith(`${PACKAGE_NAME}@`) ?? false));
		if (!ours || spec === pinned) return false;
	}

	config.mcpServers.pharaoh = {
		command: "npx",
		args: [pinned, ...(current?.args.slice(1) ?? [])],
	};

	writeFileSync(configPath, JSON.stringify(config, null, "\t"));
	return true;
}

// ── Claude Code permissions ─────────────────────────────────────────

/**
 * Rules the interactive setup adds to `permissions.allow` in
 * ~/.claude/settings.json: the six read-only tools and `pharaoh_account`,
 * each by full name. Never a prefix rule — `mcp__pharaoh` also auto-approves
 * account deletion and `pharaoh_admin`, so a prompt injection could run them
 * with no human in the loop (security review SC-6). Those tools keep prompting.
 */
export const PHARAOH_ALLOW_RULES: readonly string[] = [
	"mcp__pharaoh__get_codebase_map",
	"mcp__pharaoh__get_module_context",
	"mcp__pharaoh__search_functions",
	"mcp__pharaoh__get_blast_radius",
	"mcp__pharaoh__get_unused_code",
	"mcp__pharaoh__pharaoh_recon",
	"mcp__pharaoh__pharaoh_account",
];

/** The prefix rule proxies 0.3.46 and earlier wrote on every start; replaced by the list above. */
const LEGACY_ALLOW_RULE = "mcp__pharaoh";

/** Shape of the permissions block in Claude Code settings.json. */
interface ClaudePermissions {
	allow?: string[];
	deny?: string[];
	[key: string]: unknown;
}

/** Shape of ~/.claude/settings.json (partial — only the keys we touch). */
interface ClaudeSettings {
	permissions?: ClaudePermissions;
	[key: string]: unknown;
}

/** What `allowReadTools` did to ~/.claude/settings.json. */
export type AllowReadToolsResult = "added" | "migrated" | "current" | "no-settings" | "error";

/**
 * Add `PHARAOH_ALLOW_RULES` to `permissions.allow` in ~/.claude/settings.json,
 * replacing the blanket `mcp__pharaoh` rule an earlier version wrote. Runs
 * only from the interactive setup, which prints what happened; never on a
 * proxy start. Never creates the file: with no settings.json the tools
 * simply prompt on first use.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @returns "added" or "migrated" when the file was written, "current" when
 *   nothing was missing, "no-settings" when there is no file, "error" when
 *   the file is not valid JSON (left untouched).
 */
export function allowReadTools(home = homedir()): AllowReadToolsResult {
	const settingsPath = join(home, ".claude", "settings.json");
	if (!existsSync(settingsPath)) return "no-settings";

	let settings: ClaudeSettings;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as ClaudeSettings;
	} catch {
		// ALLOWED-CATCH: a file we cannot parse is a file we must not rewrite
		return "error";
	}

	const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
	const migrated = allow.includes(LEGACY_ALLOW_RULE);
	const kept = allow.filter((rule) => rule !== LEGACY_ALLOW_RULE);
	const next = [...kept, ...PHARAOH_ALLOW_RULES.filter((rule) => !kept.includes(rule))];
	if (!migrated && next.length === allow.length) return "current";

	settings.permissions = { ...settings.permissions, allow: next };
	writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"));
	return migrated ? "migrated" : "added";
}

/**
 * The line the interactive setup prints for an `allowReadTools` result, so
 * the user always learns what was done to their settings.
 *
 * @param result - What `allowReadTools` returned.
 */
export function describeAllowReadTools(result: AllowReadToolsResult): string {
	const count = PHARAOH_ALLOW_RULES.length;
	switch (result) {
		case "added":
			return `Pharaoh: allowed ${count} tools by name in ~/.claude/settings.json (permissions.allow): the read-only tools and pharaoh_account. Account deletion and pharaoh_admin still prompt.`;
		case "migrated":
			return `Pharaoh: replaced the blanket mcp__pharaoh rule in ~/.claude/settings.json with ${count} tools by name. Account deletion and pharaoh_admin prompt again.`;
		case "current":
			return `Pharaoh: ~/.claude/settings.json already allows the ${count} read-only and account tools by name.`;
		case "no-settings":
			return "Pharaoh: no ~/.claude/settings.json yet, so Pharaoh's tools ask before they run. The rules to allow the read-only tools are in the README (Security).";
		case "error":
			return "Pharaoh: ~/.claude/settings.json is not valid JSON; left as is. Pharaoh's tools ask before they run.";
	}
}

// ── Main entry point ────────────────────────────────────────────────

/** What `runInstallSkills` wants the caller to tell the user. */
export interface InstallResult {
	/** Files in ~/.claude/commands/ left as they were because they are not Pharaoh's. */
	keptCommands: string[];
}

/**
 * Main entry point for --install-skills, also run on every proxy start.
 *
 * Detection priority: Claude Code > OpenClaw > Codex > manual instructions.
 * Installs to all detected platforms (a user may use several). Never touches
 * Claude Code permissions: that is `allowReadTools`, interactive setup only.
 *
 * @param home - Home directory override (defaults to os.homedir()).
 * @param options.silent - Print nothing (the interactive setup prints its own summary).
 * @param options.claude - `claude` CLI runner (defaults to the real CLI for `home`).
 * @returns What was kept, for the caller's own summary.
 */
export function runInstallSkills(
	home = homedir(),
	options?: { silent?: boolean; claude?: ClaudeCli },
): InstallResult {
	const silent = options?.silent ?? false;
	const hasClaudeCode = detectClaudeCode(home);
	const hasOpenClaw = detectOpenClaw(home);
	let installed = false;
	const keptCommands: string[] = [];

	// ── Claude Code ──
	if (hasClaudeCode) {
		// The marketplace lives under ~/.pharaoh, which may not exist yet: create
		// it 0700 (and keep it 0700) before anything is written there.
		ensurePharaohHome(join(home, ".pharaoh"));
		removeLegacyClaudePlugin(home);
		const skillCount = writeClaudeMarketplace(home);
		const registration = registerClaudePlugin(home, options?.claude ?? claudeCliFor(home));
		const commands = installClaudeCodeCommands(home);
		keptCommands.push(...commands.kept);
		const keptLine = formatKeptCommands(commands.kept);

		if (!silent) {
			const registrationLine: Record<typeof registration, string> = {
				installed:
					"  → Installed through `claude plugin` — start a new Claude Code session to load it",
				current: "  → Already installed and enabled",
				disabled:
					"  → Disabled in Claude Code; left off (`claude plugin enable pharaoh@pharaoh` turns it on)",
				failed: `  → Couldn't run \`claude plugin install\`. Run: claude plugin marketplace add ${claudeMarketplaceDir(home)} && claude plugin install ${PLUGIN_ID}`,
			};
			process.stderr.write(
				[
					`Pharaoh: Claude Code plugin with ${skillCount} skills and the Grep routing hook`,
					registrationLine[registration],
					...(commands.installed > 0
						? [
								`  → Installed ${commands.installed} slash command${commands.installed === 1 ? "" : "s"} to ~/.claude/commands/`,
							]
						: []),
					...(keptLine ? [`  → ${keptLine}`] : []),
					...commands.removed.map((name) => `  → Removed retired ~/.claude/commands/${name}`),
					"",
				].join("\n"),
			);
		}
		installed = true;
	}

	// ── OpenClaw ──
	if (hasOpenClaw) {
		const count = installSkills(home);
		const configUpdated = mergeOpenClawConfig(home);

		if (!silent) {
			const configMsg = configUpdated
				? "Pharaoh MCP server added to ~/.openclaw/openclaw.json"
				: "Pharaoh already present in ~/.openclaw/openclaw.json — skipped";

			process.stderr.write(
				[
					`Pharaoh: installed ${count} skills to ~/.openclaw/skills/`,
					`  → ${configMsg}`,
					"",
					"Restart OpenClaw to pick up the new skills.",
					"",
				].join("\n"),
			);
		}
		installed = true;
	}

	// ── Codex ──
	if (detectCodex(home)) {
		try {
			const count = installCodexSkills(home);
			if (!silent) {
				process.stderr.write(
					`Pharaoh: installed ${count} skill to ~/.agents/skills/ for Codex ($pharaoh-review)\n\n`,
				);
			}
		} catch (err) {
			// ALLOWED-CATCH: a directory other tools share must not stop setup before the SC-6
			// permission migration; the reason is printed even when silent.
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`Pharaoh: couldn't install the review skill for Codex — ${msg}\n`);
		}
		installed = true;
	}

	// ── Neither detected ──
	if (!installed && !silent) {
		process.stderr.write(
			[
				"Pharaoh: no supported skill platform detected.",
				"",
				"Supported platforms:",
				`  • Claude Code — install the CLI from ${CLAUDE_CLI_SETUP_URL}`,
				"  • Codex      — install from https://developers.openai.com/codex",
				"  • OpenClaw   — install from https://openclaw.dev/install",
				"",
				"Once installed, re-run: npx @pharaoh-so/mcp",
				"",
			].join("\n"),
		);
	}

	return { keptCommands };
}
