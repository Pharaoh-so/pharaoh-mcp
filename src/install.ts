/** One-command developer setup. Registration is separate from an answered tool call. */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
	automaticRuntimeIntent,
	disableRuntime,
	type RuntimeDeviceApproval,
	type RuntimeEnrollmentIntent,
} from "../runtime/runtime-client.mjs";
import { syncLocalWorktreeHooks } from "../runtime/runtime-hooks.mjs";
import { RUNTIME_CLIENTS } from "../runtime/runtime-native.mjs";
import {
	pollForToken,
	printActivationPrompt,
	printAuthSuccess,
	requestDeviceCode,
} from "./auth.js";
import { type Credentials, readCredentials, saveAuthorizedCredentials } from "./credentials.js";
import {
	askYesNo,
	DEFAULT_SERVER,
	INSTALL_COMMAND,
	NPX_COMMAND,
	printLines,
	resolveSseUrl,
	tokenToCredentials,
} from "./helpers.js";
import type { ClientId, ClientOutcome, LaunchConfig } from "./install-types.js";
import { installedLocalAnalyzer } from "./local/worker-host.js";
import { loadAndRefresh } from "./refresh.js";
import { ensureRuntime, RuntimeSetupError } from "./runtime.js";
import { describeRuntimeDisable, enableInstalledRuntime } from "./runtime-command.js";
import {
	type ClientTarget,
	configureClients,
	discoverClients,
	freshRuntimeClients,
	legacyMigrations,
	verifiedCodingClients,
} from "./setup.js";
import { SETUP_TOOL_PROMPT } from "./setup-prompt.generated.js";
import {
	fetchLatestVersion,
	getPackageVersion,
	isNewerVersion,
	UPGRADE_COMMAND,
} from "./version.js";

const LABELS: Record<ClientId, string> = {
	"claude-code": "Claude Code CLI",
	codex: "Codex CLI / Desktop",
	"claude-desktop": "Claude Desktop Chat / Code",
};

const STATUS: Record<ClientOutcome["status"], string> = {
	configured: "configured",
	"already-configured": "already configured",
	"preserved-custom": "kept your custom connection",
	"preserved-disabled": "kept disabled",
	unavailable: "not available",
	ambiguous: "needs attention",
	failed: "setup failed",
};

/** Reject a mistyped explicit install command before it can authorize or change settings. */
export function validateInstallArguments(args: readonly string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--server") {
			if (!args[i + 1] || args[i + 1].startsWith("--")) return "--server needs a URL.";
			i++;
		} else if (!["--migrate-legacy", "--memory-hooks", "--skip-runtime"].includes(args[i])) {
			return "Unknown install option. Run pharaoh-mcp install --help.";
		}
	}
	return null;
}

function sameOrigin(left: string, right: string): boolean {
	try {
		return new URL(left).origin === new URL(right).origin;
	} catch {
		return false;
	}
}

interface InstallAuthResult {
	credentials: Credentials;
	runtimeApprovals?: RuntimeDeviceApproval[];
}

/** Keep working credentials until a new device authorization has actually succeeded. */
async function authenticateInstall(
	server: string,
	runtimeInstallations: readonly RuntimeEnrollmentIntent[],
): Promise<InstallAuthResult> {
	const existing = readCredentials();
	if (existing && sameOrigin(existing.sse_url, server)) {
		const current = await loadAndRefresh(server, undefined, true);
		if (current?.ok) {
			printAuthSuccess(
				current.creds.github_login,
				current.creds.tenant_name,
				current.creds.repos.length,
			);
			return { credentials: current.creds };
		}
		if (current && current.action !== "reauth") {
			throw new Error(
				"Sign-in could not be refreshed. Try again; your saved credentials were kept.",
			);
		}
	}

	const device = await requestDeviceCode(server, runtimeInstallations);
	printActivationPrompt(
		device.user_code,
		device.verification_uri,
		device.verification_uri_complete,
	);
	const token = await pollForToken(server, device.device_code, device.interval);
	// Validate the server binding before replacing credentials.
	const sseUrl = resolveSseUrl(token.sse_url, server);
	const credentials = tokenToCredentials(token, sseUrl, server);
	const offered = Array.isArray(token.runtime_approvals) ? token.runtime_approvals : [];
	const runtimeApprovals = runtimeInstallations.flatMap((intent) => {
		const approval = offered.find(
			(offer) =>
				offer?.client === intent.client &&
				offer.installationId === intent.installationId &&
				offer.generation === intent.generation &&
				offer.policyVersion === intent.policyVersion,
		);
		return approval ? [approval] : [];
	});
	if (runtimeApprovals.length) credentials.runtime_session = randomUUID();
	// A device ticket stays in this process. Only the ordinary OAuth record goes to disk.
	await saveAuthorizedCredentials(credentials);
	if (token.provisional) {
		printLines(`Pharaoh: install the GitHub App to map your repos: ${token.install_url ?? ""}`);
	}
	printAuthSuccess(credentials.github_login, credentials.tenant_name, credentials.repos.length);
	return { credentials, runtimeApprovals };
}

