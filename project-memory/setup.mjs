import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { bundledHook, installMemoryBundle, packagedMemoryBundle } from "./bundle.mjs";
import {
	clearDiagnosticQueue,
	diagnosticsPolicyEligible,
	revokeDiagnosticConsent,
} from "./diagnostics-collector.mjs";
import { hasLegacyHooks, hasUserHooks, updateHooks, updateUserHooks } from "./hook-config.mjs";
import { atomicWrite, checkout, git, hasMemoryGit } from "./local.mjs";
import { requestMemory, requestMemoryPolicy } from "./memory-api.mjs";
import {
	MEMORY_HOOK_CLIENTS,
	memoryHookStateForClient,
	nativeMemoryClient,
	readHookPreferences,
	writeHookPreferences,
} from "./preferences.mjs";
import {
	legacySettingsPath,
	matchingMemoryHint,
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

function syncUserHooks(
	client,
	home,
	env,
	target,
	hookPath,
	node,
	alreadyActive,
	graphCues,
	diagnostics,
) {
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
				updateUserHooks(settings.config, client, hookPath, node, graphCues, diagnostics),
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

/** Resolve memory defaults and explicit choices after a supported client's MCP registration. */
export async function chooseMemoryHooks({
	credentials,
	clients,
	requested = false,
	ask,
	home = homedir(),
	env = process.env,
}) {
	const choices = { accepted: [], declined: [], graphClients: [], notices: [] };
	if (typeof process.getuid !== "function") {
		if (requested)
			choices.notices.push("Pharaoh: project memory hooks need a POSIX client with system Git.");
		return choices;
	}
	if (credentials?.project_memory_status === "unavailable") {
		if (requested)
			choices.notices.push(
				"Pharaoh: project memory eligibility could not be checked. Retry setup to enable hooks.",
			);
		return choices;
	}
	if (!projectMemoryHint(credentials).length) {
		if (requested) choices.notices.push("Pharaoh: this session has no project memory hook grant.");
		return credentials ? { ...choices, removeUnentitled: true } : choices;
	}
	if (!clients.length || !hasMemoryGit) {
		if (requested && !hasMemoryGit)
			choices.notices.push("Pharaoh: project memory hooks need a POSIX client with system Git.");
		return choices;
	}
	for (const client of clients) {
		try {
			await revokeDiagnosticConsent(client, { home, readCredentials: async () => credentials });
		} catch {
			/* A pending content-free tombstone retries at the next setup. */
		}
	}
	const previous = readHookPreferences(home);
	const active = readActiveMemoryClients(home);
	const next = { ...previous };
	// A policy lookup failure never prevents ordinary memory setup.
	let diagnosticPolicy;
	try {
		diagnosticPolicy = await requestMemoryPolicy(
			projectMemoryHint(credentials)[0]?.repo,
			credentials,
			performance.now() + 500,
		);
	} catch {
		/* Closed until the server supplies eligible disclosure policy. */
	}
	for (const client of MEMORY_HOOK_CLIENTS) {
		if (!clients.includes(client)) continue;
		const label = client === "codex" ? "Codex" : "Claude Code";
		let config;
		try {
			config = inspectSettings(userSettings(client, home, env)).config;
		} catch {
			// An unreadable settings file cannot establish a previous installation.
		}
		if (client === "claude-code" && config?.disableAllHooks === true) continue;
		const choice = { ...previous[client] };
		if (requested || choice.memory !== false) choice.memory = true;
		if (choice.memory === true) {
			// A reminder reinstall must not restore diagnostic handlers from an old choice.
			if (
				choice.diagnostics === true &&
				(!active[client] || !hasUserHooks({ hooks: { Stop: config?.hooks?.Stop } }, client))
			)
				delete choice.diagnostics;
			let graphEnabled =
				choice.graph === true &&
				["PreToolUse", "PostToolUse"].every((event) =>
					hasUserHooks({ hooks: { [event]: config?.hooks?.[event] } }, client),
				);
			if (requested || choice.graph === undefined || (choice.graph === true && !graphEnabled)) {
				const answer = await ask(
					`Enable advisory Pharaoh worktree cues in ${label}? [y/N] `,
					false,
				);
				if (answer !== null) {
					choice.graph = answer;
					graphEnabled = answer;
				}
			}
			if (
				(requested || choice.diagnostics === undefined) &&
				diagnosticsPolicyEligible(diagnosticPolicy)
			) {
				const answer = await ask(
					`Share bounded project-memory task/action/final excerpts and record links from ${label} for diagnostics? Includes prompt text (1 KB), action descriptions (2 KB), final text (2 KB), edited paths and tool result metadata; incidental source may occur. No file-read bodies, patches, arbitrary shell output or hidden reasoning. Local queue: 1 MB/24 h; server retention: ${diagnosticPolicy.retentionDays ?? 90} days. Native hook review/trust remains required. [y/N] `,
					false,
				);
				if (answer !== null) {
					choice.diagnostics = false;
					if (!answer) {
						clearDiagnosticQueue(client, home);
						if (choice.diagnosticsGeneration)
							for (const hint of projectMemoryHint(credentials)) {
								try {
									await requestMemory(
										"diagnostics/control",
										{
											repo: hint.repo,
											clientName: client,
											enabled: false,
											generation: choice.diagnosticsGeneration,
											policyVersion: choice.diagnosticsPolicyVersion,
										},
										{ credentials, timeoutMs: 1_200 },
									);
								} catch {
									/* Local decline still prevents collection. */
								}
							}
					}
					if (answer) {
						const generation = randomUUID();
						try {
							for (const hint of projectMemoryHint(credentials)) {
								const control = await requestMemory(
									"diagnostics/control",
									{
										repo: hint.repo,
										clientName: client,
										enabled: true,
										generation,
										policyVersion: diagnosticPolicy.policyVersion,
									},
									{ credentials },
								);
								if (control?.enabled !== true || control.generation !== generation)
									throw new Error("Diagnostic consent was not confirmed.");
							}
							choice.diagnostics = true;
							choice.diagnosticsGeneration = generation;
							choice.diagnosticsPolicyVersion = diagnosticPolicy.policyVersion;
						} catch {
							choices.notices.push(
								`Pharaoh: ${label} diagnostics remain off because consent could not be confirmed. Retry setup later.`,
							);
						}
					}
				}
			}
			choices.accepted.push(client);
			if (graphEnabled) choices.graphClients.push(client);
		} else {
			choices.declined.push(client);
		}
		next[client] = choice;
	}
	writeHookPreferences(next, home, previous);
	return choices;
}

/** Apply the outcome against the saved choices, which can change after the prompt. */
export function applyMemoryHookChoices(decision, options = {}) {
	const { accepted, declined, graphClients, removeUnentitled } = decision;
	const notices = [...decision.notices];
	if (removeUnentitled)
		return [...notices, ...syncMemoryHooks({ ...options, clients: MEMORY_HOOK_CLIENTS })];

	if (declined.length) {
		const saved = readHookPreferences(options.home);
		const clients = declined.filter((client) => saved[client]?.memory === false);
		if (clients.length) notices.push(...syncMemoryHooks({ ...options, clients }));
	}
	if (accepted.length) {
		const saved = readHookPreferences(options.home);
		const clients = accepted.filter((client) => saved[client]?.memory === true);
		const cues = graphClients.filter((client) => saved[client]?.graph === true);
		if (clients.length)
			notices.push(...syncMemoryHooks({ ...options, clients, graphClients: cues, enable: true }));
	}
	return notices;
}

/**
 * At proxy start, give the identified Claude Code or Codex client the default
 * memory reminder without asking, as the installer would. Leaves alone anyone who
 * declined or ran --disable-memory-hooks, Claude Code with disableAllHooks, and an
 * edited or unreadable Pharaoh entry; adds graph cues or diagnostics only where
 * the user consented before. Returns lines for the user when it turned hooks on.
 */
export function ensureMemoryHooks(info, credentials, options = {}) {
	const { home = homedir(), env = process.env } = options;
	const client = nativeMemoryClient(info);
	if (!client || typeof process.getuid !== "function" || !hasMemoryGit) return [];
	if (credentials?.project_memory_status === "unavailable") return [];
	if (!projectMemoryHint(credentials).length) return [];
	const choice = readHookPreferences(home)[client] ?? {};
	if (choice.memory === false) return [];
	let config;
	try {
		config = inspectSettings(userSettings(client, home, env)).config;
	} catch {
		return [];
	}
	if (client === "claude-code" && config?.disableAllHooks === true) return [];
	const state = memoryHookStateForClient(info, { home, env });
	const fresh = state === "absent";
	if (!fresh) {
		// "installed" is Pharaoh's exact entry; anything else may be the user's edit.
		if (state !== "installed") return [];
		const digest = packagedMemoryBundle(options.packageRoot).sha256;
		const current = readActiveMemoryClients(home)[client];
		if (current === digest && existsSync(bundledHook(join(memoryClientRoot(home), digest))))
			return [];
	}
	// As at setup: a saved diagnostics choice never puts back handlers the user removed.
	if (
		choice.diagnostics === true &&
		(!readActiveMemoryClients(home)[client] ||
			!hasUserHooks({ hooks: { Stop: config?.hooks?.Stop } }, client))
	) {
		const { diagnostics: _removed, ...kept } = choice;
		writeHookPreferences({ ...readHookPreferences(home), [client]: kept }, home);
	}
	const graph =
		choice.graph === true &&
		["PreToolUse", "PostToolUse"].every((event) =>
			hasUserHooks({ hooks: { [event]: config?.hooks?.[event] } }, client),
		);
	syncMemoryHooks({
		...options,
		credentials,
		clients: [client],
		graphClients: graph ? [client] : [],
		enable: true,
	});
	if (!fresh || memoryHookStateForClient(info, { home, env }) !== "installed") return [];
	const label = client === "codex" ? "Codex" : "Claude Code";
	return [
		`Pharaoh turned on project memory reminders in ${label}: from your next conversation, the agent is reminded to check past decisions for this repo. To turn them off, run \`npx @pharaoh-so/mcp --disable-memory-hooks\`.`,
		...(client === "codex"
			? [
					"Codex runs the reminder only after you review and trust it in /hooks or Settings > Hooks.",
				]
			: []),
	];
}

/** Run only during setup or explicit cleanup of the local memory hooks. */
export function syncMemoryHooks({
	credentials,
	clients = MEMORY_HOOK_CLIENTS,
	graphClients = [],
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
	const preferences = readHookPreferences(home);

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

	for (const client of MEMORY_HOOK_CLIENTS) {
		if (!clients.includes(client)) continue;
		const next = { ...active, [client]: digest };
		if (
			!enable ||
			preferences[client]?.memory === false ||
			preferences[client]?.diagnostics !== true
		)
			clearDiagnosticQueue(client, home);
		try {
			// Enable the replacement before swapping any settings, so failed
			// activation cannot strand an existing hook or remove a legacy one.
			const replacing = enable && active[client] !== digest;
			if (replacing) writeActivation(activePath, next);
			try {
				syncUserHooks(
					client,
					home,
					env,
					target,
					installed,
					node,
					active[client],
					graphClients.includes(client),
					preferences[client]?.memory !== false && preferences[client]?.diagnostics === true,
				);
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
	if (!enable) {
		const remaining = Object.fromEntries(
			Object.entries(active).filter(([client]) => !clients.includes(client)),
		);
		if (Object.keys(remaining).length !== Object.keys(active).length)
			writeActivation(activePath, remaining);
	}
	for (const client of enable ? configured : clients) {
		if (MEMORY_HOOK_CLIENTS.includes(client)) migrateCheckout(client, target, notices);
	}
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
