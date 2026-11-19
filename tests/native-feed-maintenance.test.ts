/** Maintenance uses real private state while controlled transport and hashes prove its boundaries. */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	deriveFeedCohortKey,
	feedCheckoutIdentity,
	readFeedSignInGeneration,
} from "../runtime/feed-identity.mjs";
import { feedRoot, writeFeedJSON } from "../runtime/feed-io.mjs";
import { createFeedStore } from "../runtime/feed-store.mjs";
import { readCredentials, saveAuthorizedCredentials } from "../src/credentials.js";
import type { VerifiedCheckout } from "../src/local/dispatch.js";
import { type FeedMaintenanceJob, runFeedMaintenance } from "../src/native-feed-maintenance.js";

const server = "https://mcp.pharaoh.so";
const registration = "00000000-0000-4000-8000-000000000001";
const rootId = "native-root";
let home: string;
let credentialsPath: string;
let job: FeedMaintenanceJob;
let checkout: VerifiedCheckout;
let time: number;
let signIn: string;
let cohort: string;
let store: ReturnType<typeof createFeedStore>;
const response = () =>
	Response.json({
		version: 1,
		githubUserId: 123,
		tenantId: "owner",
		repoSlug: "owner/repo",
		accessEpoch: 1,
	});
const options = () => ({
	now: () => time,
	resolveCheckout: () => checkout,
	fingerprint: () => new Map<string, string | null>(),
	provenance: () => ({ head: "d".repeat(40), branch: "main" }),
});
const scope = (agentId: string) => ({ cohort, rootId, agentId });

function authorize() {
	const expectedRevision = store.readScopeRevision({ cohort });
	if (!expectedRevision) throw new Error("Fixture scope was not created.");
	expect(
		store.putAccessProof({
			cohort,
			expectedRevision,
			proof: {
				version: 1,
				actor: 123,
				owner: "owner",
				repo: "owner/repo",
				epoch: 1,
				signIn,
				issuer: server,
				checkout: job.checkout,
				checkoutIdentity: feedCheckoutIdentity(job.checkout)!,
				requestedAt: time,
				expiresAt: time + 60_000,
			},
		}),
	).toBe(true);
	store.registerFeedRoot({ cohort, rootId, checkout: job.checkout });
	for (const agentId of ["worker-a", "worker-b"])
		store.registerRecipient({
			...scope(agentId),
			checkout: job.checkout,
			interests: ["src/shared.ts"],
		});
}

async function replaceSignIn() {
	const credentials = readCredentials(credentialsPath);
	if (!credentials) throw new Error("Fixture credentials are missing.");
	await saveAuthorizedCredentials(
		{ ...credentials, access_token: "replacement-access" },
		credentialsPath,
	);
}

beforeEach(async () => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "pharaoh-feed-maintenance-")));
	chmodSync(home, 0o700);
	credentialsPath = join(home, ".pharaoh", "credentials.json");
	await saveAuthorizedCredentials(
		{
			version: 2,
			access_token: "private-access",
			refresh_token: "private-refresh",
			expires_at: "2099-01-01T00:00:00.000Z",
			refresh_expires_at: "2099-01-01T00:00:00.000Z",
			expires_in: 3600,
			sse_url: `${server}/sse`,
			github_login: "person",
			tenant_name: "owner",
			repos: ["owner/repo"],
		},
		credentialsPath,
	);
	const generation = readFeedSignInGeneration({ home, credentialsPath });
	if (!generation) throw new Error("Fixture sign-in was not committed.");
	signIn = generation;
	writeFeedJSON(feedRoot({ home }), "registration-codex.json", {
		version: 1,
		client: "codex",
		registration,
	});
	const root = join(home, "repo");
	mkdirSync(root, { mode: 0o700 });
	mkdirSync(join(root, ".git"), { mode: 0o700 });
	const base = {
		client: "codex",
		registration,
		server,
		serverArgv: [],
		checkout: root,
		rootId,
		home,
		credentialsPath,
		signIn,
	} as const;
	checkout = { root, repoSlug: "owner/repo", worktreeId: "device:inode", device: "1", inode: "1" };
	cohort = deriveFeedCohortKey({ ...base, serverArgv: [] })!;
	job = { ...base, serverArgv: [], cohort };
	time = Date.now();
	store = createFeedStore({ home, credentialsPath, now: () => time });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

