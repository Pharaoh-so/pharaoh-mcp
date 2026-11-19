/** Native feed identity and compatibility lookup, restricted to bounded local filesystem reads. */
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { feedHash, feedRoot, readFeedJSON } from "./feed-io.mjs";
import { classifyFeedProfile } from "./feed-profiles.mjs";
import { readFeedSignIn } from "./feed-signin.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Read a committed sign-in generation; pending/withdrawn/inconsistent state is unavailable. */
export function readFeedSignInGeneration(options = {}) {
	return (
		readFeedSignIn(
			options.credentialsPath ?? join(options.home ?? homedir(), ".pharaoh", "credentials.json"),
		)?.generation ?? null
	);
}
/** Validate an HTTP(S) origin without credentials, query, fragment or remote plaintext transport. */
export function feedServerOrigin(value) {
	try {
		const url = new URL(value);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(url.protocol !== "https:" &&
				!(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
		)
			return null;
		return url.origin;
	} catch {
		return null;
	}
}
/** Resolve one canonical worktree root, including linked worktrees, without invoking Git. */
export function resolveFeedCheckout(cwd) {
	if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.length > 4096) return null;
	let current;
	try {
		current = realpathSync(cwd);
		if (!lstatSync(current).isDirectory()) return null;
	} catch {
		return null;
	}
	for (let parents = 0; parents < 32; parents++) {
		const marker = join(current, ".git");
		let fd;
		try {
			const stat = lstatSync(marker);
			if (stat.isDirectory()) return current;
			if (!stat.isFile() || stat.size > 4096) return null;
			fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			const opened = fstatSync(fd);
			if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile()) return null;
			const bytes = Buffer.alloc(4097);
			const length = readSync(fd, bytes, 0, bytes.length, 0);
			const match =
				length <= 4096 &&
				/^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(bytes.subarray(0, length).toString("utf8"));
			if (!match || !lstatSync(realpathSync(resolve(current, match[1]))).isDirectory()) return null;
			return current;
		} catch (error) {
			if (error.code !== "ENOENT") return null;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

function sameMetadata(left, right) {
	return (
		left.ino === right.ino &&
		left.dev === right.dev &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function readGitMetadata(path, limit = 4096) {
	let fd;
	try {
		const before = lstatSync(path);
		if (!before.isFile() || before.size > limit) return;
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(fd);
		if (!opened.isFile() || !sameMetadata(before, opened)) return;
		const bytes = Buffer.alloc(limit + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		if (
			length > limit ||
			!sameMetadata(opened, fstatSync(fd)) ||
			!sameMetadata(opened, lstatSync(path))
		)
			return;
		return { text: bytes.subarray(0, length).toString("utf8"), stat: opened };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Hash the physical checkout and captured Git configuration, never source or credentials. */
export function feedCheckoutIdentity(checkout) {
	try {
		if (resolveFeedCheckout(checkout) !== checkout) return null;
		const root = lstatSync(checkout);
		const markerPath = join(checkout, ".git");
		const marker = lstatSync(markerPath);
		let gitDir = markerPath;
		let pointer = "";
		if (!marker.isDirectory()) {
			const captured = readGitMetadata(markerPath);
			const match = captured && /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(captured.text);
			if (!match) return null;
			pointer = captured.text;
			gitDir = realpathSync(resolve(checkout, match[1]));
		}
		const git = lstatSync(gitDir);
		if (!git.isDirectory()) return null;
		let commonDir = gitDir;
		let commonPointer = "";
		try {
			const common = readGitMetadata(join(gitDir, "commondir"));
			if (!common || !/^[^\r\n\0]+\r?\n?$/.test(common.text)) return null;
			commonPointer = common.text;
			commonDir = realpathSync(resolve(gitDir, common.text.trim()));
		} catch (error) {
			if (error.code !== "ENOENT") return null;
		}
		const common = lstatSync(commonDir);
		if (!common.isDirectory()) return null;
		let config = "";
		try {
			const captured = readGitMetadata(join(commonDir, "config"), 65_536);
			if (!captured) return null;
			config = captured.text;
		} catch (error) {
			if (error.code !== "ENOENT") return null;
		}
		const after = lstatSync(checkout);
		const gitAfter = lstatSync(gitDir);
		if (
			root.dev !== after.dev ||
			root.ino !== after.ino ||
			git.dev !== gitAfter.dev ||
			git.ino !== gitAfter.ino
		)
			return null;
		return feedHash(
			JSON.stringify([
				checkout,
				root.dev,
				root.ino,
				gitDir,
				git.dev,
				git.ino,
				pointer,
				commonDir,
				common.dev,
				common.ino,
				commonPointer,
				config,
			]),
		);
	} catch {
		return null;
	}
}

/**
 * Read only a stable, bounded Git HEAD without executing repository configuration.
 * @param checkout Canonical checkout root established by resolveFeedCheckout.
 * @returns The local branch, null for a detached commit, or undefined when unavailable.
 */
export function readFeedBranch(checkout) {
	if (typeof checkout !== "string" || !isAbsolute(checkout) || checkout.length > 4096) return;
	try {
		if (realpathSync(checkout) !== checkout) return;
		const root = lstatSync(checkout);
		if (!root.isDirectory()) return;
		const markerPath = join(checkout, ".git");
		const marker = lstatSync(markerPath);
		let metadataPath = markerPath;
		let pointer;
		if (!marker.isDirectory()) {
			pointer = readGitMetadata(markerPath);
			const match = pointer && /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(pointer.text);
			if (!match) return;
			metadataPath = resolve(checkout, match[1]);
		}
		const metadata = lstatSync(metadataPath);
		if (!metadata.isDirectory()) return;
		const canonicalMetadata = realpathSync(metadataPath);
		const head = readGitMetadata(join(canonicalMetadata, "HEAD"));
		const rootAfter = lstatSync(checkout);
		const metadataAfter = lstatSync(metadataPath);
		const markerAfter = lstatSync(markerPath);
		if (
			!head ||
			!rootAfter.isDirectory() ||
			!metadataAfter.isDirectory() ||
			root.ino !== rootAfter.ino ||
			root.dev !== rootAfter.dev ||
			metadata.ino !== metadataAfter.ino ||
			metadata.dev !== metadataAfter.dev ||
			(marker.isDirectory()
				? !markerAfter.isDirectory() ||
					marker.ino !== markerAfter.ino ||
					marker.dev !== markerAfter.dev
				: !markerAfter.isFile() || !sameMetadata(pointer.stat, markerAfter))
		)
			return;
		if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})\r?\n?$/i.test(head.text)) return null;
		const branch = /^ref: refs\/heads\/([^\r\n\0]+)\r?\n?$/.exec(head.text)?.[1];
		if (
			!branch ||
			branch.length > 256 ||
			[...branch].some(
				(character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
			) ||
			/[~^:?*[\\]/.test(branch) ||
			branch.includes("..") ||
			branch.includes("@{") ||
			branch.endsWith(".") ||
			branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
		)
			return;
		return branch;
	} catch {
		return undefined;
	}
}
/** Produce identical scoped bytes in the proxy and native hook; server argv means only the --server option. */
export function deriveFeedCohortKey(scope) {
	if (
		!scope ||
		!["codex", "claude-code"].includes(scope.client) ||
		!UUID.test(scope.registration) ||
		!UUID.test(scope.signIn) ||
		typeof scope.checkout !== "string" ||
		!isAbsolute(scope.checkout)
	)
		return null;
	const origin = feedServerOrigin(scope.server);
	const argv = scope.serverArgv ?? [];
	if (
		!origin ||
		!Array.isArray(argv) ||
		!(
			argv.length === 0 ||
			(argv.length === 2 && argv[0] === "--server" && feedServerOrigin(argv[1]) === origin)
		)
	)
		return null;
	return feedHash(
		JSON.stringify([
			1,
			scope.client,
			scope.registration,
			origin,
			argv,
			scope.signIn,
			scope.checkout,
		]),
	);
}
/** Read one installed adapter registration independently of the current credential path. */
export function readFeedRegistration(options) {
	if (!options || !["codex", "claude-code"].includes(options.client)) return null;
	const registration = readFeedJSON(
		join(feedRoot({ home: options.home }), `registration-${options.client}.json`),
		1024,
	);
	return registration?.version === 1 &&
		registration.client === options.client &&
		UUID.test(registration.registration ?? "")
		? registration.registration
		: null;
}
/** Read a live whole-cohort profile; metadata selects output compatibility and never authorizes repository data. */
export function resolveFeedProfile(options) {
	const unavailable = {
		admit: false,
		basis: "cohort",
		exactVersion: "unknown",
		reason: "unavailable",
	};
	if (
		!options ||
		!/^[a-f0-9]{64}$/.test(options.cohort ?? "") ||
		readFeedRegistration(options) !== options.registration
	)
		return unavailable;
	const activeSignIn = readFeedSignInGeneration(options);
	if (!activeSignIn) return unavailable;
	const summary = readFeedJSON(join(feedRoot(options), "cohorts", `${options.cohort}.json`));
	const now = options.now ?? Date.now();
	const failurePath = join(feedRoot(options), `registry-failure-${options.cohort}.json`);
	try {
		lstatSync(failurePath);
		const failure = readFeedJSON(failurePath, 1024);
		if (!failure || !Number.isFinite(failure.until) || failure.until > now) return unavailable;
	} catch (error) {
		if (error.code !== "ENOENT") return unavailable;
	}
	if (
		!summary ||
		summary.version !== 1 ||
		summary.cohort !== options.cohort ||
		summary.suppressed ||
		!Array.isArray(summary.connections) ||
		summary.connections.length > 32
	)
		return unavailable;
	if (
		summary.connections.some(
			(entry) =>
				!entry ||
				!UUID.test(entry.id ?? "") ||
				entry.cohort !== options.cohort ||
				entry.signIn !== activeSignIn ||
				!Number.isFinite(entry.leaseExpiresAt) ||
				!["pending", "initialized"].includes(entry.state) ||
				!["codex", "claude-code"].includes(entry.client),
		)
	)
		return { ...unavailable, reason: "incompatible" };
	const choicePath = join(feedRoot({ home: options.home }), `choice-${options.client}.json`);
	const choice = readFeedJSON(choicePath, 1024);
	try {
		if (lstatSync(choicePath) && (!choice || choice.version !== 1 || choice.enabled !== true))
			return { ...unavailable, reason: "disabled" };
	} catch (error) {
		if (error.code !== "ENOENT") return unavailable;
	}
	const live = summary.connections.filter((entry) => entry.leaseExpiresAt > now);
	if (!live.length) return unavailable;
	let exact;
	for (const entry of live) {
		const profile = classifyFeedProfile(entry.name, entry.clientVersion, options.event);
		if (
			entry.state !== "initialized" ||
			!profile ||
			profile.client !== options.client ||
			entry.cohort !== options.cohort
		)
			return { ...unavailable, reason: "incompatible" };
		if (entry.id === options.exactConnectionId) exact = entry;
	}
	if (options.exactConnectionId && !exact) return unavailable;
	return {
		admit: true,
		basis: exact ? "exact" : "cohort",
		exactVersion: exact?.clientVersion ?? "unknown",
		contract: "additional-context-v1",
		reason: "compatible",
	};
}
