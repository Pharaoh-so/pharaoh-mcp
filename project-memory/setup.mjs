import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { bundledHook, installMemoryBundle, packagedMemoryBundle } from "./bundle.mjs";
import { hasLegacyHooks, updateHooks, updateUserHooks } from "./hook-config.mjs";
import { atomicWrite, checkout, git, hasMemoryGit } from "./local.mjs";
import {
	eligibleCheckout,
	legacySettingsPath,
	memoryClientRoot,
	projectMemoryHint,
	readActiveMemoryClients,
	readHookSettings,
} from "./user-target.mjs";

function userSettings(client, home, env) {
	const codex = client === "codex";
	const directory =
		(codex ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR) ?? join(home, codex ? ".codex" : ".claude");
	if (!isAbsolute(directory)) throw new Error("Client configuration directory must be absolute.");
	return join(directory, codex ? "hooks.json" : "settings.json");
}

function writeSettings(path, previous, next) {
	if (JSON.stringify(previous) === JSON.stringify(next)) return;
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const info = lstatSync(directory);
	if (!info.isDirectory() || info.uid !== process.getuid?.())
		throw new Error("Client settings directory is not owner-controlled.");
	atomicWrite(path, `${JSON.stringify(next, null, "\t")}\n`);
}

function migrateCheckout(client, target) {
	if (!target) return;
	const path = legacySettingsPath(client, target.root);
	const before = readHookSettings(path);
	if (!hasLegacyHooks(before, client, target.root)) return;
	const relative = path.slice(target.root.length + 1);
	if (realpathSync(dirname(path)) !== dirname(path) || git(target.root, "ls-files", "--", relative))
		throw new Error("The earlier checkout hook is in tracked or linked settings.");
	// The legacy installer always wrote ignored files. Never create or alter
	// Git excludes, and never migrate project settings that can be committed.
	git(target.root, "check-ignore", "--quiet", "--no-index", "--", relative);
	writeSettings(path, before, updateHooks(before, client, target, true));
}

/** Run only as part of a deliberate normal setup, upgrade, clean or logout. */
export function syncMemoryHooks({
	credentials,
	clients = [],
	home = homedir(),
	env = process.env,
	cwd = process.cwd(),
	node = process.execPath,
	removeLegacy = false,
	packageRoot,
} = {}) {
	const hint = projectMemoryHint(credentials);
	const root = memoryClientRoot(home);
	const previous = readActiveMemoryClients(home);
	if (!removeLegacy && credentials?.project_memory_status === "unavailable") {
		return [
			"Pharaoh: project memory eligibility could not be checked. Existing hook settings were kept. Rerun normal setup to retry.",
		];
	}
	if (!hint.length && !Object.keys(previous).length && !removeLegacy) return [];
	const notices = [];
	const active = {};
	const configured = [];
	let installed;
	let digest;
	const target = removeLegacy ? checkout(cwd) : eligibleCheckout(cwd, hint);
	const pendingCheckout =
		!target && hint.some((entry) => entry?.revision === null) ? checkout(cwd) : undefined;
	const pendingRoot =
		pendingCheckout &&
		hint.some(
			(entry) =>
				entry?.revision === null &&
				entry.repo?.toLowerCase() === pendingCheckout.repo.toLowerCase(),
		)
			? pendingCheckout.root
			: undefined;

	if (hint.length) {
		try {
			if (!hasMemoryGit || typeof process.getuid !== "function")
				throw new Error("Project memory needs a POSIX client with system Git.");
			const bundle = packagedMemoryBundle(packageRoot);
			digest = bundle.sha256;
			installed = bundledHook(installMemoryBundle(root, target?.root ?? pendingRoot, bundle));
		} catch (error) {
			return [`Pharaoh: project memory setup unavailable. ${error.message}`];
		}
	}

	for (const client of ["claude-code", "codex"]) {
		const desired = clients.includes(client) ? installed : undefined;
		if (!desired && !previous[client] && !removeLegacy) continue;
		try {
			const path = userSettings(client, home, env);
			const before = readHookSettings(path);
			writeSettings(path, before, updateUserHooks(before, client, desired, node));
			if (desired) {
				active[client] = digest;
				configured.push(client);
			}
		} catch {
			if (desired && previous[client]) active[client] = previous[client];
			if (desired || previous[client])
				notices.push(
					`Pharaoh: project memory could not update ${client} hooks. Check the client settings and rerun normal setup.`,
				);
		}
	}

	// This private activation record makes older hook commands inert even if a
	// client still has them loaded or its settings could not be updated.
	const activePath = join(root, "active.json");
	if (Object.keys(active).length) {
		if (JSON.stringify(previous) !== JSON.stringify(active))
			atomicWrite(activePath, `${JSON.stringify(active)}\n`);
		if (configured.length) {
			notices.push(
				"Pharaoh project memory is set up for your eligible repositories. Start a new local conversation.",
			);
			if (hint.some((entry) => entry?.revision === null))
				notices.push(
					"A connected repository is still mapping. Its hooks will start memory automatically when the mapped revision is available.",
				);
			if (configured.includes("codex"))
				notices.push("In Codex, review and trust the Pharaoh hooks in /hooks or Settings > Hooks.");
		}
	} else if (Object.keys(previous).length) {
		rmSync(activePath, { force: true });
	}
	// The old checkout hook is a fallback until its replacement settings and
	// the private activation record are both in place.
	for (const client of ["claude-code", "codex"]) {
		if (!removeLegacy && !configured.includes(client)) continue;
		try {
			migrateCheckout(client, target);
		} catch {
			notices.push(
				`Pharaoh: the earlier ${client} checkout hook remains in place for this checkout.`,
			);
		}
	}
	return notices;
}
