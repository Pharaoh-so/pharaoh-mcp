import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMemoryBundle, packagedMemoryBundle } from "../project-memory/bundle.mjs";
import {
	memoryActivePath,
	memoryClientRoot,
	readActiveMemoryClients,
} from "../project-memory/client-settings.mjs";
import {
	collectDiagnosticEvent,
	flushDiagnosticQueue,
} from "../project-memory/diagnostics-collector.mjs";
import { executeTurn } from "../project-memory/execute-turn.mjs";
import {
	memoryCue,
	refreshAnchoredMemory,
	retrievalLocked,
	worktreeCue,
} from "../project-memory/graph-cues.mjs";
import {
	conversationMemoryBinding,
	markSessionLocal,
	memoryEgressDecision,
	sessionLocalSensitivity,
	turnStore,
} from "../project-memory/local.mjs";
import { PilotError, requestMemory } from "../project-memory/memory-api.mjs";
import {
	changeReviewEnabled,
	memoryDiagnosticsForClient,
	memoryHookStateForClient,
	readHookPreferences,
	resetHookPreferences,
	setChangeReview,
	writeHookPreferences,
} from "../project-memory/preferences.mjs";
import {
	applyMemoryHookChoices,
	chooseMemoryHooks,
	configureChangeReview,
	ensureMemoryHooks,
	syncMemoryHooks,
} from "../project-memory/setup.mjs";
import { legacyMemoryHooksMayRun } from "../project-memory/user-target.mjs";
import type { Backend, DownstreamClient } from "../src/backend.js";
import { type Credentials, writeCredentials } from "../src/credentials.js";
import { askYesNoInTerminal, tokenToCredentials } from "../src/helpers.js";
import { ProxyServer } from "../src/proxy-server.js";

const repo = "fixture/project";
const require = createRequire(import.meta.url);
let home: string;
let checkout: string;
let packageRoot: URL;
let credentials: Credentials;

function git(...args: string[]): string {
	return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
}

function commitFixture() {
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
}

beforeEach(() => {
	vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
	home = realpathSync(mkdtempSync(join(tmpdir(), "pharaoh-memory-install-")));
	checkout = join(home, "checkout");
	mkdirSync(checkout);
	git("init", "-q");
	git("remote", "add", "origin", `https://github.com/${repo}.git`);
	commitFixture();
	const pkg = join(home, "package");
	packageRoot = pathToFileURL(`${pkg}/`);
	mkdirSync(join(pkg, "dist"), { recursive: true });
	cpSync(new URL("../project-memory/", import.meta.url), join(pkg, "project-memory"), {
		recursive: true,
	});
	mkdirSync(join(pkg, "runtime"));
	cpSync(
		new URL("../runtime/feed-signin.mjs", import.meta.url),
		join(pkg, "runtime/feed-signin.mjs"),
	);
	mkdirSync(join(pkg, "hooks"));
	cpSync(new URL("../hooks/route-grep.mjs", import.meta.url), join(pkg, "hooks/route-grep.mjs"));
	cpSync(
		new URL("../hooks/change-review-completion.js", import.meta.url),
		join(pkg, "hooks/change-review-completion.js"),
	);
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

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function configure(options: Partial<Parameters<typeof syncMemoryHooks>[0]> = {}) {
	return syncMemoryHooks({
		...installOptions(),
		clients: ["claude-code", "codex"],
		...options,
	});
}

function installOptions() {
	return { home, cwd: checkout, env: {}, packageRoot, credentials };
}

function readJson(path: string | URL) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string | URL, value: unknown) {
	writeFileSync(path, JSON.stringify(value));
}

/** Pharaoh's last answer about giving this sign-in's memories back, fresh, so the hook starts no fetch. */
async function retrieval(binding: string, locked = false) {
	const directory = memoryClientRoot(home);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	await refreshAnchoredMemory(repo, {
		directory,
		binding,
		request: async () => {
			if (locked) throw new PilotError("This needs Pro.", true, 403);
			return { records: [] };
		},
	});
}
const SESSION = "5a0f3d1e-6c2b-4e8a-9f71-0b3c2d4e5f60";

function hookCommand(settings: string, event: string): string {
	const hooks = readJson(settings).hooks[event];
	return hooks.find((group: { hooks: Array<{ command?: string }> }) =>
		group.hooks[0]?.command?.endsWith("# pharaoh-project-memory:user-v1"),
	).hooks[0].command;
}

it("keeps Local memory active through repair without writing user-level hooks or legacy migration", () => {
	const scope = { kind: "local" as const, root: checkout };
	expect(configure({ scope, enable: true })).toEqual([]);
	const settings = join(checkout, ".claude/settings.local.json");
	expect(readFileSync(settings, "utf8")).toContain("pharaoh-project-memory:local-v1:");
	expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
	expect(existsSync(join(home, ".codex/hooks.json"))).toBe(false);
	expect(legacyMemoryHooksMayRun("claude-code", checkout)).toBe(false);
	expect(memoryHookStateForClient({ name: "claude-code" }, { home, env: {}, scope })).toBe(
		"installed",
	);
	ensureMemoryHooks({ name: "claude-code" }, credentials, { ...installOptions(), scope });
	expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
	expect(readFileSync(settings, "utf8")).toContain("pharaoh-project-memory:local-v1:");
});

it("Local cleanup preserves another checkout's activation and user-level hooks", () => {
	configure({ enable: true });
	const global = readFileSync(join(home, ".claude/settings.json"), "utf8");
	const first = { kind: "local" as const, root: checkout };
	const other = join(home, "other");
	mkdirSync(other);
	execFileSync("git", ["-C", other, "init", "-q"]);
	const second = { kind: "local" as const, root: other };
	configure({ scope: first, enable: true });
	configure({ scope: second, enable: true });
	const otherSettings = readFileSync(join(other, ".claude/settings.local.json"), "utf8");
	configure({ scope: first });
	expect(readActiveMemoryClients(home, first)).toEqual({});
	expect(readActiveMemoryClients(home, second)["claude-code"]).toBeTruthy();
	expect(readFileSync(join(other, ".claude/settings.local.json"), "utf8")).toBe(otherSettings);
	expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe(global);
	expect(existsSync(memoryActivePath(memoryClientRoot(home), second))).toBe(true);
});

it("scoped memory setup and cleanup preserve another installation's diagnostics", async () => {
	const fixture = diagnosticFixture();
	const event = fixture.collect({
		hook_event_name: "UserPromptSubmit",
		prompt: "Check the saved decision",
	});
	const queued = join(fixture.directory, `event-${event?.eventId}.json`);
	const before = readFileSync(queued, "utf8");
	const saved = readHookPreferences(home).codex;
	const scope = { kind: "local" as const, root: checkout };
	const decision = await choose({ scope, requested: true, ask: async () => false });
	applyMemoryHookChoices(decision, { ...installOptions(), scope });
	expect(readHookPreferences(home).codex).toEqual({ ...saved, graph: false });
	expect(readFileSync(queued, "utf8")).toBe(before);
	const local = join(checkout, ".codex/hooks.json");
	expect(readFileSync(local, "utf8")).not.toContain("--diagnostics");
	configure({ scope, clients: ["codex"] });
	expect(readFileSync(queued, "utf8")).toBe(before);
	expect(readHookPreferences(home).codex?.diagnosticsGeneration).toBe(saved?.diagnosticsGeneration);
	// A Global repair or cleanup must likewise preserve a live Local target.
	configure({ scope, clients: ["codex"], enable: true });
	const global = join(home, ".codex/hooks.json");
	const config = readJson(global);
	delete config.hooks.Stop;
	writeJson(global, config);
	appendFileSync(new URL("project-memory/local.mjs", packageRoot), "\n// force repair\n");
	ensureMemoryHooks({ name: "codex" }, credentials, { ...installOptions() });
	expect(readHookPreferences(home).codex?.diagnostics).toBe(true);
	expect(readFileSync(global, "utf8")).not.toContain("--diagnostics");
	configure({ clients: ["codex"] });
	expect(readFileSync(queued, "utf8")).toBe(before);
	expect(readActiveMemoryClients(home, scope).codex).toBeTruthy();
});

it("a Local memory hook ignores a native event from a different checkout", () => {
	const scope = { kind: "local" as const, root: checkout };
	configure({ scope, enable: true });
	const config = readJson(join(checkout, ".claude/settings.local.json"));
	const command = config.hooks.UserPromptSubmit[0].hooks[0].command;
	const child = spawnSync(command, {
		shell: true,
		cwd: home,
		env: { ...process.env, HOME: home },
		input: JSON.stringify({
			hook_event_name: "UserPromptSubmit",
			cwd: home,
			session_id: SESSION,
			prompt: "inspect callers",
		}),
		encoding: "utf8",
	});
	expect(child.status).toBe(0);
	expect(child.stdout).toBe("");
});

it("keeps Local memory repair scoped when native credentials are refreshed", async () => {
	const scope = { kind: "local" as const, root: checkout };
	configure({ scope, enable: true, clients: ["codex"] });
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEX_HOME", join(home, ".codex"));
	const currentDirectory = vi.spyOn(process, "cwd").mockReturnValue(checkout);
	const identified: DownstreamClient[] = [];
	const backend: Backend = {
		name: "sse",
		identifyClient: (value) => identified.push(value),
		listTools: async () => [],
		callTool: async () => ({ content: [] }),
	};
	const proxy = new ProxyServer(backend, undefined, undefined, scope);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "codex", version: "1.2.3" });
	try {
		proxy.setMemoryCredentials(credentials);
		await proxy.startWithTransport(serverTransport);
		await client.connect(clientTransport);
		proxy.setMemoryCredentials({ ...credentials });
		expect(identified[0].memoryHooks).toBe("installed");
		expect(existsSync(join(home, ".codex/hooks.json"))).toBe(false);
		expect(readActiveMemoryClients(home, scope).codex).toBeTruthy();
	} finally {
		await client.close();
		currentDirectory.mockRestore();
	}
});

it.each([
	"absent",
	"declined",
	"installed",
] as const)("handles %s Global memory setup through an unmanaged connection without silent adoption", async (state) => {
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEX_HOME", join(home, ".codex"));
	const settings = join(home, ".codex/hooks.json");
	if (state === "declined") writeHookPreferences({ codex: { memory: false } }, home);
	if (state === "installed") {
		configure({ clients: ["codex"], enable: true });
		const config = readJson(settings);
		delete config.hooks.Stop;
		writeJson(settings, config);
	}
	const before = existsSync(settings) ? readFileSync(settings, "utf8") : null;
	const backend: Backend = {
		name: "sse",
		listTools: async () => [],
		callTool: async () => ({ content: [{ type: "text", text: "Memory lookup complete." }] }),
	};
	const proxy = new ProxyServer(backend, undefined, undefined, undefined, () => []);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "codex", version: "1.2.3" });
	proxy.setMemoryCredentials(credentials);
	await proxy.startWithTransport(serverTransport);
	await client.connect(clientTransport);
	try {
		const call = () =>
			client.callTool({ name: "pharaoh_memory_recall", arguments: { repo, terms: ["setup"] } });
		const first = JSON.stringify(await call());
		proxy.setMemoryCredentials({ ...credentials });
		const second = JSON.stringify(await call());
		if (state === "declined") expect(first).not.toContain("no matching managed activation");
		else expect(first).toContain("no matching managed activation");
		expect(second).not.toContain("no matching managed activation");
		expect(existsSync(settings) ? readFileSync(settings, "utf8") : null).toBe(before);
	} finally {
		await client.close();
	}
});

it("keeps native adoption states content-free and preserves saved declines and custom settings", () => {
	const options = { home, env: {}, platform: "linux" as const };
	expect(memoryHookStateForClient(undefined, options)).toBe("unknown");
	expect(memoryHookStateForClient({ name: "other-editor" }, options)).toBe("unsupported");
	expect(memoryHookStateForClient({ name: "codex" }, { ...options, platform: "win32" })).toBe(
		"unsupported",
	);
	expect(memoryHookStateForClient({ name: "codex" }, options)).toBe("absent");
	const custom = join(home, "custom-codex");
	mkdirSync(custom);
	const settings = join(custom, "hooks.json");
	const config =
		'{"hooks":{"Notification":[{"hooks":[{"type":"command","command":"user-tool"}]}]}}';
	writeFileSync(settings, config);
	const customOptions = { ...options, env: { CODEX_HOME: custom } };
	expect(memoryHookStateForClient({ name: "codex" }, customOptions)).toBe("absent");
	expect(readFileSync(settings, "utf8")).toBe(config);
	writeFileSync(settings, '{"hooks":');
	expect(memoryHookStateForClient({ name: "codex" }, customOptions)).toBe("unknown");
	writeHookPreferences({ codex: { memory: false, diagnostics: false } }, home);
	const preferences = readFileSync(
		join(home, ".pharaoh/project-memory-client/hook-preferences-v1.json"),
	);
	expect(memoryHookStateForClient({ name: "codex" }, customOptions)).toBe("declined");
	expect(
		readFileSync(join(home, ".pharaoh/project-memory-client/hook-preferences-v1.json")),
	).toEqual(preferences);
	expect(readFileSync(settings, "utf8")).toBe('{"hooks":');
});

