/** Build the immutable release handoff and verify registry integrity and npm-verified provenance. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
	appendFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE = "@pharaoh-so/mcp";
export const REPOSITORY = "Pharaoh-so/pharaoh-mcp";
export const PACKAGE_REPOSITORY = `git+https://github.com/${REPOSITORY}.git`;
export const WORKFLOW = ".github/workflows/publish-mcp-proxy.yml";
const REGISTRY = "https://registry.npmjs.org";
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
export const hash = (bytes, algorithm = "sha256") =>
	createHash(algorithm).update(bytes).digest("hex");
const run = (command, args, cwd = process.cwd()) =>
	execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const npm = (args, cwd) => run("npm", [...args, "--registry", REGISTRY], cwd);
const output = (name, value) => {
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};
const safePath = (path) =>
	typeof path === "string" &&
	/^[A-Za-z0-9_./-]+$/.test(path) &&
	!path.startsWith("/") &&
	path.split("/").every((part) => part !== "." && part !== ".." && part !== "");

/** Validate the private export record against the exact public working-tree files. */
export function verifySource(root) {
	const source = json(join(root, "pharaoh-source.json"));
	assert.equal(source.version, 1);
	assert.equal(source.repository, "Pharaoh-so/pharaoh");
	assert.match(source.commit, SHA);
	assert.match(source.payloadSha256, SHA256);
	assert.ok(Array.isArray(source.files) && source.files.length > 0);
	let previous = "";
	let payload = "";
	for (const file of source.files) {
		assert.ok(
			safePath(file.path) && file.path > previous,
			"Source paths must be safe, unique and sorted",
		);
		assert.match(file.sha256, SHA256);
		assert.ok(["100644", "100755"].includes(file.mode));
		let current = root;
		for (const part of file.path.split("/")) {
			current = join(current, part);
			assert.ok(!lstatSync(current).isSymbolicLink(), `Source link rejected: ${file.path}`);
		}
		assert.ok(lstatSync(current).isFile());
		assert.equal(hash(readFileSync(current)), file.sha256, `Source hash mismatch: ${file.path}`);
		assert.equal(
			(lstatSync(current).mode & 0o111) !== 0,
			file.mode === "100755",
			`Source mode mismatch: ${file.path}`,
		);
		payload += `${file.path}\0${file.sha256}\0${file.mode}\n`;
		previous = file.path;
	}
	assert.equal(hash(payload), source.payloadSha256, "Source aggregate mismatch");
	return source;
}

/** Only public runtime assets can enter npm; source, tests and release machinery stay out. */
export function verifyPackPaths(paths) {
	assert.ok(paths.length > 0 && paths.length < 300);
	assert.equal(new Set(paths).size, paths.length, "Duplicate archive entries");
	for (const path of paths) {
		assert.ok(safePath(path), `Unsafe archive path: ${path}`);
		assert.ok(
			/^(?:package\.json|README\.md|LICENSE|CHANGELOG\.md|\.mcp\.json|inspect-tools\.json|trace-app\.html|\.claude-plugin\/plugin\.json|dist\/[a-z][a-z0-9-]*\.(?:js|d\.ts)(?:\.map)?|skills\/(?:\.gitkeep|[a-z-]+\/SKILL\.md)|commands\/(?:plan|review|sessions)\.md|hooks\/(?:hooks\.json|route-grep\.mjs))$/.test(
				path,
			),
			`Unexpected npm file: ${path}`,
		);
	}
	for (const required of [
		"package.json",
		"dist/index.js",
		"dist/index.d.ts",
		"inspect-tools.json",
		"trace-app.html",
		"LICENSE",
	])
		assert.ok(paths.includes(required), `Missing npm asset: ${required}`);
}

/** npm 12 keys pack JSON by package name; older npm versions returned an array. */
export function readPackResult(value, version) {
	if (!Array.isArray(value)) assert.deepEqual(Object.keys(value), [PACKAGE]);
	const results = Array.isArray(value) ? value : Object.values(value);
	assert.equal(results.length, 1, "Exactly one package must be packed");
	const packed = results[0];
	assert.equal(packed.name, PACKAGE);
	assert.equal(packed.version, version);
	assert.equal(packed.filename, `pharaoh-so-mcp-${version}.tgz`);
	return packed;
}

