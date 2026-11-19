/** Shared local activation paths and checkout guards for the bundled memory hooks. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { git } from "./local.mjs";
export { memoryActivePath } from "./client-settings.mjs";

let processScope;

/** Set only from a verified managed launch or the explicit installer target. */
export function setMemoryInstallScope(scope) {
	if (scope?.kind === "local" && !isAbsolute(scope.root))
		throw new Error("Local installation needs an absolute checkout root.");
	processScope = scope?.kind === "local" ? { kind: "local", root: scope.root } : undefined;
}

/** The current process's explicit installation scope; omitted means legacy Global. */
export function memoryInstallScope() {
	return processScope;
}

/** A private filename suffix, never an upstream repository identifier. */
export function memoryScopeKey(scope = processScope) {
	return scope?.kind === "local" ? createHash("sha256").update(scope.root).digest("hex") : null;
}

/** Resolve the native client's settings without changing its home/profile. */
export function memorySettingsPath(client, home, env, scope = processScope) {
	const codex = client === "codex";
	if (scope?.kind === "local")
		return join(scope.root, codex ? ".codex/hooks.json" : ".claude/settings.local.json");
	const directory =
		(codex ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR) ?? join(home, codex ? ".codex" : ".claude");
	if (!isAbsolute(directory)) throw new Error("Client configuration directory must be absolute.");
	return join(directory, codex ? "hooks.json" : "settings.json");
}

/** Re-check native event context, including nested directories and linked worktrees. */
export function memoryScopeMatches(cwd, scope = processScope) {
	if (scope?.kind !== "local") return true;
	if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
	try {
		return realpathSync(git(cwd, "rev-parse", "--show-toplevel")) === scope.root;
	} catch {
		return false;
	}
}

function scopeGit(root, ...args) {
	return execFileSync(
		"git",
		[
			"--no-optional-locks",
			"--no-replace-objects",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"-C",
			root,
			...args,
		],
		{
			env: {
				...Object.fromEntries(
					Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
				),
				GIT_NO_LAZY_FETCH: "1",
				GIT_ALLOW_PROTOCOL: "",
			},
			encoding: "utf8",
			timeout: 2_000,
			maxBuffer: 16_384,
			stdio: ["ignore", "pipe", "ignore"],
		},
	).trim();
}

/**
 * Keep generated checkout configuration private without changing the repository's .gitignore.
 * @param {object | undefined} scope - The explicitly selected installation boundary.
 * @param {string[]} paths - Absolute generated paths, including any temporary write files.
 * @returns {void} Throws before writes if a path is tracked, linked or cannot be ignored.
 */
export function ensureLocalPrivatePaths(scope, paths) {
	if (scope?.kind !== "local") return;
	const root = scope.root;
	if (realpathSync(scopeGit(root, "rev-parse", "--show-toplevel")) !== root)
		throw new Error("Local configuration needs its canonical Git checkout.");
	const names = [...new Set(paths)].map((path) => {
		const name = relative(root, path);
		if (
			!name ||
			name === ".." ||
			name.startsWith(`..${sep}`) ||
			isAbsolute(name) ||
			/[\r\n\0]/.test(name)
		)
			throw new Error("Local configuration must stay inside its checkout.");
		let ancestor = root;
		const parts = name.split(sep);
		for (let i = 0; i < parts.length; i++) {
			ancestor = join(ancestor, parts[i]);
			const entry = lstatSync(ancestor, { throwIfNoEntry: false });
			if (
				entry &&
				(i < parts.length - 1 ? !entry.isDirectory() : !entry.isFile() || entry.nlink > 1)
			)
				throw new Error(`Local configuration is not a regular path: ${path}`);
		}
		if (scopeGit(root, "ls-files", "--", `:(literal)${name}`))
			throw new Error(`Local configuration is tracked by Git: ${path}`);
		return name.split(sep).join("/");
	});
	const missing = names.filter((name) => {
		try {
			scopeGit(root, "check-ignore", "--quiet", "--", name);
			return false;
		} catch (error) {
			if (error.status !== 1) throw error;
			return true;
		}
	});
	if (!missing.length) return;
	// Git's own path resolution handles linked worktrees and separate Git directories.
	const common = realpathSync(resolve(root, scopeGit(root, "rev-parse", "--git-common-dir")));
	const info = join(common, "info");
	mkdirSync(info, { recursive: true, mode: 0o700 });
	if (!lstatSync(info).isDirectory()) throw new Error("Git's private exclude directory is linked.");
	const exclude = join(info, "exclude");
	const existing = lstatSync(exclude, { throwIfNoEntry: false });
	if (existing && (!existing.isFile() || existing.nlink > 1))
		throw new Error("Git's private exclude file is linked.");
	const fd = openSync(
		exclude,
		constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink > 1 || stat.size > 1024 * 1024)
			throw new Error("Git's private exclude file is unsafe.");
		const entries = missing.map((name) => `/${name.replace(/[\\!*?#[\] ]/g, "\\$&")}`);
		writeFileSync(
			fd,
			`\n# Pharaoh Local configuration (machine-specific)\n${entries.join("\n")}\n`,
		);
	} finally {
		closeSync(fd);
	}
	for (const name of missing) {
		try {
			scopeGit(root, "check-ignore", "--quiet", "--", name);
		} catch {
			throw new Error(`Git does not ignore Local configuration: ${join(root, name)}`);
		}
	}
}