it("recognizes configured active reminders without asserting native trust, execution or diagnostic consent", async () => {
	configure({ enable: true, clients: ["codex", "claude-code"] });
	const options = { home, env: {} };
	const info = { name: "codex", version: "1.2.3" };
	const settings = join(home, ".codex/hooks.json");
	const configured = readFileSync(settings, "utf8");
	expect(memoryHookStateForClient(info, options)).toBe("installed");
	expect(memoryDiagnosticsForClient(info, home)).toBeUndefined();
	const active = readJson(join(home, ".pharaoh/project-memory-client/active.json"));
	const runtime = join(home, ".pharaoh/project-memory-client", active.codex);
	const installed = await import(pathToFileURL(join(runtime, "preferences.mjs")).href);
	expect(installed.memoryHookStateForClient(info, options)).toBe("installed");
	expect(readFileSync(settings, "utf8")).toBe(configured);
	const claudeSettings = join(home, ".claude/settings.json");
	const disabled = {
		...readJson(claudeSettings),
		disableAllHooks: true,
	};
	writeJson(claudeSettings, disabled);
	expect(memoryHookStateForClient({ name: "claude-code" }, options)).toBe("absent");
	const stale = configured.replace(active.codex, "f".repeat(64));
	writeFileSync(settings, stale);
	expect(memoryHookStateForClient(info, options)).toBe("unknown");
	writeFileSync(settings, configured);
	rmSync(join(runtime, "pharaoh-memory-hook.mjs"));
	expect(memoryHookStateForClient(info, options)).toBe("unknown");
});