/** Only a main version change, first package commit or deliberate main retry requests publication. */
export function shouldPublish(root, { eventName, ref, before }) {
	if (ref !== "refs/heads/main") return false;
	if (eventName === "workflow_dispatch") return true;
	if (eventName !== "push") return false;
	assert.match(before, SHA, "Push must name its immutable prior commit");
	const current = json(join(root, "package.json"));
	assert.equal(current.name, PACKAGE);
	assert.match(current.version, VERSION);
	if (before === "0".repeat(40)) return true;
	const git = (args) => run("git", ["--no-replace-objects", ...args], root).trim();
	assert.equal(git(["cat-file", "-t", before]), "commit");
	const entry = git(["ls-tree", before, "--", "package.json"]);
	if (!entry) return true;
	assert.match(entry, /^100(?:644|755) blob [a-f0-9]{40}\tpackage\.json$/);
	const previous = JSON.parse(git(["show", `${before}:package.json`]));
	assert.equal(previous.name, PACKAGE);
	assert.match(previous.version, VERSION);
	return previous.version !== current.version;
}

/** Reject altered, unexpected or identity-mismatched immutable release artifacts. */
export function validateArtifact(directory, expectedCommit, expectedManifestHash) {
	assert.match(expectedCommit, SHA);
	assert.match(expectedManifestHash, SHA256);
	const manifestBytes = readFileSync(join(directory, "release-manifest.json"));
	assert.equal(hash(manifestBytes), expectedManifestHash, "Release manifest hash mismatch");
	const manifest = JSON.parse(manifestBytes);
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.publicRepository, REPOSITORY);
	assert.equal(manifest.publicCommit, expectedCommit);
	assert.equal(manifest.sourceRepository, "Pharaoh-so/pharaoh");
	assert.match(manifest.sourceCommit, SHA);
	assert.match(manifest.sourcePayloadSha256, SHA256);
	assert.equal(manifest.packageName, PACKAGE);
	assert.match(manifest.version, VERSION);
	assert.equal(manifest.packageRepository, PACKAGE_REPOSITORY);
	assert.equal(manifest.tarballFile, `pharaoh-so-mcp-${manifest.version}.tgz`);
	assert.deepEqual(
		readdirSync(directory).sort(),
		[manifest.tarballFile, "release-manifest.json"].sort(),
	);
	const tarball = join(directory, manifest.tarballFile);
	assert.ok(lstatSync(tarball).isFile() && !lstatSync(tarball).isSymbolicLink());
	const bytes = readFileSync(tarball);
	assert.equal(hash(bytes), manifest.tarballSha256, "Tarball SHA-256 mismatch");
	assert.equal(
		`sha512-${createHash("sha512").update(bytes).digest("base64")}`,
		manifest.integrity,
		"Tarball integrity mismatch",
	);
	const names = run("tar", ["-tzf", tarball]).trim().split("\n");
	assert.ok(names.every((name) => name.startsWith("package/")));
	verifyPackPaths(names.map((name) => name.slice(8)));
	assert.ok(
		run("tar", ["-tvzf", tarball])
			.trim()
			.split("\n")
			.every((line) => line.startsWith("-")),
		"Archive links and special files are forbidden",
	);
	const pkg = JSON.parse(run("tar", ["-xOzf", tarball, "package/package.json"]));
	assert.equal(pkg.name, PACKAGE);
	assert.equal(pkg.version, manifest.version);
	assert.equal(pkg.repository?.url, PACKAGE_REPOSITORY);
	assert.equal(pkg.repository?.directory, undefined);
	return manifest;
}

/** Compare stable release numbers without loading package code or project dependencies. */
export function compareVersions(a, b) {
	assert.match(a, VERSION);
	assert.match(b, VERSION);
	const left = a.split(".").map(BigInt);
	const right = b.split(".").map(BigInt);
	for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
	return 0;
}

