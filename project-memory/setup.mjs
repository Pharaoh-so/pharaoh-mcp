import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { bundledHook, installMemoryBundle, packagedMemoryBundle } from "./bundle.mjs";
import { hasLegacyHooks, hasUserHooks, updateHooks, updateUserHooks } from "./hook-config.mjs";
import { atomicWrite, checkout, git, hasMemoryGit } from "./local.mjs";
import {
	legacySettingsPath,
	matchingMemoryHint,
	memoryClientRoot,
	projectMemoryHint,
	readActiveMemoryClients,
	readHookSettings,
} from "./user-target.mjs";

const CLIENTS = ["claude-code", "codex"];

function userSettings(client, home, env) {
	const codex = client === "codex";
	const directory =
		(codex ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR) ?? join(home, codex ? ".codex" : ".claude");
	if (!isAbsolute(directory)) throw new Error("Client configuration directory must be absolute.");
	return join(directory, codex ? "hooks.json" : "settings.json");
}

function canonicalSettingsPath(path) {
	try {
		return realpathSync(path);
	} catch (error) {
		const parent = dirname(path);
		if (error.code !== "ENOENT" || parent === path) throw error;
		// Even a missing settings file can be under a linked ancestor.
		return join(canonicalSettingsPath(parent), basename(path));
	}
}

function inspectSettings(path) {
	const resolved = canonicalSettingsPath(path);
	return { path, resolved, config: readHookSettings(resolved) };
}

function writeSettings({ path, resolved, config }, next, target, requireIgnored = false) {
	if (JSON.stringify(config) === JSON.stringify(next)) return;
	if (requireIgnored && path !== resolved)
		throw new Error("The checkout hook settings are linked.");
	if (target) {
		const location = relative(target.root, resolved);
		if (
			location &&
			location !== ".." &&
			!location.startsWith(`..${sep}`) &&
			!isAbsolute(location)
		) {
			if (git(target.root, "ls-files", "--", `:(literal)${location}`))
				throw new Error("The checkout hook settings are tracked.");
			if (requireIgnored) git(target.root, "check-ignore", "--quiet", "--no-index", "--", location);
		}
	}
	const directory = dirname(path);
	const file = lstatSync(path, { throwIfNoEntry: false });
	if (file && !file.isFile()) throw new Error("The hook settings are linked.");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const info = lstatSync(directory);
	if (!info.isDirectory() || info.uid !== process.getuid?.())
		throw new Error("Client settings directory is not owner-controlled.");
	atomicWrite(resolved, `${JSON.stringify(next, null, "\t")}\n`);
}

function migrateCheckout(client, target, notices) {
	if (!target) return;
	let known = false;
	try {
		const settings = inspectSettings(legacySettingsPath(client, target.root));
		known = hasLegacyHooks(settings.config, client, target.root);
		if (known)
			writeSettings(settings, updateHooks(settings.config, client, target, true), target, true);
	} catch {
		if (known)
			notices.push(
				`Pharaoh: the earlier ${client} checkout hook remains in place for this checkout.`,
			);
	}
}

function syncUserHooks(client, home, env, target, hookPath, node, alreadyActive) {
	let known = Boolean(alreadyActive);
	try {
		const settings = inspectSettings(userSettings(client, home, env));
		known ||= hasUserHooks(settings.config, client);
		if (hookPath || known) {
			const legacy = target && legacySettingsPath(client, target.root);
			const checkoutHook =
				legacy &&
				[settings.path, settings.resolved].includes(legacy) &&
				hasLegacyHooks(settings.config, client, target.root);
			writeSettings(
				settings,
				updateUserHooks(settings.config, client, hookPath, node),
				target,
				checkoutHook,
			);
		}
	} catch (error) {
		if (hookPath || known) throw error;
	}
}

function writeActivation(path, active) {
	if (Object.keys(active).length) atomicWrite(path, `${JSON.stringify(active)}\n`);
	else rmSync(path, { force: true });
}

/** Run only during setup or explicit cleanup of the local memory hooks. */
export function syncMemoryHooks({
	credentials,
	clients = [],
	enable = false,
	home = homedir(),
	env = process.env,
	cwd = process.cwd(),
	node = process.execPath,
	packageRoot,
} = {}) {
	if (typeof process.getuid !== "function")
		return enable ? ["Pharaoh: project memory reminders need a POSIX client."] : [];
	const root = memoryClientRoot(home);
	const activePath = join(root, "active.json");
	let active = readActiveMemoryClients(home);
	const target = checkout(cwd);
	const notices = [];
	const configured = [];

	let installed;
	let digest;
	const hint = projectMemoryHint(credentials);
	if (enable) {
		if (credentials?.project_memory_status === "unavailable")
			return [
				"Pharaoh: project memory eligibility could not be checked. Retry setup to enable reminders.",
			];
		if (!hint.length) return ["Pharaoh: this session has no project memory hook grant."];
		try {
			if (!hasMemoryGit) throw new Error("Project memory needs a POSIX client with system Git.");
			const enrolledRoot = target && matchingMemoryHint(target, hint) ? target.root : undefined;
			const bundle = packagedMemoryBundle(packageRoot);
			digest = bundle.sha256;
			installed = bundledHook(installMemoryBundle(root, enrolledRoot, bundle));
		} catch (error) {
			return [`Pharaoh: project memory reminders unavailable. ${error.message}`];
		}
	}

	for (const client of CLIENTS) {
		if (enable && !clients.includes(client)) continue;
		const next = { ...active, [client]: digest };
		try {
			// Enable the replacement before swapping any settings, so failed
			// activation cannot strand an existing hook or remove a legacy one.
			const replacing = enable && active[client] !== digest;
			if (replacing) writeActivation(activePath, next);
			try {
				syncUserHooks(client, home, env, target, installed, node, active[client]);
			} catch (error) {
				if (replacing) writeActivation(activePath, active);
				throw error;
			}
			if (enable) {
				active = next;
				configured.push(client);
			}
		} catch {
			notices.push(
				`Pharaoh: could not update ${client} project memory hooks. Check the client settings and retry.`,
			);
		}
	}

	// Deactivate loaded user hooks even if known settings could not be edited.
	if (!enable && Object.keys(active).length) writeActivation(activePath, {});
	for (const client of enable ? configured : CLIENTS) migrateCheckout(client, target, notices);
	if (configured.length) {
		notices.push(
			"Pharaoh project memory reminders are set up for your eligible repositories. Start a new local conversation.",
		);
		if (hint.some((entry) => entry?.revision === null))
			notices.push(
				"A connected repository is still mapping. Its reminder will run after the mapped revision is available.",
			);
		if (configured.includes("codex"))
			notices.push(
				"In Codex, review and trust the Pharaoh reminder in /hooks or Settings > Hooks.",
			);
	}
	return notices;
}
