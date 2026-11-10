import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, gitBefore, sessionKey, updateWorktreeCueState } from "./local.mjs";

const MAP_TOOL = "mcp__pharaoh__get_codebase_map";
const SHA = /^(?!0{40}$)[a-f0-9]{40}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const MAPPED_FILE = /\.(?:[cm]?[jt]s|[jt]sx|py)$/i;
const STATE_TTL = 12 * 60 * 60 * 1000;
const MAX_SCOPES = 8;
const MAX_SEARCHES = 2;
const MAX_WARNED = 8;
const MAX_EDIT_PATHS = 20;
const MAX_SOURCE_BYTES = 512 * 1024;

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function responseText(value) {
	if (typeof value === "string") {
		if (/^\s*[[{]/.test(value)) {
			try {
				return responseText(JSON.parse(value));
			} catch {
				return [];
			}
		}
		return [value];
	}
	if (value?.isError || value?.is_error) return [];
	const content = Array.isArray(value) ? value : value?.content;
	return Array.isArray(content)
		? content.flatMap((block) =>
				block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
			)
		: [];
}

function mappedRevision(input, target) {
	const requested = input.tool_input?.repo;
	if (typeof requested !== "string") return;
	const full = target.repo.toLowerCase();
	const short = full.split("/")[1];
	const fullRequest = requested.toLowerCase() === full;
	if (!fullRequest && requested.toLowerCase() !== short) return;
	const maps = responseText(input.tool_response).flatMap((text) => {
		const headers = [...text.matchAll(/^# (.+) Codebase Map\r?$/gim)];
		return headers.length ? [{ text, headers }] : [];
	});
	if (maps.length !== 1 || maps[0].headers.length !== 1) return;
	const header = maps[0].headers[0][1].toLowerCase();
	// Credential repo hints can omit organizations. Only canonical output proves
	// which repo a short request resolved to; full requests keep legacy support.
	if (header !== full && !(fullRequest && header === short)) return;
	const revisions = [...maps[0].text.matchAll(/^Indexed commit: ([^\r\n]+)\r?$/gm)];
	const revision = revisions.length === 1 && revisions[0][1];
	if (revision && SHA.test(revision)) return revision.toLowerCase();
}

/** Extract candidate native edit paths without executing commands or reading files. */
export function nativeEditPaths(input, client, successful = true) {
	if (client === "codex") {
		if (input.tool_name !== "apply_patch") return [];
		const patch = input.tool_input?.command;
		if (typeof patch !== "string" || !patch.startsWith("*** Begin Patch\n")) return [];
		if (
			successful &&
			!responseText(input.tool_response).some((text) =>
				/^Success\. Updated the following files:/m.test(text),
			)
		)
			return [];
		const paths = [
			...patch.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm),
		];
		return paths.length <= MAX_EDIT_PATHS
			? paths.map(([, operation, path]) => ({ path, mayAdd: operation === "Add File" }))
			: [];
	}
	if (!["Edit", "Write", "MultiEdit"].includes(input.tool_name)) return [];
	const response = input.tool_response;
	if (successful && (response?.isError || response?.is_error || response?.success === false))
		return [];
	return [{ path: input.tool_input?.file_path, mayAdd: input.tool_name === "Write" }];
}

function editedPaths(input, client, root, anyFile = false) {
	const inCheckout = nativeEditPaths(input, client).flatMap(({ path }) => {
		if (typeof path !== "string" || path.length > 512 || !(anyFile || MAPPED_FILE.test(path)))
			return [];
		const absolute = resolve(input.cwd ?? root, path);
		let parent;
		try {
			parent = realpathSync(dirname(absolute));
		} catch {
			return [];
		}
		const local = relative(root, join(parent, basename(absolute)));
		if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return [];
		return [local];
	});
	return [...new Set(inCheckout)];
}

function worktreeBlob(path, remaining) {
	let fd;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		return error.code === "ENOENT" ? null : undefined;
	}
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > remaining) return;
		const bytes = Buffer.alloc(before.size);
		if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return;
		const after = fstatSync(fd);
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return;
		return {
			size: bytes.length,
			oid: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
		};
	} finally {
		closeSync(fd);
	}
}

function changedPaths(root, revision, paths, deadline, git) {
	const comparisonDeadline = Math.min(deadline, performance.now() + 700);
	const run = (...args) =>
		git(
			root,
			Math.min(comparisonDeadline, performance.now() + 300),
			"--literal-pathspecs",
			...args,
		);
	try {
		// Git reads tree and index metadata only. Hash raw regular-file bytes
		// locally so checkout attributes cannot invoke an executable filter.
		const tree = run("ls-tree", "-rz", revision, "--", ...paths);
		const indexed = new Map(
			tree
				.split("\0")
				.filter(Boolean)
				.map((entry) => {
					const tab = entry.indexOf("\t");
					const [mode, type, oid] = entry.slice(0, tab).split(" ");
					return [
						entry.slice(tab + 1),
						/^100(?:644|755)$/.test(mode) && type === "blob" && SHA.test(oid) ? oid : null,
					];
				}),
		);
		const added = paths.filter((path) => !indexed.has(path));
		const visible = added.length
			? new Set(
					run("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...added).split(
						"\0",
					),
				)
			: new Set();
		let remaining = MAX_SOURCE_BYTES;
		const changed = [];
		for (const path of paths) {
			if (performance.now() >= comparisonDeadline) return [];
			const previous = indexed.get(path);
			if (!previous && !visible.has(path)) continue;
			const local = worktreeBlob(join(root, path), remaining);
			if (local === undefined) continue;
			remaining -= local?.size ?? 0;
			if ((local?.oid ?? undefined) !== previous) changed.push(digest(path));
		}
		if (performance.now() >= comparisonDeadline) return [];
		return changed;
	} catch {
		// A missing revision or failed comparison leaves the cue available for a later edit.
		return [];
	}
}

