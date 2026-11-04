import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { syncMemoryHooks } from "../project-memory/setup.mjs";
import { type Credentials, writeCredentials } from "../src/credentials.js";
import { tokenToCredentials } from "../src/helpers.js";

const repo = "fixture/project";
let home: string;
let checkout: string;
let packageRoot: URL;
let credentials: Credentials;

function git(...args: string[]): string {
	return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "pharaoh-memory-install-")));
	checkout = join(home, "checkout");
	mkdirSync(checkout);
	git("init", "-q");
	git("remote", "add", "origin", `https://github.com/${repo}.git`);
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"--allow-empty",
		"-qm",
		"seed",
	);
	const pkg = join(home, "package");
	packageRoot = pathToFileURL(`${pkg}/`);
	mkdirSync(join(pkg, "dist"), { recursive: true });
	cpSync(new URL("../project-memory/", import.meta.url), join(pkg, "project-memory"), {
		recursive: true,
	});
	writeFileSync(join(pkg, "dist/refresh.js"), "export function originBoundRefresh() {}\n");
	writeFileSync(
		join(pkg, "dist/credentials.js"),
		`
		import { readFileSync } from "node:fs";
		import { homedir } from "node:os";
		export const CREDENTIALS_PATH = homedir() + "/.pharaoh/credentials.json";
		export function readCredentials() { return JSON.parse(readFileSync(CREDENTIALS_PATH)); }
	`,
	);
	credentials = {
		version: 2,
		access_token: "fixture",
		refresh_token: "fixture",
		expires_at: "2030-01-01",
		refresh_expires_at: "2030-01-01",
		expires_in: 3600,
		sse_url: "https://mcp.pharaoh.so/sse",
		github_login: "owner",
		tenant_name: null,
		repos: [repo],
		project_memory: [{ repo, revision: git("rev-parse", "HEAD") }],
	};
	writeCredentials(credentials, join(home, ".pharaoh/credentials.json"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function configure(options: Partial<Parameters<typeof syncMemoryHooks>[0]> = {}) {
	return syncMemoryHooks({
		home,
		cwd: checkout,
		env: {},
		packageRoot,
		credentials,
		clients: ["claude-code", "codex"],
		...options,
	});
}

function prompt(
	client: string,
	settings: string,
	cwd: string,
	turn: string,
	env: NodeJS.ProcessEnv = {},
	event = "UserPromptSubmit",
) {
	const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks[event];
	const command = hooks.find((group: { hooks: Array<{ command?: string }> }) =>
		group.hooks[0]?.command?.endsWith("# pharaoh-project-memory:user-v1"),
	).hooks[0].command;
	return execFileSync("/bin/sh", ["-c", command], {
		cwd,
		env: { ...process.env, HOME: home, ...env },
		encoding: "utf8",
		input: JSON.stringify({
			hook_event_name: event,
			cwd,
			prompt: "Investigate a real project issue",
			stop_hook_active: false,
			last_assistant_message: "Verified the mapped repository.",
			session_id: `fixture-${client}-${turn}`,
			turn_id: turn,
		}),
	});
}

it("installs the same owned hooks on returning setup and resolves ordinary worktrees", () => {
	const claude = join(home, ".claude/settings.json");
	const codex = join(home, ".codex/hooks.json");
	mkdirSync(join(home, ".codex"));
	writeFileSync(
		codex,
		JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } }),
	);
	expect(configure().join(" ")).toContain("review and trust");
	const first = readFileSync(codex, "utf8");
	configure();
	expect(readFileSync(codex, "utf8")).toBe(first);
	expect(first).toContain('"other"');
	const activePath = join(home, ".pharaoh/project-memory-client/active.json");
	const activation = readFileSync(activePath, "utf8");
	expect(
		configure({
			credentials: { ...credentials, project_memory_status: "unavailable" },
		}).join(" "),
	).toContain("Rerun normal setup to retry");
	expect(readFileSync(codex, "utf8")).toBe(first);
	expect(readFileSync(activePath, "utf8")).toBe(activation);
	expect(existsSync(join(checkout, ".codex/hooks.json"))).toBe(false);
	const worktree = join(home, "worktree");
	git("worktree", "add", "--quiet", "--detach", worktree);
	for (const [client, file] of [
		["claude-code", claude],
		["codex", codex],
	]) {
		expect(prompt(client, file, worktree, "eligible")).toContain("recall --turn");
		expect(prompt(client, file, home, "unrelated")).toBe("");
	}
	// A similarly named origin without the mapped object must not enroll.
	const spoof = join(home, "spoof");
	execFileSync("git", ["init", "-q", spoof]);
	execFileSync("git", ["-C", spoof, "remote", "add", "origin", `https://github.com/${repo}.git`]);
	expect(prompt("codex", codex, spoof, "spoof")).toBe("");
	const legacy = join(checkout, ".codex/hooks.json");
	mkdirSync(join(checkout, ".codex"));
	writeFileSync(join(checkout, ".git/info/exclude"), "/.codex/hooks.json\n");
	const marker = createHash("sha256").update(`codex\0${checkout}`).digest("hex");
	writeFileSync(
		legacy,
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							{
								type: "command",
								command: `/old/pharaoh-memory-hook.mjs # pharaoh-project-memory:${marker}`,
							},
						],
					},
				],
			},
		}),
	);
	expect(prompt("codex", codex, checkout, "legacy")).toBe("");
	writeFileSync(codex, "invalid settings");
	expect(configure().join(" ")).toContain("could not update codex hooks");
	expect(readFileSync(legacy, "utf8")).toContain("pharaoh-project-memory");
	writeFileSync(codex, first);
	configure();
	expect(readFileSync(legacy, "utf8")).not.toContain("pharaoh-project-memory");
	expect(prompt("codex", codex, checkout, "migrated")).toContain("recall --turn");
	const nonpilot = { ...credentials, project_memory: undefined };
	writeCredentials(nonpilot, join(home, ".pharaoh/credentials.json"));
	expect(prompt("codex", codex, worktree, "switched")).toBe("");
	configure({ credentials: nonpilot, clients: [] });
	expect(readFileSync(codex, "utf8")).not.toContain("pharaoh-project-memory");
	expect(readFileSync(codex, "utf8")).toContain('"other"');
});