interface InstallDependencies {
	discover: () => ClientTarget[];
	migrations: typeof legacyMigrations;
	authenticate: typeof authenticateInstall;
	runtime: () => Promise<LaunchConfig>;
	configure: typeof configureClients;
	ask: (question: string) => Promise<boolean | null>;
	write: (...lines: string[]) => void;
	latest: typeof fetchLatestVersion;
	freshRuntimeClients: typeof freshRuntimeClients;
	verifiedRuntimeClients: typeof verifiedCodingClients;
	runtimeIntent: typeof automaticRuntimeIntent;
	enableRuntime: typeof enableInstalledRuntime;
	disableRuntime: typeof disableRuntime;
}

/** Install hooks/skills only for coding clients whose enabled registration was verified. */
export interface InstallOptions {
	server: string;
	migrateLegacy?: boolean;
	skipRuntime?: boolean;
	interactive?: boolean;
	afterConfigure?: (credentials: Credentials, clients: string[]) => Promise<void>;
	/** Isolated process/filesystem fixtures use the same orchestration without real user writes. */
	dependencies?: Partial<InstallDependencies>;
}

/**
 * Discover, authorize, prepare a pinned runtime, then configure every client independently.
 * A failed runtime never reaches a configuration writer. Partial successes are retained.
 * @returns A shell exit status; does not terminate the caller or mark onboarding complete.
 */
