/** Resolve the installer's activation boundary without reading credentials or writing files. */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import type { InstallScope } from "./install-types.js";

/** Resolve a nested directory or linked worktree to its canonical Git checkout root. */
export function gitWorktreeRoot(directory: string): string | null {
	try {
		const root = execFileSync(
			"git",
			[
				"--no-optional-locks",
				"--no-replace-objects",
				"--no-pager",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.untrackedCache=false",
				"-C",
				directory,
				"rev-parse",
				"--show-toplevel",
			],
			{
				env: {
					...Object.fromEntries(
						Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
					),
					GIT_NO_LAZY_FETCH: "1",
					GIT_ALLOW_PROTOCOL: "",
				},
				encoding: "utf8",
				timeout: 5_000,
				killSignal: "SIGKILL",
				maxBuffer: 16_384,
				stdio: ["ignore", "pipe", "pipe"],
			},
		).trim();
		return root ? realpathSync(root) : null;
	} catch {
		return null;
	}
}

/** Read a path without the yes/no helper's lowercasing; ended input cancels installation. */
export function askInstallPath(question: string): Promise<string | null> {
	return new Promise((resolve) => {
		const input = createInterface({ input: process.stdin, output: process.stderr });
		let answered = false;
		input.once("close", () => {
			if (!answered) resolve(null);
		});
		input.question(question, (answer) => {
			answered = true;
			input.close();
			resolve(answer.trim() || null);
		});
	});
}

/** Parse the flags shared by install and scoped cleanup. */
export function installScopeArguments(args: readonly string[]): {
	kind?: InstallScope["kind"];
	path?: string;
} {
	const kind = args[args.indexOf("--scope") + 1];
	const path = args.includes("--path") ? args[args.indexOf("--path") + 1] : undefined;
	return {
		...(args.includes("--scope") && (kind === "local" || kind === "global") ? { kind } : {}),
		...(path ? { path } : {}),
	};
}

/** Choose Global or resolve Local completely before the installer starts side effects. */
export async function resolveInstallScope(options: {
	kind?: InstallScope["kind"];
	path?: string;
	cwd?: string;
	interactive: boolean;
	choose: (title: string, labels: readonly string[]) => Promise<number | null>;
	askPath: (question: string) => Promise<string | null>;
	resolveRoot?: (path: string) => string | null;
	write: (...lines: string[]) => void;
}): Promise<InstallScope | null> {
	let kind = options.kind;
	if (!kind && options.interactive) {
		const choice = await options.choose("Where should Pharaoh run?", [
			"Global (recommended)",
			"Local",
		]);
		if (choice === null || choice < 0) return null;
		kind = choice === 1 ? "local" : "global";
	}
	if (kind !== "local") return { kind: "global" };
	const resolveRoot = options.resolveRoot ?? gitWorktreeRoot;
	let root = resolveRoot(options.path ?? options.cwd ?? process.cwd());
	while (!root && options.interactive && !options.path) {
		const path = await options.askPath("Repository path (empty cancels): ");
		if (!path) return null;
		root = resolveRoot(path);
		if (!root) options.write("That path is not inside a Git checkout.");
	}
	if (!root)
		throw new Error(
			"Local installation needs a Git checkout. Use --scope local --path <repository>.",
		);
	options.write(`Local installation: ${root}`);
	return { kind: "local", root };
}
