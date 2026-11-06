/** Coordinates the local authorization, capture, analysis and result lifetime. */

import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
	consumeLocalWorktreeContext,
	consumeNativeMemoryCall,
	type LocalRuntimeGeneration,
	localWorktreeBinding,
	localWorktreeClaimCurrent,
	nativeMemoryCallCurrent,
	nativeMemoryRuntimeBinding,
	observeRuntimeGeneration,
	releaseRuntimeGeneration,
	runtimeConversationBinding,
	verifyRuntimeSession,
} from "../../runtime/local-worktree-hook.mjs";
import { runtimeClient } from "../../runtime/runtime-native.mjs";
import { verifiedCodingClients } from "../client-install.js";
import { type Credentials, readCredentials } from "../credentials.js";
import { createLocalAuthorization, LocalAuthorizationError } from "./authorization.js";
import { type LocalBlastRuntime, type LocalDelivery, localRefusal } from "./contracts.js";
import type { BlastRoute, CheckoutEvidence, VerifiedCheckout } from "./dispatch.js";
import { formatLocalBlastRadius } from "./format.js";
import { resolveLocalCheckout } from "./scope.js";
import { captureLocalSnapshot } from "./snapshot.js";
import { installedLocalAnalyzer, type LocalAnalyzer, runLocalAnalyzer } from "./worker-host.js";

type Claimed = Extract<BlastRoute, { kind: "local" }>;

async function answerLocal(
	server: string,
	analyzer: LocalAnalyzer,
	route: Claimed,
	signal: AbortSignal,
	onDelivery: (settle: LocalDelivery) => void,
	expectedSignIn?: Credentials,
): Promise<CallToolResult> {
	let authorization: ReturnType<typeof createLocalAuthorization> | undefined;
	let permit:
		| Awaited<ReturnType<ReturnType<typeof createLocalAuthorization>["reserve"]>>
		| undefined;
	let settled = false;
	try {
		signal.throwIfAborted();
		const { checkout, query } = route;
		authorization = createLocalAuthorization({ server, expectedSignIn });
		permit = await authorization.reserve(checkout.repoSlug, signal);
		// A stale capture never earns an answer. Try once more if a save races a query.
		for (let attempt = 0; attempt < 2; attempt++) {
			signal.throwIfAborted();
			const snapshot = await captureLocalSnapshot(checkout, analyzer.reader, signal);
			if (snapshot.sources.size === 0) {
				return localRefusal(
					"unsupported_worktree",
					"No supported saved source files were captured.",
				);
			}
			const result = await runLocalAnalyzer(analyzer, snapshot, checkout.repoSlug, query, signal);
			if (expectedSignIn && !localWorktreeClaimCurrent(checkout)) {
				return localRefusal(
					"native_scope_changed",
					"The active worktree turn changed. Make a fresh local call.",
				);
			}
			signal.throwIfAborted();
			authorization.assertCurrentSignIn();
			const hasAnswer =
				result.callers.length > 0 || (result.status === "empty" && result.targets.length > 0);
			if (hasAnswer) {
				await authorization.confirm(permit, signal);
			} else {
				await authorization.abort(permit, "error", signal);
				settled = true;
			}
			// A save can land during the last authorization round trip.
			const checked = await captureLocalSnapshot(checkout, analyzer.reader, signal);
			if (snapshot.fingerprint !== checked.fingerprint) {
				if (settled) break;
				continue;
			}
			signal.throwIfAborted();
			authorization.assertCurrentSignIn();
			if (hasAnswer && Date.now() >= permit.expiresAt)
				throw new LocalAuthorizationError("permit_expired");
			if (expectedSignIn && !localWorktreeClaimCurrent(checkout)) {
				return localRefusal(
					"native_scope_changed",
					"The active worktree turn changed. Make a fresh local call.",
				);
			}
			const answer = formatLocalBlastRadius(result, snapshot);
			if (hasAnswer) {
				const currentAuthorization = authorization;
				const currentPermit = permit;
				const outcome = result.callers.length > 0 ? "answered" : "valid_empty";
				onDelivery(async (written) => {
					try {
						if (written) {
							await currentAuthorization.commit(currentPermit, outcome, AbortSignal.timeout(5_000));
						} else await currentAuthorization.abort(currentPermit, "cancelled");
					} catch {
						// A lost receipt never turns a delivered answer into a refusal.
					}
				});
				settled = true;
			}
			return answer;
		}
		return localRefusal(
			"worktree_changed",
			"The worktree kept changing during analysis. Make a fresh local call.",
		);
	} catch (error) {
		if (error instanceof LocalAuthorizationError) return localRefusal(error.code, error.message);
		return localRefusal(
			signal.aborted ? "local_cancelled" : "local_unavailable",
			signal.aborted
				? "Local worktree analysis was cancelled."
				: "Local worktree analysis could not finish. Make a fresh local call.",
		);
	} finally {
		if (authorization && permit && !settled)
			await authorization.abort(permit, signal.aborted ? "cancelled" : "error").catch(() => {});
	}
}

