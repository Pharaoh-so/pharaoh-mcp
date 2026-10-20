/** Record the already-verified release with contents permission and no npm/OIDC credential. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	githubLatestOption,
	hash,
	PACKAGE_REPOSITORY,
	REPOSITORY,
	registryPackument,
	validateArtifact,
} from "./release.mjs";

const [directory, commit, manifestHash] = process.argv.slice(2);
const manifest = validateArtifact(directory, commit, manifestHash);
assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.ok(process.env.GH_TOKEN);
const tag = `mcp-proxy-v${manifest.version}`;
const base = `https://api.github.com/repos/${REPOSITORY}`;
async function api(path, options = {}) {
	const response = await fetch(`${base}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${process.env.GH_TOKEN}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...options.headers,
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404 && !options.method) return null;
	assert.ok(response.ok, `GitHub release request failed: ${response.status}`);
	return response.json();
}
const ref = await api(`/git/ref/tags/${tag}`);
if (ref) {
	assert.equal(ref.object.type, "commit");
	assert.equal(ref.object.sha, commit, "Existing release tag points to different source");
} else
	await api("/git/refs", {
		method: "POST",
		body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: commit }),
	});

let release = await api(`/releases/tags/${tag}`);
if (!release) {
	const packument = await registryPackument();
	const published = packument.versions?.[manifest.version];
	assert.equal(published?.repository?.url, PACKAGE_REPOSITORY);
	assert.equal(published?.dist?.integrity, manifest.integrity);
	const latest = await api("/releases/latest");
	release = await api("/releases", {
		method: "POST",
		body: JSON.stringify({
			tag_name: tag,
			target_commitish: commit,
			name: `${manifest.packageName} ${manifest.version}`,
			body: `Verified npm release from public commit ${commit}.\n\nPrivate source record: ${manifest.sourceCommit}\nTarball SHA-256: ${manifest.tarballSha256}`,
			draft: false,
			prerelease: false,
			make_latest: githubLatestOption(
				packument["dist-tags"]?.latest,
				latest?.tag_name,
				manifest.version,
			),
		}),
	});
}
assert.equal(release.tag_name, tag);
assert.equal(release.draft, false);
const assets = await api(`/releases/${release.id}/assets?per_page=100`);
const existing = assets.filter((asset) => asset.name === "release-manifest.json");
assert.ok(existing.length <= 1);
const bytes = readFileSync(join(directory, "release-manifest.json"));
if (existing.length) {
	const response = await fetch(existing[0].url, {
		headers: {
			Authorization: `Bearer ${process.env.GH_TOKEN}`,
			Accept: "application/octet-stream",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		signal: AbortSignal.timeout(30_000),
	});
	assert.ok(response.ok);
	assert.equal(
		hash(Buffer.from(await response.arrayBuffer())),
		manifestHash,
		"Existing release manifest differs",
	);
} else {
	const response = await fetch(
		`https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=release-manifest.json`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.GH_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: bytes,
			signal: AbortSignal.timeout(30_000),
		},
	);
	assert.ok(response.ok, `GitHub release manifest upload failed: ${response.status}`);
}
console.log(`Recorded ${tag} at ${commit}`);
