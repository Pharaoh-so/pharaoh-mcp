/**
 * Offline diagnosis of Pharaoh's local plugin and instruction markers. It reads
 * bounded files only; it cannot establish what a running agent loaded or used.
 */
import { homedir } from "node:os";
import { runtimeStatus } from "../runtime/runtime-client.mjs";
import { RUNTIME_CLIENTS } from "../runtime/runtime-native.mjs";
import { claudePluginState, instructionStates } from "./install-skills.js";
import { getPackageVersion } from "./version.js";

/** Local observations; no file text, credentials, paths or configured-version claim. */
interface LocalSetupDiagnosis {
	/** Version of this diagnostic's running package. */
	proxyVersion: string;
	/** Explicit supported client selection, never inferred from a folder or CLI. */
	client: "claude-code" | "unsupported" | "unverified";
	/** Pharaoh's enabled-plugin setting, not proof of loading. */
	plugin: ReturnType<typeof claudePluginState>;
	/** Pharaoh marker states in the bounded user/project instruction files. */
	instructions: ReturnType<typeof instructionStates>;
	/** Offline consent and receipt coverage, without reading credential records. */
	runtime: Array<{ client: string; status: ReturnType<typeof runtimeStatus> }>;
}

/**
 * Read existing Pharaoh markers without sign-in, network access or changes.
 * @param options - Explicit client and local fixture overrides; only Claude Code has a verified project scan.
 * @returns Finite observed states; loading, use and a configured package pin remain unmeasured.
 */
export function diagnoseLocalSetup(
	options: { clientName?: string; cwd?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): LocalSetupDiagnosis {
	const home = options.home ?? homedir();
	const env = options.env ?? process.env;
	const client =
		options.clientName === "claude-code"
			? "claude-code"
			: options.clientName
				? "unsupported"
				: "unverified";
	return {
		proxyVersion: getPackageVersion(),
		client,
		plugin: claudePluginState(home, env),
		instructions: instructionStates(
			client === "claude-code" ? client : undefined,
			options.cwd,
			home,
			env,
		),
		runtime: RUNTIME_CLIENTS.map((name) => ({
			client: name,
			status: runtimeStatus(name, { home }),
		})),
	};
}

/**
 * Render a local diagnostic without leaking file contents or implying live context access.
 * @param diagnosis - Finite states from diagnoseLocalSetup.
 * @returns Human-readable offline observations and the existing native diagnostic entry point.
 */
export function renderLocalSetupDiagnosis(diagnosis: LocalSetupDiagnosis): string {
	return [
		`Pharaoh local setup · running package ${diagnosis.proxyVersion}`,
		"Offline observations; no sign-in, uploads or changes.",
		`Client selection: ${diagnosis.client}`,
		`Claude Code Pharaoh plugin setting: ${diagnosis.plugin}`,
		`Claude Code user instruction marker: ${diagnosis.instructions.user}`,
		`Pharaoh managed instruction block: ${diagnosis.instructions.managed}`,
		`Project instruction marker: ${diagnosis.instructions.project}`,
		...diagnosis.runtime.map(
			({ client, status }) =>
				`Runtime observations (${client}): ${status.consent}; receipt coverage ${status.receiptCoverage}; token coverage ${status.tokenCoverage}.`,
		),
		"File presence does not establish instruction loading, skill use or compliance.",
		"The configured package pin is not inspected. For a general instruction audit, use Claude Code's /doctor prompt-audit.",
		"To inspect project markers for Claude Code, run npx @pharaoh-so/mcp@latest --doctor --client claude-code from the repository root.",
	].join("\n");
}
