/** Resolves a worktree only from a native hook directory or the shell invocation directory. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	opendirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CheckoutEvidence, VerifiedCheckout } from "./dispatch.js";
import { installedLocalAnalyzer } from "./worker-host.js";

// Apple's /usr/bin/git is an Xcode shim. Prefer an installed Git on macOS
// so a cold developer-tools lookup cannot consume the native hook budget.
const GIT_LOCATIONS =
	process.platform === "darwin"
		? ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]
		: ["/usr/bin/git", "/usr/local/bin/git"];
const GIT_TIMEOUT_MS = 1_500;
const SCOPE_TIMEOUT_MS = 2_250;
const WINDOWS_COMMAND_TIMEOUT_MS = 2_500;
const WINDOWS_SNAPSHOT_SCOPE_TIMEOUT_MS = 5_000;
const MAX_GIT_METADATA = 8_192;
const MAX_GIT_CONFIG = 64 * 1_024;
const MAX_GIT_INVENTORY = 4 * 1_024 * 1_024;
const MAX_CONFINED_METADATA = 8 * 1_024 * 1_024;
const MAX_METADATA_RECORDS = 2_048;
const INVENTORY_TIMEOUT_MS = 8_000;
const MAX_POSIX_INVENTORY_ENTRIES = 25_000;
const SKIP_INVENTORY_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	"compiled",
]);
const GITHUB_ORIGIN =
	/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100})$/i;
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/][^\0\r\n]*$/i;
const WINDOWS_IDENTITY = /^(\d{1,20}) ([0-9a-f]{32})$/;
const unavailable = { kind: "unverified" } as const;
const hostedOnly = { kind: "hosted-only" } as const;

interface WindowsGit {
	executable: string;
	systemRoot: string;
}

interface GitLayout {
	root: string;
	gitDir: string;
	commonDir: string;
	rootIdentity: string;
	gitIdentity: string;
	commonIdentity: string;
}

function boundedTimeout(deadline: number, commandTimeout = GIT_TIMEOUT_MS): number {
	return Math.max(1, Math.min(commandTimeout, Math.ceil(deadline - performance.now())));
}

function posixGit(
	executable: string,
	cwd: string,
	args: readonly string[],
	maxBuffer = MAX_GIT_METADATA,
	deadline = performance.now() + GIT_TIMEOUT_MS,
	input?: Buffer,
) {
	return spawnSync(
		executable,
		["--no-optional-locks", "--no-replace-objects", "--no-pager", ...args],
		{
			cwd,
			env: {
				PATH: "/usr/bin:/bin",
				LC_ALL: "C",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_NO_LAZY_FETCH: "1",
				GIT_ALLOW_PROTOCOL: "",
				GIT_TERMINAL_PROMPT: "0",
			},
			input,
			encoding: "utf8",
			stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
			timeout: boundedTimeout(deadline),
			killSignal: "SIGKILL",
			maxBuffer,
		},
	);
}

function runWindowsReader(
	reader: string,
	args: readonly string[],
	deadline: number,
	maxBuffer = 64 * 1_024,
) {
	return spawnSync(reader, args, {
		cwd: dirname(reader),
		env: {},
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		timeout: boundedTimeout(deadline, WINDOWS_COMMAND_TIMEOUT_MS),
		killSignal: "SIGKILL",
		maxBuffer,
	});
}

function windowsGit(
	git: WindowsGit,
	args: readonly string[],
	deadline: number,
	maxBuffer: number,
	input?: Buffer,
) {
	return spawnSync(
		git.executable,
		["--no-optional-locks", "--no-replace-objects", "--no-pager", ...args],
		{
			cwd: dirname(git.executable),
			env: {
				SystemRoot: git.systemRoot,
				PATH: [dirname(git.executable), join(git.systemRoot, "System32")].join(";"),
				LC_ALL: "C",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_NO_LAZY_FETCH: "1",
				GIT_ALLOW_PROTOCOL: "",
				GIT_TERMINAL_PROMPT: "0",
			},
			input,
			encoding: "utf8",
			stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
			timeout: boundedTimeout(deadline, WINDOWS_COMMAND_TIMEOUT_MS),
			killSignal: "SIGKILL",
			maxBuffer,
		},
	);
}

function resolveTrustedGitWin(reader: string, deadline: number) {
	const result = runWindowsReader(reader, ["git-path"], deadline);
	if (result.error || result.status !== 0) return;
	const [executable, systemRoot, end, ...extra] = result.stdout.split("\n");
	if (
		end === "" &&
		extra.length === 0 &&
		WINDOWS_ABSOLUTE.test(executable) &&
		/\\git\.exe$/i.test(executable) &&
		WINDOWS_ABSOLUTE.test(systemRoot) &&
		!result.stdout.includes("\ufffd")
	)
		return { executable, systemRoot };
}

function windowsLayout(
	cwd: string,
	reader: string,
	deadline: number,
): GitLayout | null | undefined {
	if (!WINDOWS_ABSOLUTE.test(cwd) || !isAbsolute(reader)) return;
	// Native validation checks the literal path before Git can follow .git indirection.
	const normalized = cwd.replaceAll("/", "\\");
	const path =
		normalized.length > 3 && normalized.endsWith("\\") ? normalized.slice(0, -1) : normalized;
	const result = runWindowsReader(reader, ["git-layout", path], deadline);
	if (result.error) return;
	if (result.status === 3) return null;
	if (result.status !== 0) return;
	const [root, gitDir, commonDir, rootIdentity, gitIdentity, end, ...extra] =
		result.stdout.split("\n");
	if (
		end === "" &&
		extra.length === 0 &&
		[root, gitDir, commonDir].every((directory) => WINDOWS_ABSOLUTE.test(directory)) &&
		WINDOWS_IDENTITY.test(rootIdentity) &&
		WINDOWS_IDENTITY.test(gitIdentity) &&
		!result.stdout.includes("\ufffd") &&
		isWithin(root, path)
	) {
		let commonIdentity = gitIdentity;
		if (gitDir.toLowerCase() !== commonDir.toLowerCase()) {
			const identified = runWindowsReader(reader, ["identify", commonDir], deadline);
			if (identified.error || identified.status !== 0) return;
			commonIdentity = identified.stdout.replace(/\n$/, "");
			if (!WINDOWS_IDENTITY.test(commonIdentity)) return;
		}
		return { root, gitDir, commonDir, rootIdentity, gitIdentity, commonIdentity };
	}
}

function githubHost(value: string): boolean {
	const hostname = value.toLowerCase().replace(/\.+$/, "");
	return hostname === "github.com" || hostname.endsWith(".github.com");
}

/** A null origin means positively hosted; malformed or ambiguous data stays unverified. */
function classifyOrigin(value: string): string | null | undefined {
	if (!value || value.trim() !== value || /[\0\r\n]/.test(value)) return;
	const slug = GITHUB_ORIGIN.exec(value.replace(/\.git$/i, ""))?.[1].toLowerCase();
	if (slug && !slug.endsWith("/.") && !slug.endsWith("/..")) return slug;
	if (/^(?:https?|ssh|git|file):\/\//i.test(value) && !value.includes("\\")) {
		try {
			const url = new URL(value);
			if ((url.protocol === "file:" || url.hostname) && url.pathname && !githubHost(url.hostname)) {
				return null;
			}
		} catch {
			// A malformed URI is not evidence of a hosted-only checkout.
		}
		return;
	}
	if (/^(?:https?|ssh|git|file):/i.test(value)) return;
	if (/^(?:[a-z]:[\\/]|\/[^/]|\.\.?[\\/])/i.test(value)) return null;
	const host = /^(?:[^@\s/:]+@)?([a-z\d.-]+):[^\s:][^\r\n]*$/i.exec(value)?.[1];
	if (host && !githubHost(host)) return null;
}

