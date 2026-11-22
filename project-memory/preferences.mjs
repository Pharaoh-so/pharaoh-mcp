import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateMemoryPath } from "./bundle.mjs";
import {
	MEMORY_HOOK_CLIENTS,
	memoryClientRoot,
	readActiveMemoryClients,
	readHookPreferences,
	readHookSettings,
} from "./client-settings.mjs";
import { hasUserHooks } from "./hook-config.mjs";
import { memoryInstallScope, memoryScopeKey, memorySettingsPath } from "./install-scope.mjs";
import { ANCHORED_MEMORY_FILE, atomicWrite, shellWord } from "./local.mjs";

export { MEMORY_HOOK_CLIENTS, readHookPreferences };
const FILE = "hook-preferences-v1.json";

export function writeHookPreferences(clients, home = homedir(), expected) {
	const previous = readHookPreferences(home);
	if (expected && JSON.stringify(expected) !== JSON.stringify(previous))
		throw new Error("Project memory preferences changed while setup was asking.");
	if (JSON.stringify(clients) === JSON.stringify(previous)) return;
	const root = memoryClientRoot(home);
	const path = join(root, FILE);
	if (Object.keys(clients).length === 0) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(root, { recursive: true, mode: 0o700 });
	privateMemoryPath(root, true);
	atomicWrite(path, `${JSON.stringify({ version: 1, clients })}\n`);
}

/** Read the separate opt-in for the selected installation; other hook choices grant no review authority. */
export function changeReviewEnabled(home = homedir(), scope = memoryInstallScope()) {
	const root = memoryClientRoot(home);
	const path = join(root, `change-review-${memoryScopeKey(scope) ?? "global"}.json`);
	try {
		privateMemoryPath(root, true);
		if (privateMemoryPath(path, false).size > 128)
			throw new Error("Change review choice is invalid.");
		const choice = JSON.parse(readFileSync(path, "utf8"));
		if (choice.version !== 1 || typeof choice.enabled !== "boolean")
			throw new Error("Change review choice is invalid.");
		return choice.enabled;
	} catch {
		// A malformed optional review choice disables review, never the established memory hooks.
		return false;
	}
}

/** Enable or disable review only for the chosen installation, without changing memory or diagnostics. */
export function setChangeReview(enabled, home = homedir(), scope = memoryInstallScope()) {
	const root = memoryClientRoot(home);
	const path = join(root, `change-review-${memoryScopeKey(scope) ?? "global"}.json`);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	privateMemoryPath(root, true);
	if (existsSync(path)) privateMemoryPath(path, false);
	if (enabled) atomicWrite(path, `${JSON.stringify({ version: 1, enabled: true })}\n`);
	else rmSync(path, { force: true });
}

/** Turn automatic capture on or off for every client; the hooks read it at each event. */
export function setMemoryCapture(enabled, home = homedir()) {
	// Off drops turn logs and saves not sent yet; the receipt stays for --undo-memory.
	if (!enabled) clearCaptureState(home, false);
	const choices = readHookPreferences(home);
	for (const client of MEMORY_HOOK_CLIENTS) {
		const { capture: _previous, ...choice } = choices[client] ?? {};
		if (!enabled) choices[client] = { ...choice, capture: false };
		else if (Object.keys(choice).length) choices[client] = choice;
		else delete choices[client];
	}
	writeHookPreferences(choices, home);
}

/** Remove automatic capture's local state: turn logs, unsent saves and, with `receipt`, the undo receipt. */
function clearCaptureState(home, receipt) {
	const directory = join(memoryClientRoot(home), "capture");
	for (const name of existsSync(directory) ? readdirSync(directory) : [])
		if (receipt || name !== "last.json")
			rmSync(join(directory, name), { force: true, recursive: true });
}

