/** Small credential-lifecycle markers for the native feed; no tokens or network enter this module. */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = 2048;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const credentialsFile = (value) =>
	resolve(value ?? join(homedir(), ".pharaoh", "credentials.json"));

/** Locate markers beside the selected credentials; alternate credential files never share a feed root. */
export function feedRootForCredentials(path) {
	const file = credentialsFile(path);
	return join(
		dirname(file),
		"private",
		basename(file) === "credentials.json" ? "feed" : `feed-${hash(file).slice(0, 24)}`,
	);
}

function privateEntry(path, directory = false) {
	const stat = lstatSync(path);
	if (
		process.platform === "win32" ||
		typeof process.getuid !== "function" ||
		stat.uid !== process.getuid() ||
		(stat.mode & 0o077) !== 0 ||
		(directory ? !stat.isDirectory() : !stat.isFile())
	)
		throw new Error("Native feed state is not owner-private.");
	return stat;
}

function read(path) {
	let fd;
	try {
		privateEntry(dirname(dirname(dirname(path))), true);
		privateEntry(dirname(dirname(path)), true);
		privateEntry(dirname(path), true);
		const stat = privateEntry(path);
		if (stat.size > LIMIT) return null;
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(fd);
		if (
			!opened.isFile() ||
			opened.ino !== stat.ino ||
			opened.dev !== stat.dev ||
			opened.size > LIMIT
		)
			return null;
		const bytes = Buffer.alloc(LIMIT + 1);
		const size = readSync(fd, bytes, 0, bytes.length, 0);
		if (size > LIMIT) return null;
		return JSON.parse(bytes.subarray(0, size).toString("utf8"));
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function ensureRoot(file) {
	const base = dirname(file);
	privateEntry(base, true);
	const root = feedRootForCredentials(file);
	for (const path of [join(base, "private"), root]) {
		try {
			privateEntry(path, true);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			try {
				mkdirSync(path, { mode: 0o700 });
			} catch (race) {
				if (race.code !== "EEXIST") throw race;
			}
			privateEntry(path, true);
		}
	}
	return root;
}

function write(root, name, value) {
	privateEntry(root, true);
	const target = join(root, name);
	try {
		privateEntry(target);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > LIMIT) throw new Error("Native feed marker is oversized.");
	const temporary = join(root, `${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function credentialGeneration(path) {
	let fd;
	try {
		const stat = privateEntry(path);
		if (stat.size > 65_536) return null;
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = fstatSync(fd);
		if (
			!opened.isFile() ||
			opened.ino !== stat.ino ||
			opened.dev !== stat.dev ||
			opened.size > 65_536
		)
			return null;
		const bytes = Buffer.alloc(65_537);
		const size = readSync(fd, bytes, 0, bytes.length, 0);
		if (size > 65_536) return null;
		const value = JSON.parse(bytes.subarray(0, size).toString("utf8"))?.native_feed_generation;
		return typeof value === "string" && UUID.test(value) ? value : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Read only a committed sign-in generation whose marker and lifecycle agree. */
export function readFeedSignIn(path) {
	const file = credentialsFile(path);
	const root = feedRootForCredentials(file);
	try {
		privateEntry(file);
	} catch {
		return null;
	}
	const generation = credentialGeneration(file);
	if (!generation) return null;
	const marker = read(join(root, "signin.json"));
	const state = read(join(root, "lifecycle.json"));
	if (
		!marker ||
		!state ||
		marker.version !== 1 ||
		state.version !== 1 ||
		state.state !== "active" ||
		!UUID.test(marker.generation) ||
		marker.generation !== generation ||
		state.generation !== marker.generation ||
		marker.credentialPath !== hash(file) ||
		state.credentialPath !== marker.credentialPath ||
		state.server !== marker.server ||
		typeof marker.server !== "string"
	)
		return null;
	try {
		if (new URL(marker.server).origin !== marker.server) return null;
	} catch {
		return null;
	}
	if (credentialGeneration(file) !== generation) return null;
	return { generation: marker.generation, server: marker.server, root };
}

/** Start a replacement under the credential lock; old feed data becomes unreadable immediately. */
export function beginFeedSignIn(server, path, generation = randomUUID()) {
	const file = credentialsFile(path);
	const root = ensureRoot(file);
	if (!UUID.test(generation)) throw new Error("Invalid native feed generation.");
	const canonical = new URL(server).origin;
	const state = {
		version: 1,
		state: "pending",
		generation,
		server: canonical,
		credentialPath: hash(file),
	};
	write(root, "lifecycle.json", state);
	rmSync(join(root, "signin.json"), { force: true });
	return state;
}

/** Publish a successful authorization under the credential lock after writing credentials. */
export function commitFeedSignIn(pending, path) {
	const file = credentialsFile(path);
	const root = ensureRoot(file);
	const current = read(join(root, "lifecycle.json"));
	if (
		!current ||
		current.state !== "pending" ||
		current.generation !== pending.generation ||
		pending.credentialPath !== hash(file)
	)
		throw new Error("Native feed authorization changed.");
	const { state: _state, ...marker } = pending;
	write(root, "signin.json", marker);
	write(root, "lifecycle.json", { ...pending, state: "active" });
	return pending.generation;
}

/** Withdraw the active generation under the credential lock, retaining an explicit no-bootstrap fence. */
export function withdrawFeedSignIn(path) {
	const file = credentialsFile(path);
	const root = ensureRoot(file);
	write(root, "lifecycle.json", { version: 1, state: "withdrawn", credentialPath: hash(file) });
	rmSync(join(root, "signin.json"), { force: true });
}

/** Initialize truly legacy state after install revalidated existing credentials; caller owns the credential lock. */
export function bootstrapFeedSignIn(server, path, persistGeneration) {
	const file = credentialsFile(path);
	const root = ensureRoot(file);
	const active = readFeedSignIn(file);
	if (active) return active.server === new URL(server).origin ? active.generation : null;
	for (const name of ["signin.json", "lifecycle.json"]) {
		try {
			lstatSync(join(root, name));
			return null;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	if (typeof persistGeneration !== "function") return null;
	const pending = beginFeedSignIn(server, file);
	persistGeneration(pending.generation);
	return commitFeedSignIn(pending, file);
}
