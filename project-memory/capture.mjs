/**
 * Automatic project-memory capture. Native tool hooks keep a short per-turn log of code
 * edits and check commands on this machine. When a turn edited code and a check then
 * passed, the Stop hook asks the agent once for the decision or fix and its reason, and a
 * detached sender saves it with a procedure built only from what the hooks observed.
 * See VISION.md § Memory saves what a turn proved, without asking.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { citeRefs, safeRecap } from "./execute-turn.mjs";
import { editedPaths } from "./graph-cues.mjs";
import {
	atomicWrite,
	DIAGNOSTIC_SHELL_TOOLS,
	git,
	gitRaw,
	memoryEgressDecision,
	sessionKey,
	updateLocalState,
} from "./local.mjs";
import { requestMemory } from "./memory-api.mjs";
import { memoryClientRoot, projectMemorySession, readMemoryCredentials } from "./user-target.mjs";

const TURN_TTL = 12 * 60 * 60 * 1000;
const MAX_EVENTS = 24;
const MAX_PATHS = 6;
/** Source files: an edit to one of these is a code edit. Docs, config and lockfiles are not. */
const CODE_FILE =
	/\.(?:[cm]?[jt]s|[jt]sx|py|go|rs|java|kt|kts|scala|rb|php|cs|swift|c|cc|cpp|cxx|h|hh|hpp|m|mm|ex|exs|vue|svelte|dart|lua|sh)$/i;
/** Commands that check code: test runners, type checkers, linters and builds. */
const CHECK =
	/^(?:(?:npm|pnpm|yarn|bun)(?: run)? (?:test|lint|check|typecheck|type-check|tsc|build|verify)(?::[\w:-]+)?|(?:npx|pnpm exec|pnpm dlx|yarn dlx|bunx) (?:vitest|jest|tsc|biome|eslint|mocha|playwright test)|vitest|jest|mocha|tsc|eslint|biome (?:check|lint|ci)|node --test|deno (?:test|check|lint)|bun test|pytest|python3? -m (?:pytest|unittest|mypy)|mypy|ruff check|go (?:test|vet|build)|cargo (?:test|check|clippy|build)|make (?:test|check|lint)|mvn (?:test|verify)|(?:\.\/)?gradlew? (?:test|check)|dotnet test|(?:bundle exec )?rspec|phpunit|mix test)(?:\s|$)/;
/** Credential-shaped text: known token prefixes, or a secret-named option or variable with a value. */
const SECRET_SHAPED =
	/\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA|ASIA|glpat-|npm_)|(?:token|secret|passw(?:or)?d|api[_-]?key|auth|credential)\w*\s*[=:]/i;

/**
 * A saved procedure leaves the machine, so its command never carries a secret: inline
 * environment (`FOO=bar npm test`) is dropped, and a command with a credential-shaped
 * string, or a long opaque word mixing letters and digits, is not kept at all.
 */
