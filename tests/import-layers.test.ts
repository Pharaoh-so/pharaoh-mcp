/**
 * The package's imports run one way: no file imports itself back through
 * others, and its directories import downward from src/ (the composition
 * root) to src/local, runtime/ and project-memory/. Codebase Health counts
 * every import inside a cycle, the way this reads them: type-only imports
 * skipped, literal dynamic imports kept, and `../dist/` read as `src/`.
 * runtime/ files run from installed hook commands, so the compiled code a hook
 * needs is loaded by its place in the build (src/local-host.ts), never imported.
 *
 * Breaks when:
 * - a file imports one that imports it back, directly or around a loop
 * - a file imports from a directory that imports it back
 * - runtime/ reaches a new built file by path, or one whose source is gone
 * - the hook reads an export or function the composition root doesn't provide
 *   (the hook swallows its errors, so it would stop answering silently)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const DIRECTORIES = ["src", "src/local", "runtime", "project-memory", "hooks"];
const BUILT = /^\.\.\/dist\/(.+)\.js$/;

/** A package path as its source: built output read as src/, a `.js` import as its `.ts`. */
function source(from: string, specifier: string): string {
	const path = posix.normalize(posix.join(posix.dirname(from), specifier));
	if (path.startsWith("dist/")) return `src/${path.slice(5).replace(/\.js$/, ".ts")}`;
	return path.endsWith(".js") && path.startsWith("src/") ? path.replace(/\.js$/, ".ts") : path;
}

/** What one file imports at run time, and the built files it loads by path. */
function readFile(file: string): { imports: string[]; built: string[] } {
	const text = readFileSync(join(ROOT, file), "utf8");
	const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const imports: string[] = [];
	const built: string[] = [];
	const literal = (node: ts.Node | undefined) =>
		node && ts.isStringLiteral(node) ? node.text : undefined;
	const visit = (node: ts.Node) => {
		let specifier: string | undefined;
		if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
			specifier = literal(node.moduleSpecifier);
		else if (ts.isExportDeclaration(node) && !node.isTypeOnly)
			specifier = literal(node.moduleSpecifier);
		else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
			specifier = literal(node.arguments[0]);
		else if (ts.isNewExpression(node) && node.expression.getText() === "URL") {
			const path = literal(node.arguments?.[0]);
			if (path && BUILT.test(path)) built.push(source(file, path));
		}
		if (specifier?.startsWith(".")) imports.push(source(file, specifier));
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return { imports, built };
}

const files = DIRECTORIES.flatMap((directory) =>
	readdirSync(join(ROOT, directory))
		.filter((name) => /\.(?:ts|mjs)$/.test(name) && !name.endsWith(".d.mts"))
		.map((name) => `${directory}/${name}`),
);
const read = new Map(files.map((file) => [file, readFile(file)]));

/** One cycle in `graph`, as the nodes around it back to the first; empty when there is none. */
function cycle(graph: Map<string, Set<string>>): string[] {
	const done = new Set<string>();
	const path: string[] = [];
	const visit = (node: string): string[] => {
		if (path.includes(node)) return [...path.slice(path.indexOf(node)), node];
		if (done.has(node)) return [];
		path.push(node);
		for (const next of graph.get(node) ?? []) {
			const found = visit(next);
			if (found.length > 0) return found;
		}
		path.pop();
		done.add(node);
		return [];
	};
	for (const node of graph.keys()) {
		const found = visit(node);
		if (found.length > 0) return found;
	}
	return [];
}

/** The import graph with each file replaced by `group(file)`, without self-links. */
function graphOf(group: (file: string) => string): Map<string, Set<string>> {
	const graph = new Map<string, Set<string>>();
	for (const [file, { imports }] of read)
		for (const target of imports) {
			const [from, to] = [group(file), group(target)];
			if (from !== to) graph.set(from, (graph.get(from) ?? new Set()).add(to));
		}
	return graph;
}

it("no file imports itself back through others", () => {
	expect(cycle(graphOf((file) => file))).toEqual([]);
});

it("imports between directories run one way", () => {
	expect(cycle(graphOf(dirname))).toEqual([]);
});

it("reaches the build by path only where runtime/ means to, and those sources exist", () => {
	// The one deliberate exception to the import graph: the hook's analysis
	// (src/local-host.ts), loaded by path, and the entry registrations name (src/index.ts).
	const built = [...read.values()].flatMap((file) => file.built).sort();
	expect(built).toEqual(["src/index.ts", "src/local-host.ts", "src/native-feed-maintenance.ts"]);
	expect(built.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
});

it("finds every function the hook command reads in the module it loads", async () => {
	const hook = "runtime/local-worktree-hook.mjs";
	const text = readFileSync(join(ROOT, hook), "utf8");
	const tree = ts.createSourceFile(hook, text, ts.ScriptTarget.Latest, true);
	let exported: string | undefined;
	const names: string[] = [];
	const visit = (node: ts.Node) => {
		// `(await import(ANALYSIS.href)).<export>` and `const { ... } = await loadAnalysis()`
		if (
			ts.isPropertyAccessExpression(node) &&
			/import\(ANALYSIS\.href\)/.test(node.expression.getText())
		)
			exported = node.name.text;
		if (
			ts.isVariableDeclaration(node) &&
			ts.isObjectBindingPattern(node.name) &&
			node.initializer?.getText() === "await loadAnalysis()"
		)
			for (const element of node.name.elements) names.push(element.name.getText());
		ts.forEachChild(node, visit);
	};
	visit(tree);
	expect(exported).toBe("worktreeHookAnalysis");
	expect(names).toHaveLength(6);
	const analysis = (await import("../src/local-host.js"))[exported as "worktreeHookAnalysis"];
	expect(names.filter((name) => typeof Reflect.get(analysis, name) !== "function")).toEqual([]);
});
