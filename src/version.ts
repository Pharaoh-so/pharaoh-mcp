/**
 * The package's own version, and what follows from it: the pinned `npx` spec
 * every registration uses, and the registry check behind the upgrade hint.
 *
 * Reads packages/mcp-proxy/package.json, which ships in the npm artifact.
 * Returns "0.0.0" on any failure so callers can treat the value as display-only.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the bundled package root (one level up from dist/). */
const PKG_ROOT = join(__dirname, "..");

/** The npm package name, as `npx` resolves it. */
export const PACKAGE_NAME = "@pharaoh-so/mcp";

/** The deliberate upgrade: re-runs setup with the newest release, which re-pins every registration. */
export const UPGRADE_COMMAND = `npx ${PACKAGE_NAME}@latest`;

/** Where the npm registry reports the newest published version. */
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2F")}/latest`;

/** Read the mcp-proxy package version from package.json. */
export function getPackageVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8")) as {
			version?: string;
		};
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/**
 * The package spec a registration runs: this exact version, so a new release
 * on npm changes nothing on the user's machine until they upgrade on purpose
 * (security review SC-2). Falls back to the bare name only when the version
 * is unreadable, which would otherwise pin a version that does not exist.
 *
 * @returns `@pharaoh-so/mcp@<version>` as `npx` accepts it.
 */
export function pinnedPackageSpec(): string {
	const version = getPackageVersion();
	return version === "0.0.0" ? PACKAGE_NAME : `${PACKAGE_NAME}@${version}`;
}

/** `[major, minor, patch]` of a plain semver string, or null for anything else. */
function parseVersion(version: string): number[] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match ? match.slice(1).map(Number) : null;
}

/**
 * Whether `candidate` is a strictly newer release than `current`. Anything
 * that is not a plain `major.minor.patch` compares as not newer.
 *
 * @param candidate - Version reported by the registry.
 * @param current - Version this process runs.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	const a = parseVersion(candidate);
	const b = parseVersion(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return false;
}

/**
 * The newest version on the npm registry, or null when it cannot be learned
 * (offline, slow, or an unexpected answer). Called only by the interactive
 * setup, never on a proxy start, and sends nothing but the request itself.
 *
 * @param fetchImpl - `fetch` stand-in for tests.
 * @param timeoutMs - How long to wait for the registry before giving up.
 */
export async function fetchLatestVersion(
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 3000,
): Promise<string | null> {
	try {
		const res = await fetchImpl(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return null;
		const body = (await res.json()) as { version?: unknown };
		return typeof body.version === "string" ? body.version : null;
	} catch {
		// ALLOWED-CATCH: the hint is optional; being offline must not affect setup
		return null;
	}
}