/**
 * Prepare the installed analyzer and bind native scope only after stdio negotiation.
 * @param server - Existing Pharaoh origin used for authorization metadata only
 * @param invocation - Optional trusted CLI workspace evidence
 * @returns The local dispatcher when its exact installed assets are present
 */
export function createLocalBlastRuntime(
	server: string,
	invocation: CheckoutEvidence = { kind: "hosted-only" },
): LocalBlastRuntime | undefined {
	const analyzer = installedLocalAnalyzer();
	if (!analyzer) return undefined;
	const entry = fileURLToPath(new URL("../index.js", import.meta.url));
	const claimedSignIns = new WeakMap<VerifiedCheckout, Credentials>();
	let generation: LocalRuntimeGeneration | undefined;
	const managedClients = () =>
		verifiedCodingClients({
			runningLaunch: { command: process.execPath, args: [entry] },
			rejectProjectOverrides: true,
		});
	const managed = (client: LocalRuntimeGeneration["client"]) => managedClients().includes(client);
	const currentCheckout = (): CheckoutEvidence => {
		try {
			return resolveLocalCheckout(process.cwd());
		} catch {
			return { kind: "unverified" };
		}
	};
	return {
		invocation,
		canDeferHostedStartup() {
			return managedClients().length > 0 && currentCheckout().kind === "checkout";
		},
		connect(name) {
			const client = runtimeClient(name);
			if (!client || !managed(client)) return;
			const evidence = currentCheckout();
			if (evidence.kind === "checkout") {
				const binding = localWorktreeBinding(client, entry, readCredentials());
				generation = observeRuntimeGeneration(client, binding, evidence.checkout, {
					resolveCheckout: resolveLocalCheckout,
					memoryRuntime: nativeMemoryRuntimeBinding(client, entry),
				});
			}
		},
		canCheckReadiness: () => generation !== undefined,
		checkReadiness(args) {
			const client = generation?.client;
			const verified =
				client &&
				Object.keys(args).length === 1 &&
				managed(client) &&
				verifyRuntimeSession(generation, args.challenge, {
					binding: localWorktreeBinding(client, entry, readCredentials()),
				});
			if (!verified) return localRefusal("unverified_worktree");
			return {
				content: [
					{
						type: "text",
						text: `Pharaoh can analyze saved files in this worktree. For callers or impact in ${verified.checkout.repoSlug}, call get_blast_radius with local_context "${verified.token}". Use depth 1 for direct callers. Choose scope hosted for the default branch.`,
					},
				],
			};
		},
		memoryBinding: () => (generation ? runtimeConversationBinding(generation) : null),
		authorizeMemory(name, args) {
			const client = generation?.client;
			if (!client || !managed(client)) return undefined;
			const proof = consumeNativeMemoryCall(generation, name, args);
			return proof ? () => nativeMemoryCallCurrent(proof) : undefined;
		},
		disconnect: () => releaseRuntimeGeneration(generation),
		consume(name, token, args) {
			const client = runtimeClient(name);
			if (!client || client !== generation?.client || !managed(client)) return undefined;
			const credentials = readCredentials();
			if (!credentials) return undefined;
			const checkout = consumeLocalWorktreeContext(token, args, {
				client,
				binding: localWorktreeBinding(client, entry, credentials),
				resolveCheckout: resolveLocalCheckout,
				generation,
			});
			if (checkout) claimedSignIns.set(checkout, credentials);
			return checkout;
		},
		answer: (route, signal, onDelivery) =>
			answerLocal(server, analyzer, route, signal, onDelivery, claimedSignIns.get(route.checkout)),
	};
}