it("preserves daily feedback invitation metadata and exact record versions in the installed client", async () => {
	configure({ enable: true, clients: ["codex"] });
	vi.stubEnv("HOME", home);
	const active = readJson(join(home, ".pharaoh/project-memory-client/active.json"));
	const runtime = join(home, ".pharaoh/project-memory-client", active.codex);
	const installed = await import(pathToFileURL(join(runtime, "memory-api.mjs")).href);
	const recallId = randomUUID();
	const feedbackRequest = {
		requestId: randomUUID(),
		recallId,
		eventId: randomUUID(),
		probability: 0.1,
		stratum: "random",
		unit: "actor_repo_day",
		window: "2026-11-05",
		selectionVersion: "daily-stratum-v1",
		fields: ["helpfulness", "suggestion"],
	};
	const records = [{ id: randomUUID(), version: 3, status: "candidate" }];
	const fetcher = vi.fn(async (_url: string, _request: RequestInit) =>
		Response.json({ records, recallId, collection: "unrecorded", feedbackRequest }),
	);
	const binding = conversationMemoryBinding("codex", "local-conversation");
	const unrelated = conversationMemoryBinding("codex", "unrelated-conversation");
	const response = await installed.requestMemory(
		"recall",
		{ repo, terms: ["upgrade"] },
		{ credentials, client: "codex", fetcher, binding },
	);
	expect(response.records).toEqual(records);
	expect(response.feedbackRequest).toEqual(feedbackRequest);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(markSessionLocal(binding, { home })).toBe(true);
	for (const operation of ["recall", "expand", "capture", "feedback"]) {
		await expect(
			installed.requestMemory(
				operation,
				{
					repo,
					terms: ["PRIVATE_LOCAL_CALLER"],
					diagnostics: { taskSummary: "PRIVATE_LOCAL_CALLER" },
				},
				{ credentials, fetcher, binding },
			),
		).rejects.toThrow("paused for this conversation");
	}
	await expect(
		installed.requestMemory("recall", { repo, terms: ["unknown"] }, { credentials, fetcher }),
	).rejects.toThrow("paused for this conversation");
	expect(fetcher).toHaveBeenCalledTimes(1);
	const hosted = await installed.requestMemory(
		"recall",
		{ repo, terms: ["unrelated"] },
		{ credentials, client: "codex", fetcher, binding: unrelated },
	);
	expect(hosted.feedbackRequest).toEqual(feedbackRequest);
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it("reports actual native identity and configured adoption without granting diagnostic consent", async () => {
	configure({ enable: true, clients: ["codex"] });
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEX_HOME", join(home, ".codex"));
	const identified: DownstreamClient[] = [];
	const calls: Array<Record<string, unknown>> = [];
	const backend: Backend = {
		name: "sse",
		identifyClient: (client) => identified.push(client),
		listTools: async () => [],
		callTool: async (_name, args) => {
			calls.push(args);
			return { content: [] };
		},
	};
	const proxy = new ProxyServer(backend);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await proxy.startWithTransport(serverTransport);
	const client = new Client({ name: "codex", version: "1.2.3" });
	await client.connect(clientTransport);
	try {
		await client.callTool({
			name: "pharaoh_memory_recall",
			arguments: {
				repo,
				terms: ["upgrade"],
				diagnostics: {
					clientName: "claude-code",
					generation: randomUUID(),
					taskSummary: "Check an upgrade",
				},
			},
		});
		expect(identified).toEqual([
			{
				client: { name: "codex", version: "1.2.3" },
				plugin: "absent",
				memoryHooks: "installed",
				instructions: { user: "missing", managed: "absent", project: expect.any(String) },
			},
		]);
		expect(JSON.stringify(identified)).not.toContain(home);
		expect(calls[0].diagnostics).toEqual({ taskSummary: "Check an upgrade" });
	} finally {
		await client.close();
		await proxy.stop();
	}
});

function runHook(settings: string, event: string, input: object, cwd = checkout, env = {}) {
	return execFileSync("/bin/sh", ["-c", hookCommand(settings, event)], {
		cwd,
		env: { ...process.env, HOME: home, ...env },
		encoding: "utf8",
		input: JSON.stringify({ hook_event_name: event, cwd, ...input }),
	});
}

function prompt(settings: string, cwd: string, env = {}, event = "UserPromptSubmit") {
	return runHook(
		settings,
		"UserPromptSubmit",
		{
			hook_event_name: event,
			prompt: "Investigate a real project issue",
			session_id: "fixture-session",
			turn_id: "fixture-turn",
		},
		cwd,
		env,
	);
}

it("runs the worktree cue from the installed, activated bundle", async () => {
	writeCredentials(
		{ ...credentials, project_memory_session: "79d35b00-e832-4b5b-972d-acbb9ec59622" },
		join(home, ".pharaoh/credentials.json"),
	);
	writeHookPreferences({ codex: { memory: true, graph: true } }, home);
	configure({ enable: true, clients: ["codex"], graphClients: ["codex"] });
	const settings = join(home, ".codex/hooks.json");
	const run = (command: string, env: NodeJS.ProcessEnv = {}) =>
		runHook(
			settings,
			"PreToolUse",
			{
				session_id: "graph-session",
				tool_name: "Bash",
				tool_input: { command },
			},
			checkout,
			env,
		);
	const trace = join(home, "git-started");
	const probe = join(home, "probe.cjs");
	writeFileSync(
		probe,
		`require("node:child_process").execFileSync = () => {
		require("node:fs").writeFileSync(${JSON.stringify(trace)}, "started");
		throw new Error("Unexpected subprocess");
	};
	require("node:module").syncBuiltinESMExports();`,
	);
	for (const search of [
		"pwd",
		"rg -F 'function readWidget'",
		"rg 'function readWidget' -F",
		"rg 'readWidget'",
		"rg 'function readWidget' docs/",
		"rg 'function readWidget' app.config.ts",
		"rg 'function readWidget' ../another-repo",
		"rg 'function readWidget' | head",
		"rg -g '*.{ts,json}' 'function readWidget'",
	])
		expect(run(search, { NODE_OPTIONS: `--require="${probe}"` })).toBe("");
	expect(existsSync(trace)).toBe(false);
	const command = "rg -n 'function readWidget'";
	expect(JSON.parse(run(command)).hookSpecificOutput).toEqual({
		hookEventName: "PreToolUse",
		additionalContext: expect.stringContaining("search_functions"),
	});
	expect(run(command)).toBe("");
	// Memory on without the structural choice: the grep cue stays quiet.
	writeHookPreferences({ codex: { memory: true } }, home);
	expect(run("rg -n 'function otherWidget'")).toBe("");
	// The installed edit hook shows memory about the file whatever the structural choice.
	mkdirSync(join(checkout, "src"), { recursive: true });
	await refreshAnchoredMemory(repo, {
		directory: join(home, ".pharaoh/project-memory-client"),
		binding: "79d35b00-e832-4b5b-972d-acbb9ec59622",
		request: async () => ({
			records: [
				{
					id: "7f194a39-40b5-4a19-8d42-f3ed3aeb6034",
					version: 1,
					kind: "decision",
					status: "approved",
					summary: "Sessions restore only with membership proof.",
					createdAt: "2026-11-04T10:00:00.000Z",
					paths: ["src/recovery.ts"],
				},
			],
		}),
	});
	for (const [index, choice] of [{ memory: true, graph: false }, { memory: true }].entries()) {
		writeHookPreferences({ codex: choice }, home);
		const edited = runHook(settings, "PostToolUse", {
			session_id: `memory-${index}`,
			tool_name: "apply_patch",
			tool_input: { command: "*** Begin Patch\n*** Update File: src/recovery.ts\n*** End Patch\n" },
			tool_response: "Success. Updated the following files:\nM src/recovery.ts",
		});
		expect(edited).toContain("Sessions restore only with membership proof.");
	}
	resetHookPreferences(true, home);
	expect(run("rg 'function anotherWidget'")).toBe("");
});

it.each([false, true])("advises safely after a map with short request=%s", (short) => {
	const file = "secret-path.ts";
	writeFileSync(join(checkout, file), "export function temporary() {}\n");
	git("add", file);
	commitFixture();
	const revision = git("rev-parse", "HEAD");
	const filter = join(home, "filter-started");
	git("config", "filter.pilot.clean", `touch "${filter}" && cat`);
	writeFileSync(join(checkout, ".gitattributes"), `${file} filter=pilot\n`);
	const stateDirectory = join(home, ".pharaoh/project-memory-client");
	const options = {
		client: "codex",
		target: { root: checkout, repo },
		binding: "fixture",
		repos: [repo],
		stateDirectory,
	};
	const cue = (input: object, overrides = {}) =>
		worktreeCue(
			{ hook_event_name: "PostToolUse", session_id: "same-session", cwd: checkout, ...input },
			{ ...options, ...overrides },
		);
	const map = {
		tool_name: "mcp__pharaoh__get_codebase_map",
		tool_input: { repo: short ? "project" : repo },
		tool_response: {
			content: [
				{
					type: "text",
					text: `# ${short ? repo : "project"} Codebase Map\nIndexed commit: ${revision}`,
				},
			],
		},
	};
	const patch = (path: string) => ({
		tool_name: "apply_patch",
		tool_input: { command: `*** Begin Patch\n*** Update File: ${path}\n*** End Patch\n` },
		tool_response: "Success. Updated the following files:",
	});
	writeFileSync(join(checkout, file), "export function temporary() { return 1; }\n");
	cue({ ...map, tool_input: { repo: "other/project" } });
	for (const text of [
		`# project Codebase Map\nIndexed commit: ${revision}`,
		`# other/project Codebase Map\nIndexed commit: ${revision}`,
		`# ${repo} Codebase Map\n# other/project Codebase Map\nIndexed commit: ${revision}`,
		`# ${repo} Codebase Map\nIndexed commit: ${revision}\nIndexed commit: ${revision}`,
		`# ${repo} Codebase Map\nIndexed commit: unknown`,
	])
		cue({
			...map,
			tool_input: { repo: "project" },
			tool_response: { content: [{ type: "text", text }] },
		});
	cue({
		...map,
		tool_response: { content: [...map.tool_response.content, ...map.tool_response.content] },
	});
	cue({ ...map, tool_response: { ...map.tool_response, isError: true } });
	expect(cue(patch(file))).toBeUndefined();
	// Canonical output is sufficient with absent or misleading personal repo hints.
	cue(map, { repos: short ? ["other/project"] : [] });
	expect(cue({ ...patch(file), tool_response: "Failed to apply patch" })).toBeUndefined();
	expect(cue(patch("unchanged.ts"))).toBeUndefined();
	expect(
		cue(patch(file), {
			git: (_cwd: string, deadline: number) => {
				expect(deadline - performance.now()).toBeLessThanOrEqual(300);
				throw new Error("Git timeout");
			},
		}),
	).toBeUndefined();
	expect(cue(patch(file))?.hookSpecificOutput.additionalContext).toContain(revision.slice(0, 12));
	expect(cue(patch(file))).toBeUndefined();
	writeFileSync(join(checkout, "new.ts"), "export {}\n");
	expect(cue(patch("new.ts"))?.hookSpecificOutput.hookEventName).toBe("PostToolUse");
	expect(cue(patch("settings.json"))).toBeUndefined();
	expect(existsSync(filter)).toBe(false);
	expect(readFileSync(join(stateDirectory, "worktree-cues.json"), "utf8")).not.toContain(file);
});

it("shows kept memory about an edited file once, with its reason, and nothing otherwise", async () => {
	mkdirSync(join(checkout, "src"));
	const stateDirectory = join(home, ".pharaoh/project-memory-client");
	mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
	const kept = () =>
		readdirSync(stateDirectory).filter((name) => name.startsWith("anchored-memory-"));
	const launched: string[] = [];
	const edit = (path: string, overrides = {}, session = "first") =>
		memoryCue(
			{
				hook_event_name: "PostToolUse",
				session_id: session,
				cwd: checkout,
				tool_name: "Edit",
				tool_input: { file_path: join(checkout, path) },
			},
			{
				client: "claude-code",
				target: { root: checkout, repo },
				binding: "fixture",
				stateDirectory,
				launch: (name: string) => launched.push(name),
				...overrides,
			},
		)?.hookSpecificOutput.additionalContext;
	// Nothing is kept yet: the edit starts one background fetch and shows nothing.
	expect(edit("src/recovery.ts")).toBeUndefined();
	expect(edit("src/recovery.ts")).toBeUndefined();
	expect(launched).toEqual([repo]);
	const records = [
		{
			id: "7f194a39-40b5-4a19-8d42-f3ed3aeb6034",
			version: 1,
			kind: "decision",
			status: "approved",
			summary: "Sessions restore only with membership proof.",
			detail: "A refresh without proof kept removed members signed in. ".repeat(40),
			createdAt: "2026-11-04T10:00:00.000Z",
			paths: ["src/recovery.ts"],
		},
	];
	// The real client: one request, to the anchored route, carrying the repo and nothing else.
	const fetcher = vi.fn(async (_url: string, _request: RequestInit) =>
		Response.json({ records: [...records, { ...records[0], id: "not-a-record-id" }] }),
	);
	const refresh = () =>
		refreshAnchoredMemory(repo, {
			directory: stateDirectory,
			binding: "fixture",
			request: (operation: string, payload: object) =>
				requestMemory(operation, payload, { credentials, fetcher }),
		});
	await refresh();
	expect(fetcher.mock.calls[0][0]).toBe("https://mcp.pharaoh.so/api/project-memory/anchored");
	expect(fetcher.mock.calls[0][1].body).toBe(JSON.stringify({ repo }));
	const list = join(stateDirectory, kept()[0]);
	expect(lstatSync(list).mode & 0o777).toBe(0o600);
	expect(readJson(list).records).toHaveLength(1);
	expect(edit("README.md")).toBeUndefined();
	// Another sign-in never reads this one's list: it is replaced and refetched.
	expect(edit("src/recovery.ts", { binding: "another sign-in" })).toBeUndefined();
	await refresh();
	expect(launched).toHaveLength(2);
	const shown = edit("src/recovery.ts");
	expect(shown).toContain(
		"decision (approved, 2026-11-04): Sessions restore only with membership proof. Why: A refresh",
	);
	expect(shown).toContain("pharaoh_memory_expand 7f194a39-40b5-4a19-8d42-f3ed3aeb6034 v1");
	expect(shown?.length).toBeLessThanOrEqual(1_200);
	expect(edit("src/recovery.ts")).toBeUndefined();
	// Work in a second repo keeps its own list and leaves this one's list and shown history alone.
	expect(
		edit("src/recovery.ts", { target: { root: checkout, repo: "fixture/other" } }),
	).toBeUndefined();
	expect(kept()).toHaveLength(2);
	expect(edit("src/recovery.ts")).toBeUndefined();
	expect(launched).toEqual([repo, repo, "fixture/other"]);
	// Five minutes on, the list is deleted, refetched and not shown.
	expect(edit("src/recovery.ts", { now: Date.now() + 300_000 }, "second")).toBeUndefined();
	expect(launched).toHaveLength(4);
	// A locked plan keeps nothing to show and silences the reminder. Its answer outlives the
	// placeholder that replaces a stale list and a failed check; only Pharaoh's next answer changes it.
	const locked = () => retrievalLocked(repo, { binding: "fixture", stateDirectory });
	const answer = async (response: Response) => {
		fetcher.mockResolvedValueOnce(response);
		await refresh();
	};
	expect(locked()).toBe(false);
	await answer(
		Response.json({ error: "locked", memories: 3, message: "This needs Pro." }, { status: 403 }),
	);
	expect(locked()).toBe(true);
	expect(edit("src/recovery.ts", {}, "after-lock")).toBeUndefined();
	expect(edit("src/recovery.ts", { now: Date.now() + 600_000 }, "later")).toBeUndefined();
	await answer(new Response(null, { status: 503 }));
	expect(locked()).toBe(true);
	expect(retrievalLocked(repo, { binding: "another sign-in", stateDirectory })).toBe(false);
	await answer(Response.json({ records: [] }));
	expect(locked()).toBe(false);
	resetHookPreferences(false, home);
	expect(kept()).toEqual([]);
});

function commandHook(command: string) {
	return { type: "command", command };
}

function legacySettings() {
	const path = join(checkout, ".codex/hooks.json");
	mkdirSync(join(checkout, ".codex"));
	writeFileSync(join(checkout, ".git/info/exclude"), "/.codex/hooks.json\n");
	const marker = createHash("sha256").update(`codex\0${checkout}`).digest("hex");
	writeJson(path, {
		hooks: {
			UserPromptSubmit: [
				{
					hooks: [
						commandHook(`/old/pharaoh-memory-hook.mjs # pharaoh-project-memory:${marker}`),
						commandHook("keep-checkout-hook"),
					],
				},
			],
		},
	});
	return path;
}

function choose(options: Partial<Parameters<typeof chooseMemoryHooks>[0]> = {}) {
	return chooseMemoryHooks({
		credentials,
		clients: ["codex"],
		home,
		env: {},
		ask: async () => {
			throw new Error("Unexpected prompt");
		},
		...options,
	});
}

it("enables memory by default and offers independent default-no worktree cues", async () => {
	const defaults: boolean[] = [];
	const decision = await choose({
		ask: async (_, defaultAnswer) => {
			defaults.push(defaultAnswer);
			return defaultAnswer;
		},
	});
	expect(defaults).toEqual([false]);
	expect(decision).toMatchObject({ accepted: ["codex"], declined: [], graphClients: [] });
	applyChoice(decision);
	const { hooks } = readJson(join(home, ".codex/hooks.json"));
	expect(hooks.UserPromptSubmit).toHaveLength(1);
	expect(await choose()).toEqual(decision);
	// Before the first background check (no hint, never checked) install still sets
	// the hooks up and says when memory turns on; they stay quiet until a repo is confirmed.
	const unchecked = { ...credentials, project_memory: undefined };
	// From an empty client configuration, as on a first install.
	rmSync(join(home, ".codex/hooks.json"));
	// Memory is hands-off: a successful install prints nothing (only failures speak).
	expect(applyChoice(await choose({ credentials: unchecked }), unchecked)).toEqual([]);
	expect(readJson(join(home, ".codex/hooks.json")).hooks.UserPromptSubmit).toHaveLength(1);
	// An incomplete sign-in check doesn't hold setup back either.
	rmSync(join(home, ".codex/hooks.json"));
	const partial = { ...unchecked, project_memory_status: "unavailable" as const };
	applyChoice(await choose({ credentials: partial }), partial);
	expect(readJson(join(home, ".codex/hooks.json")).hooks.UserPromptSubmit).toHaveLength(1);
});

function applyChoice(decision: Awaited<ReturnType<typeof choose>>, creds = credentials) {
	return applyMemoryHookChoices(decision, { ...installOptions(), credentials: creds });
}

it("honors an opt-out saved after setup answers and re-offers cues only when requested", async () => {
	const accepted = await choose({ ask: async () => true });
	resetHookPreferences(true, home);
	applyChoice(accepted);
	expect(existsSync(join(home, ".codex/hooks.json"))).toBe(false);
	expect((await choose()).declined).toEqual(["codex"]);
	applyChoice(await choose({ requested: true, ask: async () => true }));
	const path = join(home, ".codex/hooks.json");
	const config = readJson(path);
	expect(config.hooks.PreToolUse).toHaveLength(1);
	const unrelated = [{ hooks: [commandHook("keep-unrelated-cue")] }];
	config.hooks.PostToolUse = unrelated;
	writeJson(path, config);
	applyChoice(await choose({ ask: async () => null }));
	const hooks = readJson(path).hooks;
	// Removing either structural hook turns those cues off until asked again; the memory
	// cue is part of memory and comes back beside the user's own hook.
	expect(hooks.PreToolUse).toBeUndefined();
	expect(hooks.PostToolUse).toHaveLength(2);
	expect(hooks.PostToolUse).toEqual(expect.arrayContaining(unrelated));
	expect(hooks.UserPromptSubmit).toHaveLength(1);
});

it("preserves setup after a temporary eligibility failure and deactivates both clients after grant loss", async () => {
	const clients = ["claude-code", "codex"];
	applyChoice(await choose({ clients, ask: async () => true }));
	const before = readHookPreferences(home);
	const activation = join(home, ".pharaoh/project-memory-client/active.json");
	const noGrant = {
		...credentials,
		project_memory: undefined,
		project_memory_checked_at: "2026-11-10T00:00:00Z",
	};
	const unavailable = { ...noGrant, project_memory_status: "unavailable" as const };
	applyChoice(await choose({ clients: ["claude-code"], credentials: unavailable }), unavailable);
	expect(existsSync(activation)).toBe(true);
	applyChoice(await choose({ clients: ["claude-code"], credentials: noGrant }), noGrant);
	expect(existsSync(activation)).toBe(false);
	for (const path of [".codex/hooks.json", ".claude/settings.json"])
		expect(readJson(join(home, path)).hooks).toEqual({});
	expect(readHookPreferences(home)).toEqual(before);
});

it("preserves declines through cleanup", async () => {
	writeHookPreferences({ "claude-code": { memory: false, diagnostics: false } }, home);
	await choose({ clients: ["claude-code", "codex"], ask: async () => true });
	resetHookPreferences(false, home);
	expect(readHookPreferences(home)).toEqual({
		"claude-code": { memory: false, diagnostics: false },
	});
});

it("restores missing memory hooks during setup and respects native disable", async () => {
	configure({ enable: true });
	expect((await choose({ ask: async () => false })).accepted).toEqual(["codex"]);
	const path = join(home, ".codex/hooks.json");
	writeFileSync(path, '{"hooks":{"Notification":[]}}');
	applyChoice(await choose());
	expect(readJson(path).hooks.UserPromptSubmit).toHaveLength(1);
	writeFileSync(join(home, ".claude/settings.json"), '{"disableAllHooks":true}');
	expect((await choose({ clients: ["claude-code"], requested: true })).accepted).toEqual([]);
});

/** Breaks when: proxy start installs without a hint, over a decline, an edit or disableAllHooks, silently, or twice. */
it("turns memory reminders on at proxy start once, visibly, and never over a decline, an edit or disableAllHooks", () => {
	const ensure = (name: string, creds: Credentials = credentials) =>
		ensureMemoryHooks({ name }, creds, { ...installOptions() });
	const claude = join(home, ".claude/settings.json");
	const codex = join(home, ".codex/hooks.json");
	const lost = {
		...credentials,
		project_memory: undefined,
		project_memory_checked_at: "2026-11-10T00:00:00Z",
	};
	expect(ensure("claude-code", lost)).toEqual([]);
	expect(existsSync(claude)).toBe(false);
	expect(ensure("claude-code")).toEqual([
		expect.stringContaining("run `npx @pharaoh-so/mcp --disable-memory-hooks`"),
	]);
	expect(memoryHookStateForClient({ name: "claude-code" }, { home, env: {} })).toBe("installed");
	const written = readFileSync(claude, "utf8");
	expect(ensure("claude-code")).toEqual([]);
	expect(readFileSync(claude, "utf8")).toBe(written);
	expect(ensure("codex-mcp-client")).toEqual([
		expect.stringContaining("in Codex"),
		expect.stringContaining("/hooks or Settings > Hooks"),
	]);
	// An install from before the memory cue came with memory gains it once, without the
	// structural cues; Codex is told to trust the new hook.
	const reminderOnly = readJson(codex);
	delete reminderOnly.hooks.PostToolUse;
	writeJson(codex, reminderOnly);
	chmodSync(join(home, ".codex"), 0o500);
	try {
		expect(ensure("codex")).toEqual([]);
	} finally {
		chmodSync(join(home, ".codex"), 0o700);
	}
	expect(ensure("codex")).toEqual([expect.stringContaining("/hooks or Settings > Hooks")]);
	const upgraded = readJson(codex).hooks;
	// The edit cue and the capture recorder; no structural cues.
	expect([upgraded.PostToolUse?.length, upgraded.PreToolUse]).toEqual([2, undefined]);
	expect(ensure("codex")).toEqual([]);
	const edited = written.replace("--user", "--user --mine");
	writeFileSync(claude, edited);
	expect(memoryHookStateForClient({ name: "claude-code" }, { home, env: {} })).toBe("unknown");
	expect(ensure("claude-code")).toEqual([]);
	expect(readFileSync(claude, "utf8")).toBe(edited);
	writeFileSync(claude, '{"disableAllHooks":true}');
	expect(ensure("claude-code")).toEqual([]);
	expect(readFileSync(claude, "utf8")).toBe('{"disableAllHooks":true}');
	rmSync(codex);
	writeHookPreferences({ codex: { memory: false } }, home);
	expect(ensure("codex")).toEqual([]);
	expect(existsSync(codex)).toBe(false);
});

/** Breaks when: a saved diagnostics choice restores Stop handlers the user removed, on first install or an upgrade. */
it("never puts back diagnostic handlers at proxy start, on first install or a bundle upgrade", () => {
	const ensure = () =>
		ensureMemoryHooks({ name: "claude-code" }, credentials, { ...installOptions() });
	const claude = join(home, ".claude/settings.json");
	// The capture hook also runs on Stop; this test is about the diagnostics handler.
	const stop = () => JSON.stringify(readJson(claude).hooks?.Stop ?? []).includes("--diagnostics");
	writeHookPreferences({ "claude-code": { memory: true, diagnostics: true } }, home);
	expect(ensure()).toHaveLength(1);
	expect(stop()).toBe(false);
	expect(readHookPreferences(home)["claude-code"]?.diagnostics).toBeUndefined();
	// Installed with consent, then the user removes the Stop handler and a new bundle ships.
	writeHookPreferences({ "claude-code": { memory: true, diagnostics: true } }, home);
	configure({ enable: true, clients: ["claude-code"] });
	expect(stop()).toBe(true);
	const settings = readJson(claude);
	delete settings.hooks.Stop;
	writeJson(claude, settings);
	const active = join(home, ".pharaoh/project-memory-client/active.json");
	const before = readFileSync(active, "utf8");
	appendFileSync(new URL("project-memory/local.mjs", packageRoot), "\n// next release\n");
	expect(ensure()).toEqual([]);
	expect(readFileSync(active, "utf8")).not.toBe(before);
	expect(stop()).toBe(false);
	expect(memoryHookStateForClient({ name: "claude-code" }, { home, env: {} })).toBe("installed");
});

it("removes owned pilot hooks during default setup without changing unrelated settings", () => {
	const codex = join(home, ".codex/hooks.json");
	configure({ enable: true });
	const activation = join(home, ".pharaoh/project-memory-client/active.json");
	expect(existsSync(activation)).toBe(true);
	const old = commandHook("/old/pharaoh-memory-hook.mjs # pharaoh-project-memory:user-v1");
	const keep = commandHook("/user/tool.mjs # pharaoh-project-memory:user-v1");
	const notification = [{ hooks: [commandHook("keep-notification")] }];
	writeJson(codex, {
		hooks: {
			UserPromptSubmit: [{ hooks: [old, keep] }],
			Stop: [{ hooks: [old] }],
			Interrupt: [{ hooks: [old] }],
			SessionEnd: [],
			Notification: notification,
			StopFailure: [],
		},
		otherSetting: true,
	});
	const legacy = legacySettings();
	const elsewhere = join(home, "other-checkout");
	git("worktree", "add", "--quiet", "--detach", elsewhere);
	const elsewhereSettings = join(elsewhere, ".codex/hooks.json");
	mkdirSync(join(elsewhere, ".codex"));
	const elsewhereMarker = createHash("sha256").update(`codex\0${elsewhere}`).digest("hex");
	const elsewhereConfig = JSON.stringify({
		hooks: {
			UserPromptSubmit: [
				{
					hooks: [
						commandHook(`/old/pharaoh-memory-hook.mjs # pharaoh-project-memory:${elsewhereMarker}`),
					],
				},
			],
		},
	});
	writeFileSync(elsewhereSettings, elsewhereConfig);
	const credentialsFile = join(home, ".pharaoh/credentials.json");
	const originalCredentials = readFileSync(credentialsFile, "utf8");
	expect(configure({ credentials: undefined })).toEqual([]);
	expect(readJson(codex)).toEqual({
		hooks: {
			UserPromptSubmit: [{ hooks: [keep] }],
			SessionEnd: [],
			Notification: notification,
			StopFailure: [],
		},
		otherSetting: true,
	});
	expect(readJson(legacy)).toEqual({
		hooks: { UserPromptSubmit: [{ hooks: [commandHook("keep-checkout-hook")] }] },
	});
	expect(readFileSync(elsewhereSettings, "utf8")).toBe(elsewhereConfig);
	expect(readFileSync(credentialsFile, "utf8")).toBe(originalCredentials);
	expect(existsSync(activation)).toBe(false);
	expect(configure()).toEqual([]);
});

it("deactivates loaded user hooks and leaves tracked checkout settings alone", () => {
	configure({ enable: true });
	const codex = join(home, ".codex/hooks.json");
	const activation = join(home, ".pharaoh/project-memory-client/active.json");
	const legacy = legacySettings();
	git("add", "--force", ".codex/hooks.json");
	const original = readFileSync(legacy, "utf8");
	writeFileSync(codex, "invalid settings");
	expect(configure().join(" ")).toContain("could not update codex project memory hooks");
	expect(existsSync(activation)).toBe(false);
	expect(readFileSync(codex, "utf8")).toBe("invalid settings");
	expect(readFileSync(legacy, "utf8")).toBe(original);
	configure({ env: { CODEX_HOME: join(checkout, ".codex") } });
	expect(readFileSync(legacy, "utf8")).toBe(original);
});

it("protects tracked checkout hooks when CODEX_HOME points through a linked ancestor", () => {
	const legacy = legacySettings();
	git("add", "--force", ".codex/hooks.json");
	const original = readFileSync(legacy, "utf8");
	const alias = join(home, "linked-checkout");
	symlinkSync(checkout, alias, "dir");
	const env = { CODEX_HOME: join(alias, ".codex") };
	expect(configure({ env }).join(" ")).toContain("could not update codex project memory hooks");
	expect(readFileSync(legacy, "utf8")).toBe(original);
});

it("keeps working settings and checkout hooks until a replacement is active", () => {
	configure({ enable: true });
	const codex = join(home, ".codex/hooks.json");
	const activation = join(home, ".pharaoh/project-memory-client/active.json");
	const originalSettings = readFileSync(codex, "utf8");
	const originalActivation = readFileSync(activation, "utf8");
	const legacy = legacySettings();
	const originalLegacy = readFileSync(legacy, "utf8");

	expect(
		configure({
			enable: true,
			packageRoot: new URL("missing/", packageRoot),
		}).join(" "),
	).toContain("reminders unavailable");
	expect(readFileSync(codex, "utf8")).toBe(originalSettings);
	expect(readFileSync(activation, "utf8")).toBe(originalActivation);
	expect(readFileSync(legacy, "utf8")).toBe(originalLegacy);

	appendFileSync(
		new URL("project-memory/pharaoh-memory-hook.mjs", packageRoot),
		"// replacement\n",
	);
	const alias = join(home, "linked-codex");
	symlinkSync(join(home, ".codex"), alias, "dir");
	expect(
		configure({
			enable: true,
			clients: ["codex"],
			env: { CODEX_HOME: alias },
		}).join(" "),
	).toContain("could not update codex project memory hooks");
	expect(readFileSync(codex, "utf8")).toBe(originalSettings);
	expect(readFileSync(activation, "utf8")).toBe(originalActivation);
	expect(readFileSync(legacy, "utf8")).toBe(originalLegacy);

	expect(configure({ enable: true, clients: ["codex"] })).toEqual([]);
	expect(readFileSync(activation, "utf8")).not.toBe(originalActivation);
	expect(prompt(codex, checkout)).toContain("pharaoh_memory_recall");
	expect(readFileSync(legacy, "utf8")).not.toContain("pharaoh-project-memory");
});

it("disables quietly with unrelated linked settings and fails for known linked hooks", () => {
	const external = join(home, "user-settings.json");
	const unrelated = '{"hooks":{"Notification":[]}}\n';
	writeFileSync(external, unrelated);
	const codex = join(home, ".codex");
	mkdirSync(codex);
	symlinkSync(external, join(codex, "hooks.json"));
	mkdirSync(join(checkout, ".claude"));
	symlinkSync(external, join(checkout, ".claude/settings.local.json"));
	expect(configure({ credentials: undefined })).toEqual([]);

	function disable() {
		return spawnSync(
			process.execPath,
			[
				require.resolve("tsx/cli"),
				fileURLToPath(new URL("../src/index.ts", import.meta.url)),
				"--disable-memory-hooks",
			],
			{
				cwd: checkout,
				env: {
					...process.env,
					HOME: home,
					CODEX_HOME: codex,
					CLAUDE_CONFIG_DIR: join(home, ".claude"),
				},
				encoding: "utf8",
				timeout: 5_000,
			},
		);
	}
	const clean = disable();
	expect(clean).toMatchObject({ status: 0, stdout: "", stderr: "" });
	expect(readFileSync(external, "utf8")).toBe(unrelated);
	expect(readHookPreferences(home)).toEqual({
		"claude-code": { memory: false, graph: false, diagnostics: false, capture: false },
		codex: { memory: false, graph: false, diagnostics: false, capture: false },
	});

	const managed = JSON.stringify({
		hooks: {
			Stop: [
				{ hooks: [commandHook("/old/pharaoh-memory-hook.mjs # pharaoh-project-memory:user-v1")] },
			],
		},
	});
	writeFileSync(external, managed);
	const blocked = disable();
	expect(blocked.status).toBe(1);
	expect(blocked.stderr + blocked.stdout).toContain("could not update codex project memory hooks");
	expect(readFileSync(external, "utf8")).toBe(managed);
}, 15_000);

it("opts in to one MCP reminder per client and scopes it to eligible worktrees", async () => {
	const claude = join(home, ".claude/settings.json");
	const codex = join(home, ".codex/hooks.json");
	expect(configure({ enable: true })).toEqual([]);
	const first = readFileSync(codex, "utf8");
	configure({ enable: true });
	expect(readFileSync(codex, "utf8")).toBe(first);
	const worktree = join(home, "worktree");
	git("worktree", "add", "--quiet", "--detach", worktree);
	for (const file of [claude, codex]) {
		expect(Object.keys(readJson(file).hooks)).toEqual(
			file === claude
				? ["UserPromptSubmit", "Stop", "PostToolUse", "PostToolUseFailure"]
				: ["UserPromptSubmit", "Stop", "PostToolUse"],
		);
		const reminder = prompt(file, worktree);
		expect(reminder).toContain("pharaoh_memory_recall");
		expect(reminder).toContain("pharaoh_memory_expand");
		expect(reminder).toContain("pharaoh_memory_capture");
		expect(reminder).not.toContain("--turn");
		expect(prompt(file, worktree, {}, "Stop")).toBe("");
		expect(prompt(file, home)).toBe("");
	}
	// Once Pharaoh says the plan keeps memories without giving them back: no reminder at all.
	writeCredentials(
		{ ...credentials, project_memory_session: SESSION },
		join(home, ".pharaoh/credentials.json"),
	);
	await retrieval(SESSION, true);
	expect(prompt(codex, worktree)).toBe("");
	// A similarly named origin without the mapped object must not enroll.
	const spoof = join(home, "spoof");
	execFileSync("git", ["init", "-q", spoof]);
	execFileSync("git", ["-C", spoof, "remote", "add", "origin", `https://github.com/${repo}.git`]);
	expect(prompt(codex, spoof)).toBe("");
	writeCredentials(
		{ ...credentials, project_memory: undefined },
		join(home, ".pharaoh/credentials.json"),
	);
	expect(prompt(codex, worktree)).toBe("");
	expect(existsSync(join(home, ".pharaoh/project-memory-turns-v2"))).toBe(false);
});

it("can opt in from an unrelated repository rooted at the user's home", () => {
	const dotfiles = "https://github.com/fixture/dotfiles.git";
	execFileSync("git", ["init", "-q", home]);
	execFileSync("git", ["-C", home, "remote", "add", "origin", dotfiles]);
	expect(configure({ cwd: home, clients: ["codex"], enable: true })).toEqual([]);
	expect(existsSync(join(home, ".codex/hooks.json"))).toBe(true);
});

it("uses only readiness metadata to enable the reminder after first map", () => {
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
	const settings = join(home, ".codex/hooks.json");
	expect(configure({ credentials: pending, clients: ["codex"], enable: true })).toEqual([]);
	const installed = readFileSync(settings, "utf8");
	// Later prompts run the private installed runtime, independent of the package cache.
	rmSync(packageRoot, { recursive: true });
	const shim = join(home, "readiness-fixture.mjs");
	const requests = join(home, "memory-requests.txt");
	writeFileSync(
		shim,
		`
		import { appendFileSync } from "node:fs";
		const now = Date.now.bind(Date);
		Date.now = () => now() + Number(process.env.FIXTURE_OFFSET ?? 0);
		globalThis.fetch = async (url, options) => {
			appendFileSync(process.env.FIXTURE_REQUESTS, String(url) + "\\n");
			if (String(url) !== "https://mcp.pharaoh.so/api/project-memory/readiness" ||
				options.redirect !== "error" || options.body !== JSON.stringify({repo: "fixture/project"}))
				throw new Error("Unexpected fixture request");
			if (process.env.FIXTURE_STATUS === "denied") return new Response(null, {status: 404});
			return new Response(JSON.stringify({revision: process.env.FIXTURE_REVISION || null}));
		};
	`,
	);
	const env = { NODE_OPTIONS: `--import=${shim}`, FIXTURE_REQUESTS: requests };
	expect(prompt(settings, checkout, { ...env, FIXTURE_STATUS: "denied" })).toBe("");
	expect(prompt(settings, checkout, { ...env, FIXTURE_OFFSET: "16000" })).toBe("");
	const enabled = prompt(settings, checkout, {
		...env,
		FIXTURE_OFFSET: "32000",
		FIXTURE_REVISION: revision,
	});
	expect(enabled).toContain("pharaoh_memory_recall");
	expect(prompt(settings, checkout, env, "Stop")).toBe("");
	expect(readFileSync(settings, "utf8")).toBe(installed);
	const replacement = signIn("new-device-session");
	expect(replacement.project_memory_session).not.toBe(pending.project_memory_session);
	writeCredentials(replacement, credentialsFile);
	expect(
		prompt(settings, checkout, { ...env, FIXTURE_OFFSET: "48000", FIXTURE_STATUS: "denied" }),
	).toBe("");
	expect(readFileSync(requests, "utf8").trim().split("\n")).toEqual(
		Array(4).fill("https://mcp.pharaoh.so/api/project-memory/readiness"),
	);
});

const diagnosticPolicy = {
	enabled: true,
	contentEnabled: true,
	policyVersion: "memory-diagnostics-v1",
	retentionDays: 90,
	noticeSatisfied: true,
};

it("offers diagnostics separately after policy eligibility and retains explicit choice through reset", async () => {
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
		const body = JSON.parse(String(options.body));
		requests.push({ url: String(url), body });
		return new Response(
			JSON.stringify(
				String(url).endsWith("/control")
					? {
							enabled: body.enabled,
							generation: body.generation,
							policyVersion: body.policyVersion,
						}
					: { revision: git("rev-parse", "HEAD"), diagnosticsPolicy: diagnosticPolicy },
			),
		);
	});
	const prompts: Array<{ question: string; defaultAnswer: boolean }> = [];
	const decision = await choose({
		ask: async (question, defaultAnswer) => {
			prompts.push({ question, defaultAnswer });
			return true;
		},
	});
	expect(prompts.map((entry) => entry.defaultAnswer)).toEqual([false, false]);
	expect(prompts[1].question).toContain("1 MB/24 h");
	expect(prompts[1].question).toContain("90 days");
	expect(requests.find((entry) => entry.url.endsWith("/control"))?.body).toMatchObject({
		repo,
		clientName: "codex",
		enabled: true,
	});
	const accepted = readHookPreferences(home).codex;
	expect(accepted).toMatchObject({
		diagnostics: true,
		diagnosticsPolicyVersion: diagnosticPolicy.policyVersion,
		diagnosticsGeneration: expect.any(String),
	});
	applyChoice(decision);
	const settings = readJson(join(home, ".codex/hooks.json"));
	expect(settings.hooks.Stop[0].hooks[0].command).toContain("--diagnostics");
	expect(
		settings.hooks.PostToolUse.some((group: { matcher: string }) =>
			group.matcher.includes("pharaoh_memory"),
		),
	).toBe(true);
	resetHookPreferences(false, home);
	expect(readHookPreferences(home).codex).toMatchObject({
		diagnostics: true,
		diagnosticsGeneration: accepted?.diagnosticsGeneration,
	});
});

