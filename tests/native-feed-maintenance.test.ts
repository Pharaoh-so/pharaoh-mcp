/** Maintenance uses real private state while controlled transport and hashes prove its boundaries. */
import { createHash } from "node:crypto";
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
import { setNativeFeedEnabled, setNativeFeedPreviewEnabled } from "../runtime/feed-hooks.mjs";
import {
	deriveFeedCohortKey,
	feedCheckoutIdentity,
	readFeedSignInGeneration,
} from "../runtime/feed-identity.mjs";
import { feedRoot, writeFeedJSON } from "../runtime/feed-io.mjs";
import { createFeedStore, type HostedFeedPublication } from "../runtime/feed-store.mjs";
import { readCredentials, saveAuthorizedCredentials } from "../src/credentials.js";
import type { VerifiedCheckout } from "../src/local/dispatch.js";
import type { LocalExportResult, LocalExportSymbol } from "../src/local/worker-host.js";
import {
	type FeedMaintenanceJob,
	type FeedMaintenanceOptions,
	runFeedMaintenance,
} from "../src/native-feed-maintenance.js";

const server = "https://mcp.pharaoh.so";
const registration = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000002";
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
const options = () => {
	store.renewFeedConnection(connectionId);
	return {
		now: () => time,
		resolveCheckout: () => checkout,
		fingerprint: () => new Map<string, string | null>(),
		provenance: () => ({ head: "d".repeat(40), branch: "main" }),
	};
};
const scope = (agentId: string) => ({ cohort, rootId, agentId });

function exportSamples(preview = true) {
	setNativeFeedPreviewEnabled("codex", preview, { home });
	const path = "src/shared.ts";
	const files = new Map<
		string,
		{ source: string; status: LocalExportResult["status"]; exports: LocalExportSymbol[] }
	>();
	const save = (
		source: string,
		exports: LocalExportSymbol[],
		status: LocalExportResult["status"] = "complete",
	) => {
		files.set(path, { source, status, exports });
	};
	const fingerprint: NonNullable<FeedMaintenanceOptions["fingerprint"]> = (
		_checkout,
		paths,
		_deadline,
		visit,
	) => {
		const hashes = new Map<string, string | null>();
		for (const candidate of paths) {
			const file = files.get(candidate);
			if (!file) {
				hashes.set(candidate, null);
				continue;
			}
			const bytes = Buffer.from(file.source);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			hashes.set(candidate, sha256);
			visit?.(candidate, bytes, sha256);
		}
		return hashes;
	};
	const exportInventory = vi.fn<NonNullable<FeedMaintenanceOptions["exportInventory"]>>(
		async (inputs) =>
			inputs.flatMap(({ path, sha256, bytes }) => {
				const record = files.get(path);
				if (!record) return [];
				expect(Buffer.from(bytes).toString()).toBe(record.source);
				expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
				return [{ path, sha256, status: record.status, exports: record.exports }];
			}),
	);
	const run = (changes: FeedMaintenanceOptions = {}) =>
		runFeedMaintenance(job, {
			...options(),
			fingerprint,
			exportInventory,
			fetch: async () => response(),
			...changes,
		});
	return { files, path, save, run, fingerprint, exportInventory };
}

function observe(path: string, agentId: string, kind: "read" | "edit") {
	return store.recordObservation({ ...scope(agentId), kind, paths: [path] });
}

function facts() {
	const result = store.drainRecipient({ ...scope("worker-b"), preview: true });
	if (result?.claimId) store.markEmitted({ ...scope("worker-b"), claimId: result.claimId });
	return result;
}

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
	expect(
		store.recordFeedConnection({
			id: connectionId,
			cohort,
			client: "codex",
			signIn,
			checkout: root,
			state: "initialized",
			name: "codex-mcp-client",
			clientVersion: "0.166.0",
		}),
	).toBe(true);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

