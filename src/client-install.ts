/** Client discovery and guarded updates for the persistent local proxy installer. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { ensureLocalPrivatePaths } from "../project-memory/install-scope.mjs";
import { shellWord } from "../project-memory/local.mjs";
import { nativeFeedRegistration, nativeFeedSettingsPath } from "../runtime/feed-hooks.mjs";
import { LAUNCHER_NAME, readPointer, usableVersion } from "../runtime/launcher-v1.mjs";
import { DEFAULT_SERVER } from "./helpers.js";
import { gitWorktreeRoot } from "./install-scope.js";
import type {
	ClientId,
	ClientInstallOptions,
	ClientOutcome,
	ClientTarget,
	InstallScope,
	LaunchConfig,
	LegacyMigration,
} from "./install-types.js";
import { isNewerVersion, PACKAGE_NAME } from "./version.js";

type Document = Record<string, unknown>;
interface Snapshot {
	text: string | null;
	identity: string | null;
}
interface Receipt {
	client: ClientId;
	path: string;
	entry: string;
	block?: string;
	scope?: InstallScope;
}
interface Provenance {
	version: 1;
	registrations: Record<string, Receipt>;
}

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const BLOCK_START = "# pharaoh-mcp managed registration\n";
const BLOCK_END = "# end pharaoh-mcp managed registration\n";
const RECOVERY = "npx @pharaoh-so/mcp@latest install --migrate-legacy";
/**
 * What an open Desktop lacks, and the way out. While it runs, it saves the settings it loaded
 * back over this change, and a restart then reads the reverted file: only a write made while
 * it's closed holds.
 */
const DESKTOP_OPEN = {
	created: "No Pharaoh until you quit it and run the install again.",
	updated: "Stays on an older Pharaoh until you quit it and run the install again.",
};
/** Claude Desktop's macOS bundle, which `osascript` asks to quit and `open` reopens. */
const DESKTOP_BUNDLE = "com.anthropic.claudefordesktop";
/** How long a restart waits for Desktop to close: it may ask the person to confirm. */
const DESKTOP_QUIT_MS = 30_000;

/** What the installer's and updater's summaries call each client. */
export const CLIENT_LABELS: Record<ClientId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	"claude-desktop": "Claude Desktop",
};

/** "Claude Code, Codex and Claude Desktop": the clients' names as a summary line lists them. */
export function listClients(outcomes: readonly { client: ClientId }[]): string {
	const names = outcomes.map((outcome) => CLIENT_LABELS[outcome.client]);
	return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

// Composed platform contract, rather than a scan of possibly stale package folders:
// Anthropic identifies its registered Windows app with Get-AppxPackage -Name Claude.
// Microsoft documents private AppData reads before the real APPDATA fallback and maps
// packaged APPDATA to Packages/<family>/LocalCache/Roaming. The current manifest can
// disable that mapping or exclude individual folders; only the two known whole-app
// policies are handled here. No package/customer scripts are loaded or executed.
// https://support.claude.com/en/articles/12622703-deploy-claude-desktop-for-windows
// https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization
// https://learn.microsoft.com/en-us/windows/msix/psf/create-shortcut-with-script-package-support-framework
const WINDOWS_CLAUDE_QUERY = `
$ErrorActionPreference = 'Stop'
$result = @(Get-AppxPackage -Name Claude -PackageTypeFilter Main | ForEach-Object {
  $package = $_
  $policy = 'unknown'
  try {
    $manifest = $package | Get-AppxPackageManifest
    $settings = @($manifest.SelectNodes("/*[local-name()='Package']/*[local-name()='Properties']/*[local-name()='FileSystemWriteVirtualization']"))
    if ($settings.Count -eq 0) { $policy = 'default' }
    elseif ($settings.Count -eq 1 -and $settings[0].NamespaceURI -eq 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/6' -and $settings[0].InnerText.Trim() -eq 'disabled') {
      $capabilities = @($manifest.SelectNodes("/*[local-name()='Package']/*[local-name()='Capabilities']/*[local-name()='Capability' and @Name='unvirtualizedResources']"))
      if ($capabilities.Count -eq 1 -and $capabilities[0].NamespaceURI -eq 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities') { $policy = 'disabled' }
    }
  } catch { $policy = 'unknown' }
  [pscustomobject]@{ Name = $package.Name; PackageFamilyName = $package.PackageFamilyName; Virtualization = $policy }
})
ConvertTo-Json -InputObject $result -Compress -Depth 3
`.trim();

// Both official ChatGPT Desktop Store packages retain this Codex package identity.
// The Windows app and native CLI share %USERPROFILE%\.codex.
// https://learn.chatgpt.com/docs/enterprise/windows-deployment
// https://learn.chatgpt.com/docs/windows/windows-app#share-config-auth-and-sessions-with-wsl
const WINDOWS_CODEX_PACKAGE = "OpenAI.Codex_2p2nqsd0c76g0";
const WINDOWS_CODEX_QUERY = `
$ErrorActionPreference = 'Stop'
$result = @(Get-AppxPackage -Name OpenAI.Codex -PackageTypeFilter Main | ForEach-Object {
  [pscustomobject]@{ Name = $_.Name; PackageFamilyName = $_.PackageFamilyName; SignatureKind = [string]$_.SignatureKind }
})
ConvertTo-Json -InputObject $result -Compress -Depth 3
`.trim();

class MissingRegistration extends Error {}

/** A command that ran and exited with `status`, which some commands use as their answer. */
class CommandExit extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

function object(value: unknown): value is Document {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function settings(options: ClientInstallOptions) {
	const home = resolve(options.home ?? homedir());
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	return { home, env, platform };
}

function execute(options: ClientInstallOptions, command: string, args: readonly string[]): string {
	const env = options.env ?? process.env;
	const cwd = options.scope?.kind === "local" ? options.scope.root : undefined;
	try {
		if (options.execute)
			return options.execute(command, args, { env, timeout: 30_000, ...(cwd ? { cwd } : {}) });
		return execFileSync(command, [...args], {
			env,
			timeout: 30_000,
			maxBuffer: MAX_CONFIG_BYTES,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
			...(cwd ? { cwd } : {}),
		});
	} catch (error) {
		const stderr = object(error) && "stderr" in error ? String(error.stderr) : "";
		if (
			args[0] === "mcp" &&
			args[1] === "get" &&
			stderr.includes("No MCP server named 'pharaoh' found.")
		)
			throw new MissingRegistration();
		const message =
			"The client command failed. Check that its CLI starts and can read its configuration.";
		// A status means it ran; none (a timeout, a signal, no such command) means it didn't.
		const status = object(error) && typeof error.status === "number" ? error.status : null;
		throw status === null ? new Error(message) : new CommandExit(message, status);
	}
}

function availableCli(options: ClientInstallOptions, command: string): boolean {
	return cliVersion(options, command) !== null;
}

function cliVersion(options: ClientInstallOptions, command: string): string | null {
	try {
		return execute(options, command, ["--version"]).match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
	} catch {
		return null;
	}
}

function configuredRoot(value: string | undefined, fallback: string): string {
	if (!value) return fallback;
	if (!isAbsolute(value)) throw new Error("The configured client directory must be absolute.");
	return resolve(value);
}

function desktopPath(options: ClientInstallOptions): string | null {
	const { home, env, platform } = settings(options);
	if (platform === "darwin")
		return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
	if (platform === "win32" && env.APPDATA && isAbsolute(env.APPDATA))
		return join(env.APPDATA, "Claude", "claude_desktop_config.json");
	// The MCP SDK follows XDG_CONFIG_HOME for the Linux desktop application.
	if (platform === "linux" && (!env.XDG_CONFIG_HOME || isAbsolute(env.XDG_CONFIG_HOME)))
		return join(
			env.XDG_CONFIG_HOME || join(home, ".config"),
			"Claude",
			"claude_desktop_config.json",
		);
	return null;
}

/** Inspect only regular directories below the provided platform configuration root. */
function safeDirectoryChain(root: string, names: readonly string[]): boolean {
	let path = root;
	for (const name of ["", ...names]) {
		if (name) path = join(path, name);
		const info = lstatSync(path, { throwIfNoEntry: false });
		if (!info) return false;
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error("The platform configuration path is not a regular directory.");
	}
	return true;
}

function windowsAppPackages(options: ClientInstallOptions, query: string): unknown[] {
	const { env } = settings(options);
	const systemRoot = env.SystemRoot || env.SYSTEMROOT;
	if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows PowerShell is unavailable.");
	const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	if (!safeDirectoryChain(systemRoot, ["System32", "WindowsPowerShell", "v1.0"]))
		throw new Error("Windows PowerShell is unavailable.");
	const executable = lstatSync(powershell, { throwIfNoEntry: false });
	if (!executable?.isFile() || executable.isSymbolicLink())
		throw new Error("Windows PowerShell is unavailable.");
	const raw: unknown = JSON.parse(
		execute(options, powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query]),
	);
	if (!Array.isArray(raw)) throw new Error("The package result is malformed.");
	return raw;
}

function windowsClaudePath(
	options: ClientInstallOptions,
	fallback: string | null,
	packageEvidence: boolean,
): { path: string | null; installed: boolean; ambiguousReason?: string } {
	const { env, home } = settings(options);
	const unknown = {
		path: fallback ?? join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
		installed: packageEvidence,
		ambiguousReason:
			"The active Windows Claude Desktop configuration could not be verified. Its package registration or virtualization policy needs attention.",
	};
	let installed = packageEvidence;
	try {
		const raw = windowsAppPackages(options, WINDOWS_CLAUDE_QUERY);
		if (!raw.length) return { path: fallback, installed: false };
		installed = true;
		if (raw.length !== 1) return { ...unknown, installed: true };
		const item: unknown = raw[0];
		if (
			!object(item) ||
			item.Name !== "Claude" ||
			typeof item.PackageFamilyName !== "string" ||
			!/^Claude_[a-z0-9]{13}$/i.test(item.PackageFamilyName) ||
			(item.Virtualization !== "default" && item.Virtualization !== "disabled") ||
			!fallback
		)
			return { ...unknown, installed: true };
		if (item.Virtualization === "disabled") return { path: fallback, installed: true };
		if (!env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)) return { ...unknown, installed: true };
		const names = ["Packages", item.PackageFamilyName, "LocalCache", "Roaming", "Claude"];
		if (safeDirectoryChain(env.LOCALAPPDATA, names)) {
			const path = join(env.LOCALAPPDATA, ...names, "claude_desktop_config.json");
			const privateFile = lstatSync(path, { throwIfNoEntry: false });
			if (privateFile) {
				if (
					!privateFile.isFile() ||
					privateFile.isSymbolicLink() ||
					privateFile.size > MAX_CONFIG_BYTES
				)
					return { ...unknown, installed: true };
				return { path, installed: true };
			}
		}
		return { path: fallback, installed: true };
	} catch {
		// Native errors or package output can contain private paths; never echo them.
		return installed ? { ...unknown, installed: true } : { path: fallback, installed: false };
	}
}

