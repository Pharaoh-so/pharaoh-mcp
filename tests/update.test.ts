/**
 * The consented update end to end, without the network: a local registry serves
 * a stand-in @pharaoh-so/mcp and its SDK, real npm installs them into the
 * updater's private stage, and the real launcher (runtime/launcher-v1.mjs) runs
 * whatever it selects. Sigstore and `npm audit signatures` need the network, so
 * they are stand-ins here; the release checks run them against npm's real
 * bundles. Every rejection must leave the current version running.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activatePending, selectVersion } from "../runtime/launcher-v1.mjs";
import { PUBLISHER, runUpdate, type UpdateOptions, verifySigstoreBundle } from "../src/update.js";

const PACKAGE = new URL("../", import.meta.url).pathname;
const CURRENT = "0.3.83";
const NEXT = "0.3.90";
const SLSA = "https://slsa.dev/provenance/v1";
const PUBLISH = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const WORKFLOW = {
	repository: "https://github.com/Pharaoh-so/pharaoh-mcp",
	path: ".github/workflows/publish-mcp-proxy.yml",
	ref: "refs/heads/main",
};

let work: string;
let server: ChildProcess;
let registry: string;
/** The same files from a second port: reachable, but not the registry the update trusts. */
let offRegistry: string;
let tarballs: Record<string, Buffer>;
/** What the registry serves wrongly in the current test. */
let fault: "none" | "tampered" | "off-registry" | "digest" | "publisher" = "none";

function write(file: string, contents: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, contents);
}

/** A stand-in package whose entry prints the version it is, for the launcher to run. */
function packageDir(name: string, version: string, files: Record<string, string>): string {
	const dir = join(work, "src", `${name.replace("/", "-")}-${version}`);
	write(
		join(dir, "package.json"),
		JSON.stringify({ name, version, ...JSON.parse(files["package.json"] ?? "{}") }),
	);
	for (const [file, contents] of Object.entries(files))
		if (file !== "package.json") write(join(dir, file), contents);
	return dir;
}

function pack(dir: string): Buffer {
	const out = join(work, "packed");
	mkdirSync(out, { recursive: true });
	const name = execFileSync("npm", ["pack", "--pack-destination", out, "--silent"], {
		cwd: dir,
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: work },
	}).trim();
	return readFileSync(join(out, name.split("\n").pop() ?? ""));
}