function diagnosticFixture() {
	credentials.project_memory_session = randomUUID();
	writeCredentials(credentials, join(home, ".pharaoh/credentials.json"));
	const generation = randomUUID();
	writeHookPreferences(
		{
			codex: {
				memory: true,
				diagnostics: true,
				diagnosticsGeneration: generation,
				diagnosticsPolicyVersion: diagnosticPolicy.policyVersion,
			},
		},
		home,
	);
	configure({ clients: ["codex"], enable: true });
	const digest = readJson(join(home, ".pharaoh/project-memory-client/active.json")).codex;
	const runtime = join(home, ".pharaoh/project-memory-client", digest);
	const directory = join(home, ".pharaoh/project-memory-client/diagnostics/codex");
	const options = {
		client: "codex",
		target: { root: checkout, repo },
		credentials,
		policy: { ...diagnosticPolicy, generation },
		runtime,
		home,
		spawnSender: false,
	};
	const input = { session_id: "native-session", turn_id: "native-turn", cwd: checkout };
	const collect = (event: object, overrides = {}) =>
		collectDiagnosticEvent({ ...input, ...event }, { ...options, ...overrides });
	return { options, input, runtime, directory, collect };
}

function diagnosticSender(fixture: ReturnType<typeof diagnosticFixture>) {
	return {
		home,
		runtime: fixture.runtime,
		readCredentials: async () => credentials,
		policyRequest: async () => fixture.options.policy,
	};
}

