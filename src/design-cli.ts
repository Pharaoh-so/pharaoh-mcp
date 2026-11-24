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
export async function runDesignCommand(argv: string[]): Promise<number> {
	try {
		const { values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
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
			},
		});
		if (values.help || positionals.length === 0) {
			console.log(usage);
			return 0;
		}
		if (positionals.length !== 1) throw new DesignError(2, usage);
		const [action] = positionals;
		const origin = designOrigin(values.server);
		const interactive = action === "bootstrap" || action === "maintain";
		if (interactive && !process.env.CI && !process.env.GITHUB_ACTIONS) {
			const scope = action === "maintain" || values.maintain ? "design:draft" : "design:read";
			const saved = readCredentials(credentialPath(origin));
			if (!saved || (scope === "design:draft" && saved.designScope !== scope))
				await designLogin(origin, scope);
		}
		const signal = AbortSignal.timeout(120000);
		if (action === "login") {
			await designLogin(origin, values.draft ? "design:draft" : "design:read");
			console.log("Signed in to Pharaoh design.");
			return 0;
		}
		if (action === "logout") {
			const path = credentialPath(origin);
			const release = await acquireCredentialsLock(path);
			let confirmed = true;
			try {
				const saved = readCredentials(path);
				if (saved && new URL(saved.sse_url).origin === origin) {
					try {
						const response = await fetch(`${origin}/api/design/logout`, {
							method: "POST",
							redirect: "error",
							signal: AbortSignal.timeout(5000),
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ refresh_token: saved.refresh_token }),
						});
						confirmed = response.ok;
					} catch {
						confirmed = false;
					}
				}
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
		if (action === "lint") {
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
		if (action === "maintain") {
			const binding = await resolveBinding(origin, checkout.repoSlug, signal);
			if (binding.revision === null)
				throw new DesignError(4, `Enroll at ${origin}/setup/design/enroll/${checkout.repoSlug}`);
			console.log(await setMappedMaintenance(origin, binding.repoId, !values.off, signal));
			return 0;
		}
		if (action === "uninstall") {
			console.log(
				await wireDesignCheckout(checkout.root, action, { eslint: false, privateCi: false }),
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
		const binding = await resolveBinding(origin, checkout.repoSlug, signal);
		if (action === "evidence") {
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
		if (action === "bootstrap" || action === "upgrade") {
			if (binding.revision === null)
				throw new DesignError(
					4,
					`Enroll this repository in Pharaoh at ${origin}/setup/design/enroll/${checkout.repoSlug} before adding lint.`,
				);
			if (binding.visibility === "private")
				await verifyWorkflowRelease(binding.workflowSha, signal);
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
		if (action === "propose") {
			const parent = Number(values["base-revision"]);
			if (
				!values.rules ||
				!values.reason?.trim() ||
				!/^\d+$/.test(values["base-revision"] ?? "") ||
				!Number.isSafeInteger(parent) ||
				parent < 0
			)
				throw new DesignError(2, usage);
			const handle = await open(
				resolve(values.rules),
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			let rules: unknown;
			try {
				const st = await handle.stat();
				if (!st.isFile() || st.size > 256 * 1024) throw new DesignError(2, "Invalid rules file.");
				rules = JSON.parse(await handle.readFile("utf8"));
			} finally {
				await handle.close();
			}
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
			const url = new URL(submitted.reviewUrl, origin);
			if (
				url.origin !== origin ||
				!url.pathname.startsWith(`/setup/design/${binding.repoId}/review/`)
			)
				throw new DesignError(2, "Invalid draft review link.");
			console.log(url.href);
			return 0;
		}
		throw new DesignError(2, usage);
	} catch (e) {
		const error = safeDesignError(e);
		console.error(error.message);
		return error.code;
	}
}