/** Retrying an older tag job must never move GitHub's Latest release backward. */
export function githubLatestOption(registryLatest, githubLatestTag, version) {
	if (registryLatest !== version) return "false";
	if (!githubLatestTag) return "true";
	const match = /^(?:mcp-proxy-v|v)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(
		githubLatestTag,
	);
	return match && compareVersions(match[1], version) <= 0 ? "true" : "false";
}

/** A rerun can resume only an identical version; an older run cannot publish over newer releases. */
export function releaseDecision(packument, manifest) {
	assert.equal(packument.name, PACKAGE);
	const existing = packument.versions?.[manifest.version];
	if (existing) {
		assert.equal(existing.name, PACKAGE);
		assert.equal(existing.version, manifest.version);
		assert.equal(existing.repository?.url, PACKAGE_REPOSITORY);
		assert.equal(
			existing.dist?.integrity,
			manifest.integrity,
			"Existing version contains different bytes",
		);
		// Verifying/tagging a matching version never changes npm's dist-tags,
		// so even an old interrupted run can finish after a newer publication.
		return "resume";
	}
	for (const version of [
		...Object.keys(packument.versions ?? {}),
		packument["dist-tags"]?.latest,
	].filter(Boolean)) {
		if (VERSION.test(version))
			assert.ok(
				compareVersions(version, manifest.version) <= 0,
				`Refusing older release ${manifest.version}; registry already has ${version}`,
			);
	}
	return "publish";
}

// Minimal DER reader for certificate extensions. npm verifies signatures and the
// Sigstore trust chain; these authenticated OIDs bind that proof to our source.
function der(buffer, start = 0, end = buffer.length) {
	const items = [];
	for (let offset = start; offset < end; ) {
		const tag = buffer[offset++];
		let length = buffer[offset++];
		if (length & 0x80) {
			const count = length & 0x7f;
			assert.ok(count > 0 && count <= 4 && offset + count <= end, "Invalid DER length");
			length = 0;
			for (let i = 0; i < count; i++) length = length * 256 + buffer[offset++];
		}
		assert.ok(Number.isInteger(length) && offset + length <= end, "Invalid DER value");
		items.push({ tag, value: buffer.subarray(offset, offset + length) });
		offset += length;
	}
	return items;
}

/** Read Fulcio's authenticated source identity claims from a verified certificate. */
export function certificateClaims(bytes) {
	const cert = new X509Certificate(bytes);
	const claims = {};
	const visit = (items) => {
		for (const item of items) {
			if (item.tag === 0x30) {
				const fields = der(item.value);
				if (fields[0]?.tag === 0x06 && fields.at(-1)?.tag === 0x04) {
					const prefix = Buffer.from("2b0601040183bf3001", "hex");
					const oid = fields[0].value;
					if (oid.length === prefix.length + 1 && oid.subarray(0, -1).equals(prefix)) {
						const id = oid.at(-1);
						const value = fields.at(-1).value;
						claims[id] = id >= 8 ? der(value)[0]?.value.toString("utf8") : value.toString("utf8");
					}
				}
			}
			if (item.tag & 0x20) visit(der(item.value));
		}
	};
	visit(der(cert.raw));
	return { san: cert.subjectAltName, claims };
}