const integrity = (bytes: Buffer) =>
	`sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function mcpFiles(version: string): Record<string, string> {
	return {
		"package.json": JSON.stringify({
			bin: { "pharaoh-mcp": "./dist/index.js" },
			dependencies: { "@modelcontextprotocol/sdk": "1.26.0" },
		}),
		"dist/index.js": `console.log("RUNNING ${version}");\n`,
		"runtime/launcher-v1.mjs": readFileSync(join(PACKAGE, "runtime/launcher-v1.mjs"), "utf8"),
	};
}

function statement(digest: Buffer, workflow = WORKFLOW) {
	const sha512 = createHash("sha512").update(digest).digest("hex");
	return Buffer.from(
		JSON.stringify({
			subject: [{ name: `pkg:npm/%40pharaoh-so/mcp@${NEXT}`, digest: { sha512 } }],
			predicate: { buildDefinition: { externalParameters: { workflow } } },
		}),
	).toString("base64");
}

function manifest(name: string, version: string) {
	const file = name === "@pharaoh-so/mcp" ? `mcp-${version}.tgz` : `sdk-${version}.tgz`;
	const bytes = tarballs[name];
	// A foreign origin. npm 12 refuses it before downloading (EALLOWREMOTE); older npm installs
	// it and the lockfile check catches it. Either way the update reports off-registry.
	const host = fault === "off-registry" && name === "@pharaoh-so/mcp" ? offRegistry : registry;
	return {
		name,
		version,
		...(name === "@pharaoh-so/mcp"
			? { dependencies: { "@modelcontextprotocol/sdk": "1.26.0" } }
			: {}),
		dist: {
			tarball: `${host}${name}/-/${file}`,
			integrity: integrity(bytes),
			signatures: [{ keyid: "SHA256:test", sig: "MEUCIQ" }],
			attestations:
				name === "@pharaoh-so/mcp"
					? {
							url: `${registry}-/npm/v1/attestations/@pharaoh-so%2fmcp@${version}`,
							provenance: { predicateType: SLSA },
						}
					: undefined,
		},
	};
}

/**
 * What the registry answers for the current fault: url → JSON, or a tarball file. npm runs
 * synchronously (execFileSync), so the registry runs in its own process and reads this file
 * on every request.
 */
function setRoutes(): void {
	const mcp = manifest("@pharaoh-so/mcp", NEXT);
	const sdk = manifest("@modelcontextprotocol/sdk", "1.26.0");
	const packument = (m: typeof mcp) => ({
		name: m.name,
		"dist-tags": { latest: m.version },
		versions: { [m.version]: m },
	});
	const genuine = tarballs["@pharaoh-so/mcp"];
	const digest = fault === "digest" ? tarballs.tampered : genuine;
	const workflow =
		fault === "publisher"
			? { ...WORKFLOW, repository: "https://github.com/someone/fork" }
			: WORKFLOW;
	const file = (name: string) => ({ file: join(work, "packed", name) });
	writeFileSync(
		join(work, "routes.json"),
		JSON.stringify({
			"/@pharaoh-so%2fmcp": { json: packument(mcp) },
			"/@pharaoh-so%2fmcp/latest": { json: mcp },
			"/@modelcontextprotocol%2fsdk": { json: packument(sdk) },
			[`/@pharaoh-so/mcp/-/mcp-${NEXT}.tgz`]: file(
				fault === "tampered" ? "tampered.tgz" : "mcp.tgz",
			),
			"/@modelcontextprotocol/sdk/-/sdk-1.26.0.tgz": file("sdk.tgz"),
			[`/-/npm/v1/attestations/@pharaoh-so%2fmcp@${NEXT}`]: {
				json: {
					attestations: [
						{ predicateType: PUBLISH, bundle: { dsseEnvelope: { payload: statement(genuine) } } },
						{
							predicateType: SLSA,
							bundle: { dsseEnvelope: { payload: statement(digest, workflow) } },
						},
					],
				},
			},
			"/-/npm/v1/keys": { json: { keys: [{ keyid: "SHA256:test", key: "MFkw" }] } },
		}),
	);
}

const REGISTRY = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const serve = (req, res) => {
	let route;
	try { route = JSON.parse(readFileSync(process.argv[2], "utf8"))[req.url]; } catch {}
	if (!route) return res.writeHead(404).end("{}");
	if (route.file) return res.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(route.file));
	res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(route.json));
};
const registry = createServer(serve);
const mirror = createServer(serve);
registry.listen(0, "127.0.0.1", () =>
	mirror.listen(0, "127.0.0.1", () =>
		console.log(registry.address().port + " " + mirror.address().port),
	),
);`;

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), "pharaoh-update-"));
	tarballs = {
		"@modelcontextprotocol/sdk": pack(
			packageDir("@modelcontextprotocol/sdk", "1.26.0", {
				"client/index.js": "module.exports = {};\n",
			}),
		),
		"@pharaoh-so/mcp": pack(packageDir("@pharaoh-so/mcp", NEXT, mcpFiles(NEXT))),
		tampered: pack(
			packageDir("@pharaoh-so/mcp", "9.9.9", {
				...mcpFiles(NEXT),
				"dist/index.js": "console.log('EVIL');\n",
			}),
		),
	};
	for (const [name, bytes] of [
		["sdk.tgz", tarballs["@modelcontextprotocol/sdk"]],
		["mcp.tgz", tarballs["@pharaoh-so/mcp"]],
		["tampered.tgz", tarballs.tampered],
	] as const)
		writeFileSync(join(work, "packed", name), bytes);
	writeFileSync(join(work, "registry.mjs"), REGISTRY);
	server = spawn(process.execPath, [join(work, "registry.mjs"), join(work, "routes.json")]);
	const [port, mirrorPort] = await new Promise<string[]>((resolve) =>
		server.stdout?.once("data", (chunk) => resolve(String(chunk).trim().split(" "))),
	);
	registry = `http://127.0.0.1:${port}/`;
	offRegistry = `http://127.0.0.1:${mirrorPort}/`;
}, 60_000);

afterAll(() => {
	server?.kill();
	rmSync(work, { recursive: true, force: true });
});

let home: string;
let root: string;