export async function runInstall(options: InstallOptions): Promise<number> {
	const dependencies: InstallDependencies = {
		discover: discoverClients,
		migrations: legacyMigrations,
		authenticate: authenticateInstall,
		runtime: () => ensureRuntime({ onDiagnostic: printLines }),
		configure: configureClients,
		ask: (question) => askYesNo(question),
		write: printLines,
		latest: fetchLatestVersion,
		freshRuntimeClients,
		verifiedRuntimeClients: verifiedCodingClients,
		runtimeIntent: automaticRuntimeIntent,
		enableRuntime: enableInstalledRuntime,
		disableRuntime,
		...options.dependencies,
	};
	const write = dependencies.write;
	try {
		if (options.skipRuntime) {
			const stopped = await Promise.allSettled(
				RUNTIME_CLIENTS.map(async (client) => dependencies.disableRuntime(client)),
			);
			const results = stopped.map((result) =>
				result.status === "fulfilled" ? result.value : "not_saved",
			);
			for (const [index, client] of RUNTIME_CLIENTS.entries())
				write(describeRuntimeDisable(client, results[index]));
			if (results.includes("not_saved")) return 1;
		}
		const targets = dependencies.discover();
		const migrations = dependencies.migrations(targets);
		let migrateLegacy = options.migrateLegacy === true;
		if (migrations.length && !migrateLegacy) {
			write("Existing pinned NPX connections:");
			for (const item of migrations) {
				write(`  ${LABELS[item.client]}: ${item.launch.command} ${item.launch.args.join(" ")}`);
			}
			if (options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY)) {
				migrateLegacy =
					(await dependencies.ask(
						"Move these connections to Pharaoh's managed runtime? [Y/n] ",
					)) === true;
			}
			if (!migrateLegacy) {
				write(`Kept those pins. To migrate them: ${INSTALL_COMMAND} --migrate-legacy`);
			}
		}

		let runtimeInstallations: RuntimeEnrollmentIntent[] = [];
		if (!options.skipRuntime && options.server === DEFAULT_SERVER) {
			try {
				runtimeInstallations = dependencies.freshRuntimeClients(targets).flatMap((client) => {
					const intent = dependencies.runtimeIntent(client);
					return intent ? [intent] : [];
				});
			} catch {
				// Unavailable runtime metadata cannot prevent sign-in or setup.
			}
		}
		if (runtimeInstallations.length) {
			write(
				"Eligible new managed clients send runtime usage metadata by default. No prompt or instruction text is sent.",
				`To turn it off, run ${INSTALL_COMMAND} --skip-runtime.`,
				"https://pharaoh.so/docs/use-pharaoh/what-we-measure#optional-runtime-analytics",
			);
		}
		const { credentials, runtimeApprovals } = await dependencies.authenticate(
			options.server,
			runtimeInstallations,
		);
		const launch = await dependencies.runtime();
		const configuredLaunch =
			options.server === DEFAULT_SERVER
				? launch
				: { ...launch, args: [...launch.args, "--server", options.server] };
		const outcomes = dependencies.configure(targets, configuredLaunch, { migrateLegacy });
		const codingClients = outcomes
			.filter(
				(outcome) =>
					outcome.client !== "claude-desktop" &&
					(outcome.status === "configured" || outcome.status === "already-configured"),
			)
			.map((outcome) => outcome.client);
		let extrasFailed = false;
		try {
			await options.afterConfigure?.(credentials, codingClients);
		} catch {
			extrasFailed = true;
			write(`Pharaoh: optional client setup could not finish. Retry ${INSTALL_COMMAND}.`);
		}
		const managedProxyRoot = dirname(dirname(launch.args[0]));
		if (options.server === DEFAULT_SERVER && installedLocalAnalyzer(managedProxyRoot)) {
			const hookPath = join(managedProxyRoot, "runtime", "local-worktree-hook.mjs");
			const verified = dependencies.verifiedRuntimeClients({
				runningLaunch: configuredLaunch,
				rejectProjectOverrides: true,
			});
			for (const client of verified) {
				if (!codingClients.includes(client)) continue;
				try {
					syncLocalWorktreeHooks(client, hookPath, { node: configuredLaunch.command });
				} catch {
					write(
						`${LABELS[client]}: saved-worktree hooks could not be configured. Hosted queries remain available.`,
					);
				}
			}
		}
		// Existing setup decides Claude tool permissions before runtime hooks can create settings.json.
		// Both clients publish through the same private runtime lock.
		for (const { client } of runtimeInstallations) {
			const label = LABELS[client];
			if (!outcomes.some((outcome) => outcome.client === client && outcome.created)) {
				write(`${label}: runtime analytics skipped. Review the connection setup result below.`);
				continue;
			}
			const canActivate = () =>
				dependencies
					.verifiedRuntimeClients({
						runningLaunch: configuredLaunch,
						requiredProxy: { minimumVersion: getPackageVersion(), server: options.server },
						rejectProjectOverrides: true,
					})
					.includes(client);
			let activated = false;
			try {
				if (!canActivate()) {
					write(`${label}: runtime analytics skipped. Review the client and project settings.`);
					continue;
				}
				const approval = runtimeApprovals?.find((entry) => entry.client === client);
				if (approval && credentials.runtime_session) {
					activated = await dependencies.enableRuntime(
						options.server,
						approval,
						credentials.runtime_session,
						canActivate,
					);
				}
			} catch {
				// Analytics setup failures leave the working client connection available.
			}
			write(
				activated
					? `${label}: runtime analytics enabled.`
					: `${label}: runtime analytics could not be enabled. Check --runtime-status or try --runtime-enable --client ${client}.`,
			);
		}

		write("", "Pharaoh CLI is signed in.");
		for (const outcome of outcomes) {
			write(
				`  ${LABELS[outcome.client]}: ${STATUS[outcome.status]}.${outcome.detail ? ` ${outcome.detail}` : ""}`,
			);
			if (outcome.recovery) write(`    ${outcome.recovery}`);
		}
		const enabled = outcomes.some(
			(outcome) => outcome.status === "configured" || outcome.status === "already-configured",
		);
		if (enabled) {
			write(
				"Restart configured desktop apps or start a new CLI session; accept any client trust prompt.",
				"Ask your agent:",
				"",
				SETUP_TOOL_PROMPT,
				"",
			);
		} else {
			write("No new enabled agent connection was established. Your existing choices were kept.");
		}
		write(`Shell queries: ${NPX_COMMAND} get_codebase_map --repo <name>`);
		const latest = await dependencies.latest();
		if (latest && isNewerVersion(latest, getPackageVersion())) {
			write(`Pharaoh: ${latest} is available. Upgrade: ${UPGRADE_COMMAND}`);
		}
		return extrasFailed ||
			outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "ambiguous")
			? 1
			: 0;
	} catch (error) {
		// Never print native process errors: npm output/configuration may contain registry secrets.
		if (error instanceof RuntimeSetupError) write(`Pharaoh: ${error.message}`);
		write(`Pharaoh: installation could not finish. Retry ${INSTALL_COMMAND}.`);
		return 1;
	}
}