function validEntry(entry, now) {
	return (
		DIGEST.test(entry?.key ?? "") &&
		Number.isFinite(entry.expires) &&
		entry.expires > now &&
		entry.expires <= now + STATE_TTL &&
		(entry.revision === undefined || SHA.test(entry.revision)) &&
		Array.isArray(entry.searches) &&
		entry.searches.length <= MAX_SEARCHES &&
		entry.searches.every((item) => typeof item === "string" && DIGEST.test(item)) &&
		Array.isArray(entry.warned) &&
		entry.warned.length <= MAX_WARNED &&
		entry.warned.every((item) => typeof item === "string" && DIGEST.test(item))
	);
}

/** Process local hook evidence without dispatching tools or retaining their payloads. */
export function worktreeCue(
	input,
	{
		client,
		target,
		binding,
		stateDirectory,
		structuralSearch,
		deadline = Infinity,
		git = gitBefore,
		now = Date.now(),
	},
) {
	const session = sessionKey(client, input.session_id);
	if (!session || !binding || performance.now() >= deadline) return;
	const event = input.hook_event_name;
	const search = event === "PreToolUse" && structuralSearch;
	const revision =
		event === "PostToolUse" && input.tool_name === MAP_TOOL && mappedRevision(input, target);
	const paths = event === "PostToolUse" ? editedPaths(input, client, target.root) : [];
	if (!search && !revision && !paths.length) return;
	const key = digest(`${binding}\0${session}\0${target.root}\0${target.repo.toLowerCase()}`);

	const context = updateWorktreeCueState(
		stateDirectory,
		(state) => {
			if (state !== undefined && (state?.version !== 1 || !Array.isArray(state.entries))) return;
			const entries = (state?.entries ?? [])
				.filter((entry) => validEntry(entry, now))
				.slice(0, MAX_SCOPES);
			const existing = entries.find((entry) => entry.key === key);
			const current = existing ? { ...existing } : { key, searches: [], warned: [] };
			let notice;
			if (revision) {
				if (current.revision === revision) return;
				current.revision = revision;
				current.warned = [];
			} else if (search) {
				if (current.revision || current.searches.length >= MAX_SEARCHES) return;
				const head = git(
					target.root,
					Math.min(deadline, performance.now() + 300),
					"rev-parse",
					"HEAD",
				);
				if (!SHA.test(head)) return;
				const requested = digest(`${head}\0${search.tool}\0${search.symbol}`);
				if (current.searches.includes(requested)) return;
				current.searches = [...current.searches, requested];
				notice = `For structural evidence on ${search.symbol}, try Pharaoh's ${search.tool}. The graph covers the indexed default branch. Use the current worktree for local changes.`;
			} else {
				if (!current.revision || current.warned.length >= MAX_WARNED) return;
				const changed = changedPaths(target.root, current.revision, paths, deadline, git);
				const unseen = changed.filter((path) => !current.warned.includes(path));
				if (!unseen.length) return;
				current.warned = [...current.warned, ...unseen].slice(0, MAX_WARNED);
				notice = `The Pharaoh evidence consulted earlier reflects the indexed default branch at ${current.revision.slice(0, 12)}. This edited scope differs from that revision. Check the local diff or source before relying on that evidence.`;
			}
			if (performance.now() >= deadline) return;
			current.expires = now + STATE_TTL;
			return {
				state: {
					version: 1,
					entries: [current, ...entries.filter((entry) => entry.key !== key)].slice(0, MAX_SCOPES),
				},
				context: notice,
			};
		},
		now,
	);
	if (context) return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

/** How long a fetched list of anchored records may be shown. Access is rechecked at each fetch. */
const MEMORY_TTL = 5 * 60 * 1000;
/** One kept list per repo, so work in a second repo never evicts the first's list or shown history. */
const memoryCache = (directory, repo) =>
	join(directory, `anchored-memory-${digest(repo.toLowerCase())}.json`);
const MAX_MEMORY_BYTES = 40_000;
const MAX_MEMORY_CUES = 2;
/** About 300 tokens. */
const MEMORY_CUE_CHARS = 1_100;
const MAX_SHOWN_SESSIONS = 8;
const MAX_SHOWN_RECORDS = 32;

function anchoredMemory(directory, repo, binding, now) {
	try {
		const path = memoryCache(directory, repo);
		const file = lstatSync(path);
		if (
			!file.isFile() ||
			file.mode & 0o077 ||
			file.uid !== process.getuid?.() ||
			file.size > MAX_MEMORY_BYTES
		)
			return;
		const cache = JSON.parse(readFileSync(path, "utf8"));
		if (
			cache?.version === 1 &&
			cache.repo === repo.toLowerCase() &&
			cache.binding === binding &&
			Array.isArray(cache.records) &&
			cache.shown &&
			typeof cache.shown === "object"
		)
			return { ...cache, fresh: cache.fetchedAt <= now && now - cache.fetchedAt < MEMORY_TTL };
	} catch {
		// No private cache for this repo and sign-in.
	}
}

function writeAnchoredMemory(directory, repo, binding, records, shown, now) {
	atomicWrite(
		memoryCache(directory, repo),
		JSON.stringify({
			version: 1,
			repo: repo.toLowerCase(),
			binding,
			fetchedAt: now,
			records,
			shown,
		}),
	);
}

/**
 * Fetch the records that cite a file and keep them, owner-private, for five
 * minutes. The request names the repo only. A refusal or failure leaves an
 * empty list, so a repo without memory access is not asked again until it expires.
 */
export async function refreshAnchoredMemory(
	repo,
	{ directory, binding, request, now = Date.now() },
) {
	let records = [];
	try {
		({ records } = await request("anchored", { repo }));
	} catch {
		// Keep the empty list.
	}
	const shown = anchoredMemory(directory, repo, binding, now)?.shown ?? {};
	writeAnchoredMemory(directory, repo, binding, records, shown, now);
}

/**
 * Start a background fetch when the kept list is missing or older than five
 * minutes. The hook never waits for it: a stale list is deleted and shows nothing.
 */
export function primeAnchoredMemory(
	repo,
	{
		binding,
		stateDirectory,
		now = Date.now(),
		launch = (target) =>
			spawn(
				process.execPath,
				[
					join(dirname(fileURLToPath(import.meta.url)), "diagnostics-sender.mjs"),
					"--anchored",
					target,
				],
				{ detached: true, stdio: "ignore" },
			).unref(),
	},
) {
	if (!binding) return;
	const cache = anchoredMemory(stateDirectory, repo, binding, now);
	if (cache?.fresh) return cache;
	try {
		rmSync(memoryCache(stateDirectory, repo), { force: true });
		// An empty placeholder stops later hook events from starting a second fetch.
		writeAnchoredMemory(stateDirectory, repo, binding, [], cache?.shown ?? {}, now);
		launch(repo);
	} catch {
		// Memory cues are advisory.
	}
}

/**
 * After an edit, show at most two kept records that cite the edited file, once
 * per conversation, with their rationale inline. Matching is local: the edited
 * path is never sent.
 */
export function memoryCue(
	input,
	{ client, target, binding, stateDirectory, now = Date.now(), launch },
) {
	const session = sessionKey(client, input.session_id);
	if (input.hook_event_name !== "PostToolUse" || !session || !binding) return;
	const paths = editedPaths(input, client, target.root, true).map((path) =>
		path.split(sep).join("/"),
	);
	if (!paths.length) return;
	const cache = primeAnchoredMemory(target.repo, { binding, stateDirectory, now, launch });
	if (!cache) return;
	const seen = Array.isArray(cache.shown[session]) ? cache.shown[session] : [];
	const matches = cache.records
		.filter(
			(record) =>
				typeof record?.id === "string" &&
				typeof record.summary === "string" &&
				!seen.includes(record.id) &&
				Array.isArray(record.paths) &&
				record.paths.some((path) => paths.includes(path)),
		)
		.slice(0, MAX_MEMORY_CUES);
	if (!matches.length) return;
	const header = `Project memory about ${paths.filter((path) => matches.some((record) => record.paths.includes(path))).join(", ")}. These are dated notes from earlier work in ${target.repo}; check them against the current code before relying on them.`;
	const room = Math.floor((MEMORY_CUE_CHARS - header.length) / matches.length) - 1;
	const lines = matches.map((record) => {
		const line = `- ${record.kind} (${record.status}, ${String(record.createdAt).slice(0, 10)}): ${record.summary}${typeof record.detail === "string" ? ` Why: ${record.detail}` : ""}`;
		return line.length <= room
			? line
			: `${line.slice(0, Math.max(0, room - 60))}… (pharaoh_memory_expand ${record.id} v${record.version})`;
	});
	const shown = Object.fromEntries(
		[
			[session, [...seen, ...matches.map((record) => record.id)].slice(-MAX_SHOWN_RECORDS)],
			...Object.entries(cache.shown).filter(([key]) => key !== session),
		].slice(0, MAX_SHOWN_SESSIONS),
	);
	try {
		writeAnchoredMemory(
			stateDirectory,
			target.repo,
			binding,
			cache.records,
			shown,
			cache.fetchedAt,
		);
	} catch {
		return;
	}
	return {
		hookSpecificOutput: {
			hookEventName: "PostToolUse",
			additionalContext: [header, ...lines].join("\n").slice(0, MEMORY_CUE_CHARS + 100),
		},
	};
}
