/** Starts the pinned analyzer with captured bytes and no checkout or credentials. */

import { fork } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setWindowsPrivatePathHelper } from "../../runtime/runtime-storage.mjs";
import type { BlastRoute } from "./dispatch.js";
import type { LocalSnapshot } from "./snapshot.js";

const ANALYZER = "@pharaoh-so/local-analyzer";
const WORKER_DEADLINE_MS = 30_000;
const MAX_ROWS = 2_048;
const MAX_TEXT = 1_024;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[a-z\d.-]+)?$/i;

type Query = Extract<BlastRoute, { kind: "local" }>["query"];

/** A pinned installed analyzer and its reader for this platform. */
export interface LocalAnalyzer {
	/** Trusted package directory used as the worker cwd. */
	readonly root: string;
	/** Shipped analyzer entry. */
	readonly entry: string;
	/** Shipped reader for the current platform and CPU. */
	readonly reader: string;
}

interface Location {
	uid: string;
	name: string;
	file: string;
	module: string;
}

/** Validated worker result for local presentation only. */
export interface LocalAnalysisResult {
	/** Distinguishes missing and incomplete from a known empty result. */
	status: "answered" | "empty" | "missing" | "ambiguous" | "incomplete";
	/** Completeness of the covered call graph. */
	coverage: "complete" | "incomplete";
	/** Maximum number of caller hops queried. */
	depth: number;
	/** Selected targets, or the candidates for an ambiguous selector. */
	targets: Location[];
	/** Known callers and their shortest positive distances. */
	callers: Array<Location & { depth: number }>;
}

function regular(path: string): boolean {
	const metadata = lstatSync(path, { throwIfNoEntry: false });
	return metadata?.isFile() === true && !metadata.isSymbolicLink();
}

function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function location(value: unknown): value is Location & Record<string, unknown> {
	if (!object(value)) return false;
	return ["uid", "name", "file", "module"].every((key) => {
		const part = value[key];
		return typeof part === "string" && part.length > 0 && part.length <= MAX_TEXT;
	});
}

function validResult(value: unknown): value is LocalAnalysisResult {
	if (!object(value)) return false;
	const { status, coverage, depth, targets, callers } = value;
	return (
		typeof status === "string" &&
		["answered", "empty", "missing", "ambiguous", "incomplete"].includes(status) &&
		(coverage === "complete" || coverage === "incomplete") &&
		typeof depth === "number" &&
		Number.isInteger(depth) &&
		depth >= 1 &&
		depth <= 5 &&
		Array.isArray(targets) &&
		targets.length <= MAX_ROWS &&
		targets.every(location) &&
		Array.isArray(callers) &&
		callers.length <= MAX_ROWS &&
		callers.every(
			(row: unknown) =>
				location(row) &&
				typeof row.depth === "number" &&
				Number.isInteger(row.depth) &&
				row.depth >= 1 &&
				row.depth <= depth,
		)
	);
}

function linuxReaderSupported(): boolean {
	// The pinned Linux readers link against GLIBC_2.34. Node reports the
	// loaded runtime version and omits it on musl.
	const report = process.report?.getReport() as
		| { header?: { glibcVersionRuntime?: unknown } }
		| undefined;
	const version = report?.header?.glibcVersionRuntime;
	const match = typeof version === "string" && /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	return major > 2 || (major === 2 && Number(match[2]) >= 34);
}

function expectedAnalyzer(root = fileURLToPath(new URL("../../", import.meta.url))) {
	if (
		!["darwin", "linux", "win32"].includes(process.platform) ||
		!["x64", "arm64"].includes(process.arch)
	)
		return undefined;
	// macOS 15 is the oldest macOS major verified for the published readers.
	if (process.platform === "darwin" && !(Number(release().split(".")[0]) >= 24)) return undefined;
	try {
		const proxyRoot = realpathSync(root);
		const proxyManifest = JSON.parse(readFileSync(join(proxyRoot, "package.json"), "utf8"));
		const version: unknown =
			proxyManifest.optionalDependencies?.[ANALYZER] ?? proxyManifest.dependencies?.[ANALYZER];
		if (typeof version !== "string" || !EXACT_VERSION.test(version)) return undefined;
		if (process.platform === "linux" && !linuxReaderSupported()) return undefined;
		return { proxyRoot, version };
	} catch {
		// No verified pin, so this install does not advertise local analysis.
	}
	return undefined;
}

