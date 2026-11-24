/** Runs a project's own ESLint in a process separate from the authenticated CLI. */
import { createRequire } from "node:module";
import { relative, resolve, sep } from "node:path";

const cwd = process.cwd();
try {
	const require = createRequire(resolve(cwd, "package.json"));
	const { ESLint } = require("eslint");
	if (ESLint.configType !== "flat") throw new Error("requires a project ESLint flat config");
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const findings = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const rule = (severity) => ({
		meta: { type: "problem", schema: [] },
		create(context) {
			const file = relative(cwd, context.filename).split(sep).join("/");
			const matches = findings.filter((f) => f.file === file && f.severity === severity);
			return {
				Program() {
					for (const f of matches)
						context.report({
							loc: { line: f.line, column: Math.max(0, f.column - 1) },
							message: `${f.ruleId}: ${f.message}`,
						});
				},
			};
		},
	});
	const overlay = {
		plugins: { "pharaoh-design": { rules: { error: rule("error"), warning: rule("warning") } } },
		rules: { "pharaoh-design/error": "error", "pharaoh-design/warning": "warn" },
	};
	const eslint = new ESLint({ cwd, overrideConfig: [overlay] });
	const results = await eslint.lintFiles(["."]);
	const formatter = await eslint.loadFormatter("stylish");
	process.stderr.write(await formatter.format(results));
	process.exitCode = results.some((r) => r.errorCount > 0) ? 1 : 0;
} catch {
	process.stderr.write(
		"Could not load the project's ESLint flat config. Check the native lint command or enable standalone design lint.\n",
	);
	process.exitCode = 2;
}
