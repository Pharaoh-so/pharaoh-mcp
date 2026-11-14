/**
 * The consented update: `pharaoh_update` and `npx @pharaoh-so/mcp@latest update`. Through
 * pharaoh_update the version already installed runs every check; through npx, npm's newest
 * release runs its own checks after npx has already run it, the same trust as `install`.
 * Installs npm's newest release into a private stage, accepts it only when it is
 * provably the registry's tarball built by Pharaoh's own publishing workflow, and
 * stages it (pending.json) for the stable launcher to apply at the next session
 * start. Nothing here changes the running proxy, current.json or any client's
 * settings, and any failed check leaves the current version active.
 *
 * Verification:
 * - every package came from registry.npmjs.org (the lockfile's `resolved`), the
 *   root from its canonical tarball URL;
 * - for the root package, the integrity npm installed and recorded in the stage's
 *   lockfile is the one npm's publish attestation (signed with the registry's key)
 *   and the SLSA provenance name; the provenance is verified with Sigstore (TUF
 *   trust root, fail closed) and must be signed for exactly PUBLISHER;
 * - `npm audit signatures` passes for every installed package. Dependencies are
 *   checked by registry signature only: their versions resolve at update time
 *   within the package's ranges, as with `install`, and no provenance covers them.
 */
import { execFile } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	logUpdate,
	newerVersion,
	readPointer,
	receiptDigest,
	usableVersion,
	withActivateLock,
	writePointer,
} from "../runtime/launcher-v1.mjs";
import {
	NPM_REGISTRY,
	OffRegistryTarballError,
	type RuntimeOptions,
	RuntimeSetupError,
	stageVerifiedRuntime,
	type VerifiedRuntimeOptions,
	type VerifiedStage,
} from "./runtime.js";
import { PACKAGE_NAME } from "./version.js";

/** The only build identity an update is accepted from: the public package repo's publish workflow on main. */
export const PUBLISHER =
	"https://github.com/Pharaoh-so/pharaoh-mcp/.github/workflows/publish-mcp-proxy.yml@refs/heads/main";
const ISSUER = "https://token.actions.githubusercontent.com";
const SLSA_V1 = "https://slsa.dev/provenance/v1";
const NPM_PUBLISH = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const WORKFLOW = {
	repository: "https://github.com/Pharaoh-so/pharaoh-mcp",
	path: ".github/workflows/publish-mcp-proxy.yml",
	ref: "refs/heads/main",
};
/** The manual path, always available: it runs whatever npm resolves, without these checks. */
const MANUAL = "npx @pharaoh-so/mcp@latest install";
const FETCH_TIMEOUT_MS = 15_000;

/** A failed check, with a short reason the receipt records. */
class UpdateRejected extends Error {
	constructor(
		readonly reason: string,
		message: string,
	) {
		super(message);
		this.name = "UpdateRejected";
	}
}

/** The update's outcome, as the CLI prints it and pharaoh_update returns it. */
export type UpdateResult =
	| { status: "staged"; version: string; from: string }
	| { status: "current"; version: string }
	| { status: "refused"; reason: string; message: string }
	| { status: "rejected"; reason: string; version?: string; message: string };

/** A Sigstore bundle check: resolves when the bundle verifies under `options`, throws otherwise. */
export type BundleVerifier = (bundle: unknown, options: Record<string, unknown>) => Promise<void>;

/** Inputs are injectable so fixtures never reach npm, Sigstore or a real home directory. */
export interface UpdateOptions {
	home?: string;
	platform?: NodeJS.Platform;
	nodeVersion?: string;
	fetchImpl?: typeof fetch;
	verifyBundle?: BundleVerifier;
	/** Fixtures only: a local registry standing in for registry.npmjs.org. */
	registry?: string;
	runtime?: RuntimeOptions & Pick<VerifiedRuntimeOptions, "runAsync">;
}

interface Manifest {
	version: string;
	dist: {
		tarball?: unknown;
		integrity?: unknown;
		signatures?: unknown;
		attestations?: { url?: unknown; provenance?: { predicateType?: unknown } };
	};
}

