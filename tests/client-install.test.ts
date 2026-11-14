/** Installation fixtures use private homes and fake CLIs, never the operator's settings. */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupManagedClients,
	configureClients,
	discoverClients,
	freshRuntimeClients,
	legacyMigrations,
	verifiedCodingClients,
} from "../src/client-install.js";
import type { ClientInstallOptions, ClientTarget, LaunchConfig } from "../src/install-types.js";

let home: string;
let launch: LaunchConfig;
let options: ClientInstallOptions;

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function unavailable(): never {
	throw new Error("CLI unavailable");
}

function code(): ClientTarget {
	return { client: "claude-code", path: join(home, ".claude.json") };
}

function codex(): ClientTarget {
	return { client: "codex", path: join(home, ".codex", "config.toml") };
}

function chat(): ClientTarget {
	return {
		client: "claude-desktop",
		path: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
	};
}

/** The fixed Windows query is faked; no PowerShell or customer application is launched. */
function windowsOptions(
	packages: unknown,
	onQuery?: (command: string, args: readonly string[]) => void,
): ClientInstallOptions {
	const local = join(home, "local");
	const systemRoot = join(home, "Windows");
	mkdirSync(local, { recursive: true });
	write(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "fixture");
	return {
		...options,
		platform: "win32",
		env: { APPDATA: join(home, "roaming"), LOCALAPPDATA: local, SystemRoot: systemRoot },
		execute: (command, args) => {
			if (!command.endsWith("powershell.exe")) return unavailable();
			if (args[4]?.includes("Get-AppxPackage -Name OpenAI.Codex -PackageTypeFilter Main"))
				return "[]";
			onQuery?.(command, args);
			return JSON.stringify(packages);
		},
	};
}

