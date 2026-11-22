/** Local, opt-in change review: one native continuation and content-bound proof per turn. */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { readActiveMemoryClients } from "./client-settings.mjs";
import { atomicWrite, gitRawBefore, REPO, shellWord, updateLocalState } from "./local.mjs";
import { changeReviewEnabled } from "./preferences.mjs";
import { localReviewHooksInstalled } from "./user-target.mjs";

const TTL = 12 * 60 * 60 * 1000;
const MAX_DIFF = 2 * 1024 * 1024;
const MAX_INPUT = 128 * 1024 * 1024;
const MAX_FILES = 12_000;
const MAX_RUN = 2 * 1024 * 1024;
const ID = /^[a-f0-9-]{36}$/;
const CODE = /\.(?:[cm]?[jt]s|[jt]sx|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp|vue|svelte)$/i;
const TEST = /(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const GRAPH =
	/(?:^|__)(get_codebase_map|get_module_context|get_blast_radius|get_unused_code|search_functions|pharaoh_recon)$/;
const sha = (value) => createHash("sha256").update(value).digest("hex");

/** Directory for private local review state; it is never a telemetry queue. */
export function changeReviewDirectory(root) {
	return join(root, "change-review");
}

function privateDirectory(directory) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const s = lstatSync(directory);
	if (!s.isDirectory() || s.isSymbolicLink() || s.mode & 0o077 || s.uid !== process.getuid?.())
		throw new Error("Change review requires a private local directory.");
}

/** Canonical relative path contained by a checkout, excluding Git and installed dependencies. */
export function reviewPath(root, name) {
	if (typeof name !== "string" || !name || isAbsolute(name) || /[\0\r\n]/.test(name))
		throw new Error("Expected a relative checkout path.");
	const normalized = name.split("\\").join("/");
	if (
		normalized
			.split("/")
			.some(
				(part) =>
					!part || part === "." || part === ".." || part === ".git" || part === "node_modules",
			)
	)
		throw new Error("Review path is outside the supported checkout.");
	const full = resolve(root, normalized);
	if (!full.startsWith(`${root}${sep}`)) throw new Error("Review path escapes checkout.");
	let parent = root;
	for (const part of normalized.split("/")) {
		parent = join(parent, part);
		const s = lstatSync(parent, { throwIfNoEntry: false });
		if (s?.isSymbolicLink()) {
			const target = realpathSync(parent);
			if (!target.startsWith(`${root}${sep}`) || !lstatSync(target).isFile())
				throw new Error("Source links must resolve to files inside the checkout.");
		}
	}
	return normalized;
}

function timeLeft(deadline) {
	if (performance.now() >= deadline) throw new Error("Review scan deadline expired.");
}

/** Raw bytes and file presence define identity; Git normalization and commits cannot hide edits. */
export function reviewManifest(root, deadline = Infinity) {
	timeLeft(deadline);
	root = realpathSync(root);
	const git = (...args) => gitRawBefore(root, MAX_DIFF, deadline, ...args).trim();
	if (realpathSync(git("rev-parse", "--show-toplevel")) !== root)
		throw new Error("Review needs the checkout root.");
	const head = git("rev-parse", "HEAD");
	const listed = gitRawBefore(root, MAX_DIFF, deadline, "ls-files", "-v", "-z")
		.split("\0")
		.filter(Boolean);
	if (listed.some((entry) => !entry.startsWith("H ")))
		throw new Error("Hidden index flags are unsupported.");
	const untracked = gitRawBefore(
		root,
		MAX_DIFF,
		deadline,
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	)
		.split("\0")
		.filter(Boolean);
	const files = [...new Set([...listed.map((entry) => entry.slice(2)), ...untracked])]
		.filter((name) => !name.split("/").includes("node_modules"))
		.sort();
	if (files.length > MAX_FILES) throw new Error("Checkout exceeds review file limit.");
	let bytes = 0;
	const links = {};
	const fileHashes = files.map((name) => {
		timeLeft(deadline);
		reviewPath(root, name);
		const path = join(root, name),
			stat = lstatSync(path, { throwIfNoEntry: false });
		if (!stat) return [name, null];
		const target = stat.isSymbolicLink() ? realpathSync(path) : path;
		const targetStat = lstatSync(target);
		if (stat.isSymbolicLink())
			links[name] = { target: readlinkSync(path), resolved: target.slice(root.length + 1) };
		bytes += targetStat.size;
		if (!targetStat.isFile() || bytes > MAX_INPUT)
			throw new Error("Review inputs are unsupported or too large.");
		const data = readFileSync(target);
		const hash = sha(
			Buffer.concat([
				Buffer.from(stat.isSymbolicLink() ? `link:${readlinkSync(path)}\0` : "file\0"),
				data,
			]),
		);
		timeLeft(deadline);
		return [name, hash];
	});
	const codeHashes = fileHashes.filter(([name]) => CODE.test(name) && !TEST.test(name));
	const config = fileHashes.filter(([name]) =>
		/(?:^|\/)(?:package\.json|(?:pnpm-lock|yarn\.lock|package-lock|bun\.lock).*|(?:vitest|vite|tsconfig)[^/]*\.(?:json|[cm]?[jt]s))$/.test(
			name,
		),
	);
	return {
		head,
		files,
		fileHashes,
		links,
		codeHashes,
		fingerprint: sha(JSON.stringify(fileHashes)),
		codeFingerprint: sha(JSON.stringify(codeHashes)),
		productionFingerprint: sha(JSON.stringify(fileHashes.filter(([name]) => !TEST.test(name)))),
		configFingerprint: sha(JSON.stringify(config)),
	};
}