function withoutSecrets(text) {
	const bare = text.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "");
	const opaque = bare
		.split(/[\s=:'",/]+/)
		.some((word) => word.length >= 24 && /\d/.test(word) && /[A-Za-z]/.test(word));
	return SECRET_SHAPED.test(bare) || opaque ? undefined : bare;
}

/** Argument text a procedure may keep: no expansion, substitution, chaining or absolute paths. */
const SAFE_ARGS = /^[\w@.:=+,%/ "'-]*$/;
// A runner's own summary. Failures win over passes; an unknown summary proves nothing.
const RUNNER_FAILED =
	/^# fail [1-9]|^not ok\b|\b[1-9]\d* (?:failed|failing|fail|failures?)\b|^(?:FAIL|FAILED)\b|test result: FAILED/m;
const RUNNER_TOTAL = /^# pass [1-9]|\b[1-9]\d* (?:passed|passing|pass)\b|test result: ok\.|^OK\b/m;
/** A zero-failure total: filtering can drop lines but cannot print this one. */
const ZERO_FAILED =
	/^# fail 0\s*$|\b0 (?:failed|failing|failures?)\b|test result: ok\. \d+ passed; 0 failed/m;
/** A per-package line, not a total: behind `tail` an earlier FAIL can be cut off. */
const GO_PACKAGE_OK = /^ok\s+\S+\s+(?:\(cached\)|[\d.]+s)\s*$/m;
const NOTE = /^[ \t>*_]*Pharaoh memory[*_]*:[*_]*[ \t]*(.*)$/im;
const WHY = /^[ \t>*_]*Why[*_]*:[*_]*[ \t]*/im;

export function captureDirectory(root) {
	return join(root, "capture");
}

/**
 * The check a shell command ran, safe to keep, or undefined. In an `&&` chain a later
 * step runs only after the check exits 0, so the chain's status is the check's; `;`,
 * `||` and background jobs break that and are refused.
 */
export function checkCommand(command, prefix = "") {
	if (typeof command !== "string" || command.length > 400) return;
	const chain = command.trim().replace(/\s*\d?>&\d/g, "");
	if (/[\r\n;`$]|\|\||(?<!&)&(?!&)/.test(chain)) return;
	let directory = prefix;
	let found;
	for (const step of chain.split(/\s*&&\s*/)) {
		const cd = /^cd ([\w@.+-]+(?:\/[\w@.+-]+)*)$/.exec(step);
		if (cd && !cd[1].split("/").includes("..")) {
			directory = directory ? `${directory}/${cd[1]}` : cd[1];
			continue;
		}
		if (/^cd\b/.test(step)) return;
		// A pipe hides the check's exit status, so only the runner's own summary can prove a
		// pass. `tail` and `cat` keep the end whole; `head` and `grep` can drop the failures,
		// so behind them only a visible zero-failure total counts. `grep -v` proves nothing.
		const pipe = /^([^|]+?)\s*\|\s*(tail|cat|head|grep|egrep)\b(?!.*\s-v\b).*$/.exec(step);
		const raw = pipe ? pipe[1] : step;
		const text = withoutSecrets(raw);
		if (text === undefined) {
			if (CHECK.test(raw.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, ""))) return;
			continue;
		}
		if (!CHECK.test(text)) continue;
		if (
			/[|<>\\]/.test(text) ||
			!SAFE_ARGS.test(text) ||
			/(?:^|\s)\//.test(text) ||
			text.length > 120
		)
			return;
		// The last check in the chain ran last.
		found = {
			command: directory ? `cd ${directory} && ${text}` : text,
			piped: Boolean(pipe),
			...(pipe && !["tail", "cat"].includes(pipe[2]) && { narrowed: true }),
		};
	}
	return found;
}

function outputText(response) {
	if (typeof response === "string") return response;
	if (response && typeof response === "object")
		return [response.stdout, response.stderr, response.output]
			.filter((part) => typeof part === "string")
			.join("\n");
	return "";
}

/**
 * Pass, fail or unknown for one observed check. Claude Code runs PostToolUse only when a
 * command exits 0 and PostToolUseFailure otherwise; Codex reports neither, so there and
 * behind a pipe only the runner's own summary counts.
 */
export function checkStatus(input, client, piped, narrowed = false) {
	if (input.hook_event_name === "PostToolUseFailure") return { status: "fail" };
	const response = input.tool_response;
	// A background command reports before it has finished.
	if (input.tool_input?.run_in_background === true || response?.backgroundTaskId)
		return { status: "unknown" };
	if (response?.interrupted === true || response?.isError === true) return { status: "fail" };
	const text = outputText(response).slice(-8192);
	if (RUNNER_FAILED.test(text)) return { status: "fail" };
	if (client === "claude-code" && !piped) return { status: "pass", evidence: "exit" };
	if (narrowed)
		return RUNNER_TOTAL.test(text) && ZERO_FAILED.test(text)
			? { status: "pass", evidence: "summary" }
			: { status: "unknown" };
	if (RUNNER_TOTAL.test(text) || (!piped && GO_PACKAGE_OK.test(text)))
		return { status: "pass", evidence: "summary" };
	return { status: "unknown" };
}

function turnId(input) {
	const id = input.turn_id ?? input.prompt_id;
	return typeof id === "string" && id.length <= 256 ? id : undefined;
}

/** When this turn began: Codex turn ids are UUIDv7, which lead with a millisecond time. */
function turnStart(input, now) {
	const id = input.turn_id;
	if (typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id)) {
		const time = Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
		if (time <= now && now - time < TURN_TTL) return time;
	}
	return now;
}

/**
 * Source files the worktree changed after `since`, by any means: an agent can edit with a
 * shell command (sed, a script) that no edit hook sees. Git decides what changed; the
 * modification time decides whether this turn changed it.
 */
function worktreeEdits(root, since, until) {
	let status;
	try {
		status = gitRaw(root, 262_144, "status", "--porcelain=v1", "-z", "--untracked-files=all");
	} catch {
		return null;
	}
	const paths = [];
	for (const entry of status.split("\0")) {
		if (!/^[ MADRCU?]{2} /.test(entry) || paths.length >= MAX_PATHS) continue;
		const path = entry.slice(3);
		if (!CODE_FILE.test(path)) continue;
		try {
			const { mtimeMs } = statSync(join(root, path));
			if (mtimeMs > since && mtimeMs <= until) paths.push(path);
		} catch {
			// Deleted since: nothing to cite.
		}
	}
	return paths;
}

/** The events since the last scan, with any edit the worktree shows that no hook reported. */
function withWorktreeEdits(state, entry, now) {
	const paths = worktreeEdits(state.root, state.scannedAt ?? state.startedAt ?? now, now);
	// Unreadable at Stop, the worktree may hold an edit after the last check: unproven.
	// At a check it only hides which files changed.
	const seen = paths ?? (entry ? [] : null);
	const events =
		seen === null
			? [...state.events, { edit: [] }]
			: seen.length
				? [...state.events, { edit: seen }]
				: state.events;
	return { events: entry ? [...events, entry] : events, scannedAt: now };
}

function freshState(input, target, turn, now) {
	const startedAt = turnStart(input, now);
	return {
		turn,
		repo: target.repo,
		root: target.root,
		events: [],
		startedAt,
		scannedAt: startedAt,
		expires: now + TURN_TTL,
	};
}

/** At a prompt, open the turn's log so a later check can see what the turn changed. */
export function beginTurn(input, { client, target, directory, now = Date.now() }) {
	const name = stateName(client, input);
	const turn = turnId(input);
	if (!name || !turn) return;
	updateLocalState(
		directory,
		name,
		(previous) =>
			previous?.turn === turn && previous.expires > now
				? undefined
				: { state: freshState(input, target, turn, now) },
		now,
	);
}

function stateName(client, input) {
	const key = sessionKey(client, input.session_id);
	return key && `turn-${key}.json`;
}

/**
 * Record one code edit or check command in the turn's local log. The first check that
 * proves the turn returns the ask, as context for the agent; Stop asks only if that
 * did not reach the final reply.
 */
export function recordToolEvent(
	input,
	{ client, target, directory, memorySession, binding, now = Date.now() },
) {
	const name = stateName(client, input);
	const turn = turnId(input);
	if (!name || !turn) return;
	let entry;
	let canAsk = false;
	if (DIAGNOSTIC_SHELL_TOOLS.has(input.tool_name)) {
		let prefix = "";
		try {
			prefix = relative(target.root, realpathSync(input.cwd ?? target.root))
				.split("\\")
				.join("/");
		} catch {
			return;
		}
		if (prefix.startsWith("..") || isAbsolute(prefix)) return;
		const check = checkCommand(input.tool_input?.command ?? input.tool_input?.cmd, prefix);
		if (!check) return;
		const { status, evidence } = checkStatus(input, client, check.piped, check.narrowed);
		entry = { check: check.command, status, ...(evidence && { evidence }) };
		// Ask only where the answer could be saved: a sign-in, outside a fenced conversation.
		canAsk =
			status === "pass" &&
			Boolean(memorySession) &&
			memoryEgressDecision(binding, "capture") === "normal";
	} else {
		const paths = editedPaths(input, client, target.root, true)
			.map((path) => path.split("\\").join("/"))
			.filter((path) => CODE_FILE.test(path));
		if (!paths.length) return;
		entry = { edit: paths.slice(0, MAX_PATHS) };
	}
	return updateLocalState(
		directory,
		name,
		(previous) => {
			const fresh = !previous || previous.turn !== turn || previous.expires <= now;
			const state = fresh ? freshState(input, target, turn, now) : previous;
			if (state.asked || state.repo !== target.repo) return;
			// A check also looks at the worktree, for edits made without an edit tool.
			const scanned = entry.check ? withWorktreeEdits(state, entry, now) : null;
			const events = (scanned?.events ?? [...state.events, entry]).slice(-MAX_EVENTS);
			const proof = canAsk && !state.cued && turnProof(events);
			return {
				state: {
					...state,
					events,
					...(scanned && { scannedAt: scanned.scannedAt }),
					...(proof && { cued: true }),
				},
				...(proof && { context: askAgent(proof, target.repo, false) }),
			};
		},
		now,
	);
}

/** The proof a turn needs: code edits, then a check that passed after the last of them. */
export function turnProof(events) {
	const lastEdit = events.findLastIndex((event) => event.edit);
	if (lastEdit < 0) return;
	const checks = events.slice(lastEdit + 1).filter((event) => event.check);
	const final = checks.at(-1);
	if (final?.status !== "pass") return;
	const paths = [...new Set(events.flatMap((event) => event.edit ?? []))].slice(0, MAX_PATHS);
	return { paths, check: final.check, evidence: final.evidence };
}

function askAgent(proof, repo, atStop) {
	return [
		`Pharaoh project memory: this turn changed ${proof.paths.join(", ")} and \`${proof.check}\` then passed. ${atStop ? "End your reply" : "When you finish, end your final reply"} with these two lines so later work in ${repo} remembers it:`,
		"Pharaoh memory: <what you changed and where, naming the function or file, in one sentence>",
		"Why: <the root cause or constraint behind it, specific enough to act on later; not just that a test failed>",
		'If nothing here is worth remembering, write "Pharaoh memory: none". No code, secrets or personal details. Run no tools for this.',
	].join("\n");
}

function clip(text, limit) {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= limit) return flat;
	const cut = flat.slice(0, limit - 1);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit / 2))}…`;
}

/** The agent's note from its final message: a summary and a reason, or nothing. */
export function parseNote(message) {
	if (typeof message !== "string") return;
	const note = NOTE.exec(message);
	if (!note) return;
	const rest = message.slice(note.index + note[0].length);
	const why = WHY.exec(rest);
	if (!why) return;
	const rawSummary = note[1].replace(/[*_]+$/, "");
	const rawDetail = rest.slice(why.index + why[0].length).split(/\n\s*\n/)[0];
	// The safety rules read line starts (code, transcript lines), so they see the text as
	// written, before it is flattened onto one line.
	if (!safeRecap(rawSummary) || !safeRecap(rawDetail)) return;
	const summary = clip(rawSummary, 500);
	const detail = clip(rawDetail, 1000);
	if (!summary || !detail || /^none\b/i.test(summary)) return;
	return { summary, detail };
}

/** The two records a proven turn saves: the agent's note and the observed procedure. */
export function captureRecords(note, proof, client, now = Date.now()) {
	const day = new Date(now).toISOString().slice(0, 10);
	const evidence =
		proof.evidence === "exit" ? "exited 0" : "reported passing tests and no failures";
	const refs = proof.paths.map((path) => ({ path }));
	const files = proof.paths.map((path) => basename(path)).join(", ");
	return [
		{
			kind: "lesson",
			summary: note.summary,
			detail: note.detail,
			verification: clip(`\`${proof.check}\` ${evidence} after the change (${day}).`, 300),
			refs,
		},
		{
			kind: "observation",
			summary: clip(`To check a change to ${files}, run \`${proof.check}\`.`, 500),
			detail: clip(
				`Observed by the Pharaoh hook in ${client === "codex" ? "Codex" : "Claude Code"} on ${day}: after editing ${proof.paths.join(", ")}, \`${proof.check}\` ${evidence}.`,
				1000,
			),
			verification: clip(`The hook saw \`${proof.check}\` ${evidence}.`, 300),
			recallWhen: ["verifying a change", "which check to run"],
			refs,
		},
	].filter((record) =>
		Object.values(record).every((value) => typeof value !== "string" || safeRecap(value)),
	);
}

