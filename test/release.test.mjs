/** Adversarial release handoff, rollback and verified provenance identity regressions. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	certificateClaims,
	githubLatestOption,
	hash,
	PACKAGE,
	PACKAGE_REPOSITORY,
	REPOSITORY,
	readPackResult,
	releaseDecision,
	retryRegistryVerification,
	shouldPublish,
	validateArtifact,
	verifyPackPaths,
	verifyProvenance,
	verifySource,
	WORKFLOW,
} from "../scripts/release.mjs";

const commit = "a".repeat(40);
const sourceCommit = "b".repeat(40);
const version = "0.3.48";
const paths = [
	"package.json",
	"dist/index.js",
	"dist/index.d.ts",
	"inspect-tools.json",
	"trace-app.html",
	"LICENSE",
];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pharaoh-release-test-"));
	const directory = join(root, "release");
	mkdirSync(directory);
	for (const path of paths) {
		mkdirSync(dirname(join(root, "package", path)), { recursive: true });
		writeFileSync(
			join(root, "package", path),
			path === "package.json"
				? JSON.stringify({
						name: PACKAGE,
						version,
						repository: { type: "git", url: PACKAGE_REPOSITORY },
					})
				: `public ${path}`,
		);
	}
	const tarballFile = `pharaoh-so-mcp-${version}.tgz`;
	execFileSync(
		"tar",
		["-czf", join(directory, tarballFile), ...paths.map((path) => `package/${path}`)],
		{ cwd: root },
	);
	const bytes = readFileSync(join(directory, tarballFile));
	const manifest = {
		schemaVersion: 1,
		sourceRepository: "Pharaoh-so/pharaoh",
		sourceCommit,
		sourcePayloadSha256: "c".repeat(64),
		publicRepository: REPOSITORY,
		publicCommit: commit,
		packageName: PACKAGE,
		version,
		packageRepository: PACKAGE_REPOSITORY,
		tarballFile,
		tarballSha256: hash(bytes),
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
	};
	const save = () => {
		const text = `${JSON.stringify(manifest)}\n`;
		writeFileSync(join(directory, "release-manifest.json"), text);
		return hash(text);
	};
	return {
		root,
		directory,
		manifest,
		save,
		clean: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("the exact tarball handoff succeeds; altered bytes, manifest, source and package identity fail", () => {
	const item = fixture();
	try {
		const digest = item.save();
		assert.equal(validateArtifact(item.directory, commit, digest).version, version);
		assert.throws(() => validateArtifact(item.directory, "d".repeat(40), digest));
		assert.throws(() => validateArtifact(item.directory, commit, "0".repeat(64)));
		item.manifest.packageName = "@someone/else";
		assert.throws(() => validateArtifact(item.directory, commit, item.save()));
		item.manifest.packageName = PACKAGE;
		item.manifest.packageRepository = "git+https://github.com/Pharaoh-so/pharaoh.git";
		assert.throws(() => validateArtifact(item.directory, commit, item.save()));
		item.manifest.packageRepository = PACKAGE_REPOSITORY;
		const hashBeforeTamper = item.save();
		writeFileSync(join(item.directory, item.manifest.tarballFile), "different package bytes");
		assert.throws(
			() => validateArtifact(item.directory, commit, hashBeforeTamper),
			/Tarball SHA-256 mismatch/,
		);
	} finally {
		item.clean();
	}
});

test("npm boundary rejects private source, release credentials, traversal, links and missing runtime assets", () => {
	verifyPackPaths(paths);
	for (const path of [
		"src/mcp/server.ts",
		".npmrc",
		"../credentials.json",
		"dist/../../server.js",
		"scripts/release.mjs",
		"dist/nested/private.js",
	])
		assert.throws(() => verifyPackPaths([...paths, path]));
	assert.throws(() => verifyPackPaths(paths.filter((path) => path !== "dist/index.js")));
	const item = fixture();
	try {
		rmSync(join(item.root, "package/dist/index.js"));
		symlinkSync("index.d.ts", join(item.root, "package/dist/index.js"));
		execFileSync(
			"tar",
			[
				"-czf",
				join(item.directory, item.manifest.tarballFile),
				...paths.map((path) => `package/${path}`),
			],
			{ cwd: item.root },
		);
		const bytes = readFileSync(join(item.directory, item.manifest.tarballFile));
		item.manifest.tarballSha256 = hash(bytes);
		item.manifest.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
		assert.throws(
			() => validateArtifact(item.directory, commit, item.save()),
			/links and special files/,
		);
	} finally {
		item.clean();
	}
});

test("reads actual npm 12 pack JSON and rejects multiple or misidentified packages", () => {
	const packed = { name: PACKAGE, version, filename: `pharaoh-so-mcp-${version}.tgz` };
	assert.equal(readPackResult({ [PACKAGE]: packed }, version), packed);
	assert.equal(readPackResult([packed], version), packed);
	assert.throws(() => readPackResult({ [PACKAGE]: packed, unexpected: packed }, version));
	assert.throws(() => readPackResult([{ ...packed, name: "@someone/else" }], version));
	assert.throws(() => readPackResult([{ ...packed, filename: "../other.tgz" }], version));
});

test("release intent uses immutable previous package versions and skips maintenance/PR publication", () => {
	const root = mkdtempSync(join(tmpdir(), "pharaoh-release-intent-"));
	const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	const commitFixture = () => {
		git(["add", "."]);
		git([
			"-c",
			"user.name=Release fixture",
			"-c",
			"user.email=fixture@invalid.example",
			"commit",
			"--quiet",
			"-m",
			"Release fixture",
		]);
		return git(["rev-parse", "HEAD"]);
	};
	try {
		git(["init", "--quiet"]);
		writeFileSync(join(root, "README.md"), "Public repository before source bootstrap.");
		const withoutPackage = commitFixture();
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: PACKAGE, version: "0.3.48" }));
		const priorVersion = commitFixture();
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: PACKAGE, version: "0.3.49" }));
		const currentVersion = commitFixture();
		const push = (before) =>
			shouldPublish(root, { eventName: "push", ref: "refs/heads/main", before });
		assert.equal(push(withoutPackage), true);
		assert.equal(push("0".repeat(40)), true);
		assert.equal(push(priorVersion), true);
		assert.equal(push(currentVersion), false);
		const eventPath = join(root, "event.json");
		const outputPath = join(root, "github-output");
		writeFileSync(eventPath, JSON.stringify({ before: currentVersion }));
		const stdout = execFileSync(
			process.execPath,
			[fileURLToPath(new URL("../scripts/release.mjs", import.meta.url)), "intent"],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					GITHUB_EVENT_NAME: "push",
					GITHUB_REF: "refs/heads/main",
					GITHUB_EVENT_PATH: eventPath,
					GITHUB_OUTPUT: outputPath,
				},
			},
		);
		assert.equal(stdout.trim(), "Release intent: false");
		assert.equal(readFileSync(outputPath, "utf8"), "should-publish=false\n");
		assert.equal(
			shouldPublish(root, { eventName: "pull_request", ref: "refs/pull/1/merge" }),
			false,
		);
		assert.equal(
			shouldPublish(root, { eventName: "workflow_dispatch", ref: "refs/heads/main" }),
			true,
		);
		assert.equal(
			shouldPublish(root, { eventName: "workflow_dispatch", ref: "refs/heads/topic" }),
			false,
		);
		assert.throws(() => push("HEAD:package.json; false"));
		assert.throws(() => push("f".repeat(40)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("source record checks actual contents, modes, sorted aggregate and rejects ancestor symlinks", () => {
	const root = mkdtempSync(join(tmpdir(), "pharaoh-source-test-"));
	try {
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src/index.ts"), "public source\n");
		chmodSync(join(root, "src/index.ts"), 0o644);
		const files = [{ path: "src/index.ts", sha256: hash("public source\n"), mode: "100644" }];
		const source = {
			version: 1,
			repository: "Pharaoh-so/pharaoh",
			commit: sourceCommit,
			files,
			payloadSha256: hash(`src/index.ts\0${files[0].sha256}\0${files[0].mode}\n`),
		};
		writeFileSync(join(root, "pharaoh-source.json"), JSON.stringify(source));
		assert.equal(verifySource(root).commit, sourceCommit);
		writeFileSync(join(root, "src/index.ts"), "changed");
		assert.throws(() => verifySource(root), /Source hash mismatch/);
		writeFileSync(join(root, "src/index.ts"), "public source\n");
		chmodSync(join(root, "src/index.ts"), 0o755);
		assert.throws(() => verifySource(root), /Source mode mismatch/);
		rmSync(join(root, "src"), { recursive: true });
		symlinkSync(tmpdir(), join(root, "src"));
		assert.throws(() => verifySource(root), /Source link rejected/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("publication resumes identical versions and rejects changed bytes or older/latest rollbacks", () => {
	const item = fixture();
	try {
		const packument = { name: PACKAGE, versions: {}, "dist-tags": {} };
		assert.equal(releaseDecision(packument, item.manifest), "publish");
		packument.versions[version] = {
			name: PACKAGE,
			version,
			repository: { url: PACKAGE_REPOSITORY },
			dist: { integrity: item.manifest.integrity },
		};
		assert.equal(releaseDecision(packument, item.manifest), "resume");
		packument["dist-tags"].latest = "0.3.49";
		assert.equal(releaseDecision(packument, item.manifest), "resume");
		packument.versions[version].dist.integrity = "sha512-different";
		assert.throws(() => releaseDecision(packument, item.manifest), /different bytes/);
		delete packument.versions[version];
		packument["dist-tags"].latest = "0.3.49";
		assert.throws(() => releaseDecision(packument, item.manifest), /Refusing older release/);
		packument["dist-tags"].latest = "0.3.9";
		packument.versions["0.4.0"] = {};
		assert.throws(() => releaseDecision(packument, item.manifest), /Refusing older release/);
	} finally {
		item.clean();
	}
});

test("keeps verifying when npm processing takes longer than six attempts", async () => {
	let attempts = 0;
	const waits = [];
	const result = await retryRegistryVerification(
		async () => {
			attempts++;
			if (attempts < 9) throw new Error("npm is still processing the accepted publication");
			return "verified bytes and provenance";
		},
		async (ms) => {
			waits.push(ms);
		},
	);
	assert.equal(result, "verified bytes and provenance");
	assert.equal(attempts, 9);
	assert.deepEqual(waits, [5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000]);
});

test("fails closed with the verification error after 72 attempts and no final extra wait", async () => {
	let attempts = 0;
	let waits = 0;
	const failure = new Error("Published provenance does not match the release");
	await assert.rejects(
		() =>
			retryRegistryVerification(
				async () => {
					attempts++;
					throw failure;
				},
				async (ms) => {
					assert.equal(ms, 5_000);
					waits++;
				},
			),
		(error) => error === failure,
	);
	assert.equal(attempts, 72);
	assert.equal(waits, 71);
});

test("rerunning an older failed tag job cannot replace a newer GitHub Latest release", () => {
	assert.equal(githubLatestOption("0.3.49", "mcp-proxy-v0.3.49", "0.3.48"), "false");
	assert.equal(githubLatestOption("0.3.48", "mcp-proxy-v0.3.49", "0.3.48"), "false");
	assert.equal(githubLatestOption("0.3.49", "mcp-proxy-v0.3.48", "0.3.49"), "true");
	assert.equal(githubLatestOption("0.3.49", null, "0.3.49"), "true");
	assert.equal(githubLatestOption("0.3.49", "unrecognized-tag", "0.3.49"), "false");
});

test("npm-verified provenance must bind the exact tarball to this public main workflow and certificate source SHA", () => {
	const item = fixture();
	try {
		const workflow = {
			ref: "refs/heads/main",
			repository: `https://github.com/${REPOSITORY}`,
			path: WORKFLOW,
		};
		const statement = {
			subject: [
				{
					name: `pkg:npm/%40pharaoh-so/mcp@${version}`,
					digest: {
						sha512: Buffer.from(item.manifest.integrity.slice(7), "base64").toString("hex"),
					},
				},
			],
			predicateType: "https://slsa.dev/provenance/v1",
			predicate: {
				buildDefinition: {
					externalParameters: { workflow },
					resolvedDependencies: [
						{
							uri: `git+https://github.com/${REPOSITORY}@refs/heads/main`,
							digest: { gitCommit: commit },
						},
					],
				},
			},
		};
		const envelope = {
			dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") },
			verificationMaterial: { certificate: { rawBytes: "Y2VydA==" } },
		};
		const report = {
			invalid: [],
			missing: [],
			verified: [
				{
					name: PACKAGE,
					version,
					registry: "https://registry.npmjs.org/",
					attestationBundles: [{ predicateType: statement.predicateType, bundle: envelope }],
				},
			],
		};
		const claims = {
			san: `URI:https://github.com/${REPOSITORY}/${WORKFLOW}@refs/heads/main`,
			claims: {
				8: "https://token.actions.githubusercontent.com",
				12: `https://github.com/${REPOSITORY}`,
				13: commit,
				14: "refs/heads/main",
			},
		};
		assert.equal(
			verifyProvenance(report, item.manifest, () => claims).predicateType,
			statement.predicateType,
		);
		for (const [key, value] of [
			[8, "https://other-issuer.example"],
			[12, "https://github.com/attacker/fork"],
			[13, "f".repeat(40)],
			[14, "refs/heads/topic"],
		]) {
			assert.throws(() =>
				verifyProvenance(report, item.manifest, () => ({
					...claims,
					claims: { ...claims.claims, [key]: value },
				})),
			);
		}
		assert.throws(() =>
			verifyProvenance(report, item.manifest, () => ({
				...claims,
				san: `URI:https://github.com/${REPOSITORY}/.github/workflows/other.yml@refs/heads/main`,
			})),
		);
		workflow.repository = "https://github.com/attacker/fork";
		envelope.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
		assert.throws(() => verifyProvenance(report, item.manifest, () => claims));
		assert.throws(
			() =>
				verifyProvenance({ invalid: [], missing: [], verified: [] }, item.manifest, () => claims),
			/did not cryptographically verify/,
		);
	} finally {
		item.clean();
	}
});

test("reads authenticated Fulcio identity extensions from a real npm provenance certificate", () => {
	// Public certificate from registry.npmjs.org/-/npm/v1/attestations/@modelcontextprotocol%2fsdk@1.26.0.
	// Cryptographic validity is npm's responsibility; this fixture proves our DER identity reader.
	const result = certificateClaims(
		readFileSync(new URL("fixtures/npm-provenance-certificate.pem", import.meta.url)),
	);
	assert.equal(
		result.san,
		"URI:https://github.com/modelcontextprotocol/typescript-sdk/.github/workflows/main.yml@refs/tags/v1.26.0",
	);
	assert.equal(result.claims[8], "https://token.actions.githubusercontent.com");
	assert.equal(result.claims[12], "https://github.com/modelcontextprotocol/typescript-sdk");
	assert.equal(result.claims[13], "fe9c07b465871394c7069207c86513df9c1194a4");
	assert.equal(result.claims[14], "refs/tags/v1.26.0");
});

test("publish permissions are separated from package builds and write access", () => {
	const workflow = readFileSync(
		new URL("../.github/workflows/publish-mcp-proxy.yml", import.meta.url),
		"utf8",
	);
	const publisher = workflow.split("\n  publish:\n")[1].split("\n  tag:\n")[0];
	assert.match(publisher, /environment: npm-publish/);
	assert.match(publisher, /needs\.quality\.outputs\.should-publish == 'true'/);
	assert.match(workflow, /fetch-depth: 0/);
	assert.match(publisher, /contents: read\n {6}id-token: write/);
	assert.match(publisher, /artifact-ids: \$\{\{ needs\.quality\.outputs\.artifact-id \}\}/);
	assert.doesNotMatch(publisher, /npm ci|npm run|NPM_TOKEN|NODE_AUTH_TOKEN|contents: write/);
	assert.match(workflow, /cancel-in-progress: false/);
	assert.match(workflow, /node --test test\/release\.test\.mjs/);
});