function packagedApp(options: ClientInstallOptions, matches: (entry: string) => boolean): boolean {
	const { env, platform } = settings(options);
	if (platform !== "win32" || !env.LOCALAPPDATA) return false;
	const packages = join(env.LOCALAPPDATA, "Packages");
	if (!existsSync(packages)) return false;
	try {
		return readdirSync(packages).some(matches);
	} catch {
		return true;
	}
}

function windowsCodexPackage(options: ClientInstallOptions): "verified" | "ambiguous" | undefined {
	try {
		const registrations = windowsAppPackages(options, WINDOWS_CODEX_QUERY);
		if (!registrations.length) return;
		const record = registrations[0];
		return registrations.length === 1 &&
			object(record) &&
			record.Name === "OpenAI.Codex" &&
			record.PackageFamilyName === WINDOWS_CODEX_PACKAGE &&
			record.SignatureKind === "Store"
			? "verified"
			: "ambiguous";
	} catch {
		// A package data directory alone does not establish an active installation.
		return packagedApp(
			options,
			(entry) => entry.toLowerCase() === WINDOWS_CODEX_PACKAGE.toLowerCase(),
		)
			? "ambiguous"
			: undefined;
	}
}

function macApp(home: string, name: string, contents = ""): boolean {
	const location = join(`${name}.app`, contents);
	return (
		(home === homedir() && existsSync(join("/Applications", location))) ||
		existsSync(join(home, "Applications", location))
	);
}

function windowsApp(env: NodeJS.ProcessEnv, name: string): boolean {
	return Boolean(
		env.LOCALAPPDATA && existsSync(join(env.LOCALAPPDATA, "Programs", name, `${name}.exe`)),
	);
}

/** Find existing local clients without creating their configuration directories. */
export function discoverClients(options: ClientInstallOptions = {}): ClientTarget[] {
	const { home, env, platform } = settings(options);
	const targets: ClientTarget[] = [];
	const claudeVersion = cliVersion(options, "claude");
	const codexVersion = cliVersion(options, "codex");
	const claudeCli = claudeVersion !== null;
	const codexCli = codexVersion !== null;
	const packagedClaudeEvidence = packagedApp(options, (entry) => /claude|anthropic/i.test(entry));
	const windowsClaude =
		platform === "win32"
			? windowsClaudePath(options, desktopPath(options), packagedClaudeEvidence)
			: undefined;
	const chatPath = windowsClaude?.path ?? desktopPath(options);
	const invalidClaudeRoot = Boolean(env.CLAUDE_CONFIG_DIR && !isAbsolute(env.CLAUDE_CONFIG_DIR));
	const invalidCodexRoot = Boolean(env.CODEX_HOME && !isAbsolute(env.CODEX_HOME));
	const claudeRoot = configuredRoot(
		invalidClaudeRoot ? undefined : env.CLAUDE_CONFIG_DIR,
		join(home, ".claude"),
	);
	const codePath = env.CLAUDE_CONFIG_DIR
		? join(claudeRoot, ".claude.json")
		: join(home, ".claude.json");
	const codexRoot = configuredRoot(
		invalidCodexRoot ? undefined : env.CODEX_HOME,
		join(home, ".codex"),
	);
	const claudeDesktop =
		platform === "darwin"
			? macApp(home, "Claude")
			: platform === "win32"
				? windowsApp(env, "Claude") || windowsClaude?.installed === true
				: platform === "linux" && Boolean(chatPath && existsSync(dirname(chatPath)));
	// Current ChatGPT Desktop bundles the Codex host and uses the shared Codex config.
	const codexDesktop =
		platform === "darwin"
			? macApp(home, "Codex") ||
				macApp(home, "ChatGPT", "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")
			: platform === "win32" && windowsApp(env, "Codex");
	const packagedClaude = windowsClaude?.installed === true;
	const existingCodex = codexCli || existsSync(codexRoot) || codexDesktop;
	const packagedCodex =
		platform === "win32" && !existingCodex && !invalidCodexRoot
			? windowsCodexPackage(options)
			: undefined;

	if (chatPath && (claudeDesktop || packagedClaude || existsSync(dirname(chatPath)))) {
		targets.push({
			client: "claude-desktop",
			path: chatPath,
			...(windowsClaude?.ambiguousReason
				? {
						ambiguousReason: windowsClaude.ambiguousReason,
					}
				: {}),
		});
	}
	if (
		claudeCli ||
		existsSync(codePath) ||
		existsSync(claudeRoot) ||
		claudeDesktop ||
		invalidClaudeRoot
	) {
		targets.push({
			client: "claude-code",
			path: codePath,
			...(claudeVersion ? { cli: "claude", version: claudeVersion } : {}),
			...(chatPath ? { shadowPath: chatPath } : {}),
			...(invalidClaudeRoot
				? {
						ambiguousReason: "CLAUDE_CONFIG_DIR must identify an absolute configuration directory.",
					}
				: {}),
		});
	}
	if (existingCodex || packagedCodex || invalidCodexRoot) {
		targets.push({
			client: "codex",
			path: join(codexRoot, "config.toml"),
			...(codexVersion ? { cli: "codex", version: codexVersion } : {}),
			...(invalidCodexRoot
				? { ambiguousReason: "CODEX_HOME must identify an absolute configuration directory." }
				: packagedCodex === "ambiguous"
					? {
							ambiguousReason:
								"The packaged Codex app's configuration directory could not be verified.",
						}
					: {}),
		});
	}
	return targets;
}