it.each([
	{ outcome: "revoked", revoked: true },
	{ outcome: "replacement owner", revoked: true },
	{ outcome: "new epoch", revoked: true },
	{ outcome: "publication conflict", revoked: false },
	{ outcome: "unrelated repo", revoked: false },
])("applies $outcome only to the current publication scope", async ({ outcome, revoked }) => {
	authorize();
	setNativeFeedPreviewEnabled("codex", true, { home });
	const authorizationIdentity = store.currentAuthorizationIdentity({ cohort });
	if (!authorizationIdentity) throw new Error("Fixture feed access was unavailable");
	const revision = store.readScopeRevision({ cohort });
	expect(
		store.recordHostedModuleWatch({ ...scope("worker-b"), module: "auth", authorizationIdentity }),
	).toBe(true);
	expect(
		store.publishFinding({
			...scope("worker-a"),
			authorizationIdentity,
			kind: "invalidation",
			summary: "Saved file changed.",
			references: ["src/shared.ts"],
		}),
	).toBeTruthy();
	const transport = vi.fn<typeof fetch>(async (url) => {
		if (String(url).endsWith("/feed-access")) return response();
		setNativeFeedPreviewEnabled("codex", false, { home });
		if (outcome === "revoked") return new Response(null, { status: 403 });
		if (outcome === "publication conflict") return new Response(null, { status: 409 });
		return Response.json({
			version: 1,
			githubUserId: 123,
			tenantId: outcome === "replacement owner" ? "replacement" : "owner",
			repoSlug: outcome === "unrelated repo" ? "owner/other" : "owner/repo",
			accessEpoch: outcome === "new epoch" ? 2 : 1,
			publication: null,
		});
	});
	await runFeedMaintenance(job, { ...options(), fetch: transport });
	expect(transport.mock.calls.some(([url]) => String(url).endsWith("/feed-publication"))).toBe(
		true,
	);
	if (revoked) {
		expect(store.readAccessProof({ cohort })).toBeNull();
		expect(store.readScopeRevision({ cohort })).not.toBe(revision);
		expect(store.drainRecipient(scope("worker-b"))).toBeNull();
	} else {
		expect(store.currentAuthorizationIdentity({ cohort })).toBe(authorizationIdentity);
		expect(store.drainRecipient(scope("worker-b"))?.events).toMatchObject([
			{ kind: "invalidation" },
		]);
	}
});

it("samples watched published dependencies behind a persistent minute budget and retires stale notices", async () => {
	authorize();
	const authorizationIdentity = store.currentAuthorizationIdentity({ cohort });
	if (!authorizationIdentity) throw new Error("Fixture feed access was unavailable");
	const access = { cohort, authorizationIdentity };
	expect(
		store.recordHostedModuleWatch({
			...scope("worker-a"),
			module: "auth",
			authorizationIdentity,
		}),
	).toBe(true);
	let map: HostedFeedPublication | null = {
		commit: "a".repeat(40),
		signature: "a".repeat(16),
		generation: 7,
		time: "2026-11-19T00:00:00Z",
		modules: [{ module: "auth", edges: [] }],
	};
	const publication = vi.fn(() =>
		Response.json({
			version: 1,
			githubUserId: 123,
			tenantId: "owner",
			repoSlug: "owner/repo",
			accessEpoch: 1,
			publication: map,
		}),
	);
	const transport = vi.fn<typeof fetch>(async (url, init) => {
		if (String(url).endsWith("/feed-access")) return response();
		expect(String(url)).toBe(`${server}/api/local/v1/feed-publication`);
		expect(JSON.parse(String(init?.body))).toEqual({
			version: 1,
			repoSlug: "owner/repo",
			modules: ["auth"],
		});
		return publication();
	});
	const run = () => runFeedMaintenance(job, { ...options(), fetch: transport });
	const preview = { ...scope("worker-a"), preview: true };
	const next = () => {
		time += 60_001;
	};
	await run();
	expect(publication).not.toHaveBeenCalled();
	setNativeFeedPreviewEnabled("codex", true, { home });
	time += 5_001;
	await run();
	expect(publication).toHaveBeenCalledTimes(1);
	expect(store.drainRecipient(preview)?.events).toEqual([]);
	time += 5_001;
	await run();
	expect(publication).toHaveBeenCalledTimes(1);

	next();
	map = {
		...map,
		commit: "b".repeat(40),
		time: "2026-11-19T00:01:00Z",
		modules: [{ module: "auth", edges: [["auth", "db"]] }],
	};
	await run();
	expect(publication).toHaveBeenCalledTimes(2);
	expect(store.drainRecipient({ ...scope("worker-b"), preview: true })?.events).toEqual([]);
	const added = store.drainRecipient(preview)?.events ?? [];
	expect(added).toHaveLength(1);
	expect(added[0]).toMatchObject({ kind: "fact", previewOnly: true, references: [] });
	const ids = added.map(({ id }) => id);
	expect(store.currentHostedModuleNoticeIds({ ...access, ids })).toEqual(ids);

	next();
	map = {
		...map,
		commit: "c".repeat(40),
		time: "2026-11-19T00:02:00Z",
		modules: [{ module: "auth", edges: [] }],
	};
	await run();
	const removed = store.drainRecipient(preview)?.events ?? [];
	expect(removed).toHaveLength(1);
	expect(removed[0]).toMatchObject({ provenance: { head: "c".repeat(40) } });
	expect(store.currentHostedModuleNoticeIds({ ...access, ids })).toEqual([]);
	const path = "src/shared.ts";
	expect(store.recordObservation({ ...scope("worker-b"), kind: "read", paths: [path] })).toBe(true);
	const [observation] = store.readObservations({ cohort });
	expect(
		store.publishOverlap({
			...scope("worker-b"),
			observationId: observation.id,
			path,
			provenance: { head: "c".repeat(40), fingerprint: "d".repeat(64) },
			authorizationIdentity,
		}),
	).toBe("published");
	const state = JSON.parse(
		readFileSync(join(feedRoot({ home }), "state", `${cohort}.json`), "utf8"),
	);
	expect(state.events).toEqual([]);
	expect(state.previewEvents).toMatchObject([
		{ id: removed[0].id, previewOnly: true, references: [] },
		{ previewOnly: true, references: [path] },
	]);
	expect(store.retireHostedModuleNotices(access)).toBe(true);
	expect(store.currentHostedModuleNoticeIds({ ...access, ids: [removed[0].id] })).toEqual([]);
	next();
	map = null;
	await run();
	expect(store.drainRecipient(preview)?.events).toMatchObject([
		{ references: [path], previewOnly: true },
	]);
});

