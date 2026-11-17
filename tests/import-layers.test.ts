/**
 * No file in the package imports itself back through others. Codebase Health
 * counts every import inside a cycle, the way this reads them: type-only
 * imports skipped, literal dynamic imports kept, and `../dist/` read as `src/`.
 *
 * Breaks when: a file imports one that imports it back, directly or around a loop.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const DIRECTORIES = ["src", "src/local", "runtime", "project-memory", "hooks"];

/** A package path as its source: built output read as src/, a `.js` import as its `.ts`. */
function source(from: string, specifier: string): string {
	const path = posix.normalize(posix.join(posix.dirname(from), specifier));
	if (path.startsWith("dist/")) return `src/${path.slice(5).replace(/\.js$/, ".ts")}`;
	return path.endsWith(".js") && path.startsWith("src/") ? path.replace(/\.js$/, ".ts") : path;
}

/** What one file imports at run time, as package paths. */
function importsOf(file: string): string[] {
	const text = readFileSync(join(ROOT, file), "utf8");
	const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const imports: string[] = [];
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
		if (specifier?.startsWith(".")) imports.push(source(file, specifier));
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return imports;
}

const files = DIRECTORIES.flatMap((directory) =>
	readdirSync(join(ROOT, directory))
		.filter((name) => /\.(?:ts|mjs)$/.test(name) && !name.endsWith(".d.mts"))
		.map((name) => `${directory}/${name}`),
);
const imports = new Map(files.map((file) => [file, importsOf(file)]));

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
	for (const [file, targets] of imports)
		for (const target of targets) {
			const [from, to] = [group(file), group(target)];
			if (from !== to) graph.set(from, (graph.get(from) ?? new Set()).add(to));
		}
	return graph;
}

it("no file imports itself back through others", () => {
	expect(cycle(graphOf((file) => file))).toEqual([]);
});