function launchSender(path) {
	spawn(
		process.execPath,
		[join(dirname(fileURLToPath(import.meta.url)), "diagnostics-sender.mjs"), "--capture", path],
		{ detached: true, stdio: "ignore" },
	).unref();
}

export const UNDO_COMMAND = "npx @pharaoh-so/mcp --undo-memory";
export const OFF_COMMAND = "npx @pharaoh-so/mcp --disable-memory-capture";

/**
 * At Stop: ask once when the turn proved a change, then save the agent's answer. Returns
 * the hook output, or nothing. Never blocks twice for one turn.
 */
export function stopDecision(
	input,
	{ client, target, directory, memorySession, binding, now = Date.now(), launch = launchSender },
) {
	const name = stateName(client, input);
	const turn = turnId(input);
	if (!name || !turn || !memorySession) return;
	if (memoryEgressDecision(binding, "capture") !== "normal") return;
	let save;
	const output = updateLocalState(
		directory,
		name,
		(state) => {
			if (!state || state.turn !== turn || state.expires <= now || state.repo !== target.repo)
				return;
			// An edit after the last check, by any means, leaves the turn unproven.
			const proof = turnProof(withWorktreeEdits(state, null, now).events);
			if (!proof) return { state: { ...state, events: [] } };
			const message = input.last_assistant_message;
			const note = parseNote(message);
			if (!note) {
				// Ask at Stop only when the reply has no note at all, and only once.
				const answered = typeof message === "string" && NOTE.test(message);
				if (answered || state.asked || input.stop_hook_active === true)
					return { state: { ...state, events: [], asked: true } };
				return {
					state: { ...state, asked: true },
					context: { decision: "block", reason: askAgent(proof, target.repo, true) },
				};
			}
			save = {
				client,
				repo: target.repo,
				root: target.root,
				binding,
				memorySession,
				createdAt: now,
				records: captureRecords(note, proof, client, now).map((record) => ({
					...record,
					operationId: randomUUID(),
				})),
			};
			return {
				state: { ...state, events: [], asked: true },
				context: {
					systemMessage: `Pharaoh is saving this to project memory for ${target.repo}: ${note.summary} Undo: ${UNDO_COMMAND}. Stop automatic saving: ${OFF_COMMAND}.`,
				},
			};
		},
		now,
	);
	if (save?.records.length) {
		const path = join(directory, `pending-${randomUUID()}.json`);
		atomicWrite(path, JSON.stringify(save));
		launch(path);
	}
	retryPendingCaptures(directory, { now, launch });
	return output;
}