function identity(input, options) {
	if (
		options.client !== "claude-code" ||
		typeof input.session_id !== "string" ||
		!input.session_id ||
		input.session_id.length > 256
	)
		return;
	timeLeft(options.deadline ?? Infinity);
	const root = realpathSync(options.target.root);
	if (
		realpathSync(input.cwd ?? root) !== root &&
		!realpathSync(input.cwd ?? root).startsWith(`${root}${sep}`)
	)
		return;
	if (!REPO.test(options.target.repo)) return;
	const key = sha(`${options.client}\0${input.session_id}\0${root}`);
	const turn = input.turn_id ?? input.prompt_id;
	if (turn !== undefined && (typeof turn !== "string" || turn.length > 256)) return;
	return { key, root, turn, repo: options.target.repo, installRoot: options.scope?.root ?? null };
}

function enabled(options) {
	const home = options.home ?? homedir();
	if (!changeReviewEnabled(home, options.scope)) return false;
	// Only a complete, current local hook installation may displace or act in place of Global.
	const local = { kind: "local", root: realpathSync(options.target.root) };
	if (options.scope?.kind === "local" && options.scope.root !== local.root) return false;
	const digest =
		changeReviewEnabled(home, local) && readActiveMemoryClients(home, local)[options.client];
	const localOwnsReview = Boolean(digest && localReviewHooksInstalled(home, local, digest));
	return options.scope?.kind === "local" ? localOwnsReview : !localOwnsReview;
}
function stateName(key) {
	return `turn-${key}.json`;
}
function runPath(directory, id) {
	if (!ID.test(id)) throw new Error("Invalid review identifier.");
	return join(directory, `run-${id}.json`);
}

function privateBytes(path, limit) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const s = fstatSync(fd);
		if (
			!s.isFile() ||
			s.nlink !== 1 ||
			s.mode & 0o077 ||
			s.uid !== process.getuid?.() ||
			s.size > limit
		)
			throw new Error("Invalid private review record.");
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Read an owned bounded review record. This file contains only local evidence and references. */
export function readReviewRun(directory, id) {
	privateDirectory(directory);
	const run = JSON.parse(privateBytes(runPath(directory, id), MAX_RUN));
	if (run.id !== id || run.version !== 1 || run.expires < Date.now())
		throw new Error("Review expired.");
	return run;
}

/** Persist a bounded review record without exposing source to any server. */
export function writeReviewRun(directory, run) {
	privateDirectory(directory);
	const data = JSON.stringify(run);
	if (Buffer.byteLength(data) > MAX_RUN) throw new Error("Review record exceeds limit.");
	atomicWrite(runPath(directory, run.id), data);
}

/** Lazily retire expired private snapshots outside the short native hook deadline. */
export function cleanupReviewRuns(directory, now = Date.now()) {
	privateDirectory(directory);
	let removed = 0;
	for (const name of readdirSync(directory)
		.filter((name) => /^run-[a-f0-9-]{36}\.json$/.test(name))
		.slice(0, 64)) {
		try {
			const path = join(directory, name);
			const info = lstatSync(path);
			if (
				!info.isFile() ||
				info.isSymbolicLink() ||
				info.nlink !== 1 ||
				info.mode & 0o077 ||
				info.uid !== process.getuid?.() ||
				info.size > MAX_RUN
			)
				continue;
			const run = JSON.parse(readFileSync(path, "utf8"));
			if (
				name !== `run-${run.id}.json` ||
				!ID.test(run.id) ||
				!Number.isFinite(run.expires) ||
				run.expires > now
			)
				continue;
			rmSync(join(directory, `files-${run.id}`), { recursive: true, force: true });
			rmSync(join(directory, `proof-${run.id}.json`), { force: true });
			rmSync(path);
			removed++;
		} catch {
			/* Unknown local files are not ours to remove. */
		}
	}
	return removed;
}

