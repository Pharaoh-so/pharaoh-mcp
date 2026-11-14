import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workerHost from "../src/local/worker-host.js";
import {
	ensureRuntime,
	refusedRemoteTarball,
	resolveLaunchNode,
	resolveNpmCli,
	RuntimeSetupError,
	type RuntimeOptions,
	type RuntimeRunner,
} from "../src/runtime.js";

const VERSION = "1.2.3";

function write(file: string, contents = ""): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, contents);
}

function npmFixture(root: string): string {
	write(
		join(root, "package.json"),
		JSON.stringify({
			name: "npm",
			version: "10.9.0",
			bin: { npm: "bin/npm-cli.js", npx: "bin/npx-cli.js" },
		}),
	);
	write(join(root, "bin", "npm-cli.js"));
	write(join(root, "bin", "npx-cli.js"));
	return join(root, "bin", "npm-cli.js");
}

function installedFixture(prefix: string, version = VERSION, sdk = true): void {
	const root = join(prefix, "node_modules", "@pharaoh-so", "mcp");
	write(
		join(root, "package.json"),
		JSON.stringify({
			name: "@pharaoh-so/mcp",
			version,
			bin: { "pharaoh-mcp": "./dist/index.js" },
		}),
	);
	write(join(root, "dist", "index.js"), "// Fixture entry, never executed.\n");
	if (sdk) {
		const sdkRoot = join(prefix, "node_modules", "@modelcontextprotocol", "sdk");
		write(
			join(sdkRoot, "package.json"),
			JSON.stringify({
				name: "@modelcontextprotocol/sdk",
				version: "1.26.0",
				exports: { "./client/index.js": "./client.js" },
			}),
		);
		write(join(sdkRoot, "client.js"), "module.exports = {};\n");
	}
}

