import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { designOrigin, verifyProjection } from "../src/design-projection.js";
import { callerWorkflow } from "../src/design-wiring.js";

const origin = "https://design.example.com";
const binding = { repoId: "42", repoSlug: "team/private" };
const ci = { ...binding, runId: "10", runAttempt: "1", sha: "a".repeat(40) };
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const rules = [
	{
		id: "link",
		kind: "css-token",
		file: "ui/theme.ts",
		template: "THEME",
		selector: "a",
		property: "color",
		token: "--gold",
		theme: "base",
		severity: "error",
	},
];
const payload = {
	schemaVersion: 1,
	...binding,
	iss: origin,
	aud: "pharaoh-design-lint",
	epoch: "e",
	revision: 1,
	visionDigest: "1".repeat(64),
	rules,
	iat: Math.floor(Date.now() / 1000),
	exp: Math.floor(Date.now() / 1000) + 300,
};
function signed(value: unknown, head: Record<string, unknown> = { alg: "EdDSA", kid: "primary" }) {
	const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
	const bytes = [encode(head), encode(value)].join(".");
	return `${bytes}.${sign(null, Buffer.from(bytes), privateKey).toString("base64url")}`;
}
function keys() {
	const fetch = vi.fn(async (url: string, opts: RequestInit) => {
		expect(url).toBe(`${origin}/api/design/keys`);
		expect(opts.redirect).toBe("error");
		expect(opts.headers).toEqual({});
		return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "primary" }] });
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
const signal = () => AbortSignal.timeout(3000);
afterEach(() => vi.unstubAllGlobals());
describe("signed design evaluation boundary", () => {
	it("binds the trusted key to the exact repository and CI attempt", async () => {
		keys();
		const token = signed({ ...payload, ...ci });
		await expect(verifyProjection(origin, token, binding, signal(), ci)).resolves.toMatchObject({
			rules,
			revision: 1,
		});
		await expect(
			verifyProjection(origin, token, binding, signal(), { ...ci, runAttempt: "2" }),
		).rejects.toMatchObject({ code: 2 });
		await expect(verifyProjection(origin, token, binding, signal())).rejects.toMatchObject({
			code: 2,
		});
	});
	it.each([
		{ aud: "generic-mcp" },
		{ repoId: "41" },
		{ iss: "https://other.test" },
		{ exp: 0 },
		{ rules: [{ kind: "unsupported" }] },
	])("rejects invalid policy claims %j", async (change) => {
		keys();
		await expect(
			verifyProjection(origin, signed({ ...payload, ...change }), binding, signal()),
		).rejects.toMatchObject({ code: 2 });
	});
	it("never resolves an artifact-provided signing key or credential origin", async () => {
		const fetch = keys();
		await expect(
			verifyProjection(
				origin,
				signed(payload, { alg: "EdDSA", kid: "primary", jku: "https://attacker.example" }),
				binding,
				signal(),
			),
		).rejects.toMatchObject({ code: 2 });
		expect(fetch).not.toHaveBeenCalled();
		expect(() => designOrigin("https://user:password@host.example")).toThrow();
	});
	it("enrolls VISION.md-only PRs and requires an immutable reusable workflow", () => {
		const caller = callerWorkflow("a".repeat(40), true);
		expect(caller).toContain("on: [push, pull_request]");
		expect(caller).not.toMatch(/paths(-ignore)?:/);
		expect(caller).toContain(`design-lint.yml@${"a".repeat(40)}`);
		expect(() => callerWorkflow("main", false)).toThrow();
	});
});
describe("opt-in native ESLint", () => {
	it("preserves native errors and emits the approved overlay only in the managed run", () => {
		const require = createRequire(import.meta.url);
		const eslintRoot = dirname(require.resolve("eslint/package.json"));
		const root = mkdtempSync(join(tmpdir(), "pharaoh-design-eslint-"));
		try {
			mkdirSync(join(root, "node_modules"));
			symlinkSync(eslintRoot, join(root, "node_modules/eslint"), "junction");
			writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}');
			writeFileSync(
				join(root, "eslint.config.mjs"),
				'export default [{files:["**/*.jsx"],languageOptions:{parserOptions:{ecmaFeatures:{jsx:true}}},rules:{"no-debugger":"error"}}];',
			);
			writeFileSync(join(root, "Button.jsx"), "debugger; export const Button = () => <button/>;");
			const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
			const native = spawnSync(process.execPath, [join(eslintRoot, "bin/eslint.js"), "."], {
				cwd: root,
				env,
				encoding: "utf8",
			});
			expect(native.status).toBe(1);
			expect(native.stdout).toContain("no-debugger");
			expect(native.stdout).not.toContain("pharaoh-design/");
			const entry = fileURLToPath(new URL("../runtime/design-eslint.mjs", import.meta.url));
			const finding = {
				file: "Button.jsx",
				line: 1,
				column: 37,
				severity: "error",
				ruleId: "reuse",
				message: "Use CanonicalButton",
			};
			const managed = spawnSync(process.execPath, [entry], {
				cwd: root,
				env,
				input: JSON.stringify([finding]),
				encoding: "utf8",
			});
			expect(managed.status).toBe(1);
			expect(managed.stderr).toContain("no-debugger");
			expect(managed.stderr).toContain("pharaoh-design/error");
			writeFileSync(join(root, "Button.jsx"), "export const Button = () => <button/>;");
			expect(
				execFileSync(process.execPath, [join(eslintRoot, "bin/eslint.js"), "."], {
					cwd: root,
					env,
					encoding: "utf8",
				}),
			).toBe("");
			expect(readFileSync(join(root, "eslint.config.mjs"), "utf8")).not.toContain("pharaoh");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("authorized checkout wiring", () => {
	it("refuses to overwrite an existing customer lint command", async () => {
		const root = mkdtempSync(join(tmpdir(), "pharaoh-design-wiring-"));
		const before = '{"scripts":{"lint:design":"node customer-lint.js"}}';
		writeFileSync(join(root, "package.json"), before);
		try {
			const { wireDesignCheckout } = await import("../src/design-wiring.js");
			await expect(
				wireDesignCheckout(root, "bootstrap", { eslint: false, privateCi: false }),
			).rejects.toThrow(/conflicts/);
			expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("refuses opaque native configs before creating any managed files", async () => {
		const root = mkdtempSync(join(tmpdir(), "pharaoh-design-legacy-"));
		writeFileSync(join(root, "package.json"), '{"private":true}');
		writeFileSync(join(root, ".eslintrc"), "{}");
		try {
			const { wireDesignCheckout } = await import("../src/design-wiring.js");
			await expect(
				wireDesignCheckout(root, "bootstrap", { eslint: true, privateCi: false }),
			).rejects.toThrow(/flat config/);
			expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
				private: true,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

it.each([
	"written",
	"rolled-back",
])("recovers an interrupted install with the manifest %s and preserves a competing workflow edit", async (stage) => {
	const root = mkdtempSync(join(tmpdir(), "pharaoh-design-interrupted-"));
	const home = join(root, "home");
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	const { digest } = await import("../src/design-projection.js");
	const { wireDesignCheckout } = await import("../src/design-wiring.js");
	const journalDir = join(home, ".pharaoh/design/installs");
	const previous = Buffer.from('{"scripts":{"lint:design":"node native.js"}}');
	const interrupted = Buffer.from('{"scripts":{"lint:design":"pharaoh-mcp design lint"}}');
	const workflowPath = join(root, ".github/workflows/pharaoh-design.yml");
	try {
		mkdirSync(journalDir, { recursive: true });
		mkdirSync(dirname(workflowPath), { recursive: true });
		writeFileSync(join(root, "package.json"), stage === "written" ? interrupted : previous);
		writeFileSync(join(root, "package-lock.json"), "installed lock");
		writeFileSync(workflowPath, "engineer edit");
		writeFileSync(
			join(journalDir, `${digest(root)}.json`),
			JSON.stringify({
				pid: 1000000000,
				original: previous.toString("base64"),
				desired: digest(interrupted),
				manager: "npm",
				priorLock: Buffer.from("original lock").toString("base64"),
				installedLockHash: digest("installed lock"),
				priorWorkflow: null,
				nextWorkflow: digest("generated version"),
			}),
		);
		await expect(
			wireDesignCheckout(root, "bootstrap", { eslint: false, privateCi: false }),
		).rejects.toThrow(/conflicts/);
		expect(readFileSync(join(root, "package.json"))).toEqual(previous);
		expect(readFileSync(join(root, "package-lock.json"), "utf8")).toBe("original lock");
		expect(readFileSync(workflowPath, "utf8")).toBe("engineer edit");
	} finally {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"late workflow installation failure",
	() => {
		it.each([
			"competing-edit",
			"write-denied",
		])("restores package.json and the lockfile after %s", async (failure) => {
			const root = mkdtempSync(join(tmpdir(), "pharaoh-design-late-"));
			const home = join(root, "home"),
				bin = join(root, "bin");
			const workflowDir = join(root, ".github/workflows");
			const workflow = join(workflowDir, "pharaoh-design.yml");
			const before = '{"private":true,"scripts":{"lint":"eslint ."}}';
			try {
				mkdirSync(bin);
				mkdirSync(workflowDir, { recursive: true });
				writeFileSync(join(root, "package.json"), before);
				writeFileSync(join(root, "package-lock.json"), "original lock");
				vi.stubEnv("HOME", home);
				vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
				const action =
					failure === "competing-edit"
						? 'printf "human workflow" > .github/workflows/pharaoh-design.yml'
						: "chmod 0555 .github/workflows";
				writeFileSync(
					join(bin, "npm"),
					`#!/bin/sh\nprintf 'updated lock' > package-lock.json\n${action}\n`,
					{ mode: 0o755 },
				);
				const { wireDesignCheckout } = await import("../src/design-wiring.js");
				await expect(
					wireDesignCheckout(root, "bootstrap", {
						eslint: false,
						privateCi: true,
						workflowSha: "a".repeat(40),
					}),
				).rejects.toThrow();
				expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
				expect(readFileSync(join(root, "package-lock.json"), "utf8")).toBe("original lock");
				if (failure === "competing-edit")
					expect(readFileSync(workflow, "utf8")).toBe("human workflow");
				else expect(existsSync(workflow)).toBe(false);
			} finally {
				vi.unstubAllEnvs();
				chmodSync(workflowDir, 0o755);
				rmSync(root, { recursive: true, force: true });
			}
		});
	},
);
