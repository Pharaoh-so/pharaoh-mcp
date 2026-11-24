import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type DesignQuery, validDesignQuery } from "../runtime/design-contract.mjs";
import {
	approvedProjection,
	authorizedRequest,
	bundleLimit,
	type CiBinding,
	DesignError,
	digest,
	verifyProjection,
} from "./design-projection.js";
import type { VerifiedCheckout } from "./local/dispatch.js";
import { resolveLocalCheckout, sameLocalCheckout } from "./local/scope.js";
import { captureLocalSnapshot, type LocalSnapshot, readDesignVision } from "./local/snapshot.js";
import {
	installedLocalAnalyzer,
	type LocalAnalyzer,
	runDesignAnalysis,
} from "./local/worker-host.js";

export const DESIGN_CONTEXT_TOOL = {
	name: "design_context",
	description:
		"Before editing UI, find reusable components, callers and design tokens for a file in the current checkout.",
	inputSchema: {
		type: "object" as const,
		properties: {
			target: {
				type: "string",
				minLength: 1,
				maxLength: 480,
				description: "Repository-relative UI file to edit",
			},
			search: {
				type: "string",
				maxLength: 128,
				description: "Optional component or token name to prioritize",
			},
		},
		required: ["target"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true, destructiveHint: false },
};
export function localDesignCheckout() {
	const analyzer = installedLocalAnalyzer();
	if (!analyzer)
		throw new DesignError(
			2,
			"The verified local analyzer is unavailable. Reinstall the pinned Pharaoh package for this platform.",
		);
	if (!analyzer.designAnalysisV1)
		throw new DesignError(4, "This analyzer release does not support design intelligence.");
	const evidence = resolveLocalCheckout(process.cwd(), analyzer.reader);
	if (evidence.kind !== "checkout")
		throw new DesignError(2, "Open a verified GitHub checkout to use design intelligence.");
	return { analyzer, checkout: evidence.checkout };
}
function checkedCheckout(checkout: VerifiedCheckout, analyzer: LocalAnalyzer) {
	if (!sameLocalCheckout(checkout, analyzer.reader))
		throw new DesignError(2, "The checkout changed during this run. Run again.");
}
async function vision(checkout: VerifiedCheckout, analyzer: LocalAnalyzer, signal: AbortSignal) {
	const result = await readDesignVision(checkout, analyzer.reader, signal);
	if (result.status === "absent") return { candidate: "deleted", text: null };
	if (result.status !== "present")
		throw new DesignError(2, `Cannot evaluate VISION.md (${result.status}).`);
	const bytes = Buffer.from(result.bytes);
	return { candidate: digest(bytes), text: bytes.toString("utf8") };
}
function pending(origin: string, repoId: string, revision: number, candidate: string) {
	return `${origin}/setup/design/${repoId}/pending/${revision}/${candidate}`;
}
export async function readDesignContext(
	origin: string,
	checkout: VerifiedCheckout,
	analyzer: LocalAnalyzer,
	target: string,
	search: string | undefined,
	signal: AbortSignal,
) {
	const query: DesignQuery = { kind: "context", target, ...(search && { search }) };
	if (!validDesignQuery(query))
		throw new DesignError(2, "Provide a valid checkout-relative UI target.");
	const initial = await vision(checkout, analyzer, signal);
	const snapshot = await captureLocalSnapshot(checkout, analyzer.reader, signal, "design");
	const facts = await runDesignAnalysis(analyzer, snapshot, query, signal);
	if (facts.kind !== "context") throw new DesignError(2, "Unexpected analyzer response.");
	let policy: Awaited<ReturnType<typeof approvedProjection>> | undefined;
	let access = "approved";
	try {
		policy = await approvedProjection(origin, checkout.repoSlug, signal);
	} catch (e) {
		signal.throwIfAborted();
		access = e instanceof DesignError && e.code === 3 ? "sign-in-or-offline" : "unavailable";
	}
	const relevantRules = policy?.rules.filter((rule) => rule.file === target) ?? [];
	let drift = relevantRules.length
		? await runDesignAnalysis(analyzer, snapshot, { kind: "lint", rules: relevantRules }, signal)
		: undefined;
	const latest = await vision(checkout, analyzer, signal);
	let approvedCandidate = policy?.visionStatus === "deleted" ? "deleted" : policy?.visionDigest;
	let approvedIntent: { vision: string | null; reason: string } | undefined;
	if (policy && approvedCandidate !== latest.candidate) {
		const revision = policy.revision;
		try {
			const history = await authorizedRequest(
				origin,
				`/api/design/repos/${policy.repoId}/evidence?revision=${policy.revision}`,
				signal,
			);
			const row = history?.evidence?.find(
				(item: { status?: string; parent?: number }) =>
					item.status === "approved" && item.parent === revision - 1,
			);
			if (
				row &&
				(typeof row.vision === "string" || row.vision === null) &&
				typeof row.reason === "string"
			)
				approvedIntent = { vision: row.vision, reason: row.reason };
		} catch {
			signal.throwIfAborted();
			// The read may have been revoked between requests. Deliver only local facts.
			policy = undefined;
			drift = undefined;
			approvedCandidate = undefined;
			access = "unavailable";
		}
	}
	if (latest.candidate !== initial.candidate)
		throw new DesignError(2, "VISION.md changed during this run. Run again.");
	const checked = await captureLocalSnapshot(checkout, analyzer.reader, signal, "design");
	if (checked.fingerprint !== snapshot.fingerprint)
		throw new DesignError(2, "Saved design files changed during this run. Run again.");
	checkedCheckout(checkout, analyzer);
	return {
		...facts,
		...(approvedIntent && { approvedIntent }),
		...(drift?.kind === "lint" && {
			drift: { findings: drift.findings, unknown: drift.unknown, evaluated: drift.evaluated },
		}),
		repository: checkout.repoSlug,
		vision: {
			status: approvedCandidate === latest.candidate ? "approved" : "draft",
			text: latest.text,
		},
		policyAccess: access,
		...(policy && {
			revision: policy.revision,
			rules: policy.rules,
			...(approvedCandidate !== latest.candidate && {
				reviewUrl: pending(origin, policy.repoId, policy.revision, latest.candidate),
			}),
		}),
	};
}
function ciBinding(checkout: VerifiedCheckout): CiBinding {
	const env = process.env;
	if (
		env.GITHUB_ACTIONS !== "true" ||
		!/^[1-9]\d*$/.test(env.GITHUB_REPOSITORY_ID ?? "") ||
		env.GITHUB_REPOSITORY?.toLowerCase() !== checkout.repoSlug.toLowerCase() ||
		!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") ||
		!/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
		!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")
	) {
		throw new DesignError(
			2,
			"A signed CI bundle requires the exact GitHub Actions run and repository.",
		);
	}
	// Git is invoked without repository hooks, environment overrides or PATH supplied by project scripts.
	const head = execFileSync(
		"/usr/bin/git",
		["--no-replace-objects", "rev-parse", "--verify", "HEAD"],
		{
			cwd: checkout.root,
			env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
			encoding: "utf8",
			timeout: 3000,
		},
	).trim();
	if (head !== env.GITHUB_SHA)
		throw new DesignError(2, "The checked-out SHA differs from this CI run.");
	return {
		repoId: env.GITHUB_REPOSITORY_ID ?? "",
		repoSlug: checkout.repoSlug,
		runId: env.GITHUB_RUN_ID ?? "",
		runAttempt: env.GITHUB_RUN_ATTEMPT ?? "",
		sha: head,
	};
}
/** Compare captured evaluator inputs to their Git objects without invoking checkout filters or hooks. */
function confirmCiInputs(
	checkout: VerifiedCheckout,
	snapshot: LocalSnapshot,
	visionText: string | null,
) {
	const binding = ciBinding(checkout);
	const list = execFileSync(
		"/usr/bin/git",
		["--no-replace-objects", "ls-tree", "-rz", "--full-tree", binding.sha],
		{
			cwd: checkout.root,
			env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			timeout: 5000,
		},
	);
	const objects = new Map<string, string>();
	for (const entry of list.split("\0")) {
		const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(entry);
		if (match) objects.set(match[3], match[2]);
	}
	const matches = (path: string, bytes: Buffer) => {
		const id = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
		if (objects.get(path) !== id)
			throw new DesignError(2, "A design input differs from the signed CI checkout.");
	};
	for (const [path, bytes] of snapshot.sources) matches(path, Buffer.from(bytes));
	for (const [path, text] of snapshot.configFiles) matches(path, Buffer.from(text));
	if (visionText !== null) matches("VISION.md", Buffer.from(visionText));
	else if (objects.has("VISION.md"))
		throw new DesignError(2, "The signed checkout is missing VISION.md.");
}
export async function ciPolicy(
	origin: string,
	checkout: VerifiedCheckout,
	path: string,
	signal: AbortSignal,
) {
	const ci = ciBinding(checkout);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > bundleLimit)
			throw new DesignError(2, "Invalid CI bundle file.");
		const { bundle } = JSON.parse(await handle.readFile("utf8"));
		return verifyProjection(origin, bundle, ci, signal, ci);
	} finally {
		await handle.close();
	}
}
export async function runDesignLint(
	origin: string,
	checkout: VerifiedCheckout,
	analyzer: LocalAnalyzer,
	options: { bundle?: string; eslint: boolean },
	signal: AbortSignal,
) {
	const policy = options.bundle
		? await ciPolicy(origin, checkout, options.bundle, signal)
		: await approvedProjection(origin, checkout.repoSlug, signal);
	const initial = await vision(checkout, analyzer, signal);
	const snapshot = await captureLocalSnapshot(checkout, analyzer.reader, signal, "design");
	if (options.bundle) confirmCiInputs(checkout, snapshot, initial.text);
	const result = await runDesignAnalysis(
		analyzer,
		snapshot,
		{ kind: "lint", rules: policy.rules },
		signal,
	);
	if (result.kind !== "lint") throw new DesignError(2, "Unexpected analyzer response.");
	const ids = new Set([...result.evaluated, ...result.unknown.map((entry) => entry.ruleId)]);
	if (policy.rules.some((rule) => !ids.has(rule.id)))
		throw new DesignError(2, "The analyzer omitted an approved target.");
	const native = options.eslint ? await runEslint(checkout.root, result.findings, signal) : 0;
	if ((await vision(checkout, analyzer, signal)).candidate !== initial.candidate)
		throw new DesignError(2, "VISION.md changed during this run. Run again.");
	const checked = await captureLocalSnapshot(checkout, analyzer.reader, signal, "design");
	if (checked.fingerprint !== snapshot.fingerprint)
		throw new DesignError(2, "Saved design files changed during this run. Run again.");
	checkedCheckout(checkout, analyzer);
	const code =
		native === 2 || result.unknown.length
			? 2
			: native || result.findings.some((f) => f.severity === "error")
				? 1
				: 0;
	return {
		code,
		report: {
			completed: true,
			repository: checkout.repoSlug,
			revision: policy.revision,
			visionDigest: policy.visionDigest,
			...result,
			...(initial.candidate !==
				(policy.visionStatus === "deleted" ? "deleted" : policy.visionDigest) && {
				reviewUrl: pending(origin, policy.repoId, policy.revision, initial.candidate),
			}),
		},
	};
}
async function runEslint(cwd: string, findings: unknown, signal: AbortSignal): Promise<number> {
	const entry = fileURLToPath(new URL("../runtime/design-eslint.mjs", import.meta.url));
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [entry], {
			cwd,
			signal,
			env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
			stdio: ["pipe", "inherit", "inherit"],
		});
		child.on("error", reject);
		child.stdin.on("error", reject);
		child.stdin.end(JSON.stringify(findings));
		child.on("exit", (code) => resolve(code === 0 || code === 1 ? code : 2));
	});
}