function worktreeIdentity(layout: GitLayout): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				layout.root,
				layout.gitDir,
				layout.commonDir,
				layout.rootIdentity,
				layout.gitIdentity,
				layout.commonIdentity,
			]),
		)
		.digest("hex");
}

interface CapturedMetadata {
	status: number;
	bytes: Buffer;
}

/** Read a bounded batch of repository-relative paths through the native reader. */
function confinedMetadata(
	reader: string,
	root: string,
	identity: string,
	paths: readonly string[],
	deadline: number,
	maxBuffer = MAX_CONFINED_METADATA,
	maxStatus = 2,
): Map<string, CapturedMetadata> | undefined {
	const entries = new Map<string, CapturedMetadata>();
	if (paths.length === 0) return entries;
	if (paths.length > MAX_METADATA_RECORDS) return;
	const input: Buffer[] = [];
	for (const path of paths) {
		const bytes = Buffer.from(path);
		if (bytes.length === 0 || bytes.length > 4096) return;
		const length = Buffer.alloc(2);
		length.writeUInt16BE(bytes.length);
		input.push(length, bytes);
	}
	const result = spawnSync(reader, [root, ...identity.split(" ")], {
		cwd: dirname(reader),
		env: {},
		input: Buffer.concat(input),
		stdio: ["pipe", "pipe", "ignore"],
		windowsHide: true,
		timeout: boundedTimeout(
			deadline,
			process.platform === "win32" ? WINDOWS_COMMAND_TIMEOUT_MS : undefined,
		),
		killSignal: "SIGKILL",
		maxBuffer,
	});
	if (result.error || result.status !== 0) return;
	let offset = 0;
	for (const path of paths) {
		if (offset + 5 > result.stdout.length) return;
		const status = result.stdout.readUInt8(offset);
		const size = result.stdout.readUInt32BE(offset + 1);
		offset += 5;
		if (status > maxStatus || (status !== 0 && size !== 0) || offset + size > result.stdout.length)
			return;
		entries.set(path, { status, bytes: result.stdout.subarray(offset, offset + size) });
		offset += size;
	}
	return offset === result.stdout.length ? entries : undefined;
}