const PENDING = /^pending-[a-f0-9-]{36}\.json$/;
/** Refusals that can pass later: a stale sign-in and the rate limit. */
const RETRYABLE = [401, 429];
const TURN_FILE = /^turn-[a-f0-9]{64}\.json$/;
const PENDING_TTL = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const CLAIM_MS = 60_000;

/** Start the sender again for saves a throttled or interrupted send left behind. */
export function retryPendingCaptures(directory, { now = Date.now(), launch = launchSender } = {}) {
	let names = [];
	try {
		names = readdirSync(directory);
	} catch {
		return;
	}
	// A turn log lives at most 12 hours.
	for (const name of names.filter((entry) => TURN_FILE.test(entry)).slice(0, 20)) {
		try {
			if (!(readPrivate(join(directory, name)).expires > now))
				rmSync(join(directory, name), { force: true });
		} catch {
			rmSync(join(directory, name), { force: true });
		}
	}
	names = names.filter((name) => PENDING.test(name));
	for (const name of names.slice(0, 3)) {
		try {
			const pending = readPrivate(join(directory, name));
			// A fresh save is still with its first sender; retry after the backoff.
			const due = pending.retryAt ?? (pending.createdAt ?? 0) + 30_000;
			if (due <= now && (pending.claimedUntil ?? 0) <= now) launch(join(directory, name));
		} catch {
			// Another sender may have finished it.
		}
	}
}