it("restores the reminder after cleanup without accepting piped input for optional hooks", async () => {
	diagnosticFixture();
	const savedGeneration = readHookPreferences(home).codex?.diagnosticsGeneration;
	resetHookPreferences(false, home);
	configure({ credentials: undefined });
	expect(readHookPreferences(home).codex?.diagnosticsGeneration).toBe(savedGeneration);
	const request = vi.fn(
		async () => new Response(JSON.stringify({ diagnosticsPolicy: diagnosticPolicy })),
	);
	vi.stubGlobal("fetch", request);
	const input = new PassThrough();
	input.end("y\ny\n");
	const output = Object.assign(new PassThrough(), { isTTY: true });
	const decision = await choose({
		ask: (question, defaultAnswer) => askYesNoInTerminal(question, defaultAnswer, input, output),
	});
	applyChoice(decision);
	const { hooks } = readJson(join(home, ".codex/hooks.json"));
	expect(hooks.UserPromptSubmit).toHaveLength(1);
	expect(hooks.PreToolUse).toBeUndefined();
	expect(JSON.stringify(hooks.Stop)).not.toContain("--diagnostics");
	expect(readHookPreferences(home).codex?.diagnostics).toBeUndefined();
	expect(String(input.read())).toBe("y\ny\n");
	expect(output.read()).toBeNull();
	expect(request).toHaveBeenCalledTimes(1);
});

it("links actual native recall results, bounds excerpts and excludes file/patch/shell bodies", async () => {
	const fixture = diagnosticFixture();
	const collect = (event: object) => fixture.collect(event);
	const prompt = collect({
		hook_event_name: "UserPromptSubmit",
		prompt: `Investigate the failing memory delivery. ${"x".repeat(1500)}`,
	});
	const recallId = randomUUID();
	const record = { id: randomUUID(), version: 3 };
	const recall = collect({
		hook_event_name: "PostToolUse",
		tool_name: "mcp__pharaoh__pharaoh_memory_recall",
		tool_input: { repo, turnRef: "agent-forged-turn" },
		tool_response: {
			content: [{ type: "text", text: JSON.stringify({ recallId, records: [record] }) }],
		},
	});
	collect({
		hook_event_name: "PostToolUse",
		tool_name: "apply_patch",
		tool_input: {
			command: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n+RAW_PATCH_SECRET\n*** End Patch",
		},
		tool_response: "Success. Updated the following files:",
	});
	collect({
		hook_event_name: "PostToolUse",
		tool_name: "Read",
		tool_input: { file_path: "src/private.ts" },
		tool_response: "RAW_FILE_SECRET",
	});
	collect({
		hook_event_name: "PostToolUse",
		tool_name: "Bash",
		tool_input: { command: "printf RAW_COMMAND_SECRET", description: "Check the revised artifact" },
		tool_response: { exit_code: 0, output: "RAW_OUTPUT_SECRET" },
	});
	collect({
		hook_event_name: "Stop",
		last_assistant_message: `Repaired the delivery path. ${"z".repeat(2200)}`,
	});
	expect(recall?.turnRef).toBe(prompt?.turnRef);
	expect(recall?.payload).toMatchObject({ recallId, records: [record] });
	expect(prompt?.payload).toEqual({ coverage: { eligibility: "eligible", linkage: "native" } });
	const files = readdirSync(fixture.directory).filter((name) => name.startsWith("event-"));
	const spool = files.map((name) => readFileSync(join(fixture.directory, name), "utf8")).join("\n");
	expect(spool).not.toMatch(/RAW_(?:PATCH|FILE|COMMAND|OUTPUT)_SECRET|agent-forged-turn/);
	expect(spool).toContain("src/a.ts");
	expect(lstatSync(fixture.directory).mode & 0o777).toBe(0o700);
	for (const name of files)
		expect(lstatSync(join(fixture.directory, name)).mode & 0o777).toBe(0o600);
	const sent: Array<{ events: Array<{ eventId: string }> }> = [];
	await flushDiagnosticQueue("codex", {
		...diagnosticSender(fixture),
		request: async (_operation: string, payload: { events: Array<{ eventId: string }> }) => {
			sent.push(payload);
			return { acceptedEventIds: payload.events.map((event) => event.eventId) };
		},
	});
	expect(sent.flatMap((batch) => batch.events)).toHaveLength(5);
	for (const batch of sent) expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(12_000);
	expect(readdirSync(fixture.directory).filter((name) => name.startsWith("event-"))).toEqual([]);
});

it("keeps first-prompt diagnostics content-free before the local scope hook runs", async () => {
	const fixture = diagnosticFixture();
	const secret = "PRIVATE_SAVED_SELECTOR";
	const prompt = fixture.collect({ hook_event_name: "UserPromptSubmit", prompt: secret });
	const file = join(fixture.directory, `event-${prompt?.eventId}.json`);
	const before = readFileSync(file, "utf8");
	expect(before).not.toContain(secret);
	expect(
		sessionLocalSensitivity(conversationMemoryBinding("codex", fixture.input.session_id), { home }),
	).toBe("clear");
	// Simulate a queued prompt observation from the previous collector format.
	const queued = JSON.parse(before);
	queued.event.payload.taskSummary = secret;
	writeJson(file, queued);
	const fetcher = vi.fn(async (_url: string, request: RequestInit) => {
		const { events } = JSON.parse(request.body as string) as { events: Array<{ eventId: string }> };
		return Response.json({ acceptedEventIds: events.map((event) => event.eventId) });
	});
	await flushDiagnosticQueue("codex", {
		...diagnosticSender(fixture),
		request: (operation: string, payload: unknown, options: Record<string, unknown>) =>
			requestMemory(operation, payload, { ...options, fetcher }),
	});
	expect(fetcher).toHaveBeenCalledOnce();
	const wire = fetcher.mock.calls[0][1].body as string;
	expect(wire).toContain("turn_observed");
	expect(wire).not.toContain(secret);
});

