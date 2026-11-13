/** Installer orchestration against real isolated client configurations. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDeviceApproval, RuntimeEnrollmentIntent } from "../runtime/runtime-client.mjs";
import { updateRuntimeHooks } from "../runtime/runtime-hooks.mjs";
import { pollOnce, requestDeviceCode } from "../src/auth.js";
import type { Credentials } from "../src/credentials.js";
import { askYesNo, printLines, showProgress } from "../src/helpers.js";
import {
	type AgentLaunch,
	canStartAgent,
	codexHookUntrusted,
	type InstallOptions,
	runInstall,
	startAgent,
} from "../src/install.js";
import { allowReadTools } from "../src/install-skills.js";
import { RuntimeSetupError } from "../src/runtime.js";
import {
	configureClients,
	discoverClients,
	freshRuntimeClients,
	legacyMigrations,
	verifiedCodingClients,
} from "../src/setup.js";
import { SETUP_TOOL_PROMPT } from "../src/setup-prompt.generated.js";
import { getPackageVersion, PACKAGE_NAME } from "../src/version.js";

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

const CLAUDE_INTENT: RuntimeEnrollmentIntent = {
	client: "claude-code",
	installationId: "df37cf55-c42c-457f-9cf9-07e42b9ffbdc",
	generation: "1802b973-d42b-41ef-a6aa-f99c864d1ccd",
	policyVersion: "runtime-v1",
};
const CODEX_INTENT: RuntimeEnrollmentIntent = {
	...CLAUDE_INTENT,
	client: "codex",
	installationId: "f7074bf4-c53a-4b84-a158-9b049bb8f0e2",
	generation: "0f0f5f85-9f58-403d-8f3f-619964bf54c4",
};
const APPROVAL: RuntimeDeviceApproval = {
	...CLAUDE_INTENT,
	approvalId: "a".repeat(64),
	expiresAt: "2999-01-01T00:00:00Z",
};
const RUNTIME_SESSION = "011e2c33-3e78-4d7a-8363-d1b99c095c38";

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

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	/** `clis` answer `--version`, so discovery sees them start; nothing else runs. */
	function options(overrides: Partial<InstallOptions> = {}, clis: string[] = []): InstallOptions {
		const clientOptions = {
			home,
			env: { PATH: "" },
			platform: "darwin" as const,
			execute: (command: string, args: readonly string[]) => {
				if (clis.includes(command) && args[0] === "--version") return `${command} 2.1.0`;
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
				authenticate: async () => ({ credentials: CREDENTIALS }),
				freshRuntimeClients: (targets) => freshRuntimeClients(targets, clientOptions),
				verifiedRuntimeClients: (flags) => verifiedCodingClients({ ...clientOptions, ...flags }),
				runtimeIntent: () => null,
				runtime: async () => launch,
				// Registration writes the files; a CLI only marks an agent the installer can start.
				configure: (targets, config, flags) =>
					configureClients(
						targets.map(({ cli: _cli, ...target }) => target),
						config,
						{ ...clientOptions, ...flags },
					),
				ask: async () => false,
				choose: async () => 0,
				startAgent: async () => {
					throw new Error("No agent starts in this fixture");
				},
				write: (...lines) => output.push(...lines),
				latest: async () => null,
				...overrides.dependencies,
			},
		};
	}

	function runCli(...args: string[]) {
		const tsx = createRequire(import.meta.url).resolve("tsx/cli");
		return spawnSync(process.execPath, [tsx, join(__dirname, "../src/index.ts"), ...args], {
			encoding: "utf8",
			timeout: 20_000,
			env: { HOME: home, PATH: dirname(process.execPath), PHARAOH_MCP_DISABLE_BROWSER: "1" },
		});
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
		// The user receives the complete investigation request, not only a setup command.
		expect(output.join("\n")).toContain(SETUP_TOOL_PROMPT);
	});

	it("starts the one connected agent CLI with the setup prompt on a yes, and not on a no", async () => {
		const startAgent = vi.fn(async (_agent: AgentLaunch) => true);
		const ask = vi.fn<(question: string) => Promise<boolean | null>>();
		const install = options({ interactive: true, dependencies: { ask, startAgent } }, ["claude"]);
		ask.mockResolvedValueOnce(true);
		expect(await runInstall(install)).toBe(0);
		ask.mockResolvedValueOnce(false);
		expect(await runInstall(install)).toBe(0);
		// Codex is connected too, but without a CLI it isn't offered.
		expect(ask).toHaveBeenCalledTimes(2);
		expect(startAgent).toHaveBeenCalledExactlyOnceWith({
			client: "claude-code",
			command: "claude",
			args: [SETUP_TOOL_PROMPT],
		});
	});

	it("numbers several agent CLIs, starts the one picked, and none on n", async () => {
		const startAgent = vi.fn(async (_agent: AgentLaunch) => true);
		const choose = vi.fn<(question: string, count: number) => Promise<number | null>>();
		choose.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
		const install = options({ interactive: true, dependencies: { choose, startAgent } }, [
			"claude",
			"codex",
		]);
		expect(await runInstall(install)).toBe(0);
		expect(await runInstall(install)).toBe(0);
		expect(choose.mock.calls.map(([, count]) => count)).toEqual([2, 2]);
		expect(startAgent).toHaveBeenCalledExactlyOnceWith({
			client: "codex",
			command: "codex",
			args: [SETUP_TOOL_PROMPT],
		});
	});

	it("asks and starts nothing without a terminal, or without an agent CLI", async () => {
		const ask = vi.fn(async () => true);
		const choose = vi.fn(async () => 1);
		const startAgent = vi.fn(async () => true);
		const dependencies = { ask, choose, startAgent };
		expect(await runInstall(options({ dependencies }, ["claude", "codex"]))).toBe(0);
		// The whole summary: who's connected, then one command per agent.
		expect(output).toHaveLength(3);
		expect(output.slice(1)).toEqual([
			`Start: claude "${SETUP_TOOL_PROMPT}"`,
			`Start: codex "${SETUP_TOOL_PROMPT}"`,
		]);
		expect(await runInstall(options({ interactive: true, dependencies }))).toBe(0);
		expect([ask, choose, startAgent].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
		const tty = { isTTY: true };
		expect(canStartAgent({}, tty, tty)).toBe(true);
		expect(canStartAgent({ CI: "true" }, tty, tty)).toBe(false);
		expect(canStartAgent({ NO_COLOR: "1" }, tty, tty)).toBe(false);
		expect(canStartAgent({}, {}, tty)).toBe(false);
	});

	it("gives Claude Desktop, which has no CLI, the request to send: alone, or beside a CLI", async () => {
		mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
		rmSync(join(home, ".claude"), { recursive: true });
		rmSync(join(home, ".codex"), { recursive: true });
		const ask = vi.fn(async () => false);
		const dependencies = { ask, startAgent: vi.fn(async () => true) };
		const desktopLines = () =>
			output.filter((line) => line.includes("Claude Desktop") && line.includes(SETUP_TOOL_PROMPT));
		expect(await runInstall(options({ interactive: true, dependencies }))).toBe(0);
		expect(ask).not.toHaveBeenCalled();
		expect(desktopLines()).toHaveLength(1);
		output.length = 0;
		expect(await runInstall(options({ interactive: true, dependencies }, ["claude"]))).toBe(0);
		expect(ask).toHaveBeenCalledTimes(1);
		expect(desktopLines()).toHaveLength(1);
	});

	it("asks for the Codex hook trust only while a Pharaoh hook has no trust record", async () => {
		const codex = join(home, ".codex");
		const hooks = join(codex, "hooks.json");
		const own = { hooks: [{ type: "command", command: "own-hook" }] };
		const pharaoh = {
			hooks: [{ type: "command", command: "'hook.mjs' --pharaoh-local-worktree-v1" }],
		};
		writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [own, pharaoh] } }));
		expect(codexHookUntrusted(codex)).toBe(true);
		expect(await runInstall(options())).toBe(0);
		expect(output.filter((line) => line.includes("/hooks"))).toHaveLength(1);
		// Trusting Pharaoh's position is enough: the user's own untrusted hook isn't ours to raise.
		const trusted = `[hooks.state."${hooks}:pre_tool_use:1:0"]\ntrusted_hash = "sha256:fixture"\n`;
		writeFileSync(join(codex, "config.toml"), trusted);
		expect(codexHookUntrusted(codex)).toBe(false);
		expect(codexHookUntrusted(join(home, "missing"))).toBe(false);
	});

	it("starts an agent in this terminal without npx's npm_ variables", async () => {
		const seen = join(home, "agent-env.json");
		vi.stubEnv("npm_config_yes", "true");
		// The user's npm credentials and registry stay: an .npmrc may read ${NPM_TOKEN}.
		vi.stubEnv("NPM_TOKEN", "kept");
		vi.stubEnv("npm_config_registry", "https://registry.example/");
		const script = `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env))`;
		expect(
			await startAgent({ client: "codex", command: process.execPath, args: ["-e", script] }),
		).toBe(true);
		const env = JSON.parse(readFileSync(seen, "utf8"));
		expect(env.NPM_TOKEN).toBe("kept");
		expect(env.npm_config_registry).toBe("https://registry.example/");
		expect(env).not.toHaveProperty("npm_config_yes");
		expect(await startAgent({ client: "codex", command: join(home, "missing"), args: [] })).toBe(
			false,
		);
	});

	it("uses a fresh device grant after an exact new registration and keeps optional errors nonfatal", async () => {
		const checks: Array<[string, boolean]> = [];
		const permissionChecks: Array<ReturnType<typeof allowReadTools>> = [];
		const settings = join(home, ".claude", "settings.json");
		let disclosedBeforeSignIn = false;
		let enrollmentPending = false;
		let overlapping = false;
		const enableRuntime = vi.fn(
			async (
				_server: string,
				approval: RuntimeDeviceApproval,
				_session: string,
				canActivate: () => boolean,
			) => {
				checks.push([approval.client, canActivate()]);
				if (enrollmentPending) overlapping = true;
				enrollmentPending = true;
				await Promise.resolve();
				enrollmentPending = false;
				if (approval.client === "claude-code") {
					const hookOnly = updateRuntimeHooks(
						{},
						"claude-code",
						"/fixture/runtime-hook.mjs",
						process.execPath,
						"2.1.318",
						approval.generation,
					);
					writeFileSync(settings, JSON.stringify(hookOnly));
					throw new Error("Private enrollment ticket must stay out of the install transcript");
				}
				return true;
			},
		);
		const install = options({
			afterConfigure: async () => {
				permissionChecks.push(allowReadTools(home));
			},
			dependencies: {
				runtimeIntent: (client) => (client === "claude-code" ? CLAUDE_INTENT : CODEX_INTENT),
				authenticate: async (_server, intents) => {
					disclosedBeforeSignIn = output.some((line) => line.includes("--skip-runtime"));
					return {
						credentials: { ...CREDENTIALS, runtime_session: RUNTIME_SESSION },
						runtimeApprovals: intents.map((intent) => ({ ...APPROVAL, ...intent })),
					};
				},
				verifiedRuntimeClients: ({ runningLaunch } = {}) => {
					if (runningLaunch?.args[0] !== launch.args[0]) return [];
					const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
					const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
					return claude.mcpServers.pharaoh.args[0] === launch.args[0] &&
						codex.includes(launch.args[0])
						? ["claude-code", "codex"]
						: [];
				},
				enableRuntime,
			},
		});
		expect(await runInstall(install)).toBe(0);
		expect(disclosedBeforeSignIn).toBe(true);
		expect(enableRuntime).toHaveBeenNthCalledWith(
			1,
			install.server,
			APPROVAL,
			RUNTIME_SESSION,
			expect.any(Function),
		);
		expect(enableRuntime).toHaveBeenNthCalledWith(
			2,
			install.server,
			{ ...APPROVAL, ...CODEX_INTENT },
			RUNTIME_SESSION,
			expect.any(Function),
		);
		expect(checks).toEqual([
			["claude-code", true],
			["codex", true],
		]);
		expect(overlapping).toBe(false);
		// Enabled analytics stays quiet; only the client that failed gets a line.
		expect(output.filter((line) => line.includes("--client codex"))).toEqual([]);
		expect(output.join("\n")).toContain("--runtime-enable --client claude-code");
		expect(output.join("\n")).not.toContain("Private enrollment ticket");
		expect(output.join("\n")).not.toContain(APPROVAL.approvalId);
		expect(await runInstall(install)).toBe(0);
		expect(enableRuntime).toHaveBeenCalledTimes(2);
		expect(permissionChecks).toEqual(["no-settings", "runtime-hooks-only"]);
		expect(JSON.parse(readFileSync(settings, "utf8"))).not.toHaveProperty("permissions");
	});

	it("keeps a Claude project override added during sign-in out of automatic analytics", async () => {
		const version = getPackageVersion();
		const root = join(
			realpathSync(home),
			".pharaoh",
			"runtimes",
			"mcp",
			version,
			"node_modules",
			PACKAGE_NAME,
		);
		mkdirSync(join(root, "dist"), { recursive: true });
		mkdirSync(join(root, "runtime"));
		const entry = join(root, "dist", "index.js");
		writeFileSync(entry, "");
		writeFileSync(join(root, "runtime", "runtime-client.mjs"), "");
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
		const projects = { "/repo": { disabledMcpServers: ["pharaoh"] } };
		const enableRuntime = vi.fn(async () => true);
		const install = options({
			dependencies: {
				runtime: async () => ({ command: process.execPath, args: [entry] }),
				runtimeIntent: (client) => (client === "claude-code" ? CLAUDE_INTENT : null),
				authenticate: async (_server, intents) => {
					expect(intents).toEqual([CLAUDE_INTENT]);
					writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects }));
					return {
						credentials: { ...CREDENTIALS, runtime_session: RUNTIME_SESSION },
						runtimeApprovals: [APPROVAL],
					};
				},
				enableRuntime,
			},
		});
		expect(await runInstall(install)).toBe(0);
		expect(enableRuntime).not.toHaveBeenCalled();
		expect(
			verifiedCodingClients({
				home,
				env: {},
				runningLaunch: { command: process.execPath, args: [entry] },
				requiredProxy: { minimumVersion: version, server: install.server },
			}),
		).toContain("claude-code");
		expect(output.join("\n")).toContain(
			"runtime analytics skipped. Review the client and project settings",
		);
		expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toMatchObject({
			projects,
			mcpServers: { pharaoh: { args: [entry] } },
		});
	});

	it("reports the recovery command when ordinary sign-in returns no runtime ticket", async () => {
		const enableRuntime = vi.fn(async () => true);
		expect(
			await runInstall(
				options({
					dependencies: {
						runtimeIntent: (client) => (client === "claude-code" ? CLAUDE_INTENT : null),
						verifiedRuntimeClients: () => ["claude-code"],
						enableRuntime,
					},
				}),
			),
		).toBe(0);
		expect(enableRuntime).not.toHaveBeenCalled();
		expect(output.join("\n")).toContain("runtime analytics could not be enabled");
		expect(output.join("\n")).toContain("--runtime-enable --client claude-code");
	});

	it("applies runtime opt-out before sign-in and leaves setup usable when cleanup is pending", async () => {
		const disabled: string[] = [];
		const runtimeIntent = vi.fn(() => CLAUDE_INTENT);
		expect(
			await runInstall(
				options({
					skipRuntime: true,
					dependencies: {
						runtimeIntent,
						disableRuntime: async (client) => {
							disabled.push(client);
							return client === "codex" ? "disabled" : "cleanup_pending";
						},
						authenticate: async (_server, intents) => {
							expect(disabled).toEqual(["claude-code", "codex"]);
							expect(intents).toEqual([]);
							return { credentials: CREDENTIALS };
						},
					},
				}),
			),
		).toBe(0);
		expect(runtimeIntent).not.toHaveBeenCalled();
		expect(output.join("\n")).toContain("runtime analytics is off locally");
	});

	it("fails an explicit install opt-out when the local choice could not be saved", async () => {
		const authenticate = vi.fn(async () => ({ credentials: CREDENTIALS }));
		expect(
			await runInstall(
				options({
					skipRuntime: true,
					dependencies: {
						disableRuntime: async () => "not_saved",
						authenticate,
					},
				}),
			),
		).toBe(1);
		expect(authenticate).not.toHaveBeenCalled();
		expect(output.join("\n")).toContain("could not save the runtime analytics off choice");
		expect(output.join("\n")).not.toContain("runtime analytics is off");
	});

	it("sends the optional device intent without following redirects that could forward credentials", async () => {
		const fetchDevice = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({}));
		fetchDevice.mockResolvedValueOnce(Response.json({ runtime_approvals: [APPROVAL] }));
		vi.stubGlobal("fetch", fetchDevice);
		const server = "https://mcp.pharaoh.so";
		await requestDeviceCode(server, [CLAUDE_INTENT]);
		expect(fetchDevice).toHaveBeenNthCalledWith(
			1,
			`${server}/device`,
			expect.objectContaining({
				redirect: "error",
				body: JSON.stringify({ runtime_installations: [CLAUDE_INTENT] }),
			}),
		);
		expect(await pollOnce(server, "device-fixture")).toEqual({
			status: "authorized",
			token: { runtime_approvals: [APPROVAL] },
		});
		expect(fetchDevice).toHaveBeenNthCalledWith(
			2,
			`${server}/device/token`,
			expect.objectContaining({ redirect: "error" }),
		);
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

	it("prepares the runtime during sign-in and shows what's left, step by step, before the summary", async () => {
		const events: string[] = [];
		let signIn = () => {};
		let runtimeStarted = false;
		const dependencies = {
			progress: () => ({
				step: (label: string) => events.push(`step ${label}`),
				stop: () => events.push("stop"),
			}),
			write: (...lines: string[]) => events.push(...lines),
			authenticate: async () => {
				expect(runtimeStarted).toBe(true);
				await new Promise<void>((resolve) => {
					signIn = resolve;
				});
				events.push("signed in");
				return { credentials: CREDENTIALS };
			},
		};
		let finishRuntime = () => {};
		const downloading = (onInstall: (version: string) => void, note: (message: string) => void) => {
			runtimeStarted = true;
			onInstall("9.9.9");
			note("Pharaoh will use the current Node.js installation.");
			return new Promise<typeof launch>((resolve) => {
				finishRuntime = () => resolve(launch);
			});
		};
		const install = runInstall(options({ dependencies: { ...dependencies, runtime: downloading } }));
		await vi.waitFor(() => expect(runtimeStarted).toBe(true));
		// Nothing draws or prints over the sign-in prompt.
		expect(events).toEqual([]);
		signIn();
		await vi.waitFor(() => expect(events).toContain("step Installing Pharaoh 9.9.9"));
		finishRuntime();
		expect(await install).toBe(0);
		expect(events.slice(0, 6)).toEqual([
			"signed in",
			"Pharaoh will use the current Node.js installation.",
			"step Installing Pharaoh 9.9.9",
			"step Connecting Claude Code and Codex",
			"stop",
			"✓ Connected to Claude Code and Codex",
		]);

		events.length = 0;
		const configure = vi.fn();
		const failing = async () => {
			throw new RuntimeSetupError("Pharaoh could not install its exact-version runtime.");
		};
		const status = await runInstall(
			options({ dependencies: { ...dependencies, authenticate: async () => ({ credentials: CREDENTIALS }), runtime: failing, configure } }),
		);
		expect(status).toBe(1);
		expect(configure).not.toHaveBeenCalled();
		expect(events).toContain("stop");

		// A sign-in that fails a macrotask later stops the preparation it started alongside,
		// so npm and the lock wait can't hold the process open after the failure prints.
		let preparation: AbortSignal | undefined;
		const pending = (_onInstall: unknown, _note: unknown, signal: AbortSignal) => {
			preparation = signal;
			return new Promise<typeof launch>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new RuntimeSetupError("stopped")));
			});
		};
		const refused = async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			throw new Error("sign-in refused");
		};
		expect(
			await runInstall(options({ dependencies: { ...dependencies, authenticate: refused, runtime: pending, configure } })),
		).toBe(1);
		expect(preparation?.aborted).toBe(true);
		expect(configure).not.toHaveBeenCalled();
	});

	it("draws one step-and-seconds line on a terminal, around printed lines, and erases it", async () => {
		vi.stubEnv("TERM", "xterm-256color");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const stream = (isTTY: boolean, chunks: string[]) => ({
				isTTY,
				write: (chunk: string | Uint8Array) => chunks.push(String(chunk)) > 0,
			});
			let clock = 1_000;
			const terminal: string[] = [];
			const progress = showProgress(stream(true, terminal), () => clock);
			progress.step("Installing Pharaoh 9.9.9");
			clock += 4_200;
			progress.step("Connecting Claude Code and Codex");
			printLines("! Codex: trust the Pharaoh hook in /hooks");
			progress.stop();
			progress.stop();
			expect(terminal).toEqual([
				"\r\x1b[2K⠋ Installing Pharaoh 9.9.9 · 0s",
				"\r\x1b[2K⠙ Connecting Claude Code and Codex · 4s",
				"\r\x1b[2K",
				"\r\x1b[2K⠹ Connecting Claude Code and Codex · 4s",
				"\r\x1b[2K",
			]);
			expect(stderr).toHaveBeenCalledWith("! Codex: trust the Pharaoh hook in /hooks\n");
			// A question erases the line while it waits and redraws it after the answer.
			const asked: string[] = [];
			const questioning = showProgress(stream(true, asked), () => clock);
			questioning.step("Connecting Claude Code");
			expect(await askYesNo("Add the line? [Y/n] ", Readable.from(["y\n"]), new PassThrough())).toBe(true);
			questioning.stop();
			expect(asked.map((chunk) => chunk.slice(0, 6))).toEqual(["\r\x1b[2K⠋", "\r\x1b[2K", "\r\x1b[2K⠙", "\r\x1b[2K"]);
			const piped: string[] = [];
			const quiet = showProgress(stream(false, piped));
			quiet.step("Installing Pharaoh 9.9.9");
			quiet.stop();
			expect(piped).toEqual([]);
		} finally {
			stderr.mockRestore();
			vi.unstubAllEnvs();
		}
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
	});

	it("supports shell-only sign-in without treating absent apps as errors", async () => {
		expect(await runInstall(options({ dependencies: { discover: () => [] } }))).toBe(0);
		expect(output.join("\n")).toContain("get_codebase_map --repo");
	});

	it("routes install --help before the question-tool CLI without starting sign-in", () => {
		const result = runCli("install", "--help");
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("pharaoh-mcp install");
		expect(result.stderr).not.toContain("Unknown question tool");
		expect(result.stdout).toBe("");
	});

	it.skipIf(typeof process.getuid !== "function")(
		"reports a busy off-switch lock as unsaved in the revoke CLI",
		() => {
			const lock = join(home, ".pharaoh", "runtime-observations", "choice-claude-code.lock");
			mkdirSync(lock, { recursive: true, mode: 0o700 });
			const result = runCli("--runtime-revoke", "--client", "claude-code");
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("could not save the runtime analytics off choice");
			expect(result.stderr).not.toContain("runtime analytics is off");
		},
	);
});