interface Attestation {
	predicateType: string;
	bundle: { dsseEnvelope?: { payload?: string } } & Record<string, unknown>;
}

function runtimesRoot(home: string): string {
	return join(home, ".pharaoh", "runtimes", "mcp");
}

/** The signing certificate's subject alternative name in a Sigstore bundle, as Node reads it. */
function signerIdentity(bundle: unknown): string | undefined {
	const material = (
		bundle as {
			verificationMaterial?: {
				certificate?: { rawBytes?: unknown };
				x509CertificateChain?: { certificates?: Array<{ rawBytes?: unknown }> };
			};
		}
	)?.verificationMaterial;
	const raw =
		material?.certificate?.rawBytes ?? material?.x509CertificateChain?.certificates?.[0]?.rawBytes;
	if (typeof raw !== "string") return undefined;
	try {
		return new X509Certificate(Buffer.from(raw, "base64")).subjectAltName;
	} catch {
		return undefined;
	}
}

/**
 * Sigstore's own verifier, loaded only when an update runs. Sigstore matches a
 * certificate identity as an unanchored pattern (`.` matches anything, and a
 * branch named main-x would pass for main), so a required identity is first
 * compared exactly with the bundle's certificate, then passed escaped and anchored.
 *
 * @param bundle - A Sigstore bundle from npm's attestations
 * @param options - Sigstore's verify options; certificateIdentityURI is an exact identity
 */