describe("managed exact-version runtime", () => {
	let home: string;
	let node: string;
	let npm: string;
	let options: RuntimeOptions;
	let installs: number;
	let run: RuntimeRunner;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pharaoh runtime spaces "));
		node = join(home, "Node installation", "node");
		write(node);
		npm = npmFixture(join(home, "Node installation", "node_modules", "npm"));
		installs = 0;
		run = vi.fn<RuntimeRunner>((_file, args, settings) => {
			if (args[1] === "--version") return "10.9.0\n";
			if (args[1] === "config") return join(home, "global-npmrc");
			installs++;
			const prefix = args[args.indexOf("--prefix") + 1];
			expect(settings.cwd).toBe(prefix);
			installedFixture(prefix, args[2].slice("@pharaoh-so/mcp@".length));
			return "";
		});
		options = {
			home,
			execPath: node,
			env: { PATH: "", npm_execpath: npm },
			version: VERSION,
			run,
		};
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	const runtimes = (home: string) => join(realpathSync(home), ".pharaoh", "runtimes", "mcp");

	it("recognizes npm 12 refusing a tarball off the registry, and nothing else", () => {
		// Breaks if npm's refusal stops reading as off-registry: the update would report
		// install-failed for a foreign tarball on npm 12 (pharaoh-mcp #70, Nov 13).
		const refusal = Object.assign(new Error("Command failed"), {
			stderr:
				'npm error code EALLOWREMOTE\nnpm error Fetching packages of type "remote" have been disabled\n',
		});
		expect(refusedRemoteTarball(refusal)).toBe(true);
		expect(
			refusedRemoteTarball(Object.assign(new Error("x"), { stderr: "npm error code E404\n" })),
		).toBe(false);
		expect(refusedRemoteTarball(new Error("EALLOWREMOTE in a message, not npm's output"))).toBe(
			false,
		);
		expect(refusedRemoteTarball(null)).toBe(false);
	});

	it("prepares a cache-independent absolute entry with a GUI-like PATH", async () => {
		// The installer's progress line hangs on this: once for a download, never for a current runtime.
		const onInstall = vi.fn<(version: string) => void>();
		options.onInstall = onInstall;
		const launch = await ensureRuntime(options);
		expect(onInstall.mock.calls).toEqual([[VERSION]]);
		expect(launch).toEqual({
			command: realpathSync(node),
			args: [
				join(runtimes(home), VERSION, "node_modules", "@pharaoh-so", "mcp", "dist", "index.js"),
			],
		});
		expect(installs).toBe(1);
		expect(existsSync(launch.args[0])).toBe(true);
		expect(readdirSync(runtimes(home))).toEqual([VERSION]);
		if (process.platform !== "win32") expect(statSync(runtimes(home)).mode & 0o777).toBe(0o700);
		expect(await ensureRuntime(options)).toEqual(launch);
		expect(installs).toBe(1);
		expect(onInstall).toHaveBeenCalledTimes(1);
	});

	it("uses exact registry installation in neutral staging and suppresses lifecycle scripts", async () => {
		write(
			join(home, "repository", "package.json"),
			'{"name":"@pharaoh-so/mcp","version":"1.2.3","scripts":{"preinstall":"do-not-run"}}',
		);
		await ensureRuntime(options);
		const call = vi.mocked(run).mock.calls.find(([, args]) => args[1] === "install");
		expect(call).toBeDefined();
		const [executable, args, settings] = call!;
		expect(executable).toBe(realpathSync(node));
		expect(args.slice(0, 3)).toEqual([realpathSync(npm), "install", "@pharaoh-so/mcp@1.2.3"]);
		expect(args).toEqual(
			expect.arrayContaining([
				"--ignore-scripts",
				"--omit=dev",
				"--global=false",
				"--workspaces=false",
				"--no-audit",
				"--no-fund",
				"--package-lock=false",
				"--prefer-offline",
			]),
		);
		expect(settings.shell).toBe(false);
		expect(settings.cwd).toContain(`${runtimes(home)}`);
		expect(settings.cwd).not.toContain("repository");
	});

	it("retains registry authentication while removing install and preload redirection", async () => {
		const secret = "fixture-registry-secret";
		const npmrc = join(home, "custom-npmrc");
		write(
			npmrc,
			`registry=https://registry.example/\n//registry.example/:_authToken=\${NPM_TOKEN}\n//private.example/:_authToken=\${NPM_PRIVATE_TOKEN}\nproxy=http://proxy.example/\ncafile=certs/company.pem\ncache=~/npm-cache\nprefix=/wrong\nscript-shell=/do-not-run\n`,
		);
		options.sourceCwd = join(home, "original repository");
		options.env = {
			...options.env,
			npm_config_userconfig: npmrc,
			npm_config_prefix: "/wrong",
			npm_config_global: "true",
			npm_config_workspace: "/repository",
			NPM_CONFIG_PREFIX: "/also-wrong",
			NPM_CONFIG_GLOBAL: "true",
			NPM_CONFIG_WORKSPACE: "/another-repository",
			NODE_OPTIONS: "--require do-not-load",
			NODE_PATH: "/do-not-resolve",
			LD_PRELOAD: "/do-not-preload",
			DYLD_INSERT_LIBRARIES: "/do-not-load-library",
			NPM_TOKEN: secret,
			NPM_AUTH_TOKEN: secret,
			NPM_PRIVATE_TOKEN: secret,
			npm_config_registry: "https://registry.example/",
			npm_config_cache: "npx-cache",
		};
		let config = "";
		let installEnv: NodeJS.ProcessEnv | undefined;
		options.run = (file, args, settings) => {
			if (args[1] === "install") {
				config = readFileSync(args[args.indexOf("--userconfig") + 1], "utf8");
				installEnv = settings.env;
			}
			return run(file, args, settings);
		};
		const launch = await ensureRuntime(options);
		expect(config).toContain(":_authToken=${NPM_TOKEN}");
		expect(config).toContain(":_authToken=${NPM_PRIVATE_TOKEN}");
		expect(config).toContain("proxy=http://proxy.example/");
		expect(config).toContain(
			JSON.stringify(join(home, "original repository", "certs", "company.pem")),
		);
		// The install reads the cache npx just filled: a relative path resolves where npx ran.
		expect(config).toContain(`cache=${JSON.stringify(join(home, "npm-cache"))}`);
		expect(config).not.toContain("script-shell");
		expect(config).not.toContain("prefix");
		expect(installEnv).toMatchObject({
			NPM_TOKEN: secret,
			NPM_AUTH_TOKEN: secret,
			NPM_PRIVATE_TOKEN: secret,
			npm_config_registry: "https://registry.example/",
			npm_config_cache: join(home, "original repository", "npx-cache"),
		});
		for (const key of [
			"NODE_OPTIONS",
			"NODE_PATH",
			"LD_PRELOAD",
			"DYLD_INSERT_LIBRARIES",
			"npm_config_prefix",
			"npm_config_global",
			"npm_config_workspace",
			"npm_config_userconfig",
			"NPM_CONFIG_PREFIX",
			"NPM_CONFIG_GLOBAL",
			"NPM_CONFIG_WORKSPACE",
		])
			expect(installEnv).not.toHaveProperty(key);
		expect(existsSync(join(runtimes(home), VERSION, ".npmrc"))).toBe(false);
		expect(readFileSync(join(runtimes(home), VERSION, "package.json"), "utf8")).not.toContain(
			secret,
		);
		expect(launch.args[0]).not.toContain("_npx");
	});

	it("coalesces concurrent preparation of the same runtime", async () => {
		const first = ensureRuntime(options);
		const second = ensureRuntime(options);
		expect(first).toBe(second);
		expect(await first).toEqual(await second);
		expect(installs).toBe(1);
	});

	it("reclaims a dead install and deletes its marked credential staging", async () => {
		const root = runtimes(home);
		const abandoned = join(root, ".stage-old-interrupted");
		write(
			join(root, ".install-lock", "owner.json"),
			JSON.stringify({ pid: 99_999_999, token: "dead" }),
		);
		write(join(abandoned, ".runtime-stage.json"), JSON.stringify({ pid: 99_999_999 }));
		write(join(abandoned, ".npmrc"), "fixture-private-token");
		await ensureRuntime(options);
		expect(readdirSync(root)).toEqual([VERSION]);
	});

	it("does not disturb an installer whose process is alive", async () => {
		const root = runtimes(home);
		write(
			join(root, ".install-lock", "owner.json"),
			JSON.stringify({ pid: process.pid, token: "other" }),
		);
		await expect(ensureRuntime({ ...options, lockTimeoutMs: 1 })).rejects.toThrow(
			"Another Pharaoh installation",
		);
		expect(JSON.parse(readFileSync(join(root, ".install-lock", "owner.json"), "utf8")).token).toBe(
			"other",
		);
		expect(installs).toBe(0);
	});

	it("keeps earlier versions when preparing another version", async () => {
		const old = await ensureRuntime(options);
		const next = await ensureRuntime({ ...options, version: "1.2.4" });
		expect(existsSync(old.args[0])).toBe(true);
		expect(existsSync(next.args[0])).toBe(true);
		expect(readdirSync(runtimes(home)).sort()).toEqual(["1.2.3", "1.2.4"]);
	});

	it("removes credential staging and partial output on install failure", async () => {
		const old = await ensureRuntime(options);
		options.run = (_file, args) => {
			if (args[1] === "--version") return "10.9.0";
			if (args[1] === "config") return join(home, "global-npmrc");
			throw new Error("do-not-display registry-password or private npm diagnostics");
		};
		await expect(ensureRuntime({ ...options, version: "1.2.4" })).rejects.toThrow(
			RuntimeSetupError,
		);
		await expect(ensureRuntime({ ...options, version: "1.2.4" })).rejects.not.toThrow(
			"registry-password",
		);
		expect(existsSync(old.args[0])).toBe(true);
		expect(readdirSync(runtimes(home))).toEqual([VERSION]);
	});

	it("installs from npm's cache first, then online when the cache can't satisfy this exact version", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const online: { args: readonly string[]; timeout?: number }[] = [];
			options.run = (file, args, settings) => {
				if (args[1] !== "install") return run(file, args, settings);
				if (!args.includes("--prefer-offline")) {
					online.push({ args, timeout: settings.timeout });
					return run(file, args, settings);
				}
				installs++;
				write(join(args[args.indexOf("--prefix") + 1], "node_modules", "partial", "package.json"));
				vi.setSystemTime(Date.now() + 30_000);
				throw new Error("ETARGET: the cached version list predates this release");
			};
			const launch = await ensureRuntime(options);
			expect(installs).toBe(2);
			expect(existsSync(launch.args[0])).toBe(true);
			expect(existsSync(join(runtimes(home), VERSION, "node_modules", "partial"))).toBe(false);
			// The online run rechecks cached version lists and gets only what's left of 120 s.
			expect(online[0].args).toContain("--prefer-online");
			expect(online[0].timeout).toBeLessThanOrEqual(90_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("drops a cache path it can't resolve, so npm uses its default cache", async () => {
		const npmrc = join(home, "custom-npmrc");
		write(npmrc, "cache=${PHARAOH_FIXTURE_UNSET}/npm\nregistry=https://registry.example/\n");
		options.env = {
			...options.env,
			npm_config_userconfig: npmrc,
			npm_config_cache: "${PHARAOH_FIXTURE_UNSET}",
		};
		let config = "";
		let installEnv: NodeJS.ProcessEnv | undefined;
		options.run = (file, args, settings) => {
			if (args[1] === "install") {
				config = readFileSync(args[args.indexOf("--userconfig") + 1], "utf8");
				installEnv = settings.env;
			}
			return run(file, args, settings);
		};
		await ensureRuntime(options);
		expect(config).toBe("registry=https://registry.example/\n");
		expect(installEnv).not.toHaveProperty("npm_config_cache");
	});

	it("stops waiting for another installer's lock when the caller gives up", async () => {
		const root = runtimes(home);
		mkdirSync(join(root, ".install-lock"), { recursive: true });
		writeFileSync(
			join(root, ".install-lock", "owner.json"),
			JSON.stringify({ pid: process.pid, token: "other installer" }),
		);
		const preparation = new AbortController();
		setTimeout(() => preparation.abort(), 50);
		const started = Date.now();
		await expect(
			ensureRuntime({ ...options, lockTimeoutMs: 60_000, signal: preparation.signal }),
		).rejects.toThrow(RuntimeSetupError);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(installs).toBe(0);
	});

	it("does not start the online install once the time budget is spent", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			options.run = (_file, args) => {
				if (args[1] === "--version") return "10.9.0";
				if (args[1] === "config") return join(home, "global-npmrc");
				installs++;
				vi.setSystemTime(Date.now() + 119_500);
				throw new Error("npm timed out");
			};
			await expect(ensureRuntime(options)).rejects.toThrow(RuntimeSetupError);
			expect(installs).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		"wrong-version",
		"missing-sdk",
		"outside-entry",
	])("rejects %s before publishing", async (fault) => {
		options.run = (_file, args) => {
			if (args[1] === "--version") return "10.9.0";
			if (args[1] === "config") return join(home, "global-npmrc");
			const prefix = args[args.indexOf("--prefix") + 1];
			installedFixture(
				prefix,
				fault === "wrong-version" ? "9.9.9" : VERSION,
				fault !== "missing-sdk",
			);
			if (fault === "outside-entry") {
				const entry = join(prefix, "node_modules", "@pharaoh-so", "mcp", "dist", "index.js");
				rmSync(entry);
				write(join(home, "outside.js"));
				symlinkSync(join(home, "outside.js"), entry);
			}
			return "";
		};
		await expect(ensureRuntime(options)).rejects.toThrow(RuntimeSetupError);
		expect(readdirSync(runtimes(home))).toEqual([]);
	});

	it("repairs a damaged runtime only after validating its replacement", async () => {
		const launch = await ensureRuntime(options);
		write(launch.args[0].replace(/dist[/\\]index\.js$/, "package.json"), '{"name":"different"}');
		expect(await ensureRuntime(options)).toEqual(launch);
		expect(installs).toBe(2);
		const quarantined = readdirSync(runtimes(home)).find((name) => name.startsWith(".invalid-"));
		expect(quarantined).toBeDefined();
		expect(
			readFileSync(
				join(runtimes(home), quarantined!, "node_modules", "@pharaoh-so", "mcp", "package.json"),
				"utf8",
			),
		).toBe('{"name":"different"}');
	});

	it("repairs an omitted optional analyzer on a later install and retains hosted fallback", async () => {
		const analyzerFile = (proxy: string) => join(proxy, "dist", "analyzer-fixture");
		const probe = vi
			.spyOn(workerHost, "localAnalyzerInstallStatus")
			.mockImplementation((proxy) => (existsSync(analyzerFile(proxy)) ? "ready" : "repair-needed"));
		let fetchFails = false;
		let includeAnalyzer = false;
		options.run = (file, args, settings) => {
			if (args[1] === "install" && fetchFails) {
				installs++;
				throw new Error("Optional registry fetch failed");
			}
			const output = run(file, args, settings);
			if (args[1] === "install" && includeAnalyzer) {
				const prefix = args[args.indexOf("--prefix") + 1];
				write(analyzerFile(join(prefix, "node_modules", "@pharaoh-so", "mcp")));
			}
			return output;
		};
		try {
			const launch = await ensureRuntime(options);
			write(launch.args[0], "Original hosted entry");
			expect(await ensureRuntime(options)).toEqual(launch);
			expect(readFileSync(launch.args[0], "utf8")).toBe("Original hosted entry");
			fetchFails = true;
			expect(await ensureRuntime(options)).toEqual(launch);
			expect(readFileSync(launch.args[0], "utf8")).toBe("Original hosted entry");
			expect(readdirSync(runtimes(home))).toEqual([VERSION]);

			fetchFails = false;
			includeAnalyzer = true;
			expect(await ensureRuntime(options)).toEqual(launch);
			expect(existsSync(analyzerFile(dirname(dirname(launch.args[0]))))).toBe(true);
			// Each install that lacked the analyzer ran from the cache, then once online.
			expect(installs).toBe(7);
			expect(await ensureRuntime(options)).toEqual(launch);
			expect(installs).toBe(7);
		} finally {
			probe.mockRestore();
		}
	});

	it("keeps a damaged runtime in place when its replacement cannot be installed", async () => {
		const launch = await ensureRuntime(options);
		write(launch.args[0], "damaged old entry");
		write(launch.args[0].replace(/dist[/\\]index\.js$/, "package.json"), '{"name":"different"}');
		options.run = (_file, args) => {
			if (args[1] === "--version") return "10.9.0";
			if (args[1] === "config") return join(home, "global-npmrc");
			throw new Error("install failed");
		};
		await expect(ensureRuntime(options)).rejects.toThrow(RuntimeSetupError);
		expect(readFileSync(launch.args[0], "utf8")).toBe("damaged old entry");
		expect(readdirSync(runtimes(home))).toEqual([VERSION]);
	});

	it("restores the damaged runtime when atomic replacement fails", async () => {
		const launch = await ensureRuntime(options);
		write(launch.args[0], "old entry retained");
		write(launch.args[0].replace(/dist[/\\]index\.js$/, "package.json"), '{"name":"different"}');
		options.rename = (from, to) => {
			if (from.includes(".stage-")) throw new Error("publication failure");
			renameSync(from, to);
		};
		await expect(ensureRuntime(options)).rejects.toThrow(RuntimeSetupError);
		expect(readFileSync(launch.args[0], "utf8")).toBe("old entry retained");
		expect(readdirSync(runtimes(home))).toEqual([VERSION]);
	});

	it("does not fall back to an unversioned package", async () => {
		await expect(ensureRuntime({ ...options, version: "0.0.0" })).rejects.toThrow(
			"package version",
		);
		expect(installs).toBe(0);
	});
});

describe("Node and npm discovery", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("uses the matching persistent Node path without depending on shell initialization", () => {
		expect(resolveLaunchNode({ env: { PATH: dirname(process.execPath) } })).toBe(
			join(dirname(process.execPath), process.platform === "win32" ? "node.exe" : "node"),
		);
	});

	it("falls back to the running Node and provides reinstall recovery", () => {
		const diagnostic = vi.fn();
		expect(resolveLaunchNode({ env: { PATH: "" }, onDiagnostic: diagnostic })).toBe(
			realpathSync(process.execPath),
		);
		expect(diagnostic).toHaveBeenCalledWith(
			expect.stringContaining("npx @pharaoh-so/mcp@latest install"),
		);
	});

	it("normalizes npx-cli.js to its validated npm sibling", async () => {
		const root = mkdtempSync(join(tmpdir(), "pharaoh-npm-"));
		roots.push(root);
		const npm = npmFixture(join(root, "npm"));
		const run = vi.fn(() => "10.9.0\n");
		await expect(
			resolveNpmCli({ env: { PATH: "", npm_execpath: join(dirname(npm), "npx-cli.js") }, run }),
		).resolves.toBe(realpathSync(npm));
		expect(run).toHaveBeenCalledWith(
			expect.any(String),
			[realpathSync(npm), "--version"],
			expect.objectContaining({ timeout: 15_000, shell: false }),
		);
	});

	it("finds the npm layout beside Windows Node without reading npm.cmd", async () => {
		const root = mkdtempSync(join(tmpdir(), "pharaoh Windows layout "));
		roots.push(root);
		write(join(root, "node.exe"));
		write(join(root, "npm.cmd"), "do not execute or interpret this command file");
		const npm = npmFixture(join(root, "node_modules", "npm"));
		await expect(
			resolveNpmCli({
				platform: "win32",
				execPath: join(root, "node.exe"),
				env: { Path: root },
				run: () => "10.9.0",
			}),
		).resolves.toBe(realpathSync(npm));
	});

	it("rejects invalid package hints without executing them", async () => {
		const root = mkdtempSync(join(tmpdir(), "pharaoh-invalid-npm-"));
		roots.push(root);
		const hint = npmFixture(join(root, "not-npm"));
		write(join(root, "not-npm", "package.json"), '{"name":"not-npm","version":"10.9.0"}');
		write(join(root, "node"));
		const run = vi.fn(() => "10.9.0");
		await expect(
			resolveNpmCli({ execPath: join(root, "node"), env: { PATH: "", npm_execpath: hint }, run }),
		).rejects.toThrow("working npm installation");
		expect(run).not.toHaveBeenCalled();
	});
});
