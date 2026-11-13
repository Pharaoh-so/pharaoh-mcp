/** Prepare an exact-version runtime whose path survives npm cache eviction. */
import { type ExecFileSyncOptionsWithStringEncoding, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { LaunchConfig } from "./install-types.js";
import { localAnalyzerInstallStatus } from "./local/worker-host.js";
import { getPackageVersion, PACKAGE_NAME } from "./version.js";

const RECOVERY = "npx @pharaoh-so/mcp@latest install";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOCK_TIMEOUT_MS = 150_000;
/** All npm time for one runtime install, retry included; below LOCK_TIMEOUT_MS, so lock waiters outlast it. */
const INSTALL_TIMEOUT_MS = 120_000;
const pending = new Map<string, Promise<LaunchConfig>>();

/** An installer error whose message is safe to display without npm diagnostics. */
export class RuntimeSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeSetupError";
	}
}

/** Process seam for fixtures; production always invokes an absolute executable. */
export type RuntimeRunner = (
	file: string,
	args: readonly string[],
	options: ExecFileSyncOptionsWithStringEncoding,
) => string;

export interface RuntimeOptions {
	home?: string;
	env?: NodeJS.ProcessEnv;
	execPath?: string;
	platform?: NodeJS.Platform;
	version?: string;
	run?: RuntimeRunner;
	/** Atomic filesystem seam for publication failure fixtures. */
	rename?: (from: string, to: string) => void;
	onDiagnostic?: (message: string) => void;
	/** Called once, just before a fresh install or repair downloads `version`; never when the runtime is current. */
	onInstall?: (version: string) => void;
	lockTimeoutMs?: number;
	/** Stops a preparation the caller no longer needs: npm is killed, and the lock and stage are released. */
	signal?: AbortSignal;
	/** Preserve npm's relative TLS paths when installation moves to neutral staging. */
	sourceCwd?: string;
	/** Internal neutral directory used for npm's version probe. */
	cwd?: string;
}

function fail(message: string): never {
	throw new RuntimeSetupError(`${message} Run ${RECOVERY} to retry.`);
}

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