export async function verifySigstoreBundle(
	bundle: unknown,
	options: Record<string, unknown>,
): Promise<void> {
	const identity = options.certificateIdentityURI;
	if (typeof identity === "string") {
		if (signerIdentity(bundle) !== `URI:${identity}`)
			throw new Error("The bundle was signed for another identity.");
		options = {
			...options,
			certificateIdentityURI: `^${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
		};
	}
	const { verify } = await import("sigstore");
	await verify(bundle as Parameters<typeof verify>[0], options);
}

async function getJson(url: string, options: UpdateOptions): Promise<unknown> {
	const res = await (options.fetchImpl ?? fetch)(url, {
		headers: { accept: "application/json" },
		redirect: "error",
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new UpdateRejected("registry-unavailable", `npm answered ${res.status}.`);
	return res.json();
}

/** Whether a staged update would still activate: its directory checks out and its receipt is the one recorded. */
function stagedIntact(root: string, pending: Record<string, unknown>): boolean {
	return (
		usableVersion(root, pending.version) !== null &&
		receiptDigest(root, String(pending.version)) === pending.receiptDigest
	);
}

/** Node versions sigstore 3 supports. */
function supportedNode(version: string): boolean {
	const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
	return (major === 18 && minor >= 17) || (major === 20 && minor >= 5) || major > 20;
}

/** The hex sha512 of an `sha512-<base64>` integrity value. */
function sha512Hex(integrity: string): string {
	return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
}

/**
 * Every package in the stage's lockfile came from the registry with an sha512
 * integrity value, and the root package is this exact version from its
 * canonical tarball URL.
 *
 * @returns The root package's integrity value
 */
function checkLockfile(staging: string, version: string, registry: string): string {
	let lock: {
		packages?: Record<string, { resolved?: unknown; integrity?: unknown; link?: unknown }>;
	};
	try {
		lock = JSON.parse(readFileSync(join(staging, "package-lock.json"), "utf8"));
	} catch {
		throw new UpdateRejected("no-lockfile", "npm left no lockfile to check.");
	}
	const packages = Object.entries(lock.packages ?? {}).filter(([path]) => path !== "");
	if (!packages.length) throw new UpdateRejected("no-lockfile", "npm's lockfile lists nothing.");
	for (const [path, entry] of packages) {
		if (
			entry.link ||
			typeof entry.resolved !== "string" ||
			!entry.resolved.startsWith(registry) ||
			typeof entry.integrity !== "string" ||
			!entry.integrity.startsWith("sha512-")
		)
			throw new UpdateRejected("off-registry", `${path} did not come from ${registry}.`);
	}
	const root = lock.packages?.["node_modules/@pharaoh-so/mcp"];
	if (root?.resolved !== `${registry}@pharaoh-so/mcp/-/mcp-${version}.tgz`)
		throw new UpdateRejected("off-registry", "The package did not come from its registry tarball.");
	return root.integrity as string;
}

/** The in-toto statement inside a bundle's DSSE envelope, and a check of its subject. */
function checkSubject(attestation: Attestation, version: string, integrity: string) {
	let statement: {
		subject?: Array<{ name?: string; digest?: { sha512?: string } }>;
		predicate?: {
			buildDefinition?: { externalParameters?: { workflow?: Record<string, unknown> } };
		};
	};
	try {
		statement = JSON.parse(
			Buffer.from(attestation.bundle.dsseEnvelope?.payload ?? "", "base64").toString("utf8"),
		);
	} catch {
		throw new UpdateRejected("bad-attestation", "An attestation could not be read.");
	}
	const subject = statement.subject?.[0];
	if (
		statement.subject?.length !== 1 ||
		subject?.name !== `pkg:npm/%40pharaoh-so/mcp@${version}` ||
		subject.digest?.sha512 !== sha512Hex(integrity)
	)
		throw new UpdateRejected(
			"digest-mismatch",
			"An attestation names other bytes than npm installed.",
		);
	return statement;
}

/**
 * Accept or reject a staged install (see the module comment), then write its
 * receipt into the stage, where it is published with the version directory.
 */
async function verifyStage(
	stage: VerifiedStage,
	manifest: Manifest,
	registry: string,
	options: UpdateOptions,
	source: string,
): Promise<void> {
	const { version, dist } = manifest;
	const integrity = checkLockfile(stage.staging, version, registry);
	if (dist.integrity !== integrity)
		throw new UpdateRejected(
			"digest-mismatch",
			"npm installed other bytes than the registry lists.",
		);
	if (!Array.isArray(dist.signatures) || !dist.signatures.length)
		throw new UpdateRejected("unsigned", "The registry lists no signature for this release.");
	const url = dist.attestations?.url;
	if (dist.attestations?.provenance?.predicateType !== SLSA_V1 || typeof url !== "string")
		throw new UpdateRejected("no-provenance", "This release has no build provenance.");
	if (!url.startsWith(`${registry}-/npm/v1/attestations/`))
		throw new UpdateRejected("off-registry", "The provenance is not on the registry.");
	const { attestations } = (await getJson(url, options)) as { attestations?: Attestation[] };
	const find = (type: string) => attestations?.find((entry) => entry.predicateType === type);
	const publish = find(NPM_PUBLISH);
	const provenance = find(SLSA_V1);
	if (!publish || !provenance)
		throw new UpdateRejected("no-provenance", "The registry's attestations are incomplete.");
	checkSubject(publish, version, integrity);
	const statement = checkSubject(provenance, version, integrity);
	const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
	if (
		workflow?.repository !== WORKFLOW.repository ||
		workflow.path !== WORKFLOW.path ||
		workflow.ref !== WORKFLOW.ref
	)
		throw new UpdateRejected(
			"wrong-publisher",
			"This release was not built by Pharaoh's workflow.",
		);
	const { keys } = (await getJson(`${registry}-/npm/v1/keys`, options)) as {
		keys?: Array<{ keyid?: string; key?: string; expires?: unknown }>;
	};
	// A registry key past its expiry signs nothing new.
	const live = (keys ?? []).filter(
		(key) => typeof key.expires !== "string" || Date.parse(key.expires) > Date.now(),
	);
	const pem = new Map(
		live.map((key) => [
			key.keyid,
			`-----BEGIN PUBLIC KEY-----\n${key.key}\n-----END PUBLIC KEY-----`,
		]),
	);
	const tuf = { tufCachePath: join(runtimesRoot(options.home ?? homedir()), ".sigstore") };
	const verifyBundle = options.verifyBundle ?? verifySigstoreBundle;
	/** Sigstore's trust root couldn't be fetched: unverifiable, which is not a bad signature. */
	const unreachable = (error: unknown) =>
		/^TUF_/.test(String((error as { code?: unknown })?.code ?? ""))
			? new UpdateRejected(
					"sigstore-unreachable",
					"Pharaoh could not reach Sigstore to verify this release.",
				)
			: null;
	try {
		await verifyBundle(publish.bundle, { ...tuf, keySelector: (hint: string) => pem.get(hint) });
	} catch (error) {
		throw (
			unreachable(error) ??
			new UpdateRejected("bad-signature", "npm's signature on this release did not verify.")
		);
	}
	try {
		await verifyBundle(provenance.bundle, {
			...tuf,
			certificateIssuer: ISSUER,
			certificateIdentityURI: PUBLISHER,
		});
	} catch (error) {
		throw (
			unreachable(error) ??
			new UpdateRejected("bad-provenance", "This release's build provenance did not verify.")
		);
	}
	const audit = await stage.npm(["audit", "signatures", "--json"]);
	let report: { invalid?: unknown[]; missing?: unknown[] } = {};
	try {
		report = JSON.parse(audit.stdout);
	} catch {
		// An unreadable report fails below.
	}
	if (audit.code !== 0 || report.invalid?.length !== 0 || report.missing?.length !== 0)
		throw new UpdateRejected("bad-signature", "npm's signature check of the dependencies failed.");
	writeFileSync(
		join(stage.staging, ".pharaoh-verified.json"),
		JSON.stringify({
			package: PACKAGE_NAME,
			version,
			tarball: dist.tarball,
			integrity,
			publisher: PUBLISHER,
			source,
			verifiedAt: new Date().toISOString(),
			id: randomUUID(),
		}),
		{ mode: 0o600 },
	);
}

/**
 * Verify npm's newest release and stage it for the next session start.
 *
 * @param source - Who asked: "tool" (pharaoh_update) or "terminal" (the CLI)
 * @param options - Fixtures
 * @returns What happened; the receipt is in ~/.pharaoh/runtimes/mcp/update.log
 */
export async function runUpdate(
	source: "tool" | "terminal",
	options: UpdateOptions = {},
): Promise<UpdateResult> {
	const home = options.home ?? homedir();
	const root = runtimesRoot(home);
	if ((options.platform ?? process.platform) === "win32")
		return { status: "refused", reason: "windows", message: `On Windows, update with ${MANUAL}.` };
	if (!supportedNode(options.nodeVersion ?? process.version))
		return {
			status: "refused",
			reason: "node",
			message: `Verified updates need Node.js 18.17, 20.5 or later. Update with ${MANUAL}.`,
		};
	const current = readPointer(root, "current.json");
	if (!usableVersion(root, current?.version))
		return {
			status: "refused",
			reason: "no-launcher",
			message: `Run ${MANUAL} once; from then on Pharaoh can update itself when you accept.`,
		};
	const from = current?.version as string;
	const registry = options.registry ?? NPM_REGISTRY;
	let version: string | undefined;
	try {
		const manifest = (await getJson(`${registry}@pharaoh-so%2fmcp/latest`, options)) as Manifest;
		version = manifest?.version;
		if (typeof version !== "string" || !manifest.dist)
			throw new UpdateRejected("registry-unavailable", "npm's answer had no version.");
		const pending = readPointer(root, "pending.json");
		if (!newerVersion(version, from)) return { status: "current", version: from };
		// A staged version that still checks out stands; a broken one is restaged below.
		if (pending && !newerVersion(version, pending.version) && stagedIntact(root, pending))
			return { status: "staged", version: pending.version as string, from };
		const existing = readPointer(join(root, version), ".pharaoh-verified.json");
		if (usableVersion(root, version) && existing?.integrity === manifest.dist.integrity) {
			logUpdate(root, { event: "reused", version, source });
		} else {
			await stageVerifiedRuntime({ ...options.runtime, home, version, registry }, (stage) =>
				verifyStage(stage, manifest, registry, options, source),
			);
		}
		const digest = receiptDigest(root, version);
		const staged = await withActivateLock(
			root,
			() => {
				// Another update or activation may have moved on meanwhile: report what holds now.
				const now = readPointer(root, "current.json");
				const queued = readPointer(root, "pending.json");
				if (!newerVersion(version, now?.version))
					return { status: "current", version: String(now?.version) } as const;
				if (queued && !newerVersion(version, queued.version) && stagedIntact(root, queued))
					return { status: "staged", version: String(queued.version), from } as const;
				writePointer(root, "pending.json", { version, receiptDigest: digest, source });
				return null;
			},
			{ waitMs: 5_000 },
		);
		if (!staged.held)
			throw new UpdateRejected(
				"busy",
				"Another Pharaoh update was being applied. Try again shortly.",
			);
		if (staged.value) {
			logUpdate(root, { event: "superseded", version, source });
			return staged.value;
		}
		logUpdate(root, { event: "staged", version, from, source });
		return { status: "staged", version, from };
	} catch (error) {
		const reason =
			error instanceof UpdateRejected
				? error.reason
				: error instanceof OffRegistryTarballError
					? "off-registry"
					: error instanceof RuntimeSetupError
						? "install-failed"
						: "unverifiable";
		const message =
			error instanceof UpdateRejected || error instanceof RuntimeSetupError
				? error.message
				: "Pharaoh could not reach npm or Sigstore to verify the update.";
		logUpdate(root, { event: "rejected", version, reason, source });
		return {
			status: "rejected",
			reason,
			version,
			message: `${message} Pharaoh ${from} stays active.`,
		};
	}
}

/**
 * The line the CLI prints and pharaoh_update returns for an outcome.
 * @param result - What runUpdate returned
 */
function describeUpdate(result: UpdateResult): string {
	switch (result.status) {
		case "staged":
			return `Pharaoh ${result.version} passed verification (npm's registry signature and its build provenance from Pharaoh-so/pharaoh-mcp) and is staged. It becomes active when you start your next session; ${result.from} keeps running until then.`;
		case "current":
			return `Pharaoh ${result.version} is the newest release.`;
		case "refused":
			return result.message;
		case "rejected":
			return `Pharaoh did not stage ${result.version ?? "the update"}: ${result.message}`;
	}
}

/**
 * `npx @pharaoh-so/mcp@latest update [--json]`, and the child process pharaoh_update runs.
 * @param args - Arguments after `update`
 * @returns A shell exit status: 0 staged or already current, 1 otherwise
 */
export async function runUpdateCommand(args: readonly string[]): Promise<number> {
	const result = await runUpdate(args.includes("--from-tool") ? "tool" : "terminal");
	process.stdout.write(
		args.includes("--json") ? `${JSON.stringify(result)}\n` : `${describeUpdate(result)}\n`,
	);
	return result.status === "staged" || result.status === "current" ? 0 : 1;
}

/**
 * pharaoh_update inside a running proxy: run the update in a child process of
 * this same version (npm would block the proxy's event loop) and answer with
 * its outcome. The child never goes through the launcher, so nothing activates,
 * and the running proxy is never changed.
 *
 * @param signal - The tool call's abort signal; aborting stops the child
 * @returns The reply text, and whether it reports a failure
 */
export async function updateFromTool(
	signal: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
	const entry = fileURLToPath(new URL("./index.js", import.meta.url));
	const result = await new Promise<UpdateResult>((resolveRun) => {
		execFile(
			process.execPath,
			[entry, "update", "--from-tool", "--json"],
			{ signal, timeout: 300_000, maxBuffer: 65_536, encoding: "utf8" },
			(_error, stdout) => {
				try {
					resolveRun(JSON.parse(String(stdout).trim().split("\n").pop() ?? ""));
				} catch {
					resolveRun({
						status: "rejected",
						reason: "unfinished",
						message: "The update check did not finish. The current version stays active.",
					});
				}
			},
		);
	});
	return {
		text: describeUpdate(result),
		isError: result.status === "rejected" || result.status === "refused",
	};
}