/** Begin an actual native user turn; clients without prompt IDs receive a local nonce. */
export function beginReviewTurn(input, options) {
	try {
		if (!enabled(options)) return;
		const who = identity(input, options);
		if (!who) return;
		const manifest = reviewManifest(who.root, options.deadline);
		const now = options.now ?? Date.now();
		return updateLocalState(
			options.directory,
			stateName(who.key),
			(previous) => {
				if (who.turn && previous?.nativeTurn === who.turn && previous.expires > now)
					return { state: previous, context: previous.turn };
				const turn = randomUUID();
				return {
					state: {
						version: 1,
						key: who.key,
						root: who.root,
						repo: options.target.repo,
						nativeTurn: who.turn,
						installRoot: who.installRoot,
						turn,
						baseline: manifest.codeFingerprint,
						expires: now + TTL,
						attempted: false,
					},
					context: turn,
				};
			},
			now,
		);
	} catch {
		/* Optional review never prevents the original task. */
	}
}

function matches(state, who, now) {
	return (
		state?.version === 1 &&
		state.root === who.root &&
		state.repo === who.repo &&
		state.key === who.key &&
		(!Object.hasOwn(state, "installRoot") || state.installRoot === who.installRoot) &&
		state.expires > now &&
		(!who.turn || state.nativeTurn === who.turn)
	);
}

/** Add the locally generated prompt identity to legacy capture only; review receives the original event. */
export function reviewTurnInput(input, options) {
	if (input.turn_id || input.prompt_id) return input;
	try {
		if (!enabled(options)) return input;
		const who = identity(input, options);
		if (!who) return input;
		const now = options.now ?? Date.now();
		return (
			updateLocalState(
				options.directory,
				stateName(who.key),
				(state) => {
					if (!matches(state, who, now)) return;
					return { state, context: { ...input, prompt_id: state.turn } };
				},
				now,
			) ?? input
		);
	} catch {
		return input;
	}
}

/** Request exactly one short review after saved source changed in this user turn. */
export function reviewStop(input, options) {
	try {
		if (!enabled(options) || input.stop_hook_active === true) return;
		const who = identity(input, options);
		if (!who) return;
		const now = options.now ?? Date.now();
		return updateLocalState(
			options.directory,
			stateName(who.key),
			(state) => {
				if (!matches(state, who, now) || state.attempted) return;
				const manifest = reviewManifest(who.root, options.deadline);
				if (manifest.codeFingerprint === state.baseline) return;
				const id = randomUUID();
				const run = {
					version: 1,
					id,
					key: who.key,
					turn: state.turn,
					root: who.root,
					repo: state.repo,
					home: options.home ?? homedir(),
					scope: options.scope,
					expires: state.expires,
					candidate: manifest,
					phase: "reserved",
				};
				writeReviewRun(options.directory, run);
				const proof =
					options.proofPath ??
					join(dirname(fileURLToPath(import.meta.url)), "change-review-proof.mjs");
				const command = `${shellWord(process.execPath)} ${shellWord(proof)}`;
				const args = `${shellWord(id)} --directory ${shellWord(options.directory)}`;
				const reason = [
					"Pharaoh change review (one pass, then finish): check the change you were about to deliver for one concrete missed behavior, not a broad refactor.",
					`First freeze this exact pre-review candidate: ${command} snapshot ${args}. If it cannot snapshot, finish without claiming a catch.`,
					`Then use one relevant tool on the configured Pharaoh server with the exact full repo argument "${state.repo}" (do not shorten it) and validate its relationship against current source. Choose a behavior introduced or changed by this draft and a pre-existing behavior it must interact with. Compare the actual assertions in existing tests, identify one combination they do not cover, and run one focused behavioral probe using the documented or dependency contract as its oracle. Prefer interactions in the changed behavior (such as precedence, state transitions or failure recovery), not already-covered or unchanged plumbing. Test counts and inspection alone do not prove coverage.`,
					"If the probe passes and no grounded defect remains, finish normally. Remove useless temporary diagnostics; do not invent requirements or keep searching beyond this one review pass.",
					"If a defect exists, add one behavioral regression test before repairing production code. It must describe an existing requirement, not invent a new feature. Keep the finding to one short user-visible wrong outcome; leave function names and causes in the test and proof.",
					`Prove it on the saved candidate: ${command} before ${args} --test RELATIVE_TEST_FILE --name 'EXACT FULL TEST NAME' --finding 'USER-VISIBLE WRONG OUTCOME' --repair PRODUCTION_SOURCE_FILE [--fixture RELATIVE_FIXTURE] [--regression EXISTING_TEST_FILE]. Declare the one to three source files you will repair now; every other file will be frozen. A new test file needs an existing relevant regression file.`,
					`Only after that command reports reproduced, repair the defect and run ${command} after ${args}. If proof is inconclusive, do not claim Pharaoh caught a mistake. Do not mutate code merely to make a failure.`,
					"Keep changes within the user's task. The verifier uses local disposable copies, runs installed Vitest under your normal command permissions, and never uploads code. Do not rerun this review or block completion again.",
				].join("\n");
				return {
					state: { ...state, attempted: true, reviewId: id },
					context: { decision: "block", reason },
				};
			},
			now,
		);
	} catch {
		/* Missing, large or changing checkouts simply receive no automatic claim. */
	}
}

