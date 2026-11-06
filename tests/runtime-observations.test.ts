/** Exercise the independent consent, native reduction, profile binding and delivery boundary. */
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	automaticRuntimeIntent,
	claimRuntimeDelivery,
	configuredRuntimeHooks,
	disableRuntime,
	enableRuntime,
	flushRuntimeQueue,
	recordRuntimeHook,
	revokeRuntime,
	type RuntimeClient,
	type RuntimeOAuthCredentials,
	type RuntimeOptions,
	runtimeProfileReceipt,
	runtimeRequestMetadata,
	runtimeStatus,
	refreshRuntimeBuildEvidence,
	selectRuntimeProfile,
} from "../runtime/runtime-client.mjs";
import { type RuntimeEvent, RUNTIME_POLICY_VERSION } from "../runtime/runtime-contract.mjs";
import { EVENT_TTL_MS, RUNTIME_META } from "../runtime/runtime-native.mjs";

const SERVER = "https://mcp.example.test";
const NOW = Date.parse("2026-11-05T18:00:00.000Z");
const RUNTIME_TOKEN = "test-runtime-credential-private-0123456789";
const DEVICE_APPROVAL = "b".repeat(64);
const OAUTH_TOKEN = "test-oauth-credential-private";
const SESSION = "native-session-private";
const TURN = "native-turn-private";
const SENTINEL = "PRIVATE_INPUT_MUST_NEVER_LEAVE";

type Batch = { body: string; headers: Headers; events: RuntimeEvent[] };
const credentialsFor = (server: string): RuntimeOAuthCredentials => ({
	access_token: OAUTH_TOKEN,
	expires_at: new Date(Date.now() + 60_000).toISOString(),
	sse_url: `${server}/sse`,
	runtime_session: randomUUID(),
});