function entryExists(file: string): boolean {
	try {
		lstatSync(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

function pathDirectories(options: RuntimeOptions): string[] {
	return (environmentValue(options.env ?? process.env, "PATH") ?? "")
		.split((options.platform ?? process.platform) === "win32" ? ";" : ":")
		.filter((directory) => isAbsolute(directory));
}

function temporaryPath(file: string): boolean {
	return /(?:^|[/\\])(?:_npx|tmp|temp|\.tmp)(?:[/\\]|$)|[/\\]var[/\\]folders[/\\]/i.test(file);
}

/** Prefer a persistent PATH alias that resolves to the Node running this installer. */
export function resolveLaunchNode(options: RuntimeOptions = {}): string {
	if (Number(process.versions.node.split(".")[0]) < 18) {
		fail("Pharaoh requires Node.js 18 or later.");
	}
	const executable = options.execPath ?? process.execPath;
	if (!isAbsolute(executable) || !isFile(executable)) {
		fail("Pharaoh could not find its Node.js executable.");
	}
	const target = realpathSync(executable);
	const name = (options.platform ?? process.platform) === "win32" ? "node.exe" : "node";
	for (const directory of pathDirectories(options)) {
		const candidate = join(directory, name);
		if (temporaryPath(candidate) || !isFile(candidate)) continue;
		if (realpathSync(candidate) === target) return candidate;
	}
	options.onDiagnostic?.(
		`Pharaoh will use the current Node.js installation. If it moves, run ${RECOVERY} again.`,
	);
	return target;
}

const execFileAsync = promisify(execFile);

/**
 * Run npm without blocking the event loop, so sign-in and the installer's progress line
 * keep running meanwhile. A fixture runner keeps its synchronous seam.
 * @returns npm's standard output
 */
async function runNpm(
	options: RuntimeOptions,
	file: string,
	args: readonly string[],
	settings: ExecFileSyncOptionsWithStringEncoding,
): Promise<string> {
	options.signal?.throwIfAborted();
	if (options.run) return options.run(file, args, settings);
	// execFile pipes every stream, so close stdin to match the synchronous "ignore":
	// an npm prompt then ends at once instead of waiting out the timeout.
	const { stdio: _pipes, ...asyncSettings } = settings;
	const run = execFileAsync(file, [...args], { ...asyncSettings, signal: options.signal });
	run.child.stdin?.end();
	return (await run).stdout;
}

/**
 * Whether an npm setting names a registry, proxy, TLS, credential or cache value a user
 * configures. The cache is the one npx just filled with this release.
 */
export function registryKey(key: string): boolean {
	return (
		/^(?:@[^:]+:)?registry$/i.test(key) ||
		/^(?:https?-proxy|proxy|noproxy|strict-ssl|cafile|ca(?:\[\])?|cert|key|certfile|keyfile|always-auth|_auth|_authtoken|username|_password|email|cache)$/i.test(
			key,
		) ||
		/^\/\/[^\s=]+:(?:_authToken|_auth|username|_password|certfile|keyfile|always-auth)$/i.test(key)
	);
}

/** Settings whose value is a file path, resolved before npm runs from the neutral stage. */
function tlsPathKey(key: string): boolean {
	return /(?:^|:)(?:cafile|certfile|keyfile|cache)$/i.test(key);
}

function tlsPath(value: string, options: RuntimeOptions): string {
	const env = options.env ?? process.env;
	const expanded = value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
		const optional = name.endsWith("?");
		const replacement = env[optional ? name.slice(0, -1) : name];
		if (replacement === undefined && !optional)
			fail("Pharaoh could not resolve npm's TLS file path environment.");
		return replacement ?? "";
	});
	if (!expanded || expanded === "null") return expanded;
	if (/^~[/\\]/.test(expanded)) return resolve(options.home ?? homedir(), expanded.slice(2));
	return resolve(options.sourceCwd ?? process.cwd(), expanded);
}

/** A path setting's resolved value. A cache path that can't be resolved is dropped, so npm uses its default. */
function settingPath(key: string, value: string, options: RuntimeOptions): string | undefined {
	try {
		return tlsPath(value, options);
	} catch (error) {
		if (/(?:^|:)cache$/i.test(key)) return undefined;
		throw error;
	}
}

/** Keep registry credentials while preventing inherited install or loader redirection. */
function npmEnvironment(options: RuntimeOptions): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(options.env ?? process.env)) {
		// npmrc token interpolation uses ordinary variables such as NPM_TOKEN.
		if (/^npm_config_/i.test(key)) {
			const setting = key.replace(/^npm_config_/i, "");
			if (!registryKey(setting)) continue;
		}
		if (/^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|DYLD_.+)$/i.test(key)) continue;
		const setting = key.replace(/^npm_config_/i, "");
		if (value === undefined || !tlsPathKey(setting)) env[key] = value;
		else {
			const path = settingPath(setting, value, options);
			if (path !== undefined) env[key] = path;
		}
	}
	return env;
}

function npmSettings(options: RuntimeOptions): ExecFileSyncOptionsWithStringEncoding {
	return {
		cwd: options.cwd ?? options.home ?? homedir(),
		env: npmEnvironment(options),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
		shell: false,
	};
}

function npmEntry(candidate: string): string | null {
	if (!isAbsolute(candidate) || !isFile(candidate)) return null;
	const actual = realpathSync(candidate);
	const entry = basename(actual) === "npx-cli.js" ? join(dirname(actual), "npm-cli.js") : actual;
	if (basename(entry) !== "npm-cli.js" || !isFile(entry)) return null;
	try {
		const root = dirname(dirname(entry));
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (
			pkg.name === "npm" &&
			SEMVER.test(pkg.version) &&
			pkg.bin?.npm === "bin/npm-cli.js" &&
			realpathSync(entry) === realpathSync(join(root, "bin", "npm-cli.js"))
		) {
			return realpathSync(entry);
		}
	} catch {
		// Invalid discovery hints never become executable candidates.
	}
	return null;
}

