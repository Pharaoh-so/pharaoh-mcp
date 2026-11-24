import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { acquireCredentialsLock } from "./credentials.js";
import { DesignError, digest } from "./design-projection.js";
import { getPackageVersion } from "./version.js";

const workflowPath = ".github/workflows/pharaoh-design.yml";
const dep = "@pharaoh-so/mcp";
const script = "lint:design";
export function callerWorkflow(pin: string, eslint: boolean) {
	if (!/^[a-f0-9]{40}$/.test(pin))
		throw new DesignError(
			4,
			"Private CI needs a trusted released workflow pin. Open Pharaoh design setup.",
		);
	return `# Managed by pharaoh-mcp design bootstrap.
name: Pharaoh Design
on: [push, pull_request]
permissions: {}
jobs:
  design:
    permissions:
      contents: read
      id-token: write
      actions: write
    uses: Pharaoh-so/pharaoh-mcp/.github/workflows/design-lint.yml@${pin}
    with:
      eslint: ${eslint}
`;
}
function checkedPath(root: string, rel: string) {
	let current = root;
	for (const part of rel.split("/")) {
		current = join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink())
				throw new DesignError(2, `Cannot manage a symlink at ${rel}.`);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
	}
	return current;
}
function content(path: string) {
	try {
		return readFileSync(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		return null;
	}
}
function write(path: string, value: Buffer | null) {
	if (value === null) {
		if (existsSync(path)) unlinkSync(path);
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.pharaoh-${randomUUID()}`;
	const mode = lstatSync(path, { throwIfNoEntry: false })?.mode ?? 0o666;
	const fd = openSync(temp, "wx", mode);
	try {
		try {
			writeFileSync(fd, value);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}
interface Managed {
	version: 1;
	command: string;
	packageVersion: string;
	priorVersion: string | null;
	workflowDigest: string | null;
	manager: "npm" | "pnpm";
}
interface InstallJournal {
	pid: number;
	original: string;
	desired: string;
	priorWorkflow: string | null;
	nextWorkflow: string | null;
	manager: "npm" | "pnpm";
	priorLock: string | null;
	installedLockHash?: string | null;
	recoveryRequired?: boolean;
}

function restoreInterruptedInstall(root: string, guard: string) {
	const saved = content(guard);
	if (!saved) return;
	const journal: InstallJournal = JSON.parse(saved.toString());
	if (!Number.isSafeInteger(journal.pid) || journal.pid <= 0)
		throw new DesignError(2, "Invalid design install journal.");
	if (!journal.recoveryRequired)
		try {
			process.kill(journal.pid, 0);
			throw new DesignError(2, "Another Pharaoh process is updating this checkout.");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
		}
	const manifest = checkedPath(root, "package.json");
	const current = readFileSync(manifest);
	const original = Buffer.from(journal.original, "base64");
	const workflow = checkedPath(root, workflowPath);
	const existing = content(workflow);
	const currentHash = existing && digest(existing);
	const previous =
		journal.priorWorkflow === null ? null : Buffer.from(journal.priorWorkflow, "base64");
	if (!current.equals(original) && digest(current) !== journal.desired) {
		throw new DesignError(
			2,
			`package.json changed after an interrupted setup. Review the saved install journal at ${guard}.`,
		);
	}
	if (currentHash === journal.nextWorkflow) write(workflow, previous);
	// Preserve edits made outside this operation. A fresh preflight will identify a workflow conflict.
	const restoringManifest = digest(current) === journal.desired;
	const lock = checkedPath(
		root,
		journal.manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
	);
	const currentLock = content(lock);
	if (restoringManifest) write(manifest, original);
	// Also finish a rollback interrupted after the manifest was restored but before its lockfile.
	if (restoringManifest || journal.installedLockHash === (currentLock && digest(currentLock)))
		write(lock, journal.priorLock === null ? null : Buffer.from(journal.priorLock, "base64"));
	unlinkSync(guard);
}
type Operation = "bootstrap" | "upgrade" | "uninstall";
type WiringOptions = { eslint: boolean; privateCi: boolean; workflowSha?: string };
export async function wireDesignCheckout(
	root: string,
	operation: Operation,
	options: WiringOptions,
) {
	const guardDir = join(homedir(), ".pharaoh", "design", "installs");
	const guard = join(guardDir, `${digest(root)}.json`);
	// Serialize crash recovery and journal creation. The active PID owns the longer dependency install.
	const release = await acquireCredentialsLock(guard);
	try {
		return applyWiring(root, operation, options, guard, release);
	} finally {
		release();
	}
}
function applyWiring(
	root: string,
	operation: Operation,
	options: WiringOptions,
	guard: string,
	release: () => void,
) {
	restoreInterruptedInstall(root, guard);
	const pkgPath = checkedPath(root, "package.json");
	const original = readFileSync(pkgPath);
	const pkg = JSON.parse(original.toString());
	const managed: Managed | undefined = pkg.pharaohDesign;
	if (
		managed &&
		(managed.version !== 1 ||
			!/^pharaoh-mcp design lint( --eslint)?$/.test(managed.command) ||
			!/^\d+\.\d+\.\d+$/.test(managed.packageVersion))
	)
		throw new DesignError(2, "Unknown design wiring. Review package.json before applying changes.");
	if (!managed && operation === "uninstall") return "No managed design wiring.";
	if (!managed && operation === "upgrade") throw new DesignError(2, "Run design bootstrap first.");
	const lintCommand = pkg.scripts?.[script];
	if (
		managed
			? lintCommand !== managed.command || pkg.devDependencies?.[dep] !== managed.packageVersion
			: lintCommand || pkg.dependencies?.[dep]
	)
		throw new DesignError(
			2,
			"An existing package entry conflicts with the managed lint command. Review package.json.",
		);
	const file = checkedPath(root, workflowPath);
	const oldWorkflow = content(file);
	if ((oldWorkflow && digest(oldWorkflow)) !== (managed?.workflowDigest ?? null))
		throw new DesignError(
			2,
			"The design workflow was edited. Review the workflow before changing its wiring.",
		);
	const manager =
		existsSync(checkedPath(root, "pnpm-lock.yaml")) || pkg.packageManager?.startsWith("pnpm@")
			? "pnpm"
			: "npm";
	if (
		(manager === "pnpm" && existsSync(checkedPath(root, "package-lock.json"))) ||
		["yarn.lock", "bun.lock", "bun.lockb"].some((f) => existsSync(checkedPath(root, f)))
	)
		throw new DesignError(4, "Design bootstrap supports npm or pnpm with a single lockfile.");
	const eslint = options.eslint || Boolean(managed?.command.endsWith(" --eslint"));
	if (
		eslint &&
		(manager !== "npm" ||
			![
				"eslint.config.js",
				"eslint.config.cjs",
				"eslint.config.mjs",
				"eslint.config.ts",
				"eslint.config.cts",
				"eslint.config.mts",
			].some((f) => existsSync(checkedPath(root, f))))
	)
		throw new DesignError(4, "Managed ESLint requires an npm checkout with a flat config.");
	const command = `pharaoh-mcp design lint${eslint ? " --eslint" : ""}`;
	const pin = getPackageVersion();
	if (pin === "0.0.0") throw new DesignError(2, "Cannot determine the installed Pharaoh release.");
	const workflow =
		operation === "uninstall" || !options.privateCi
			? null
			: Buffer.from(callerWorkflow(options.workflowSha ?? "", eslint));
	pkg.scripts ??= {};
	pkg.devDependencies ??= {};
	if (operation === "uninstall" && managed) {
		delete pkg.scripts[script];
		if (managed.priorVersion) pkg.devDependencies[dep] = managed.priorVersion;
		else delete pkg.devDependencies[dep];
		delete pkg.pharaohDesign;
	} else {
		const priorVersion = managed ? managed.priorVersion : (pkg.devDependencies[dep] ?? null);
		pkg.scripts[script] = command;
		pkg.devDependencies[dep] = pin;
		pkg.pharaohDesign = {
			version: 1,
			command,
			packageVersion: pin,
			priorVersion,
			workflowDigest: workflow && digest(workflow),
			manager,
		} satisfies Managed;
	}
	const indent = original.toString().match(/\n([^\S\n]+)"/)?.[1] ?? "  ";
	const desired = Buffer.from(`${JSON.stringify(pkg, null, indent)}\n`);
	const lock = checkedPath(root, manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml");
	if (original.equals(desired) && existsSync(lock)) return "Design wiring is already current.";
	const oldLock = content(lock);
	const journal: InstallJournal = {
		pid: process.pid,
		original: original.toString("base64"),
		desired: digest(desired),
		priorWorkflow: oldWorkflow?.toString("base64") ?? null,
		nextWorkflow: workflow && digest(workflow),
		manager,
		priorLock: oldLock?.toString("base64") ?? null,
	};
	writeFileSync(guard, JSON.stringify(journal), { flag: "wx", mode: 0o600 });
	release();
	let preserveJournal = false;
	try {
		if (!readFileSync(pkgPath).equals(original))
			throw new DesignError(2, "package.json changed during setup.");
		write(pkgPath, desired);
		const args =
			manager === "npm"
				? ["install", "--ignore-scripts", "--no-fund", "--no-audit"]
				: ["install", "--ignore-scripts", "--ignore-pnpmfile", "--no-frozen-lockfile"];
		const install = spawnSync(manager, args, { cwd: root, stdio: "inherit", timeout: 120000 });
		if (install.status !== 0) {
			throw new DesignError(
				2,
				`Could not synchronize the ${manager} lockfile. Install a released Pharaoh version and retry.`,
			);
		}
		const installedLock = content(
			checkedPath(root, manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml"),
		);
		journal.installedLockHash = installedLock && digest(installedLock);
		write(guard, Buffer.from(JSON.stringify(journal)));
		if (!readFileSync(checkedPath(root, "package.json")).equals(desired))
			throw new DesignError(2, "package.json changed during dependency installation.");
		const currentWorkflow = content(checkedPath(root, workflowPath));
		if ((currentWorkflow && digest(currentWorkflow)) !== (oldWorkflow && digest(oldWorkflow)))
			throw new DesignError(2, "The design workflow changed during setup.");
		write(file, workflow);
		return operation === "uninstall"
			? "Removed managed design lint wiring. Manage enrollment and revoke CI access in Pharaoh setup."
			: `Review the checkout changes, then run ${manager} run lint:design.`;
	} catch (e) {
		try {
			if (content(checkedPath(root, "package.json"))?.equals(desired)) {
				const lockPath = checkedPath(
					root,
					manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
				);
				const currentLock = content(lockPath);
				if (
					journal.installedLockHash === undefined ||
					journal.installedLockHash === (currentLock && digest(currentLock))
				)
					write(lockPath, oldLock);
				write(pkgPath, original);
			}
		} catch {
			preserveJournal = true;
			journal.recoveryRequired = true;
			write(guard, Buffer.from(JSON.stringify(journal)));
			throw new DesignError(
				2,
				"Checkout rollback was interrupted. Restore filesystem access and rerun design setup.",
			);
		}
		throw e;
	} finally {
		if (!preserveJournal) unlinkSync(guard);
	}
}

/** Verify the configured release actually publishes the evaluator matching this checkout before editing files. */
export async function verifyWorkflowRelease(sha: string | undefined, signal: AbortSignal) {
	if (!sha || !/^[a-f0-9]{40}$/.test(sha))
		throw new DesignError(4, "Private CI needs a released reusable workflow. Open Pharaoh setup.");
	const base = `https://raw.githubusercontent.com/Pharaoh-so/pharaoh-mcp/${sha}`;
	try {
		const [workflow, pkg] = await Promise.all([
			fetch(`${base}/.github/workflows/design-lint.yml`, {
				method: "HEAD",
				redirect: "error",
				signal,
			}),
			fetch(`${base}/package.json`, { redirect: "error", signal }),
		]);
		if (!workflow.ok || !pkg.ok)
			throw new DesignError(4, "The configured private CI release is unavailable.");
		const metadata = await pkg.json();
		if (metadata.name !== "@pharaoh-so/mcp" || metadata.version !== getPackageVersion())
			throw new DesignError(
				4,
				"Run bootstrap with the Pharaoh package release configured for private CI.",
			);
	} catch (e) {
		if (e instanceof DesignError) throw e;
		throw new DesignError(
			3,
			"Cannot verify the released design workflow. Check your connection and retry.",
		);
	}
}
