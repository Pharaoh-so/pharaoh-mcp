import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { bundledHook, installMemoryBundle, packagedMemoryBundle } from "./bundle.mjs";
import { syncChangeReviewPlugin } from "./change-review-plugin.mjs";
import {
	hasOtherActiveMemoryClient,
	memoryClientRoot,
	readActiveMemoryClients,
	readHookSettings,
} from "./client-settings.mjs";
import {
	clearDiagnosticQueue,
	diagnosticsPolicyEligible,
	revokeDiagnosticConsent,
} from "./diagnostics-collector.mjs";
import {
	hasCaptureHook,
	hasChangeReviewHooks,
	hasLegacyHooks,
	hasMemoryCueHook,
	hasStructuralCueHooks,
	hasUserHookMode,
	hasUserHooks,
	updateHooks,
	updateUserHooks,
} from "./hook-config.mjs";
import {
	ensureLocalPrivatePaths,
	memoryActivePath,
	memoryInstallScope,
	memorySettingsPath,
} from "./install-scope.mjs";
import { atomicWrite, checkout, git, hasMemoryGit } from "./local.mjs";
import { requestMemory, requestMemoryPolicy } from "./memory-api.mjs";
import {
	changeReviewEnabled,
	MEMORY_HOOK_CLIENTS,
	memoryHookStateForClient,
	nativeMemoryClient,
	readHookPreferences,
	setChangeReview,
	writeHookPreferences,
} from "./preferences.mjs";
import { legacySettingsPath, matchingMemoryHint, projectMemoryHint } from "./user-target.mjs";