it.each([
	{ waiter: "active", kept: true },
	{ waiter: "idle", kept: false },
])("shares one publication minute between worktrees with an $waiter contender", async ({
	kept,
}) => {
	authorize();
	setNativeFeedPreviewEnabled("codex", true, { home });
	const otherCheckout = join(home, "second-worktree");
	mkdirSync(join(otherCheckout, ".git"), { recursive: true, mode: 0o700 });
	const otherCohort = deriveFeedCohortKey({ ...job, checkout: otherCheckout });
	const physical = feedCheckoutIdentity(otherCheckout);
	const initialProof = store.readAccessProof({ cohort });
	if (!otherCohort || !physical || !initialProof) throw new Error("Missing second worktree scope");
	const second = { ...job, cohort: otherCohort, checkout: otherCheckout, rootId: "other-root" };
	const secondConnection = {
		id: "00000000-0000-4000-8000-000000000003",
		cohort: otherCohort,
		client: "codex",
		signIn,
		checkout: otherCheckout,
		state: "initialized",
		name: "codex-mcp-client",
		clientVersion: "0.166.0",
	} as const;
	expect(store.recordFeedConnection(secondConnection)).toBe(true);
	expect(
		store.putAccessProof({
			cohort: otherCohort,
			proof: { ...initialProof, checkout: otherCheckout, checkoutIdentity: physical },
		}),
	).toBe(true);
	expect(store.registerFeedRoot(second)).toBe(true);
	expect(store.registerRecipient({ ...second, agentId: "worker-a" })).toBe(true);
	for (const [target, module] of [
		[job, "auth"],
		[second, "db"],
	] as const) {
		const authorizationIdentity = store.currentAuthorizationIdentity({ cohort: target.cohort });
		if (!authorizationIdentity) throw new Error("Fixture feed access was unavailable");
		expect(
			store.recordHostedModuleWatch({
				...target,
				agentId: "worker-a",
				module,
				authorizationIdentity,
			}),
		).toBe(true);
	}

	const sampled: string[][] = [];
	const transport = vi.fn<typeof fetch>(async (url, init) => {
		if (String(url).endsWith("/feed-access")) return response();
		const request = JSON.parse(String(init?.body)) as { modules: string[] };
		sampled.push(request.modules);
		return Response.json({
			version: 1,
			githubUserId: 123,
			tenantId: "owner",
			repoSlug: "owner/repo",
			accessEpoch: 1,
			publication: {
				commit: "a".repeat(40),
				signature: "a".repeat(16),
				time: "2026-11-19T00:00:00Z",
				generation: 7,
				modules: request.modules.map((module) => ({ module, edges: [] })),
			},
		});
	});
	const started = time;
	const run = async (elapsed: number, target = job) => {
		time = started + elapsed;
		// A sibling registry rebuild can remove this expired connection between sparse polls.
		if (target === second) expect(store.recordFeedConnection(secondConnection)).toBe(true);
		await runFeedMaintenance(target, {
			...options(),
			resolveCheckout: () => ({ ...checkout, root: target.checkout }),
			fetch: transport,
		});
	};
	await run(0);
	await run(5_001, second);
	await run(6_001);
	expect(sampled).toEqual([["auth"]]);

	// The second checkout polls only once per minute, just after the first checkout.
	await run(60_001);
	expect(sampled).toEqual([["auth"]]);
	if (kept) {
		await run(65_001, second);
	} else {
		await run(80_001);
		expect(sampled).toEqual([["auth"]]);
		await run(96_001);
	}
	expect(sampled).toEqual([["auth"], kept ? ["db"] : ["auth"]]);

	// This scope's old budget row can already be gone before a clock rollback.
	writeFeedJSON(feedRoot({ home }), "publication-attempts.json", {
		version: 1,
		clock: started + 120_001,
		entries: [{ identity: "e".repeat(64), at: started + 120_001, waiters: [] }],
	});
	await run(kept ? 71_002 : 102_002);
	expect(sampled).toHaveLength(2);
});

