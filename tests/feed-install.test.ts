/** Native feed installation and credential lifecycle use real isolated files, without native clients. */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	nativeFeedRegistration,
	setNativeFeedEnabled,
	syncNativeFeedHooks,
} from "../runtime/feed-hooks.mjs";
import * as feedSignIn from "../runtime/feed-signin.mjs";
import {
	beginFeedSignIn,
	feedRootForCredentials,
	readFeedSignIn,
} from "../runtime/feed-signin.mjs";
import { configureClients } from "../src/client-install.js";
import {
	bootstrapLegacyFeedSignIn,
	type Credentials,
	readCredentials,
	saveAuthorizedCredentials,
	takeCredentialsForLogout,
	writeCredentials,
} from "../src/credentials.js";
import { parseArgs } from "../src/helpers.js";

let home: string;
let credentialsPath: string;
const credentials: Credentials = {
	version: 2,
	access_token: "fixture-access",
	refresh_token: "fixture-refresh",
	expires_at: "2999-01-01T00:00:00Z",
	refresh_expires_at: "2999-02-01T00:00:00Z",
	expires_in: 604800,
	sse_url: "https://mcp.pharaoh.so/sse/fixture",
	github_login: "fixture",
	tenant_name: "fixture",
	repos: ["fixture/repo"],
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pharaoh-feed-install-"));
	mkdirSync(join(home, ".pharaoh"), { mode: 0o700 });
	credentialsPath = join(home, ".pharaoh", "credentials.json");
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true });
});