function userSettings(client, home, env, scope) {
	return memorySettingsPath(client, home, env, scope);
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

function writeSettings({ path, resolved, config }, next, target, requireIgnored = false, scope) {
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
	atomicWrite(resolved, `${JSON.stringify(next, null, "\t")}\n`, (temporary) =>
		ensureLocalPrivatePaths(scope, [temporary]),
	);
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
	capture,
	scope,
	review,
	preserveHandlers,
) {
	let known = Boolean(alreadyActive);
	try {
		const settings = inspectSettings(userSettings(client, home, env, scope));
		known ||= hasUserHooks(settings.config, client, scope);
		if (hookPath || known) {
			const legacy = target && legacySettingsPath(client, target.root);
			const checkoutHook =
				legacy &&
				[settings.path, settings.resolved].includes(legacy) &&
				hasLegacyHooks(settings.config, client, target.root);
			const preserve = preserveHandlers
				? {
						diagnostics: ["PostToolUse", "Stop", "StopFailure", "Interrupt", "SessionEnd"].filter(
							(event) => hasUserHookMode(settings.config, [event], "--diagnostics", scope),
						),
						graphPre: hasUserHookMode(settings.config, ["PreToolUse"], "--graph", scope),
						graphMap: (settings.config.hooks?.PostToolUse ?? []).some(
							(entry) =>
								typeof entry.matcher === "string" &&
								entry.matcher.includes("mcp__pharaoh__get_codebase_map") &&
								hasUserHookMode(
									{ hooks: { PostToolUse: [entry] } },
									["PostToolUse"],
									"--graph",
									scope,
								),
						),
					}
				: undefined;
			writeSettings(
				settings,
				updateUserHooks(
					settings.config,
					client,
					hookPath,
					node,
					graphCues,
					diagnostics,
					capture,
					scope,
					review,
					preserve,
				),
				target ?? (scope?.kind === "local" ? { root: scope.root } : undefined),
				checkoutHook,
				scope,
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

/**
 * A completed check that named no repo: the grant is gone. Before the first
 * check, or after an incomplete one, the hooks install and stay quiet.
 */
function grantLost(credentials) {
	return (
		!projectMemoryHint(credentials).length &&
		Boolean(credentials?.project_memory_checked_at) &&
		credentials?.project_memory_status !== "unavailable"
	);
}

/** Resolve memory defaults and explicit choices after a supported client's MCP registration. */
export async function chooseMemoryHooks({
	credentials,
	clients,
	requested = false,
	ask,
	home = homedir(),
	env = process.env,
	scope = memoryInstallScope(),
}) {
	const choices = {
		accepted: [],
		declined: [],
		graphClients: [],
		diagnosticClients: [],
		notices: [],
	};
	if (typeof process.getuid !== "function") {
		if (requested)
			choices.notices.push("Pharaoh: project memory hooks need a POSIX client with system Git.");
		return choices;
	}
	// An incomplete eligibility check doesn't stop setup: the hooks stay quiet until
	// the background check at the next session start names a repo.
	// A completed check that found no repo is a lost grant. Before the first check
	// (it runs at the next session start) the hooks install and stay quiet.
	if (grantLost(credentials)) {
		if (requested) choices.notices.push("Pharaoh: this session has no project memory hook grant.");
		return { ...choices, removeUnentitled: true };
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
	const active = readActiveMemoryClients(home, scope);
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
			config = inspectSettings(userSettings(client, home, env, scope)).config;
		} catch {
			// An unreadable settings file cannot establish a previous installation.
		}
		if (client === "claude-code" && config?.disableAllHooks === true) continue;
		const choice = { ...previous[client] };
		const sharedDiagnostics =
			scope?.kind === "local" || hasOtherActiveMemoryClient(client, home, scope);
		let diagnosticEnabled = choice.diagnostics === true;
		if (requested || choice.memory !== false) choice.memory = true;
		if (choice.memory === true) {
			// A reminder reinstall must not restore diagnostic handlers from an old choice.
			if (
				choice.diagnostics === true &&
				(!active[client] || !hasUserHookMode(config, ["Stop"], "--diagnostics", scope))
			) {
				diagnosticEnabled = false;
				if (!sharedDiagnostics) delete choice.diagnostics;
			}
			// The memory cue comes with memory; this choice covers only the structural cues.
			let graphEnabled = choice.graph === true && hasStructuralCueHooks(config, client, scope);
			if (requested || choice.graph === undefined || (choice.graph === true && !graphEnabled)) {
				const answer = await ask(
					`Also show Pharaoh's structural hints in ${label}? When your agent greps for code, they suggest the Pharaoh query; after a codebase map, they say when an edited file differs from the mapped revision. [y/N] `,
					false,
				);
				if (answer !== null) {
					choice.graph = answer;
					graphEnabled = answer;
				}
			}
			if (
				((requested && !sharedDiagnostics) || choice.diagnostics === undefined) &&
				diagnosticsPolicyEligible(diagnosticPolicy)
			) {
				const answer = await ask(
					`Share bounded project-memory task/action/final excerpts and record links from ${label} for diagnostics? Includes prompt text (1 KB), action descriptions (2 KB), final text (2 KB), edited paths and tool result metadata; incidental source may occur. No file-read bodies, patches, arbitrary shell output or hidden reasoning. Local queue: 1 MB/24 h; server retention: ${diagnosticPolicy.retentionDays ?? 90} days. Native hook review/trust remains required. [y/N] `,
					false,
				);
				if (answer !== null) {
					choice.diagnostics = false;
					diagnosticEnabled = false;
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
							diagnosticEnabled = true;
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
			if (diagnosticEnabled) choices.diagnosticClients.push(client);
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
	const { accepted, declined, graphClients, diagnosticClients, removeUnentitled } = decision;
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
			notices.push(
				...syncMemoryHooks({
					...options,
					clients,
					graphClients: cues,
					diagnosticClients,
					enable: true,
				}),
			);
	}
	return notices;
}

/**
 * At proxy start, give the identified Claude Code or Codex client the default
 * memory hooks without asking, as the installer would: the reminder and the
 * edit-time memory cue, added to installs from before the cue came with memory.
 * Leaves alone anyone who declined or ran --disable-memory-hooks, Claude Code with
 * disableAllHooks, and an edited or unreadable Pharaoh entry; keeps the structural
 * cues and diagnostics only where the user chose them before. Returns lines for
 * the user when it turned hooks on, or added a Codex hook that needs trusting.
 */
export function ensureMemoryHooks(info, credentials, options = {}) {
	const { home = homedir(), env = process.env, scope = memoryInstallScope() } = options;
	const client = nativeMemoryClient(info);
	if (!client || typeof process.getuid !== "function" || !hasMemoryGit) return [];
	if (grantLost(credentials)) return [];
	const choice = readHookPreferences(home)[client] ?? {};
	if (choice.memory === false) return [];
	let config;
	try {
		config = inspectSettings(userSettings(client, home, env, scope)).config;
	} catch {
		return [];
	}
	if (client === "claude-code" && config?.disableAllHooks === true) return [];
	const state = memoryHookStateForClient(info, { home, env, scope });
	const fresh = state === "absent";
	if (!fresh) {
		// "installed" is Pharaoh's exact entry; anything else may be the user's edit.
		if (state !== "installed") return [];
		const digest = packagedMemoryBundle(options.packageRoot).sha256;
		const current = readActiveMemoryClients(home, scope)[client];
		if (
			hasMemoryCueHook(config, scope) &&
			(choice.capture === false || hasCaptureHook(config, scope)) &&
			(!reviewEligible(client, choice, home, scope) || hasChangeReviewHooks(config, scope)) &&
			current === digest &&
			existsSync(bundledHook(join(memoryClientRoot(home), digest)))
		) {
			if (reviewEligible(client, choice, home, scope))
				return syncReceiptDisplay({
					home,
					env,
					scope,
					node: options.node ?? process.execPath,
					hook: bundledHook(join(memoryClientRoot(home), digest)),
					target: checkout(scope?.kind === "local" ? scope.root : (options.cwd ?? process.cwd())),
					packageRoot: options.packageRoot,
				});
			return [];
		}
	}
	const addsCue = !fresh && !hasMemoryCueHook(config, scope);
	const addsCapture = !fresh && choice.capture !== false && !hasCaptureHook(config, scope);
	// As at setup: a saved diagnostics choice never puts back handlers the user removed.
	const missingDiagnostics =
		choice.diagnostics === true &&
		(!readActiveMemoryClients(home, scope)[client] ||
			!hasUserHookMode(config, ["Stop"], "--diagnostics", scope));
	if (
		missingDiagnostics &&
		scope?.kind !== "local" &&
		!hasOtherActiveMemoryClient(client, home, scope)
	) {
		const { diagnostics: _removed, ...kept } = choice;
		writeHookPreferences({ ...readHookPreferences(home), [client]: kept }, home);
	}
	const graph = choice.graph === true && hasStructuralCueHooks(config, client, scope);
	const receiptNotices = [];
	syncHookInstallation(
		{
			...options,
			credentials,
			clients: [client],
			graphClients: graph ? [client] : [],
			diagnosticClients: missingDiagnostics ? [] : [client],
			enable: true,
		},
		receiptNotices,
	);
	if ((addsCue || addsCapture) && client === "codex") {
		// Announce only what the settings now show: a failed write is retried next start, silently.
		let added = false;
		try {
			const next = inspectSettings(userSettings(client, home, env, scope)).config;
			added =
				(addsCue && hasMemoryCueHook(next, scope)) || (addsCapture && hasCaptureHook(next, scope));
		} catch {
			// Unreadable settings: nothing to announce.
		}
		if (!added) return [];
		return [
			addsCapture
				? "Pharaoh added project memory hooks to Codex: after a turn that changed code and passed a check, your agent saves the fix and its reason to project memory. Review and trust them in /hooks or Settings > Hooks. To stop automatic saving, run `npx @pharaoh-so/mcp --disable-memory-capture`."
				: "Pharaoh added a project memory hook to Codex: when your agent edits a file, it shows what project memory says about that file. Review and trust it in /hooks or Settings > Hooks. To turn memory hooks off, run `npx @pharaoh-so/mcp --disable-memory-hooks`.",
		];
	}
	if (!fresh || memoryHookStateForClient(info, { home, env, scope }) !== "installed")
		return receiptNotices;
	const label = client === "codex" ? "Codex" : "Claude Code";
	return [
		...receiptNotices,
		`Pharaoh turned on project memory reminders in ${label}: from your next conversation, the agent is reminded to check past decisions for this repo. To turn them off, run \`npx @pharaoh-so/mcp --disable-memory-hooks\`.`,
		...(client === "codex"
			? [
					"Codex runs the reminder only after you review and trust it in /hooks or Settings > Hooks.",
				]
			: []),
	];
}

/** Keep an optional receipt display failure separate from the installed review and capture hooks. */
function syncReceiptDisplay(options) {
	try {
		syncChangeReviewPlugin(options);
		return [];
	} catch (error) {
		const scope = options.scope?.kind === "local" ? "this checkout" : "your Claude Code profile";
		const operation = options.hook
			? "install verified receipts"
			: "finish removing verified receipts";
		return [`Pharaoh: could not ${operation} for ${scope}. ${error.message}`];
	}
}

/** Run only during setup or explicit cleanup of the local memory hooks. */
export function syncMemoryHooks(options = {}) {
	const receiptNotices = [];
	return [...syncHookInstallation(options, receiptNotices), ...receiptNotices];
}

function syncHookInstallation(
	{
		credentials,
		clients = MEMORY_HOOK_CLIENTS,
		graphClients = [],
		diagnosticClients,
		enable = false,
		home = homedir(),
		env = process.env,
		cwd = process.cwd(),
		node = process.execPath,
		packageRoot,
		scope = memoryInstallScope(),
		preserveHandlers = false,
	},
	receiptNotices,
) {
	if (typeof process.getuid !== "function")
		return enable ? ["Pharaoh: project memory reminders need a POSIX client."] : [];
	const root = memoryClientRoot(home);
	const activePath = memoryActivePath(root, scope);
	let active = readActiveMemoryClients(home, scope);
	const target = checkout(scope?.kind === "local" ? scope.root : cwd);
	const notices = [];
	const configured = [];
	const preferences = readHookPreferences(home);

	let installed;
	let digest;
	const hint = projectMemoryHint(credentials);
	if (enable) {
		if (grantLost(credentials)) return ["Pharaoh: this session has no project memory hook grant."];
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
			(!enable ||
				preferences[client]?.memory === false ||
				preferences[client]?.diagnostics !== true) &&
			!hasOtherActiveMemoryClient(client, home, scope)
		)
			clearDiagnosticQueue(client, home);
		try {
			const review = reviewEligible(client, preferences[client], home, scope);
			if (client === "claude-code" && receiptNotices)
				receiptNotices.push(
					...syncReceiptDisplay({
						home,
						env,
						scope,
						node,
						hook: enable && review ? installed : undefined,
						target,
						packageRoot,
					}),
				);
			ensureLocalPrivatePaths(scope, [userSettings(client, home, env, scope)]);
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
					preferences[client]?.memory !== false &&
						preferences[client]?.diagnostics === true &&
						(diagnosticClients === undefined || diagnosticClients.includes(client)),
					preferences[client]?.capture !== false,
					scope,
					review,
					preserveHandlers,
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
		if (scope?.kind !== "local" && MEMORY_HOOK_CLIENTS.includes(client))
			migrateCheckout(client, target, notices);
	}
	return notices;
}

/**
 * Change review is an explicit local workflow, independent of capture and analytics.
 * It reuses an existing active Claude installation and never enables memory on its behalf.
 */
export function configureChangeReview(
	enabled,
	{
		credentials,
		home = homedir(),
		env = process.env,
		cwd = process.cwd(),
		scope = memoryInstallScope(),
		packageRoot,
	} = {},
) {
	const options = {
		credentials,
		home,
		env,
		cwd,
		scope,
		packageRoot,
		clients: ["claude-code"],
		enable: true,
		preserveHandlers: true,
	};
	if (!enabled) {
		setChangeReview(false, home, scope);
		// Optional display cleanup needs neither a current grant nor a working hook bundle.
		const removalNotices = syncReceiptDisplay({ home, env, scope });
		if (memoryHookStateForClient({ name: "claude-code" }, { home, env, scope }) !== "installed")
			return removalNotices;
		const choice = readHookPreferences(home)["claude-code"];
		return [
			...syncHookInstallation({
				...options,
				graphClients: choice?.graph === true ? ["claude-code"] : [],
			}),
			...removalNotices,
		];
	}
	const previous = changeReviewEnabled(home, scope);
	const choice = readHookPreferences(home)["claude-code"];
	const target = checkout(scope?.kind === "local" ? scope.root : cwd);
	if (
		choice?.memory === false ||
		choice?.graph === false ||
		!credentials?.access_token ||
		!(Date.parse(credentials.expires_at) > Date.now()) ||
		!target ||
		!matchingMemoryHint(target, projectMemoryHint(credentials)) ||
		memoryHookStateForClient({ name: "claude-code" }, { home, env, scope }) !== "installed"
	)
		throw new Error(
			"Run this in a mapped checkout with active, signed-in Claude Code memory hooks and structural hints enabled.",
		);
	setChangeReview(true, home, scope);
	try {
		const receiptNotices = [];
		const notices = syncHookInstallation(
			{
				...options,
				graphClients: choice?.graph === true ? ["claude-code"] : [],
			},
			receiptNotices,
		);
		const config = inspectSettings(userSettings("claude-code", home, env, scope)).config;
		if (notices.length || !hasChangeReviewHooks(config, scope))
			throw new Error(
				"Could not install the change review hooks. Existing choices were preserved.",
			);
		return receiptNotices;
	} catch (error) {
		setChangeReview(previous, home, scope);
		if (!previous)
			syncMemoryHooks({ ...options, graphClients: choice?.graph === true ? ["claude-code"] : [] });
		throw error;
	}
}

/** Use the same opt-in and decline rules for startup repair and actual hook registration. */
function reviewEligible(client, choice, home, scope) {
	return (
		client === "claude-code" &&
		choice?.memory !== false &&
		choice?.graph !== false &&
		changeReviewEnabled(home, scope)
	);
}
