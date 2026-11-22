/** Permissioned local verifier; snapshots and raw diagnostics never leave this machine. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommand } from "./capture.mjs";
import {
	cleanupReviewRuns,
	readReviewRun,
	reviewManifest,
	reviewPath,
	writeReviewRun,
} from "./change-review.mjs";
import { safeRecap } from "./execute-turn.mjs";
import { atomicWrite, gitRawBefore, shellWord } from "./local.mjs";
import { changeReviewEnabled } from "./preferences.mjs";

const MAX_INPUT = 128 * 1024 * 1024,
	MAX_TEST = 2 * 1024 * 1024,
	MAX_OUTPUT = 512 * 1024;
const TIMEOUT = 60_000;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const sha = (v) => createHash("sha256").update(v).digest("hex");
const script = fileURLToPath(import.meta.url);
const inside = (root, path) => path === root || path.startsWith(`${root}${sep}`);
function environmentIdentity() {
	const ignored = new Set([
		"PWD",
		"OLDPWD",
		"_",
		"SHLVL",
		"NODE_OPTIONS",
		"NODE_PATH",
		"CI",
		"FORCE_COLOR",
	]);
	return sha(
		JSON.stringify(
			Object.entries(process.env)
				.filter(([key]) => !ignored.has(key))
				.sort(([a], [b]) => a.localeCompare(b)),
		),
	);
}
function current(run, cwd) {
	const root = realpathSync(
		gitRawBefore(cwd, 8192, Infinity, "rev-parse", "--show-toplevel").trim(),
	);
	if (root !== run.root) throw new Error("Review belongs to a different checkout.");
	if (!changeReviewEnabled(run.home, run.scope)) throw new Error("Change review is disabled.");
	return reviewManifest(root);
}
function area(directory, id) {
	return join(directory, `files-${id}`);
}
function copySource(root, destination, manifest) {
	if (inside(root, destination))
		throw new Error("Review copies must stay outside the working tree.");
	mkdirSync(destination, { recursive: true, mode: 0o700 });
	let bytes = 0;
	for (const name of manifest.files) {
		const from = join(root, reviewPath(root, name));
		const stat = lstatSync(from, { throwIfNoEntry: false });
		if (!stat) continue;
		bytes += stat.size;
		if (bytes > MAX_INPUT) throw new Error("Snapshot is too large.");
		const to = join(destination, name);
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		if (stat.isSymbolicLink()) {
			const target = realpathSync(from);
			if (!inside(root, target) || !lstatSync(target).isFile())
				throw new Error("Source link is not confined.");
			symlinkSync(relative(dirname(to), join(destination, manifest.links[name].resolved)), to);
		} else if (stat.isFile()) copyFileSync(from, to);
		else throw new Error("Only regular source files and internal file links are supported.");
	}
	for (const name of [
		"package.json",
		...manifest.files.filter((f) => f.endsWith("/package.json")),
	]) {
		const folder = dirname(name),
			deps = join(root, folder, "node_modules");
		if (!existsSync(deps)) continue;
		const to = join(destination, folder, "node_modules");
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		symlinkSync(realpathSync(deps), to, "dir");
	}
}
/** Installed third-party dependencies are shared unchanged; live workspace-source links are refused. */
function dependencyIdentity(root, manifest) {
	const hash = createHash("sha256"),
		visited = new Set();
	let entries = 0,
		bytes = 0;
	const deadline = performance.now() + 10_000;
	function scan(path) {
		if (++entries > 250_000 || performance.now() > deadline)
			throw new Error("Dependency inspection exceeds limit.");
		const s = lstatSync(path),
			link = s.isSymbolicLink() ? realpathSync(path) : null;
		hash.update(JSON.stringify([path, s.isDirectory() ? "directory" : "file", link]));
		if (link) {
			if (
				!link.split(sep).includes("node_modules") ||
				(inside(root, link) && !relative(root, link).split(sep).includes("node_modules"))
			)
				throw new Error("Live workspace dependency links cannot be isolated.");
			const container = link.slice(
				0,
				link.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules`.length,
			);
			for (const target of [link, container])
				if (!visited.has(target)) {
					visited.add(target);
					scan(target);
				}
			return;
		}
		if (s.isFile()) {
			bytes += s.size;
			if (bytes > 1024 * 1024 * 1024) throw new Error("Dependency content exceeds limit.");
			hash.update(readFileSync(path));
		}
		if (s.isDirectory())
			for (const name of readdirSync(path).sort()) {
				if (![".cache", ".vite", ".vite-temp", ".vitest"].includes(name)) scan(join(path, name));
			}
	}
	for (const name of [
		"package.json",
		...manifest.files.filter((f) => f.endsWith("/package.json")),
	]) {
		const path = join(root, dirname(name), "node_modules");
		if (!existsSync(path)) continue;
		const real = realpathSync(path);
		if (!visited.has(real)) {
			visited.add(real);
			scan(real);
		}
	}
	return hash.digest("hex");
}
function bundle(root, names) {
	let bytes = 0;
	const files = [...new Set(names)].sort().map((name) => {
		name = reviewPath(root, name);
		if (!TEST_PATH.test(name))
			throw new Error("Only test and fixture inputs can overlay the saved candidate.");
		const data = readFileSync(join(root, name));
		bytes += data.length;
		if (bytes > MAX_TEST) throw new Error("Test inputs exceed limit.");
		return { name, hash: sha(data) };
	});
	return { files, hash: sha(JSON.stringify(files)) };
}
function overlay(root, target, files) {
	for (const { name } of files) {
		const to = join(target, name);
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		if (lstatSync(to, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(to);
		copyFileSync(join(root, name), to);
	}
}
function sameTestInputs(candidate, currentManifest, allowed) {
	const listed = new Set(allowed);
	const select = (manifest) =>
		manifest.fileHashes.filter(([name]) => TEST_PATH.test(name) && !listed.has(name));
	if (JSON.stringify(select(candidate)) !== JSON.stringify(select(currentManifest)))
		throw new Error("An unlisted test-side input changed.");
}
function assertSourceCopy(root, manifest) {
	for (const [name, expected] of manifest.fileHashes) {
		const path = join(root, reviewPath(root, name)),
			s = lstatSync(path, { throwIfNoEntry: false });
		if (
			s?.isSymbolicLink() &&
			readlinkSync(path) !== relative(dirname(path), join(root, manifest.links[name].resolved))
		)
			throw new Error("Saved candidate link changed.");
		const actual = !s
			? null
			: sha(
					Buffer.concat([
						Buffer.from(s.isSymbolicLink() ? `link:${manifest.links[name].target}\0` : "file\0"),
						readFileSync(path),
					]),
				);
		if (actual !== expected) throw new Error("Saved candidate was modified.");
	}
}
function acquire(directory, id) {
	const path = join(directory, `operation-${id}.lock`),
		owner = randomUUID();
	const base = join(directory, `files-${id}`);
	mkdirSync(base, { recursive: true, mode: 0o700 });
	const prepared = join(base, `lock-${owner}`);
	mkdirSync(prepared, { mode: 0o700 });
	writeFileSync(
		join(prepared, `owner-${owner}.json`),
		JSON.stringify({ owner, pid: process.pid, reviewId: id, createdAt: Date.now() }),
		{ mode: 0o600 },
	);
	try {
		if (existsSync(path)) {
			const info = lstatSync(path);
			if (
				!info.isDirectory() ||
				info.isSymbolicLink() ||
				info.mode & 0o077 ||
				info.uid !== process.getuid?.()
			)
				throw new Error("Unknown review lock.");
			const entries = readdirSync(path);
			if (!entries.length) {
				if (Date.now() - info.mtimeMs < 1000)
					throw new Error("A review operation is already running.");
			} else {
				if (entries.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(entries[0]))
					throw new Error("Unknown review lock.");
				const ownerFile = join(path, entries[0]),
					file = lstatSync(ownerFile);
				if (
					!file.isFile() ||
					file.isSymbolicLink() ||
					file.mode & 0o077 ||
					file.uid !== process.getuid?.()
				)
					throw new Error("Unknown review lock.");
				const prior = JSON.parse(readFileSync(ownerFile, "utf8"));
				if (
					prior.reviewId !== id ||
					entries[0] !== `owner-${prior.owner}.json` ||
					!Number.isFinite(prior.createdAt) ||
					prior.createdAt > Date.now() ||
					Date.now() - prior.createdAt < 1000 ||
					!Number.isInteger(prior.pid) ||
					prior.pid < 1 ||
					!/^[a-f0-9-]{36}$/.test(prior.owner)
				)
					throw new Error("Unknown review lock.");
				try {
					process.kill(prior.pid, 0);
					throw new Error("A review operation is already running.");
				} catch (check) {
					if (check.code !== "ESRCH") throw check;
				}
				unlinkSync(ownerFile);
				rmdirSync(path);
			}
		}
		// The visible lock always contains an owner; interruption cannot strand an empty lock.
		renameSync(prepared, path);
	} catch (error) {
		rmSync(prepared, { recursive: true, force: true });
		throw error;
	}
	return () => {
		try {
			unlinkSync(join(path, `owner-${owner}.json`));
			rmdirSync(path);
		} catch {
			/* Never remove another operation's populated lock. */
		}
	};
}
/** The child watchdog owns its process group and survives parent death long enough to kill every test worker. */
async function supervise(args) {
	const [parent, timeout, file, cwd, ...argv] = args;
	const kill = () => {
		try {
			process.kill(-process.pid, "SIGKILL");
		} catch {
			process.exit(1);
		}
	};
	const timer = setTimeout(kill, Number(timeout));
	const watch = setInterval(() => {
		try {
			process.kill(Number(parent), 0);
		} catch {
			kill();
		}
	}, 250);
	process.once("SIGTERM", kill);
	process.once("SIGINT", kill);
	const child = spawn(file, argv, { cwd, env: process.env, stdio: "inherit" });
	const code = await new Promise((done) => {
		child.once("error", () => done(1));
		child.once("close", done);
	});
	clearTimeout(timer);
	clearInterval(watch);
	process.exit(typeof code === "number" ? code : 1);
}
async function command(args, cwd, signal) {
	const env = { ...process.env, CI: "true", FORCE_COLOR: "0", PWD: cwd };
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
	return new Promise((done) => {
		const child = spawn(
			process.execPath,
			[script, "--run-child", String(process.pid), String(TIMEOUT), process.execPath, cwd, ...args],
			{ env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "",
			stopped = false;
		const kill = () => {
			stopped = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* already exited */
			}
		};
		const collect = (data) => {
			output += data;
			if (output.length > MAX_OUTPUT) kill();
		};
		signal.addEventListener("abort", kill, { once: true });
		if (signal.aborted) kill();
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", () =>
			done({ code: null, stopped: true, output: "Test process could not start." }),
		);
		child.on("close", (code) => {
			signal.removeEventListener("abort", kill);
			done({ code, stopped, output: output.slice(-8192) });
		});
	});
}
async function vitest(root, copy, file, name, signal) {
	const executable = join(root, "node_modules/vitest/vitest.mjs");
	if (!existsSync(executable)) throw new Error("Install local Vitest dependencies before review.");
	const reportName = ".pharaoh-proof.json",
		report = join(copy, reportName);
	const argv = ["run", file, "--maxWorkers", "1", "--reporter=json", `--outputFile=${reportName}`];
	if (name) argv.push("--testNamePattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
	const result = await command([executable, ...argv], copy, signal);
	let data;
	try {
		const s = lstatSync(report);
		if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_OUTPUT) throw new Error();
		data = JSON.parse(readFileSync(report, "utf8"));
	} catch {
		/* No valid report means no proof. */
	}
	rmSync(report, { force: true });
	const suites = data?.testResults;
	const suite = Array.isArray(suites)
		? suites.filter((s) => {
				try {
					const reported = realpathSync(s.name),
						canonical = realpathSync(copy);
					return (
						inside(canonical, reported) &&
						relative(canonical, reported).split(sep).join("/") === file
					);
				} catch {
					return false;
				}
			})
		: [];
	const assertions =
		suite.length === 1 && Array.isArray(suite[0].assertionResults) ? suite[0].assertionResults : [];
	const selected = name ? assertions.filter((test) => test.fullName === name) : assertions;
	const error =
		!Array.isArray(suites) || suites.length !== 1 || suite.length !== 1 || !assertions.length;
	const pass =
		!error &&
		!result.stopped &&
		result.code === 0 &&
		selected.length > 0 &&
		selected.every((t) => t.status === "passed") &&
		(name || assertions.every((t) => t.status === "passed"));
	const failure =
		!error &&
		!result.stopped &&
		result.code === 1 &&
		selected.length === 1 &&
		selected[0].status === "failed" &&
		assertions.filter((t) => t.status === "failed").length === 1 &&
		selected[0].failureMessages?.some((m) => /AssertionError/.test(m));
	const safeCommand = checkCommand(
		["node", "node_modules/vitest/vitest.mjs", ...argv.map(shellWord)].join(" "),
	)?.command;
	return {
		pass: Boolean(pass),
		failure: Boolean(failure),
		code: result.code,
		test: name,
		suite: file,
		tests: assertions.map((t) => ({ name: t.fullName, status: t.status })),
		command: safeCommand,
		output: result.output,
		failureMessage: failure ? selected[0].failureMessages.join("\n").slice(0, 6000) : undefined,
	};
}
function options(argv) {
	const [operation, id, ...rest] = argv;
	const result = { operation, id, fixtures: [], regressions: [], repairs: [] };
	for (let i = 0; i < rest.length; i += 2) {
		const value = rest[i + 1];
		if (value === undefined) throw new Error("Missing review option value.");
		const key = rest[i];
		if (key === "--directory") result.directory = resolve(value);
		else if (key === "--test") result.test = value;
		else if (key === "--name") result.name = value;
		else if (key === "--finding") result.finding = value;
		else if (key === "--fixture") result.fixtures.push(value);
		else if (key === "--regression") result.regressions.push(value);
		else if (key === "--repair") result.repairs.push(value);
		else throw new Error("Unknown review option.");
	}
	if (
		!result.directory ||
		!["snapshot", "before", "after"].includes(operation) ||
		result.regressions.length > 3 ||
		result.repairs.length > 3
	)
		throw new Error("Expected a bounded snapshot, before or after operation.");
	return result;
}
/** Run proof operations under normal agent permissions. Returned JSON deliberately contains no raw diagnostics. */
export async function runChangeReview(argv, { cwd = process.cwd() } = {}) {
	const opts = options(argv);
	cleanupReviewRuns(opts.directory);
	opts.directory = realpathSync(opts.directory);
	const run = readReviewRun(opts.directory, opts.id),
		manifest = current(run, cwd);
	if (inside(run.root, opts.directory)) throw new Error("Review state must be outside checkout.");
	const release = acquire(opts.directory, run.id),
		controller = new AbortController();
	const abort = () => controller.abort();
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	let attempt;
	try {
		const base = area(opts.directory, run.id),
			candidate = join(base, "candidate");
		mkdirSync(base, { recursive: true, mode: 0o700 });
		if (opts.operation === "snapshot") {
			if (run.phase !== "reserved" || manifest.fingerprint !== run.candidate.fingerprint)
				throw new Error("The pre-review candidate changed before its snapshot.");
			run.dependencies = dependencyIdentity(run.root, manifest);
			attempt = mkdtempSync(join(base, "snapshot-"));
			copySource(run.root, attempt, manifest);
			if (reviewManifest(run.root).fingerprint !== manifest.fingerprint)
				throw new Error("Source changed during snapshot.");
			// A failed snapshot never becomes the candidate; retry starts from a fresh directory.
			if (existsSync(candidate)) rmSync(candidate, { recursive: true });
			renameSync(attempt, candidate);
			attempt = undefined;
			run.environment = environmentIdentity();
			run.phase = "snapshotted";
			writeReviewRun(opts.directory, run);
			return { status: "snapshotted", reviewId: run.id };
		}
		if (!run.graph)
			throw new Error("No successful Pharaoh graph answer was observed for this review.");
		if (
			manifest.configFingerprint !== run.candidate.configFingerprint ||
			dependencyIdentity(run.root, manifest) !== run.dependencies ||
			environmentIdentity() !== run.environment
		)
			throw new Error("Test configuration, environment or dependencies changed.");
		assertSourceCopy(candidate, run.candidate);
		attempt = mkdtempSync(join(base, "attempt-"));
		if (opts.operation === "before") {
			if (
				run.phase !== "snapshotted" ||
				manifest.productionFingerprint !== run.candidate.productionFingerprint
			)
				throw new Error("Production changed before the failing check.");
			if (
				!opts.test ||
				!opts.name ||
				!opts.finding ||
				opts.finding.length > 180 ||
				/[\r\n]/.test(opts.finding) ||
				!safeRecap(opts.finding)
			)
				throw new Error("Provide one test, its exact full name, and a short finding.");
			if (
				!opts.repairs.length ||
				opts.repairs.some(
					(name) =>
						!run.candidate.files.includes(reviewPath(run.root, name)) ||
						TEST_PATH.test(name) ||
						!run.candidate.codeHashes.some(([file]) => file === name),
				)
			)
				throw new Error("Declare one to three existing production source files with --repair.");
			const inputs = bundle(run.root, [opts.test, ...opts.fixtures, ...opts.regressions]);
			sameTestInputs(
				run.candidate,
				manifest,
				inputs.files.map((f) => f.name),
			);
			if (
				(!opts.regressions.length && !run.candidate.files.includes(opts.test)) ||
				opts.regressions.some((f) => !run.candidate.files.includes(f))
			)
				throw new Error("A new test file needs an existing relevant --regression test file.");
			const copy = join(attempt, "before");
			copySource(candidate, copy, run.candidate);
			overlay(run.root, copy, inputs.files);
			const result = await vitest(run.root, copy, opts.test, opts.name, controller.signal);
			if (!result.failure)
				throw new Error(
					"The saved candidate did not fail the selected behavioral assertion; no catch established.",
				);
			if (
				reviewManifest(run.root).fingerprint !== manifest.fingerprint ||
				dependencyIdentity(run.root, manifest) !== run.dependencies
			)
				throw new Error("Inputs changed during the check.");
			run.test = opts.test;
			run.testName = opts.name;
			run.finding = opts.finding;
			run.inputs = inputs;
			run.repairs = opts.repairs;
			run.frozenInputs = manifest.fileHashes.filter(([f]) => !run.repairs.includes(f));
			run.regressions = opts.regressions;
			run.before = result;
			run.phase = "reproduced";
			writeReviewRun(opts.directory, run);
			return { status: "reproduced", reviewId: run.id, test: run.testName };
		}
		if (run.phase !== "reproduced")
			throw new Error("First reproduce the failure on the saved candidate.");
		if (
			bundle(
				run.root,
				run.inputs.files.map((f) => f.name),
			).hash !== run.inputs.hash ||
			JSON.stringify(manifest.fileHashes.filter(([f]) => !run.repairs.includes(f))) !==
				JSON.stringify(run.frozenInputs)
		)
			throw new Error(
				"The frozen test, fixture or unlisted source inputs changed after reproduction.",
			);
		if (manifest.productionFingerprint === run.candidate.productionFingerprint)
			throw new Error("No production repair was made.");
		const beforeCopy = join(attempt, "before"),
			final = join(attempt, "final");
		copySource(candidate, beforeCopy, run.candidate);
		overlay(run.root, beforeCopy, run.inputs.files);
		copySource(run.root, final, manifest);
		const baseline = await vitest(run.root, beforeCopy, run.test, run.testName, controller.signal);
		const after = await vitest(run.root, final, run.test, undefined, controller.signal);
		const matching = after.tests.filter((t) => t.name === run.testName);
		if (
			!baseline.failure ||
			!after.pass ||
			matching.length !== 1 ||
			matching[0].status !== "passed"
		)
			throw new Error("The identical assertion did not reproduce and pass after repair.");
		const regressions = [];
		for (const file of [...new Set(run.regressions)].filter((f) => f !== run.test)) {
			const checked = await vitest(run.root, final, file, undefined, controller.signal);
			regressions.push(checked);
			if (!checked.pass)
				throw new Error("A declared regression suite was missing, skipped or failed.");
		}
		if (
			reviewManifest(run.root).fingerprint !== manifest.fingerprint ||
			dependencyIdentity(run.root, manifest) !== run.dependencies
		)
			throw new Error("Inputs changed during verification.");
		const prior = new Map(run.candidate.codeHashes),
			next = new Map(manifest.codeHashes);
		const repairedPaths = [...new Set([...prior.keys(), ...next.keys()])].filter(
			(f) => prior.get(f) !== next.get(f),
		);
		if (!repairedPaths.length) throw new Error("No source-code repair was found.");
		const proofPath = join(opts.directory, `proof-${run.id}.json`);
		const proof = {
			version: 1,
			kind: "caught_mistake",
			reviewId: run.id,
			finding: run.finding,
			repo: run.repo,
			graph: run.graph,
			beforeFingerprint: run.candidate.fingerprint,
			finalFingerprint: manifest.fingerprint,
			test: run.test,
			testName: run.testName,
			inputs: run.inputs,
			repairBoundary: run.repairs,
			before: run.before,
			reproducedAgain: baseline,
			after,
			regressions,
			repairedPaths,
		};
		const proofBytes = JSON.stringify(proof, null, 2);
		atomicWrite(proofPath, proofBytes);
		run.phase = "verified";
		run.receipt = {
			path: proofPath,
			proofHash: sha(proofBytes),
			finalFingerprint: manifest.fingerprint,
			repairedPaths,
			command: after.command,
		};
		writeReviewRun(opts.directory, run);
		rmSync(base, { recursive: true, force: true });
		return { status: "verified", kind: "caught_mistake", proof: proofPath, finding: run.finding };
	} finally {
		if (attempt) rmSync(attempt, { recursive: true, force: true });
		release();
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
}
if (process.argv[1] && resolve(process.argv[1]) === script) {
	if (process.argv[2] === "--run-child") supervise(process.argv.slice(3));
	else
		runChangeReview(process.argv.slice(2))
			.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
			.catch((error) => {
				process.stderr.write(`Change review is unproven: ${error.message}\n`);
				process.exitCode = 1;
			});
}
