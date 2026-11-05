import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitBefore, sessionKey, updateWorktreeCueState } from "./local.mjs";

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

function editedPaths(input, client, root) {
	let paths;
	if (client === "codex") {
		if (input.tool_name !== "apply_patch") return [];
		const patch = input.tool_input?.command;
		const succeeded = responseText(input.tool_response).some((text) =>
			/^Success\. Updated the following files:/m.test(text),
		);
		if (!succeeded || typeof patch !== "string" || !patch.startsWith("*** Begin Patch\n"))
			return [];
		paths = [
			...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm),
		].map((match) => match[1]);
	} else {
		if (!["Edit", "Write", "MultiEdit"].includes(input.tool_name)) return [];
		paths = [input.tool_input?.file_path];
	}
	if (paths.length > MAX_EDIT_PATHS) return [];
	const inCheckout = paths.flatMap((path) => {
		if (typeof path !== "string" || path.length > 512 || !MAPPED_FILE.test(path)) return [];
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
