/** One-command developer setup. Registration is separate from an answered tool call. */
import {
	pollForToken,
	printActivationPrompt,
	printAuthSuccess,
	requestDeviceCode,
} from "./auth.js";
import { type Credentials, readCredentials, writeCredentials } from "./credentials.js";
import {
	askYesNo,
	INSTALL_COMMAND,
	NPX_COMMAND,
	printLines,
	resolveSseUrl,
	tokenToCredentials,
} from "./helpers.js";
import type { ClientId, ClientOutcome, LaunchConfig } from "./install-types.js";
import { loadAndRefresh } from "./refresh.js";
import { ensureRuntime, RuntimeSetupError } from "./runtime.js";
import { type ClientTarget, configureClients, discoverClients, legacyMigrations } from "./setup.js";
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
		} else if (args[i] !== "--migrate-legacy" && args[i] !== "--memory-hooks") {
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

/** Keep working credentials until a new device authorization has actually succeeded. */
async function authenticateInstall(server: string): Promise<Credentials> {
	const existing = readCredentials();
	if (existing && sameOrigin(existing.sse_url, server)) {
		const current = await loadAndRefresh(server, undefined, true);
		if (current?.ok) {
			printAuthSuccess(
				current.creds.github_login,
				current.creds.tenant_name,
				current.creds.repos.length,
			);
			return current.creds;
		}
		if (current && current.action !== "reauth") {
			throw new Error(
				"Sign-in could not be refreshed. Try again; your saved credentials were kept.",
			);
		}
	}

	const device = await requestDeviceCode(server);
	printActivationPrompt(
		device.user_code,
		device.verification_uri,
		device.verification_uri_complete,
	);
	const token = await pollForToken(server, device.device_code, device.interval);
	// Validate the server binding before replacing credentials.
	const sseUrl = resolveSseUrl(token.sse_url, server);
	const credentials = tokenToCredentials(token, sseUrl, server);
	writeCredentials(credentials);
	if (token.provisional) {
		printLines(`Pharaoh: install the GitHub App to map your repos: ${token.install_url ?? ""}`);
	}
	printAuthSuccess(credentials.github_login, credentials.tenant_name, credentials.repos.length);
	return credentials;
}

interface InstallDependencies {
	discover: () => ClientTarget[];
	migrations: typeof legacyMigrations;
	authenticate: (server: string) => Promise<Credentials>;
	runtime: () => Promise<LaunchConfig>;
	configure: typeof configureClients;
	ask: (question: string) => Promise<boolean | null>;
	write: (...lines: string[]) => void;
	latest: typeof fetchLatestVersion;
}

/** Install hooks/skills only for coding clients whose enabled registration was verified. */
export interface InstallOptions {
	server: string;
	migrateLegacy?: boolean;
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
		...options.dependencies,
	};
	const write = dependencies.write;
	try {
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

		const credentials = await dependencies.authenticate(options.server);
		const launch = await dependencies.runtime();
		const configuredLaunch =
			options.server === "https://mcp.pharaoh.so"
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
				'In a new conversation in your repo, ask: "Run the Pharaoh setup tool".',
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