/**
 * Fingerprint a small batch of eligible source paths without releasing their bytes.
 * @public Used by the packaged local-worktree hook through the compiled module.
 */
export function fingerprintLocalSources(
	checkout: VerifiedCheckout,
	reader: string,
	paths: readonly string[],
	deadline: number,
	visit?: (path: string, bytes: Buffer) => void,
): Map<string, string | null> | undefined {
	if (paths.length > 4 || performance.now() >= deadline) return;
	const entries = confinedMetadata(
		reader,
		checkout.root,
		`${checkout.device} ${checkout.inode}`,
		paths,
		deadline,
		4 * 1_000_005,
		5,
	);
	if (!entries) return;
	const fingerprints = new Map<string, string | null>();
	for (const [path, { status, bytes }] of entries) {
		if (status === 0) {
			fingerprints.set(path, createHash("sha256").update(bytes).digest("hex"));
			visit?.(path, bytes);
		} else if (status === 1) fingerprints.set(path, null);
		// Other native statuses are individually uncertain, not evidence of absence.
	}
	return fingerprints;
}

interface RepoSettings {
	repoSlug: string | null;
	ignoreCase: boolean;
	objectFormat: "sha1" | "sha256";
}

function windowsRepoSettings(
	windows: WindowsGit,
	config: CapturedMetadata | undefined,
	deadline: number,
): RepoSettings | undefined {
	if (config?.status !== 0 || config.bytes.length > MAX_GIT_CONFIG) return;
	const result = windowsGit(
		windows,
		["config", "--file", "-", "--no-includes", "--null", "--list"],
		deadline,
		MAX_GIT_CONFIG,
		config.bytes,
	);
	return result.error || result.status !== 0 ? undefined : parseRepoSettings(result.stdout);
}