describe("feed sign-in lifecycle", () => {
	it("rotates only on explicit authorization, preserving ordinary credential writers", async () => {
		await saveAuthorizedCredentials(credentials, credentialsPath);
		const initial = readFeedSignIn(credentialsPath);
		expect(initial?.server).toBe("https://mcp.pharaoh.so");
		expect(initial?.generation).toMatch(/^[0-9a-f-]{36}$/);
		const signedIn = readCredentials(credentialsPath)!;
		writeCredentials(
			{ ...signedIn, access_token: "refreshed", refresh_token: "rotated" },
			credentialsPath,
		);
		writeCredentials(
			{ ...signedIn, project_memory: [], project_memory_checked_at: "2026-11-19T00:00:00Z" },
			credentialsPath,
		);
		writeCredentials(
			{ ...signedIn, runtime_session: "553bdcce-2440-4207-9d7f-9c1f95d834cb" },
			credentialsPath,
		);
		expect(readFeedSignIn(credentialsPath)?.generation).toBe(initial?.generation);
		await saveAuthorizedCredentials(
			{ ...credentials, access_token: "new-person" },
			credentialsPath,
		);
		expect(readFeedSignIn(credentialsPath)?.generation).not.toBe(initial?.generation);
		const marker = readFileSync(
			join(feedRootForCredentials(credentialsPath), "signin.json"),
			"utf8",
		);
		expect(marker).not.toContain("fixture-access");
		expect(marker).not.toContain("fixture-refresh");
	});

	it("bootstraps a validated legacy sign-in once and refuses changed credentials", async () => {
		writeCredentials(credentials, credentialsPath);
		expect(
			await bootstrapLegacyFeedSignIn(
				{ ...credentials, access_token: "stale" },
				"https://mcp.pharaoh.so",
				credentialsPath,
			),
		).toBeNull();
		expect(readFeedSignIn(credentialsPath)).toBeNull();
		const generation = await bootstrapLegacyFeedSignIn(
			credentials,
			"https://mcp.pharaoh.so",
			credentialsPath,
		);
		expect(generation).toMatch(/^[0-9a-f-]{36}$/);
		expect(
			await bootstrapLegacyFeedSignIn(credentials, "https://mcp.pharaoh.so", credentialsPath),
		).toBe(generation);
	});

	it("logout leaves a withdrawal fence even after its credentials file was removed", async () => {
		await saveAuthorizedCredentials(credentials, credentialsPath);
		rmSync(credentialsPath);
		expect(await takeCredentialsForLogout(credentialsPath)).toBeNull();
		expect(readFeedSignIn(credentialsPath)).toBeNull();
		writeCredentials(credentials, credentialsPath);
		expect(
			await bootstrapLegacyFeedSignIn(credentials, "https://mcp.pharaoh.so", credentialsPath),
		).toBeNull();
		await saveAuthorizedCredentials(credentials, credentialsPath);
		expect(readFeedSignIn(credentialsPath)?.generation).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("interrupted replacement cannot be reinterpreted as legacy state", async () => {
		await saveAuthorizedCredentials(credentials, credentialsPath);
		const pending = beginFeedSignIn("https://mcp.pharaoh.so", credentialsPath);
		writeCredentials(
			{ ...credentials, access_token: "replacement", native_feed_generation: pending.generation },
			credentialsPath,
		);
		expect(readFeedSignIn(credentialsPath)).toBeNull();
		expect(
			await bootstrapLegacyFeedSignIn(
				{ ...credentials, access_token: "replacement" },
				"https://mcp.pharaoh.so",
				credentialsPath,
			),
		).toBeNull();
	});

	it.each([
		"beginFeedSignIn",
		"commitFeedSignIn",
	] as const)("keeps OAuth usable and fences old context when %s fails", async (phase) => {
		await saveAuthorizedCredentials(credentials, credentialsPath);
		const before = readFeedSignIn(credentialsPath)!.generation;
		vi.spyOn(feedSignIn, phase).mockImplementationOnce(() => {
			throw new Error("optional feed storage failed");
		});
		await expect(
			saveAuthorizedCredentials({ ...credentials, access_token: "replacement" }, credentialsPath),
		).resolves.toBeUndefined();
		const current = readCredentials(credentialsPath)!;
		expect(current.access_token).toBe("replacement");
		expect(current.native_feed_generation).toMatch(/^[0-9a-f-]{36}$/);
		expect(current.native_feed_generation).not.toBe(before);
		expect(readFeedSignIn(credentialsPath)).toBeNull();
		expect(
			await bootstrapLegacyFeedSignIn(current, "https://mcp.pharaoh.so", credentialsPath),
		).toBeNull();
	});

	it("does not bootstrap a credential generation whose optional marker publication never began", async () => {
		writeCredentials(
			{ ...credentials, native_feed_generation: "dab0a26e-4b6c-4a9f-a010-f5c5877eea33" },
			credentialsPath,
		);
		expect(
			await bootstrapLegacyFeedSignIn(
				readCredentials(credentialsPath)!,
				"https://mcp.pharaoh.so",
				credentialsPath,
			),
		).toBeNull();
		expect(readFeedSignIn(credentialsPath)).toBeNull();
	});

	it("keeps alternative credential files separate in the same directory", async () => {
		await saveAuthorizedCredentials(credentials, credentialsPath);
		const original = readFeedSignIn(credentialsPath)?.generation;
		const alternate = join(dirname(credentialsPath), "other.json");
		await saveAuthorizedCredentials(credentials, alternate);
		expect(feedRootForCredentials(alternate)).not.toBe(feedRootForCredentials(credentialsPath));
		await takeCredentialsForLogout(alternate);
		expect(readFeedSignIn(credentialsPath)?.generation).toBe(original);
	});
});

describe("managed native feed registration", () => {
	it.each([
		{ serverArgv: [] },
		{ serverArgv: ["--server", "https://mcp.pharaoh.so"] },
		{ serverArgv: ["--server", "https://example.test/custom/"] },
	])("round-trips literal server arguments $serverArgv", ({ serverArgv }) => {
		const target = { client: "codex" as const, path: join(home, ".codex", "config.toml") };
		const launch = { command: process.execPath, args: [join(home, "index.js"), ...serverArgv] };
		const options = { home, env: {}, nativeFeed: true };
		const first = configureClients([target], launch, options)[0];
		expect(first.status).toBe("configured");
		const feed = first.nativeFeed!;
		expect(feed.serverArgv).toEqual(serverArgv);
		const config = parseToml(readFileSync(target.path, "utf8")) as {
			mcp_servers: { pharaoh: { args: string[] } };
		};
		const args = config.mcp_servers.pharaoh.args;
		expect(args.slice(1, 1 + serverArgv.length)).toEqual(serverArgv);
		expect(parseArgs(args.slice(1)).feedRegistration).toBe(feed.registration);
		syncNativeFeedHooks("codex", join(home, "hook.mjs"), { ...feed, node: process.execPath });
		const hooks = JSON.parse(readFileSync(feed.settingsPath, "utf8")).hooks;
		const command = hooks.SubagentStart[0].hooks[0].command;
		for (const argument of serverArgv) expect(command).toContain(`'${argument}'`);
		if (!serverArgv.length) expect(command).not.toContain("--server");
		expect(configureClients([target], launch, options)[0].nativeFeed?.registration).toBe(
			feed.registration,
		);
		expect(nativeFeedRegistration("codex", { home })).toBe(feed.registration);
	});

	it("keeps Local activation arguments and hooks scoped to the selected checkout", () => {
		const directory = join(home, "local-checkout");
		mkdirSync(directory);
		execFileSync("git", ["init", "-q", directory]);
		const root = realpathSync(directory);
		const scope = { kind: "local" as const, root };
		const launch = {
			command: process.execPath,
			args: [join(home, "index.js"), "--install-scope", "local", "--install-root", root],
		};
		const targets = [
			{
				client: "claude-code" as const,
				path: join(home, ".claude.json"),
				cli: "claude",
				version: "2.1.328",
			},
			{
				client: "codex" as const,
				path: join(home, ".codex", "config.toml"),
				cli: "codex",
				version: "0.166.0",
			},
		];
		const results = configureClients(targets, launch, { home, env: {}, scope, nativeFeed: true });
		for (const outcome of results) {
			expect(outcome.status, outcome.detail).toBe("configured");
			const feed = outcome.nativeFeed!;
			expect(feed.settingsPath).toBe(
				join(
					root,
					outcome.client === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json",
				),
			);
			if (outcome.client === "claude-desktop") throw new Error("Unexpected Desktop result");
			syncNativeFeedHooks(outcome.client, join(home, "hook.mjs"), {
				...feed,
				scope,
				node: process.execPath,
			});
			expect(existsSync(feed.settingsPath)).toBe(true);
			const config =
				outcome.client === "codex"
					? (parseToml(readFileSync(join(root, ".codex", "config.toml"), "utf8")) as {
							mcp_servers: { pharaoh: { args: string[] } };
						})
					: JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects[root];
			const actual =
				outcome.client === "codex"
					? config.mcp_servers.pharaoh.args
					: config.mcpServers.pharaoh.args;
			expect(actual).toEqual([
				...launch.args,
				"--feed-client",
				outcome.client,
				"--feed-registration",
				feed.registration,
			]);
		}
		expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
		expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
	});

	it("keeps unrelated hooks and explicit hook opt-outs", () => {
		const path = join(home, "settings.json");
		const registration = nativeFeedRegistration("claude-code", { home });
		writeFileSync(
			path,
			JSON.stringify({
				hooks: {
					PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "user-hook" }] }],
				},
			}),
		);
		syncNativeFeedHooks("claude-code", join(home, "hook.mjs"), {
			home,
			settingsPath: path,
			registration,
		});
		syncNativeFeedHooks("claude-code", null, { home, settingsPath: path });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			hooks: {
				PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "user-hook" }] }],
			},
		});
		setNativeFeedEnabled("claude-code", false, { home });
		syncNativeFeedHooks("claude-code", join(home, "hook.mjs"), {
			home,
			settingsPath: path,
			registration,
		});
		expect(JSON.parse(readFileSync(path, "utf8")).hooks.SubagentStart).toBeUndefined();
		setNativeFeedEnabled("claude-code", true, { home });
		writeFileSync(path, JSON.stringify({ disableAllHooks: true }));
		expect(() =>
			syncNativeFeedHooks("claude-code", join(home, "hook.mjs"), {
				home,
				settingsPath: path,
				registration,
			}),
		).toThrow("disabled");
	});

	it("leaves absent client settings absent during cleanup, including unsupported Windows", () => {
		const path = join(home, ".codex", "hooks.json");
		syncNativeFeedHooks("codex", null, { home, env: {} });
		expect(existsSync(path)).toBe(false);
		expect(existsSync(dirname(path))).toBe(false);
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			expect(() => syncNativeFeedHooks("codex", null, { home, env: {} })).not.toThrow();
			expect(existsSync(path)).toBe(false);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	});

	it("refuses partial and duplicate managed options", () => {
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit");
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		expect(() => parseArgs(["--feed-client", "codex"])).toThrow("exit");
		expect(() =>
			parseArgs(["--server", "https://example.test", "--server", "https://other.test"]),
		).toThrow("exit");
	});
});