it("redacts shell action excerpts and fences finals after a local-capable CLI attempt", async () => {
	const fixture = diagnosticFixture();
	const privateName = "PRIVATE_SAVED_SELECTOR";
	const collect = (session_id: string, event: object) => fixture.collect({ session_id, ...event });
	const shell = (session: string, cmd: string) =>
		collect(session, {
			hook_event_name: "PostToolUse",
			tool_name: "functions.exec_command",
			tool_input: { cmd, description: privateName },
			tool_response: { exit_code: 1 },
		});
	const local = shell(
		fixture.input.session_id,
		`npx -y @pharaoh-so/mcp@latest get_blast_radius --entity ${privateName}`,
	);
	expect(local?.payload).toEqual({ operation: "shell_task", status: "error" });
	const binding = conversationMemoryBinding("codex", fixture.input.session_id);
	expect(sessionLocalSensitivity(binding, { home })).toBe("local");
	expect(
		collect(fixture.input.session_id, {
			hook_event_name: "Stop",
			last_assistant_message: `The query for ${privateName} was refused.`,
		})?.payload,
	).toEqual({ completion: "stop_observed" });

	const hostedSession = "explicit-hosted-shell";
	const hosted = shell(
		hostedSession,
		"npx -y @pharaoh-so/mcp@latest get_blast_radius --scope hosted --entity defaultBranch",
	);
	expect(sessionLocalSensitivity(conversationMemoryBinding("codex", hostedSession), { home })).toBe(
		"clear",
	);
	const file = join(fixture.directory, `event-${hosted?.eventId}.json`);
	const queued = readJson(file);
	// Earlier queues did not include command provenance with a shell excerpt.
	delete queued.metadataOnly;
	queued.root = checkout;
	queued.event.payload.actionExcerpt = privateName;
	writeJson(file, queued);
	collect(hostedSession, {
		hook_event_name: "Stop",
		last_assistant_message: "Hosted graph answer.",
	});
	const sent: Array<{ events: Array<{ eventId: string }> }> = [];
	await flushDiagnosticQueue("codex", {
		...diagnosticSender(fixture),
		request: async (_operation: string, payload: { events: Array<{ eventId: string }> }) => {
			sent.push(payload);
			return { acceptedEventIds: payload.events.map((event) => event.eventId) };
		},
	});
	const wire = JSON.stringify(sent);
	expect(wire).toContain("shell_task");
	expect(wire).toContain("Hosted graph answer.");
	expect(wire).not.toContain(privateName);
});

it("redacts one opted-in conversation across queued delivery, restart and resume", async () => {
	const fixture = diagnosticFixture();
	const binding = conversationMemoryBinding("codex", fixture.input.session_id);
	expect(binding).toBeDefined();
	const now = Date.now();
	const collect = (event: object, at = now) => fixture.collect(event, { now: at });
	expect(
		collect({
			hook_event_name: "Stop",
			last_assistant_message: "QUEUED_PRIVATE_LOCAL_CALLER",
		})?.payload,
	).toMatchObject({ finalExcerpt: "QUEUED_PRIVATE_LOCAL_CALLER" });
	expect(
		collect({
			session_id: "unrelated-native-session",
			hook_event_name: "Stop",
			last_assistant_message: "An unrelated hosted answer",
		})?.payload,
	).toMatchObject({ finalExcerpt: "An unrelated hosted answer" });
	const fetcher = vi.fn(async (_url: string, request: RequestInit) => {
		const { events } = JSON.parse(request.body as string) as { events: Array<{ eventId: string }> };
		return Response.json({ acceptedEventIds: events.map((event) => event.eventId) });
	});
	const sender = {
		...diagnosticSender(fixture),
		now: () => now,
		policyRequest: async () => {
			// A local claim races an already-awaiting sender.
			expect(markSessionLocal(binding, { home })).toBe(true);
			return fixture.options.policy;
		},
		request: (operation: string, payload: unknown, options: Record<string, unknown>) =>
			requestMemory(operation, payload, { ...options, fetcher }),
	};
	await flushDiagnosticQueue("codex", sender);
	expect(fetcher).toHaveBeenCalledOnce();
	const sent = fetcher.mock.calls[0][1].body as string;
	expect(sent).not.toContain("QUEUED_PRIVATE_LOCAL_CALLER");
	expect(sent).toContain("An unrelated hosted answer");
	expect(sent).toContain(binding?.sessionRef);

	for (const event of [
		{ hook_event_name: "Stop", last_assistant_message: "PRIVATE_LOCAL_CALLER" },
		{
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { description: "PRIVATE_LOCAL_CALLER" },
			tool_use_id: "PRIVATE_LOCAL_CALLER",
		},
		{
			hook_event_name: "PostToolUse",
			tool_name: "apply_patch",
			tool_input: { patch: "*** Update File: PRIVATE_LOCAL_CALLER.ts" },
		},
	])
		expect(collect(event)).toBeDefined();
	const spooled = readdirSync(fixture.directory)
		.filter((name) => name.startsWith("event-"))
		.map((name) => readFileSync(join(fixture.directory, name), "utf8"))
		.join("\n");
	expect(spooled).not.toContain("PRIVATE_LOCAL_CALLER");
	expect(spooled).not.toContain(checkout);
	expect(spooled).toContain('"metadataOnly":true');
	expect(spooled).toContain("stop_observed");
	expect(spooled).toContain("shell_task");
	expect(readHookPreferences(home).codex?.diagnostics).toBe(true);

	const marker = join(
		home,
		".pharaoh",
		"local-worktree",
		"conversation-v1",
		`${binding?.sessionRef}.local`,
	);
	expect(lstatSync(marker).mode & 0o777).toBe(0o600);
	expect(readFileSync(marker, "utf8")).toBe("local-v1\n");
	collect({ hook_event_name: "SessionEnd" });
	const resumed = collect(
		{
			hook_event_name: "UserPromptSubmit",
			turn_id: "resumed-turn",
			prompt: "PRIVATE_LOCAL_CALLER_FROM_PREVIOUS_TURN",
		},
		now + 13 * 60 * 60_000,
	);
	expect(resumed?.payload).not.toHaveProperty("taskSummary");
	expect(sessionLocalSensitivity(binding, { home })).toBe("local");
	await flushDiagnosticQueue("codex", { ...sender, now: () => now + 13 * 60 * 60_000 });
	expect(fetcher).toHaveBeenCalledTimes(2);
	const resumedWire = fetcher.mock.calls[1][1].body as string;
	expect(resumedWire).toContain("stop_observed");
	expect(resumedWire).not.toContain("PRIVATE_LOCAL_CALLER");
	expect(resumedWire).not.toContain(checkout);
});

it("fences uncertain or damaged conversation state without disabling unrelated diagnostics", () => {
	const binding = conversationMemoryBinding("codex", "local-session");
	const unrelated = conversationMemoryBinding("claude-code", "local-session");
	expect(sessionLocalSensitivity(binding, { home })).toBe("clear");
	expect(markSessionLocal(binding, { home })).toBe(true);
	expect(markSessionLocal(binding, { home })).toBe(true);
	expect(sessionLocalSensitivity(unrelated, { home })).toBe("clear");
	expect(memoryEgressDecision(undefined, "recall", { home })).toBe("blocked");
	expect(memoryEgressDecision(undefined, "anchored", { home })).toBe("normal");
	expect(memoryEgressDecision(undefined, "diagnostics", { home })).toBe("metadata");
	expect(memoryEgressDecision(null, "recall", { home })).toBe("normal");
	const marker = join(
		home,
		".pharaoh",
		"local-worktree",
		"conversation-v1",
		`${binding?.sessionRef}.local`,
	);
	writeFileSync(marker, "damaged");
	expect(sessionLocalSensitivity(binding, { home })).toBe("unknown");
	expect(markSessionLocal(binding, { home })).toBe(false);
	expect(memoryEgressDecision(binding, "capture", { home })).toBe("blocked");
	expect(memoryEgressDecision(unrelated, "diagnostics", { home })).toBe("normal");
});

it("distinguishes the earlier checkout memory hook from clean settings", () => {
	expect(legacyMemoryHooksMayRun("codex", checkout)).toBe(false);
	const path = legacySettings();
	expect(legacyMemoryHooksMayRun("codex", checkout)).toBe(true);
	expect(legacyMemoryHooksMayRun("claude-code", checkout)).toBe(false);
	writeFileSync(path, "{invalid JSON");
	expect(legacyMemoryHooksMayRun("codex", checkout)).toBe(true);
});

it("rechecks legacy shell turns and HTTP memory egress after asynchronous sign-in", async () => {
	const binding = conversationMemoryBinding("codex", "active-memory-conversation");
	const target = { root: checkout, repo };
	const store = turnStore(home);
	const opened = store.begin(binding?.sessionRef, target, "codex", "native-turn", {
		skip: false,
		readOnly: false,
		memorySession: randomUUID(),
	});
	const fetcher = vi.fn();
	await expect(
		requestMemory(
			"recall",
			{ repo, terms: ["PRIVATE_LOCAL_CALLER"] },
			{
				binding,
				home,
				fetcher,
				helper: {
					originBoundRefresh: () => ({
						load: async () => {
							expect(markSessionLocal(binding, { home })).toBe(true);
							return { ok: true, creds: credentials };
						},
					}),
				},
			},
		),
	).rejects.toThrow("paused for this conversation");
	expect(fetcher).not.toHaveBeenCalled();
	const read = vi.fn();
	const request = vi.fn();
	await expect(
		executeTurn("recall", opened?.token, { target, store, home, read, request }),
	).rejects.toThrow("paused for this conversation");
	expect(read).not.toHaveBeenCalled();
	expect(request).not.toHaveBeenCalled();
});

it("records observed heuristic skips, suppresses opted-out turns and rechecks consent before sending", async () => {
	const fixture = diagnosticFixture();
	const collect = (event: object) => fixture.collect(event);
	const skipped = collect({ hook_event_name: "UserPromptSubmit", prompt: "/help" });
	expect(skipped?.payload.coverage.eligibility).toBe("heuristic_skip");
	collect({ hook_event_name: "UserPromptSubmit", prompt: "skip project memory" });
	expect(
		collect({ hook_event_name: "Stop", last_assistant_message: "OPTED_OUT_FINAL" }),
	).toBeUndefined();
	expect(readdirSync(fixture.directory).filter((name) => name.startsWith("event-"))).toEqual([]);
	collect({
		hook_event_name: "UserPromptSubmit",
		turn_id: "another-turn",
		prompt: "Inspect the new failure",
	});
	const request = vi.fn();
	await flushDiagnosticQueue("codex", {
		...diagnosticSender(fixture),
		policyRequest: async () => {
			writeHookPreferences({ codex: { memory: true, diagnostics: false } }, home);
			return fixture.options.policy;
		},
		request,
	});
	expect(request).not.toHaveBeenCalled();
	resetHookPreferences(true, home);
	expect(existsSync(fixture.directory)).toBe(false);
});

it("recovers dead sender leases and flushes final native events after the silent installed hook exits", async () => {
	const fixture = diagnosticFixture();
	const shim = join(home, "diagnostic-fetch.mjs");
	const received = join(home, "received-diagnostics.jsonl");
	writeFileSync(
		shim,
		`
		import { appendFileSync } from "node:fs";
		globalThis.fetch = async (url, options) => {
			const body = JSON.parse(options.body);
			if (String(url).endsWith("/readiness")) return new Response(JSON.stringify({
				revision: process.env.FIXTURE_REVISION,
				diagnosticsPolicy: JSON.parse(process.env.FIXTURE_POLICY),
				diagnosticsControl: { enabled: true, generation: process.env.FIXTURE_GENERATION, policyVersion: "memory-diagnostics-v1" }
			}));
			if (!String(url).endsWith("/diagnostics")) throw new Error("Unexpected diagnostic request");
			appendFileSync(process.env.FIXTURE_RECEIVED, JSON.stringify(body) + "\\n");
			return new Response(JSON.stringify({ acceptedEventIds: body.events.map((event) => event.eventId) }));
		};
	`,
	);
	// Both leases belong to a process that really exited, including a recent start lease.
	const deadSender = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
	expect(deadSender.status).toBe(0);
	mkdirSync(fixture.directory, { recursive: true, mode: 0o700 });
	for (const name of ["sender.lock", "sender-start.lock"])
		writeFileSync(
			join(fixture.directory, name),
			JSON.stringify({ owner: randomUUID(), pid: deadSender.pid, createdAt: Date.now() }),
			{ mode: 0o600 },
		);
	const settings = join(home, ".codex/hooks.json");
	const execute = (event: object) =>
		execFileSync("/bin/sh", ["-c", hookCommand(settings, "Stop")], {
			cwd: checkout,
			env: {
				...process.env,
				HOME: home,
				NODE_OPTIONS: `--import=${shim}`,
				FIXTURE_REVISION: git("rev-parse", "HEAD"),
				FIXTURE_POLICY: JSON.stringify(diagnosticPolicy),
				FIXTURE_GENERATION: fixture.options.policy.generation,
				FIXTURE_RECEIVED: received,
			},
			input: JSON.stringify({ ...fixture.input, ...event }),
			encoding: "utf8",
			timeout: 4_000,
		});
	expect(
		execute({
			hook_event_name: "Stop",
			last_assistant_message: "Verified the final native artifact.",
		}),
	).toBe("");
	const until = Date.now() + 3_000;
	// The writer creates the file before it writes: wait for a whole line.
	while (
		!(existsSync(received) && readFileSync(received, "utf8").endsWith("\n")) &&
		Date.now() < until
	)
		await new Promise((resolve) => setTimeout(resolve, 20));
	const batches = readFileSync(received, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(batches.flatMap((batch) => batch.events)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: "final_observed",
				payload: expect.objectContaining({
					finalExcerpt: "Verified the final native artifact.",
					completion: "stop_observed",
				}),
			}),
		]),
	);
	expect(readFileSync(received, "utf8")).not.toContain("access_token");
}, 10_000);

