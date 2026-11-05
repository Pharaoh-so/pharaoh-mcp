import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const TURN_TTL = 12 * 60 * 60 * 1000;
const LOCK_MIN_AGE = 15_000;
const LOCK_OWNER = /^owner-[a-f0-9-]{36}\.json$/;
const TOKEN = /^[a-f0-9]{64}$/;
const GIT = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find(existsSync);
export const hasMemoryGit = Boolean(GIT);
const GIT_TIMEOUT_MS = 750;
const VISIBLE_INDEX_TAG = Buffer.from("H ");
export const REPO = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i;

function gitProcess(cwd, args) {
	if (!GIT) throw new Error("Project memory could not locate a system Git executable.");
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
		GIT_NO_LAZY_FETCH: "1",
		GIT_ALLOW_PROTOCOL: "",
	};
	return {
		args: [
			"--no-optional-locks",
			"--no-replace-objects",
			"--no-pager",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"-C",
			cwd,
			...args,
		],
		env,
		stdio: ["ignore", "pipe", "ignore"],
	};
}

export function git(cwd, ...command) {
	return gitBefore(cwd, Infinity, ...command);
}

export function gitBefore(cwd, deadline, ...command) {
	const { args, ...options } = gitProcess(cwd, command);
	const timeout = Math.min(GIT_TIMEOUT_MS, Math.floor(deadline - performance.now()));
	if (timeout < 1) throw new Error("Project memory Git deadline expired.");
	return execFileSync(GIT, args, {
		...options,
		encoding: "utf8",
		maxBuffer: 8192,
		timeout,
		killSignal: "SIGKILL",
	}).trim();
}

/** Check one literal path or the entire index for flags that can hide worktree edits. */
export async function visibleGitIndex(cwd, path) {
	try {
		const paths = path ? [`:(literal)${path}`] : [];
		const { args, ...options } = gitProcess(cwd, ["ls-files", "-v", "-z", "--", ...paths]);
		const signal = AbortSignal.timeout(GIT_TIMEOUT_MS);
		const child = spawn(GIT, args, {
			...options,
			signal,
			killSignal: "SIGKILL",
		});
		return await new Promise((resolve) => {
			let prefix = 0;
			let hasName = false;
			let sawEntry = false;
			let failed = false;
			let ended = false;
			function stop() {
				failed = true;
				child.stdout.destroy();
				child.kill("SIGKILL");
			}
			child.on("error", () => {
				failed = true;
			});
			child.stdout.once("end", () => {
				ended = true;
			});
			child.stdout.on("error", stop);
			child.stdout.on("data", (chunk) => {
				// Only H is visible. Lowercase tags and S can hide changed files.
				// Names can contain newlines. Carry only framing state across chunks.
				for (const byte of chunk) {
					if (prefix < VISIBLE_INDEX_TAG.length) {
						if (byte !== VISIBLE_INDEX_TAG[prefix]) return stop();
						prefix++;
					} else if (byte === 0) {
						if (!hasName) return stop();
						sawEntry = true;
						prefix = 0;
						hasName = false;
					} else {
						hasName = true;
					}
				}
			});
			child.once("close", (code) =>
				resolve(!failed && !signal.aborted && code === 0 && ended && sawEntry && prefix === 0),
			);
		});
	} catch {
		return false;
	}
}

/** Accept only an unambiguous GitHub origin, independent of the branch name. */
export function checkout(cwd, deadline = Infinity) {
	if (typeof cwd !== "string" || !isAbsolute(cwd)) return;
	try {
		const root = realpathSync(gitBefore(cwd, deadline, "rev-parse", "--show-toplevel"));
		const origin = gitBefore(root, deadline, "config", "--local", "--get-all", "remote.origin.url");
		const repo = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^\n]+)$/i
			.exec(origin)?.[1]
			.replace(/\.git$/i, "");
		if (repo && REPO.test(repo)) return { root, repo };
	} catch {
		// Non-repositories and unreadable worktrees are outside the pilot.
	}
}

