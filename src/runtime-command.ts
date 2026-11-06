/** Explicit owner controls for optional, content-free native runtime observations. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { installRuntimeBundle } from "../runtime/runtime-bundle.mjs";
import {
	disableRuntime,
	enableRuntime,
	type RuntimeClient,
	type RuntimeDeviceApproval,
	type RuntimeDisableResult,
	type RuntimeOAuthCredentials,
	refreshRuntimeBuildEvidence,
	revokeRuntime,
	runtimeProfileReceipt,
	runtimeStatus,
	selectRuntimeProfile,
} from "../runtime/runtime-client.mjs";
import { RUNTIME_CLIENTS, runtimeBuild, runtimeUuid } from "../runtime/runtime-native.mjs";
import { openBrowser } from "./auth.js";
import { verifiedCodingClients } from "./client-install.js";
import { acquireCredentialsLock, readCredentials, writeCredentials } from "./credentials.js";
import { parseArgs, printLines } from "./helpers.js";
import { getPackageVersion } from "./version.js";

const OPERATIONS = [
	"--runtime-enable",
	"--runtime-revoke",
	"--runtime-status",
	"--runtime-profile",
	"--runtime-profile-receipt",
] as const;

type Operation = (typeof OPERATIONS)[number];
const RECEIPT_PROXY_VERSION = "0.3.70";

/** Attach a private binding to an existing sign-in, serialized with refresh and logout. */
async function bindRuntimeSignIn(server: string): Promise<boolean> {
	if (!readCredentials()) return false;
	const release = await acquireCredentialsLock();
	try {
		const credentials = readCredentials();
		if (
			!credentials ||
			new URL(credentials.sse_url).origin !== new URL(server).origin ||
			!(Date.parse(credentials.expires_at) > Date.now())
		)
			return false;
		if (!runtimeUuid(credentials.runtime_session))
			writeCredentials({ ...credentials, runtime_session: randomUUID() });
		return true;
	} finally {
		release();
	}
}

function parseRuntimeArgs(args: string[]) {
	let operation: Operation | undefined;
	let client: RuntimeClient | undefined;
	let value: string | undefined;
	let json = false;
	let server: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		const found = OPERATIONS.find((candidate) => candidate === flag);
		if (found && !operation) {
			operation = found;
			if (found === "--runtime-profile" || found === "--runtime-profile-receipt")
				value = args[++index];
		} else if (flag === "--client" && !client) {
			client = RUNTIME_CLIENTS.find((candidate) => candidate === args[index + 1]);
			if (!client) return null;
			index++;
		} else if (flag === "--server" && !server) {
			server = args[++index];
			if (!server || server.startsWith("-")) return null;
		} else if (flag === "--json" && !json) json = true;
		else return null;
	}
	if (
		!operation ||
		((operation === "--runtime-profile" || operation === "--runtime-profile-receipt") &&
			(!value || value.startsWith("-")))
	)
		return null;
	if (!["--runtime-status", "--runtime-revoke"].includes(operation) && !client) return null;
	return {
		operation,
		client,
		value,
		json,
		server: parseArgs(server ? ["--server", server] : []).server,
	};
}

function installedBuild(client: RuntimeClient): string {
	try {
		const version = execFileSync(client === "codex" ? "codex" : "claude", ["--version"], {
			encoding: "utf8",
			timeout: 2_000,
			maxBuffer: 4_096,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return runtimeBuild(version.match(/\b\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]+)?/)?.[0]);
	} catch {
		// A desktop-only or older client keeps unverified capabilities.
		return "unknown";
	}
}

/** Refresh ordinary proxy build evidence without invoking a model or running inside a native hook. */
export function refreshManagedRuntimeBuild(clientName: string | undefined): void {
	try {
		refreshRuntimeBuildEvidence(clientName, (client) => ({
			clientBuild: installedBuild(client),
			proxyBuild: getPackageVersion(),
		}));
	} catch {
		/* Optional installation discovery cannot prevent an answered tool call. */
	}
}

/** Use a fresh device grant only while the registration it created still matches. */
export async function enableInstalledRuntime(
	server: string,
	deviceApproval: RuntimeDeviceApproval,
	expectedRuntimeSession: string,
	canActivate: () => boolean,
): Promise<boolean> {
	if (!canActivate()) return false;
	return enableRuntime(deviceApproval.client, server, installRuntimeBundle(), {
		clientBuild: installedBuild(deviceApproval.client),
		proxyBuild: getPackageVersion(),
		deviceApproval,
		expectedRuntimeSession,
		canActivate,
	});
}