/** Open a regular configuration file without following a replaced symlink. */
function snapshot(path: string): Snapshot {
	let fd: number;
	try {
		const before = lstatSync(path);
		if (!before.isFile() || before.isSymbolicLink())
			throw new Error("The configuration is not a regular file.");
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: null, identity: null };
		throw new Error("The configuration could not be read safely.");
	}
	try {
		const stat = fstatSync(fd);
		const current = lstatSync(path);
		if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES)
			throw new Error("The configuration must be a regular file smaller than 4 MiB.");
		if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino)
			throw new Error("The configuration changed while it was being read.");
		return {
			text: readFileSync(fd, "utf8"),
			identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
		};
	} finally {
		closeSync(fd);
	}
}

function unchanged(path: string, before: Snapshot): boolean {
	const current = snapshot(path);
	return current.text === before.text && current.identity === before.identity;
}

function json(text: string | null): Document {
	try {
		const parsed: unknown = text === null ? {} : JSON.parse(text);
		if (object(parsed)) return parsed;
	} catch {
		// Parser diagnostics can include a configuration value, including credentials.
	}
	throw new Error("The client configuration must contain a valid JSON object.");
}

function toml(text: string | null): Document {
	try {
		return parseToml(text ?? "") as Document;
	} catch {
		throw new Error("The Codex configuration could not be parsed as TOML.");
	}
}

function entries(document: Document, client: ClientId): Document {
	const key = client === "codex" ? "mcp_servers" : "mcpServers";
	const value = document[key];
	if (value === undefined) return {};
	if (!object(value)) throw new Error("The MCP server configuration is malformed.");
	return value;
}

function entry(document: Document, client: ClientId): unknown {
	return entries(document, client).pharaoh;
}

/** The portion of Claude's shared JSON belonging to one explicitly selected checkout. */
function targetDocument(document: Document, target: ClientTarget, create = false): Document {
	if (target.client !== "claude-code" || target.scope?.kind !== "local") return document;
	if (document.projects !== undefined && !object(document.projects))
		throw new Error("The Claude project configuration is malformed.");
	const projects = object(document.projects) ? document.projects : {};
	const value = projects[target.scope.root];
	if (value !== undefined && !object(value))
		throw new Error("The Claude project entry is malformed.");
	const project = object(value) ? value : {};
	if (create) {
		projects[target.scope.root] = project;
		document.projects = projects;
	}
	return project;
}

function targetEntry(document: Document, target: ClientTarget): unknown {
	return entry(targetDocument(document, target), target.client);
}