/** Require exact provenance identity from npm's successful cryptographic verification output. */
export function verifyProvenance(report, manifest, readClaims = certificateClaims) {
	assert.deepEqual(report.invalid, []);
	assert.deepEqual(report.missing, []);
	const entry = report.verified?.find(
		(item) =>
			item.name === PACKAGE &&
			item.version === manifest.version &&
			new URL(item.registry).href === `${REGISTRY}/`,
	);
	assert.ok(entry, "npm did not cryptographically verify package attestations");
	const expectedWorkflow = `https://github.com/${REPOSITORY}/${WORKFLOW}@refs/heads/main`;
	const bundle = entry.attestationBundles?.find(
		(item) => item.predicateType === "https://slsa.dev/provenance/v1",
	)?.bundle;
	assert.ok(bundle, "Verified SLSA provenance is missing");
	const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64"));
	assert.equal(statement.subject?.length, 1);
	assert.equal(statement.subject[0].name, `pkg:npm/%40pharaoh-so/mcp@${manifest.version}`);
	assert.equal(
		statement.subject[0].digest?.sha512,
		Buffer.from(manifest.integrity.slice(7), "base64").toString("hex"),
	);
	assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1");
	const definition = statement.predicate?.buildDefinition;
	assert.deepEqual(definition?.externalParameters?.workflow, {
		ref: "refs/heads/main",
		repository: `https://github.com/${REPOSITORY}`,
		path: WORKFLOW,
	});
	assert.ok(
		definition.resolvedDependencies?.some(
			(item) =>
				item.uri === `git+https://github.com/${REPOSITORY}@refs/heads/main` &&
				item.digest?.gitCommit === manifest.publicCommit,
		),
	);
	const raw =
		bundle.verificationMaterial?.certificate?.rawBytes ??
		bundle.verificationMaterial?.x509CertificateChain?.certificates?.[0]?.rawBytes;
	assert.ok(raw, "Provenance signing certificate is missing");
	const { san, claims } = readClaims(Buffer.from(raw, "base64"));
	assert.equal(san, `URI:${expectedWorkflow}`);
	assert.equal(claims[8] ?? claims[1], "https://token.actions.githubusercontent.com");
	assert.equal(claims[12] ?? `https://github.com/${claims[5]}`, `https://github.com/${REPOSITORY}`);
	assert.equal(claims[13] ?? claims[3], manifest.publicCommit);
	assert.equal(claims[14] ?? claims[6], "refs/heads/main");
	if (claims[9]) assert.equal(claims[9], expectedWorkflow);
	return statement;
}

export async function registryPackument() {
	const response = await fetch(`${REGISTRY}/@pharaoh-so%2fmcp`, {
		signal: AbortSignal.timeout(30_000),
		cache: "no-store",
	});
	if (response.status === 404) return { name: PACKAGE, versions: {}, "dist-tags": {} };
	assert.ok(response.ok, `Registry lookup failed: ${response.status}`);
	return response.json();
}

