/**
 * The session-start update notice, a SessionStart hook for Claude Code and Codex
 * (`node ~/.pharaoh/update-notice-hook.mjs <client> --pharaoh-update-notice-v1`).
 * It reads one local file, ~/.pharaoh/update-notice.json: the installed version,
 * which the installer writes, and npm's latest, which the proxy's daily
 * background check writes. While the install is behind, every session gives the
 * agent the update command, and the first session of each local day also shows
 * the person one line. It never touches the network and always exits 0.
 *
 * The installer copies this file to a stable path, so the hook command (and
 * Codex's trust in it) outlives updates. It imports only Node built-ins for that
 * reason.
 *
 * Behind the stable launcher (runtime/launcher-v1.mjs), the installed version is
 * the one the launcher runs (runtimes/mcp/current.json), since an accepted update
 * changes it without an install; a release already staged for the next session
 * start (pending.json) counts as accepted; and the agent is told to use
 * pharaoh_update, which verifies the release before staging it.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The marker that ends the hook command, so cleanup removes only this handler. */
export const UPDATE_NOTICE_MARKER = "--pharaoh-update-notice-v1";
/** Where the installer copies this file, inside ~/.pharaoh. */
export const UPDATE_NOTICE_HOOK = "update-notice-hook.mjs";
const STATE = "update-notice.json";
const SHOWN = "update-notice-shown";
const UPDATE_COMMAND = "npx @pharaoh-so/mcp@latest install";
const LABELS = { "claude-code": "Claude Code", codex: "Codex" };
const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;

/** Remove a temporary file; a leftover only costs disk space. */
function discard(path) {
	try {
		rmSync(path, { force: true });
	} catch {
		// Nothing more to do.
	}
}

function parts(version) {
	const match = typeof version === "string" ? VERSION.exec(version) : null;
	return match ? match.slice(1).map(Number) : null;
}

/**
 * Whether `candidate` is a newer plain x.y.z than `current`.
 * @param {unknown} candidate
 * @param {unknown} current
 * @returns {boolean} false when either isn't a plain x.y.z
 */
export function newerVersion(candidate, current) {
	const a = parts(candidate);
	const b = parts(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
	return false;
}

/**
 * The stored versions, as the installer and the daily check left them.
 * @param {string} directory - ~/.pharaoh, or a test directory
 * @returns {{ version?: unknown, latest?: unknown, release_checked_at?: unknown } | null}
 *   null when the file is missing, oversized or not a JSON object
 */
export function readUpdateState(directory) {
	try {
		const path = join(directory, STATE);
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > 4_096) return null;
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * Merge `fields` into the stored versions with an atomic replace. Callers that can
 * race (the installer, the daily check) hold the credentials lock.
 * @param {{ version?: string, latest?: string, release_checked_at?: string }} fields
 * @param {string} directory - ~/.pharaoh, or a test directory
 * @returns {boolean} true when written; never throws
 */
export function writeUpdateState(fields, directory) {
	const temporary = join(directory, `${STATE}.${randomUUID()}.tmp`);
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const next = { ...readUpdateState(directory), ...fields };
		writeFileSync(temporary, `${JSON.stringify(next)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, join(directory, STATE));
		return true;
	} catch {
		discard(temporary);
		return false;
	}
}

/**
 * Copy this file to its stable hook path, replacing an older copy atomically.
 * @param {string} directory - ~/.pharaoh, or a test directory
 * @returns {string | null} The hook's path, or null when it couldn't be written
 */
export function copyUpdateNoticeHook(directory) {
	const target = join(directory, UPDATE_NOTICE_HOOK);
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		const source = readFileSync(fileURLToPath(import.meta.url));
		try {
			if (readFileSync(target).equals(source)) return target;
		} catch {
			// No copy yet.
		}
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(temporary, source, { flag: "wx", mode: 0o600 });
		renameSync(temporary, target);
		return target;
	} catch {
		discard(temporary);
		return null;
	}
}

/**
 * How the agent is told to update. One place, so an install with another update
 * path changes this sentence and nothing else.
 * @param {"claude-code" | "codex"} client
 * @param {boolean} launcher - The install runs behind the stable launcher
 */
function howToUpdate(client, launcher) {
	if (launcher)
		return `If the person asks to update Pharaoh, call pharaoh_update: it checks the release's npm signature and build provenance, and the new version runs when they next start ${LABELS[client]}.`;
	return `If the person asks to update Pharaoh, run \`${UPDATE_COMMAND}\` (and the \`--migrate-legacy\` command it prints, if it prints one), then tell them to restart ${LABELS[client]} to use the new version.`;
}

/**
 * The version in one of the stable launcher's pointer files (current.json, pending.json).
 * @param {string} directory - ~/.pharaoh
 * @param {string} name
 * @returns {string | undefined} undefined without a launcher or a readable version
 */
function launcherVersion(directory, name) {
	try {
		const path = join(directory, "runtimes", "mcp", name);
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > 4_096) return undefined;
		const version = JSON.parse(readFileSync(path, "utf8"))?.version;
		return parts(version) ? version : undefined;
	} catch {
		return undefined;
	}
}

/** The local calendar day of `now`, as YYYY-MM-DD. */
function localDay(now) {
	const day = new Date(now);
	const pad = (value) => String(value).padStart(2, "0");
	return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/**
 * Claim today's visible line on this machine, by creating today's marker
 * exclusively: exactly one session start a day wins, across both clients.
 * Earlier days' markers are removed.
 */
function claimDay(directory, now) {
	const shown = join(directory, SHOWN);
	const today = localDay(now);
	try {
		mkdirSync(shown, { recursive: true, mode: 0o700 });
		// A real directory only, never a link: its other entries are removed below.
		if (!lstatSync(shown).isDirectory()) return false;
		closeSync(openSync(join(shown, today), "wx", 0o600));
	} catch {
		return false;
	}
	try {
		for (const name of readdirSync(shown))
			if (name !== today) rmSync(join(shown, name), { force: true, recursive: true });
	} catch {
		// Another session pruned first; today's claim stands.
	}
	return true;
}

/**
 * This session start's output: nothing while the install is current; while it is
 * behind, the update command for the agent and, once a day, one line for the person.
 * @param {string | undefined} client - "claude-code" or "codex"
 * @param {{ directory?: string, now?: number }} [options]
 * @returns {{ systemMessage?: string, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: string } } | null}
 */
export function updateNotice(
	client,
	{ directory = join(homedir(), ".pharaoh"), now = Date.now() } = {},
) {
	if (!Object.hasOwn(LABELS, client ?? "")) return null;
	const state = readUpdateState(directory);
	if (!state) return null;
	const launched = launcherVersion(directory, "current.json");
	const installed = launched ?? state.version;
	if (!newerVersion(state.latest, installed)) return null;
	// Already accepted: the staged version runs from the next session start.
	const staged = launched ? launcherVersion(directory, "pending.json") : undefined;
	if (staged && !newerVersion(state.latest, staged)) return null;
	const context = `Pharaoh ${state.latest} is available; this machine has ${installed}. ${howToUpdate(client, Boolean(launched))}`;
	return {
		...(claimDay(directory, now) && {
			systemMessage: `Pharaoh ${state.latest} is available — you're on ${installed}.`,
		}),
		hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
	};
}

function invokedDirectly() {
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (invokedDirectly() && process.argv[3] === UPDATE_NOTICE_MARKER) {
	try {
		const output = updateNotice(process.argv[2]);
		if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
	} catch {
		// A notice is never worth a failed session start.
	}
}
