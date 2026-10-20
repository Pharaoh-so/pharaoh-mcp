// @ts-check
/**
 * PreToolUse hook shipped in Pharaoh's Claude Code plugin: a Grep that is
 * really a structural question about a code symbol ("where is resolveWidget
 * defined, what calls it") is refused once per session with the Pharaoh tool
 * that answers it. A repeat of the same search runs, so an agent is never
 * stuck when the repo isn't mapped or the code changed since the last push.
 *
 * Text searches (strings, config, comments, non-code files) always run. The
 * plugin runs this file as is (no build step), so it imports only Node
 * built-ins and is plain JavaScript typed with JSDoc. Any error lets the
 * search run: a hook must never break Grep.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Credentials file under the home directory, as credentials.ts writes it (a test holds them equal). */
export const CREDENTIALS_FILE = /** @type {const} */ ([".pharaoh", "credentials.json"]);

/**
 * The fields of Claude Code's PreToolUse payload this hook reads.
 * @typedef {object} GrepHookInput
 * @property {string} [session_id] Claude Code session; redirects are remembered per session.
 * @property {string} [tool_name] Tool about to run; only Grep is routed.
 * @property {{ pattern?: string, path?: string, glob?: string, type?: string }} [tool_input]
 *   Grep's arguments: the regex, the file or directory searched, a glob ("*.ts") or a ripgrep type ("py").
 */

/** File extensions of the languages Pharaoh maps. */
const MAPPED_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py"]);
/** ripgrep `--type` names of the languages Pharaoh maps. */
const MAPPED_TYPES = new Set(["ts", "typescript", "js", "javascript", "py", "python"]);

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const DEFINITION = new RegExp(
	`^(?:export )?(?:default )?(?:async )?(?:function|class|def|interface|type|enum|const|let|var) (${IDENTIFIER})$`,
);
const BARE_IDENTIFIER = new RegExp(`^${IDENTIFIER}$`);

/**
 * The code symbol a Grep pattern searches for, or null when it's a text search.
 * Matches a bare camelCase, PascalCase or snake_case name, a definition
 * (`function foo`, `class Foo`, `def foo`) or a call (`foo(`). Plain words,
 * ALL_CAPS constants and regexes are text.
 *
 * @param {string} pattern Grep's pattern argument.
 * @returns {string | null}
 */
export function symbolSearched(pattern) {
	const normalized = pattern
		.replace(/\\b/g, "")
		.replace(/\\s[+*]?/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\s*\\?\($/, "");
	const definition = normalized.match(DEFINITION);
	if (definition) return definition[1];
	if (!BARE_IDENTIFIER.test(normalized) || normalized.length < 4) return null;
	const camel = /[a-z][A-Z]/.test(normalized);
	const snake = /^[a-z][a-z0-9]*_[a-z0-9_]*[a-z0-9]$/.test(normalized);
	return camel || snake ? normalized : null;
}

/**
 * Whether a Grep searches files of a language Pharaoh maps (or doesn't narrow by file at all).
 * @param {NonNullable<GrepHookInput["tool_input"]>} input
 * @returns {boolean}
 */
function searchesMappedCode(input) {
	if (input.type) return MAPPED_TYPES.has(input.type.toLowerCase());
	if (input.glob) {
		const braces = input.glob.match(/\.\{([^}]+)\}$/);
		const single = input.glob.match(/\.([A-Za-z0-9]+)$/);
		const extensions = braces ? braces[1].split(",") : single ? [single[1]] : [];
		return extensions.length === 0 || extensions.some((ext) => MAPPED_EXTENSIONS.has(ext.trim()));
	}
	const extension = input.path?.match(/\.([A-Za-z0-9]+)$/)?.[1];
	return extension === undefined || MAPPED_EXTENSIONS.has(extension.toLowerCase());
}

/**
 * Decide one Grep: the reason to send the agent to Pharaoh, or null to let it run.
 * A symbol is redirected once per session; `redirected` records it.
 *
 * @param {GrepHookInput} input Claude Code's PreToolUse payload.
 * @param {boolean} signedIn Whether the Pharaoh proxy has credentials on this machine.
 * @param {Set<string>} redirected Symbols already redirected this session (updated in place).
 * @returns {string | null}
 */
export function routeGrep(input, signedIn, redirected) {
	if (!signedIn || input.tool_name !== "Grep" || !input.tool_input) return null;
	const symbol = symbolSearched(input.tool_input.pattern ?? "");
	if (!symbol || redirected.has(symbol) || !searchesMappedCode(input.tool_input)) return null;
	redirected.add(symbol);
	return [
		`\`${symbol}\` looks like a code symbol, and Pharaoh answers that from the code graph in one call:`,
		"search_functions finds where it's defined and whether something similar exists;",
		"get_blast_radius lists what calls it and what breaks if it changes;",
		"get_unused_code says whether it's used.",
		"If you're renaming it or need every text reference (tests, mocks), or Pharaoh can't answer (repo not mapped, or the code changed since the last push), run this Grep again and it will go through.",
	].join(" ");
}

/** Hook entry point: read the payload from stdin, reply with a PreToolUse deny or nothing. */
function main() {
	try {
		/** @type {GrepHookInput} */
		const input = JSON.parse(readFileSync(0, "utf-8"));
		// Without a session there's nowhere to remember the redirect: never refuse twice.
		if (!input.session_id) return;
		const signedIn = existsSync(join(homedir(), ...CREDENTIALS_FILE));
		const stateDir =
			process.env.PHARAOH_ROUTE_GREP_STATE_DIR ?? join(tmpdir(), "pharaoh-route-grep");
		const stateFile = join(stateDir, `${input.session_id.replace(/[^\w-]/g, "_")}.json`);
		/** @type {Set<string>} */
		const redirected = new Set(
			existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf-8")) : [],
		);
		const reason = routeGrep(input, signedIn, redirected);
		if (!reason) return;
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		writeFileSync(stateFile, JSON.stringify([...redirected]), { mode: 0o600 });
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: reason,
				},
			}),
		);
	} catch {
		// ALLOWED-CATCH: a hook must never break Grep — on any error the search runs
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