function trackedProjectSettings(target: ClientTarget): boolean {
	if (target.scope?.kind !== "local" || target.client !== "codex" || !existsSync(target.path))
		return false;
	try {
		execFileSync(
			"git",
			[
				"--no-optional-locks",
				"--no-replace-objects",
				"-c",
				"core.fsmonitor=false",
				"-C",
				target.scope.root,
				"ls-files",
				"--error-unmatch",
				"--",
				relative(target.scope.root, target.path),
			],
			{
				env: {
					...Object.fromEntries(
						Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
					),
					GIT_NO_LAZY_FETCH: "1",
					GIT_ALLOW_PROTOCOL: "",
				},
				timeout: 5_000,
				maxBuffer: 16_384,
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
		return true;
	} catch (error) {
		if ((error as { status?: number }).status === 1) return false;
		throw new Error("The project settings could not be checked for tracked files.");
	}
}

function targetUnrelated(document: Document, target: ClientTarget): string {
	if (target.client !== "claude-code" || target.scope?.kind !== "local")
		return unrelated(document, target.client);
	const copy = structuredClone(document);
	const project = targetDocument(copy, target);
	if (object(project.mcpServers)) {
		delete project.mcpServers.pharaoh;
		if (!Object.keys(project.mcpServers).length) delete project.mcpServers;
	}
	if (!Object.keys(project).length && object(copy.projects)) {
		delete copy.projects[target.scope.root];
		if (!Object.keys(copy.projects).length) delete copy.projects;
	}
	return canonical(copy);
}

/** Bind discovered clients to the selected checkout without changing shared client discovery. */
export function scopeInstallTargets(
	targets: readonly ClientTarget[],
	scope: InstallScope,
): ClientTarget[] {
	if (scope.kind === "global") return targets.map((target) => ({ ...target, scope }));
	return targets.map((target) => ({
		...target,
		scope,
		...(target.client === "codex" ? { path: join(scope.root, ".codex", "config.toml") } : {}),
		...(target.client === "claude-desktop"
			? { unavailableReason: "Claude Desktop does not support checkout-local installation." }
			: !target.cli
				? { unavailableReason: "Local installation requires this client's CLI." }
				: target.client === "codex" &&
						(!target.version ||
							(target.version !== "0.166.0" && !isNewerVersion(target.version, "0.166.0")))
					? {
							unavailableReason:
								"Local installation requires Codex CLI 0.166.0 or newer for project hooks.",
						}
					: {}),
	}));
}

function disabled(document: Document, value: unknown): boolean {
	return (
		(object(value) && (value.enabled === false || value.disabled === true)) ||
		(Array.isArray(document.disabledMcpServers) && document.disabledMcpServers.includes("pharaoh"))
	);
}

function legacy(value: unknown): value is LaunchConfig {
	return (
		object(value) &&
		value.command === "npx" &&
		Array.isArray(value.args) &&
		value.args.length === 1 &&
		typeof value.args[0] === "string" &&
		/^@pharaoh-so\/mcp@\d+\.\d+\.\d+$/.test(value.args[0]) &&
		Object.keys(value).every(
			(key) => key === "command" || key === "args" || (key === "type" && value.type === "stdio"),
		)
	);
}

/** The runtimes folder and version of an exact-version entry: <root>/<x.y.z>/node_modules/@pharaoh-so/mcp/dist/index.js. */
function versionEntry(entry: string): { root: string; version: string } | undefined {
	const versionDir = dirname(dirname(dirname(dirname(dirname(entry)))));
	const version = basename(versionDir);
	const root = dirname(versionDir);
	return /^\d+\.\d+\.\d+$/.test(version) &&
		entry === join(root, version, "node_modules", PACKAGE_NAME, "dist", "index.js")
		? { root, version }
		: undefined;
}

/**
 * A registration that runs one of install's own exact-version runtimes from the runtimes
 * folder `launch` runs from, through Node, with `launch`'s server arguments and nothing
 * added. Only install writes into that folder, so the entry is install's even when its
 * receipt is missing (a check after `codex mcp add` failed, say). Left alone, it never
 * updates. Node may have moved since (another nvm version), but a wrapper stays the user's.
 */
function managedPin(value: unknown, launch: LaunchConfig): boolean {
	if (
		!persistentLaunch(value) ||
		Object.keys(value).some((key) => key !== "command" && key !== "args") ||
		basename(value.command) !== basename(launch.command)
	)
		return false;
	const actual = proxyLaunchOptions(value.args);
	const wanted = proxyLaunchOptions(launch.args);
	if (!actual || !wanted) return false;
	const target = launch.args[0];
	const root = basename(target) === LAUNCHER_NAME ? dirname(target) : versionEntry(target)?.root;
	return (
		root !== undefined &&
		versionEntry(value.args[0])?.root === root &&
		canonical(actual.baseArgs.slice(1)) === canonical(wanted.baseArgs.slice(1))
	);
}

/** Whether install may replace the current entry: none yet, its receipt, a consented legacy pin or a managed pin. */
function replaceable(
	current: unknown,
	receipt: Receipt | undefined,
	launch: LaunchConfig,
	options: { migrateLegacy?: boolean },
): boolean {
	return (
		current === undefined ||
		receipt !== undefined ||
		(options.migrateLegacy === true && legacy(current)) ||
		managedPin(current, launch)
	);
}

/**
 * Claude Desktop's process IDs (macOS); none when it's closed. An open Desktop writes the
 * settings it loaded at launch back over its config file, `mcpServers` included, so a
 * registration changed meanwhile reverts at its next save (seen in Desktop's "Config file
 * written" log minutes after each install). `-a`: install often runs in Desktop's own
 * terminal, and pgrep otherwise skips its ancestors.
 * @returns The IDs; none when it's closed; null when pgrep couldn't tell (it failed or timed out).
 */
function desktopPids(options: ClientInstallOptions): number[] | null {
	if (settings(options).platform !== "darwin") return [];
	try {
		return execute(options, "/usr/bin/pgrep", ["-a", "-x", "Claude"])
			.split("\n")
			.filter((line) => /^\d+$/.test(line.trim()))
			.map(Number);
	} catch (error) {
		// pgrep exits 1 when nothing matches: closed. Any other failure says nothing either way.
		return error instanceof CommandExit && error.status === 1 ? [] : null;
	}
}

function parse(target: ClientTarget, contents: string | null): Document {
	return target.client === "codex" ? toml(contents) : json(contents);
}

/** List only enabled plain NPX registrations eligible for explicit migration consent. */
export function legacyMigrations(
	targets: readonly ClientTarget[],
	_options: ClientInstallOptions = {},
): LegacyMigration[] {
	return targets.flatMap((target) => {
		if (target.ambiguousReason || target.unavailableReason) return [];
		try {
			const document = targetDocument(parse(target, snapshot(target.path).text), target);
			const value = entry(document, target.client);
			return !disabled(document, value) && legacy(value)
				? [
						{
							client: target.client,
							path: target.path,
							launch: { command: value.command, args: [...value.args] },
						},
					]
				: [];
		} catch {
			return [];
		}
	});
}

/** Read-only preflight before asking the device grant for enrollment tickets. */
export function freshRuntimeClients(
	targets: readonly ClientTarget[],
	options: ClientInstallOptions = {},
): Array<"claude-code" | "codex"> {
	const { platform } = settings(options);
	if (platform !== "darwin" && platform !== "linux") return [];
	const records = Object.values(readProvenance(options).data.registrations);
	return (options.scope ? scopeInstallTargets(targets, options.scope) : targets).flatMap(
		(target) => {
			const { client } = target;
			if (client === "claude-desktop" || target.unavailableReason || target.ambiguousReason)
				return [];
			try {
				const document = targetDocument(parse(target, snapshot(target.path).text), target);
				if (
					entry(document, client) !== undefined ||
					disabled(document, undefined) ||
					records.some(
						(record) =>
							record?.client === client &&
							record.path === resolve(target.path) &&
							(record.scope?.kind === "local" ? record.scope.root : undefined) ===
								(target.scope?.kind === "local" ? target.scope.root : undefined),
					)
				)
					return [];
				if (
					client === "claude-code" &&
					target.scope?.kind !== "local" &&
					projectOverrides(document)
				)
					return [];
				return [client];
			} catch {
				// Unreadable or ambiguous local settings cannot authorize automatic enrollment.
				return [];
			}
		},
	);
}

function provenancePath(options: ClientInstallOptions): string {
	return join(settings(options).home, ".pharaoh", "client-installations.json");
}

function readProvenance(options: ClientInstallOptions): { before: Snapshot; data: Provenance } {
	const before = snapshot(provenancePath(options));
	if (before.text === null) return { before, data: { version: 1, registrations: {} } };
	const data: unknown = json(before.text);
	if (!object(data) || data.version !== 1 || !object(data.registrations))
		throw new Error("The private installation record is malformed.");
	return { before, data: data as unknown as Provenance };
}

/** Known checkout roots, retained so cleanup and overlap checks cover inactive registrations too. */
export function recordedLocalRoots(options: ClientInstallOptions = {}): string[] {
	return [
		...new Set(
			Object.values(readProvenance(options).data.registrations).flatMap((receipt) =>
				receipt.scope?.kind === "local" ? [receipt.scope.root] : [],
			),
		),
	];
}

function globalTarget(target: ClientTarget, options: ClientInstallOptions): ClientTarget {
	const { home, env } = settings(options);
	return {
		...target,
		scope: { kind: "global" },
		path:
			target.client === "codex"
				? join(configuredRoot(env.CODEX_HOME, join(home, ".codex")), "config.toml")
				: target.path,
	};
}

function localCleanupRecovery(
	target: ClientTarget & { scope: { kind: "local"; root: string } },
): string {
	if (gitWorktreeRoot(target.scope.root) === target.scope.root)
		return `npx @pharaoh-so/mcp@latest cleanup --client ${target.client} --scope local --path ${shellWord(target.scope.root)}`;
	const project =
		target.client === "claude-code" ? ` (project key ${JSON.stringify(target.scope.root)})` : "";
	return `The recorded checkout is missing or no longer a Git root: ${target.scope.root}. Remove only its Pharaoh registration from ${target.path}${project}, then retry Global setup.`;
}

/** Read-only overlap check; custom and owned activation both require explicit cleanup first. */
export function preflightInstallScope(
	targets: readonly ClientTarget[],
	options: ClientInstallOptions = {},
): ClientOutcome[] {
	const scope = options.scope ?? { kind: "global" };
	const data = readProvenance(options).data;
	return targets.flatMap((candidate) => {
		try {
			if (trackedProjectSettings(candidate))
				return [
					result(
						candidate,
						"ambiguous",
						"Local setup preserves tracked Codex configuration. Use Global or an untracked project config.",
					),
				];
			const global = globalTarget(candidate, options);
			if (scope.kind === "local") {
				const globalDocument = parse(global, snapshot(global.path).text);
				const value = entry(globalDocument, global.client);
				if (value === undefined || disabled(globalDocument, value)) return [];
				const managed = owned(global, value, data) !== undefined;
				return [
					result(
						candidate,
						"ambiguous",
						"Global Pharaoh activation is still enabled. Local setup made no changes.",
						managed
							? `npx @pharaoh-so/mcp@latest cleanup --client ${candidate.client} --scope global`
							: "Remove or disable the existing global Pharaoh registration, then retry Local setup.",
					),
				];
			}
			const localTargets = Object.values(data.registrations).flatMap((receipt) =>
				receipt.client === candidate.client && receipt.scope?.kind === "local"
					? [
							{
								client: receipt.client,
								path: receipt.path,
								scope: receipt.scope,
							} satisfies ClientTarget,
						]
					: [],
			);
			if (candidate.client === "claude-code") {
				let globalDocument: Document;
				try {
					globalDocument = parse(global, snapshot(global.path).text);
				} catch {
					// This client's guarded writer will report its malformed configuration
					// without changing it. Other Global clients can still be installed.
					return [];
				}
				if (object(globalDocument.projects))
					for (const root of Object.keys(globalDocument.projects))
						localTargets.push({ ...global, scope: { kind: "local", root } });
			}
			for (const local of localTargets) {
				const document = parse(local, snapshot(local.path).text);
				const selected = targetDocument(document, local);
				const value = entry(selected, local.client);
				if (value === undefined || disabled(selected, value)) continue;
				const managed = owned(local, value, data) !== undefined;
				return [
					result(
						candidate,
						"ambiguous",
						"A Local Pharaoh installation would overlap this Global setup. No changes were made.",
						managed && local.scope?.kind === "local"
							? localCleanupRecovery({ ...local, scope: local.scope })
							: "Remove or disable the existing Local Pharaoh registration, then retry Global setup.",
					),
				];
			}
			return [];
		} catch {
			return [
				result(
					candidate,
					"ambiguous",
					"Existing activation could not be checked safely. Review the client configuration before changing scope.",
				),
			];
		}
	});
}

function receiptKey(target: ClientTarget, value: unknown): string {
	return createHash("sha256")
		.update(
			`${target.client}\0${resolve(target.path)}\0${JSON.stringify(value)}${target.scope?.kind === "local" ? `\0local\0${target.scope.root}` : ""}`,
		)
		.digest("hex");
}

function owned(target: ClientTarget, value: unknown, data: Provenance): Receipt | undefined {
	const receipt = data.registrations[receiptKey(target, value)];
	return receipt?.client === target.client &&
		receipt.path === resolve(target.path) &&
		receipt.entry === JSON.stringify(value)
		? receipt
		: undefined;
}

/** Replace a validated file only while its read version remains current. */
function atomicReplace(path: string, before: Snapshot, next: string, scope?: InstallScope): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory())
		throw new Error("The configuration directory is not a regular directory.");
	const temporary = join(parent, `.pharaoh-${randomUUID()}.tmp`);
	ensureLocalPrivatePaths(scope, [path, temporary]);
	try {
		const fd = openSync(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeFileSync(fd, next, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (!unchanged(path, before))
			throw new Error("The configuration changed during installation. Run install again.");
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function remember(
	target: ClientTarget,
	value: unknown,
	options: ClientInstallOptions,
	block?: string,
): void {
	const { before, data } = readProvenance(options);
	const path = provenancePath(options);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	data.registrations[receiptKey(target, value)] = {
		client: target.client,
		path: resolve(target.path),
		entry: JSON.stringify(value),
		...(block ? { block } : {}),
		...(target.scope?.kind === "local" ? { scope: target.scope } : {}),
	};
	atomicReplace(path, before, `${JSON.stringify(data, null, "\t")}\n`);
}

function result(
	target: ClientTarget,
	status: ClientOutcome["status"],
	detail?: string,
	recovery?: string,
	created = false,
): ClientOutcome {
	return {
		client: target.client,
		path: target.path,
		status,
		...(created ? { created: true } : {}),
		...(detail ? { detail } : {}),
		...(recovery ? { recovery } : {}),
	};
}

function canonical(value: unknown): string {
	if (value instanceof Date) return `date:${value.toISOString()}`;
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (object(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "undefined";
}

function unrelated(document: Document, client: ClientId): string {
	const copy = structuredClone(document);
	const key = client === "codex" ? "mcp_servers" : "mcpServers";
	if (object(copy[key])) {
		delete copy[key].pharaoh;
		if (!Object.keys(copy[key]).length) delete copy[key];
	}
	return canonical(copy);
}

function desktopPrecedence(
	target: ClientTarget,
	launch: LaunchConfig,
	options: ClientInstallOptions,
): string | undefined {
	if (!target.shadowPath || !existsSync(target.shadowPath)) return;
	const shadow: ClientTarget = { client: "claude-desktop", path: target.shadowPath };
	try {
		const document = json(snapshot(shadow.path).text);
		const value = entry(document, shadow.client);
		if (disabled(document, value))
			return "Desktop Code keeps its disabled Desktop registration. The Claude Code CLI uses this user registration.";
		if (value === undefined) return;
		const data = readProvenance(options).data;
		if (!owned(shadow, value, data))
			return "Desktop Code uses its retained custom Desktop registration. The Claude Code CLI uses this user registration.";
		if (canonical(value) !== canonical(launch))
			return "Desktop Code may use its previous Desktop registration; review the separate Desktop installation result.";
	} catch {
		return "Desktop Code could not be verified; review the separate Desktop installation result.";
	}
}

function projectOverrides(document: Document, currentRoot?: string): string | undefined {
	if (!object(document.projects)) return;
	const retained = Object.entries(document.projects).some(
		([root, project]) =>
			(!currentRoot || (isAbsolute(root) && withinProject(root, currentRoot))) &&
			object(project) &&
			(disabled(project, undefined) ||
				(object(project.mcpServers) && project.mcpServers.pharaoh !== undefined)),
	);
	return retained
		? "The user registration is configured. Project-specific connections and disabled choices were kept."
		: undefined;
}

function withinProject(root: string, cwd: string): boolean {
	// Match the active checkout (including subdirectories), never a sibling's override.
	const canonical = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	const path = relative(canonical(root), canonical(cwd));
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function configureJson(
	target: ClientTarget,
	launch: LaunchConfig,
	options: ClientInstallOptions & { migrateLegacy?: boolean },
): ClientOutcome {
	const before = snapshot(target.path);
	const document = json(before.text);
	const selected = targetDocument(document, target);
	const current = entry(selected, target.client);
	if (disabled(selected, current))
		return result(target, "preserved-disabled", "The disabled registration was kept.");
	const receipt = owned(target, current, readProvenance(options).data);
	if (!replaceable(current, receipt, launch, options) && !adoptableLocal(target, current, launch))
		return result(
			target,
			"preserved-custom",
			"The existing registration was kept.",
			legacy(current) ? RECOVERY : undefined,
		);
	const notes =
		target.scope?.kind === "local"
			? []
			: [projectOverrides(document), desktopPrecedence(target, launch, options)];
	if (current !== undefined && canonical(current) === canonical(launch)) {
		if (target.scope?.kind === "local" && !receipt) remember(target, current, options);
		return result(target, "already-configured", notes.filter(Boolean).join(" "));
	}
	// A pgrep that couldn't tell adds no note: the install can't say Desktop is open.
	const desktopOpen = target.client === "claude-desktop" && (desktopPids(options)?.length ?? 0) > 0;
	if (desktopOpen) notes.push(current === undefined ? DESKTOP_OPEN.created : DESKTOP_OPEN.updated);
	const detail = notes.filter(Boolean).join(" ");
	const destination = targetDocument(document, target, true);
	const servers = entries(destination, target.client);
	servers.pharaoh = { command: launch.command, args: [...launch.args] };
	destination.mcpServers = servers;
	const next = `${JSON.stringify(document, null, "\t")}\n`;
	const verified = json(next);
	if (targetUnrelated(verified, target) !== targetUnrelated(parse(target, before.text), target))
		throw new Error("The configuration update changed unrelated settings.");
	remember(target, servers.pharaoh, options);
	atomicReplace(target.path, before, next);
	const outcome = result(target, "configured", detail, undefined, current === undefined);
	return desktopOpen ? { ...outcome, desktopOpen: true } : outcome;
}

/** Explicit Local install may adopt the same plain stable launcher, with no custom arguments. */
function adoptableLocal(target: ClientTarget, current: unknown, launch: LaunchConfig): boolean {
	if (target.scope?.kind !== "local" || !persistentLaunch(current)) return false;
	if (
		Object.keys(current).some(
			(key) =>
				key !== "command" &&
				key !== "args" &&
				!(key === "type" && "type" in current && current.type === "stdio"),
		)
	)
		return false;
	const scopeIndex = launch.args.indexOf("--install-scope");
	const base = scopeIndex < 0 ? launch.args : launch.args.slice(0, scopeIndex);
	return (
		basename(base[0] ?? "") === LAUNCHER_NAME &&
		current.command === launch.command &&
		(canonical(current.args) === canonical(base) ||
			canonical(current.args) === canonical(launch.args))
	);
}

function tomlBlock(launch: LaunchConfig): string {
	return `${BLOCK_START}[mcp_servers.pharaoh]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n${BLOCK_END}`;
}

function readCodex(target: ClientTarget, options: ClientInstallOptions): Document | null {
	try {
		return json(execute(options, target.cli ?? "codex", ["mcp", "get", "pharaoh", "--json"]));
	} catch (error) {
		if (error instanceof MissingRegistration) return null;
		throw error;
	}
}

function cliLaunch(raw: Document): Document | null {
	if (!object(raw.transport) || raw.transport.type !== "stdio") return null;
	const transport = raw.transport;
	if (transport.env && Object.keys(transport.env as object).length) return null;
	if (Array.isArray(transport.env_vars) && transport.env_vars.length) return null;
	if (transport.cwd) return null;
	return { command: transport.command, args: transport.args };
}

function configureCodex(
	target: ClientTarget,
	launch: LaunchConfig,
	options: ClientInstallOptions & { migrateLegacy?: boolean },
): ClientOutcome {
	if (trackedProjectSettings(target))
		return result(target, "preserved-custom", "The tracked Codex project configuration was kept.");
	const before = snapshot(target.path);
	const document = toml(before.text);
	const current = entry(document, target.client);
	if (disabled(document, current))
		return result(target, "preserved-disabled", "The disabled Codex registration was kept.");
	const receipt = owned(target, current, readProvenance(options).data);
	if (!replaceable(current, receipt, launch, options) && !adoptableLocal(target, current, launch))
		return result(
			target,
			"preserved-custom",
			"The existing Codex registration was kept.",
			legacy(current) ? RECOVERY : undefined,
		);
	if (target.cli && target.scope?.kind !== "local") {
		const effective = readCodex(target, options);
		if (effective?.enabled === false)
			return result(target, "preserved-disabled", "The effective Codex registration is disabled.");
		if (
			effective &&
			(current === undefined || canonical(cliLaunch(effective)) !== canonical(current))
		)
			return result(
				target,
				"preserved-custom",
				"A project or custom Codex registration takes precedence over this user configuration.",
			);
		if (current !== undefined && !effective)
			return result(
				target,
				"ambiguous",
				"The Codex CLI did not find the registration in the selected configuration directory.",
			);
		if (current !== undefined && canonical(current) === canonical(launch))
			return result(target, "already-configured");
		if (!unchanged(target.path, before))
			throw new Error("The Codex configuration changed during installation.");
		execute(options, target.cli, ["mcp", "add", "pharaoh", "--", launch.command, ...launch.args]);
		const after = toml(snapshot(target.path).text);
		const added = entry(after, target.client);
		// The entry reads back as install wrote it, so it is install's even if a check below
		// fails; without this receipt, later installs would keep it as the user's forever.
		if (canonical(added) === canonical(launch)) remember(target, added, options);
		if (
			canonical(added) !== canonical(launch) ||
			unrelated(after, target.client) !== unrelated(document, target.client)
		)
			throw new Error(
				"Codex registration read-back did not match the requested update. Review config.toml before retrying.",
			);
		const raw = readCodex(target, options);
		if (!raw || canonical(cliLaunch(raw)) !== canonical(launch) || raw.enabled === false)
			throw new Error("Codex did not report an enabled matching stdio registration.");
		return result(target, "configured", undefined, undefined, current === undefined);
	}
	if (current !== undefined && canonical(current) === canonical(launch)) {
		ensureLocalPrivatePaths(target.scope, [target.path]);
		if (target.scope?.kind === "local" && !receipt) remember(target, current, options);
		return result(target, "already-configured");
	}
	const block = tomlBlock(launch);
	let next: string;
	if (current === undefined) {
		next = `${before.text ?? ""}${before.text && !before.text.endsWith("\n") ? "\n" : ""}\n${block}`;
	} else {
		if (!receipt?.block || !before.text || before.text.split(receipt.block).length !== 2)
			return result(
				target,
				"preserved-custom",
				"This Codex table needs its CLI for a safe migration.",
				"Install the Codex CLI, then rerun the install command.",
			);
		next = before.text.replace(receipt.block, block);
	}
	const verified = toml(next);
	if (
		canonical(entry(verified, target.client)) !== canonical(launch) ||
		unrelated(verified, target.client) !== unrelated(document, target.client)
	)
		throw new Error("The Codex table could not be appended without changing unrelated settings.");
	ensureLocalPrivatePaths(target.scope, [target.path]);
	remember(target, entry(verified, target.client), options, block);
	atomicReplace(target.path, before, next, target.scope);
	return result(target, "configured", undefined, undefined, current === undefined);
}

/** Independently configure each discovered client, preserving custom and disabled entries. */
export function configureClients(
	targets: readonly ClientTarget[],
	launch: LaunchConfig,
	options: ClientInstallOptions & { migrateLegacy?: boolean } = {},
): ClientOutcome[] {
	if (!isAbsolute(launch.command) || !launch.args.length || !isAbsolute(launch.args[0]))
		throw new Error("Client registration requires an absolute persistent runtime launch.");
	return (options.scope ? scopeInstallTargets(targets, options.scope) : targets).map((target) => {
		if (target.unavailableReason) return result(target, "unavailable", target.unavailableReason);
		if (target.ambiguousReason) return result(target, "ambiguous", target.ambiguousReason);
		try {
			let configured = launch;
			let nativeFeed: ClientOutcome["nativeFeed"];
			if (
				options.nativeFeed &&
				target.client !== "claude-desktop" &&
				settings(options).platform !== "win32"
			) {
				const { home } = settings(options);
				const parsed = proxyLaunchOptions(launch.args);
				if (!parsed) throw new Error("Invalid managed proxy arguments.");
				try {
					const registration = nativeFeedRegistration(target.client, { home });
					configured = {
						...launch,
						args: [
							...parsed.baseArgs,
							"--feed-client",
							target.client,
							"--feed-registration",
							registration,
						],
					};
					const settingsOptions = { ...options, scope: target.scope ?? options.scope };
					nativeFeed = {
						registration,
						home,
						serverArgv: parsed.serverArgv,
						settingsPath: nativeFeedSettingsPath(target.client, settingsOptions),
					};
				} catch {
					// Optional feed state must not prevent a normal hosted tool registration.
				}
			}
			const outcome =
				target.client === "codex"
					? configureCodex(target, configured, options)
					: configureJson(target, configured, options);
			return nativeFeed &&
				(outcome.status === "configured" || outcome.status === "already-configured")
				? { ...outcome, nativeFeed }
				: outcome;
		} catch (error) {
			return result(
				target,
				"failed",
				error instanceof Error ? error.message : "The client configuration could not be updated.",
				"Review the client configuration and run install again.",
			);
		}
	});
}

/**
 * Move each Pharaoh registration that still runs one exact version from `launcher`'s
 * runtimes folder onto `launcher`, keeping its Node and server arguments, under the
 * rules install uses: its receipt, or a managed pin. Custom and disabled entries stay as
 * they are, and a client without a Pharaoh registration gets none. `update` runs this, so
 * every client follows later updates through the launcher.
 *
 * @param launcher - The stable launcher (<runtimes>/launcher-v1.mjs)
 * @param options - Fixtures
 * @returns An outcome for each pinned registration found
 */
export function moveToLauncher(
	launcher: string,
	options: ClientInstallOptions = {},
): ClientOutcome[] {
	return discoverClients(options).flatMap((target) => {
		let current: unknown;
		try {
			current = entry(parse(target, snapshot(target.path).text), target.client);
		} catch {
			// Unreadable settings are install's to report; update leaves them alone.
			return [];
		}
		if (!persistentLaunch(current) || versionEntry(current.args[0])?.root !== dirname(launcher))
			return [];
		let receipt: Receipt | undefined;
		try {
			receipt = owned(target, current, readProvenance(options).data);
		} catch {
			return [];
		}
		// Without a receipt, the entry is install's only as install writes it: Node and the
		// default server. A wrapper or another server stays the user's.
		if (!receipt && !managedPin(current, { command: process.execPath, args: [launcher] }))
			return [result(target, "preserved-custom", "The existing registration was kept.")];
		const launch = { command: current.command, args: [launcher, ...current.args.slice(1)] };
		return configureClients([target], launch, options);
	});
}

/**
 * Whether install can restart Claude Desktop: it is open, and this process doesn't run
 * inside it. From Desktop's own terminal, quitting Desktop would end this install too.
 *
 * @param options - Fixtures
 */
export function desktopRestartable(options: ClientInstallOptions = {}): boolean {
	const pids = desktopPids(options);
	// Closed, or pgrep couldn't tell: no restart to offer.
	if (!pids?.length) return false;
	let parents: Map<number, number>;
	try {
		const table = execute(options, "/bin/ps", ["-A", "-o", "pid=,ppid="]);
		parents = new Map(
			table
				.trim()
				.split("\n")
				.map((line) => line.trim().split(/\s+/).map(Number) as [number, number]),
		);
	} catch {
		return false;
	}
	for (let pid = process.pid, hops = 0; pid > 1 && hops < 64; hops++) {
		if (pids.includes(pid)) return false;
		pid = parents.get(pid) ?? 0;
	}
	return true;
}

/**
 * Restart Claude Desktop onto `launch`: ask macOS to quit it (as ⌘Q does, so Desktop may
 * ask the person to confirm), register while it's closed, then open it again. It then
 * starts on this registration and saves this one from then on.
 *
 * The quit request returns before Desktop decides, and a "no" to its confirmation leaves it
 * just as it was while asking, so only the person can end the wait early: `signal`.
 *
 * @param target - Claude Desktop's configuration
 * @param launch - The registration to keep
 * @param options - The install's consent to migrate a legacy pin, which Desktop may write
 *   back as it quits; `signal`, which stops waiting for Desktop to close; fixtures
 * @returns The registration's outcome, or null when Desktop didn't quit
 */
export async function restartDesktop(
	target: ClientTarget,
	launch: LaunchConfig,
	options: ClientInstallOptions & { migrateLegacy?: boolean; signal?: AbortSignal } = {},
): Promise<ClientOutcome | null> {
	try {
		execute(options, "/usr/bin/osascript", [
			"-e",
			`tell application id "${DESKTOP_BUNDLE}" to quit`,
		]);
	} catch {
		// macOS refused (the terminal may not control other apps): the person quits it.
		return null;
	}
	// Registers only once Desktop is seen closed: a pgrep that couldn't tell keeps the wait going.
	for (let waited = 0; desktopPids(options)?.length !== 0; waited += 250) {
		if (waited >= DESKTOP_QUIT_MS || options.signal?.aborted) return null;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	const [outcome] = configureClients([target], launch, options);
	try {
		execute(options, "/usr/bin/open", ["-b", DESKTOP_BUNDLE]);
		return outcome;
	} catch {
		// Its registration is saved; the person opens Desktop themselves.
		return {
			...outcome,
			detail: [outcome.detail, "Open Claude Desktop again."].filter(Boolean).join(" "),
		};
	}
}

function persistentLaunch(value: unknown): value is LaunchConfig {
	return (
		object(value) &&
		typeof value.command === "string" &&
		isAbsolute(value.command) &&
		Array.isArray(value.args) &&
		value.args.length > 0 &&
		value.args.every((arg) => typeof arg === "string") &&
		isAbsolute(value.args[0])
	);
}

function sameRunningRuntime(configured: LaunchConfig, running: LaunchConfig): boolean {
	if (!persistentLaunch(running) || resolve(configured.args[0]) !== resolve(running.args[0]))
		return false;
	// Node may have been registered through its persistent PATH alias, while
	// process.execPath reports the alias's resolved executable. Never execute it.
	return realpathSync(configured.command) === realpathSync(running.command);
}

/** Parse only installer-owned options while preserving local activation and literal server tokens. */
function proxyLaunchOptions(args: readonly string[]): {
	baseArgs: string[];
	serverArgv: string[];
	client?: string;
	registration?: string;
} | null {
	const parsed: {
		baseArgs: string[];
		serverArgv: string[];
		client?: string;
		registration?: string;
	} = {
		baseArgs: [args[0]],
		serverArgv: [],
	};
	const seen = new Set<string>();
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!value || seen.has(key)) return null;
		seen.add(key);
		if (key === "--server") {
			parsed.serverArgv = [key, value];
			parsed.baseArgs.push(key, value);
		} else if (key === "--install-scope" && value === "local") parsed.baseArgs.push(key, value);
		else if (key === "--install-root" && isAbsolute(value)) parsed.baseArgs.push(key, value);
		else if (key === "--feed-client" && ["claude-code", "codex"].includes(value))
			parsed.client = value;
		else if (
			key === "--feed-registration" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
		)
			parsed.registration = value;
		else return null;
	}
	if (seen.has("--install-scope") !== seen.has("--install-root")) return null;
	return Boolean(parsed.client) === Boolean(parsed.registration) ? parsed : null;
}

/** Compare activation scope while allowing a common install launch to omit adapter-specific feed flags. */
function sameLocalLaunch(
	configured: LaunchConfig,
	running: LaunchConfig,
	client: "claude-code" | "codex",
): boolean {
	const actual = proxyLaunchOptions(configured.args);
	const expected = proxyLaunchOptions(running.args);
	return (
		!!actual &&
		!!expected &&
		canonical(actual.baseArgs) === canonical(expected.baseArgs) &&
		(!actual.client || actual.client === client) &&
		(!expected.client ||
			(actual.client === expected.client && actual.registration === expected.registration))
	);
}

function supportsRegisteredProxy(
	launch: LaunchConfig,
	home: string,
	required: { minimumVersion: string; server: string },
): boolean {
	const [registered] = launch.args;
	const parsed = proxyLaunchOptions(launch.args);
	if (!parsed) return false;
	const configuredServer = parsed.serverArgv[1];
	if (new URL(configuredServer ?? DEFAULT_SERVER).origin !== new URL(required.server).origin)
		return false;
	// A registration through the stable launcher runs the version current.json names.
	const runtimes = join(realpathSync(home), ".pharaoh", "runtimes", "mcp");
	const entry =
		registered === join(runtimes, LAUNCHER_NAME)
			? (usableVersion(runtimes, readPointer(runtimes, "current.json")?.version) ?? "")
			: registered;
	if (!entry) return false;
	const packageRoot = dirname(dirname(entry));
	const pkg = json(snapshot(join(packageRoot, "package.json")).text);
	const version = pkg.version;
	return (
		pkg.name === PACKAGE_NAME &&
		typeof version === "string" &&
		/^\d+\.\d+\.\d+$/.test(version) &&
		(version === required.minimumVersion || isNewerVersion(version, required.minimumVersion)) &&
		entry ===
			join(
				realpathSync(home),
				".pharaoh",
				"runtimes",
				"mcp",
				version,
				"node_modules",
				PACKAGE_NAME,
				"dist",
				"index.js",
			) &&
		lstatSync(entry).isFile() &&
		lstatSync(join(packageRoot, "runtime", "runtime-client.mjs")).isFile()
	);
}

/**
 * Read-only eligibility for automatic startup asset updates. Historical receipts,
 * mere client directories and another running package version do not authorize
 * changes. This deliberately avoids discoverClients and all executable probes.
 */
export function verifiedCodingClients(
	options: ClientInstallOptions & {
		runningLaunch?: LaunchConfig;
		requiredProxy?: { minimumVersion: string; server: string };
		rejectProjectOverrides?: boolean;
		/** Checkout whose project override can suppress automatic repair. */
		projectRoot?: string;
	} = {},
): Array<"claude-code" | "codex"> {
	let data: Provenance;
	try {
		data = readProvenance(options).data;
	} catch {
		return [];
	}
	const { home, env } = settings(options);
	const targets: Array<ClientTarget & { client: "claude-code" | "codex" }> = [];
	if (!env.CLAUDE_CONFIG_DIR || isAbsolute(env.CLAUDE_CONFIG_DIR)) {
		targets.push({
			client: "claude-code",
			path: env.CLAUDE_CONFIG_DIR
				? join(resolve(env.CLAUDE_CONFIG_DIR), ".claude.json")
				: join(home, ".claude.json"),
		});
	}
	if (!env.CODEX_HOME || isAbsolute(env.CODEX_HOME)) {
		targets.push({
			client: "codex",
			path: join(resolve(env.CODEX_HOME || join(home, ".codex")), "config.toml"),
		});
	}
	return scopeInstallTargets(targets, options.scope ?? { kind: "global" }).flatMap((target) => {
		if (target.client === "claude-desktop") return [];
		try {
			const directory = lstatSync(dirname(target.path), { throwIfNoEntry: false });
			if (!directory?.isDirectory() || directory.isSymbolicLink()) return [];
			const document = targetDocument(parse(target, snapshot(target.path).text), target);
			const value = entry(document, target.client);
			if (
				disabled(document, value) ||
				(target.scope?.kind !== "local" &&
					options.rejectProjectOverrides &&
					target.client === "claude-code" &&
					projectOverrides(document, options.projectRoot)) ||
				!persistentLaunch(value) ||
				!owned(target, value, data) ||
				(options.runningLaunch && !sameRunningRuntime(value, options.runningLaunch)) ||
				(target.scope?.kind === "local" &&
					options.runningLaunch &&
					!sameLocalLaunch(value, options.runningLaunch, target.client)) ||
				(options.requiredProxy && !supportsRegisteredProxy(value, home, options.requiredProxy))
			)
				return [];
			return [target.client];
		} catch {
			// Optional asset setup must preserve unreadable, malformed or changed choices.
			return [];
		}
	});
}

/** Remove only exact registrations whose private provenance still matches their current contents. */
export function cleanupManagedClients(options: ClientInstallOptions = {}): ClientOutcome[] {
	const { data } = readProvenance(options);
	const targets = new Map<string, ClientTarget>();
	const requested = options.scope ?? { kind: "global" };
	const key = (target: ClientTarget) =>
		`${target.client}:${target.path}:${target.scope?.kind === "local" ? target.scope.root : "global"}`;
	for (const value of Object.values(data.registrations)) {
		if (
			object(value) &&
			typeof value.path === "string" &&
			isAbsolute(value.path) &&
			["claude-code", "codex", "claude-desktop"].includes(value.client)
		) {
			if (options.client && value.client !== options.client) continue;
			const scope: InstallScope = value.scope ?? { kind: "global" };
			if (
				scope.kind !== requested.kind ||
				(scope.kind === "local" && requested.kind === "local" && scope.root !== requested.root)
			)
				continue;
			const target = { client: value.client, path: value.path, scope };
			targets.set(key(target), target);
		}
	}
	// An active custom registration without a receipt must be reported, not silently
	// treated as removed. These paths are known; cleanup does not execute client discovery.
	const { home, env } = settings(options);
	const known: ClientTarget[] = [
		{
			client: "claude-code",
			path: env.CLAUDE_CONFIG_DIR
				? join(configuredRoot(env.CLAUDE_CONFIG_DIR, ""), ".claude.json")
				: join(home, ".claude.json"),
			scope: requested,
		},
		{
			client: "codex",
			path:
				requested.kind === "local"
					? join(requested.root, ".codex", "config.toml")
					: join(configuredRoot(env.CODEX_HOME, join(home, ".codex")), "config.toml"),
			scope: requested,
		},
	];
	const desktop = requested.kind === "global" ? desktopPath(options) : null;
	if (desktop) known.push({ client: "claude-desktop", path: desktop, scope: requested });
	for (const target of known) {
		if (options.client && target.client !== options.client) continue;
		if (targets.has(key(target))) continue;
		try {
			if (targetEntry(parse(target, snapshot(target.path).text), target) !== undefined)
				targets.set(key(target), target);
		} catch {
			targets.set(key(target), target);
		}
	}
	return [...targets.values()].map((target) => {
		try {
			if (trackedProjectSettings(target))
				return result(
					target,
					"preserved-custom",
					"The tracked Codex project configuration was kept.",
				);
			const before = snapshot(target.path);
			const document = parse(target, before.text);
			const current = targetEntry(document, target);
			if (current === undefined)
				return result(target, "already-configured", "The selected registration is already absent.");
			const receipt = owned(target, current, data);
			if (!receipt)
				return result(
					target,
					"preserved-custom",
					"The current registration does not match the installation record.",
				);
			let next: string;
			if (target.client === "codex") {
				if (receipt.block && before.text?.split(receipt.block).length === 2)
					next = before.text.replace(receipt.block, "");
				else if (target.scope?.kind !== "local" && availableCli(options, "codex")) {
					if (!unchanged(target.path, before))
						throw new Error("The Codex configuration changed during cleanup.");
					// A receipt may refer to a profile different from the current CODEX_HOME.
					// Direct the CLI at the exact configuration whose ownership was verified.
					execute(
						{
							...options,
							env: { ...(options.env ?? process.env), CODEX_HOME: dirname(target.path) },
						},
						"codex",
						["mcp", "remove", "pharaoh"],
					);
					const after = parse(target, snapshot(target.path).text);
					if (
						entry(after, target.client) !== undefined ||
						unrelated(after, target.client) !== unrelated(document, target.client)
					)
						throw new Error("Codex cleanup read-back failed.");
					return result(target, "configured", "Removed the managed registration.");
				} else
					return result(
						target,
						"unavailable",
						"The managed Codex registration needs its CLI for removal.",
					);
			} else {
				delete entries(targetDocument(document, target), target.client).pharaoh;
				next = `${JSON.stringify(document, null, "\t")}\n`;
			}
			parse(target, next);
			atomicReplace(
				target.path,
				before,
				next,
				target.client === "codex" ? target.scope : undefined,
			);
			return result(target, "configured", "Removed the managed registration.");
		} catch (error) {
			return result(
				target,
				"failed",
				error instanceof Error ? error.message : "Managed registration cleanup failed.",
			);
		}
	});
}
