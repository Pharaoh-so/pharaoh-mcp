import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { hasLegacyHooks } from "./hook-config.mjs";
import { atomicWrite, checkout, gitBefore } from "./local.mjs";
import { PROJECT_MEMORY_ORIGIN, requestMemoryReadiness } from "./memory-api.mjs";

const REVISION = /^(?!0{40}$)[a-f0-9]{40}$/;
const READINESS_RETRY_MS = 15_000;
const LEGACY_SETTINGS = {
	"claude-code": ".claude/settings.local.json",
	codex: ".codex/hooks.json",
};

export function legacySettingsPath(client, root) {
	return join(root, LEGACY_SETTINGS[client]);
}

export function projectMemoryHint(credentials) {
	if (!credentials || !Array.isArray(credentials.project_memory)) return [];
	try {
		if (new URL(credentials.sse_url).origin !== PROJECT_MEMORY_ORIGIN) return [];
	} catch {
		return [];
	}
	return credentials.project_memory;
}

export function projectMemorySession(credentials) {
	const session = credentials?.project_memory_session;
	if (typeof session === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(session))
		return session;
}

export function matchingMemoryHint(target, hints) {
	return hints.find(
		(entry) =>
			typeof entry?.repo === "string" && entry.repo.toLowerCase() === target.repo.toLowerCase(),
	);
}

function hasMappedCommit(target, revision, deadline = Infinity) {
	if (typeof revision !== "string" || !REVISION.test(revision)) return false;
	try {
		// An origin URL is editable. Require an actual GitHub-mapped commit
		// locally, without fetching, consulting replace refs, or running hooks.
		return gitBefore(target.root, deadline, "cat-file", "-t", revision) === "commit";
	} catch {
		return false;
	}
}

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

function readReadiness(path, binding) {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 512)
			return;
		const state = JSON.parse(readFileSync(path, "utf8"));
		if (state.binding === binding) return state;
	} catch {
		// A missing or unreadable cache cannot authorize a checkout.
	}
}

function tryReadinessLease(path, now) {
	try {
		try {
			const stat = lstatSync(path);
			if (
				!stat.isFile() ||
				stat.uid !== process.getuid?.() ||
				now - stat.mtimeMs < READINESS_RETRY_MS
			)
				return;
			rmSync(path, { force: true });
		} catch (error) {
			if (error.code !== "ENOENT") return;
		}
		const owner = randomUUID();
		writeFileSync(path, owner, { flag: "wx", mode: 0o600 });
		return () => {
			try {
				if (readFileSync(path, "utf8") === owner) rmSync(path, { force: true });
			} catch {
				// A stale lease expires without blocking ordinary work.
			}
		};
	} catch {
		// Another hook is already checking or private local state is unavailable.
	}
}

async function resolveRevision(repo, credentials, probe, deadline) {
	const session = projectMemorySession(credentials);
	if (!session) return;
	const binding = hash(session);
	const path = join(memoryClientRoot(), `ready-${hash(repo.toLowerCase())}.json`);
	const saved = readReadiness(path, binding);
	if (typeof saved?.revision === "string" && REVISION.test(saved.revision)) return saved.revision;
	const now = Date.now();
	if (!probe || now - (saved?.checkedAt ?? 0) < READINESS_RETRY_MS) return;
	const release = tryReadinessLease(`${path}.lock`, now);
	if (!release) return;
	try {
		const latest = readReadiness(path, binding);
		if (typeof latest?.revision === "string" && REVISION.test(latest.revision))
			return latest.revision;
		if (now - (latest?.checkedAt ?? 0) < READINESS_RETRY_MS) return;
		atomicWrite(path, JSON.stringify({ binding, checkedAt: now }));
		const revision = await requestMemoryReadiness(repo, credentials, deadline);
		if (typeof revision === "string" && REVISION.test(revision)) {
			atomicWrite(path, JSON.stringify({ binding, checkedAt: now, revision }));
			return revision;
		}
	} catch {
		// A cache failure must not activate memory or block the normal prompt.
	} finally {
		release();
	}
}

async function resolveMappedCheckout(target, credentials, hint, probe, deadline = Infinity) {
	const revision =
		hint.revision === null
			? await resolveRevision(hint.repo, credentials, probe, deadline)
			: hint.revision;
	if (hasMappedCommit(target, revision, deadline)) return target;
}

export async function cachedMemoryCheckout(cwd, credentials) {
	const hints = projectMemoryHint(credentials);
	if (!hints.length) return;
	const target = checkout(cwd);
	const hint = target && matchingMemoryHint(target, hints);
	if (hint) return resolveMappedCheckout(target, credentials, hint, false);
}