/** A home with CURRENT installed behind the launcher, as 0.3.83's install leaves it. */
function installCurrent(): void {
	home = mkdtempSync(join(work, "home-"));
	root = join(home, ".pharaoh", "runtimes", "mcp");
	const pkg = join(root, CURRENT, "node_modules", "@pharaoh-so", "mcp");
	for (const [file, contents] of Object.entries(mcpFiles(CURRENT)))
		write(
			join(pkg, file),
			file === "package.json"
				? JSON.stringify({ name: "@pharaoh-so/mcp", version: CURRENT })
				: contents,
		);
	write(
		join(root, CURRENT, ".pharaoh-runtime.json"),
		JSON.stringify({ package: "@pharaoh-so/mcp", version: CURRENT }),
	);
	cpSync(join(PACKAGE, "runtime/launcher-v1.mjs"), join(root, "launcher-v1.mjs"));
	write(join(root, "current.json"), JSON.stringify({ version: CURRENT }));
}

/** Run the launcher as a client would at session start; returns what it printed. */
function launch(...args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(root, "launcher-v1.mjs"), ...args], {
			env: { HOME: home },
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", reject);
		child.on("close", () => resolve(out.trim()));
	});
}

function options(overrides: Partial<UpdateOptions> = {}): UpdateOptions {
	return {
		home,
		registry,
		verifyBundle: async () => {},
		runtime: {
			home,
			env: { PATH: process.env.PATH, HOME: home },
			runAsync: async () => ({ code: 0, stdout: '{"invalid":[],"missing":[]}' }),
		},
		...overrides,
	};
}

