import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

const LIMIT = 256 * 1024;
export const MEMORY_RUNTIME_FILES = [
	"execute-turn.mjs",
	"hook-config.mjs",
	"hook-events.mjs",
	"local.mjs",
	"memory-api.mjs",
	"pharaoh-memory-hook.mjs",
	"pharaoh-memory.mjs",
	"user-target.mjs",
	"runtime/credentials.js",
	"runtime/package.json",
	"runtime/refresh.js",
];

function digest(files) {
	return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

export function privateMemoryPath(path, directory) {
	const stat = lstatSync(path);
	if (
		(directory ? !stat.isDirectory() : !stat.isFile()) ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o077) !== 0
	) {
		throw new Error("Project memory needs a regular owner-private bundle path.");
	}
	return stat;
}

/** Read only the executable closure from the installed npm package. */
export function packagedMemoryBundle(packageRoot = new URL("../", import.meta.url)) {
	const files = MEMORY_RUNTIME_FILES.map((name) => {
		let bytes;
		if (name === "runtime/package.json") {
			bytes = Buffer.from('{"type":"module"}\n');
		} else {
			const location = name.startsWith("runtime/")
				? new URL(`dist/${name.slice(8)}`, packageRoot)
				: new URL(`project-memory/${name}`, packageRoot);
			try {
				bytes = readFileSync(location);
			} catch {
				throw new Error("The Pharaoh package is missing its project memory runtime.");
			}
			if (name === "runtime/refresh.js" && !bytes.includes("function originBoundRefresh(")) {
				throw new Error("The packaged refresh helper is incompatible with project memory.");
			}
		}
		return [name, bytes.toString("base64")];
	});
	const sha256 = digest(files);
	if (Buffer.byteLength(JSON.stringify(files)) >= LIMIT)
		throw new Error("Project memory bundle is oversized.");
	return { sha256, files };
}

export function installMemoryBundle(root, target, bundle) {
	// Check the nearest existing parent before creating anything, including a
	// requested path whose parent is a symlink into the checkout.
	let parent = root;
	for (;;) {
		try {
			const resolved = join(realpathSync(parent), relative(parent, root));
			const within = target ? relative(target, resolved) : "..";
			if (!within || (!within.startsWith("../") && within !== "..")) {
				throw new Error("Install the project memory bundle outside the enrolled checkout.");
			}
			break;
		} catch (error) {
			if (error.code !== "ENOENT" || parent === dirname(parent)) throw error;
			parent = dirname(parent);
		}
	}
	mkdirSync(root, { recursive: true, mode: 0o700 });
	privateMemoryPath(root, true);
	const destination = join(realpathSync(root), bundle.sha256);
	function verifyExisting() {
		try {
			privateMemoryPath(destination, true);
		} catch (error) {
			if (error.code === "ENOENT") return false;
			throw error;
		}
		privateMemoryPath(join(destination, "runtime"), true);
		for (const [name, content] of bundle.files) {
			const path = join(destination, name);
			if (
				privateMemoryPath(path, false).size > LIMIT ||
				readFileSync(path).toString("base64") !== content
			) {
				throw new Error(
					"Installed project memory bundle was modified. Remove it before reinstalling.",
				);
			}
		}
		return true;
	}
	if (verifyExisting()) return destination;
	const staging = mkdtempSync(join(root, ".memory-client-"));
	try {
		mkdirSync(join(staging, "runtime"), { mode: 0o700 });
		for (const [name, content] of bundle.files) {
			writeFileSync(join(staging, name), Buffer.from(content, "base64"), {
				flag: "wx",
				mode: 0o600,
			});
		}
		try {
			renameSync(staging, destination);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !verifyExisting()) throw error;
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	return destination;
}

/** Derive a hook executable path from the reviewed installation, never from cwd. */
export function bundledHook(root) {
	return join(root, "pharaoh-memory-hook.mjs");
}