const WINDOWS_CLAUDE_PACKAGE = {
	Name: "Claude",
	PackageFamilyName: "Claude_pzs8sxrjxfjjc",
	Virtualization: "default",
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pharaoh-client-install-"));
	launch = { command: join(home, "node"), args: [join(home, "runtime", "dist", "index.js")] };
	options = { home, platform: "darwin", env: { PATH: "" }, execute: unavailable };
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("independent client discovery", () => {
	it("finds both CLIs without memory credentials or a feature grant", () => {
		const execute = (command: string) => (command === "claude" ? "2.1.304" : "codex-cli 0.166.0");
		const targets = discoverClients({ ...options, execute });
		expect(targets.map(({ client }) => client)).toEqual(["claude-code", "codex"]);
	});

	it("finds desktop-only installations without requiring a CLI", () => {
		mkdirSync(join(home, "Applications", "Claude.app"), { recursive: true });
		mkdirSync(join(home, "Applications", "Codex.app"), { recursive: true });
		const targets = discoverClients(options);
		expect(targets.map(({ client }) => client)).toEqual(["claude-desktop", "claude-code", "codex"]);
		expect(targets.every(({ cli }) => cli === undefined)).toBe(true);
		expect(
			configureClients(targets, launch, options).every(({ status }) => status === "configured"),
		).toBe(true);
	});

	it("configures a fresh Codex installation bundled with ChatGPT Desktop", () => {
		const chatgpt = join(home, "Applications", "ChatGPT.app");
		mkdirSync(chatgpt, { recursive: true });
		expect(discoverClients(options)).toEqual([]);
		write(
			join(chatgpt, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
			"bundled client fixture",
		);

		const targets = discoverClients(options);
		expect(targets).toEqual([codex()]);
		expect(configureClients(targets, launch, options)[0].status).toBe("configured");
		expect(parseToml(readFileSync(codex().path, "utf8"))).toMatchObject({
			mcp_servers: { pharaoh: launch },
		});
	});

	it("does not create configurations for absent clients", () => {
		expect(discoverClients(options)).toEqual([]);
	});

	it("offers automatic runtime enrollment only before a first guarded registration", () => {
		const target = code();
		expect(freshRuntimeClients([target], options)).toEqual(["claude-code"]);
		expect(freshRuntimeClients([target], { ...options, platform: "win32" })).toEqual([]);
		write(target.path, '{"disabledMcpServers":["pharaoh"]}');
		expect(freshRuntimeClients([target], options)).toEqual([]);
		write(target.path, '{"projects":{"/repo":{"mcpServers":{"pharaoh":{"url":"custom"}}}}}');
		expect(freshRuntimeClients([target], options)).toEqual([]);
		write(target.path, "{}");
		expect(configureClients([target], launch, options)[0]).toMatchObject({
			status: "configured",
			created: true,
		});
		expect(freshRuntimeClients([target], options)).toEqual([]);
		write(target.path, "{}");
		expect(freshRuntimeClients([target], options)).toEqual([]);
	});

	it("discovers Linux Desktop Chat and Code from the documented config directory", () => {
		const path = join(home, ".config", "Claude", "claude_desktop_config.json");
		write(path, '{"theme":"dark"}');
		const targets = discoverClients({ ...options, platform: "linux" });
		expect(targets.map(({ client }) => client)).toEqual(["claude-desktop", "claude-code"]);
		expect(targets[0].path).toBe(path);
		expect(configureClients(targets, launch, options).map(({ status }) => status)).toEqual([
			"configured",
			"configured",
		]);
		expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("dark");
	});

	it("honors Linux XDG_CONFIG_HOME without reading a relative override", () => {
		const root = join(home, "xdg-config");
		mkdirSync(join(root, "Claude"), { recursive: true });
		const targets = discoverClients({
			...options,
			platform: "linux",
			env: { XDG_CONFIG_HOME: root },
		});
		expect(targets[0].path).toBe(join(root, "Claude", "claude_desktop_config.json"));
		expect(
			discoverClients({ ...options, platform: "linux", env: { XDG_CONFIG_HOME: "relative" } }),
		).toEqual([]);
	});

	it("honors explicit configuration roots", () => {
		const claudeRoot = join(home, "code profile");
		const codexRoot = join(home, "codex profile");
		mkdirSync(claudeRoot);
		mkdirSync(codexRoot);
		const targets = discoverClients({
			...options,
			env: { CLAUDE_CONFIG_DIR: claudeRoot, CODEX_HOME: codexRoot },
		});
		expect(targets.map(({ path }) => path)).toEqual([
			join(claudeRoot, ".claude.json"),
			join(codexRoot, "config.toml"),
		]);
	});

	it("reports a Windows packaged-app configuration as ambiguous", () => {
		const local = join(home, "local");
		mkdirSync(join(local, "Packages", "Anthropic.Claude_example"), { recursive: true });
		const targets = discoverClients({
			...options,
			platform: "win32",
			env: { APPDATA: join(home, "roaming"), LOCALAPPDATA: local },
		});
		expect(
			targets.find(({ client }) => client === "claude-desktop")?.ambiguousReason,
		).toBeDefined();
		expect(configureClients(targets, launch, options)[0].status).toBe("ambiguous");
	});

	it("a relative override does not prevent discovery of another client", () => {
		mkdirSync(join(home, ".codex"));
		const targets = discoverClients({ ...options, env: { CLAUDE_CONFIG_DIR: "relative" } });
		expect(targets.map(({ client }) => client)).toEqual(["claude-code", "codex"]);
		expect(targets[0].ambiguousReason).toBeDefined();
	});
});

describe("Windows Desktop package configuration", () => {
	it("configures the registered ChatGPT Store app before Codex creates its home", () => {
		const base = windowsOptions([]);
		let signature = "Developer";
		const config: ClientInstallOptions = {
			...base,
			execute: (command, args, context) => {
				if (!args[4]?.includes("Get-AppxPackage -Name OpenAI.Codex -PackageTypeFilter Main"))
					return base.execute?.(command, args, context) ?? unavailable();
				expect(command).toBe(
					join(home, "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				);
				return JSON.stringify([
					{
						Name: "OpenAI.Codex",
						PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
						SignatureKind: signature,
					},
				]);
			},
		};
		expect(configureClients(discoverClients(config), launch, config)[0].status).toBe("ambiguous");
		signature = "Store";
		const targets = discoverClients(config);
		expect(targets).toEqual([codex()]);
		expect(configureClients(targets, launch, config)[0].status).toBe("configured");
		expect(parseToml(readFileSync(codex().path, "utf8"))).toMatchObject({
			mcp_servers: { pharaoh: launch },
		});
	});

	it("uses a fixed trusted PowerShell query and the registered package's private config", () => {
		const config = windowsOptions([WINDOWS_CLAUDE_PACKAGE], (command, args) => {
			expect(command).toBe(
				join(home, "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			);
			expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
			expect(args[4]).toContain("Get-AppxPackage -Name Claude -PackageTypeFilter Main");
			expect(args[4]).toContain("Get-AppxPackageManifest");
			expect(args[4]).toContain("FileSystemWriteVirtualization");
			expect(args[4]).toContain("unvirtualizedResources");
			expect(args[4]).not.toContain(home);
		});
		const privatePath = join(
			home,
			"local",
			"Packages",
			WINDOWS_CLAUDE_PACKAGE.PackageFamilyName,
			"LocalCache",
			"Roaming",
			"Claude",
			"claude_desktop_config.json",
		);
		const fallback = join(home, "roaming", "Claude", "claude_desktop_config.json");
		write(privatePath, '{"theme":"private"}');
		write(fallback, '{"theme":"real-appdata"}');
		const targets = discoverClients(config);
		expect(targets.map(({ client }) => client)).toEqual(["claude-desktop", "claude-code"]);
		expect(targets[0]).toMatchObject({ path: privatePath });
		expect(targets[0].ambiguousReason).toBeUndefined();
		expect(targets[1].shadowPath).toBe(privatePath);
		expect(configureClients(targets, launch, config).map(({ status }) => status)).toEqual([
			"configured",
			"configured",
		]);
		expect(JSON.parse(readFileSync(privatePath, "utf8")).theme).toBe("private");
		expect(readFileSync(fallback, "utf8")).toBe('{"theme":"real-appdata"}');
	});

	it("uses documented APPDATA fallback when the registered package has no private file", () => {
		const config = windowsOptions([WINDOWS_CLAUDE_PACKAGE]);
		const targets = discoverClients(config);
		expect(targets[0].path).toBe(join(home, "roaming", "Claude", "claude_desktop_config.json"));
		expect(targets[0].ambiguousReason).toBeUndefined();
		expect(configureClients(targets, launch, config)[0].status).toBe("configured");
	});

	it("ignores stale package folders when the current-user package query finds no install", () => {
		const config = windowsOptions([]);
		mkdirSync(join(home, "local", "Packages", WINDOWS_CLAUDE_PACKAGE.PackageFamilyName), {
			recursive: true,
		});
		expect(discoverClients(config)).toEqual([]);
	});

	it("uses real APPDATA when the manifest fully disables virtualization", () => {
		const config = windowsOptions([{ ...WINDOWS_CLAUDE_PACKAGE, Virtualization: "disabled" }]);
		const privatePath = join(
			home,
			"local",
			"Packages",
			WINDOWS_CLAUDE_PACKAGE.PackageFamilyName,
			"LocalCache",
			"Roaming",
			"Claude",
			"claude_desktop_config.json",
		);
		write(privatePath, '{"theme":"obsolete-private"}');
		const targets = discoverClients(config);
		expect(targets[0].path).toBe(join(home, "roaming", "Claude", "claude_desktop_config.json"));
		expect(configureClients(targets, launch, config)[0].status).toBe("configured");
		expect(readFileSync(privatePath, "utf8")).toBe('{"theme":"obsolete-private"}');
	});

	it.each([
		[WINDOWS_CLAUDE_PACKAGE, WINDOWS_CLAUDE_PACKAGE],
		[{ ...WINDOWS_CLAUDE_PACKAGE, Virtualization: "unknown" }],
		[{ ...WINDOWS_CLAUDE_PACKAGE, PackageFamilyName: "../untrusted" }],
	])("keeps duplicate identities and unknown mappings ambiguous: %j", (...packages) => {
		const config = windowsOptions(packages);
		const targets = discoverClients(config);
		expect(targets[0].ambiguousReason).toBeDefined();
		expect(configureClients(targets, launch, config)[0].status).toBe("ambiguous");
	});

	it("does not echo query secrets or guess from a stale package folder on failure", () => {
		const config = windowsOptions([], () => {
			throw Object.assign(new Error("private-query-canary"), { stderr: "private-query-canary" });
		});
		mkdirSync(join(home, "local", "Packages", WINDOWS_CLAUDE_PACKAGE.PackageFamilyName), {
			recursive: true,
		});
		const targets = discoverClients(config);
		expect(targets[0].ambiguousReason).toBeDefined();
		const outcomes = configureClients(targets, launch, config);
		expect(outcomes[0].status).toBe("ambiguous");
		expect(JSON.stringify({ targets, outcomes })).not.toContain("private-query-canary");
	});
});

describe("registration ownership", () => {
	it("preserves custom and disabled JSON configurations byte for byte", () => {
		const first =
			'{"mcpServers":{"pharaoh":{"url":"https://custom.example/mcp"}},"theme":"dark"}\n';
		write(code().path, first);
		expect(configureClients([code()], launch, options)[0].status).toBe("preserved-custom");
		expect(readFileSync(code().path, "utf8")).toBe(first);
		const second =
			'{"mcpServers":{"pharaoh":{"command":"npx","args":["@pharaoh-so/mcp@0.3.50"],"enabled":false}}}\n';
		write(code().path, second);
		expect(configureClients([code()], launch, { ...options, migrateLegacy: true })[0].status).toBe(
			"preserved-disabled",
		);
		expect(readFileSync(code().path, "utf8")).toBe(second);
	});

	it("requires explicit migration of ambiguous exact-version NPX pins", () => {
		const old = { command: "npx", args: ["@pharaoh-so/mcp@0.3.50"] };
		write(code().path, JSON.stringify({ mcpServers: { pharaoh: old } }));
		expect(legacyMigrations([code()], options)).toEqual([{ ...code(), launch: old }]);
		expect(configureClients([code()], launch, options)[0]).toMatchObject({
			status: "preserved-custom",
			recovery: expect.stringContaining("--migrate-legacy"),
		});
		expect(configureClients([code()], launch, { ...options, migrateLegacy: true })[0].status).toBe(
			"configured",
		);
		expect(configureClients([code()], launch, options)[0].status).toBe("already-configured");
		const upgraded = { ...launch, args: [join(home, "runtime-next", "dist", "index.js")] };
		expect(configureClients([code()], upgraded, options)[0].status).toBe("configured");
		expect(JSON.parse(readFileSync(code().path, "utf8")).mcpServers.pharaoh).toEqual(upgraded);
	});

	it("keeps project registrations and disabled choices while adding user scope", () => {
		const projects = {
			"/project": {
				disabledMcpServers: ["pharaoh"],
				mcpServers: { pharaoh: { url: "https://project.example/mcp" } },
			},
		};
		write(
			code().path,
			JSON.stringify({ projects, mcpServers: { other: { command: "other" } }, theme: "dark" }),
		);
		expect(configureClients([code()], launch, options)[0].status).toBe("configured");
		expect(JSON.parse(readFileSync(code().path, "utf8"))).toEqual({
			projects,
			theme: "dark",
			mcpServers: { other: { command: "other" }, pharaoh: launch },
		});
	});

	it("configures user scope without a CLI while keeping a custom Desktop registration", () => {
		const desktop = JSON.stringify({
			mcpServers: { pharaoh: { url: "https://custom.example/mcp" } },
		});
		write(chat().path, desktop);
		const target = { ...code(), shadowPath: chat().path };
		expect(configureClients([target], launch, options)[0]).toMatchObject({
			status: "configured",
			detail: expect.stringContaining("Desktop Code uses its retained custom Desktop registration"),
		});
		expect(JSON.parse(readFileSync(code().path, "utf8")).mcpServers.pharaoh).toEqual(launch);
		expect(readFileSync(chat().path, "utf8")).toBe(desktop);
	});

	it("configures user scope while keeping a disabled Desktop registration", () => {
		const desktop = JSON.stringify({ mcpServers: { pharaoh: { ...launch, disabled: true } } });
		write(chat().path, desktop);
		expect(
			configureClients([{ ...code(), shadowPath: chat().path }], launch, options)[0],
		).toMatchObject({
			status: "configured",
			detail: expect.stringContaining("Desktop Code keeps its disabled Desktop registration"),
		});
		expect(readFileSync(chat().path, "utf8")).toBe(desktop);
	});

	it("records the exact server arguments, including a custom server", () => {
		const custom = { ...launch, args: [...launch.args, "--server", "https://self-hosted.example"] };
		expect(configureClients([chat()], custom, options)[0].status).toBe("configured");
		expect(configureClients([chat()], custom, options)[0].status).toBe("already-configured");
	});

	it("does not treat an unrecorded persistent launcher as installer-owned", () => {
		write(code().path, JSON.stringify({ mcpServers: { pharaoh: launch } }));
		expect(configureClients([code()], launch, options)[0].status).toBe("preserved-custom");
	});
});

describe("desktop-only Codex TOML", () => {
	it("appends and upgrades one generated block without rewriting comments", () => {
		const original =
			'# My profile\nmodel = "example-model"\n\n[profiles.work]\napproval_policy = "never"\n';
		write(codex().path, original);
		expect(configureClients([codex()], launch, options)[0].status).toBe("configured");
		const first = readFileSync(codex().path, "utf8");
		expect(first.startsWith(original)).toBe(true);
		const upgraded = { ...launch, args: [join(home, "next", "index.js")] };
		expect(configureClients([codex()], upgraded, options)[0].status).toBe("configured");
		const next = readFileSync(codex().path, "utf8");
		expect(next.startsWith(original)).toBe(true);
		expect((parseToml(next).mcp_servers as Record<string, unknown>).pharaoh).toEqual(upgraded);
	});

	it("preserves edited generated blocks and existing custom tables", () => {
		expect(configureClients([codex()], launch, options)[0].status).toBe("configured");
		const text = readFileSync(codex().path, "utf8").replace("command =", "command  =");
		write(codex().path, text);
		const upgraded = { ...launch, args: [join(home, "next", "index.js")] };
		expect(configureClients([codex()], upgraded, options)[0].status).toBe("preserved-custom");
		expect(readFileSync(codex().path, "utf8")).toBe(text);
	});

	it("leaves inline parent tables untouched when appending would be invalid", () => {
		const text = 'mcp_servers = { other = { command = "other" } }\n';
		write(codex().path, text);
		expect(configureClients([codex()], launch, options)[0].status).toBe("failed");
		expect(readFileSync(codex().path, "utf8")).toBe(text);
	});
});

describe("CLI-backed Codex", () => {
	it("uses the verified CLI and reads back the enabled launch", () => {
		const calls: string[][] = [];
		let registered: LaunchConfig | null = null;
		const execute: NonNullable<ClientInstallOptions["execute"]> = (_command, args) => {
			calls.push([...args]);
			if (args[1] === "get") {
				if (!registered)
					throw Object.assign(new Error("missing"), {
						stderr: "No MCP server named 'pharaoh' found.",
					});
				return JSON.stringify({ enabled: true, transport: { type: "stdio", ...registered } });
			}
			registered = { command: args[4], args: args.slice(5) };
			write(
				codex().path,
				`[mcp_servers.pharaoh]\ncommand = ${JSON.stringify(registered.command)}\nargs = ${JSON.stringify(registered.args)}\n`,
			);
			return "";
		};
		expect(
			configureClients([{ ...codex(), cli: "codex" }], launch, { ...options, execute })[0].status,
		).toBe("configured");
		expect(calls).toEqual([
			["mcp", "get", "pharaoh", "--json"],
			["mcp", "add", "pharaoh", "--", launch.command, ...launch.args],
			["mcp", "get", "pharaoh", "--json"],
		]);
	});

	it("preserves an effective project registration before invoking add", () => {
		const execute: NonNullable<ClientInstallOptions["execute"]> = (_command, args) => {
			expect(args[1]).toBe("get");
			return JSON.stringify({
				enabled: true,
				transport: { type: "stdio", command: "custom", args: [] },
			});
		};
		expect(
			configureClients([{ ...codex(), cli: "codex" }], launch, { ...options, execute })[0].status,
		).toBe("preserved-custom");
	});

	it("keeps a concurrent configuration change instead of invoking add", () => {
		const concurrent = '# Another process saved this profile\nmodel = "new-model"\n';
		const execute: NonNullable<ClientInstallOptions["execute"]> = (_command, args) => {
			expect(args[1]).toBe("get");
			write(codex().path, concurrent);
			throw Object.assign(new Error("missing"), {
				stderr: "No MCP server named 'pharaoh' found.",
			});
		};
		expect(
			configureClients([{ ...codex(), cli: "codex" }], launch, { ...options, execute })[0].status,
		).toBe("failed");
		expect(readFileSync(codex().path, "utf8")).toBe(concurrent);
	});
});

describe("verified coding clients for automatic startup assets", () => {
	it("requires current enabled provenance and never probes CLIs or changes files", () => {
		expect(configureClients([code(), codex(), chat()], launch, options)).toHaveLength(3);
		const paths = [
			code().path,
			codex().path,
			chat().path,
			join(home, ".pharaoh", "client-installations.json"),
		];
		const before = paths.map((path) => readFileSync(path, "utf8"));
		let probes = 0;
		expect(
			verifiedCodingClients({
				...options,
				execute: () => {
					probes++;
					return unavailable();
				},
			}),
		).toEqual(["claude-code", "codex"]);
		expect(probes).toBe(0);
		expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(before);
	});

	it("does not infer coding eligibility from Desktop Chat or a copied unverified launch", () => {
		configureClients([chat()], launch, options);
		write(code().path, JSON.stringify({ mcpServers: { pharaoh: launch } }));
		write(
			codex().path,
			`[mcp_servers.pharaoh]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`,
		);
		expect(verifiedCodingClients(options)).toEqual([]);
	});

	it("preserves disabled and modified registrations even when historical receipts exist", () => {
		configureClients([code(), codex()], launch, options);
		write(code().path, JSON.stringify({ mcpServers: { pharaoh: { ...launch, enabled: false } } }));
		write(codex().path, '[mcp_servers.pharaoh]\nurl = "https://custom.example/mcp"\n');
		const before = [code().path, codex().path].map((path) => readFileSync(path, "utf8"));
		expect(verifiedCodingClients(options)).toEqual([]);
		expect([code().path, codex().path].map((path) => readFileSync(path, "utf8"))).toEqual(before);
	});

	it("uses only the active configured homes rather than historical default registrations", () => {
		configureClients([code(), codex()], launch, options);
		const claudeRoot = join(home, "code-profile");
		const codexRoot = join(home, "codex-profile");
		const targets: ClientTarget[] = [
			{ client: "claude-code", path: join(claudeRoot, ".claude.json") },
			{ client: "codex", path: join(codexRoot, "config.toml") },
		];
		const active = { ...options, env: { CLAUDE_CONFIG_DIR: claudeRoot, CODEX_HOME: codexRoot } };
		expect(verifiedCodingClients(active)).toEqual([]);
		configureClients(targets, launch, active);
		expect(verifiedCodingClients(active)).toEqual(["claude-code", "codex"]);
		write(targets[0].path, '{"disabledMcpServers":["pharaoh"]}');
		write(targets[1].path, "[mcp_servers.pharaoh]\nenabled = false\n");
		expect(verifiedCodingClients(active)).toEqual([]);
		expect(verifiedCodingClients(options)).toEqual(["claude-code", "codex"]);
	});

	it("excludes malformed configurations independently and fails closed on malformed provenance", () => {
		configureClients([code(), codex()], launch, options);
		write(code().path, '{"secret":"private-startup-canary", broken');
		expect(verifiedCodingClients(options)).toEqual(["codex"]);
		const receipt = join(home, ".pharaoh", "client-installations.json");
		write(receipt, '{"secret":"private-startup-canary", broken');
		expect(verifiedCodingClients(options)).toEqual([]);
		expect(readFileSync(receipt, "utf8")).toContain("private-startup-canary");
	});

	it("matches the running version and Node executable without comparing custom server flags", () => {
		write(launch.command, "fixture-node");
		const configured = {
			...launch,
			args: [...launch.args, "--server", "https://self-hosted.example"],
		};
		configureClients([code(), codex()], configured, options);
		expect(verifiedCodingClients({ ...options, runningLaunch: launch })).toEqual([
			"claude-code",
			"codex",
		]);
		const next = {
			...configured,
			args: [join(home, "next-version", "index.js"), ...configured.args.slice(1)],
		};
		configureClients([code(), codex()], next, options);
		expect(verifiedCodingClients({ ...options, runningLaunch: launch })).toEqual([]);
		expect(verifiedCodingClients({ ...options, runningLaunch: next })).toEqual([
			"claude-code",
			"codex",
		]);
		const otherNode = join(home, "other-node");
		write(otherNode, "another-fixture-node");
		expect(
			verifiedCodingClients({ ...options, runningLaunch: { ...next, command: otherNode } }),
		).toEqual([]);
	});

	it("requires the managed proxy release and server to support runtime receipts", () => {
		const server = "https://self-hosted.example";
		const managedLaunch = (version: string) => {
			const pkg = join(
				realpathSync(home),
				".pharaoh",
				"runtimes",
				"mcp",
				version,
				"node_modules",
				"@pharaoh-so",
				"mcp",
			);
			const entry = join(pkg, "dist", "index.js");
			write(entry, "fixture entry");
			write(join(pkg, "package.json"), JSON.stringify({ name: "@pharaoh-so/mcp", version }));
			return { pkg, config: { command: launch.command, args: [entry, "--server", server] } };
		};
		configureClients([code()], managedLaunch("0.3.69").config, options);
		const requiredProxy = { minimumVersion: "0.3.70", server };
		expect(verifiedCodingClients({ ...options, requiredProxy })).toEqual([]);
		const next = managedLaunch("0.3.70");
		configureClients([code()], next.config, options);
		expect(verifiedCodingClients({ ...options, requiredProxy })).toEqual([]);
		write(join(next.pkg, "runtime", "runtime-client.mjs"), "fixture capability");
		expect(verifiedCodingClients({ ...options, requiredProxy })).toEqual(["claude-code"]);
		expect(
			verifiedCodingClients({
				...options,
				requiredProxy: { ...requiredProxy, server: "https://other.example" },
			}),
		).toEqual([]);
		// Through the stable launcher, the version current.json names is the one checked.
		const runtimes = join(realpathSync(home), ".pharaoh", "runtimes", "mcp");
		write(
			join(runtimes, "0.3.70", ".pharaoh-runtime.json"),
			'{"package":"@pharaoh-so/mcp","version":"0.3.70"}',
		);
		const launcher = {
			command: launch.command,
			args: [join(runtimes, "launcher-v1.mjs"), "--server", server],
		};
		configureClients([code()], launcher, options);
		write(join(runtimes, "current.json"), '{"version":"0.3.69"}');
		expect(verifiedCodingClients({ ...options, requiredProxy })).toEqual([]);
		write(join(runtimes, "current.json"), '{"version":"0.3.70"}');
		expect(verifiedCodingClients({ ...options, requiredProxy })).toEqual(["claude-code"]);
		// The proxy and its saved-worktree hook check themselves as the launcher that started them
		// (runningEntry): as their own versioned entry they would never count as managed.
		write(launch.command, "fixture-node");
		const running = (entry: string) => ({ command: launch.command, args: [entry] });
		expect(verifiedCodingClients({ ...options, runningLaunch: running(launcher.args[0]) })).toEqual(
			["claude-code"],
		);
		expect(
			verifiedCodingClients({ ...options, runningLaunch: running(next.config.args[0]) }),
		).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"accepts a persistent Node alias and rejects a symlinked client file",
		() => {
			write(launch.command, "fixture-node");
			const alias = join(home, "node-alias");
			symlinkSync(launch.command, alias);
			configureClients([code(), codex()], { ...launch, command: alias }, options);
			expect(verifiedCodingClients({ ...options, runningLaunch: launch })).toEqual([
				"claude-code",
				"codex",
			]);
			const original = readFileSync(code().path, "utf8");
			rmSync(code().path);
			const outside = join(home, "outside.json");
			write(outside, original);
			symlinkSync(outside, code().path);
			expect(verifiedCodingClients({ ...options, runningLaunch: launch })).toEqual(["codex"]);
			expect(readFileSync(outside, "utf8")).toBe(original);
		},
	);
});

describe("failures and cleanup", () => {
	it("retains a successful client when another configuration is malformed", () => {
		write(code().path, '{"token":"private-canary", broken');
		const outcomes = configureClients([code(), codex()], launch, options);
		expect(outcomes.map(({ status }) => status)).toEqual(["failed", "configured"]);
		expect(JSON.stringify(outcomes)).not.toContain("private-canary");
	});

	it.skipIf(process.platform === "win32")("refuses a symlinked configuration", () => {
		const external = join(home, "external.json");
		write(external, "{}\n");
		symlinkSync(external, code().path);
		expect(configureClients([code()], launch, options)[0].status).toBe("failed");
		expect(readFileSync(external, "utf8")).toBe("{}\n");
	});

	it("removes managed registrations and preserves a later user edit", () => {
		expect(
			configureClients([code(), codex()], launch, options).map(({ status }) => status),
		).toEqual(["configured", "configured"]);
		write(code().path, '{"mcpServers":{"pharaoh":{"url":"https://custom.example"}}}\n');
		const outcomes = cleanupManagedClients(options);
		expect(outcomes.find(({ client }) => client === "claude-code")?.status).toBe(
			"preserved-custom",
		);
		expect(outcomes.find(({ client }) => client === "codex")?.status).toBe("configured");
		expect(parseToml(readFileSync(codex().path, "utf8")).mcp_servers).toBeUndefined();
	});

	it("targets the recorded Codex profile when cleaning a CLI-created registration", () => {
		let registered = false;
		const execute: NonNullable<ClientInstallOptions["execute"]> = (
			_command,
			args,
			commandOptions,
		) => {
			if (args[0] === "--version") return "codex-cli 0.166.0";
			if (args[1] === "get") {
				if (!registered)
					throw Object.assign(new Error("missing"), {
						stderr: "No MCP server named 'pharaoh' found.",
					});
				return JSON.stringify({ enabled: true, transport: { type: "stdio", ...launch } });
			}
			if (args[1] === "remove") {
				expect(commandOptions.env.CODEX_HOME).toBe(dirname(codex().path));
				write(codex().path, 'model = "retained"\n');
				registered = false;
				return "";
			}
			registered = true;
			write(
				codex().path,
				`model = "retained"\n[mcp_servers.pharaoh]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`,
			);
			return "";
		};
		write(codex().path, 'model = "retained"\n');
		expect(
			configureClients([{ ...codex(), cli: "codex" }], launch, { ...options, execute })[0].status,
		).toBe("configured");
		const outcomes = cleanupManagedClients({
			...options,
			execute,
			env: { CODEX_HOME: join(home, "different-profile") },
		});
		expect(outcomes[0].status).toBe("configured");
		expect(readFileSync(codex().path, "utf8")).toBe('model = "retained"\n');
	});
});
