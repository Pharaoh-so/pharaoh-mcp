/** Private installation selectors. Scope is never part of the runtime wire contract. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function runtimeProfilePath(client, options = {}) {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const directory =
		(client === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR) ??
		join(home, client === "codex" ? ".codex" : ".claude");
	if (!isAbsolute(directory)) throw new Error("Unsupported native hook configuration.");
	return resolve(directory, client === "codex" ? "hooks.json" : "settings.json");
}

export function runtimeProfileId(client, options = {}) {
	const standard = runtimeProfilePath(client, { ...options, env: {} });
	const actual = runtimeProfilePath(client, options);
	return actual === standard ? null : digest(actual);
}

export function runtimeScope(options = {}) {
	if (options.scope?.kind !== "local") return { kind: "global" };
	if (typeof options.scope.root !== "string" || !isAbsolute(options.scope.root))
		throw new Error("Invalid local runtime root.");
	return { kind: "local", root: resolve(options.scope.root) };
}

export function runtimeTargetId(client, options = {}) {
	const scope = runtimeScope(options);
	return digest(JSON.stringify([client, runtimeProfilePath(client, options), scope]));
}

function checkoutRoot(path) {
	try {
		if (typeof path !== "string" || !isAbsolute(path)) return null;
		const value = execFileSync(
			"git",
			[
				"--no-optional-locks",
				"--no-replace-objects",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.untrackedCache=false",
				"-C",
				path,
				"rev-parse",
				"--show-toplevel",
			],
			{
				encoding: "utf8",
				timeout: 750,
				maxBuffer: 16_384,
				stdio: ["ignore", "pipe", "ignore"],
				env: {
					...Object.fromEntries(
						Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
					),
					GIT_NO_LAZY_FETCH: "1",
					GIT_TERMINAL_PROMPT: "0",
				},
			},
		).trim();
		return value ? realpathSync(value) : null;
	} catch {
		return null;
	}
}

/** Check native execution context each time; a configured root is not proof of session location. */
export function runtimeScopeMatches(scope, options = {}) {
	if (scope?.kind !== "local") return true;
	let expected;
	try {
		expected = realpathSync(scope.root);
	} catch {
		return false;
	}
	if (expected !== scope.root || checkoutRoot(options.cwd ?? process.cwd()) !== expected)
		return false;
	return options.inputCwd === undefined || checkoutRoot(options.inputCwd) === expected;
}

export function runtimeScopeArguments(scope) {
	return scope?.kind === "local" ? ["--install-scope", "local", "--install-root", scope.root] : [];
}

export function runtimeScopeFromArguments(args) {
	const index = args.indexOf("--install-scope");
	if (index < 0) return { kind: "global" };
	if (args[index + 1] !== "local" || args[index + 2] !== "--install-root") return null;
	try {
		return runtimeScope({ scope: { kind: "local", root: args[index + 3] } });
	} catch {
		return null;
	}
}
