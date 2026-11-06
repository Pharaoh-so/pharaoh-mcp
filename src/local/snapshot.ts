/** Captures bounded saved worktree inputs through the confined native reader. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, posix } from "node:path";
import type { VerifiedCheckout } from "./dispatch.js";
import { listLocalCheckoutPaths, sameLocalCheckout } from "./scope.js";

const MAX_FILES = 2_048;
const MAX_PATH_BYTES = 4_096;
const MAX_FILE_BYTES = 1_000_000;
const MAX_BYTES = 32 * 1_024 * 1_024;
const MAX_EXTENDS_DEPTH = 16;
const MAX_EXTENDS_FILES = 32;
const FRAME_BYTES = 5;
const READER_TIMEOUT_MS = 10_000;
const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".vue",
	".py",
]);
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	"compiled",
]);
const CONFIG_NAME =
	/^(?:tsconfig(?:\.[a-z\d_.-]+)?\.json|jsconfig\.json|package\.json|manifest\.json|pyproject\.toml|nuxt\.config\.[cm]?[jt]s)$/i;
const TS_CONFIG_NAME = /^(?:tsconfig(?:\.[a-z\d_.-]+)?|jsconfig)\.json$/i;
const MINIFIED_NAME = /\.(?:min\.[cm]?js|bundle\.[m]?js)$/i;

interface Candidate {
	readonly path: string;
	readonly kind: "source" | "config";
}

/** Saved inputs and a fingerprint that never leaves the local process. */
export interface LocalSnapshot {
	/** Repository-relative source bytes. */
	readonly sources: ReadonlyMap<string, Uint8Array>;
	/** Repository-relative resolver inputs, decoded as inert text. */
	readonly configFiles: ReadonlyMap<string, string>;
	/** A read or content policy omitted one or more candidates. */
	readonly incomplete: boolean;
	/** Comparison key for before-delivery revalidation. */
	readonly fingerprint: string;
	/** Capture completion time, for the local answer. */
	readonly capturedAt: number;
}

function eligibleName(path: string): string | undefined {
	const segments = path.split("/");
	if (
		path.includes("\\") ||
		path.includes("\ufffd") ||
		Buffer.byteLength(path) > MAX_PATH_BYTES ||
		segments.some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
		segments.slice(0, -1).some((part) => SKIP_DIRS.has(part) || /[-_]dist$/.test(part))
	)
		return;
	return segments.at(-1);
}

function candidates(paths: readonly string[]): Candidate[] {
	const selected: Candidate[] = [];
	for (const path of paths) {
		const name = eligibleName(path);
		if (!name) continue;
		if (CONFIG_NAME.test(name)) selected.push({ path, kind: "config" });
		else if (SOURCE_EXTENSIONS.has(posix.extname(name)) && !MINIFIED_NAME.test(name))
			selected.push({ path, kind: "source" });
	}
	return selected;
}

function encode(items: readonly Candidate[]): Buffer {
	return Buffer.concat(
		items.flatMap(({ path }) => {
			const bytes = Buffer.from(path, "utf8");
			const length = Buffer.alloc(2);
			length.writeUInt16BE(bytes.length);
			return [length, bytes];
		}),
	);
}

async function readConfined(
	reader: string,
	checkout: VerifiedCheckout,
	items: readonly Candidate[],
	signal: AbortSignal,
): Promise<Buffer> {
	if (!isAbsolute(reader)) throw new Error("Local reader unavailable");
	signal.throwIfAborted();
	return await new Promise<Buffer>((resolve, reject) => {
		const output: Buffer[] = [];
		let size = 0;
		let failed = false;
		const child = spawn(reader, [checkout.root, checkout.device, checkout.inode], {
			cwd: dirname(reader),
			env: {},
			stdio: ["pipe", "pipe", "ignore"],
			signal,
			killSignal: "SIGKILL",
			timeout: READER_TIMEOUT_MS,
			windowsHide: true,
		});
		child.on("error", () => {
			failed = true;
		});
		child.stdin.on("error", () => {
			failed = true;
			child.kill("SIGKILL");
		});
		child.stdout.on("data", (chunk: Buffer) => {
			if (failed) return;
			size += chunk.length;
			if (size > MAX_BYTES + FRAME_BYTES * items.length) {
				failed = true;
				child.kill("SIGKILL");
				return;
			}
			output.push(chunk);
		});
		child.once("close", (code) => {
			if (failed || code !== 0 || signal.aborted) reject(new Error("Local snapshot unavailable"));
			else resolve(Buffer.concat(output, size));
		});
		child.stdin.end(encode(items));
	});
}

function decode(output: Buffer, items: readonly Candidate[]): LocalSnapshot {
	const sources = new Map<string, Uint8Array>();
	const configFiles = new Map<string, string>();
	const fingerprint = createHash("sha256");
	let incomplete = false;
	let offset = 0;
	for (const { path, kind } of items) {
		if (offset + FRAME_BYTES > output.length) throw new Error("Incomplete local snapshot frame");
		const status = output.readUInt8(offset);
		const size = output.readUInt32BE(offset + 1);
		offset += FRAME_BYTES;
		if (
			status > 5 ||
			(status !== 0 && size !== 0) ||
			size > MAX_FILE_BYTES ||
			offset + size > output.length
		)
			throw new Error("Invalid local snapshot frame");
		if (status === 4) throw new Error("Worktree changed while reading");
		const bytes = output.subarray(offset, offset + size);
		offset += size;
		fingerprint.update(JSON.stringify([path, kind, status, size])).update(bytes);
		if (status !== 0) {
			// A tracked file can be deleted in the working tree; absence is authoritative.
			if (status !== 1) incomplete = true;
		} else if (kind === "source") sources.set(path, bytes);
		else configFiles.set(path, bytes.toString("utf8"));
	}
	if (offset !== output.length) throw new Error("Unexpected local snapshot frame");
	return {
		sources,
		configFiles,
		incomplete,
		fingerprint: fingerprint.digest("hex"),
		capturedAt: Date.now(),
	};
}

