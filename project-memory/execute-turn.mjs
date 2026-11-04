import { git, visibleGitIndex } from "./local.mjs";
import { PilotError, requestMemory } from "./memory-api.mjs";

const SHA = /^[a-f0-9]{40}$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TERMS = /^[\p{L}\p{N}._+@ $/#:-]+$/u;
const SECRET =
	/\b(?:[a-f0-9]{32,}|ph(?:at|rt)_[a-z0-9_-]{12,})\b|:\/\/|\b[\w.-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
const UNSAFE_RECAP =
	/\x60{3}|~~~|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:(?:phat|phrt|pss|dev)_[a-f0-9]{64}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b|\bBearer[ \t]+[A-Za-z0-9_.~+/=-]{12,}|\b(?:password|secret|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S{6,}|(?:^|\n)\s*(?:assistant|user|system|tool)\s*:/i;
const REF_PATH = /^[\p{L}\p{N}._+@ -]+(?:\/[\p{L}\p{N}._+@ -]+)*$/u;

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
		!UNSAFE_RECAP.test(term)
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
				!UNSAFE_RECAP.test(ref.path))) &&
		(ref.symbol === undefined ||
			(typeof ref.symbol === "string" &&
				ref.symbol.length <= 100 &&
				/^[\w$][\w$.#:-]*$/u.test(ref.symbol) &&
				!UNSAFE_RECAP.test(ref.symbol))) &&
		(ref.pullRequest === undefined || (Number.isInteger(ref.pullRequest) && ref.pullRequest > 0)) &&
		(ref.commit === undefined || (typeof ref.commit === "string" && SHA.test(ref.commit)))
	);
}

function validRecap(text, limit) {
	return (
		typeof text === "string" &&
		text.trim().length > 0 &&
		text.length <= limit &&
		!UNSAFE_RECAP.test(text)
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
			"Use a bounded JSON candidate with kind, summary, and optional detail, refs, and verification.",
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
	{ target, store, read, request = requestMemory, compact = false },
) {
	const change = (from, to) => {
		const state = store.transition(token, target, from, to);
		if (!state) throw new PilotError("This project memory turn is stale or not eligible.");
		return state;
	};
	if (operation === "nothing-material") {
		change(["nudged"], "acknowledged");
		return { acknowledged: true };
	}
	if (operation === "receipt") {
		const receipt = store.readReceipt(token, target);
		if (!receipt) throw new PilotError("No confirmed capture receipt is available for this turn.");
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
	const recall = operation === "recall";
	const draft = recall ? { terms: recallTerms(input) } : captureDraft(input);
	if (JSON.stringify(draft).includes(token))
		throw new PilotError("The local turn token cannot appear in a memory request.");
	const gitRev = recall ? null : git(target.root, "rev-parse", "HEAD");
	if (!recall && !SHA.test(gitRev))
		throw new PilotError("The checkout has no full Git commit to cite.");
	const refs = !recall && draft.refs ? await citeRefs(target.root, gitRev, draft.refs) : undefined;
	const running = recall ? "recalling" : "capturing";
	const state = change([recall ? "pending" : "nudged"], running);
	const payload = {
		repo: state.repo,
		...draft,
		...(recall && compact && { format: "compact-v1" }),
		...(!recall && { gitRev, client: state.client, operationId: state.operationId }),
		...(refs && { refs }),
	};
	let result;
	try {
		result = await request(operation, payload);
	} catch (error) {
		store.transition(token, target, [running], "failed");
		throw error;
	}
	if (recall) {
		const pairs =
			result?.format === "compact-v1" ? result.records.map(({ id, version }) => [id, version]) : [];
		if (
			pairs.length > 5 ||
			!pairs.every(([id, version]) => validPair(id, version)) ||
			!store.finishRecall(token, target, pairs)
		) {
			throw new PilotError("This project memory turn ended before recall returned.");
		}
	} else {
		try {
			store.saveReceipt(token, target, result.record);
			store.transition(token, target, [running], "acknowledged");
		} catch {
			// The service already committed. Local disk or a stale turn cannot turn a confirmed record into a failed write.
			return { ...result, localReceiptUnavailable: true };
		}
	}
	return result;
}