/** Locate and validate npm without executing a PATH shell wrapper. */
export async function resolveNpmCli(options: RuntimeOptions = {}): Promise<string> {
	const executable = options.execPath ?? process.execPath;
	const node = resolveLaunchNode({ ...options, onDiagnostic: undefined });
	const nodeDirectory = dirname(realpathSync(executable));
	const candidates = [
		environmentValue(options.env ?? process.env, "npm_execpath"),
		join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
		join(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		...pathDirectories(options).flatMap((directory) => [
			join(directory, "npm"),
			join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
		]),
	];
	for (const candidate of new Set(candidates)) {
		if (!candidate) continue;
		const entry = npmEntry(candidate);
		if (!entry) continue;
		try {
			const version = (
				await runNpm(options, node, [entry, "--version"], npmSettings(options))
			).trim();
			if (SEMVER.test(version)) return entry;
		} catch {
			// Continue to another validated npm installation, without exposing its output.
		}
	}
	fail("Pharaoh could not find a working npm installation. Install Node.js 18 or later with npm.");
}

function privateDirectory(directory: string): void {
	if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Pharaoh's runtime directory is unsafe.");
	if (process.getuid && stat.uid !== process.getuid())
		fail("Pharaoh's runtime directory has another owner.");
	if (process.platform !== "win32") chmodSync(directory, 0o700);
}

function runtimeRoot(home: string): string {
	if (!isAbsolute(home) || !statSync(home).isDirectory())
		fail("Pharaoh could not access the home directory.");
	let directory = realpathSync(home);
	for (const name of [".pharaoh", "runtimes", "mcp"]) {
		directory = join(directory, name);
		privateDirectory(directory);
	}
	return directory;
}

function contained(root: string, file: string): boolean {
	const path = relative(root, realpathSync(file));
	return (
		path !== ".." &&
		!path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(path)
	);
}

function validateTree(root: string, directory = root): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			if (basename(directory) !== ".bin" || !contained(root, file) || !statSync(file).isFile()) {
				fail("Pharaoh's installed runtime contains an unexpected link.");
			}
		} else if (entry.isDirectory()) validateTree(root, file);
		else if (!entry.isFile()) fail("Pharaoh's installed runtime contains an unexpected file type.");
	}
}