function configDependencies(path: string, text: string): { paths: string[]; incomplete: boolean } {
	// Comments and trailing commas are allowed. Preserve both inside quoted values.
	const uncommented = text.replace(
		/"(?:[^"\\]|\\[\s\S])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
		(token) => (token.startsWith('"') ? token : " "),
	);
	const json = JSON.parse(
		uncommented
			.trim()
			.replace(/"(?:[^"\\]|\\[\s\S])*"|,(?=\s*[}\]])/g, (token) => (token === "," ? "" : token)),
	);
	if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Invalid config");
	const directory = posix.dirname(path);
	const paths: string[] = [];
	const normalize = (value: unknown): string | undefined => {
		if (typeof value !== "string" || posix.isAbsolute(value) || /[\\:]/.test(value)) return;
		const target = posix.normalize(posix.join(directory, value));
		if (eligibleName(target) && posix.extname(target).toLowerCase() === ".json") return target;
	};
	const parent =
		typeof json.extends === "string" && /^\.\.?\//.test(json.extends) && normalize(json.extends);
	if (parent) paths.push(parent);
	// A solution config can inherit app aliases from an adjacent referenced file.
	const solution =
		json.include === undefined &&
		(json.files === undefined || (Array.isArray(json.files) && json.files.length === 0));
	if (solution && Array.isArray(json.references)) {
		for (const reference of json.references) {
			const target = normalize(reference?.path);
			if (target && posix.dirname(target) === directory) paths.push(target);
		}
	}
	return { paths, incomplete: json.extends !== undefined && !parent };
}

async function captureInheritedConfigs(
	snapshot: LocalSnapshot,
	files: readonly Candidate[],
	inventory: readonly string[],
	bytes: number,
	read: (items: Candidate[]) => Promise<Buffer>,
): Promise<LocalSnapshot> {
	const configFiles = new Map(snapshot.configFiles);
	const available = new Set(inventory);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const fingerprint = createHash("sha256").update(snapshot.fingerprint);
	let incomplete = snapshot.incomplete;
	let additional = 0;
	const visit = async (path: string, depth: number): Promise<void> => {
		if (visited.has(path)) return;
		if (visiting.has(path) || depth > MAX_EXTENDS_DEPTH) {
			incomplete = true;
			return;
		}
		let content = configFiles.get(path);
		if (content === undefined) {
			if (
				!available.has(path) ||
				additional >= MAX_EXTENDS_FILES ||
				files.length + additional >= MAX_FILES ||
				MAX_BYTES - bytes < MAX_FILE_BYTES
			) {
				incomplete = true;
				return;
			}
			const item: Candidate = { path, kind: "config" };
			const frame = await read([item]);
			const parent = decode(frame, [item]);
			additional++;
			bytes += frame.length - FRAME_BYTES;
			fingerprint.update(parent.fingerprint);
			content = parent.configFiles.get(path);
			if (content === undefined) {
				incomplete = true;
				return;
			}
			configFiles.set(path, content);
		}
		let dependencies: ReturnType<typeof configDependencies> | undefined;
		try {
			dependencies = configDependencies(path, content);
		} catch {
			incomplete = true;
		}
		visiting.add(path);
		if (dependencies) {
			incomplete ||= dependencies.incomplete;
			for (const dependency of dependencies.paths) await visit(dependency, depth + 1);
		}
		visiting.delete(path);
		visited.add(path);
	};
	for (const path of snapshot.configFiles.keys()) {
		if (TS_CONFIG_NAME.test(posix.basename(path))) await visit(path, 0);
	}
	return {
		...snapshot,
		configFiles,
		incomplete,
		fingerprint: fingerprint.update(incomplete ? "1" : "0").digest("hex"),
		capturedAt: Date.now(),
	};
}

/**
 * Read the selected checkout without repository-supplied commands or symlink traversal.
 * @param checkout - Verified worktree from the native hook or CLI invocation
 * @param reader - Trusted absolute path to the packaged native reader
 * @param signal - Cancellation for the reader subprocess
 * @returns Saved-file capture used for one local query
 */
export async function captureLocalSnapshot(
	checkout: VerifiedCheckout,
	reader: string,
	signal: AbortSignal,
): Promise<LocalSnapshot> {
	if (!sameLocalCheckout(checkout, reader)) throw new Error("Worktree identity changed");
	const inventory = listLocalCheckoutPaths(checkout, reader);
	if (!inventory) throw new Error("Worktree inventory unavailable");
	const files = candidates(inventory);
	if (files.length > MAX_FILES) throw new Error("Worktree exceeds the local file limit");
	const output = await readConfined(reader, checkout, files, signal);
	const snapshot = await captureInheritedConfigs(
		decode(output, files),
		files,
		inventory,
		output.length - FRAME_BYTES * files.length,
		(items) => readConfined(reader, checkout, items, signal),
	);
	if (!sameLocalCheckout(checkout, reader)) throw new Error("Worktree identity changed");
	return snapshot;
}