function parseRepoSettings(output: string): RepoSettings | undefined {
	if (output && !output.endsWith("\0")) return;
	const urls: string[] = [];
	let ignoreCase = false;
	let objectFormat: RepoSettings["objectFormat"] = "sha1";
	for (const entry of output.slice(0, -1).split("\0")) {
		const separator = entry.indexOf("\n");
		const key = (separator < 0 ? entry : entry.slice(0, separator)).toLowerCase();
		const value = separator < 0 ? "" : entry.slice(separator + 1);
		// Only finite index and case settings enter the private Git scaffold.
		// Refuse unsupported external or checkout-specific ignore policies.
		if (
			/^include(?:if)?\./.test(key) ||
			key === "core.excludesfile" ||
			key === "core.attributesfile" ||
			key === "extensions.worktreeconfig"
		)
			return;
		if (key === "remote.origin.url") urls.push(value);
		if (key === "core.ignorecase") {
			if (separator < 0 || /^(?:true|yes|on|1)$/i.test(value)) ignoreCase = true;
			else if (/^(?:false|no|off|0)?$/i.test(value)) ignoreCase = false;
			else return;
		}
		if (key === "extensions.objectformat") {
			if (value !== "sha1" && value !== "sha256") return;
			objectFormat = value;
		}
	}
	const repoSlug =
		urls.length === 0 ? null : urls.length === 1 ? classifyOrigin(urls[0]) : undefined;
	return repoSlug === undefined ? undefined : { repoSlug, ignoreCase, objectFormat };
}

function resolveWindowsCheckout(
	cwd: string,
	reader: string,
	timeout = SCOPE_TIMEOUT_MS,
): CheckoutEvidence {
	const deadline = performance.now() + timeout;
	const layout = windowsLayout(cwd, reader, deadline);
	if (layout === null) return hostedOnly;
	if (!layout) return unavailable;
	const windows = resolveTrustedGitWin(reader, deadline);
	if (!windows) return unavailable;
	const metadata = confinedMetadata(
		reader,
		layout.commonDir,
		layout.commonIdentity,
		["config"],
		deadline,
		MAX_GIT_CONFIG + 5,
	);
	const settings = windowsRepoSettings(windows, metadata?.get("config"), deadline);
	if (!settings) return unavailable;
	if (settings.repoSlug === null) return hostedOnly;
	const [device, inode] = layout.rootIdentity.split(" ");
	return {
		kind: "checkout",
		checkout: {
			root: layout.root,
			repoSlug: settings.repoSlug,
			worktreeId: worktreeIdentity(layout),
			device,
			inode,
		},
	};
}

