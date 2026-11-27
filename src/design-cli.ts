/** `pharaoh-mcp design`: sign-in, context, lint, checkout wiring, evidence and rule proposals. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { validDesignRules } from "../runtime/design-contract.mjs";
import { pollForToken, printActivationPrompt, requestDeviceCode } from "./auth.js";
import {
	acquireCredentialsLock,
	deleteCredentials,
	readCredentials,
	writeCredentials,
} from "./credentials.js";
import {
	ciPolicy,
	localDesignCheckout,
	readDesignContext,
	runDesignLint,
} from "./design-evaluate.js";
import { setMappedMaintenance } from "./design-maintenance.js";
import {
	authorizedRequest,
	credentialPath,
	DesignError,
	designOrigin,
	resolveBinding,
} from "./design-projection.js";
import { verifyWorkflowRelease, wireDesignCheckout } from "./design-wiring.js";
import { DEFAULT_SERVER, tokenToCredentials } from "./helpers.js";
import { readDesignVision } from "./local/snapshot.js";

const usage = `pharaoh-mcp design context --target <file> [--search <name>]
pharaoh-mcp design login [--draft] | logout | evidence [--revision <number>] [--cursor <id>]
pharaoh-mcp design bootstrap [--eslint] [--maintain] | upgrade | maintain [--off] | uninstall
pharaoh-mcp design lint [--eslint] [--json]
pharaoh-mcp design propose --rules <file.json> --base-revision <number> --reason <text>
Use --server <origin> for a dedicated Pharaoh installation.`;
export function safeDesignError(e: unknown) {
	return e instanceof DesignError
		? e
		: new DesignError(
				2,
				"Could not complete design analysis. Verify the checkout, package installation and command arguments.",
			);
}
async function designLogin(origin: string, scope: "design:draft" | "design:read") {
	const device = await requestDeviceCode(origin, [], scope);
	printActivationPrompt(device);
	const token = await pollForToken(origin, device.device_code, device.interval);
	if (token.audience !== "pharaoh-design" || token.scope !== scope)
		throw new DesignError(3, "The server did not grant the requested design access.");
	const path = credentialPath(origin);
	const release = await acquireCredentialsLock(path);
	try {
		writeCredentials(
			{ ...tokenToCredentials(token, `${origin}/sse`, origin), designScope: scope },
			path,
		);
	} finally {
		release();
	}
}
const DESIGN_OPTIONS = {
	server: { type: "string", default: DEFAULT_SERVER },
	target: { type: "string" },
	search: { type: "string" },
	bundle: { type: "string" },
	rules: { type: "string" },
	reason: { type: "string" },
	"base-revision": { type: "string" },
	revision: { type: "string" },
	cursor: { type: "string" },
	draft: { type: "boolean" },
	eslint: { type: "boolean" },
	json: { type: "boolean" },
	help: { type: "boolean" },
	maintain: { type: "boolean" },
	off: { type: "boolean" },
} as const;
function parseDesignArgs(argv: string[]) {
	return parseArgs({ args: argv, allowPositionals: true, options: DESIGN_OPTIONS });
}
type DesignValues = ReturnType<typeof parseDesignArgs>["values"];
type DesignCheckout = ReturnType<typeof localDesignCheckout>;
type DesignBinding = Awaited<ReturnType<typeof resolveBinding>>;

/** Run one `pharaoh-mcp design` command; the exit code, with a safe message on any failure. */
export async function runDesignCommand(argv: string[]): Promise<number> {
	try {
		const { values, positionals } = parseDesignArgs(argv);
		if (values.help || positionals.length === 0) {
			console.log(usage);
			return 0;
		}
		if (positionals.length !== 1) throw new DesignError(2, usage);
		const [action] = positionals;
		const origin = designOrigin(values.server);
		await ensureInteractiveLogin(action, origin, values);
		const signal = AbortSignal.timeout(120000);
		if (action === "login") {
			await designLogin(origin, values.draft ? "design:draft" : "design:read");
			console.log("Signed in to Pharaoh design.");
			return 0;
		}
		if (action === "logout") return await designLogout(origin);
		return await runCheckoutAction(action, origin, values, signal);
	} catch (e) {
		const error = safeDesignError(e);
		console.error(error.message);
		return error.code;
	}
}