it("publishes only strict remote scope and bounds expiry from the request start", async () => {
	const started = time;
	const transport = vi.fn<typeof fetch>(async (_url, init) => {
		expect(JSON.parse(String(init?.body))).toEqual({ version: 1, repoSlug: "owner/repo" });
		expect(init).toMatchObject({
			redirect: "error",
			cache: "no-store",
			headers: { Authorization: "Bearer private-access" },
		});
		time += 500;
		return response();
	});
	expect(await runFeedMaintenance(job, { ...options(), fetch: transport })).toBe(true);
	expect(String(transport.mock.calls[0][0])).toBe(`${server}/api/local/v1/feed-access`);
	expect(store.readAccessProof({ cohort })).toMatchObject({
		version: 1,
		actor: 123,
		owner: "owner",
		repo: "owner/repo",
		epoch: 1,
		issuer: server,
		signIn,
		checkout: job.checkout,
		checkoutIdentity: feedCheckoutIdentity(job.checkout),
		requestedAt: started,
		expiresAt: started + 60_000,
	});
	const saved = readFileSync(join(feedRoot({ home }), "proofs", `${cohort}.json`), "utf8");
	expect(saved).not.toContain("private-access");
	expect(saved).not.toContain("private-refresh");
});

it("admits one in-flight request and keeps refresh attempts thirty seconds apart", async () => {
	let finish: (value: Response) => void = () => {};
	const transport = vi.fn<typeof fetch>(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			}),
	);
	const first = runFeedMaintenance(job, { ...options(), fetch: transport });
	expect(await runFeedMaintenance(job, { ...options(), fetch: transport })).toBe(false);
	expect(transport).toHaveBeenCalledOnce();
	finish(response());
	await first;
	time += 5_001;
	await runFeedMaintenance(job, { ...options(), fetch: transport });
	expect(transport).toHaveBeenCalledOnce();
	time += 25_000;
	const next = runFeedMaintenance(job, { ...options(), fetch: transport });
	expect(transport).toHaveBeenCalledTimes(2);
	finish(response());
	await next;
});

it("rejects malformed scope and never restores a replaced sign-in from a late response", async () => {
	const malformed = vi.fn<typeof fetch>(async () =>
		Response.json({
			version: 1,
			githubUserId: 123,
			tenantId: "owner",
			repoSlug: "other/repo",
			accessEpoch: 1,
		}),
	);
	await runFeedMaintenance(job, { ...options(), fetch: malformed });
	expect(store.readAccessProof({ cohort })).toBeNull();
	time += 30_001;
	await runFeedMaintenance(job, {
		...options(),
		fetch: async () => {
			await replaceSignIn();
			return response();
		},
	});
	expect(store.readAccessProof({ cohort })).toBeNull();
});

it("rejects a queued job after sign-in replacement or a mismatched cohort", async () => {
	const transport = vi.fn<typeof fetch>(async () => response());
	expect(
		await runFeedMaintenance(
			{ ...job, cohort: "f".repeat(64) },
			{ ...options(), fetch: transport },
		),
	).toBe(false);
	await replaceSignIn();
	expect(await runFeedMaintenance(job, { ...options(), fetch: transport })).toBe(false);
	expect(transport).not.toHaveBeenCalled();
});

it("does not reuse another repository's proof or accept a config retarget during access refresh", async () => {
	authorize();
	const transport = vi.fn<typeof fetch>(async () => response());
	await runFeedMaintenance(job, {
		...options(),
		resolveCheckout: () => ({ ...checkout, repoSlug: "other/repo" }),
		fetch: transport,
	});
	expect(store.readAccessProof({ cohort })).toBeNull();
	expect(transport).not.toHaveBeenCalled();
	time += 30_001;
	await runFeedMaintenance(job, {
		...options(),
		fetch: async () => {
			writeFileSync(
				join(job.checkout, ".git", "config"),
				'[remote "origin"]\nurl = https://github.com/other/repo.git\n',
			);
			return response();
		},
	});
	expect(store.readAccessProof({ cohort })).toBeNull();
});

it.each([402, 403])("withdraws queued context on definitive HTTP %i denial", async (status) => {
	authorize();
	store.publishFinding({
		...scope("worker-a"),
		kind: "reported",
		references: ["src/shared.ts"],
		summary: "Known finding.",
	});
	time += 31_000;
	await runFeedMaintenance(job, {
		...options(),
		fetch: async () => new Response(null, { status }),
	});
	expect(store.readAccessProof({ cohort })).toBeNull();
	expect(store.drainRecipient(scope("worker-b"))).toBeNull();
});