function isWithin(root: string, cwd: string): boolean {
	const location = relative(root, cwd);
	return !isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`);
}

function posixDirectoryIdentity(path: string): string | undefined {
	if (realpathSync(path) !== path) return;
	const metadata = lstatSync(path, { bigint: true });
	if (metadata.isDirectory()) return `${metadata.dev} ${metadata.ino}`;
}

function gitMarker(metadata: CapturedMetadata | undefined, prefix = ""): string | undefined {
	if (metadata?.status !== 0 || metadata.bytes.length > 4096) return;
	const text = metadata.bytes.toString("utf8").replace(/\r?\n$/, "");
	if (!text.startsWith(prefix) || /[\0\r\n\ufffd]/.test(text)) return;
	const path = text.slice(prefix.length);
	if (path && path.trim() === path) return path;
}

/** Resolve only standard Git layouts, with marker bytes confined by the openat reader. */
function posixLayout(cwd: string, reader: string, deadline: number): GitLayout | null | undefined {
	let root = realpathSync(cwd);
	while (performance.now() < deadline) {
		const markerPath = join(root, ".git");
		const marker = lstatSync(markerPath, { throwIfNoEntry: false });
		if (!marker) {
			const parent = dirname(root);
			if (parent === root) return null;
			root = parent;
			continue;
		}
		const rootIdentity = posixDirectoryIdentity(root);
		if (!rootIdentity) return;
		if (marker.isDirectory()) {
			const gitIdentity = posixDirectoryIdentity(markerPath);
			if (!gitIdentity) return;
			const common = confinedMetadata(reader, markerPath, gitIdentity, ["commondir"], deadline);
			if (common?.get("commondir")?.status !== 1) return;
			return {
				root,
				gitDir: markerPath,
				commonDir: markerPath,
				rootIdentity,
				gitIdentity,
				commonIdentity: gitIdentity,
			};
		}
		if (!marker.isFile()) return;
		const link = confinedMetadata(reader, root, rootIdentity, [".git"], deadline, 4101);
		const target = gitMarker(link?.get(".git"), "gitdir: ");
		if (!target) return;
		const gitDir = realpathSync(resolve(root, target));
		const worktrees = dirname(gitDir);
		const commonDir = dirname(worktrees);
		if (basename(worktrees) !== "worktrees" || basename(commonDir) !== ".git") return;
		const gitIdentity = posixDirectoryIdentity(gitDir);
		const commonIdentity = posixDirectoryIdentity(commonDir);
		if (!gitIdentity || !commonIdentity) return;
		const reverse = confinedMetadata(
			reader,
			gitDir,
			gitIdentity,
			["gitdir", "commondir"],
			deadline,
			8202,
		);
		const gitdir = gitMarker(reverse?.get("gitdir"));
		const commondir = gitMarker(reverse?.get("commondir"));
		if (
			!gitdir ||
			!commondir ||
			realpathSync(resolve(gitDir, gitdir)) !== markerPath ||
			resolve(gitDir, commondir) !== commonDir
		)
			return;
		return { root, gitDir, commonDir, rootIdentity, gitIdentity, commonIdentity };
	}
}

function posixRepoSettings(
	executable: string,
	config: CapturedMetadata | undefined,
	deadline: number,
) {
	if (config?.status !== 0 || config.bytes.length > MAX_GIT_CONFIG) return;
	const result = posixGit(
		executable,
		dirname(executable),
		["config", "--file", "-", "--no-includes", "--null", "--list"],
		MAX_GIT_CONFIG,
		deadline,
		config.bytes,
	);
	return result.error || result.status !== 0 ? undefined : parseRepoSettings(result.stdout);
}

/**
 * Identify the worktree and its single GitHub origin without invoking repository commands.
 * @param cwd - The directory provided by the native host, or the CLI's own process cwd
 * @param reader - Verified packed reader supplied by the snapshot coordinator or CI fixture
 * @returns Verified checkout, confirmed non-repository, or unverified scope
 */
export function resolveLocalCheckout(cwd: string, reader?: string): CheckoutEvidence {
	if (!isAbsolute(cwd)) return unavailable;
	const packaged = reader ?? installedLocalAnalyzer()?.reader;
	if (!packaged) return unavailable;
	if (process.platform === "win32") return resolveWindowsCheckout(cwd, packaged);
	const executable = GIT_LOCATIONS.find(existsSync);
	if (!executable) return unavailable;
	try {
		const deadline = performance.now() + SCOPE_TIMEOUT_MS;
		const layout = posixLayout(cwd, packaged, deadline);
		if (layout === null) return hostedOnly;
		if (!layout) return unavailable;
		const config = confinedMetadata(
			packaged,
			layout.commonDir,
			layout.commonIdentity,
			["config"],
			deadline,
			MAX_GIT_CONFIG + 5,
		);
		const settings = posixRepoSettings(executable, config?.get("config"), deadline);
		if (!settings) return unavailable;
		if (settings.repoSlug === null) return hostedOnly;
		const [device, inode] = layout.rootIdentity.split(" ");
		return {
			kind: "checkout",
			checkout: {
				root: layout.root,
				repoSlug: settings.repoSlug,
				worktreeId: worktreeIdentity(layout),
				device,
				inode,
			},
		};
	} catch {
		// Git, filesystem and configuration errors do not establish a hosted route.
		return unavailable;
	}
}

/** Verify that the same checkout identity still owns the selected root.
 * @param checkout - Checkout previously authorized by the native caller
 * @param reader - Verified packed reader supplied by the snapshot coordinator
 * @returns Whether its current root, origin and worktree still match
 */
export function sameLocalCheckout(checkout: VerifiedCheckout, reader?: string): boolean {
	// Snapshot rechecks can wait longer than a native hook for Windows Git startup.
	const current =
		process.platform === "win32" && reader
			? resolveWindowsCheckout(checkout.root, reader, WINDOWS_SNAPSHOT_SCOPE_TIMEOUT_MS)
			: resolveLocalCheckout(checkout.root, reader);
	return (
		current.kind === "checkout" &&
		current.checkout.worktreeId === checkout.worktreeId &&
		current.checkout.repoSlug === checkout.repoSlug
	);
}

function trackedPaths(output: string, rejectSparse = false) {
	const files = new Set<string>();
	const nonRegular = new Set<string>();
	const gitlinks = new Set<string>();
	for (const row of output.split("\0")) {
		if (!row) continue;
		const match = /^(\d{6}) [a-f\d]+ ([0-3])\t([\s\S]+)$/.exec(row);
		if (!match || match[2] !== "0" || (rejectSparse && match[1] === "040000")) return;
		if (match[1] === "100644" || match[1] === "100755") files.add(match[3]);
		else nonRegular.add(match[3]);
		if (match[1] === "160000") gitlinks.add(match[3]);
	}
	return { files, nonRegular, gitlinks };
}

function windowsInventoryNames(reader: string, layout: GitLayout, deadline: number) {
	const result = runWindowsReader(
		reader,
		["inventory", layout.root, ...layout.rootIdentity.split(" ")],
		deadline,
		MAX_GIT_INVENTORY,
	);
	if (result.error || result.status !== 0 || (result.stdout && !result.stdout.endsWith("\0")))
		return;
	const paths = result.stdout.split("\0");
	paths.pop();
	const spelling = new Map<string, string>();
	for (const path of paths) {
		if (path.includes("\ufffd") || Buffer.byteLength(path) > 4096) return;
		let prefix = "";
		for (const part of path.split("/")) {
			if (
				!part ||
				/[\\:<>"|?*]|[ .]$/.test(part) ||
				[...part].some((char) => char.charCodeAt(0) < 32) ||
				part.toLowerCase() === ".git"
			)
				return;
			prefix = prefix ? `${prefix}/${part}` : part;
			const key = prefix.toLowerCase();
			const prior = spelling.get(key);
			if (prior !== undefined && prior !== prefix) return;
			spelling.set(key, prefix);
		}
	}
	return paths;
}

function untrackedPaths(
	paths: readonly string[],
	tracked: NonNullable<ReturnType<typeof trackedPaths>>,
	ignoreCase: boolean,
) {
	const key = (path: string) => (ignoreCase ? path.toLowerCase() : path);
	const known = new Set([...tracked.files, ...tracked.nonRegular].map(key));
	const submodules = new Set([...tracked.gitlinks].map(key));
	return paths.filter((path) => {
		if (known.has(key(path))) return false;
		for (let end = path.lastIndexOf("/"); end >= 0; end = path.lastIndexOf("/", end - 1)) {
			if (submodules.has(key(path.slice(0, end)))) return false;
		}
		return true;
	});
}

/** Run Git only against private projected metadata and an empty worktree scaffold. */
function windowsInventory(
	checkout: VerifiedCheckout,
	reader: string,
	deadline: number,
): string[] | undefined {
	const layout = windowsLayout(checkout.root, reader, deadline);
	if (!layout || worktreeIdentity(layout) !== checkout.worktreeId) return;
	const windows = resolveTrustedGitWin(reader, deadline);
	if (!windows) return;
	const sameGitDirectory = layout.gitIdentity === layout.commonIdentity;
	const commonPaths = ["config", "info/exclude", ...(sameGitDirectory ? ["index"] : [])];
	const common = confinedMetadata(
		reader,
		layout.commonDir,
		layout.commonIdentity,
		commonPaths,
		deadline,
	);
	const index = (
		sameGitDirectory
			? common
			: confinedMetadata(reader, layout.gitDir, layout.gitIdentity, ["index"], deadline)
	)?.get("index");
	const exclude = common?.get("info/exclude");
	const settings = windowsRepoSettings(windows, common?.get("config"), deadline);
	if (
		!settings ||
		settings.repoSlug !== checkout.repoSlug ||
		!index ||
		index.status > 1 ||
		!exclude ||
		exclude.status > 1
	)
		return;
	const paths = windowsInventoryNames(reader, layout, deadline);
	if (!paths) return;
	const ignoreNames = paths.filter(
		(path) => path.split("/").at(-1)?.toLowerCase() === ".gitignore",
	);
	const ignores = confinedMetadata(reader, layout.root, layout.rootIdentity, ignoreNames, deadline);
	// The native inventory omits direct ignore symlinks. A listed ignore file
	// that disappeared or became unsafe cannot be treated as a removed rule.
	if (!ignores || [...ignores.values()].some((metadata) => metadata.status !== 0)) return;

	const privateParent = join(homedir(), ".pharaoh");
	const parentCheck = runWindowsReader(
		reader,
		["private-path", "ensure-directory", privateParent],
		deadline,
	);
	if (parentCheck.error || parentCheck.status !== 0) return;
	let scratch: string | undefined;
	try {
		scratch = mkdtempSync(join(privateParent, "local-inventory-"));
		const scratchCheck = runWindowsReader(reader, ["private-path", "directory", scratch], deadline);
		if (scratchCheck.error || scratchCheck.status !== 0) return;
		return projectedInventory(
			scratch,
			settings,
			index,
			exclude,
			paths,
			ignores,
			deadline,
			(args, input) => windowsGit(windows, args, deadline, MAX_GIT_INVENTORY, input),
		);
	} catch {
		// A private projection failure cannot make the original paths available to Git.
		return undefined;
	} finally {
		if (scratch) rmSync(scratch, { force: true, recursive: true, maxRetries: 2, retryDelay: 20 });
	}
}

function projectedInventory(
	scratch: string,
	settings: RepoSettings,
	index: CapturedMetadata,
	exclude: CapturedMetadata,
	paths: readonly string[],
	ignores: ReadonlyMap<string, CapturedMetadata>,
	deadline: number,
	runGit: (args: readonly string[], input?: Buffer) => ReturnType<typeof windowsGit>,
): string[] | undefined {
	const gitDir = join(scratch, "git");
	const worktree = join(scratch, "worktree");
	const empty = join(scratch, "empty-excludes");
	for (const directory of [
		worktree,
		join(gitDir, "objects"),
		join(gitDir, "refs"),
		join(gitDir, "info"),
	]) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	const write = (path: string, contents: string | Buffer) =>
		writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
	write(empty, "");
	write(join(gitDir, "HEAD"), "ref: refs/heads/inventory\n");
	const sha256 = settings.objectFormat === "sha256";
	write(
		join(gitDir, "config"),
		`[core]\nrepositoryformatversion=${sha256 ? 1 : 0}\nbare=false\nignorecase=${settings.ignoreCase}\n${sha256 ? "[extensions]\nobjectformat=sha256\n" : ""}`,
	);
	if (index.status === 0) write(join(gitDir, "index"), index.bytes);
	if (exclude.status === 0) write(join(gitDir, "info", "exclude"), exclude.bytes);
	const flags = [
		"-C",
		worktree,
		`--git-dir=${gitDir}`,
		`--work-tree=${worktree}`,
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.untrackedCache=false",
		"-c",
		"core.longpaths=true",
		"-c",
		`core.excludesFile=${empty}`,
	];
	// A split index cannot resolve its shared file in this empty repository.
	// Do not expand sparse directories via repository object storage.
	const listing = runGit([...flags, "ls-files", "--stage", "--sparse", "-z"]);
	if (listing.error || listing.status !== 0) return;
	const tracked = trackedPaths(listing.stdout, true);
	if (!tracked) return;
	const untracked = untrackedPaths(paths, tracked, settings.ignoreCase);
	if (!untracked.length) return [...tracked.files].sort();
	const directories = new Set(untracked.map((path) => dirname(join(worktree, ...path.split("/")))));
	for (const path of directories) {
		if (performance.now() >= deadline) return;
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	for (const [path, metadata] of ignores) {
		if (performance.now() >= deadline) return;
		const target = join(worktree, ...path.split("/"));
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		write(target, metadata.bytes);
	}
	const input = Buffer.from(`${untracked.join("\0")}\0`);
	const ignored = runGit([...flags, "check-ignore", "--no-index", "-z", "--stdin"], input);
	if (
		ignored.error ||
		(ignored.status !== 0 && ignored.status !== 1) ||
		(ignored.stdout && !ignored.stdout.endsWith("\0"))
	)
		return;
	const excluded = new Set(ignored.stdout.split("\0"));
	return [...tracked.files, ...untracked.filter((path) => !excluded.has(path))].sort();
}

/** Enumerate candidate names only. All selected bytes are still read by openat. */
function posixInventoryNames(layout: GitLayout, deadline: number): string[] | undefined {
	const paths: string[] = [];
	let entries = 0;
	let bytes = 0;
	const device = layout.rootIdentity.split(" ")[0];
	const directories = [""];
	for (;;) {
		const prefix = directories.pop();
		if (prefix === undefined) return paths;
		const path = join(layout.root, prefix);
		const identity = posixDirectoryIdentity(path);
		if (!identity || !identity.startsWith(`${device} `)) return;
		if (!prefix && identity !== layout.rootIdentity) return;
		if (prefix && lstatSync(join(path, ".git"), { throwIfNoEntry: false })) continue;
		const directory = opendirSync(path);
		try {
			for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
				if (++entries > MAX_POSIX_INVENTORY_ENTRIES || performance.now() >= deadline) return;
				const name = entry.name;
				if (name.toLowerCase() === ".git") continue;
				const relative = prefix ? `${prefix}/${name}` : name;
				if (
					relative.includes("\ufffd") ||
					relative.includes("\\") ||
					Buffer.byteLength(relative) > 4096
				)
					return;
				if (entry.isDirectory()) {
					if (
						!name.startsWith(".") &&
						!SKIP_INVENTORY_DIRECTORIES.has(name) &&
						!/[-_]dist$/.test(name)
					)
						directories.push(relative);
				} else if (entry.isFile() || (entry.isSymbolicLink() && name !== ".gitignore")) {
					bytes += Buffer.byteLength(relative) + 1;
					if (bytes > MAX_GIT_INVENTORY) return;
					paths.push(relative);
				}
			}
		} finally {
			directory.closeSync();
		}
		if (posixDirectoryIdentity(path) !== identity) return;
	}
}

function posixInventory(
	checkout: VerifiedCheckout,
	reader: string,
	deadline: number,
): string[] | undefined {
	const executable = GIT_LOCATIONS.find(existsSync);
	if (!executable) return;
	let scratch: string | undefined;
	try {
		const layout = posixLayout(checkout.root, reader, deadline);
		if (!layout || worktreeIdentity(layout) !== checkout.worktreeId) return;
		const common = confinedMetadata(
			reader,
			layout.commonDir,
			layout.commonIdentity,
			["config", "info/exclude"],
			deadline,
		);
		const index = confinedMetadata(
			reader,
			layout.gitDir,
			layout.gitIdentity,
			["index"],
			deadline,
		)?.get("index");
		const exclude = common?.get("info/exclude");
		const settings = posixRepoSettings(executable, common?.get("config"), deadline);
		if (
			!settings ||
			settings.repoSlug !== checkout.repoSlug ||
			!index ||
			index.status > 1 ||
			!exclude ||
			exclude.status > 1
		)
			return;
		const paths = posixInventoryNames(layout, deadline);
		if (!paths) return;
		const ignoreNames = paths.filter((path) => basename(path) === ".gitignore");
		const ignores = confinedMetadata(
			reader,
			layout.root,
			layout.rootIdentity,
			ignoreNames,
			deadline,
		);
		if (!ignores || [...ignores.values()].some((metadata) => metadata.status !== 0)) return;
		const privateRoot = mkdtempSync(join(realpathSync(tmpdir()), "pharaoh-local-inventory-"));
		scratch = privateRoot;
		return projectedInventory(
			scratch,
			settings,
			index,
			exclude,
			paths,
			ignores,
			deadline,
			(args, input) => posixGit(executable, privateRoot, args, MAX_GIT_INVENTORY, deadline, input),
		);
	} catch {
		// Never recover from an unverified metadata projection by pointing Git at the checkout.
		return undefined;
	} finally {
		if (scratch) rmSync(scratch, { force: true, recursive: true });
	}
}

/**
 * List saved worktree candidates without checking out files or invoking Git filters.
 * @param checkout - Current verified checkout
 * @param reader - Verified packed reader supplied by the snapshot coordinator
 * @param deadline - Optional tighter limit for best-effort hook checks
 * @returns Repository-relative regular index and nonignored untracked paths, or undefined on failure
 */
export function listLocalCheckoutPaths(
	checkout: VerifiedCheckout,
	reader?: string,
	deadline = performance.now() + INVENTORY_TIMEOUT_MS,
): string[] | undefined {
	if (!reader || performance.now() >= deadline) return;
	return process.platform === "win32"
		? windowsInventory(checkout, reader, deadline)
		: posixInventory(checkout, reader, deadline);
}