function resultText(result) {
	if (typeof result === "string") return result;
	if (Array.isArray(result))
		return result
			.filter((c) => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("\n")
			.slice(0, 65_536);
	if (!result || typeof result !== "object") return "";
	if (Array.isArray(result.content))
		return result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	return typeof result.output === "string" ? result.output : "";
}

function structuredRefusal(value, depth = 0) {
	if (depth > 8) return true;
	if (!value || typeof value !== "object") return false;
	if (value.isError === true || value.success === false || value.ok === false || value.error)
		return true;
	if (
		/^(?:error|failed|denied|unauthorized|forbidden|upgrade_required|trial_expired|access_denied)$/i.test(
			value.status ?? value.code ?? "",
		)
	)
		return true;
	if (value.type === "text" && typeof value.text === "string" && /^\s*[[{]/.test(value.text)) {
		try {
			if (structuredRefusal(JSON.parse(value.text), depth + 1)) return true;
		} catch {
			/* Ordinary graph prose is not JSON. */
		}
	}
	return Object.values(value).some(
		(item) => item && typeof item === "object" && structuredRefusal(item, depth + 1),
	);
}

/** Observe actual native successful graph completion after the candidate was frozen. */
export function observeReviewTool(input, options) {
	try {
		if (
			!enabled(options) ||
			input.hook_event_name !== "PostToolUse" ||
			!/^mcp__pharaoh__/.test(input.tool_name ?? "") ||
			!GRAPH.test(input.tool_name ?? "")
		)
			return;
		const who = identity(input, options);
		if (!who) return;
		const now = options.now ?? Date.now();
		updateLocalState(
			options.directory,
			stateName(who.key),
			(state) => {
				if (!matches(state, who, now) || !state.reviewId) return;
				const run = readReviewRun(options.directory, state.reviewId);
				if (run.phase !== "snapshotted") return;
				const repo = input.tool_input?.repo;
				if (typeof repo !== "string" || repo.toLowerCase() !== run.repo.toLowerCase()) return;
				const server =
					typeof input.mcp_server === "string" ? input.mcp_server : input.mcp_server?.name;
				if (server !== undefined && server !== "pharaoh") return;
				const result = input.tool_response;
				const text = stripVTControlCharacters(resultText(result));
				// A recon can contain useful sections alongside an empty search. Only the
				// search tool's own no-result answer makes that lookup uninformative.
				const emptySearch =
					/(?:^|__)search_functions$/.test(input.tool_name) &&
					/^\s*no (?:functions matching|matching functions)\b/i.test(text);
				// A valid structural answer may have a separate setup or upgrade footer.
				// Classify refusal prose only when no graph-result heading was returned.
				const structuralAnswer =
					/^#{1,3}\s+(?:Blast Radius|Recon|Module|Search Results|Unused code|Reachability|.*Codebase Map)\b|^- (?:function|async function|const|class)\b/im.test(
						text,
					);
				if (!text || structuredRefusal(result) || input.error || emptySearch || !structuralAnswer)
					return;
				run.graph = {
					tool: input.tool_name,
					hash: sha(text),
					observedAt: now,
					scope: /Scope:\s*local saved worktree/i.test(text)
						? "local-saved-worktree"
						: "hosted-default-branch",
					indexedCommit: text.match(/Indexed commit:\s*([a-f0-9]{40})/i)?.[1] ?? null,
					refreshedAt: text.match(/Last refreshed:\s*([^\n]+)/i)?.[1]?.trim() ?? null,
					target: JSON.stringify(input.tool_input).slice(0, 2000),
				};
				writeReviewRun(options.directory, run);
			},
			now,
		);
	} catch {
		/* Unobserved graph results cannot earn a receipt. */
	}
}

/** Read the preceding classic nonce before the native prompt enters the session. */
export function completionBoundary(input, options) {
	try {
		if (!enabled(options)) return;
		const who = identity(input, options);
		if (!who) return;
		privateDirectory(options.directory);
		try {
			const previous = JSON.parse(privateBytes(join(options.directory, stateName(who.key)), 8192));
			if (previous.key === who.key && ID.test(previous.turn))
				return { previousReviewTurn: previous.turn };
		} catch (error) {
			if (error.code === "ENOENT") return { previousReviewTurn: null };
		}
	} catch {
		/* Unreadable prior state cannot authenticate a new prompt. */
	}
}

/** Pair native turn.start with the new classic nonce created after prompt.submit. */
export function bindCompletionTurn(input, options) {
	try {
		const prior = input.previous_review_turn;
		const native = input.completion_turn_id;
		if (!enabled(options) || !ID.test(native) || !(prior === null || ID.test(prior))) return;
		const who = identity(input, options);
		if (!who) return;
		const now = options.now ?? Date.now();
		return updateLocalState(
			options.directory,
			stateName(who.key),
			(state) => {
				if (
					!matches(state, who, now) ||
					state.installRoot !== who.installRoot ||
					state.turn === prior ||
					state.attempted ||
					(state.completionTurn && state.completionTurn !== native)
				)
					return;
				return { state: { ...state, completionTurn: native }, context: { reviewTurn: state.turn } };
			},
			now,
		);
	} catch {
		/* Ambiguous or stale native observations earn no receipt. */
	}
}

function claimVerifiedReview(input, options, display) {
	try {
		if (!enabled(options)) return;
		const who = identity(input, options);
		if (!who) return;
		const now = options.now ?? Date.now();
		return updateLocalState(
			options.directory,
			stateName(who.key),
			(state) => {
				if (!matches(state, who, now) || !state.reviewId) return;
				if (display) {
					if (
						state.delivered ||
						state.installRoot !== who.installRoot ||
						!ID.test(input.completion_turn_id) ||
						state.completionTurn !== input.completion_turn_id ||
						state.turn !== input.review_turn
					)
						return;
				} else if (state.captureCheckTaken || state.delivered) return;
				const run = readReviewRun(options.directory, state.reviewId);
				if (
					run.turn !== state.turn ||
					run.key !== who.key ||
					run.root !== who.root ||
					run.repo !== who.repo ||
					(run.scope?.root ?? null) !== who.installRoot
				)
					return;
				if (run.phase !== "verified" || !run.receipt) {
					if (!display && input.stop_hook_active === true) {
						run.phase = "unproven";
						writeReviewRun(options.directory, run);
					}
					return;
				}
				if (!display && options.captureEnabled === false) return;
				if (reviewManifest(who.root, options.deadline).fingerprint !== run.receipt.finalFingerprint)
					return;
				const proof = join(realpathSync(options.directory), `proof-${run.id}.json`);
				// Old private records can still supply their existing capture check. Visible delivery
				// requires the verified artifact written by this version to remain byte-identical.
				if (
					(display || run.receipt.proofHash) &&
					(run.receipt.path !== proof ||
						sha(privateBytes(proof, MAX_RUN)) !== run.receipt.proofHash)
				)
					return;
				if (display) {
					const message = `Pharaoh caught: ${run.finding.replace(/[.!?]+$/, "")}. Test failed before the fix; passed after. Proof: ${proof}`;
					return { state: { ...state, delivered: true }, context: { message } };
				}
				if (!run.receipt.command) return;
				return {
					state: { ...state, captureCheckTaken: true },
					context: {
						paths: run.receipt.repairedPaths,
						check: run.receipt.command,
						evidence: "the same behavioral test failed before repair and passed afterward",
					},
				};
			},
			now,
		);
	} catch {
		/* A stale or absent proof is never displayed as a success. */
	}
}

/** Offer verifier evidence to optional capture once; leave visible delivery to native completion. */
export function takeReviewCaptureCheck(input, options) {
	return claimVerifiedReview(input, options, false);
}

/** Only the owning, explicitly bound foreground turn can consume its still-valid receipt. */
export function consumeReviewReceipt(input, options) {
	return claimVerifiedReview(input, options, true);
}