export function readHookSettings(path, storage) {
	let fd;
	try {
		if (storage) storage.privatePath(dirname(path), true);
		const info = storage ? storage.privatePath(path, false) : lstatSync(path);
		if (!info.isFile() || (!storage && info.uid !== process.getuid?.()) || info.size > 512 * 1024)
			throw new Error("Expected a regular owner-controlled hook settings file.");
		if (!storage) return JSON.parse(readFileSync(path, "utf8"));
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(fd);
		if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
			throw new Error("Hook settings changed during inspection.");
		const bytes = Buffer.alloc(opened.size + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		if (length !== opened.size) throw new Error("Hook settings changed during inspection.");
		return JSON.parse(bytes.toString("utf8", 0, length));
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function checkoutHookPath(path, directory, storage) {
	const info = lstatSync(path);
	if (
		(directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
		(typeof process.getuid === "function" &&
			(info.uid !== process.getuid() || (info.mode & 0o022) !== 0))
	) {
		throw new Error("Expected an owner-controlled checkout hook path.");
	}
	// POSIX project directories can be readable to other users. On Windows,
	// ask the native reader to check the ACL where the legacy file exists.
	if (process.platform === "win32" && storage) storage.privatePath(path, directory);
	return info;
}

/** Legacy checkout hooks can execute independently of the active managed bundle. */
export function legacyMemoryHooksMayRun(client, root, storage) {
	if (!Object.hasOwn(LEGACY_SETTINGS, client) || !isAbsolute(root)) return true;
	try {
		const path = legacySettingsPath(client, root);
		const parent = dirname(path);
		if (!lstatSync(parent, { throwIfNoEntry: false })) return false;
		checkoutHookPath(parent, true);
		if (!lstatSync(path, { throwIfNoEntry: false })) return false;
		const projectStorage = {
			privatePath: (target, directory) => checkoutHookPath(target, directory, storage),
		};
		const config = readHookSettings(path, projectStorage);
		if (!config || typeof config !== "object" || Array.isArray(config)) return true;
		const { hooks } = config;
		if (
			hooks !== undefined &&
			(!hooks ||
				typeof hooks !== "object" ||
				Array.isArray(hooks) ||
				Object.values(hooks).some(
					(groups) =>
						!Array.isArray(groups) || groups.some((group) => !Array.isArray(group?.hooks)),
				))
		) {
			return true;
		}
		return hasLegacyHooks(config, client, root);
	} catch {
		// An unreadable settings file cannot establish that the old hook is absent.
		return true;
	}
}

export async function resolveMemoryHookTarget(
	client,
	cwd,
	credentials,
	probe = false,
	deadline = Infinity,
) {
	if (!Object.hasOwn(LEGACY_SETTINGS, client)) return;
	const hints = projectMemoryHint(credentials);
	if (!hints.length) return;
	const target = checkout(cwd, deadline);
	const hint = target && matchingMemoryHint(target, hints);
	if (!hint) return;
	// Leave a checkout enrolled by the original pilot in charge until setup migrates it.
	if (legacyMemoryHooksMayRun(client, target.root)) return;
	return resolveMappedCheckout(target, credentials, hint, probe, deadline);
}

export function memoryClientRoot(home = homedir()) {
	return join(home, ".pharaoh", "project-memory-client");
}

export function readActiveMemoryClients(home = homedir()) {
	try {
		const root = memoryClientRoot(home);
		const directory = lstatSync(root);
		if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077)
			return {};
		const path = join(root, "active.json");
		const file = lstatSync(path);
		if (!file.isFile() || file.uid !== process.getuid?.() || file.mode & 0o077 || file.size > 512)
			return {};
		const active = JSON.parse(readFileSync(path, "utf8"));
		return Object.fromEntries(
			Object.keys(LEGACY_SETTINGS).flatMap((client) => {
				const digest = active?.[client];
				return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)
					? [[client, digest]]
					: [];
			}),
		);
	} catch {
		return {};
	}
}

export function activeMemoryRuntime(client, directory, home = homedir()) {
	const digest = readActiveMemoryClients(home)[client];
	return Boolean(digest && directory === join(realpathSync(memoryClientRoot(home)), digest));
}

export async function readMemoryCredentials() {
	try {
		const { CREDENTIALS_PATH, readCredentials } = await import("./runtime/credentials.js");
		const stat = lstatSync(CREDENTIALS_PATH);
		if (
			stat.isFile() &&
			stat.uid === process.getuid?.() &&
			!(stat.mode & 0o077) &&
			stat.size <= 65_536
		)
			return readCredentials();
	} catch {
		// No current owner-private credential file.
	}
}
