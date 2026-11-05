import { git, visibleGitIndex } from "./local.mjs";
import { PilotError, requestMemory } from "./memory-api.mjs";
import { projectMemorySession } from "./user-target.mjs";

const SHA = /^[a-f0-9]{40}$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TERMS = /^[\p{L}\p{N}._+@ $/#:-]+$/u;
const SECRET =
	/\b(?:[a-f0-9]{32,}|ph(?:at|rt)_[a-z0-9_-]{12,})\b|:\/\/|\b[\w.-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
// Apply the hosted recap safety rules before any agent-written text hits disk.
const UNSAFE_RECAP = [
	/(?:phat|phrt|pss|dev)_[a-f\d]{64}/i,
	/\x60{3}|~~~|-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
	/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/i,
	/\bBearer[ \t]+[A-Za-z0-9_.~+/=-]{12,}|\b(?:password|secret|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S{6,}/i,
	/^\s*(?:assistant|user|system|tool)\s*:/im,
	/^\s*(?:import\s.+\sfrom\s+["']|(?:const|let|var)\s+\w+\s*=|(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|def\s+\w+\s*\()/m,
	/\p{Bidi_Control}/u,
];
const REF_PATH = /^[\p{L}\p{N}._+@ -]+(?:\/[\p{L}\p{N}._+@ -]+)*$/u;

function safeRecap(text) {
	return (
		![...text].some((char) => {
			const code = char.charCodeAt(0);
			return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
		}) && !UNSAFE_RECAP.some((pattern) => pattern.test(text))
	);
}

function hasKeys(input, allowed) {
	return (
		input &&
		typeof input === "object" &&
		!Array.isArray(input) &&
		Object.keys(input).every((key) => allowed.includes(key))
	);
}

function normalizeTerm(value) {
	if (typeof value !== "string" || value.length > 100 || /[\r\n]/.test(value)) return;
	const term = value.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[ \t]+/g, " ");
	if (
		term &&
		term.split(" ").length <= 8 &&
		TERMS.test(term) &&
		!SECRET.test(term) &&
		safeRecap(term)
	) {
		return term;
	}
}

function recallTerms(input) {
	if (
		hasKeys(input, ["terms"]) &&
		Array.isArray(input.terms) &&
		input.terms.length >= 1 &&
		input.terms.length <= 5
	) {
		const terms = input.terms.map(normalizeTerm);
		if (terms.every(Boolean)) return [...new Set(terms)];
	}
	throw new PilotError(
		"Use JSON with 1–5 short, non-sensitive keywords, phrases, paths, or symbols in terms.",
	);
}

function validRef(ref) {
	return (
		hasKeys(ref, ["path", "symbol", "pullRequest", "commit"]) &&
		Object.keys(ref).length > 0 &&
		(ref.path === undefined ||
			(typeof ref.path === "string" &&
				ref.path.length <= 180 &&
				REF_PATH.test(ref.path) &&
				!ref.path.split("/").some((part) => part === "." || part === "..") &&
				safeRecap(ref.path))) &&
		(ref.symbol === undefined ||
			(typeof ref.symbol === "string" &&
				ref.symbol.length <= 100 &&
				/^[\w$][\w$.#:-]*$/u.test(ref.symbol) &&
				safeRecap(ref.symbol))) &&
		(ref.pullRequest === undefined ||
			(Number.isInteger(ref.pullRequest) &&
				ref.pullRequest > 0 &&
				ref.pullRequest <= 1_000_000_000)) &&
		(ref.commit === undefined || (typeof ref.commit === "string" && SHA.test(ref.commit)))
	);
}

function validRecap(text, limit) {
	return (
		typeof text === "string" && text.trim().length > 0 && text.length <= limit && safeRecap(text)
	);
}

function captureDraft(input) {
	if (
		!hasKeys(input, ["kind", "summary", "detail", "refs", "verification"]) ||
		!["observation", "lesson", "decision"].includes(input.kind) ||
		!validRecap(input.summary, 500) ||
		(input.detail !== undefined && !validRecap(input.detail, 1000)) ||
		(input.verification !== undefined && !validRecap(input.verification, 300)) ||
		(input.refs !== undefined &&
			(!Array.isArray(input.refs) || input.refs.length > 6 || !input.refs.every(validRef)))
	) {
		throw new PilotError(
			"Use a JSON candidate with kind, summary (500 characters), optional detail (1,000), verification (300), and up to six refs.",
		);
	}
	return input;
}

function worktreeEvidence(root, rev) {
	try {
		if (git(root, "status", "--porcelain=v1", "--untracked-files=normal")) return true;
		return !git(
			root,
			"for-each-ref",
			`--contains=${rev}`,
			"--count=1",
			"--format=%(objectname)",
			"refs/remotes/origin/",
		);
	} catch {
		return true;
	}
}

function pathAtRevision(root, rev, path) {
	try {
		git(root, "cat-file", "-e", `${rev}:${path}`);
		return true;
	} catch {
		return false;
	}
}

async function citeRefs(root, rev, refs) {
	const unverified = worktreeEvidence(root, rev);
	const needsFullIndex = refs.some((ref) => !ref.commit && !ref.path && ref.symbol);
	const fullIndex = !unverified && needsFullIndex && visibleGitIndex(root);
	return Promise.all(
		refs.map(async (ref) => {
			if (ref.commit || !(ref.path || ref.symbol)) return ref;
			const visible =
				!unverified && (await (ref.path ? visibleGitIndex(root, ref.path) : fullIndex));
			if (!visible || (ref.path && !pathAtRevision(root, rev, ref.path)))
				return { ...ref, provenance: "worktree" };
			return ref;
		}),
	);
}

function validPair(id, version) {
	return (
		typeof id === "string" &&
		UUID.test(id) &&
		Number.isInteger(version) &&
		version > 0 &&
		version <= 1_000_000
	);
}

export async function executeTurn(
	operation,
	token,
	{ target, store, read, request = requestMemory, compact = true, loadCaptureCredentials },
) {
	const change = (from, to) => {
		const state = store.transition(token, target, from, to);
		if (!state) throw new PilotError("This project memory turn is stale or not eligible.");
		return state;
	};
	if (operation === "receipt") {
		const receipt = store.readReceipt(token, target);
		if (!receipt)
			throw new PilotError(
				"No confirmed capture receipt is available for this turn. Check Project Memory before retrying.",
			);
		return receipt;
	}
	let input;
	try {
		input = await read();
	} catch {
		throw new PilotError("Provide a bounded JSON object on standard input.");
	}
	if (operation === "expand") {
		if (!hasKeys(input, ["id", "version"]) || !validPair(input.id, input.version))
			throw new PilotError("Provide the exact record ID and version from the compact packet.");
		const expanding = store.beginExpand(token, target, input.id, input.version);
		if (!expanding)
			throw new PilotError(
				"This record version is outside the active packet, the turn is stale, or its two expansions are used.",
			);
		let result;
		try {
			result = await request(operation, {
				repo: expanding.repo,
				id: input.id,
				version: input.version,
			});
		} catch (error) {
			store.finishExpand(token, target, expanding.attempt);
			throw error;
		}
		if (!store.finishExpand(token, target, expanding.attempt))
			throw new PilotError("This project memory turn ended before its expansion returned.");
		return result;
	}
	const capture = operation === "capture";
	if (!capture && operation !== "recall") throw new PilotError("Unknown project memory operation.");
	const draft = capture ? captureDraft(input) : { terms: recallTerms(input) };
	if (JSON.stringify(draft).includes(token))
		throw new PilotError("The local turn token cannot appear in a memory request.");
	if (capture) {
		const gitRev = git(target.root, "rev-parse", "HEAD");
		if (!SHA.test(gitRev)) throw new PilotError("The checkout has no full Git commit to cite.");
		const refs = draft.refs ? await citeRefs(target.root, gitRev, draft.refs) : undefined;
		const credentials = await loadCaptureCredentials?.();
		const session = projectMemorySession(credentials);
		if (!session || !(Date.parse(credentials.expires_at) > Date.now()))
			throw new PilotError("Reconnect to Pharaoh to save project memory.");
		const dispatched = store.startCapture(token, target, session, (identity) =>
			request("capture", { ...draft, gitRev, refs, ...identity }, { credentials }),
		);
		if (!dispatched)
			throw new PilotError("This turn is stale, read-only, or has already attempted a capture.");
		let record;
		try {
			({ record } = await dispatched);
		} catch (error) {
			if (error instanceof PilotError && error.rejected)
				store.saveReceipt(token, target, "rejected");
			throw error;
		}
		try {
			store.saveReceipt(token, target, "confirmed", record);
		} catch {
			throw new PilotError("Pharaoh saved the candidate. Check Project Memory for the record.");
		}
		return;
	}
	const state = change(["pending"], "recalling");
	const payload = {
		repo: state.repo,
		...draft,
		...(compact && { format: "compact-v1" }),
	};
	let result;
	try {
		result = await request(operation, payload);
	} catch (error) {
		store.transition(token, target, ["recalling"], "failed");
		throw error;
	}
	const pairs =
		result?.format === "compact-v1" ? result.records.map(({ id, version }) => [id, version]) : [];
	if (
		pairs.length > 5 ||
		!pairs.every(([id, version]) => validPair(id, version)) ||
		!store.finishRecall(token, target, pairs)
	) {
		throw new PilotError("This project memory turn ended before recall returned.");
	}
	return result;
}