it("bounds the spool and turn, reports expiry gaps, and retries stable event IDs until acknowledgement", async () => {
	const fixture = diagnosticFixture();
	for (let index = 0; index < 130; index++)
		fixture.collect({
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { description: `Check expected behavior ${"x".repeat(1800)}` },
			tool_response: { exit_code: 0 },
		});
	const files = readdirSync(fixture.directory).filter((name) => name.startsWith("event-"));
	expect(files.length).toBeLessThanOrEqual(100);
	expect(
		files.reduce((sum, name) => sum + lstatSync(join(fixture.directory, name)).size, 0),
	).toBeLessThanOrEqual(64 * 1024);
	expect(
		readdirSync(fixture.directory).reduce(
			(sum, name) => sum + lstatSync(join(fixture.directory, name)).size,
			0,
		),
	).toBeLessThanOrEqual(1024 * 1024);
	const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
	for (const name of files) utimesSync(join(fixture.directory, name), expired, expired);
	fixture.collect({
		turn_id: "next-native-turn",
		hook_event_name: "UserPromptSubmit",
		prompt: "Verify delivery after the connection returns",
	});
	const queued = () =>
		readdirSync(fixture.directory)
			.filter((name) => name.startsWith("event-"))
			.map((name) => readJson(join(fixture.directory, name)));
	expect(
		queued().find((item) => item.event.kind === "collector_gap")?.event.payload.count,
	).toBeGreaterThan(0);
	const before = queued()
		.map((item) => item.event.eventId)
		.sort();
	const options = { ...diagnosticSender(fixture) };
	await flushDiagnosticQueue("codex", {
		...options,
		request: async () => {
			throw new Error("Unconfirmed delivery");
		},
	});
	expect(
		queued()
			.map((item) => item.event.eventId)
			.sort(),
	).toEqual(before);
	const seen: string[][] = [];
	await flushDiagnosticQueue("codex", {
		...options,
		request: async (_operation: string, payload: { events: Array<{ eventId: string }> }) => {
			seen.push(payload.events.map((event) => event.eventId));
			return { acceptedEventIds: payload.events.map((event) => event.eventId) };
		},
	});
	expect(seen.flat().sort()).toEqual(before);
	expect(queued()).toEqual([]);
});