function readPrivate(path, limit = 16_384) {
	const file = lstatSync(path);
	if (!file.isFile() || file.uid !== process.getuid?.() || file.mode & 0o077 || file.size > limit)
		throw new Error("Expected an owner-private capture file.");
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Detached sender: save a pending capture, then keep a receipt for --undo-memory. The
 * first attempt pins the revision and cited refs, so a retry sends the same payload under
 * the same operation ID and Pharaoh returns the record it already saved. A refusal drops
 * the record; an unconfirmed send waits for a later Stop, up to five attempts in a day.
 */
export async function sendCapture(
	path,
	{ request = requestMemory, credentials, now = Date.now() } = {},
) {
	let pending;
	try {
		pending = readPrivate(path);
	} catch {
		return;
	}
	if ((pending.claimedUntil ?? 0) > now) return;
	// The sign-in that saw the turn is the one that saves it. Without explicit credentials
	// the request loads them and refreshes an expired token.
	const current = credentials ?? (await readMemoryCredentials());
	if (
		!current ||
		projectMemorySession(current) !== pending.memorySession ||
		now - (pending.createdAt ?? 0) > PENDING_TTL
	)
		return rmSync(path, { force: true });
	atomicWrite(path, JSON.stringify({ ...pending, claimedUntil: now + CLAIM_MS }));
	if (!pending.gitRev) {
		const gitRev = git(pending.root, "rev-parse", "HEAD");
		if (!/^[a-f0-9]{40}$/i.test(gitRev)) return rmSync(path, { force: true });
		const records = [];
		for (const { refs, ...record } of pending.records)
			records.push({
				...record,
				refs: refs?.length ? await citeRefs(pending.root, gitRev, refs) : undefined,
			});
		pending = { ...pending, gitRev, records };
	}
	const done = pending.done ?? [];
	for (const record of pending.records) {
		if (done.some((entry) => entry.operationId === record.operationId)) continue;
		try {
			const result = await request(
				"capture",
				{ repo: pending.repo, ...record, gitRev: pending.gitRev, client: pending.client },
				{ ...(credentials && { credentials }), client: pending.client, binding: pending.binding },
			);
			const { id, version } = result?.record ?? {};
			done.push({ operationId: record.operationId, ...(id && { id, version }) });
		} catch (error) {
			// A stale sign-in (401) and the rate limit (429) can pass later; other refusals are final.
			if (error?.rejected && !RETRYABLE.includes(error.status)) {
				done.push({ operationId: record.operationId });
				continue;
			}
			const attempts = (pending.attempts ?? 0) + 1;
			if (attempts >= MAX_ATTEMPTS) break;
			atomicWrite(
				path,
				JSON.stringify({
					...pending,
					done,
					attempts,
					retryAt: now + 30_000 * attempts,
					claimedUntil: 0,
				}),
			);
			return;
		}
	}
	const saved = done.filter((entry) => entry.id).map(({ id, version }) => ({ id, version }));
	if (saved.length)
		atomicWrite(
			join(dirname(path), "last.json"),
			JSON.stringify({ repo: pending.repo, records: saved, at: pending.createdAt ?? now }),
		);
	rmSync(path, { force: true });
}

/**
 * Undo the most recent automatic save: cancel what it has not sent and delete what it
 * saved, while each record is still an unchanged candidate of yours. Progress is kept, so
 * an undo cut off by the network can run again.
 */
export async function undoLastCapture({ request = requestMemory, home = homedir(), helper } = {}) {
	const directory = captureDirectory(memoryClientRoot(home));
	const receipt = join(directory, "last.json");
	const saves = [];
	for (const name of existsSync(directory) ? readdirSync(directory) : []) {
		if (name !== "last.json" && !PENDING.test(name)) continue;
		try {
			const data = readPrivate(join(directory, name));
			saves.push({ path: join(directory, name), data, at: data.createdAt ?? data.at ?? 0 });
		} catch {
			// A sender finished it meanwhile.
		}
	}
	const latest = saves.sort((a, b) => b.at - a.at)[0];
	if (!latest) return { undone: 0, repo: undefined };
	const { data } = latest;
	let undone = 0;
	let records = data.records ?? [];
	if (latest.path !== receipt) {
		rmSync(latest.path, { force: true });
		const done = data.done ?? [];
		undone = records.filter(
			(record) => !done.some((entry) => entry.operationId === record.operationId),
		).length;
		records = done.filter((entry) => entry.id).map(({ id, version }) => ({ id, version }));
	}
	for (const record of [...records]) {
		try {
			// The undo comes from the user's terminal, not from a conversation.
			const result = await request(
				"forget",
				{ repo: data.repo, id: record.id, version: record.version },
				{ binding: null, home, helper },
			);
			if (result?.forgotten) undone += 1;
		} catch (error) {
			// Unconfirmed, rate limited (429) or a stale sign-in (401): keep the rest for a retry.
			if (!error?.rejected || RETRYABLE.includes(error.status)) {
				atomicWrite(receipt, JSON.stringify({ repo: data.repo, records, at: latest.at }));
				throw error;
			}
			// Already deleted, approved or changed by someone: nothing of it left to undo.
		}
		records = records.filter((entry) => entry !== record);
	}
	if (latest.path === receipt) rmSync(receipt, { force: true });
	return { undone, repo: data.repo };
}