const log = () =>
	readFileSync(join(root, "update.log"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

beforeEach(() => {
	fault = "none";
	setRoutes();
	installCurrent();
});

/** Breaks when: a verified release isn't staged, staging changes what runs now, a hook activates, or the next start doesn't run it. */
it("stages a verified release for the next start, and the launcher runs it then", async () => {
	const seen: Array<Record<string, unknown>> = [];
	const result = await runUpdate(
		"terminal",
		options({ verifyBundle: async (_b, o) => void seen.push(o) }),
	);
	expect(result).toEqual({ status: "staged", version: NEXT, from: CURRENT });
	// npm's signature is checked with its key; the provenance against Pharaoh's workflow identity.
	expect(seen.map((o) => [typeof o.keySelector, o.certificateIdentityURI])).toEqual([
		["function", undefined],
		["undefined", PUBLISHER],
	]);
	expect(JSON.parse(readFileSync(join(root, "current.json"), "utf8")).version).toBe(CURRENT);
	expect(
		JSON.parse(readFileSync(join(root, NEXT, ".pharaoh-verified.json"), "utf8")),
	).toMatchObject({
		version: NEXT,
		integrity: integrity(tarballs["@pharaoh-so/mcp"]),
		publisher: PUBLISHER,
		source: "terminal",
	});
	// A session-start hook runs what is current and never activates.
	await launch("hook", "local-worktree", "claude-code");
	expect(existsSync(join(root, "pending.json"))).toBe(true);
	expect(await launch()).toBe(`RUNNING ${NEXT}`);
	expect(JSON.parse(readFileSync(join(root, "current.json"), "utf8"))).toMatchObject({
		version: NEXT,
		previous: CURRENT,
	});
	expect(existsSync(join(root, "pending.json"))).toBe(false);
	expect(log().map((entry) => entry.event)).toEqual(["staged", "activated"]);
	expect(await runUpdate("tool", options())).toEqual({ status: "current", version: NEXT });
}, 60_000);

/** Breaks when: a version directory that is damaged, or that install made without a receipt,
 * blocks every later update to that version, as it did before the review's fix. */
it("restages a version whose directory was damaged or never verified", async () => {
	expect(await runUpdate("terminal", options())).toMatchObject({ status: "staged", version: NEXT });
	rmSync(join(root, NEXT, "node_modules", "@pharaoh-so", "mcp", "dist", "index.js"));
	// The launcher discards the unusable staged version and keeps running the current one.
	expect(await launch()).toBe(`RUNNING ${CURRENT}`);
	expect(await runUpdate("terminal", options())).toMatchObject({ status: "staged", version: NEXT });
	rmSync(join(root, NEXT, ".pharaoh-verified.json"));
	rmSync(join(root, "pending.json"));
	expect(await runUpdate("terminal", options())).toMatchObject({ status: "staged", version: NEXT });
	expect(await launch()).toBe(`RUNNING ${NEXT}`);
	expect(readdirSync(root).filter((name) => name.startsWith(".invalid-"))).toEqual([]);
}, 60_000);

/** Breaks when: any failed check stages, publishes or activates anything, or leaves no receipt. */
it.each([
	["tampered", "a tampered tarball", "install-failed", {}],
	["off-registry", "a tarball off the registry", "off-registry", {}],
	["digest", "provenance for other bytes", "digest-mismatch", {}],
	["publisher", "provenance from another workflow", "wrong-publisher", {}],
	[
		"none",
		"a bad registry signature",
		"bad-signature",
		{
			verifyBundle: async (_b: unknown, o: Record<string, unknown>) => {
				if (o.keySelector) throw new Error("SIGNATURE_ERROR");
			},
		},
	],
	[
		"none",
		"a provenance signature that doesn't verify",
		"bad-provenance",
		{
			verifyBundle: async (_b: unknown, o: Record<string, unknown>) => {
				if (o.certificateIdentityURI) throw new Error("SIGNATURE_ERROR");
			},
		},
	],
	[
		"none",
		"Sigstore unreachable (fail closed)",
		"sigstore-unreachable",
		{
			verifyBundle: async () => {
				throw Object.assign(new Error("fetch failed"), { code: "TUF_REFRESH_METADATA_ERROR" });
			},
		},
	],
	["none", "a dependency with an invalid signature", "bad-signature", { runtime: undefined }],
] as const)(
	"leaves the current version active after %s (%s)",
	async (which, _label, reason, overrides) => {
		fault = which;
		setRoutes();
		const before = readFileSync(join(root, "current.json"));
		const base = options();
		const result = await runUpdate("tool", {
			...base,
			...overrides,
			runtime:
				"runtime" in overrides
					? {
							...base.runtime,
							runAsync: async () => ({
								code: 1,
								stdout: '{"invalid":[{"name":"x"}],"missing":[]}',
							}),
						}
					: base.runtime,
			verifyBundle: "verifyBundle" in overrides ? overrides.verifyBundle : base.verifyBundle,
		});
		expect(result).toMatchObject({ status: "rejected", reason, version: NEXT });
		expect(readFileSync(join(root, "current.json"))).toEqual(before);
		expect(existsSync(join(root, "pending.json"))).toBe(false);
		expect(readdirSync(root).filter((name) => /^\d|^\.stage-/.test(name))).toEqual([CURRENT]);
		expect(log()).toEqual([
			expect.objectContaining({ event: "rejected", reason, version: NEXT, source: "tool" }),
		]);
		expect(await launch()).toBe(`RUNNING ${CURRENT}`);
	},
	60_000,
);

/** The Fulcio certificate that signed 0.3.82's provenance (public, from npm's attestations). */
const FULCIO_0_3_82 =
	"MIIHMTCCBrigAwIBAgIUP+Len5HICN0qUFmsJexHp2EvUU8wCgYIKoZIzj0EAwMwNzEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MR4wHAYDVQQDExVzaWdzdG9yZS1pbnRlcm1lZGlhdGUwHhcNMjYxMTEyMDczMzIxWhcNMjYxMTEyMDc0MzIxWjAAMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqm+pCa55+xxHlPsSiLI7lif7HmouAk3fCNfOsVjR8VMepGGXUAaiXnzbSEu7YvVezX+kx8UgHl3F0AU/5ZgLeaOCBdcwggXTMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAzAfBgNVHSMEGDAWgBTf0+nPViQRlvmo2OkoVaLGLhhkPzBvBgNVHREBAf8EZTBjhmFodHRwczovL2dpdGh1Yi5jb20vUGhhcmFvaC1zby9waGFyYW9oLW1jcC8uZ2l0aHViL3dvcmtmbG93cy9wdWJsaXNoLW1jcC1wcm94eS55bWxAcmVmcy9oZWFkcy9tYWluMDkGCisGAQQBg78wAQEEK2h0dHBzOi8vdG9rZW4uYWN0aW9ucy5naXRodWJ1c2VyY29udGVudC5jb20wEgYKKwYBBAGDvzABAgQEcHVzaDA2BgorBgEEAYO/MAEDBCg3NmY5MmRjMWExZmViODQzOTg3ZjczNmY5OTI2NjZhYjJkYzNjYWIxMB8GCisGAQQBg78wAQQEEVB1Ymxpc2ggTUNQIHByb3h5MCQGCisGAQQBg78wAQUEFlBoYXJhb2gtc28vcGhhcmFvaC1tY3AwHQYKKwYBBAGDvzABBgQPcmVmcy9oZWFkcy9tYWluMDsGCisGAQQBg78wAQgELQwraHR0cHM6Ly90b2tlbi5hY3Rpb25zLmdpdGh1YnVzZXJjb250ZW50LmNvbTBxBgorBgEEAYO/MAEJBGMMYWh0dHBzOi8vZ2l0aHViLmNvbS9QaGFyYW9oLXNvL3BoYXJhb2gtbWNwLy5naXRodWIvd29ya2Zsb3dzL3B1Ymxpc2gtbWNwLXByb3h5LnltbEByZWZzL2hlYWRzL21haW4wOAYKKwYBBAGDvzABCgQqDCg3NmY5MmRjMWExZmViODQzOTg3ZjczNmY5OTI2NjZhYjJkYzNjYWIxMB0GCisGAQQBg78wAQsEDwwNZ2l0aHViLWhvc3RlZDA5BgorBgEEAYO/MAEMBCsMKWh0dHBzOi8vZ2l0aHViLmNvbS9QaGFyYW9oLXNvL3BoYXJhb2gtbWNwMDgGCisGAQQBg78wAQ0EKgwoNzZmOTJkYzFhMWZlYjg0Mzk4N2Y3MzZmOTkyNjY2YWIyZGMzY2FiMTAfBgorBgEEAYO/MAEOBBEMD3JlZnMvaGVhZHMvbWFpbjAaBgorBgEEAYO/MAEPBAwMCjExNzQwNzA4MzYwLQYKKwYBBAGDvzABEAQfDB1odHRwczovL2dpdGh1Yi5jb20vUGhhcmFvaC1zbzAZBgorBgEEAYO/MAERBAsMCTI2NTY5Mzc4ODBxBgorBgEEAYO/MAESBGMMYWh0dHBzOi8vZ2l0aHViLmNvbS9QaGFyYW9oLXNvL3BoYXJhb2gtbWNwLy5naXRodWIvd29ya2Zsb3dzL3B1Ymxpc2gtbWNwLXByb3h5LnltbEByZWZzL2hlYWRzL21haW4wOAYKKwYBBAGDvzABEwQqDCg3NmY5MmRjMWExZmViODQzOTg3ZjczNmY5OTI2NjZhYjJkYzNjYWIxMBQGCisGAQQBg78wARQEBgwEcHVzaDBdBgorBgEEAYO/MAEVBE8MTWh0dHBzOi8vZ2l0aHViLmNvbS9QaGFyYW9oLXNvL3BoYXJhb2gtbWNwL2FjdGlvbnMvcnVucy80MzE3NTk0MjUxNy9hdHRlbXB0cy8xMBYGCisGAQQBg78wARYECAwGcHVibGljMBsGCisGAQQBg78wARcEDQwLbnBtLXB1Ymxpc2gwQwYKKwYBBAGDvzABGAQ1DDNyZXBvOlBoYXJhb2gtc28vcGhhcmFvaC1tY3A6ZW52aXJvbm1lbnQ6bnBtLXB1Ymxpc2gwgYsGCisGAQQB1nkCBAIEfQR7AHkAdwDdPTBqxscRMmMZHhyZZzcCokpeuN48rf+HinKALynujgAAAaHOrOzAAAAEAwBIMEYCIQD0zaVhAonZvnQc9/pVST2HM4JdRYss9Zc4btZzNbgdWQIhALo9hznhjDB3ipDQb1t4H9bqcQeYvdRIkR2Ftn+kneFWMAoGCCqGSM49BAMDA2cAMGQCMH/pV+o8Oh/QoKNi+C/t5QB1oL97TZAgumSMK/DOgc6Ic5y0F36ngNWOFL6q0pjw7gIwEZmmrPYHhZeSPdjXooglkzx8zLaxtjqW/xR3cuH11INKQxKk0zOt0EpT874NHud4";

/** Breaks when: Sigstore's unanchored identity pattern decides alone, so a branch named main-x or a
 * workflow path that differs by one character would pass for Pharaoh's publisher. */
it("accepts only the exact publisher identity on a provenance certificate", async () => {
	const bundle = { verificationMaterial: { certificate: { rawBytes: FULCIO_0_3_82 } } };
	// Refused before any network call: the certificate names main, not this prefix or this variant.
	for (const identity of [
		PUBLISHER.slice(0, -1),
		`${PUBLISHER}-x`,
		PUBLISHER.replace(".yml", "Xyml"),
	])
		await expect(
			verifySigstoreBundle(bundle, { certificateIdentityURI: identity }),
		).rejects.toThrow("signed for another identity");
});

it("refuses on Windows, on an install without the launcher, and on a Node too old for Sigstore", async () => {
	expect(await runUpdate("tool", options({ platform: "win32" }))).toMatchObject({
		status: "refused",
		reason: "windows",
	});
	expect(await runUpdate("tool", options({ nodeVersion: "v18.16.0" }))).toMatchObject({
		status: "refused",
		reason: "node",
	});
	rmSync(join(root, "current.json"));
	expect(await runUpdate("tool", options())).toMatchObject({
		status: "refused",
		reason: "no-launcher",
	});
});

describe("the launcher", () => {
	/** A version directory as the updater publishes it, with its receipt. */
	function publish(version: string): string {
		const pkg = join(root, version, "node_modules", "@pharaoh-so", "mcp");
		write(join(pkg, "package.json"), JSON.stringify({ name: "@pharaoh-so/mcp", version }));
		write(join(pkg, "dist", "index.js"), `console.log("RUNNING ${version}");\n`);
		write(
			join(root, version, ".pharaoh-runtime.json"),
			JSON.stringify({ package: "@pharaoh-so/mcp", version }),
		);
		const receipt = JSON.stringify({ version });
		write(join(root, version, ".pharaoh-verified.json"), receipt);
		return createHash("sha256").update(receipt).digest("hex");
	}

	/** Breaks when: concurrent session starts activate twice, or one of them runs a half-applied state. */
	it("applies a staged update once across concurrent starts", async () => {
		write(
			join(root, "pending.json"),
			JSON.stringify({ version: NEXT, receiptDigest: publish(NEXT) }),
		);
		const runs = await Promise.all(Array.from({ length: 5 }, () => launch()));
		// A start that found the lock busy runs current; every start after the switch runs NEXT.
		expect(runs.every((out) => out === `RUNNING ${NEXT}` || out === `RUNNING ${CURRENT}`)).toBe(
			true,
		);
		expect(await launch()).toBe(`RUNNING ${NEXT}`);
		expect(log().filter((entry) => entry.event === "activated")).toHaveLength(1);
	});

	/** Breaks when: a directory swapped in after staging, or an older staged version, becomes current. */
	it("discards a staged version whose receipt changed, or that is no newer", async () => {
		publish(NEXT);
		write(
			join(root, "pending.json"),
			JSON.stringify({ version: NEXT, receiptDigest: "0".repeat(64) }),
		);
		expect(await activatePending(root)).toBeNull();
		write(
			join(root, "pending.json"),
			JSON.stringify({ version: "0.3.80", receiptDigest: publish("0.3.80") }),
		);
		expect(await activatePending(root)).toBeNull();
		expect(log().map((entry) => entry.reason)).toEqual(["receipt-mismatch", "not-newer"]);
		expect(await launch()).toBe(`RUNNING ${CURRENT}`);
	});

	/** Breaks when: a hook started by the launcher can't name the launch registrations use, so its
	 * saved-worktree grants would never match the proxy's. */
	it("tells a hook which launcher started it", async () => {
		write(
			join(
				root,
				CURRENT,
				"node_modules",
				"@pharaoh-so",
				"mcp",
				"runtime",
				"local-worktree-hook.mjs",
			),
			'console.log(JSON.stringify(globalThis[Symbol.for("pharaoh.launcher")]));\n',
		);
		const real = realpathSync(root);
		expect(JSON.parse(await launch("hook", "local-worktree", "codex"))).toEqual({
			path: join(real, "launcher-v1.mjs"),
			root: real,
			version: CURRENT,
		});
	});

	/** Breaks when: an unusable current version stops Pharaoh starting although the previous one is there (fix 3). */
	it("runs the previous version when the current one's directory is gone", async () => {
		publish(NEXT);
		write(join(root, "current.json"), JSON.stringify({ version: NEXT, previous: CURRENT }));
		rmSync(join(root, NEXT), { recursive: true });
		expect(selectVersion(root, { log: false })).toMatchObject({ version: CURRENT });
		expect(await launch()).toBe(`RUNNING ${CURRENT}`);
		expect(log()).toEqual([
			expect.objectContaining({ event: "fallback", version: CURRENT, from: NEXT }),
		]);
	});
});
