/**
 * Composition root for saved-worktree answers. It hands src/local the proxy
 * services it runs with (the saved sign-in, the launch entry, the managed
 * clients), and hands runtime/local-worktree-hook.mjs's hook command its
 * compiled analysis, which the hook loads from this file's place in the build.
 * So neither src/local nor runtime/ imports anything above it.
 */
import { fileURLToPath } from "node:url";
import type { LocalWorktreeAnalysis } from "../runtime/local-worktree-hook.mjs";
import { verifiedCodingClients } from "./client-install.js";
import { readCredentials } from "./credentials.js";
import type { InstallScope } from "./install-types.js";
import type { LocalHost, LocalSignIn } from "./local/contracts.js";
import {
	fingerprintLocalSources,
	listLocalCheckoutPaths,
	resolveLocalCheckout,
} from "./local/scope.js";
import { isLocalSourcePath } from "./local/snapshot.js";
import { installedLocalAnalyzer } from "./local/worker-host.js";
import { renewOriginBoundSignIn, sameCredentialSnapshot } from "./refresh.js";
import { runningEntry } from "./version.js";

/**
 * The sign-in saved at `path`, read and compared as saved, and renewed against
 * its own server only.
 *
 * @param path - Credentials file; the user's when omitted
 * @returns The sign-in port local authorization runs with
 */
export function savedSignIn(path?: string): LocalSignIn {
	return {
		read: () => readCredentials(path),
		same: sameCredentialSnapshot,
		renew: (creds, server) => renewOriginBoundSignIn(creds, server, path),
	};
}

/**
 * The proxy services local answers run with, for this process's launch.
 *
 * @returns The user's saved sign-in, the entry registrations name, and the clients that run it
 */
export function localHost(scope?: InstallScope): LocalHost {
	const entry = runningEntry(fileURLToPath(new URL("./index.js", import.meta.url)));
	return {
		signIn: savedSignIn(),
		scope,
		entry,
		managedClients: () =>
			verifiedCodingClients({
				scope,
				runningLaunch: {
					command: process.execPath,
					args: [entry, ...(scope?.kind === "local" ? process.argv.slice(2) : [])],
				},
				rejectProjectOverrides: true,
				projectRoot: process.cwd(),
			}),
	};
}

/**
 * What the worktree hook command runs with.
 * @public Used by the packaged local-worktree hook through the compiled module.
 */
export const worktreeHookAnalysis: LocalWorktreeAnalysis = {
	resolveLocalCheckout,
	fingerprintLocalSources,
	listLocalCheckoutPaths,
	isLocalSourcePath,
	installedLocalAnalyzer,
	verifiedCodingClients,
};
