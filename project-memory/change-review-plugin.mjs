import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { memoryClientRoot } from "./client-settings.mjs";
import { ensureLocalPrivatePaths, memorySettingsPath } from "./install-scope.mjs";
import { atomicWrite, updateLocalState } from "./local.mjs";

const moduleFile = "hooks/register.js";
const hooksFile = "hooks/hooks.json";
const manifestFile = ".claude-plugin/plugin.json";
const leaves = [moduleFile, hooksFile, manifestFile];

const hash = (text) => createHash("sha256").update(text).digest("hex");

function canonicalPath(path) {
	if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync(path);
	return join(canonicalPath(dirname(path)), basename(path));
}

function insideCheckout(path, root) {
	const location = relative(root, path);
	return location !== ".." && !location.startsWith("../") && !isAbsolute(location);
}

function validateContents(directory) {
	for (const [path, allowed] of [
		[directory, ["hooks", ".claude-plugin"]],
		[join(directory, "hooks"), ["register.js", "hooks.json"]],
		[join(directory, ".claude-plugin"), ["plugin.json"]],
	]) {
		if (existsSync(path) && readdirSync(path).some((entry) => !allowed.includes(entry)))
			throw new Error("The Claude receipt plugin contains files that Pharaoh does not own.");
	}
}

function validateDirectory(path) {
	const info = lstatSync(path, { throwIfNoEntry: false });
	if (info && (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o022))
		throw new Error("The Claude receipt plugin directory is not owner-controlled.");
}

function fileHash(path) {
	const info = lstatSync(path, { throwIfNoEntry: false });
	if (!info) return null;
	if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > 64 * 1024)
		return "unsafe";
	return hash(readFileSync(path));
}

function removeEmpty(path) {
	try {
		rmdirSync(path);
	} catch (error) {
		if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
	}
}

function pluginSources(name, node, hook, scope, packageRoot) {
	if (!isAbsolute(node) || !isAbsolute(hook)) throw new Error("The release hook must be pinned.");
	const template = readFileSync(new URL("hooks/change-review-completion.js", packageRoot), "utf8");
	const launch = {
		node,
		hook,
		scope: scope?.kind === "local" ? ["--install-root", scope.root] : [],
	};
	const marker = "const launch = null;";
	if (!template.includes(marker)) throw new Error("The Claude completion module is invalid.");
	return {
		[moduleFile]: template.replace(marker, () => `const launch = ${JSON.stringify(launch)};`),
		[hooksFile]: `${JSON.stringify({ modules: ["./register.js"] })}\n`,
		[manifestFile]: `${JSON.stringify({ name, description: "Shows verified Pharaoh change reviews." })}\n`,
	};
}

/** Enroll the current opt-in scope. Removing a file requires its exact previously installed hash. */
export function syncChangeReviewPlugin({
	home,
	env,
	scope,
	node,
	hook,
	target,
	packageRoot = new URL("../", import.meta.url),
}) {
	const local = scope?.kind === "local";
	const name = local ? "pharaoh-change-review-local" : "pharaoh-change-review";
	const requested = dirname(memorySettingsPath("claude-code", home, env, scope));
	const config = local ? requested : canonicalPath(requested);
	const skills = join(config, "skills");
	const directory = join(skills, name);
	const stateRoot = memoryClientRoot(home);
	const ownership = `receipt-plugin-${hash(directory)}.json`;
	if (!hook && !existsSync(join(stateRoot, ownership))) return;
	if (!local && target && [requested, config].some((path) => insideCheckout(path, target.root)))
		throw new Error("The global receipt plugin would be installed inside the checkout.");
	const sources = hook ? pluginSources(name, node, hook, scope, packageRoot) : null;
	let reconciled = false;
	const complete = updateLocalState(stateRoot, ownership, (record) => {
		for (const parent of [
			config,
			skills,
			directory,
			join(directory, "hooks"),
			join(directory, ".claude-plugin"),
		])
			validateDirectory(parent);
		const previous = record?.files ?? {};
		const pending = record?.pending ?? {};
		const owned = Object.keys(previous).length > 0 || Object.keys(pending).length > 0;
		const ownedHash = (leaf, digest) => previous[leaf] === digest || pending[leaf] === digest;
		const actual = Object.fromEntries(
			leaves.map((leaf) => [leaf, fileHash(join(directory, leaf))]),
		);
		if (!sources) {
			if (owned) {
				for (const leaf of leaves) {
					if (!actual[leaf] || !ownedHash(leaf, actual[leaf])) continue;
					const path = join(directory, leaf);
					ensureLocalPrivatePaths(scope, [path]);
					unlinkSync(path);
				}
				for (const parent of ["hooks", ".claude-plugin", ""]) removeEmpty(join(directory, parent));
			}
			if (record) unlinkSync(join(stateRoot, ownership));
			reconciled = true;
			return;
		}
		const expected = Object.fromEntries(leaves.map((leaf) => [leaf, hash(sources[leaf])]));
		if (!owned && existsSync(directory))
			throw new Error("The Claude receipt plugin directory is already owned by someone else.");
		validateContents(directory);
		for (const leaf of leaves) {
			if (actual[leaf] && !ownedHash(leaf, actual[leaf]))
				throw new Error("The installed Claude receipt plugin was edited.");
		}
		const changed = leaves.filter((leaf) => actual[leaf] !== expected[leaf]);
		ensureLocalPrivatePaths(
			scope,
			leaves.map((leaf) => join(directory, leaf)),
		);
		if (!changed.length && !record.pending) {
			reconciled = true;
			return;
		}
		// Record exactly which replacement bytes we may own before writing them. If a
		// process stops between file replacement and the final ledger update, both
		// cleanup and retry can recognize the partial install under this same lock.
		if (changed.length)
			atomicWrite(join(stateRoot, ownership), JSON.stringify({ files: actual, pending: expected }));
		const written = [];
		try {
			for (const leaf of changed) {
				const path = join(directory, leaf);
				const original = actual[leaf] ? readFileSync(path) : null;
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
				atomicWrite(path, sources[leaf], (temp) => ensureLocalPrivatePaths(scope, [temp]));
				written.push({ path, original });
			}
		} catch (error) {
			for (const { path, original } of written.reverse()) {
				if (original) atomicWrite(path, original, (temp) => ensureLocalPrivatePaths(scope, [temp]));
				else unlinkSync(path);
			}
			if (!owned)
				for (const parent of ["hooks", ".claude-plugin", ""]) removeEmpty(join(directory, parent));
			throw error;
		}
		return { state: { files: expected }, context: true };
	});
	if (!complete && !reconciled)
		throw new Error("The Claude receipt plugin enrollment is busy or unreadable.");
}