it("fences a local or unverified MCP conversation before dispatch and preserves other diagnostic consent", async () => {
	const fixture = diagnosticFixture();
	vi.stubEnv("HOME", home);
	const calls: Array<Record<string, unknown>> = [];
	const backend: Backend = {
		name: "sse",
		listTools: async () => [],
		callTool: async (_name, args) => {
			calls.push(args);
			return { content: [] };
		},
	};
	const localBinding = conversationMemoryBinding("codex", "bound-conversation");
	let binding = localBinding;
	const proxy = new ProxyServer(backend, undefined, {
		invocation: { kind: "hosted-only" },
		consume: () => undefined,
		answer: async () => ({ content: [] }),
		memoryBinding: () => binding,
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await proxy.startWithTransport(serverTransport);
	const client = new Client({ name: "codex", version: "1.2.3" });
	await client.connect(clientTransport);
	try {
		const claimed = {
			clientName: "claude-code",
			generation: randomUUID(),
			taskSummary: "Investigate delivery",
			versions: { serverCommit: "forged" },
		};
		await client.callTool({
			name: "pharaoh_memory_recall",
			arguments: { repo, terms: ["delivery"], diagnostics: claimed },
		});
		expect(calls[0].diagnostics).toMatchObject({
			clientName: "codex",
			generation: fixture.options.policy.generation,
			taskSummary: claimed.taskSummary,
			versions: { clientVersion: "1.2.3", collectorVersion: "native-v1" },
		});
		expect(JSON.stringify(calls[0])).not.toContain("forged");
		writeHookPreferences({ codex: { memory: false, diagnostics: false } }, home);
		await client.callTool({
			name: "pharaoh_memory_recall",
			arguments: { repo, terms: ["delivery"], diagnostics: claimed },
		});
		expect(calls[1].diagnostics).toEqual({ taskSummary: claimed.taskSummary });
		expect(markSessionLocal(localBinding, { home })).toBe(true);
		for (const operation of ["recall", "expand", "capture", "feedback"]) {
			await client.callTool({
				name: `pharaoh_memory_${operation}`,
				arguments: {
					repo,
					terms: ["PRIVATE_LOCAL_CALLER"],
					diagnostics: { taskSummary: "PRIVATE_LOCAL_CALLER" },
				},
			});
		}
		binding = undefined;
		await client.callTool({
			name: "pharaoh_memory_recall",
			arguments: { repo, terms: ["UNATTRIBUTED_LOCAL_CALLER"] },
		});
		expect(calls).toHaveLength(2);
		binding = conversationMemoryBinding("codex", "unrelated-conversation");
		await client.callTool({
			name: "pharaoh_memory_recall",
			arguments: { repo, terms: ["unrelated"] },
		});
		expect(calls[2]).toMatchObject({ repo, terms: ["unrelated"] });
	} finally {
		await client.close();
		await proxy.stop();
	}
});

it.each([
	"missing_credentials",
	"different_sign_in",
	"unknown_policy",
	"policy_error",
	"global_pause",
	"superseded_runtime",
])("preserves bounded evidence during %s", async (failure) => {
	const fixture = diagnosticFixture();
	fixture.collect({
		hook_event_name: "UserPromptSubmit",
		prompt: "Inspect the retryable delivery failure",
	});
	const queued = () =>
		readdirSync(fixture.directory)
			.filter((name) => name.startsWith("event-"))
			.map((name) => readFileSync(join(fixture.directory, name), "utf8"));
	const before = queued();
	const request = vi.fn();
	await flushDiagnosticQueue("codex", {
		home,
		runtime: failure === "superseded_runtime" ? join(fixture.runtime, "old") : fixture.runtime,
		readCredentials: async () =>
			failure === "missing_credentials"
				? undefined
				: failure === "different_sign_in"
					? { ...credentials, project_memory_session: randomUUID() }
					: credentials,
		policyRequest: async () => {
			if (failure === "policy_error") throw new Error("Temporary readiness outage");
			return failure === "unknown_policy"
				? undefined
				: failure === "global_pause"
					? { ...fixture.options.policy, enabled: false, contentEnabled: false }
					: fixture.options.policy;
		},
		request,
	});
	expect(queued()).toEqual(before);
	expect(request).not.toHaveBeenCalled();
});

it("removes only a confirmed revoked repo/auth/generation scope and still delivers its valid peer", async () => {
	const fixture = diagnosticFixture();
	const first = fixture.collect({
		hook_event_name: "UserPromptSubmit",
		prompt: "Inspect the first repository",
	});
	const source = readJson(join(fixture.directory, `event-${first?.eventId}.json`));
	const retained = [
		{ ...source, binding: randomUUID(), event: { ...source.event, eventId: randomUUID() } },
		{
			...source,
			collectionGeneration: randomUUID(),
			event: { ...source.event, eventId: randomUUID() },
		},
	];
	for (const item of retained)
		writeFileSync(
			join(fixture.directory, `event-${item.event.eventId}.json`),
			JSON.stringify(item),
			{ mode: 0o600 },
		);
	const otherRoot = join(home, "second-checkout");
	const otherRepo = "fixture/second-project";
	execFileSync("git", ["clone", "--quiet", checkout, otherRoot]);
	execFileSync("git", [
		"-C",
		otherRoot,
		"remote",
		"set-url",
		"origin",
		`https://github.com/${otherRepo}.git`,
	]);
	credentials.project_memory?.push({ repo: otherRepo, revision: git("rev-parse", "HEAD") });
	fixture.collect(
		{
			cwd: otherRoot,
			session_id: "second-session",
			hook_event_name: "UserPromptSubmit",
			prompt: "Inspect the other enrolled repository",
		},
		{ target: { root: otherRoot, repo: otherRepo } },
	);
	const sent: Array<{ repo: string }> = [];
	await flushDiagnosticQueue("codex", {
		...diagnosticSender(fixture),
		policyRequest: async (requestedRepo: string) =>
			requestedRepo === repo
				? {
						...diagnosticPolicy,
						control: {
							enabled: false,
							generation: fixture.options.policy.generation,
							policyVersion: diagnosticPolicy.policyVersion,
						},
					}
				: fixture.options.policy,
		request: async (
			_operation: string,
			payload: { repo: string; events: Array<{ eventId: string }> },
		) => {
			sent.push(payload);
			return { acceptedEventIds: payload.events.map((event) => event.eventId) };
		},
	});
	expect(sent).toEqual([expect.objectContaining({ repo: otherRepo })]);
	const remaining = readdirSync(fixture.directory)
		.filter((name) => name.startsWith("event-"))
		.map((name) => readJson(join(fixture.directory, name)).event.eventId)
		.sort();
	expect(remaining).toEqual(retained.map((item) => item.event.eventId).sort());
});

it("retains a live sender lease and acknowledges permanent rejections without poisoning valid peers", async () => {
	const fixture = diagnosticFixture();
	const collect = (event: object) => fixture.collect(event);
	const prompt = collect({
		hook_event_name: "UserPromptSubmit",
		prompt: "Inspect the rejected event",
	});
	const final = collect({
		hook_event_name: "Stop",
		last_assistant_message: "The valid peer is ready",
	});
	const live = join(fixture.directory, "sender.lock");
	writeFileSync(
		live,
		JSON.stringify({ owner: randomUUID(), pid: process.pid, createdAt: Date.now() - 60_000 }),
		{ mode: 0o600 },
	);
	const request = vi.fn(async (_operation: string, _payload: unknown) => ({
		acceptedEventIds: [final?.eventId],
		rejectedEventIds: [prompt?.eventId],
		gaps: [{ eventId: prompt?.eventId, reason: "event_conflict" }],
	}));
	const options = { ...diagnosticSender(fixture), request };
	await flushDiagnosticQueue("codex", options);
	expect(request).not.toHaveBeenCalled();
	rmSync(live);
	await flushDiagnosticQueue("codex", options);
	expect(request).toHaveBeenCalledTimes(1);
	expect(readdirSync(fixture.directory).filter((name) => name.startsWith("event-"))).toEqual([]);
	expect(readJson(join(fixture.directory, "gaps.json")).count).toBe(1);
});

const reviewChoice = { memory: true, graph: true, capture: false };
function configureClaude(
	choice: typeof reviewChoice & { diagnostics?: boolean } = reviewChoice,
	session = false,
) {
	writeHookPreferences({ "claude-code": choice }, home);
	if (session) {
		credentials.project_memory_session = SESSION;
		writeCredentials(credentials, join(home, ".pharaoh/credentials.json"));
	}
	configure({
		enable: true,
		clients: ["claude-code"],
		graphClients: choice.graph ? ["claude-code"] : [],
	});
	return join(home, ".claude/settings.json");
}

it("opts one existing Claude installation into review with capture off and preserves that choice on reinstall", () => {
	const settings = configureClaude();
	const options = { ...installOptions() };
	const mod = join(home, ".claude", "skills", "pharaoh-change-review");
	expect(existsSync(mod)).toBe(false);
	expect(changeReviewEnabled(home)).toBe(false);
	expect(readJson(settings).hooks.Stop).toBeUndefined();
	expect(configureChangeReview(true, options)).toEqual([]);
	expect(readJson(join(mod, "hooks/hooks.json")).modules).toEqual(["./register.js"]);
	expect(readFileSync(join(mod, "hooks/register.js"), "utf8")).toContain(
		join(
			memoryClientRoot(home),
			packagedMemoryBundle(packageRoot).sha256,
			"pharaoh-memory-hook.mjs",
		),
	);
	rmSync(join(mod, "hooks/register.js"));
	expect(ensureMemoryHooks({ name: "claude-code" }, credentials, options)).toEqual([]);
	expect(existsSync(join(mod, "hooks/register.js"))).toBe(true);
	expect(changeReviewEnabled(home)).toBe(true);
	const hooks = readJson(settings).hooks;
	expect(hooks.Stop).toHaveLength(1);
	expect(hooks.Stop[0].hooks[0].command).toContain("--capture");
	expect(
		hooks.PostToolUse.some(
			(group: { matcher?: string; hooks: Array<{ command: string }> }) =>
				group.hooks.some((hook) => hook.command.includes("--review")) &&
				group.matcher?.includes("pharaoh_recon"),
		),
	).toBe(true);
	expect(readHookPreferences(home)["claude-code"]).toEqual(reviewChoice);
	configure({ enable: true, graphClients: ["claude-code"] });
	expect(readJson(settings).hooks.Stop).toHaveLength(1);
	expect(configureChangeReview(false, options)).toEqual([]);
	expect(existsSync(mod)).toBe(false);
	expect(readJson(settings).hooks.Stop).toBeUndefined();
});

it("keeps the Local receipt plugin private and preserves an edited file and disabled choice", () => {
	const scope = { kind: "local" as const, root: checkout };
	const options = { ...installOptions(), scope };
	writeHookPreferences({ "claude-code": reviewChoice }, home);
	configure({ enable: true, scope, clients: ["claude-code"], graphClients: ["claude-code"] });
	const settings = join(checkout, ".claude/settings.local.json");
	const config = readJson(settings);
	config.enabledPlugins = { "pharaoh-change-review-local@skills-dir": false };
	writeJson(settings, config);
	expect(configureChangeReview(true, options)).toEqual([]);
	const mod = join(checkout, ".claude/skills/pharaoh-change-review-local");
	const module = join(mod, "hooks/register.js");
	expect(readFileSync(module, "utf8")).toContain(JSON.stringify(["--install-root", checkout]));
	expect(git("check-ignore", "--", module)).toContain("pharaoh-change-review-local");
	expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
	writeFileSync(module, "// user edit");
	expect(configureChangeReview(false, options)).toEqual([]);
	expect(readFileSync(module, "utf8")).toBe("// user edit");
	expect(readJson(settings).enabledPlugins).toEqual(config.enabledPlugins);
	expect(existsSync(join(mod, ".claude-plugin/plugin.json"))).toBe(false);
});

it.each([
	false,
	true,
])("keeps the receipt after a continuation unless final delivery is superseded (%s)", async (queued) => {
	const settings = configureClaude();
	expect(configureChangeReview(true, installOptions())).toEqual([]);
	const file = join(home, ".claude/skills/pharaoh-change-review/hooks/register.js");
	const { register } = await import(pathToFileURL(file).href);
	type Handler = (
		client: unknown,
		event: Record<string, unknown>,
		next: () => Promise<unknown>,
	) => Promise<unknown>;
	const hooks: Record<string, Handler> = {};
	register((name: string, handler: Handler) => {
		hooks[name] = handler;
	});
	const answer = { text: "Done" };
	const next = vi.fn(async () => answer);
	const operation = vi.fn(async (args: string[]): Promise<{ exitCode: number; stdout: string }> => {
		if (args.includes("--completion-boundary"))
			return { exitCode: 0, stdout: JSON.stringify({ previousReviewTurn: null }) };
		if (args.includes("--completion-bind"))
			return { exitCode: 0, stdout: JSON.stringify({ reviewTurn: "fixture-nonce" }) };
		if (queued)
			await hooks["prompt.submit"](client, { turnId: "first", origin: { kind: "composer" } }, next);
		return { exitCode: 0, stdout: JSON.stringify({ message: "Fixture receipt" }) };
	});
	const client = {
		session: { id: () => "session", root: () => checkout },
		process: { run: operation },
	};
	await hooks["prompt.submit"](client, { origin: { kind: "composer" } }, next);
	runHook(settings, "UserPromptSubmit", {
		session_id: "session",
		prompt: "Implement the requested change.",
	});
	await hooks["turn.start"](client, { turnId: "first" }, next);
	writeFileSync(join(checkout, "changed.js"), "export const changed = true;");
	const continued = JSON.parse(runHook(settings, "Stop", { session_id: "session" }));
	expect(continued.decision).toBe("block");
	expect(continued.systemMessage).toBeUndefined();
	expect(operation.mock.calls.map(([args]) => args[3])).toEqual([
		"--completion-boundary",
		"--completion-bind",
	]);
	const final = { turnId: "first", answer: "Done", reason: "answer" };
	expect(await hooks["turn.complete"](client, final, next)).toEqual(
		queued ? answer : { text: "Fixture receipt" },
	);
	expect(next).toHaveBeenCalledWith(final);
	expect(final.answer).toBe("Done");
	expect(await hooks["turn.complete"](client, final, next)).toBe(answer);
	expect(operation.mock.calls.map(([args]) => args[3])).toEqual([
		"--completion-boundary",
		"--completion-bind",
		"--completion-receipt",
	]);
});

it("keeps the review active and reports unowned receipt files on enrollment and startup", () => {
	const settings = configureClaude();
	const mod = join(home, ".claude/skills/pharaoh-change-review");
	mkdirSync(mod, { recursive: true });
	writeFileSync(join(mod, "SKILL.md"), "Mine");
	const notices = configureChangeReview(true, installOptions());
	expect(notices).toEqual([
		expect.stringContaining("could not install verified receipts for your Claude Code profile"),
	]);
	expect(changeReviewEnabled(home)).toBe(true);
	expect(readJson(settings).hooks.Stop).toHaveLength(1);
	expect(ensureMemoryHooks({ name: "claude-code" }, credentials, installOptions())).toEqual(
		notices,
	);
	expect(readdirSync(mod)).toEqual(["SKILL.md"]);
	expect(configureChangeReview(false, installOptions())).toEqual([]);
	expect(changeReviewEnabled(home)).toBe(false);
	expect(readFileSync(join(mod, "SKILL.md"), "utf8")).toBe("Mine");
});

it("keeps review disabled if receipt cleanup fails and can retry cleanup", () => {
	const settings = configureClaude();
	expect(configureChangeReview(true, installOptions())).toEqual([]);
	const mod = join(home, ".claude/skills/pharaoh-change-review");
	chmodSync(join(mod, "hooks"), 0o777);
	expect(configureChangeReview(false, installOptions())).toEqual([
		expect.stringContaining(
			"could not finish removing verified receipts for your Claude Code profile",
		),
	]);
	expect(changeReviewEnabled(home)).toBe(false);
	expect(readJson(settings).hooks.Stop).toBeUndefined();
	chmodSync(join(mod, "hooks"), 0o700);
	expect(configureChangeReview(false, installOptions())).toEqual([]);
	expect(existsSync(mod)).toBe(false);
});

it("requires an active mapped Claude installation and never changes independent declines", () => {
	const options = { ...installOptions() };
	expect(() => configureChangeReview(true, options)).toThrow(/active, signed-in/);
	expect(changeReviewEnabled(home)).toBe(false);
	configure({ enable: true });
	for (const choice of [{ memory: false }, { graph: false }]) {
		writeHookPreferences({ "claude-code": choice }, home);
		expect(() => configureChangeReview(true, options)).toThrow(/active, signed-in/);
		expect(readHookPreferences(home)["claude-code"]).toEqual(choice);
		expect(changeReviewEnabled(home)).toBe(false);
	}
});

it("keeps review opt-in scoped and clears it on broad sign-out", () => {
	const scope = { kind: "local" as const, root: checkout };
	setChangeReview(true, home, scope);
	expect(changeReviewEnabled(home, scope)).toBe(true);
	expect(changeReviewEnabled(home, { kind: "global" })).toBe(false);
	expect(changeReviewEnabled(home, { kind: "local", root: join(home, "other") })).toBe(false);
	const reviewDirectory = join(memoryClientRoot(home), "change-review");
	mkdirSync(reviewDirectory, { mode: 0o700 });
	writeFileSync(join(reviewDirectory, "private-proof.json"), "{}");
	resetHookPreferences(false, home);
	expect(changeReviewEnabled(home, scope)).toBe(false);
	expect(existsSync(reviewDirectory)).toBe(false);
});

it("loads the real credential reader from the installed bundle, including its native sign-in dependency", async () => {
	const ts = require("typescript") as typeof import("typescript");
	for (const name of ["credentials", "refresh"]) {
		const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
		const compiled = ts.transpileModule(source, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
		}).outputText;
		writeFileSync(new URL(`dist/${name}.js`, packageRoot), compiled);
	}
	const directory = installMemoryBundle(
		memoryClientRoot(home),
		checkout,
		packagedMemoryBundle(packageRoot),
	);
	const installed = await import(pathToFileURL(join(directory, "runtime/credentials.js")).href);
	// This loads the shipped module closure, rather than a test substitute that hid missing imports.
	expect(installed.readCredentials(join(home, ".pharaoh/credentials.json"))?.repos).toEqual([repo]);
});

it("retains a bounded bundle size after adding the verifier and credential dependency closure", () => {
	appendFileSync(new URL("project-memory/local.mjs", packageRoot), `\n${" ".repeat(150_000)}`);
	expect(() => packagedMemoryBundle(packageRoot)).toThrow("bundle is oversized");
});

it("review toggles preserve removed diagnostic and structural handlers", () => {
	const settings = configureClaude({ ...reviewChoice, diagnostics: true });
	const initial = readJson(settings);
	delete initial.hooks.PreToolUse;
	initial.hooks.Stop = initial.hooks.Stop.filter(
		(group: { hooks: Array<{ command: string }> }) =>
			!group.hooks.some((hook) => hook.command.includes("--diagnostics")),
	);
	for (const group of initial.hooks.PostToolUse) {
		if (group.hooks.some((hook: { command: string }) => hook.command.includes("--graph")))
			group.matcher = "^(?:Edit|Write|MultiEdit)$";
	}
	writeJson(settings, initial);
	const options = { ...installOptions() };
	for (const enabled of [true, false]) {
		expect(configureChangeReview(enabled, options)).toEqual([]);
		const next = readJson(settings);
		expect(next.hooks.PreToolUse).toBeUndefined();
		expect(JSON.stringify(next.hooks.Stop ?? [])).not.toContain("--diagnostics");
		expect(
			next.hooks.PostToolUse.some(
				(group: { matcher?: string; hooks: Array<{ command: string }> }) =>
					group.matcher?.includes("mcp__pharaoh__get_codebase_map") &&
					group.hooks.some((hook) => hook.command.includes("--graph")),
			),
		).toBe(false);
		// Existing diagnostic observations stay present; only the removed handler remains absent.
		expect(JSON.stringify(next.hooks.PostToolUse)).toContain("--diagnostics");
	}
});

it("a malformed review preference disables only review and explicit disable recovers it", async () => {
	const settings = configureClaude(reviewChoice, true);
	const reviewPreference = join(memoryClientRoot(home), "change-review-global.json");
	writeFileSync(reviewPreference, "{broken", { mode: 0o600 });
	expect(changeReviewEnabled(home)).toBe(false);
	await retrieval(SESSION);
	expect(prompt(settings, checkout)).toContain("pharaoh_memory_recall");
	expect(configureChangeReview(false, { ...installOptions() })).toEqual([]);
	expect(existsSync(reviewPreference)).toBe(false);
	expect(readHookPreferences(home)["claude-code"]).toEqual(reviewChoice);
});

it("startup does not resync a declined graph installation merely because a review flag remains", () => {
	const settings = configureClaude({ ...reviewChoice, graph: false });
	setChangeReview(true, home);
	const before = readFileSync(settings, "utf8");
	for (let i = 0; i < 2; i++) {
		expect(
			ensureMemoryHooks({ name: "claude-code" }, credentials, { ...installOptions() }),
		).toEqual([]);
		expect(readFileSync(settings, "utf8")).toBe(before);
	}
});

it("keeps the memory reminder when the optional review uses its bounded scan budget", async () => {
	setChangeReview(true, home);
	const trace = join(home, "review-deadline.json");
	writeFileSync(
		new URL("project-memory/change-review.mjs", packageRoot),
		`
		import { writeFileSync } from "node:fs";
		export const changeReviewDirectory = root => root + "/change-review";
		export function beginReviewTurn(input, options) {
			const left = options.deadline - performance.now();
			writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ left }));
			while (performance.now() <= options.deadline) {}
			throw new Error("review scan timed out");
		}
	`,
	);
	const settings = configureClaude({ ...reviewChoice, capture: true }, true);
	await retrieval(SESSION);
	const output = prompt(settings, checkout);
	expect(output).toContain("pharaoh_memory_recall");
	const { left } = readJson(trace);
	expect(left).toBeGreaterThan(0);
	expect(left).toBeLessThanOrEqual(350);
});

it("keeps Stop quiet when optional capture throws after receiving the verified check", () => {
	setChangeReview(true, home);
	writeFileSync(
		new URL("project-memory/change-review.mjs", packageRoot),
		`
		export const changeReviewDirectory = root => root + "/change-review";
		export const reviewTurnInput = input => input;
		export const reviewStop = () => undefined;
		export const takeReviewCaptureCheck = () => ({ check: "test" });
		export const consumeReviewReceipt = () => { throw new Error("Stop cannot consume a receipt"); };
	`,
	);
	writeFileSync(
		new URL("project-memory/capture.mjs", packageRoot),
		`
		export const captureDirectory = root => root + "/capture";
		export const recordToolEvent = () => undefined;
		export const deferCaptureForReview = () => undefined;
		export const stopDecision = () => { throw new Error("private outbox is unavailable"); };
	`,
	);
	const output = runHook(configureClaude({ ...reviewChoice, capture: true }, true), "Stop", {
		session_id: "receipt-capture-failure",
		prompt_id: "turn",
		stop_hook_active: true,
	});
	expect(output.trim()).toBe("");
});