function validateRuntime(root: string, version: string): string {
	const packageRoot = join(root, "node_modules", "@pharaoh-so", "mcp");
	const entry = join(packageRoot, "dist", "index.js");
	try {
		if (lstatSync(root).isSymbolicLink()) fail("Pharaoh's installed runtime is unsafe.");
		const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		const marker = JSON.parse(readFileSync(join(root, ".pharaoh-runtime.json"), "utf8"));
		if (
			pkg.name !== PACKAGE_NAME ||
			pkg.version !== version ||
			pkg.bin?.["pharaoh-mcp"] !== "./dist/index.js" ||
			marker.package !== PACKAGE_NAME ||
			marker.version !== version ||
			!isFile(entry)
		)
			fail("Pharaoh's installed runtime could not be verified.");
		validateTree(root);
		const sdk = createRequire(entry).resolve("@modelcontextprotocol/sdk/client/index.js");
		if (!contained(root, sdk)) fail("Pharaoh's installed runtime is missing its own MCP SDK.");
		return entry;
	} catch (error) {
		if (error instanceof RuntimeSetupError) throw error;
		fail("Pharaoh's installed runtime could not be verified.");
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function lockOwner(directory: string): { pid: number; token: string } | null {
	try {
		const owner = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"));
		return Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string"
			? owner
			: null;
	} catch {
		return null;
	}
}

interface RuntimeLock {
	assertHeld(): void;
	release(): void;
}

async function acquireLock(
	root: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RuntimeLock> {
	const directory = join(root, ".install-lock");
	const token = randomUUID();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) fail("Pharaoh stopped preparing its runtime.");
		let created = false;
		try {
			mkdirSync(directory, { mode: 0o700 });
			created = true;
			writeFileSync(join(directory, "owner.json"), JSON.stringify({ pid: process.pid, token }), {
				mode: 0o600,
				flag: "wx",
			});
			return {
				assertHeld() {
					if (lockOwner(directory)?.token !== token) fail("Pharaoh's installation lock changed.");
				},
				release() {
					if (lockOwner(directory)?.token === token) {
						rmSync(directory, { recursive: true, force: true });
					}
				},
			};
		} catch (error) {
			if (created) {
				rmSync(directory, { recursive: true, force: true });
				fail("Pharaoh could not record its installation lock.");
			}
			if ((error as NodeJS.ErrnoException).code !== "EEXIST")
				fail("Pharaoh could not lock its runtime directory.");
		}
		let stat: Stats;
		try {
			stat = lstatSync(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			fail("Pharaoh could not inspect its runtime lock.");
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Pharaoh's runtime lock is unsafe.");
		const owner = lockOwner(directory);
		if (
			(owner && !processAlive(owner.pid)) ||
			(!owner && Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS)
		) {
			const stale = join(root, `.stale-lock-${randomUUID()}`);
			try {
				renameSync(directory, stale);
				rmSync(stale, { recursive: true, force: true });
			} catch {
				// Another installer may have reclaimed it first.
			}
			continue;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	fail("Another Pharaoh installation is still preparing the runtime.");
}

async function registryConfig(options: RuntimeOptions, npm: string, node: string): Promise<string> {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	let global = environmentValue(env, "npm_config_globalconfig");
	if (!global) {
		try {
			global = (
				await runNpm(options, node, [npm, "config", "get", "globalconfig"], npmSettings(options))
			).trim();
		} catch {
			fail("Pharaoh could not read npm's registry configuration.");
		}
	}
	const user = environmentValue(env, "npm_config_userconfig") ?? join(home, ".npmrc");
	const lines: string[] = [];
	for (const file of [global, user]) {
		if (!isAbsolute(file) || !existsSync(file)) continue;
		for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
			const match = /^\s*([^;#=][^=]*?)\s*=(.*)$/.exec(line);
			if (!match || !registryKey(match[1].trim())) continue;
			const key = match[1].trim();
			if (!tlsPathKey(key)) {
				lines.push(line);
				continue;
			}
			let value = match[2].trim();
			if (value.startsWith('"')) {
				try {
					value = JSON.parse(value);
				} catch {
					fail("Pharaoh could not read npm's TLS file path. Use an absolute path.");
				}
			} else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
			else value = value.replace(/\s+[;#].*$/, "").trim();
			if (typeof value !== "string") fail("Pharaoh could not read npm's TLS file path.");
			const path = settingPath(key, value, options);
			if (path !== undefined) lines.push(`${key}=${JSON.stringify(path)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function removeAbandonedStages(root: string): void {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.name.startsWith(".stage-") || !entry.isDirectory()) continue;
		const directory = join(root, entry.name);
		const marker = join(directory, ".runtime-stage.json");
		if (!isFile(marker)) continue;
		try {
			const owner = JSON.parse(readFileSync(marker, "utf8"));
			if (Number.isInteger(owner.pid) && owner.pid > 0 && !processAlive(owner.pid)) {
				rmSync(directory, { recursive: true, force: true });
			}
		} catch {
			// An unrecognized directory is preserved rather than treated as installer output.
		}
	}
}

async function prepareRuntime(options: RuntimeOptions, version: string): Promise<LaunchConfig> {
	const root = runtimeRoot(options.home ?? homedir());
	const command = resolveLaunchNode(options);
	const lock = await acquireLock(root, options.lockTimeoutMs ?? LOCK_TIMEOUT_MS, options.signal);
	let staging: string | undefined;
	let hostedFallback: LaunchConfig | undefined;
	try {
		removeAbandonedStages(root);
		const destination = join(root, version);
		if (entryExists(destination)) {
			try {
				const entry = validateRuntime(destination, version);
				const launch = { command, args: [entry] };
				if (localAnalyzerInstallStatus(dirname(dirname(entry))) !== "repair-needed") return launch;
				// An optional fetch can fail without invalidating the hosted runtime.
				hostedFallback = launch;
			} catch (error) {
				if (!(error instanceof RuntimeSetupError)) throw error;
				// Build a complete replacement before moving the damaged runtime aside.
			}
		}
		options.onInstall?.(version);
		staging = mkdtempSync(join(root, `.stage-${version}-`));
		privateDirectory(staging);
		writeFileSync(join(staging, ".runtime-stage.json"), JSON.stringify({ pid: process.pid }), {
			mode: 0o600,
		});
		writeFileSync(join(staging, "package.json"), '{"private":true}\n', { mode: 0o600 });
		const npm = await resolveNpmCli({ ...options, cwd: staging });
		const npmrc = join(staging, ".npmrc");
		const emptyConfig = join(staging, ".empty-npmrc");
		writeFileSync(npmrc, await registryConfig({ ...options, cwd: staging }, npm, command), {
			mode: 0o600,
		});
		writeFileSync(emptyConfig, "", { mode: 0o600 });
		// npx has just cached this exact release and its dependencies, so prefer npm's cache: npm
		// still checks every tarball's integrity and fetches whatever isn't cached. Under
		// --prefer-offline npm never refreshes a cached version list, so one older than this
		// release fails (ETARGET) and one older than the analyzer's pin drops it; the same
		// install then runs once more with --prefer-online, which rechecks every cached list,
		// within the same time budget.
		const deadline = Date.now() + INSTALL_TIMEOUT_MS;
		const prefix = staging;
		const install = (extra: readonly string[]) =>
			runNpm(
				options,
				command,
				[
					npm,
					"install",
					`${PACKAGE_NAME}@${version}`,
					"--prefix",
					prefix,
					"--global=false",
					"--workspaces=false",
					"--ignore-scripts",
					"--omit=dev",
					"--no-audit",
					"--no-fund",
					"--package-lock=false",
					...extra,
					"--userconfig",
					npmrc,
					"--globalconfig",
					emptyConfig,
				],
				{ ...npmSettings(options), cwd: prefix, timeout: deadline - Date.now() },
			);
		let cached = false;
		try {
			await install(["--prefer-offline"]);
			cached =
				localAnalyzerInstallStatus(join(staging, "node_modules", PACKAGE_NAME)) !== "repair-needed";
		} catch {
			// Retried online below.
		}
		if (!cached) {
			rmSync(join(staging, "node_modules"), { recursive: true, force: true });
			try {
				// A timeout of 0 would mean none at all.
				if (deadline - Date.now() < 1_000) throw new Error("No time left to install online.");
				await install(["--prefer-online"]);
			} catch {
				fail("Pharaoh could not install its exact-version runtime. Check npm registry access.");
			}
		}
		rmSync(npmrc, { force: true });
		rmSync(emptyConfig, { force: true });
		rmSync(join(staging, ".runtime-stage.json"), { force: true });
		writeFileSync(
			join(staging, ".pharaoh-runtime.json"),
			JSON.stringify({ package: PACKAGE_NAME, version }),
			{ mode: 0o600 },
		);
		const stagedEntry = validateRuntime(staging, version);
		if (hostedFallback && localAnalyzerInstallStatus(dirname(dirname(stagedEntry))) !== "ready")
			return hostedFallback;
		lock.assertHeld();
		const rename = options.rename ?? renameSync;
		const backup = entryExists(destination)
			? join(root, `.invalid-${version}-${randomUUID()}`)
			: undefined;
		if (backup) rename(destination, backup);
		try {
			rename(staging, destination);
		} catch (error) {
			if (backup && !entryExists(destination)) rename(backup, destination);
			throw error;
		}
		staging = undefined;
		return {
			command,
			args: [join(destination, "node_modules", "@pharaoh-so", "mcp", "dist", "index.js")],
		};
	} catch (error) {
		if (hostedFallback && isFile(hostedFallback.args[0])) return hostedFallback;
		if (error instanceof RuntimeSetupError) throw error;
		return fail("Pharaoh could not prepare its runtime safely.");
	} finally {
		if (staging) rmSync(staging, { recursive: true, force: true });
		lock.release();
	}
}

/** Stage a fresh install or repair privately, then atomically publish the verified runtime. */
export function ensureRuntime(options: RuntimeOptions = {}): Promise<LaunchConfig> {
	const version = options.version ?? getPackageVersion();
	if (!SEMVER.test(version) || version === "0.0.0") {
		return Promise.reject(
			new RuntimeSetupError(`Pharaoh could not read its package version. Run ${RECOVERY} again.`),
		);
	}
	const key = `${resolve(options.home ?? homedir())}\0${version}`;
	const active = pending.get(key);
	if (active) return active;
	const preparation = prepareRuntime(
		{ ...options, sourceCwd: options.sourceCwd ?? process.cwd() },
		version,
	).finally(() => pending.delete(key));
	pending.set(key, preparation);
	return preparation;
}