it("finishes local exports before requesting a hosted snapshot and ignores results after lease expiry", async () => {
	authorize();
	const authorizationIdentity = store.currentAuthorizationIdentity({ cohort });
	if (!authorizationIdentity) throw new Error("Fixture feed access was unavailable");
	const access = { cohort, authorizationIdentity };
	const module = "auth";
	expect(
		store.recordHostedModuleWatch({ ...scope("worker-a"), module, authorizationIdentity }),
	).toBe(true);
	const baseline: HostedFeedPublication = {
		commit: "a".repeat(40),
		signature: "a".repeat(16),
		generation: 7,
		time: "2026-11-19T00:00:00Z",
		modules: [{ module, edges: [] }],
	};
	const publication: HostedFeedPublication = {
		...baseline,
		commit: "b".repeat(40),
		time: "2026-11-19T00:01:00Z",
		modules: [{ module, edges: [["auth", "db"]] }],
	};
	expect(store.applyHostedModulePublication({ ...access, publication: baseline })).toBe(true);

	const sample = exportSamples();
	sample.save("export interface Name {}", [{ name: "Name", kind: "interface" }]);
	expect(observe(sample.path, "worker-b", "read")).toBe(true);
	const sampleTime = time;
	const requests: unknown[] = [];
	const transport = vi.fn<typeof fetch>(async (url) => {
		requests.push({
			url: String(url),
			inventoryCalls: sample.exportInventory.mock.calls.length,
			watched: store.readProducerState({ cohort })?.watched,
		});
		time += 5_001;
		return Response.json({
			version: 1,
			githubUserId: 123,
			tenantId: "owner",
			repoSlug: "owner/repo",
			accessEpoch: 1,
			publication,
		});
	});
	await expect(sample.run({ fetch: transport })).resolves.toBe(true);
	expect(requests).toMatchObject([
		{
			url: `${server}/api/local/v1/feed-publication`,
			inventoryCalls: 1,
			watched: [{ path: sample.path, inventory: { capturedAt: sampleTime } }],
		},
	]);
	const hostedEvents = () =>
		store
			.drainRecipient({ ...scope("worker-a"), preview: true })
			?.events.filter((event) => event.hosted);
	expect(hostedEvents()).toEqual([]);
	expect(store.applyHostedModulePublication({ ...access, publication })).toBe(true);
	expect(hostedEvents()).toHaveLength(1);
});

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

it("relays one verified saved-file overlap to interested siblings in the same native root", async () => {
	authorize();
	const path = "src/shared.ts";
	const fingerprint = () => new Map([[path, "a".repeat(64)]]);
	const isolated = scope("isolated");
	const other = { ...scope("worker-c"), rootId: "other-root" };
	store.registerFeedRoot({ cohort, rootId: other.rootId, checkout: job.checkout });
	store.registerRecipient({ ...other, checkout: job.checkout, interests: [path] });
	store.registerRecipient({ ...isolated, checkout: job.checkout, interests: ["assets/title.ts"] });
	store.recordObservation({ ...scope("worker-a"), kind: "read", paths: [path] });
	await runFeedMaintenance(job, { ...options(), fingerprint });
	const initial = store.drainRecipient(scope("worker-b"));
	if (!initial?.claimId) throw new Error("Expected an initial seed claim");
	expect(initial.events).toEqual([]);
	store.markEmitted({ ...scope("worker-b"), claimId: initial.claimId });

	time += 5_001;
	setNativeFeedPreviewEnabled("codex", true, { home });
	store.recordObservation({ ...scope("worker-a"), kind: "read", paths: [path] });
	store.recordObservation({ ...scope("worker-b"), kind: "read", paths: [path] });
	await runFeedMaintenance(job, { ...options(), fingerprint });
	expect(store.drainRecipient(scope("worker-b"))?.events).toEqual([]);
	const overlap = store.drainRecipient({ ...scope("worker-b"), preview: true });
	if (!overlap?.claimId) throw new Error("Expected a scoped overlap claim");
	expect(overlap.events).toHaveLength(1);
	expect(overlap.events[0]).toMatchObject({
		kind: "fact",
		agentId: "worker-a",
		references: [path],
		provenance: { head: "d".repeat(40), fingerprint: "a".repeat(64) },
	});
	expect(store.drainRecipient({ ...isolated, preview: true })?.events).toEqual([]);
	expect(store.drainRecipient({ ...other, preview: true })?.events).toEqual([]);
	expect(store.drainRecipient({ ...scope("worker-a"), preview: true })?.events).toEqual([
		expect.objectContaining({ kind: "fact", agentId: "worker-b", references: [path] }),
	]);
	store.markEmitted({ ...scope("worker-b"), claimId: overlap.claimId });

	time += 5_001;
	store.recordObservation({ ...scope("worker-a"), kind: "read", paths: [path] });
	await runFeedMaintenance(job, { ...options(), fingerprint });
	expect(store.drainRecipient({ ...scope("worker-b"), preview: true })?.events).toEqual([]);
});