/**
 * Distinguish an eligible install with damaged assets from a hosted-only build.
 * @returns Whether this proxy declares an exact analyzer pin on a supported platform
 */
export function localAnalyzerExpected(): boolean {
	return expectedAnalyzer() !== undefined;
}

function findInstalledAnalyzer(proxyRoot: string, version: string): LocalAnalyzer | undefined {
	try {
		// npm installs the pinned dependency next to the scoped proxy or below it.
		for (const root of [
			join(dirname(proxyRoot), "local-analyzer"),
			join(proxyRoot, "node_modules", "@pharaoh-so", "local-analyzer"),
		]) {
			if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory() || realpathSync(root) !== root)
				continue;
			const manifest = join(root, "package.json");
			const entry = join(root, "dist", "analyzer.mjs");
			const reader = join(
				root,
				"dist",
				"bin",
				`${process.platform}-${process.arch}`,
				process.platform === "win32" ? "capture.exe" : "capture",
			);
			if (![manifest, entry, reader].every((path) => regular(path) && realpathSync(path) === path))
				continue;
			const installed = JSON.parse(readFileSync(manifest, "utf8"));
			if (installed.name === ANALYZER && installed.version === version)
				return { root, entry, reader };
		}
	} catch {
		// Missing, broken and mismatched packages are all unavailable.
	}
	return undefined;
}

/**
 * Check an installed proxy without launching the reader or changing process state.
 * @param proxyRoot - Package root of the managed proxy installation
 * @returns Whether local is unsupported, its pinned assets need repair, or they are ready
 */
export function localAnalyzerInstallStatus(
	proxyRoot: string,
): "hosted-only" | "repair-needed" | "ready" {
	const expected = expectedAnalyzer(proxyRoot);
	if (!expected) return "hosted-only";
	return findInstalledAnalyzer(expected.proxyRoot, expected.version) ? "ready" : "repair-needed";
}

/**
 * Locate only the version pinned by a trusted installed proxy, without using NODE_PATH or the checkout.
 * @param proxyRoot - Optional managed proxy package root, defaulting to this running package
 * @returns Installed and supported analyzer, or undefined when local is unavailable
 */
export function installedLocalAnalyzer(proxyRoot?: string): LocalAnalyzer | undefined {
	const expected = expectedAnalyzer(proxyRoot);
	if (!expected) return undefined;
	const analyzer = findInstalledAnalyzer(expected.proxyRoot, expected.version);
	if (analyzer && process.platform === "win32") setWindowsPrivatePathHelper(analyzer.reader);
	return analyzer;
}

/**
 * Run a single query in a credential-free worker and return only a bounded graph result.
 * @param analyzer - Verified installed analyzer package
 * @param snapshot - Saved files already captured by the confined reader
 * @param repoName - Authorized canonical repository slug
 * @param query - Local tool selector
 * @param signal - Cancellation from the local request
 * @returns Validated result from one worker
 */
export async function runLocalAnalyzer(
	analyzer: LocalAnalyzer,
	snapshot: LocalSnapshot,
	repoName: string,
	query: Query,
	signal: AbortSignal,
): Promise<LocalAnalysisResult> {
	signal.throwIfAborted();
	return await new Promise<LocalAnalysisResult>((resolve, reject) => {
		const child = fork(analyzer.entry, [], {
			cwd: analyzer.root,
			env: {},
			execArgv: ["--max-old-space-size=384"],
			serialization: "advanced",
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			signal,
			killSignal: "SIGKILL",
		});
		let result: LocalAnalysisResult | undefined;
		let failed = false;
		const deadline = setTimeout(() => {
			failed = true;
			child.kill("SIGKILL");
		}, WORKER_DEADLINE_MS);
		child.once("error", () => {
			failed = true;
		});
		child.on("message", (packet: unknown) => {
			if (result || !object(packet) || !validResult(packet.result)) {
				failed = true;
				child.kill("SIGKILL");
				return;
			}
			result = packet.result;
		});
		child.once("close", (code) => {
			clearTimeout(deadline);
			if (!failed && code === 0 && result && !signal.aborted) resolve(result);
			else reject(new Error("Local analysis unavailable"));
		});
		child.send(
			{
				input: {
					repoName,
					sources: snapshot.sources,
					configFiles: snapshot.configFiles,
					incomplete: snapshot.incomplete,
				},
				query,
			},
			(error) => {
				if (error) {
					failed = true;
					child.kill("SIGKILL");
				}
			},
		);
	});
}