/** Check registry bytes, then use npm's supported verifier without installing or executing package code. */
async function verifyRegistry(manifest) {
	const packument = await registryPackument();
	assert.equal(
		releaseDecision(packument, manifest),
		"resume",
		`${PACKAGE}@${manifest.version} is not yet visible in npm; publication may still be processing.`,
	);
	const dist = packument.versions[manifest.version].dist;
	const url = new URL(dist.tarball);
	assert.equal(url.origin, REGISTRY);
	assert.equal(url.pathname, `/@pharaoh-so/mcp/-/mcp-${manifest.version}.tgz`);
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	assert.ok(response.ok, "Registry tarball unavailable");
	const bytes = Buffer.from(await response.arrayBuffer());
	assert.equal(hash(bytes), manifest.tarballSha256, "Registry tarball SHA-256 mismatch");
	assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, manifest.integrity);
	const directory = mkdtempSync(join(tmpdir(), "pharaoh-npm-verify-"));
	try {
		const dependency = `node_modules/${PACKAGE}`;
		mkdirSync(join(directory, dependency), { recursive: true });
		writeFileSync(
			join(directory, "package.json"),
			JSON.stringify({
				name: "release-verification",
				private: true,
				dependencies: { [PACKAGE]: manifest.version },
			}),
		);
		writeFileSync(
			join(directory, dependency, "package.json"),
			JSON.stringify({ name: PACKAGE, version: manifest.version }),
		);
		writeFileSync(
			join(directory, "package-lock.json"),
			JSON.stringify({
				name: "release-verification",
				lockfileVersion: 3,
				requires: true,
				packages: {
					"": { name: "release-verification", dependencies: { [PACKAGE]: manifest.version } },
					[dependency]: {
						version: manifest.version,
						resolved: dist.tarball,
						integrity: manifest.integrity,
					},
				},
			}),
		);
		const report = JSON.parse(
			npm(
				["audit", "signatures", "--json", "--include-attestations", "--ignore-scripts"],
				directory,
			),
		);
		verifyProvenance(report, manifest);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Allow npm's asynchronous processing up to 72 complete verification attempts, five seconds apart. */
export async function retryRegistryVerification(
	verify,
	wait = (ms) => new Promise((done) => setTimeout(done, ms)),
) {
	for (let attempt = 0; attempt < 72; attempt++) {
		try {
			return await verify();
		} catch (error) {
			if (attempt === 71) throw error;
			await wait(5_000);
		}
	}
}

async function main() {
	const [command, directory = "release", expectedCommit = process.env.GITHUB_SHA, expectedHash] =
		process.argv.slice(2);
	if (command === "intent") {
		const eventName = process.env.GITHUB_EVENT_NAME;
		const publish = shouldPublish(process.cwd(), {
			eventName,
			ref: process.env.GITHUB_REF,
			before: eventName === "push" ? json(process.env.GITHUB_EVENT_PATH).before : undefined,
		});
		output("should-publish", String(publish));
		console.log(`Release intent: ${publish}`);
	} else if (command === "prepare") {
		const source = verifySource(process.cwd());
		const pkg = json("package.json");
		assert.equal(pkg.name, PACKAGE);
		assert.equal(pkg.repository?.url, PACKAGE_REPOSITORY);
		assert.match(pkg.version, VERSION);
		const publicCommit = process.env.GITHUB_SHA ?? run("git", ["rev-parse", "HEAD"]).trim();
		assert.match(publicCommit, SHA);
		mkdirSync(directory, { recursive: true });
		assert.deepEqual(readdirSync(directory), [], "Release directory must start empty");
		const packed = readPackResult(
			JSON.parse(
				npm(["pack", "--ignore-scripts", "--json", "--pack-destination", resolve(directory)]),
			),
			pkg.version,
		);
		verifyPackPaths(packed.files.map((file) => file.path));
		const bytes = readFileSync(join(directory, packed.filename));
		const manifest = {
			schemaVersion: 1,
			sourceRepository: source.repository,
			sourceCommit: source.commit,
			sourcePayloadSha256: source.payloadSha256,
			publicRepository: REPOSITORY,
			publicCommit,
			packageName: PACKAGE,
			version: pkg.version,
			packageRepository: PACKAGE_REPOSITORY,
			tarballFile: packed.filename,
			tarballSha256: hash(bytes),
			integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
		};
		const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
		writeFileSync(join(directory, "release-manifest.json"), manifestBytes);
		validateArtifact(directory, publicCommit, hash(manifestBytes));
		output("manifest-sha256", hash(manifestBytes));
		output("version", manifest.version);
		output("source-commit", source.commit);
		console.log(JSON.stringify(manifest, null, 2));
	} else if (["validate", "publish", "verify"].includes(command)) {
		const manifest = validateArtifact(directory, expectedCommit, expectedHash);
		if (command === "publish") {
			assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
			assert.equal(process.env.GITHUB_REF, "refs/heads/main");
			assert.ok(["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME));
			assert.equal(run("git", ["rev-parse", "HEAD"]).trim(), expectedCommit);
			if (releaseDecision(await registryPackument(), manifest) === "publish") {
				npm([
					"publish",
					resolve(directory, manifest.tarballFile),
					"--access",
					"public",
					"--tag",
					"latest",
					"--ignore-scripts",
					"--provenance",
				]);
			}
		}
		if (command !== "validate") {
			// npm can process an accepted publication for several minutes. Every retry
			// repeats integrity, signature, certificate identity and source checks.
			await retryRegistryVerification(() => verifyRegistry(manifest));
		}
		output("version", manifest.version);
		output("public-commit", manifest.publicCommit);
		console.log(`${command}: ${PACKAGE}@${manifest.version} (${manifest.publicCommit})`);
	} else
		throw new Error(
			"Usage: node scripts/release.mjs intent|prepare|validate|publish|verify [artifact-directory] [public-commit] [manifest-sha256]",
		);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