describe.skipIf(typeof process.getuid !== "function")(
	"independent native runtime observations",
	() => {
		let home: string;
		let batches: Batch[];
		let options: RuntimeOptions;
		let rejectEnrollment: boolean;
		let metadataVersion: number;
		let offline: boolean;
		let holdReceipt: boolean;
		let signIn: RuntimeOAuthCredentials | null;
		let approvalUrl: string;
		let approvalsBeforeGrant: number;
		let browserOrigin: string;
		let deviceRedemptions: Array<Record<string, unknown>>;

		beforeEach(() => {
			home = realpathSync(mkdtempSync(join(tmpdir(), "pharaoh-runtime-observations-")));
			batches = [];
			rejectEnrollment = false;
			metadataVersion = 1;
			offline = false;
			holdReceipt = false;
			signIn = credentialsFor(SERVER);
			approvalUrl = "";
			approvalsBeforeGrant = 0;
			browserOrigin = SERVER;
			deviceRedemptions = [];
			options = {
				home,
				now: NOW,
				env: {},
				clientBuild: "2.1.318",
				proxyBuild: "0.3.67",
				readOAuthCredentials: () => signIn,
				onApproval: (url) => {
					approvalUrl = url;
				},
				wait: async () => {},
				fetchImpl: async (input, init) => {
					if (offline) throw new Error("offline");
					const url = new URL(String(input));
					const body = String(init?.body);
					const parsed = JSON.parse(body);
					const approvalId = "a".repeat(64);
					if (url.pathname.endsWith("/approvals"))
						return Response.json(
							{
								approvalId,
								verificationUrl: `${browserOrigin}/setup/runtime-approval?code=${approvalId}`,
								expiresAt: new Date(NOW + 600_000).toISOString(),
							},
							{ status: 201 },
						);
					if (url.pathname.endsWith("/installations")) {
						if (!parsed.enabled)
							return Response.json({
								installationId: parsed.installationId,
								generation: parsed.generation,
								revoked: true,
								policyVersion: RUNTIME_POLICY_VERSION,
							});
						if (parsed.approvalId === DEVICE_APPROVAL) deviceRedemptions.push(parsed);
						else if (parsed.approvalId !== approvalId || !approvalUrl)
							return Response.json({ error: "approval_required" }, { status: 403 });
						if (approvalsBeforeGrant > 0) {
							approvalsBeforeGrant--;
							return Response.json({ error: "approval_pending" }, { status: 202 });
						}
						return Response.json({
							installationId: parsed.installationId,
							generation: parsed.generation,
							credential: RUNTIME_TOKEN,
							policyVersion: rejectEnrollment ? "future" : RUNTIME_POLICY_VERSION,
							metadataVersion,
							activatedAt: new Date(NOW).toISOString(),
							expiresAt: null,
						});
					}
					const events: RuntimeEvent[] = parsed.events;
					batches.push({ body, headers: new Headers(init?.headers), events });
					return Response.json({
						metadataVersion,
						acceptedEventIds: events
							.filter((event) => !holdReceipt || !event.receipt)
							.map((event) => event.eventId),
						rejectedEventIds: [],
						pendingEventIds: events
							.filter((event) => holdReceipt && event.receipt)
							.map((event) => event.eventId),
					});
				},
			};
		});

		afterEach(() => rmSync(home, { recursive: true, force: true }));

		const hook = (
			client: RuntimeClient,
			event: string,
			input: Record<string, unknown> = {},
			override: RuntimeOptions = {},
		) =>
			recordRuntimeHook(
				client,
				{ hook_event_name: event, session_id: SESSION, cwd: home, ...input },
				{ ...options, ...override },
			);
		const enable = (client: RuntimeClient) =>
			enableRuntime(client, SERVER, join(home, "pinned", "hook.mjs"), {
				...options,
				clientBuild: client === "codex" ? "0.164.0" : "2.1.318",
			});

		it("registers v2 hooks only after server negotiation and preserves v1 collection during rollout", async () => {
			expect(await enable("claude-code")).toBe(true);
			const settings = () =>
				JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
			expect(settings().hooks.PostModelSwitch).toBeUndefined();
			hook("claude-code", "UserPromptSubmit");
			hook("claude-code", "Stop");
			metadataVersion = 2;
			await flush("claude-code");
			expect(
				batches.flatMap((batch) => batch.events).every((event) => event.exploration === undefined),
			).toBe(true);
			expect(settings().hooks.PostModelSwitch).toHaveLength(1);
			hook("claude-code", "SessionStart", { model: "claude-opus-5-5" });
			hook("claude-code", "UserPromptSubmit", { prompt_id: TURN });
			hook("claude-code", "Stop", { prompt_id: TURN });
			await flush("claude-code");
			expect(
				batches
					.flatMap((batch) => batch.events)
					.some((event) => event.exploration?.capability === "claude-session-switch-v2"),
			).toBe(true);
			metadataVersion = 1;
			hook("claude-code", "UserPromptSubmit", { prompt_id: "downgrade-turn" });
			hook("claude-code", "Stop", { prompt_id: "downgrade-turn" });
			await flush("claude-code");
			expect(settings().hooks.PostModelSwitch).toBeUndefined();
		});
		function deviceOptions(client: RuntimeClient): RuntimeOptions {
			const intent = automaticRuntimeIntent(client, options);
			if (!intent || !signIn?.runtime_session)
				throw new Error("expected an eligible device fixture");
			return {
				...options,
				deviceApproval: {
					...intent,
					approvalId: DEVICE_APPROVAL,
					expiresAt: new Date(NOW + 120_000).toISOString(),
				},
				expectedRuntimeSession: signIn.runtime_session,
			};
		}
		async function flush(client: RuntimeClient) {
			const lease = claimRuntimeDelivery(client, options);
			if (!lease) throw new Error("expected a queued delivery");
			await flushRuntimeQueue(client, lease, options);
		}

		it("negotiates v2, propagates only Claude session selection and invalidates switched generations", async () => {
			metadataVersion = 2;
			expect(await enable("claude-code")).toBe(true);
			hook("claude-code", "SessionStart", { model: "claude-opus-5-5", source: "startup" });
			hook("claude-code", "UserPromptSubmit", { prompt_id: "prompt-1", prompt: SENTINEL });
			hook("claude-code", "Stop", { prompt_id: "prompt-1" });
			await flush("claude-code");
			const before = batches.flatMap((batch) => batch.events);
			expect(before).toHaveLength(2);
			expect(before[0].exploration).toMatchObject({
				modelId: "claude-opus-5-5",
				modelBasis: "session_selected",
				capability: "claude-session-switch-v2",
			});
			expect(before[1].exploration?.selectionGeneration).toBe(
				before[0].exploration?.selectionGeneration,
			);
			hook("claude-code", "PostModelSwitch", {
				to: "claude-opus-999-private",
				from: "claude-opus-5-5",
			});
			hook("claude-code", "UserPromptSubmit", { prompt_id: "prompt-2" });
			await flush("claude-code");
			const after = batches.flatMap((batch) => batch.events);
			expect(after.find((event) => event.kind === "session_state")?.invalidateGeneration).toBe(
				before[0].exploration?.selectionGeneration,
			);
			expect(after.at(-1)?.exploration).toMatchObject({
				modelId: null,
				modelState: "unrecognized",
				modelFamily: "opus",
			});
			const uploaded = batches.map((batch) => batch.body).join("");
			expect(uploaded).not.toContain(SENTINEL);
			expect(uploaded).not.toContain("claude-opus-999-private");
			expect(uploaded).not.toContain("prompt-1");
		});

		it("keeps missing starts unsupported and build refresh cannot upgrade an old hook manifest", async () => {
			metadataVersion = 2;
			expect(
				await enableRuntime("claude-code", SERVER, join(home, "pinned", "hook.mjs"), {
					...options,
					clientBuild: "2.1.200",
				}),
			).toBe(true);
			hook("claude-code", "UserPromptSubmit", { prompt_id: "missing-start" });
			await flush("claude-code");
			expect(batches[0].events[0].exploration).toMatchObject({
				modelState: "absent",
				capability: "unsupported",
			});
			options.now = NOW + EVENT_TTL_MS + 1;
			let discoveries = 0;
			const discover = () => {
				discoveries++;
				return { clientBuild: "2.1.318", proxyBuild: "0.3.90" };
			};
			expect(refreshRuntimeBuildEvidence("claude-code", discover, options)).toBe(true);
			expect(refreshRuntimeBuildEvidence("claude-code", discover, options)).toBe(false);
			expect(discoveries).toBe(1);
			hook("claude-code", "SessionStart", { model: "claude-opus-5-5", source: "resume" });
			hook("claude-code", "UserPromptSubmit", { prompt_id: "after-upgrade" });
			await flush("claude-code");
			expect(batches.at(-1)?.events.at(-1)?.exploration).toMatchObject({
				clientBuild: "2.1.318",
				capability: "unsupported",
			});
		});

		it("delivers an idle switch after local expiry and retains its invalidation until accepted ACK", async () => {
			metadataVersion = 2;
			await enable("claude-code");
			hook("claude-code", "SessionStart", { model: "claude-opus-5-5" });
			hook("claude-code", "UserPromptSubmit", { prompt_id: TURN });
			hook("claude-code", "Stop", { prompt_id: TURN });
			await flush("claude-code");
			const generation = batches[0].events[0].exploration?.selectionGeneration;
			options.now = NOW + EVENT_TTL_MS + 1;
			expect(hook("claude-code", "PostModelSwitch", { to: "claude-opus-5-5" })).toBe(true);
			const deliver = options.fetchImpl;
			const rejected: RuntimeEvent[] = [];
			options.fetchImpl = async (_input, init) => {
				const events = JSON.parse(String(init?.body)).events as RuntimeEvent[];
				rejected.push(...events);
				return Response.json({
					metadataVersion: 2,
					acceptedEventIds: [],
					rejectedEventIds: events.map((e) => e.eventId),
					pendingEventIds: [],
				});
			};
			await flush("claude-code");
			expect(rejected.length).toBeGreaterThan(0);
			expect(new Set(rejected.map((event) => event.eventId)).size).toBe(1);
			expect(rejected[0]).toMatchObject({
				kind: "session_state",
				invalidateGeneration: generation,
			});
			options.now = NOW + EVENT_TTL_MS * 3;
			options.fetchImpl = deliver;
			await flush("claude-code");
			expect(batches.at(-1)?.events).toMatchObject([
				{ eventId: rejected[0].eventId, invalidateGeneration: generation },
			]);
			expect(claimRuntimeDelivery("claude-code", options)).toBeNull();
		});

		it("preserves warnings when ordinary events overflow and bounds invalidation overflow conservatively", async () => {
			metadataVersion = 2;
			await enable("claude-code");
			hook("claude-code", "SessionStart", { model: "claude-opus-5-5" });
			for (let index = 0; index < 270; index++)
				hook("claude-code", "UserPromptSubmit", { prompt_id: `queued-${index}` });
			await flush("claude-code");
			expect(batches[0].events[0]).toMatchObject({ kind: "session_state", lifecycle: "ambiguous" });
			for (let index = 0; index < 18; index++)
				hook("claude-code", "PostModelSwitch", { to: "claude-opus-5-5" });
			batches = [];
			await flush("claude-code");
			expect(batches[0].events[0]).toMatchObject({ kind: "session_state", invalidateAll: true });
			expect(batches[0].events[0].invalidateGeneration).toBeUndefined();
		});

		it("invalidates inactive and evicted native selections and keeps Codex attempts unsupported", async () => {
			metadataVersion = 2;
			await enable("claude-code");
			for (let index = 0; index < 33; index++) {
				hook("claude-code", "SessionStart", {
					session_id: `session-${index}`,
					model: "claude-opus-5-5",
				});
				hook("claude-code", "UserPromptSubmit", {
					session_id: `session-${index}`,
					prompt_id: `prompt-${index}`,
				});
				options.now = NOW + index + 1;
			}
			await flush("claude-code");
			expect(
				batches.flatMap((batch) => batch.events).filter((event) => event.lifecycle === "evicted"),
			).toHaveLength(1);
			options.now = NOW + EVENT_TTL_MS + 100;
			hook("claude-code", "UserPromptSubmit", { session_id: "session-32", prompt_id: "later" });
			await flush("claude-code");
			expect(batches.at(-1)?.events.at(-1)?.exploration?.modelState).toBe("absent");
			options.now = NOW;
			await enable("codex");
			hook("codex", "UserPromptSubmit", { turn_id: TURN, model: "gpt-6.1-sol" });
			hook("codex", "PostModelRequest", {
				turn_id: TURN,
				model: "gpt-6.1-sol",
				status: "completed",
			});
			await flush("codex");
			expect(batches.at(-1)?.events.at(-1)?.exploration).toMatchObject({
				modelId: "gpt-6.1-sol",
				modelBasis: "request_observed",
				capability: "codex-uncorrelated-v2",
			});
		});

		it("requires a compatible acknowledgment and preserves memory and custom hooks when revocation is offline", async () => {
			const configDir = join(home, ".claude");
			mkdirSync(configDir);
			const path = join(configDir, "settings.json");
			const original = {
				hooks: {
					UserPromptSubmit: [
						{ hooks: [{ type: "command", command: "memory-hook --pharaoh-memory-user-v1" }] },
					],
				},
				custom: true,
			};
			writeFileSync(path, JSON.stringify(original));
			rejectEnrollment = true;
			expect(await enable("claude-code")).toBe(false);
			expect(hook("claude-code", "UserPromptSubmit", { prompt: SENTINEL })).toBe(false);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);
			rejectEnrollment = false;
			expect(await enable("claude-code")).toBe(true);
			expect(hook("claude-code", "UserPromptSubmit", { prompt: SENTINEL })).toBe(true);
			const installed = JSON.parse(readFileSync(path, "utf8"));
			expect(installed.hooks.UserPromptSubmit[0]).toEqual(original.hooks.UserPromptSubmit[0]);
			expect(installed.hooks.PostToolUse[0].matcher).toMatch(/Skill.*mcp__pharaoh__/);
			expect(runtimeStatus("claude-code", options)).toMatchObject({
				consent: "active",
				receiptCoverage: "unobserved",
				tokenCoverage: "unsupported",
			});
			offline = true;
			expect(await disableRuntime("claude-code", options)).toBe("cleanup_pending");
			const directory = join(home, ".pharaoh", "runtime-observations");
			expect(existsSync(join(directory, "claude-code"))).toBe(false);
			expect(readFileSync(join(directory, "revoke-claude-code.json"), "utf8")).not.toContain(
				RUNTIME_TOKEN,
			);
			expect(runtimeStatus("claude-code", options).consent).toBe("revocation_pending");
			expect(hook("claude-code", "UserPromptSubmit")).toBe(false);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);
			offline = false;
			expect(await revokeRuntime("claude-code", options)).toBe(true);
			expect(runtimeStatus("claude-code", options).consent).toBe("off");
			expect(automaticRuntimeIntent("claude-code", options)).toBeNull();
		});

		it("cannot report a saved off switch while the local choice lock is held", async () => {
			expect(await enable("claude-code")).toBe(true);
			const directory = join(home, ".pharaoh", "runtime-observations");
			const lock = join(directory, "choice-claude-code.lock");
			mkdirSync(lock, { mode: 0o700 });
			try {
				expect(await disableRuntime("claude-code", options)).toBe("not_saved");
				expect(existsSync(join(directory, "choice-claude-code.json"))).toBe(false);
				expect(hook("claude-code", "UserPromptSubmit")).toBe(true);
			} finally {
				rmSync(lock, { recursive: true });
			}
			expect(await disableRuntime("claude-code", options)).toBe("disabled");
			expect(hook("claude-code", "UserPromptSubmit")).toBe(false);
		});

		it("does not use a new server's bearer to retry an older server's revocation", async () => {
			expect(await enable("claude-code")).toBe(true);
			offline = true;
			expect(await revokeRuntime("claude-code", options)).toBe(false);
			offline = false;
			const nextServer = "https://new.example.test";
			const nextCredentials = credentialsFor(nextServer);
			const dispatched: string[] = [];
			expect(
				await enableRuntime("claude-code", nextServer, join(home, "pinned", "hook.mjs"), {
					...options,
					readOAuthCredentials: () => nextCredentials,
					oauthCredentials: () => nextCredentials,
					fetchImpl: async (url, init) => {
						dispatched.push(String(url));
						return options.fetchImpl?.(url, init) ?? Response.error();
					},
				}),
			).toBe(false);
			expect(dispatched).toEqual([]);
			expect(runtimeStatus("claude-code", options).consent).toBe("revocation_pending");
			expect(await revokeRuntime("claude-code", options)).toBe(true);
		});

		it("opens only the bound approval page and waits for its grant before installing hooks", async () => {
			browserOrigin = "https://different.example.test";
			expect(await enable("claude-code")).toBe(false);
			expect(approvalUrl).toBe("");
			const settings = join(home, ".claude", "settings.json");
			expect(existsSync(settings)).toBe(false);
			browserOrigin = SERVER;
			approvalsBeforeGrant = 1;
			options.wait = async () => {
				expect(existsSync(settings)).toBe(false);
				expect(hook("claude-code", "UserPromptSubmit")).toBe(false);
			};
			expect(await enable("claude-code")).toBe(true);
			expect(approvalUrl).toBe(`${SERVER}/setup/runtime-approval?code=${"a".repeat(64)}`);
			expect(approvalsBeforeGrant).toBe(0);
			expect(existsSync(settings)).toBe(true);
		});

		it("redeems the exact device approval once without a browser and leaves other profiles alone", async () => {
			const hookPath = join(home, "pinned", "hook.mjs");
			const automatic = deviceOptions("claude-code");
			expect(existsSync(join(home, ".pharaoh"))).toBe(false);
			expect(await enableRuntime("codex", SERVER, hookPath, automatic)).toBe(false);
			expect(
				await enableRuntime("claude-code", SERVER, hookPath, {
					...automatic,
					expectedRuntimeSession: randomUUID(),
				}),
			).toBe(false);
			expect(await enableRuntime("claude-code", SERVER, hookPath, automatic)).toBe(true);
			expect(await enableRuntime("claude-code", SERVER, hookPath, automatic)).toBe(false);
			expect(approvalUrl).toBe("");
			expect(deviceRedemptions).toEqual([
				expect.objectContaining({
					client: "claude-code",
					installationId: automatic.deviceApproval?.installationId,
					generation: automatic.deviceApproval?.generation,
					approvalId: DEVICE_APPROVAL,
				}),
			]);
			expect(hook("claude-code", "UserPromptSubmit")).toBe(true);
			expect(hook("codex", "UserPromptSubmit")).toBe(false);
		});

		it("keeps an explicit opt-out across cleanup and sign-in until a manual enrollment succeeds", async () => {
			const automatic = deviceOptions("claude-code");
			expect(await disableRuntime("claude-code", options)).toBe("disabled");
			expect(await revokeRuntime("claude-code", options)).toBe(true);
			signIn = credentialsFor(SERVER);
			expect(automaticRuntimeIntent("claude-code", options)).toBeNull();
			expect(automaticRuntimeIntent("codex", options)).not.toBeNull();
			expect(
				await enableRuntime("claude-code", SERVER, join(home, "pinned", "hook.mjs"), {
					...automatic,
					expectedRuntimeSession: signIn.runtime_session,
				}),
			).toBe(false);
			expect(deviceRedemptions).toEqual([]);
			rejectEnrollment = true;
			expect(await enable("claude-code")).toBe(false);
			expect(automaticRuntimeIntent("claude-code", options)).toBeNull();
			rejectEnrollment = false;
			expect(await enable("claude-code")).toBe(true);
			expect(hook("claude-code", "UserPromptSubmit")).toBe(true);
		});

		it("makes a device acknowledgment arriving after explicit revocation inert", async () => {
			const automatic = deviceOptions("claude-code");
			let startRequest = () => {};
			const started = new Promise<void>((resolve) => {
				startRequest = resolve;
			});
			let sendAcknowledgment = () => {};
			const acknowledgment = new Promise<void>((resolve) => {
				sendAcknowledgment = resolve;
			});
			const enabling = enableRuntime("claude-code", SERVER, join(home, "pinned", "hook.mjs"), {
				...automatic,
				fetchImpl: async (url, init) => {
					if (JSON.parse(String(init?.body)).enabled) {
						startRequest();
						await acknowledgment;
					}
					return options.fetchImpl?.(url, init) ?? Response.error();
				},
			});
			await started;
			expect(await disableRuntime("claude-code", options)).toBe("disabled");
			sendAcknowledgment();
			expect(await enabling).toBe(false);
			expect(automaticRuntimeIntent("claude-code", options)).toBeNull();
			expect(runtimeRequestMetadata("claude-code", options)).toBeUndefined();
			expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
		});

		it("preserves an older observer added to the settings before device publication", async () => {
			const automatic = deviceOptions("claude-code");
			const directory = join(home, ".claude");
			const settings = join(directory, "settings.json");
			const older = {
				hooks: {
					Stop: [{ hooks: [{ command: `older '${randomUUID()}' --pharaoh-runtime-v1` }] }],
				},
			};
			expect(
				await enableRuntime("claude-code", SERVER, join(home, "pinned", "hook.mjs"), {
					...automatic,
					fetchImpl: async (url, init) => {
						if (JSON.parse(String(init?.body)).enabled) {
							mkdirSync(directory);
							writeFileSync(settings, JSON.stringify(older));
						}
						return options.fetchImpl?.(url, init) ?? Response.error();
					},
				}),
			).toBe(false);
			expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(older);
			expect(runtimeRequestMetadata("claude-code", options)).toBeUndefined();
			expect(automaticRuntimeIntent("claude-code", options)).toBeNull();
		});

		it("cannot activate an enrollment revoked while browser approval was pending", async () => {
			approvalsBeforeGrant = 1;
			options.wait = async () => {
				offline = true;
				expect(await revokeRuntime("claude-code", options)).toBe(false);
				offline = false;
			};
			expect(await enable("claude-code")).toBe(false);
			expect(runtimeStatus("claude-code", options).consent).toBe("off");
			expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
		});

		it("fences a changed sign-in and revokes the recorded profile before re-enrollment", async () => {
			const other = join(home, "other-claude");
			const override = { env: { CLAUDE_CONFIG_DIR: other } };
			expect(await enable("claude-code")).toBe(true);
			const original = runtimeStatus("claude-code", options).generation;
			const settings = join(home, ".claude", "settings.json");
			expect(hook("claude-code", "UserPromptSubmit", {}, override)).toBe(false);
			signIn = credentialsFor(SERVER);
			expect(runtimeStatus("claude-code", options).consent).toBe("paused");
			expect(runtimeRequestMetadata("claude-code", options)).toBeUndefined();
			expect(hook("claude-code", "UserPromptSubmit")).toBe(false);
			expect(await revokeRuntime("claude-code", { ...options, ...override })).toBe(true);
			expect(JSON.parse(readFileSync(settings, "utf8")).hooks).toEqual({});
			expect(existsSync(other)).toBe(false);
			expect(await enable("claude-code")).toBe(true);
			const next = runtimeStatus("claude-code", options).generation;
			expect(next).not.toBe(original);
			expect(hook("claude-code", "UserPromptSubmit", {}, { generation: original })).toBe(false);
			expect(hook("claude-code", "UserPromptSubmit", {}, { generation: next })).toBe(true);
		});

		it("reconciles replaced hook settings while retaining the active generation", async () => {
			expect(await enable("claude-code")).toBe(true);
			const generation = runtimeStatus("claude-code", options).generation;
			const path = join(home, ".claude", "settings.json");
			const unrelated = { type: "command", command: "custom-hook" };
			writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [unrelated] }] } }));
			const hookPath = join(home, "new-pinned", "hook.mjs");
			expect(await enableRuntime("claude-code", SERVER, hookPath, options)).toBe(true);
			expect(runtimeStatus("claude-code", options).generation).toBe(generation);
			const updated = JSON.parse(readFileSync(path, "utf8"));
			expect(updated.hooks.Stop[0]).toEqual({ hooks: [unrelated] });
			expect(updated.hooks.Stop[1].hooks[0].command).toContain(hookPath);
			expect(hook("claude-code", "UserPromptSubmit", {}, { hookPath })).toBe(true);
			expect(
				hook("claude-code", "UserPromptSubmit", {}, { hookPath: join(home, "pinned", "hook.mjs") }),
			).toBe(false);
		});

		it("fences a sender revoked while it is obtaining OAuth", async () => {
			expect(await enable("claude-code")).toBe(true);
			expect(hook("claude-code", "UserPromptSubmit")).toBe(true);
			const lease = claimRuntimeDelivery("claude-code", options);
			if (!lease) throw new Error("expected a queued delivery");
			let resume = () => {};
			const token = new Promise<RuntimeOAuthCredentials>((resolve) => {
				resume = () => {
					if (!signIn) throw new Error("expected signed-in fixture");
					resolve(signIn);
				};
			});
			const sending = flushRuntimeQueue("claude-code", lease, {
				...options,
				oauthCredentials: () => token,
			});
			expect(await revokeRuntime("claude-code", options)).toBe(true);
			resume();
			await sending;
			expect(batches).toEqual([]);
			expect(claimRuntimeDelivery("claude-code", options)).toBeNull();
		});

		it("retries a failed final callback without more native activity and persists expiry pruning", async () => {
			expect(await enable("claude-code")).toBe(true);
			expect(hook("claude-code", "UserPromptSubmit")).toBe(true);
			expect(hook("claude-code", "Stop")).toBe(true);
			offline = true;
			options.wait = async (delay) => {
				expect(delay).toBe(1_000);
				offline = false;
			};
			await flush("claude-code");
			expect(batches.flatMap((batch) => batch.events).map((event) => event.kind)).toEqual([
				"episode_start",
				"episode_end",
			]);
			expect(hook("claude-code", "UserPromptSubmit")).toBe(true);
			const queue = join(home, ".pharaoh", "runtime-observations", "claude-code", "queue.json");
			expect(JSON.parse(readFileSync(queue, "utf8"))).toHaveLength(1);
			expect(
				claimRuntimeDelivery("claude-code", { ...options, now: NOW + EVENT_TTL_MS + 1 }),
			).toBeNull();
			expect(JSON.parse(readFileSync(queue, "utf8"))).toEqual([]);
		});

		it("delivers new events after a full pending batch and keeps pending receipt identities", async () => {
			expect(await enable("claude-code")).toBe(true);
			for (let i = 0; i < 20; i++)
				expect(
					hook("claude-code", "PostToolUse", {
						tool_name: "mcp__pharaoh__get_module_context",
						tool_use_id: `native-call-${i}`,
						tool_response: {
							_meta: {
								[RUNTIME_META]: {
									receipt: randomUUID(),
									expiresAt: new Date(NOW + 60_000).toISOString(),
								},
							},
						},
					}),
				).toBe(true);
			expect(hook("claude-code", "UserPromptSubmit")).toBe(true);
			holdReceipt = true;
			await flush("claude-code");
			expect(batches[0].events).toHaveLength(20);
			expect(batches[0].events.every((event) => event.receipt)).toBe(true);
			expect(
				batches
					.slice(1)
					.flatMap((batch) => batch.events)
					.map((event) => event.kind),
			).toContain("episode_start");
			const pendingIds = batches[0].events.map((event) => event.eventId).sort();
			const firstRetry = batches.length;
			holdReceipt = false;
			await flush("claude-code");
			expect(
				batches
					.slice(firstRetry)
					.flatMap((batch) => batch.events)
					.map((event) => event.eventId)
					.sort(),
			).toEqual(pendingIds);
		});

		it("retains only finite scoped load and skill observations and joins only structured receipts", async () => {
			expect(await enable("claude-code")).toBe(true);
			const path = join(home, ".claude", "CLAUDE.md");
			writeFileSync(
				path,
				`${SENTINEL}\nIn repos Pharaoh has mapped, before searching or reading files, ask Pharaoh where the relevant code is, what calls it, and whether what you need already exists.\n`,
			);
			hook("claude-code", "InstructionsLoaded", {
				file_path: path,
				memory_type: "User",
				load_reason: "session_start",
			});
			hook("claude-code", "InstructionsLoaded", {
				file_path: join(home, "unrelated-private-file.md"),
				memory_type: "User",
				load_reason: "include",
			});
			hook("claude-code", "UserPromptSubmit", { prompt: SENTINEL });
			hook("claude-code", "PreToolUse", {
				tool_name: "Skill",
				tool_input: { skill: "pharaoh:plan", args: SENTINEL },
			});
			hook("claude-code", "UserPromptExpansion", {
				expansion_type: "slash_command",
				command_source: "plugin",
				command_name: "pharaoh:review",
				prompt: SENTINEL,
			});
			expect(
				hook("claude-code", "PreToolUse", { tool_name: "Skill", tool_input: { skill: SENTINEL } }),
			).toBe(false);
			const receipt = randomUUID();
			const meta = { [RUNTIME_META]: { receipt, expiresAt: new Date(NOW + 60_000).toISOString() } };
			hook("claude-code", "PostToolUse", {
				tool_name: "mcp__pharaoh__get_module_context",
				tool_use_id: "private-tool-use",
				tool_input: { module: SENTINEL },
				tool_response: { _meta: meta, content: [SENTINEL] },
			});
			hook("claude-code", "PostToolUse", {
				tool_name: "mcp__pharaoh__get_module_context",
				tool_use_id: "private-other-call",
				tool_response: { content: [JSON.stringify(meta)] },
			});
			hook("claude-code", "Stop", { last_assistant_message: SENTINEL });
			holdReceipt = true;
			await flush("claude-code");
			const events = batches[0].events;
			expect(events.map((event) => event.kind)).toEqual([
				"instruction_load",
				"instruction_load",
				"episode_start",
				"skill_request",
				"skill_expansion_request",
				"tool_call",
				"tool_call",
				"episode_end",
			]);
			expect(events[0]).toMatchObject({ instructionScope: "User", marker: "exact" });
			expect(events[1].marker).toBe("unknown");
			expect(events[5]).toMatchObject({
				receipt,
				nativeCallRef: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
			expect(events[6]).not.toHaveProperty("receipt");
			expect(events[7].outcome).toBe("stop_observed");
			expect(batches[0].headers.get("authorization")).toBe(`Bearer ${OAUTH_TOKEN}`);
			expect(batches[0].headers.get("x-pharaoh-runtime")).toBe(RUNTIME_TOKEN);
			for (const privateValue of [
				SENTINEL,
				home,
				SESSION,
				"private-tool-use",
				OAUTH_TOKEN,
				RUNTIME_TOKEN,
			])
				expect(batches[0].body).not.toContain(privateValue);
			expect(runtimeRequestMetadata("claude-cli", options)?.metadata.credential).toBe(
				RUNTIME_TOKEN,
			);
			expect(runtimeRequestMetadata("claude-desktop", options)).toBeUndefined();
			holdReceipt = false;
			await flush("claude-code");
			expect(batches.at(-1)?.events.map((event) => event.eventId)).toEqual([events[5].eventId]);
			expect(runtimeStatus("claude-code", options).receiptCoverage).toBe("observed");
		});

		it("binds a controlled selection to its launched hook and caps model callback batches", async () => {
			expect(await enable("codex")).toBe(true);
			const selection = selectRuntimeProfile("codex", "module-overview-v1", {
				...options,
				controlled: true,
			});
			if (!selection) throw new Error("expected an active selection");
			const scope = { selectionId: selection.selectionId };
			expect(JSON.stringify(configuredRuntimeHooks("codex", options))).not.toContain(
				selection.selectionId,
			);
			expect(JSON.stringify(configuredRuntimeHooks("codex", { ...options, ...scope }))).toContain(
				selection.selectionId,
			);
			hook("codex", "UserPromptSubmit", { session_id: "another-chat", turn_id: "another-turn" });
			expect(runtimeProfileReceipt("codex", selection.selectionId, options)).toBeNull();
			hook("codex", "UserPromptSubmit", { turn_id: TURN, prompt: SENTINEL }, scope);
			const receipt = runtimeProfileReceipt("codex", selection.selectionId, options);
			expect(receipt).toMatchObject({
				episodeRef: expect.stringMatching(/^[a-f0-9]{64}$/),
				controlRef: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
			expect(hook("codex", "UserPromptSubmit", { turn_id: TURN }, scope)).toBe(false);
			for (let i = 0; i < 25; i++)
				hook("codex", "PostModelRequest", {
					turn_id: TURN,
					status: "completed",
					error: SENTINEL,
					token_usage: {
						input_tokens: 21,
						cached_input_tokens: 11,
						output_tokens: 2,
						reasoning_output_tokens: 1,
						total_tokens: 23,
					},
				});
			await flush("codex");
			expect(batches).toHaveLength(2);
			for (const batch of batches) {
				expect(batch.events.length).toBeLessThanOrEqual(20);
				expect(Buffer.byteLength(batch.body)).toBeLessThanOrEqual(12_000);
				expect(batch.body).not.toContain(selection.selectionId);
				expect(batch.body).not.toContain(SENTINEL);
			}
			const events = batches.flatMap((batch) => batch.events);
			expect(events.filter((event) => event.kind === "episode_start" && event.profileId)).toEqual([
				expect.objectContaining({
					episodeRef: receipt?.episodeRef,
					controlRef: receipt?.controlRef,
					profileId: "module-overview-v1",
				}),
			]);
			const attempts = events.filter((event) => event.kind === "model_request");
			expect(attempts).toHaveLength(25);
			expect(attempts[0]).toMatchObject({
				tokens: {
					input: 21,
					cachedInput: 11,
					cacheWriteInput: null,
					output: 2,
					reasoningOutput: 1,
					total: 23,
				},
				ancestry: "unknown",
			});
			expect(attempts[0]).not.toHaveProperty("nativeCallRef");
			expect(new Set(attempts.map((event) => event.eventId)).size).toBe(25);
		});
	},
);
