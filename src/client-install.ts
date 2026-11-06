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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { DEFAULT_SERVER } from "./helpers.js";
import type {
	ClientId,
	ClientInstallOptions,
	ClientOutcome,
	ClientTarget,
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
}
interface Provenance {
	version: 1;
	registrations: Record<string, Receipt>;
}

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const BLOCK_START = "# pharaoh-mcp managed registration\n";
const BLOCK_END = "# end pharaoh-mcp managed registration\n";
const RECOVERY = "npx @pharaoh-so/mcp@latest install --migrate-legacy";

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
	try {
		if (options.execute) return options.execute(command, args, { env, timeout: 30_000 });
		return execFileSync(command, [...args], {
			env,
			timeout: 30_000,
			maxBuffer: MAX_CONFIG_BYTES,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
	} catch (error) {
		const stderr = object(error) && "stderr" in error ? String(error.stderr) : "";
		if (
			args[0] === "mcp" &&
			args[1] === "get" &&
			stderr.includes("No MCP server named 'pharaoh' found.")
		)
			throw new MissingRegistration();
		throw new Error(
			"The client command failed. Check that its CLI starts and can read its configuration.",
		);
	}
}

function availableCli(options: ClientInstallOptions, command: string): boolean {
	try {
		return /\b\d+\.\d+\.\d+\b/.test(execute(options, command, ["--version"]));
	} catch {
		return false;
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
	const claudeCli = availableCli(options, "claude");
	const codexCli = availableCli(options, "codex");
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
			...(claudeCli ? { cli: "claude" } : {}),
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
			...(codexCli ? { cli: "codex" } : {}),
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
			const document = parse(target, snapshot(target.path).text);
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
	return targets.flatMap((target) => {
		const { client } = target;
		if (client === "claude-desktop" || target.unavailableReason || target.ambiguousReason)
			return [];
		try {
			const document = parse(target, snapshot(target.path).text);
			if (
				entry(document, client) !== undefined ||
				disabled(document, undefined) ||
				records.some((record) => record?.client === client && record.path === resolve(target.path))
			)
				return [];
			if (client === "claude-code" && projectOverrides(document)) return [];
			return [client];
		} catch {
			// Unreadable or ambiguous local settings cannot authorize automatic enrollment.
			return [];
		}
	});
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

function receiptKey(target: ClientTarget, value: unknown): string {
	return createHash("sha256")
		.update(`${target.client}\0${resolve(target.path)}\0${JSON.stringify(value)}`)
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
function atomicReplace(path: string, before: Snapshot, next: string): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory())
		throw new Error("The configuration directory is not a regular directory.");
	const temporary = join(parent, `.pharaoh-${randomUUID()}.tmp`);
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

function projectOverrides(document: Document): string | undefined {
	if (!object(document.projects)) return;
	const retained = Object.values(document.projects).some(
		(project) =>
			object(project) &&
			(disabled(project, undefined) ||
				(object(project.mcpServers) && project.mcpServers.pharaoh !== undefined)),
	);
	return retained
		? "The user registration is configured. Project-specific connections and disabled choices were kept."
		: undefined;
}

function configureJson(
	target: ClientTarget,
	launch: LaunchConfig,
	options: ClientInstallOptions & { migrateLegacy?: boolean },
): ClientOutcome {
	const before = snapshot(target.path);
	const document = json(before.text);
	const current = entry(document, target.client);
	if (disabled(document, current))
		return result(target, "preserved-disabled", "The disabled registration was kept.");
	const receipt = owned(target, current, readProvenance(options).data);
	if (current !== undefined && !receipt && !(options.migrateLegacy && legacy(current)))
		return result(
			target,
			"preserved-custom",
			"The existing registration was kept.",
			legacy(current) ? RECOVERY : undefined,
		);
	const detail = [projectOverrides(document), desktopPrecedence(target, launch, options)]
		.filter(Boolean)
		.join(" ");
	if (current !== undefined && canonical(current) === canonical(launch))
		return result(target, "already-configured", detail);
	const servers = entries(document, target.client);
	servers.pharaoh = { command: launch.command, args: [...launch.args] };
	document.mcpServers = servers;
	const next = `${JSON.stringify(document, null, "\t")}\n`;
	const verified = json(next);
	if (unrelated(verified, target.client) !== unrelated(parse(target, before.text), target.client))
		throw new Error("The configuration update changed unrelated settings.");
	remember(target, servers.pharaoh, options);
	atomicReplace(target.path, before, next);
	return result(target, "configured", detail, undefined, current === undefined);
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
	const before = snapshot(target.path);
	const document = toml(before.text);
	const current = entry(document, target.client);
	if (disabled(document, current))
		return result(target, "preserved-disabled", "The disabled Codex registration was kept.");
	const receipt = owned(target, current, readProvenance(options).data);
	if (current !== undefined && !receipt && !(options.migrateLegacy && legacy(current)))
		return result(
			target,
			"preserved-custom",
			"The existing Codex registration was kept.",
			legacy(current) ? RECOVERY : undefined,
		);
	if (target.cli) {
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
		if (
			canonical(entry(after, target.client)) !== canonical(launch) ||
			unrelated(after, target.client) !== unrelated(document, target.client)
		)
			throw new Error(
				"Codex registration read-back did not match the requested update. Review config.toml before retrying.",
			);
		const raw = readCodex(target, options);
		if (!raw || canonical(cliLaunch(raw)) !== canonical(launch) || raw.enabled === false)
			throw new Error("Codex did not report an enabled matching stdio registration.");
		remember(target, entry(after, target.client), options);
		return result(target, "configured", undefined, undefined, current === undefined);
	}
	if (current !== undefined && canonical(current) === canonical(launch))
		return result(target, "already-configured");
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
	remember(target, entry(verified, target.client), options, block);
	atomicReplace(target.path, before, next);
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
	return targets.map((target) => {
		if (target.unavailableReason) return result(target, "unavailable", target.unavailableReason);
		if (target.ambiguousReason) return result(target, "ambiguous", target.ambiguousReason);
		try {
			return target.client === "codex"
				? configureCodex(target, launch, options)
				: configureJson(target, launch, options);
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

function supportsRegisteredProxy(
	launch: LaunchConfig,
	home: string,
	required: { minimumVersion: string; server: string },
): boolean {
	const [entry, flag, configuredServer, ...rest] = launch.args;
	if (flag !== undefined && (flag !== "--server" || !configuredServer || rest.length)) return false;
	if (new URL(configuredServer ?? DEFAULT_SERVER).origin !== new URL(required.server).origin)
		return false;
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
	return targets.flatMap((target) => {
		try {
			const directory = lstatSync(dirname(target.path), { throwIfNoEntry: false });
			if (!directory?.isDirectory() || directory.isSymbolicLink()) return [];
			const document = parse(target, snapshot(target.path).text);
			const value = entry(document, target.client);
			if (
				disabled(document, value) ||
				(options.rejectProjectOverrides &&
					target.client === "claude-code" &&
					projectOverrides(document)) ||
				!persistentLaunch(value) ||
				!owned(target, value, data) ||
				(options.runningLaunch && !sameRunningRuntime(value, options.runningLaunch)) ||
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
	for (const value of Object.values(data.registrations)) {
		if (
			object(value) &&
			typeof value.path === "string" &&
			isAbsolute(value.path) &&
			["claude-code", "codex", "claude-desktop"].includes(value.client)
		)
			targets.set(`${value.client}:${value.path}`, { client: value.client, path: value.path });
	}
	return [...targets.values()].map((target) => {
		try {
			const before = snapshot(target.path);
			const document = parse(target, before.text);
			const current = entry(document, target.client);
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
				else if (availableCli(options, "codex")) {
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
				delete entries(document, target.client).pharaoh;
				next = `${JSON.stringify(document, null, "\t")}\n`;
			}
			parse(target, next);
			atomicReplace(target.path, before, next);
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