/** Report whether the off choice was saved independently of cleanup. */
export function describeRuntimeDisable(
	client: RuntimeClient,
	result: RuntimeDisableResult,
): string {
	switch (result) {
		case "disabled":
			return `${client}: runtime analytics is off and its data was cleared.`;
		case "cleanup_pending":
			return `${client}: runtime analytics is off locally. Rerun --runtime-revoke --client ${client} to finish cleanup.`;
		case "not_saved":
			return `${client}: could not save the runtime analytics off choice. Rerun --runtime-revoke --client ${client}.`;
		case "unsupported":
			return `${client}: runtime analytics is unavailable on this platform.`;
	}
}

/** Run one explicit consent, revocation, status or owner-profile command. */
export async function runRuntimeCommand(args: string[]): Promise<number> {
	const parsed = parseRuntimeArgs(args);
	if (!parsed) {
		printLines(
			"Pharaoh: choose one runtime command and a supported --client (claude-code or codex).",
		);
		return 2;
	}
	const { operation, client, value, json, server } = parsed;
	const clients = client ? [client] : RUNTIME_CLIENTS;
	if (operation === "--runtime-status") {
		const status = clients.map((name) => ({ client: name, ...runtimeStatus(name) }));
		if (json) process.stdout.write(`${JSON.stringify(status)}\n`);
		else
			for (const entry of status)
				printLines(
					`${entry.client}: ${entry.consent}; receipt coverage ${entry.receiptCoverage}; token coverage ${entry.tokenCoverage}.`,
				);
		return 0;
	}
	if (operation === "--runtime-revoke") {
		const results = await Promise.all(clients.map((name) => disableRuntime(name)));
		for (const [index, name] of clients.entries())
			printLines(describeRuntimeDisable(name, results[index]));
		return results.some((result) => result === "not_saved" || result === "cleanup_pending") ? 1 : 0;
	}
	if (!client) return 2;
	if (operation === "--runtime-profile" || operation === "--runtime-profile-receipt") {
		const selection =
			operation === "--runtime-profile"
				? selectRuntimeProfile(client, value ?? "")
				: runtimeProfileReceipt(client, value ?? "");
		if (json) process.stdout.write(`${JSON.stringify(selection)}\n`);
		else if (selection)
			printLines(
				`Pharaoh: ${selection.profileId} (${selection.selectionId}), expires ${selection.expiresAt}.${"episodeRef" in selection ? ` Episode ${selection.episodeRef}.` : ""}`,
			);
		else
			printLines("Pharaoh: no valid profile selection or consumed receipt for this installation.");
		return selection ? 0 : 1;
	}
	if (typeof process.getuid !== "function") {
		printLines(
			"Pharaoh: runtime observations currently require a POSIX client with private local files.",
		);
		return 1;
	}
	if (
		!verifiedCodingClients({
			requiredProxy: { minimumVersion: RECEIPT_PROXY_VERSION, server },
		}).includes(client)
	) {
		printLines(
			"Pharaoh: install an owned local connection first with npx @pharaoh-so/mcp@latest install. Custom and disabled connections are kept.",
		);
		return 1;
	}
	if (!(await bindRuntimeSignIn(server))) {
		printLines(
			"Pharaoh: sign in with the developer installer before enabling runtime observations.",
		);
		return 1;
	}
	const enabled = await enableRuntime(client, server, installRuntimeBundle(), {
		clientBuild: installedBuild(client),
		proxyBuild: getPackageVersion(),
		onApproval: (url, reference) => {
			printLines(
				`Pharaoh: review and approve runtime observations in your browser. Check that it shows reference ${reference}.`,
				url,
			);
			openBrowser(url);
		},
	});
	if (!enabled) {
		printLines(
			"Pharaoh: runtime enrollment or hook setup could not be confirmed. Check --runtime-status and retry any pending revocation first.",
		);
		return 1;
	}
	printLines(
		"Pharaoh: content-free runtime observations enabled. Restart the client and complete any native hook trust review. Ordinary MCP use and project memory are unchanged.",
	);
	return 0;
}

/** Clear owned observations and deliver revocation, or retain a visible pending request. */
export async function clearRuntimeForCleanup(
	credentials?: RuntimeOAuthCredentials | null,
): Promise<boolean> {
	if (typeof process.getuid !== "function") return true;
	const outcomes = await Promise.allSettled(
		RUNTIME_CLIENTS.map((client) =>
			revokeRuntime(
				client,
				credentials === undefined ? {} : { oauthCredentials: () => credentials },
			),
		),
	);
	const complete = outcomes.every((outcome) => outcome.status === "fulfilled" && outcome.value);
	if (!complete)
		printLines(
			"Pharaoh: runtime revocation or hook cleanup is pending. After signing in to the original server, run --runtime-revoke to finish.",
		);
	return complete;
}