export function resetHookPreferences(disable, home = homedir()) {
	if (typeof process.getuid !== "function") return;
	// Sign-out, clean and disable all drop the locally kept memory records.
	clearCaptureState(home, true);
	const root = memoryClientRoot(home);
	for (const name of existsSync(root) ? readdirSync(root) : [])
		if (
			ANCHORED_MEMORY_FILE.test(name) ||
			/^change-review-(?:global|[a-f0-9]{64})\.json$/.test(name)
		)
			rmSync(join(root, name), { force: true });
	const reviewDirectory = join(root, "change-review");
	if (existsSync(reviewDirectory)) {
		privateMemoryPath(reviewDirectory, true);
		rmSync(reviewDirectory, { recursive: true, force: true });
	}
	const choices = readHookPreferences(home);
	for (const client of MEMORY_HOOK_CLIENTS) {
		const choice = choices[client];
		if (disable)
			choices[client] = {
				...choice,
				memory: false,
				graph: false,
				diagnostics: false,
				capture: false,
			};
		else if (choice) {
			if (choice.memory === true) delete choice.memory;
			if (choice.graph === true) delete choice.graph;
			if (Object.keys(choice).length === 0) delete choices[client];
		}
	}
	writeHookPreferences(choices, home);
	if (disable) {
		// Disable clears bounded content immediately, including loaded hook queues.
		for (const client of MEMORY_HOOK_CLIENTS) {
			try {
				const parent = join(memoryClientRoot(home), "diagnostics");
				const parentInfo = lstatSync(parent);
				if (
					parentInfo.isDirectory() &&
					parentInfo.uid === process.getuid?.() &&
					!(parentInfo.mode & 0o077)
				) {
					const path = join(parent, client);
					const info = lstatSync(path);
					if (info.isDirectory() && info.uid === process.getuid?.() && !(info.mode & 0o077))
						rmSync(path, { recursive: true, force: true });
				}
			} catch {
				/* An absent or linked queue is never followed. */
			}
			if (!choices[client]?.diagnosticsGeneration) continue;
			atomicWrite(
				join(memoryClientRoot(home), `diagnostics-revocation-${client}.json`),
				JSON.stringify({
					generation: choices[client].diagnosticsGeneration,
					policyVersion: choices[client].diagnosticsPolicyVersion,
				}),
			);
			const digest = readActiveMemoryClients(home)[client];
			const sender = digest
				? join(memoryClientRoot(home), digest, "diagnostics-sender.mjs")
				: fileURLToPath(new URL("diagnostics-sender.mjs", import.meta.url));
			const child = spawn(process.execPath, [sender, client, "--revoke"], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, HOME: home },
			});
			child.once("error", () => {});
			child.unref();
		}
	}
}

export function nativeMemoryClient(info) {
	const name = typeof info?.name === "string" ? info.name.toLowerCase() : "";
	return ["codex", "codex-mcp-client", "codex_cli_rs", "codex-desktop"].includes(name)
		? "codex"
		: ["claude-code", "claude-cli"].includes(name)
			? "claude-code"
			: undefined;
}

/** Configuration evidence only: native review, trust and execution remain unobserved. */
export function memoryHookStateForClient(
	info,
	{
		home = homedir(),
		env = process.env,
		platform = process.platform,
		scope = memoryInstallScope(),
	} = {},
) {
	if (typeof info?.name !== "string" || !info.name) return "unknown";
	const client = nativeMemoryClient(info);
	if (!client || platform === "win32" || typeof process.getuid !== "function") return "unsupported";
	try {
		if (readHookPreferences(home)[client]?.memory === false) return "declined";
		let settings = memorySettingsPath(client, home, env, scope);
		try {
			settings = realpathSync(settings);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const config = readHookSettings(settings);
		if (!config || typeof config !== "object" || Array.isArray(config)) return "unknown";
		if (client === "claude-code" && config.disableAllHooks === true) return "absent";
		if (
			config.hooks !== undefined &&
			(!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))
		)
			return "unknown";
		const groups = config.hooks?.UserPromptSubmit;
		if (
			groups !== undefined &&
			(!Array.isArray(groups) || groups.some((group) => !Array.isArray(group?.hooks)))
		)
			return "unknown";
		const reminder = { hooks: { UserPromptSubmit: groups } };
		if (!hasUserHooks(reminder, client, scope)) return "absent";
		const digest = readActiveMemoryClients(home, scope)[client];
		if (!digest) return "unknown";
		const runtime = join(realpathSync(memoryClientRoot(home)), digest);
		privateMemoryPath(runtime, true);
		const hook = join(runtime, "pharaoh-memory-hook.mjs");
		privateMemoryPath(hook, false);
		const invocation = [hook, client, "--user"].map(shellWord).join(" ");
		return groups.some(
			(group) =>
				group?.enabled !== false &&
				Array.isArray(group?.hooks) &&
				group.hooks.some(
					(entry) =>
						entry?.enabled !== false &&
						entry?.type === "command" &&
						typeof entry.command === "string" &&
						entry.command.includes(invocation) &&
						hasUserHooks({ hooks: { UserPromptSubmit: [{ hooks: [entry] }] } }, client, scope),
				),
		)
			? "installed"
			: "unknown";
	} catch {
		return "unknown";
	}
}

/** Consent metadata for the actual native initialize identity; unknown clients stay unknown. */
export function memoryDiagnosticsForClient(info, home = homedir(), scope = memoryInstallScope()) {
	const clientName = nativeMemoryClient(info);
	if (!clientName) return;
	try {
		const choice = readHookPreferences(home)[clientName];
		if (
			choice?.memory === false ||
			choice?.diagnostics !== true ||
			!choice.diagnosticsGeneration ||
			!choice.diagnosticsPolicyVersion ||
			!readActiveMemoryClients(home, scope)[clientName]
		)
			return;
		const version =
			typeof info?.version === "string" && /^[A-Za-z0-9._:/+ -]{1,120}$/.test(info.version)
				? info.version
				: null;
		return {
			clientName,
			generation: choice.diagnosticsGeneration,
			versions: {
				clientVersion: version,
				collectionPolicyVersion: choice.diagnosticsPolicyVersion,
				collectorVersion: "native-v1",
				capabilitySchemaVersion: "native-hooks-v1",
			},
		};
	} catch {
		return;
	}
}