it("leaves a fresh nonpilot's client settings untouched", () => {
	expect(configure({ credentials: { ...credentials, project_memory: undefined } })).toEqual([]);
	expect(existsSync(join(home, ".claude"))).toBe(false);
	expect(existsSync(join(home, ".codex"))).toBe(false);
	expect(existsSync(join(home, ".pharaoh/project-memory-client"))).toBe(false);
});

it("installs from an unrelated repository rooted at the user's home", () => {
	execFileSync("git", ["-C", home, "init", "-q"]);
	execFileSync("git", [
		"-C",
		home,
		"remote",
		"add",
		"origin",
		"https://github.com/fixture/dotfiles.git",
	]);
	expect(configure({ cwd: home, clients: ["codex"] }).join(" ")).toContain("memory is set up");
	expect(existsSync(join(home, ".codex/hooks.json"))).toBe(true);
});

it("activates the ordinary installed hook after the first map without a second setup", () => {
	const revision = git("rev-parse", "HEAD");
	const signIn = (accessToken: string) =>
		tokenToCredentials(
			{
				access_token: accessToken,
				refresh_token: "fixture-refresh",
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token_expires_in: 86400,
				sse_url: credentials.sse_url,
				project_memory: [{ repo, revision: null }],
			},
			credentials.sse_url,
			"https://mcp.pharaoh.so",
		);
	const pending = signIn("fixture");
	expect(pending.project_memory_session).toBeDefined();
	const credentialsFile = join(home, ".pharaoh/credentials.json");
	writeCredentials(pending, credentialsFile);
	writeFileSync(
		new URL("dist/refresh.js", packageRoot),
		`
		import { writeFileSync } from "node:fs";
		import { CREDENTIALS_PATH, readCredentials } from "./credentials.js";
		export function originBoundRefresh() {
			return { load: async () => {
				const current = readCredentials();
				if (current.access_token !== "fixture") return {ok: true, creds: current};
				const rotated = { ...current, access_token: "rotated", refresh_token: "rotated-refresh" };
				writeFileSync(CREDENTIALS_PATH, JSON.stringify(rotated));
				return {ok: true, creds: rotated};
			} };
		}
	`,
	);
	const settings = join(home, ".codex/hooks.json");
	expect(configure({ credentials: pending, clients: ["codex"] }).join(" ")).toContain(
		"still mapping",
	);
	const installed = readFileSync(settings, "utf8");
	// Later prompts run the private installed runtime, independent of the package cache.
	rmSync(packageRoot, { recursive: true });
	const shim = join(home, "readiness-fixture.mjs");
	writeFileSync(
		shim,
		`
		const now = Date.now.bind(Date);
		Date.now = () => now() + Number(process.env.FIXTURE_OFFSET ?? 0);
		globalThis.fetch = async (url, options) => {
			if (String(url) === "https://mcp.pharaoh.so/api/project-memory/readiness" &&
				options.redirect === "error" && options.body === JSON.stringify({repo: "fixture/project"})) {
				if (process.env.FIXTURE_STATUS === "denied") return new Response(null, {status: 404});
				return new Response(JSON.stringify({revision: process.env.FIXTURE_REVISION || null}));
			}
			if (String(url) === "https://mcp.pharaoh.so/api/project-memory/recall" &&
				options.headers.Authorization === "Bearer rotated")
				return new Response(JSON.stringify({records: [], graph: {verification: "unavailable"}}));
			if (String(url) === "https://mcp.pharaoh.so/api/project-memory/capture" &&
				options.headers.Authorization === "Bearer rotated")
				return new Response(JSON.stringify({record:{id:"8b24e18d-4541-4da3-941e-ce145b7cb53e",status:"candidate"}}));
			throw new Error("Unexpected fixture request");
		};
	`,
	);
	const env = { NODE_OPTIONS: `--import=${shim}` };
	expect(prompt("codex", settings, checkout, "denied", { ...env, FIXTURE_STATUS: "denied" })).toBe(
		"",
	);
	expect(prompt("codex", settings, checkout, "pending", { ...env, FIXTURE_OFFSET: "16000" })).toBe(
		"",
	);
	const enabled = prompt("codex", settings, checkout, "mapped", {
		...env,
		FIXTURE_OFFSET: "32000",
		FIXTURE_REVISION: revision,
	});
	const guidance: string = JSON.parse(enabled).hookSpecificOutput.additionalContext;
	const command = guidance
		.split("\n")
		.find((line) => line.includes("recall --turn"))
		?.split(" <<")[0];
	expect(command).toBeDefined();
	const recalled = execFileSync("/bin/sh", ["-c", command as string], {
		cwd: checkout,
		env: { ...process.env, HOME: home, ...env },
		encoding: "utf8",
		input: JSON.stringify({ terms: ["mapping"] }),
	});
	expect(JSON.parse(recalled).records).toEqual([]);
	const rotated = JSON.parse(readFileSync(credentialsFile, "utf8"));
	expect(rotated).toMatchObject({
		access_token: "rotated",
		project_memory_session: pending.project_memory_session,
	});
	const stop = JSON.parse(prompt("codex", settings, checkout, "mapped", env, "Stop"));
	expect(stop.decision).toBe("block");
	const capture = (stop.reason as string)
		.split("\n")
		.find((line) => line.includes("capture --turn"))
		?.split(" <<")[0];
	expect(capture).toBeDefined();
	const captured = execFileSync("/bin/sh", ["-c", capture as string], {
		cwd: checkout,
		env: { ...process.env, HOME: home, ...env },
		encoding: "utf8",
		input: JSON.stringify({ kind: "lesson", summary: "Check the mapped revision first." }),
	});
	expect(JSON.parse(captured).record.status).toBe("candidate");
	expect(readFileSync(settings, "utf8")).toBe(installed);
	const replacement = signIn("new-device-session");
	expect(replacement.project_memory_session).not.toBe(pending.project_memory_session);
	writeCredentials(replacement, credentialsFile);
	expect(
		prompt("codex", settings, checkout, "new-session", {
			...env,
			FIXTURE_OFFSET: "48000",
			FIXTURE_STATUS: "denied",
		}),
	).toBe("");
});