/** Bootstrap and maintain sign in first outside CI; maintain needs draft access. */
async function ensureInteractiveLogin(action: string, origin: string, values: DesignValues) {
	const interactive = action === "bootstrap" || action === "maintain";
	if (!interactive || process.env.CI || process.env.GITHUB_ACTIONS) return;
	const scope = action === "maintain" || values.maintain ? "design:draft" : "design:read";
	const saved = readCredentials(credentialPath(origin));
	if (!saved || (scope === "design:draft" && saved.designScope !== scope))
		await designLogin(origin, scope);
}

async function designLogout(origin: string): Promise<number> {
	const path = credentialPath(origin);
	const release = await acquireCredentialsLock(path);
	let confirmed = true;
	try {
		const saved = readCredentials(path);
		if (saved && new URL(saved.sse_url).origin === origin)
			confirmed = await revokeDesignSession(origin, saved.refresh_token);
		deleteCredentials(path);
	} finally {
		release();
	}
	console.log(
		confirmed
			? "Signed out of Pharaoh design."
			: "Removed local credentials. Pharaoh could not confirm remote design sign-out.",
	);
	return 0;
}

async function revokeDesignSession(origin: string, refreshToken: string): Promise<boolean> {
	try {
		const response = await fetch(`${origin}/api/design/logout`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(5000),
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh_token: refreshToken }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Commands that need the local checkout, before its hosted binding is read. */
async function runCheckoutAction(
	action: string,
	origin: string,
	values: DesignValues,
	signal: AbortSignal,
): Promise<number> {
	const { analyzer, checkout } = localDesignCheckout();
	if (action === "verify-ci" && values.bundle) {
		const policy = await ciPolicy(origin, checkout, values.bundle, signal);
		console.log(
			`Verified design revision ${policy.revision} at ${process.env.GITHUB_SHA} for this GitHub run.`,
		);
		return 0;
	}
	if (action === "context") {
		const context = await readDesignContext(
			origin,
			checkout,
			analyzer,
			values.target ?? "",
			values.search,
			signal,
		);
		console.log(JSON.stringify(context, null, 2));
		return 0;
	}
	if (action === "lint") return designLint(origin, { analyzer, checkout }, values, signal);
	if (action === "maintain") return designMaintain(origin, checkout, values, signal);
	if (action === "uninstall") return designUninstall(origin, checkout, signal);
	return runBoundAction(action, origin, { analyzer, checkout }, values, signal);
}

async function designLint(
	origin: string,
	{ analyzer, checkout }: DesignCheckout,
	values: DesignValues,
	signal: AbortSignal,
): Promise<number> {
	const { code, report } = await runDesignLint(
		origin,
		checkout,
		analyzer,
		{ eslint: values.eslint ?? false, bundle: values.bundle },
		signal,
	);
	if (values.json) console.log(JSON.stringify(report));
	else {
		console.log(
			`Design revision ${report.revision} · ${report.evaluated.length} evaluated rules · ${report.findings.length} findings${report.partial ? " · partial coverage" : ""}`,
		);
		for (const f of report.findings)
			console.log(`${f.file}:${f.line}:${f.column} ${f.severity} ${f.ruleId} ${f.message}`);
		for (const u of report.unknown) console.log(`${u.file} unknown ${u.ruleId} ${u.reason}`);
		if (report.reviewUrl) console.log(`Review the VISION.md change at ${report.reviewUrl}`);
	}
	return code;
}

async function designMaintain(
	origin: string,
	checkout: DesignCheckout["checkout"],
	values: DesignValues,
	signal: AbortSignal,
): Promise<number> {
	const binding = await resolveBinding(origin, checkout.repoSlug, signal);
	if (binding.revision === null)
		throw new DesignError(4, `Enroll at ${origin}/setup/design/enroll/${checkout.repoSlug}`);
	console.log(await setMappedMaintenance(origin, binding.repoId, !values.off, signal));
	return 0;
}

async function designUninstall(
	origin: string,
	checkout: DesignCheckout["checkout"],
	signal: AbortSignal,
): Promise<number> {
	console.log(
		await wireDesignCheckout(checkout.root, "uninstall", { eslint: false, privateCi: false }),
	);
	try {
		const binding = await resolveBinding(origin, checkout.repoSlug, signal);
		if (binding.revision !== null)
			console.log(
				`An enrolled administrator can disable hosted design lint at ${origin}/setup/design/${binding.repoId}/disable`,
			);
	} catch (e) {
		if (!(e instanceof DesignError) || ![3, 4].includes(e.code)) throw e;
	}
	return 0;
}

/** Commands that act on the repository's hosted design binding. */
async function runBoundAction(
	action: string,
	origin: string,
	local: DesignCheckout,
	values: DesignValues,
	signal: AbortSignal,
): Promise<number> {
	const binding = await resolveBinding(origin, local.checkout.repoSlug, signal);
	if (action === "evidence") return printEvidence(origin, binding, values, signal);
	if (action === "bootstrap" || action === "upgrade")
		return wireLint(action, origin, local.checkout, binding, values, signal);
	if (action === "propose") return propose(origin, local, binding, values, signal);
	throw new DesignError(2, usage);
}

async function printEvidence(
	origin: string,
	binding: DesignBinding,
	values: DesignValues,
	signal: AbortSignal,
): Promise<number> {
	const revision = values.revision ?? (binding.revision || undefined);
	if (revision !== undefined && !/^[1-9]\d*$/.test(String(revision)))
		throw new DesignError(2, "Provide a positive approved revision.");
	const params = new URLSearchParams();
	if (revision) params.set("revision", String(revision));
	if (values.cursor) params.set("cursor", values.cursor);
	const result = await authorizedRequest(
		origin,
		`/api/design/repos/${binding.repoId}/evidence?${params}`,
		signal,
	);
	console.log(JSON.stringify(result, null, 2));
	return 0;
}

async function wireLint(
	action: "bootstrap" | "upgrade",
	origin: string,
	checkout: DesignCheckout["checkout"],
	binding: DesignBinding,
	values: DesignValues,
	signal: AbortSignal,
): Promise<number> {
	if (binding.revision === null)
		throw new DesignError(
			4,
			`Enroll this repository in Pharaoh at ${origin}/setup/design/enroll/${checkout.repoSlug} before adding lint.`,
		);
	if (binding.visibility === "private") await verifyWorkflowRelease(binding.workflowSha, signal);
	console.log(
		await wireDesignCheckout(checkout.root, action, {
			eslint: values.eslint ?? false,
			privateCi: binding.visibility === "private",
			workflowSha: binding.workflowSha,
		}),
	);
	if (values.maintain)
		console.log(await setMappedMaintenance(origin, binding.repoId, true, signal));
	return 0;
}

async function propose(
	origin: string,
	{ analyzer, checkout }: DesignCheckout,
	binding: DesignBinding,
	values: DesignValues,
	signal: AbortSignal,
): Promise<number> {
	const { parent, rulesFile } = proposalBase(values);
	const rules = await readRulesFile(rulesFile);
	if (!validDesignRules(rules)) throw new DesignError(2, "Invalid proposed rules.");
	const candidate = await readDesignVision(checkout, analyzer.reader, signal);
	if (candidate.status !== "present")
		throw new DesignError(2, "A draft requires a readable root VISION.md.");
	const submitted = await authorizedRequest(
		origin,
		`/api/design/repos/${binding.repoId}/proposals`,
		signal,
		{
			vision: Buffer.from(candidate.bytes).toString("utf8"),
			rules,
			reason: values.reason,
			baseRevision: parent,
		},
	);
	console.log(proposalReviewUrl(submitted.reviewUrl, origin, binding.repoId).href);
	return 0;
}

/** The proposal's base revision, once a rules file and a reason are given too. */
function proposalBase(values: DesignValues): { parent: number; rulesFile: string } {
	const parent = Number(values["base-revision"]);
	if (
		!values.rules ||
		!values.reason?.trim() ||
		!/^\d+$/.test(values["base-revision"] ?? "") ||
		!Number.isSafeInteger(parent) ||
		parent < 0
	)
		throw new DesignError(2, usage);
	return { parent, rulesFile: values.rules };
}

/** Read a regular rules file of at most 256 KiB without following a link. */
async function readRulesFile(path: string): Promise<unknown> {
	const handle = await open(
		resolve(path),
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const st = await handle.stat();
		if (!st.isFile() || st.size > 256 * 1024) throw new DesignError(2, "Invalid rules file.");
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}

/** The draft's review link, only on this origin under the repository's review path. */
function proposalReviewUrl(reviewUrl: string, origin: string, repoId: string): URL {
	const url = new URL(reviewUrl, origin);
	if (url.origin !== origin || !url.pathname.startsWith(`/setup/design/${repoId}/review/`))
		throw new DesignError(2, "Invalid draft review link.");
	return url;
}