it("keeps bounded reads pending across a four-path rotation and a busy publisher", async () => {
	authorize();
	setNativeFeedPreviewEnabled("codex", true, { home });
	const paths = Array.from({ length: 7 }, (_, index) => `src/file${index}.ts`);
	for (const agentId of ["worker-a", "worker-b"])
		store.registerRecipient({ ...scope(agentId), checkout: job.checkout, interests: paths });
	for (const path of paths)
		store.recordObservation({ ...scope("worker-a"), kind: "read", paths: [path] });
	const fingerprint: NonNullable<FeedMaintenanceOptions["fingerprint"]> = (_checkout, sampled) =>
		new Map(sampled.map((path) => [path, "a".repeat(64)]));
	const publishOverlap = vi.fn(store.publishOverlap).mockReturnValueOnce("retry");
	const run = () =>
		runFeedMaintenance(job, { ...options(), fingerprint, store: { ...store, publishOverlap } });
	await run();
	expect(publishOverlap).toHaveBeenCalledTimes(4);
	expect(store.readObservations({ cohort }).map((entry) => entry.paths[0])).toEqual([
		paths[0],
		...paths.slice(4),
	]);
	time += 5_001;
	await run();
	expect(publishOverlap).toHaveBeenCalledTimes(8);
	expect(store.readObservations({ cohort })).toEqual([]);
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

it("silently seeds saved exports, retains metadata only across processes, and reports verified changes", async () => {
	authorize();
	const sample = exportSamples();
	sample.save('export function oldName(){ return "literal-marker" }', [
		{ name: "oldName", kind: "function" },
	]);
	observe(sample.path, "worker-b", "read");
	await sample.run();
	expect(facts()?.events).toEqual([]);
	const watched = store.readProducerState({ cohort })?.watched;
	expect(watched).toMatchObject([
		{
			inventory: {
				result: { status: "complete", exports: [{ name: "oldName", kind: "function" }] },
			},
		},
	]);
	expect(JSON.stringify(watched)).not.toContain("literal-marker");
	expect(JSON.stringify(watched)).not.toContain("export function");
	store = createFeedStore({ home, credentialsPath, now: () => time });
	const baseRecipient = scope("worker-c");
	store.registerRecipient({ ...baseRecipient, checkout: job.checkout, interests: [sample.path] });
	time += 5_001;
	sample.save("export interface NewName {}", [{ name: "NewName", kind: "interface" }]);
	observe(sample.path, "worker-a", "edit");
	await sample.run();
	const fallback = store.drainRecipient(baseRecipient);
	expect(fallback?.events).toMatchObject([
		{
			kind: "invalidation",
			agentId: "worker-a",
			references: [sample.path],
			summary: "Saved file changed.",
		},
	]);
	expect(facts()?.events).toMatchObject([
		{ id: fallback?.events[0]?.id, kind: "invalidation" },
		{
			kind: "fact",
			previewOnly: true,
			dedupeKey: fallback?.events[0]?.dedupeKey,
			agentId: "worker-a",
			references: [sample.path],
			summary: "Saved exports added NewName (interface), removed oldName (function).",
		},
	]);
});

it("distinguishes incomplete from complete empty, retries failure, and falls back for body-only edits", async () => {
	authorize();
	const sample = exportSamples();
	sample.save("export * from './unknown'", [], "incomplete");
	observe(sample.path, "worker-b", "read");
	await sample.run();
	time += 5_001;
	await sample.run();
	expect(sample.exportInventory).toHaveBeenCalledTimes(1);
	time += 5_001;
	sample.save("// exports removed", []);
	sample.exportInventory.mockResolvedValueOnce(undefined);
	await sample.run();
	expect(facts()?.events[0]?.kind).toBe("invalidation");
	time += 5_001;
	await sample.run();
	expect(sample.exportInventory).toHaveBeenCalledTimes(3);
	expect(facts()?.events).toEqual([]);
	time += 5_001;
	const symbols: LocalExportSymbol[] = [{ name: "newFunction", kind: "function" }];
	sample.save("export function newFunction(){ return 1 }", symbols);
	await sample.run();
	expect(facts()?.events[1]).toMatchObject({
		kind: "fact",
		summary: "Saved exports added newFunction (function).",
	});
	time += 5_001;
	sample.save("export function newFunction(){ return 2 }", symbols);
	await sample.run();
	expect(facts()?.events[0]?.kind).toBe("invalidation");
});

it("retains pending reads and newer same-HEAD edits when a sample races", async () => {
	authorize();
	const sample = exportSamples();
	sample.save("// starting snapshot", []);
	observe(sample.path, "worker-b", "read");
	await sample.run();
	const before = store.readProducerState({ cohort })?.watched;
	time += 5_001;
	sample.save("export interface Old {}", [{ name: "Old", kind: "interface" }]);
	observe(sample.path, "worker-a", "edit");
	observe(sample.path, "worker-b", "read");
	const deadline = performance.now() + 3_000;
	const fingerprint = vi.fn(sample.fingerprint);
	await sample.run({
		deadline,
		fingerprint,
		exportInventory: async (inputs) => {
			const captured = await sample.exportInventory(inputs, new AbortController().signal);
			sample.save("export interface Latest {}", [{ name: "Latest", kind: "interface" }]);
			time++;
			observe(sample.path, "worker-a", "edit");
			return captured;
		},
	});
	expect(fingerprint.mock.calls.map(([, , until]) => until)).toEqual([deadline, deadline - 700]);
	expect(store.readProducerState({ cohort })?.watched).toEqual(before);
	expect(store.readObservations({ cohort }).map(({ kind }) => kind)).toEqual([
		"edit",
		"read",
		"edit",
	]);
	expect(facts()?.events).toEqual([]);
	time += 5_001;
	await sample.run();
	expect(facts()?.events[1]).toMatchObject({
		kind: "fact",
		summary: "Saved exports added Latest (interface).",
	});
	expect(store.readObservations({ cohort })).toEqual([]);
});

it.each([
	false,
	true,
])("acknowledges read interests after bounding watches, preview=%s", async (preview) => {
	authorize();
	const sample = exportSamples(preview);
	sample.save("export interface Current {}", [{ name: "Current", kind: "interface" }]);
	sample.files.set("src/requested5.ts", {
		source: "export interface Selected {}",
		status: "complete",
		exports: [{ name: "Selected", kind: "interface" }],
	});
	const unreadable = "src/unreadable.ts";
	for (let index = 0; index < 35; index++)
		expect(observe(`src/requested${index}.ts`, "worker-b", "read")).toBe(true);
	expect(observe(unreadable, "worker-b", "read")).toBe(true);
	expect(observe(sample.path, "worker-b", "read")).toBe(true);
	const fingerprint: NonNullable<FeedMaintenanceOptions["fingerprint"]> = (
		verified,
		paths,
		deadline,
		visit,
	) =>
		sample.fingerprint(
			verified,
			paths.filter((path) => path !== unreadable),
			deadline,
			visit,
		);
	const run = () =>
		sample.run({ fingerprint, exportInventory: preview ? sample.exportInventory : undefined });
	await run();
	expect(sample.exportInventory).toHaveBeenCalledTimes(preview ? 1 : 0);
	const watched = () =>
		(store.readProducerState({ cohort })?.watched as { path: string }[]).map(({ path }) => path);
	const pendingReads = () => store.readObservations({ cohort }).flatMap(({ paths }) => paths);
	const first = watched();
	expect(first).toHaveLength(32);
	expect(first).toContain(unreadable);
	expect(first).not.toContain("src/requested0.ts");
	expect(pendingReads()).toHaveLength(preview ? 28 : 0);
	expect(pendingReads()).not.toContain("src/requested0.ts");
	for (let turn = 1; turn < 8; turn++) {
		time += 5_001;
		await run();
		expect(watched()).toEqual(first);
	}
	expect(pendingReads()).toEqual([]);
});

it("invalidates and rebaselines across HEAD while preserving frozen pending output over retries", async () => {
	authorize();
	const sample = exportSamples();
	let head = "d".repeat(40);
	const provenance = () => ({ head, branch: "main" });
	sample.save("// baseline", []);
	observe(sample.path, "worker-b", "read");
	await sample.run({ provenance });
	head = "e".repeat(40);
	time += 5_001;
	sample.save("export interface AcrossHead {}", [{ name: "AcrossHead", kind: "interface" }]);
	await sample.run({ provenance });
	expect(facts()?.events[0]?.kind).toBe("invalidation");
	const publishFinding = store.publishFinding.bind(store);
	const publish = vi
		.spyOn(store, "publishFinding")
		.mockImplementationOnce(publishFinding)
		.mockReturnValueOnce(null);
	time += 5_001;
	sample.save("export interface First {}", [{ name: "First", kind: "interface" }]);
	await sample.run({ provenance, store });
	expect(facts()?.events).toMatchObject([{ kind: "invalidation" }]);
	const fallback = publish.mock.calls[0]?.[0];
	const first = publish.mock.calls[1]?.[0];
	expect(first).toMatchObject({ kind: "fact" });
	expect(first?.dedupeKey).toBe(fallback?.dedupeKey);
	time += 5_001;
	sample.save("export interface Second {}", [{ name: "Second", kind: "interface" }]);
	await sample.run({ provenance, store });
	expect(publish.mock.calls[2]?.[0]).toEqual(fallback);
	expect(publish.mock.calls[3]?.[0]).toEqual(first);
	expect(publish.mock.calls[4]?.[0].dedupeKey).not.toBe(first?.dedupeKey);
	expect(facts()?.events[0]?.summary).toBe(first?.summary);
});

it("bounds retained inventories independently of the fingerprint watches", async () => {
	authorize();
	const sample = exportSamples();
	for (let i = 0; i < 12; i++) {
		const path = `src/watch${i}.ts`;
		const name = `n${i}`;
		sample.files.set(path, {
			source: `export interface ${name} {}`,
			status: "complete",
			exports: [{ name, kind: "interface" }],
		});
		observe(path, "worker-b", "read");
	}
	for (let i = 0; i < 3; i++) {
		await sample.run();
		time += 5_001;
	}
	const watched = store.readProducerState({ cohort })?.watched as {
		hash?: string;
		inventory?: unknown;
	}[];
	expect(watched).toHaveLength(12);
	expect(watched.every(({ hash }) => Boolean(hash))).toBe(true);
	expect(watched.filter(({ inventory }) => inventory)).toHaveLength(8);
});

it("downgrades a fact that exceeds the wire budget and backfills an expired unchanged receipt", async () => {
	authorize();
	const sample = exportSamples();
	sample.save("// baseline", []);
	observe(sample.path, "worker-b", "read");
	await sample.run();
	time += 5_001;
	const first = "a".repeat(64);
	const second = "b".repeat(64);
	sample.save(`export interface ${first} {}\nexport interface ${second} {}`, [
		{ name: first, kind: "interface" },
		{ name: second, kind: "interface" },
	]);
	await sample.run();
	expect(facts()?.events[0]).toMatchObject({
		kind: "invalidation",
		summary: "Saved file changed. Author unknown.",
	});
	expect(sample.exportInventory).toHaveBeenCalledTimes(2);
	time += 30 * 60_000 + 1;
	await sample.run();
	expect(sample.exportInventory).toHaveBeenCalledTimes(3);
	expect(store.readProducerState({ cohort })?.watched).toMatchObject([
		{ inventory: { capturedAt: time } },
	]);
});

it("discards analysis completed after sign-in replacement or the startup-inclusive deadline", async () => {
	authorize();
	const sample = exportSamples();
	sample.save("export interface Name {}", [{ name: "Name", kind: "interface" }]);
	observe(sample.path, "worker-b", "read");
	const deadline = performance.now() - 1;
	await expect(sample.run({ deadline })).resolves.toBe(false);
	expect(sample.exportInventory).toHaveBeenCalledTimes(0);
	await sample.run({
		exportInventory: async (inputs, signal) => {
			const result = await sample.exportInventory(inputs, signal);
			await replaceSignIn();
			return result;
		},
	});
	expect(store.readProducerState({ cohort })).toBeNull();
	expect(facts()).toBeNull();
});

it.each([
	"base",
	"preview",
	"registration",
	"connection",
] as const)("rechecks %s after a queued job captures the candidate and before analyzer dispatch", async (withdrawal) => {
	authorize();
	const sample = exportSamples();
	sample.save("// baseline", []);
	observe(sample.path, "worker-b", "read");
	await sample.run();
	expect(sample.exportInventory).toHaveBeenCalledTimes(1);
	const before = store.readProducerState({ cohort });
	time += 5_001;
	sample.save("export interface New {}", [{ name: "New", kind: "interface" }]);
	observe(sample.path, "worker-a", "edit");
	const withdraw = {
		base: () => setNativeFeedEnabled("codex", false, { home }),
		preview: () => setNativeFeedPreviewEnabled("codex", false, { home }),
		registration: () =>
			writeFeedJSON(feedRoot({ home }), "registration-codex.json", {
				version: 1,
				client: "codex",
				registration: "00000000-0000-4000-8000-000000000003",
			}),
		connection: () => store.removeFeedConnection(connectionId),
	}[withdrawal];
	await sample.run({
		fingerprint: (...args) => {
			const hashes = sample.fingerprint(...args);
			withdraw();
			return hashes;
		},
	});
	expect(sample.exportInventory).toHaveBeenCalledTimes(1);
	if (withdrawal === "preview") {
		expect(facts()?.events).toMatchObject([{ kind: "invalidation" }]);
		expect(store.readObservations({ cohort })).toEqual([]);
		expect(JSON.stringify(store.readProducerState({ cohort }))).not.toContain('"inventory"');
	} else {
		expect(store.readProducerState({ cohort })).toEqual(before);
		expect(store.readObservations({ cohort })).toHaveLength(1);
		expect(store.drainRecipient(scope("worker-b"))?.events).toEqual([]);
	}
});

it("cancels a running worker when preview is withdrawn and still publishes the rechecked base change", async () => {
	authorize();
	const sample = exportSamples();
	sample.save("// baseline", []);
	observe(sample.path, "worker-b", "read");
	await sample.run();
	time += 5_001;
	sample.save("export interface New {}", [{ name: "New", kind: "interface" }]);
	observe(sample.path, "worker-a", "edit");
	let aborted = false;
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	try {
		await sample.run({
			exportInventory: async (inputs, signal) => {
				const reply = await sample.exportInventory(inputs, signal);
				setNativeFeedPreviewEnabled("codex", false, { home });
				await vi.advanceTimersByTimeAsync(100);
				aborted = signal.aborted;
				return reply;
			},
		});
	} finally {
		vi.useRealTimers();
	}
	expect(aborted).toBe(true);
	expect(facts()?.events).toMatchObject([{ kind: "invalidation" }]);
	expect(store.readObservations({ cohort })).toEqual([]);
	expect(JSON.stringify(store.readProducerState({ cohort }))).not.toContain('"inventory"');
});

it.each([
	false,
	true,
])("reserves provenance and persistence after a late worker and slow rehash, rehash expired=%s", async (rehashExpired) => {
	authorize();
	const sample = exportSamples();
	sample.save("// baseline", []);
	observe(sample.path, "worker-b", "read");
	await sample.run();
	const before = store.readProducerState({ cohort })?.watched;
	time += 5_001;
	sample.save("export interface New {}", [{ name: "New", kind: "interface" }]);
	observe(sample.path, "worker-a", "edit");
	let ticks = performance.now();
	const deadline = ticks + 2_300;
	const fingerprint = vi.fn<NonNullable<FeedMaintenanceOptions["fingerprint"]>>((...args) => {
		const until = args[2];
		if (until < deadline) ticks = until - (rehashExpired ? 0 : 1);
		return sample.fingerprint(...args);
	});
	const provenance = vi.fn<NonNullable<FeedMaintenanceOptions["provenance"]>>(
		(_checkout, until) => {
			if (until < deadline) ticks = until - 1;
			return { head: "d".repeat(40), branch: "main" };
		},
	);
	const clock = vi.spyOn(performance, "now").mockImplementation(() => ticks);
	try {
		await sample.run({
			deadline,
			fingerprint,
			provenance,
			exportInventory: async (inputs, signal) => {
				ticks += 751;
				return sample.exportInventory(inputs, signal);
			},
		});
	} finally {
		clock.mockRestore();
	}
	expect(sample.exportInventory).toHaveBeenCalledTimes(2);
	expect(fingerprint.mock.calls.map(([, , until]) => until)).toEqual([deadline, deadline - 700]);
	expect(provenance.mock.calls.map(([, until]) => until)).toEqual([deadline, deadline - 400]);
	if (rehashExpired) {
		expect(store.readProducerState({ cohort })?.watched).toEqual(before);
		expect(store.readObservations({ cohort })).toHaveLength(1);
		expect(facts()?.events).toEqual([]);
	} else {
		expect(store.readObservations({ cohort })).toEqual([]);
		expect(facts()?.events).toMatchObject([{ kind: "invalidation" }]);
	}
});

it("skips the optional worker when its full budget would delay a verified base change", async () => {
	authorize();
	const sample = exportSamples();
	sample.save("// baseline", []);
	observe(sample.path, "worker-b", "read");
	await sample.run();
	time += 5_001;
	sample.save("export interface New {}", [{ name: "New", kind: "interface" }]);
	observe(sample.path, "worker-a", "edit");
	await sample.run({ deadline: performance.now() + 1_500 });
	expect(sample.exportInventory).toHaveBeenCalledTimes(1);
	expect(facts()?.events).toMatchObject([{ kind: "invalidation" }]);
	expect(store.readObservations({ cohort })).toEqual([]);
});