export function shellWord(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function readStdin(maxBytes) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		bytes += chunk.length;
		if (bytes > maxBytes) throw new Error("Input exceeds the size limit.");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function atomicWrite(path, contents) {
	const temporary = join(dirname(path), `.pharaoh-memory-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function readJson(path) {
	try {
		const file = lstatSync(path);
		if (!file.isFile() || (file.mode & 0o077) !== 0 || file.size > 8192) return;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// State can expire or be removed by another event.
	}
}

function makePrivateDirectory(path) {
	mkdirSync(path, { mode: 0o700, recursive: true });
	const info = lstatSync(path);
	if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
		throw new Error("Project memory needs a private local state directory.");
	}
}

export function sessionKey(client, sessionId) {
	if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256) return;
	return createHash("sha256").update(`${client}\0${sessionId}`).digest("hex");
}

function releaseLock(path, owner) {
	try {
		unlinkSync(join(path, owner));
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	try {
		rmdirSync(path);
	} catch (error) {
		// A replacement always appears already populated, so rmdir cannot remove it.
		if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
	}
}

function acquireLock(directory, path, now) {
	const owner = `owner-${randomUUID()}.json`;
	const candidate = mkdtempSync(join(directory, "lock-candidate-"));
	try {
		writeFileSync(join(candidate, owner), JSON.stringify({ pid: process.pid, createdAt: now }), {
			flag: "wx",
			mode: 0o600,
		});
		// POSIX rename installs the prepared directory only if the destination is
		// absent or empty. No process can see a new lock without its owner marker.
		renameSync(candidate, path);
		return () => releaseLock(path, owner);
	} catch (error) {
		if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
	} finally {
		rmSync(candidate, { recursive: true, force: true });
	}
}

function recoverLock(path, now) {
	let entries;
	try {
		entries = readdirSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return true;
		throw error;
	}
	if (entries.length === 0) return true;
	if (entries.length !== 1 || !LOCK_OWNER.test(entries[0])) return false;
	const [owner] = entries;
	const metadata = readJson(join(path, owner));
	if (
		!Number.isInteger(metadata?.pid) ||
		metadata.pid < 1 ||
		metadata.pid > 2_147_483_647 ||
		!Number.isFinite(metadata.createdAt) ||
		now - metadata.createdAt < LOCK_MIN_AGE
	)
		return false;
	try {
		process.kill(metadata.pid, 0);
		return false;
	} catch (error) {
		// A reused PID, a live owner, or inability to confirm death keeps the lock.
		if (error.code !== "ESRCH") return false;
	}
	releaseLock(path, owner);
	return true;
}

/** Serialize local state transitions only; network operations never hold this lock. */
export function turnStore(home = homedir(), now = Date.now) {
	const directory = join(home, ".pharaoh", "project-memory-turns-v2");
	makePrivateDirectory(directory);
	const sessionPath = (key) => join(directory, `session-${key}.json`);
	const indexPath = (token) => join(directory, `turn-${token}.json`);
	const overlapPath = (key) => join(directory, `overlap-${key}.json`);
	const receiptPath = (token) => join(directory, `receipt-${token}.json`);
	function current(key) {
		const state = readJson(sessionPath(key));
		if (!state || state.expires > now()) return state;
		remove(key, state);
	}
	function put(key, state) {
		atomicWrite(sessionPath(key), JSON.stringify(state));
	}
	function remove(key, state) {
		if (TOKEN.test(state?.token)) rmSync(indexPath(state.token), { force: true });
		rmSync(sessionPath(key), { force: true });
	}
	function lock(key, fn, { onBusy, canClearFence, onFence } = {}) {
		if (!TOKEN.test(key)) return;
		const path = join(directory, `${key}.lock`);
		const time = now();
		const release =
			acquireLock(directory, path, time) ??
			(recoverLock(path, time) ? acquireLock(directory, path, time) : undefined);
		if (!release) return onBusy?.();
		try {
			const stored = readJson(overlapPath(key));
			const fence = typeof stored === "number" ? { expires: stored } : stored;
			const active = fence?.expires > time;
			if (active && !canClearFence?.(fence)) return onFence?.();
			if (stored !== undefined) rmSync(overlapPath(key), { force: true });
			return fn(current(key), active);
		} finally {
			release();
		}
	}
	function fence(key, nativeTurn) {
		atomicWrite(overlapPath(key), JSON.stringify({ nativeTurn, expires: now() + TURN_TTL }));
	}
	function sameCheckout(state, target) {
		return (
			state?.root === target.root &&
			state.repo.toLowerCase() === target.repo.toLowerCase() &&
			state.runtime === target.runtime
		);
	}
	function withTurn(token, target, fn) {
		if (!TOKEN.test(token)) return;
		const key = readJson(indexPath(token));
		if (typeof key !== "string") return;
		return lock(key, (state) => {
			if (sameCheckout(state, target) && state.token === token) return fn(key, state);
		});
	}
	function close(key, state) {
		if (!state.nativeTurn) return remove(key, state);
		if (TOKEN.test(state.token)) rmSync(indexPath(state.token), { force: true });
		put(key, { ...state, token: undefined, phase: "closed" });
	}
	function saveReceipt(token, target, outcome, record) {
		if (!TOKEN.test(token)) return;
		atomicWrite(
			receiptPath(token),
			JSON.stringify({
				...target,
				outcome,
				record: record && { id: record.id, status: record.status },
				expires: now() + TURN_TTL,
			}),
		);
	}
	return {
		begin(key, target, client, nativeTurn, { skip, readOnly, memorySession }) {
			return lock(
				key,
				(previous) => {
					if (previous) {
						if (nativeTurn && previous.nativeTurn === nativeTurn) {
							// Duplicate native events belong to the same task. Keep its
							// token unless the user expressly opted out of this turn.
							if (skip) close(key, previous);
							return;
						}
						if (nativeTurn) {
							// A new native turn cannot be mistaken for an earlier Stop or CLI result.
							remove(key, previous);
						} else {
							if (TOKEN.test(previous.token)) rmSync(indexPath(previous.token), { force: true });
							put(key, { ...previous, phase: "ambiguous" });
							return { degraded: "overlap" };
						}
					}
					if (skip) return;
					const token = randomBytes(32).toString("hex");
					const state = {
						...target,
						client,
						nativeTurn,
						token,
						operationId: randomUUID(),
						expires: now() + TURN_TTL,
						phase: "pending",
						readOnly,
						memorySession,
					};
					atomicWrite(indexPath(token), JSON.stringify(key));
					put(key, state);
					return { token };
				},
				{
					onBusy: () => {
						fence(key, nativeTurn);
						return { degraded: "busy" };
					},
					canClearFence: (entry) => Boolean(nativeTurn && entry.nativeTurn !== nativeTurn),
					onFence: () => ({ degraded: "overlap" }),
				},
			);
		},
		startCapture(token, target, memorySession, send) {
			return withTurn(token, target, (key, state) => {
				if (
					state.phase !== "recalled" ||
					state.readOnly ||
					!memorySession ||
					state.memorySession !== memorySession
				)
					return;
				put(key, { ...state, phase: "capturing" });
				saveReceipt(token, target, "uncertain");
				if (readJson(overlapPath(key))?.expires > now()) {
					rmSync(receiptPath(token), { force: true });
					return;
				}
				// Begin dispatch under the turn lease. Await the response outside it.
				return send({ repo: state.repo, client: state.client, operationId: state.operationId });
			});
		},
		stop(key, target, nativeTurn) {
			lock(
				key,
				(state) => {
					if (
						sameCheckout(state, target) &&
						state.nativeTurn === nativeTurn &&
						(state.phase !== "ambiguous" || nativeTurn)
					)
						close(key, state);
				},
				{
					onBusy: () => fence(key, nativeTurn),
					canClearFence: (entry) => Boolean(nativeTurn && nativeTurn === entry.nativeTurn),
				},
			);
		},
		cancel(key, target, nativeTurn) {
			lock(
				key,
				(state) => {
					if (sameCheckout(state, target) && (!nativeTurn || state.nativeTurn === nativeTurn)) {
						if (nativeTurn) close(key, state);
						else remove(key, state);
					}
				},
				{
					onBusy: () => fence(key, nativeTurn),
					canClearFence: (entry) => !nativeTurn || entry.nativeTurn === nativeTurn,
				},
			);
		},
		transition(token, target, from, to) {
			return withTurn(token, target, (key, state) => {
				if (!from.includes(state.phase)) return;
				put(key, { ...state, phase: to });
				return state;
			});
		},
		finishRecall(token, target, pairs) {
			return withTurn(token, target, (key, state) => {
				if (state.phase !== "recalling") return;
				put(key, { ...state, phase: "recalled", pairs, expansions: 0 });
				return true;
			});
		},
		beginExpand(token, target, id, version) {
			return withTurn(token, target, (key, state) => {
				if (
					state.phase !== "recalled" ||
					state.expansions >= 2 ||
					!state.pairs?.some(
						([recordId, recordVersion]) => recordId === id && recordVersion === version,
					)
				)
					return;
				const expansions = state.expansions + 1;
				put(key, { ...state, phase: "expanding", expansions });
				return { repo: state.repo, attempt: expansions };
			});
		},
		finishExpand(token, target, attempt) {
			return withTurn(token, target, (key, state) => {
				if (state.phase !== "expanding" || state.expansions !== attempt) return;
				put(key, { ...state, phase: "recalled" });
				return true;
			});
		},
		saveReceipt,
		readReceipt(token, target) {
			if (!TOKEN.test(token)) return;
			const path = receiptPath(token);
			const receipt = readJson(path);
			if (receipt && receipt.expires <= now()) {
				rmSync(path, { force: true });
				return;
			}
			if (sameCheckout(receipt, target))
				return {
					outcome: receipt.outcome ?? "confirmed",
					...(receipt.record && { record: receipt.record }),
				};
		},
	};
}
