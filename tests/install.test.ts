/** Installer orchestration against real isolated client configurations. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Credentials } from "../src/credentials.js";
import { runInstall, type InstallOptions } from "../src/install.js";
import { configureClients, discoverClients, legacyMigrations } from "../src/setup.js";

const CREDENTIALS: Credentials = {
	version: 2,
	access_token: "fixture-access",
	refresh_token: "fixture-refresh",
	expires_at: "2999-01-01T00:00:00Z",
	refresh_expires_at: "2999-02-01T00:00:00Z",
	expires_in: 604800,
	sse_url: "https://mcp.pharaoh.so/sse/fixture",
	github_login: "fixture",
	tenant_name: "fixture",
	repos: ["example"],
};

describe("NPX developer install", () => {
	let home: string;
	let output: string[];
	const launch = { command: process.execPath, args: ["/fixture/pharaoh.js"] };

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pharaoh-install-"));
		output = [];
		mkdirSync(join(home, ".claude"));
		mkdirSync(join(home, ".codex"));
	});

	afterEach(() => rmSync(home, { recursive: true, force: true }));

	function options(overrides: Partial<InstallOptions> = {}): InstallOptions {
		const clientOptions = {
			home,
			env: { PATH: "" },
			platform: "darwin" as const,
			execute: () => {
				throw new Error("No client CLI is installed in this fixture");
			},
		};
		return {
			server: "https://mcp.pharaoh.so",
			interactive: false,
			...overrides,
			dependencies: {
				discover: () => discoverClients(clientOptions),
				migrations: (targets) => legacyMigrations(targets, clientOptions),
				authenticate: async () => CREDENTIALS,
				runtime: async () => launch,
				configure: (targets, config, flags) =>
					configureClients(targets, config, { ...clientOptions, ...flags }),
				ask: async () => false,
				write: (...lines) => output.push(...lines),
				latest: async () => null,
				...overrides.dependencies,
			},
		};
	}

	it("configures both desktop-only coding clients for a non-pilot account", async () => {
		writeFileSync(join(home, ".claude.json"), '{"theme":"dark"}');
		writeFileSync(join(home, ".codex", "config.toml"), 'model = "fixture-model"\n');
		let active: string[] = [];
		const status = await runInstall(
			options({
				afterConfigure: async (_credentials, clients) => {
					active = clients;
				},
			}),
		);

		expect(status).toBe(0);
		expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({
			theme: "dark",
			mcpServers: { pharaoh: launch },
		});
		const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
		expect(codex).toContain('model = "fixture-model"');
		expect(codex).toContain("[mcp_servers.pharaoh]");
		expect(codex).toContain("/fixture/pharaoh.js");
		expect(active).toEqual(["claude-code", "codex"]);
	});

	it("prepares the runtime before any client configuration changes", async () => {
		const original = '{"theme":"light"}';
		writeFileSync(join(home, ".claude.json"), original);
		const status = await runInstall(
			options({
				dependencies: {
					runtime: async () => {
						throw new Error("fixture registry password must not be printed");
					},
				},
			}),
		);
		expect(status).toBe(1);
		expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(original);
		expect(output.join("\n")).not.toContain("fixture registry password");
	});

	it("keeps a legacy pin without consent, then migrates on the explicit opt-in", async () => {
		writeFileSync(
			join(home, ".claude.json"),
			JSON.stringify({
				mcpServers: {
					pharaoh: { command: "npx", args: ["@pharaoh-so/mcp@0.3.50"] },
				},
			}),
		);
		expect(await runInstall(options())).toBe(0);
		expect(readFileSync(join(home, ".claude.json"), "utf8")).toContain("@pharaoh-so/mcp@0.3.50");
		expect(output.join("\n")).toContain("install --migrate-legacy");
		expect(await runInstall(options({ migrateLegacy: true }))).toBe(0);
		expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.pharaoh).toEqual(
			launch,
		);
	});

	it("retains successful clients while reporting another client's real failure", async () => {
		writeFileSync(join(home, ".codex", "config.toml"), "this is not TOML");
		expect(await runInstall(options())).toBe(1);
		expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.pharaoh).toEqual(
			launch,
		);
		expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe("this is not TOML");
		expect(output.join("\n")).toContain("setup failed");
	});

	it("keeps disabled/custom clients out of optional memory and skill activation", async () => {
		writeFileSync(
			join(home, ".claude.json"),
			JSON.stringify({
				mcpServers: {
					pharaoh: { command: "npx", args: ["@pharaoh-so/mcp@0.3.50"], disabled: true },
				},
			}),
		);
		writeFileSync(
			join(home, ".codex", "config.toml"),
			'[mcp_servers.pharaoh]\nurl = "https://custom.example/mcp"\n',
		);
		let active: string[] = ["unexpected"];
		expect(
			await runInstall(
				options({
					migrateLegacy: true,
					afterConfigure: async (_credentials, clients) => {
						active = clients;
					},
				}),
			),
		).toBe(0);
		expect(active).toEqual([]);
		expect(output.join("\n")).toContain("No new enabled agent connection");
	});

	it("supports shell-only sign-in without treating absent apps as errors", async () => {
		expect(await runInstall(options({ dependencies: { discover: () => [] } }))).toBe(0);
		expect(output.join("\n")).toContain("Pharaoh CLI is signed in");
	});

	it("routes install --help before the question-tool CLI without starting sign-in", () => {
		const tsx = createRequire(import.meta.url).resolve("tsx/cli");
		const result = spawnSync(
			process.execPath,
			[tsx, join(__dirname, "../src/index.ts"), "install", "--help"],
			{
				encoding: "utf8",
				timeout: 20_000,
				env: { HOME: home, PATH: dirname(process.execPath), PHARAOH_MCP_DISABLE_BROWSER: "1" },
			},
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("pharaoh-mcp install");
		expect(result.stderr).not.toContain("Unknown question tool");
		expect(result.stdout).toBe("");
	});
});