it("establishes a baseline, relays repeat edits, and labels sampled authors as unknown", async () => {
	authorize();
	let hash = "a".repeat(64);
	const fingerprint = () => new Map([["src/shared.ts", hash]]);
	store.recordObservation({ ...scope("worker-b"), kind: "read", paths: ["src/shared.ts"] });
	await runFeedMaintenance(job, { ...options(), fingerprint });
	expect(store.drainRecipient(scope("worker-b"))?.events).toEqual([]);
	time += 5_001;
	hash = "b".repeat(64);
	store.recordObservation({ ...scope("worker-a"), kind: "edit", paths: ["src/shared.ts"] });
	await runFeedMaintenance(job, { ...options(), fingerprint });
	const edited = store.drainRecipient(scope("worker-b"))!;
	expect(edited.events).toHaveLength(1);
	expect(edited.events[0]).toMatchObject({
		kind: "invalidation",
		agentId: "worker-a",
		references: ["src/shared.ts"],
		provenance: { fingerprint: "b".repeat(64) },
	});
	store.markEmitted({ ...scope("worker-b"), claimId: edited.claimId! });
	time += 5_001;
	hash = "c".repeat(64);
	await runFeedMaintenance(job, { ...options(), fingerprint });
	const sampled = store.drainRecipient(scope("worker-b"))!;
	expect(sampled.events).toHaveLength(1);
	expect(sampled.events[0]).toMatchObject({
		agentId: "unknown",
		kind: "invalidation",
		provenance: { fingerprint: "c".repeat(64) },
	});
	store.markEmitted({ ...scope("worker-b"), claimId: sampled.claimId! });
	time += 5_001;
	await runFeedMaintenance(job, { ...options(), fingerprint });
	expect(store.drainRecipient(scope("worker-b"))?.events).toEqual([]);
});

it("retries a persisted invalidation after publication fails without losing its transition", async () => {
	authorize();
	let hash = "a".repeat(64);
	const fingerprint = () => new Map([["src/shared.ts", hash]]);
	store.recordObservation({ ...scope("worker-b"), kind: "read", paths: ["src/shared.ts"] });
	await runFeedMaintenance(job, { ...options(), store, fingerprint });
	const publish = vi.spyOn(store, "publishFinding").mockReturnValueOnce(null);
	time += 5_001;
	hash = "b".repeat(64);
	await runFeedMaintenance(job, { ...options(), store, fingerprint });
	const pending = store.readProducerState({ cohort })?.pendingTransitions as Array<{ id: string }>;
	expect(pending).toHaveLength(1);
	expect(store.drainRecipient(scope("worker-b"))?.events).toEqual([]);
	time += 5_001;
	const update = store.updateProducerState.bind(store);
	vi.spyOn(store, "updateProducerState").mockImplementationOnce(update).mockReturnValueOnce(false);
	await runFeedMaintenance(job, { ...options(), store, fingerprint });
	expect(publish).toHaveBeenCalledTimes(2);
	expect(store.readProducerState({ cohort })?.pendingTransitions).toHaveLength(1);
	time += 5_001;
	await runFeedMaintenance(job, { ...options(), store, fingerprint });
	expect(publish).toHaveBeenCalledTimes(3);
	expect(store.readProducerState({ cohort })?.pendingTransitions).toEqual([]);
	expect(store.drainRecipient(scope("worker-b"))?.events).toHaveLength(1);
});

it("keeps recurring A to B transitions distinct from retry deduplication", async () => {
	authorize();
	let hash = "a".repeat(64);
	const fingerprint = () => new Map([["src/shared.ts", hash]]);
	store.recordObservation({ ...scope("worker-b"), kind: "read", paths: ["src/shared.ts"] });
	await runFeedMaintenance(job, { ...options(), fingerprint });
	const ids: string[] = [];
	for (const next of ["b", "a", "b"]) {
		time += 5_001;
		hash = next.repeat(64);
		await runFeedMaintenance(job, { ...options(), fingerprint });
		const claimed = store.drainRecipient(scope("worker-b"))!;
		expect(claimed.events).toHaveLength(1);
		ids.push(claimed.events[0].id);
		store.markEmitted({ ...scope("worker-b"), claimId: claimed.claimId! });
	}
	expect(new Set(ids).size).toBe(3);
});

it("withdraws old context on a branch switch or a commit during a fingerprint batch", async () => {
	authorize();
	store.recordObservation({ ...scope("worker-b"), kind: "read", paths: ["src/shared.ts"] });
	const fingerprint = () => new Map([["src/shared.ts", "a".repeat(64)]]);
	await runFeedMaintenance(job, { ...options(), fingerprint });
	time += 5_001;
	await runFeedMaintenance(job, {
		...options(),
		fingerprint,
		provenance: () => ({ head: "e".repeat(40), branch: "feature" }),
	});
	expect(store.readAccessProof({ cohort })).toBeNull();
	authorize();
	store.recordObservation({ ...scope("worker-a"), kind: "edit", paths: ["src/shared.ts"] });
	time += 5_001;
	let reads = 0;
	await runFeedMaintenance(job, {
		...options(),
		fingerprint,
		provenance: () => ({ head: (++reads === 1 ? "a" : "b").repeat(40), branch: "main" }),
	});
	expect(store.readAccessProof({ cohort })).toBeNull();
	expect(store.drainRecipient(scope("worker-b"))).toBeNull();
});
