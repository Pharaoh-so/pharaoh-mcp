/** Native feed regressions exercise private disk state and real scope/claim boundaries, without mocked IO. */
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deriveFeedCohortKey,
	feedCheckoutIdentity,
	readFeedBranch,
	readFeedSignInGeneration,
	resolveFeedCheckout,
	resolveFeedProfile,
} from "../runtime/feed-identity.mjs";
import { feedHash, feedRoot, writeFeedJSON } from "../runtime/feed-io.mjs";
import { beginFeedSignIn, commitFeedSignIn } from "../runtime/feed-signin.mjs";
import { createFeedStore, type FeedAccessProof } from "../runtime/feed-store.mjs";

let home: string;
let credentialsPath: string;
let checkout: string;
let generation: string;
let time: number;
let cohort: string;
let store: ReturnType<typeof createFeedStore>;
const registration = "00000000-0000-4000-8000-000000000001";
const server = "https://mcp.pharaoh.so";
const rootId = "native-root";
const options = () => ({ home, credentialsPath, now: () => time });
const scope = (agentId: string) => ({ cohort, rootId, agentId });
function authorize(epoch = 1): FeedAccessProof {
	const proof: FeedAccessProof = {
		version: 1,
		issuer: server,
		actor: 123,
		owner: "tenant-1",
		repo: "owner/repo",
		epoch,
		signIn: generation,
		checkout,
		checkoutIdentity: feedCheckoutIdentity(checkout)!,
		requestedAt: time,
		expiresAt: time + 60_000,
	};
	expect(
		store.putAccessProof({ cohort, proof, expectedRevision: store.readScopeRevision({ cohort })! }),
	).toBe(true);
	return proof;
}
function recipient(agentId: string, interests = ["src/shared.ts"]) {
	expect(store.registerFeedRoot({ cohort, rootId, checkout })).toBe(true);
	expect(store.registerRecipient({ ...scope(agentId), checkout, interests })).toBe(true);
}
function connection(clientVersion = "0.166.0", state: "pending" | "initialized" = "initialized") {
	const value = {
		id: randomUUID(),
		cohort,
		client: "codex" as const,
		signIn: generation,
		checkout,
		state,
		name: "codex-mcp-client",
		clientVersion,
	};
	expect(store.recordFeedConnection(value)).toBe(true);
	return value;
}
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "pharaoh-native-core-")));
	chmodSync(home, 0o700);
	mkdirSync(join(home, ".pharaoh"), { mode: 0o700 });
	credentialsPath = join(home, ".pharaoh", "credentials.json");
	writeFileSync(credentialsPath, "{}", { mode: 0o600 });
	const pending = beginFeedSignIn(server, credentialsPath);
	writeFileSync(credentialsPath, JSON.stringify({ native_feed_generation: pending.generation }), {
		mode: 0o600,
	});
	generation = commitFeedSignIn(pending, credentialsPath);
	writeFeedJSON(feedRoot({ home }), "registration-codex.json", {
		version: 1,
		client: "codex",
		registration,
	});
	checkout = join(home, "repo");
	mkdirSync(checkout, { mode: 0o700 });
	mkdirSync(join(checkout, ".git"), { mode: 0o700 });
	time = Date.now();
	cohort = deriveFeedCohortKey({
		client: "codex",
		registration,
		server,
		serverArgv: [],
		signIn: generation,
		checkout,
	})!;
	store = createFeedStore(options());
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("native feed identity and compatibility", () => {
	it("preserves exact server tokens while normalizing only their origin", () => {
		const base = { client: "codex", registration, server, signIn: generation, checkout };
		expect(deriveFeedCohortKey({ ...base, serverArgv: ["--server", `${server}/`] })).toBe(
			deriveFeedCohortKey({
				...base,
				server: `${server}/`,
				serverArgv: ["--server", `${server}/`],
			}),
		);
		expect(deriveFeedCohortKey({ ...base, serverArgv: ["--server", server] })).not.toBe(cohort);
		expect(
			deriveFeedCohortKey({ ...base, serverArgv: ["--server", "https://other.test"] }),
		).toBeNull();
		expect(
			deriveFeedCohortKey({ ...base, server: "https://user:secret@mcp.pharaoh.so/private" }),
		).toBeNull();
	});
	it("resolves subdirectories and keeps linked worktrees separate", () => {
		mkdirSync(join(checkout, "src"));
		expect(resolveFeedCheckout(join(checkout, "src"))).toBe(checkout);
		const linked = join(home, "linked");
		mkdirSync(linked);
		mkdirSync(join(checkout, ".git", "worktrees"));
		mkdirSync(join(checkout, ".git", "worktrees", "linked"));
		writeFileSync(
			join(linked, ".git"),
			`gitdir: ${join(checkout, ".git", "worktrees", "linked")}\n`,
		);
		expect(resolveFeedCheckout(linked)).toBe(linked);
		expect(resolveFeedCheckout(linked)).not.toBe(checkout);
	});
	it("reads only stable bounded branch metadata, including linked and detached worktrees", () => {
		const head = join(checkout, ".git", "HEAD");
		writeFileSync(head, "ref: refs/heads/main\n");
		expect(readFeedBranch(checkout)).toBe("main");
		writeFileSync(head, "ref: refs/heads/feature/context\n");
		expect(readFeedBranch(checkout)).toBe("feature/context");
		writeFileSync(head, `${"a".repeat(40)}\n`);
		expect(readFeedBranch(checkout)).toBeNull();
		const linked = join(home, "linked-head");
		mkdirSync(linked);
		writeFileSync(join(linked, ".git"), `gitdir: ${join(checkout, ".git")}\n`);
		writeFileSync(head, "ref: refs/heads/linked\n");
		expect(readFeedBranch(linked)).toBe("linked");
		for (const invalid of [
			"ref: refs/heads/../../private\n",
			"ref: refs/remotes/origin/main\n",
			"x".repeat(4097),
		]) {
			writeFileSync(head, invalid);
			expect(readFeedBranch(checkout)).toBeUndefined();
		}
		rmSync(head);
		symlinkSync(join(home, "outside-head"), head);
		writeFileSync(join(home, "outside-head"), "ref: refs/heads/unsafe\n");
		expect(readFeedBranch(checkout)).toBeUndefined();
	});
	it("requires consistent committed markers and refuses a symlinked credential file", () => {
		expect(readFeedSignInGeneration(options())).toBe(generation);
		const root = feedRoot(options());
		writeFeedJSON(root, "lifecycle.json", { version: 1, state: "pending", generation });
		expect(readFeedSignInGeneration(options())).toBeNull();
		rmSync(credentialsPath);
		symlinkSync(join(home, "other"), credentialsPath);
		expect(readFeedSignInGeneration(options())).toBeNull();
	});
	it("suppresses pending and unknown clients and expires dead connections at read time", () => {
		connection();
		const gate = () =>
			resolveFeedProfile({
				...options(),
				cohort,
				registration,
				client: "codex",
				event: "PostToolUse",
				now: time,
			});
		expect(gate()).toMatchObject({ admit: true, basis: "cohort", exactVersion: "unknown" });
		const pending = connection("0.166.0", "pending");
		expect(gate().admit).toBe(false);
		expect(store.removeFeedConnection(pending.id)).toBe(true);
		const newer = connection("0.167.0");
		expect(gate().admit).toBe(false);
		store.removeFeedConnection(newer.id);
		time += 30_001;
		expect(gate().admit).toBe(false);
	});
	it("does not renew a pending connection or discard malformed live candidates", () => {
		const pending = connection("0.166.0", "pending");
		expect(store.renewFeedConnection(pending.id)).toBe(false);
		const dir = join(feedRoot(options()), "cohorts");
		const summary = store.readCohort(cohort) as { connections: unknown[] };
		summary.connections.push({
			id: randomUUID(),
			state: "initialized",
			name: "codex-mcp-client",
			clientVersion: "0.166.0",
		});
		writeFeedJSON(dir, `${cohort}.json`, summary);
		expect(
			resolveFeedProfile({
				...options(),
				cohort,
				registration,
				client: "codex",
				event: "PostToolUse",
				now: time,
			}).admit,
		).toBe(false);
	});
	it("honors a saved native opt-out and fails closed on a malformed choice", () => {
		connection();
		for (const choice of [{ version: 1, enabled: false }, { broken: true }]) {
			writeFeedJSON(feedRoot(options()), "choice-codex.json", choice);
			expect(
				resolveFeedProfile({
					...options(),
					cohort,
					registration,
					client: "codex",
					event: "PostToolUse",
					now: time,
				}).admit,
			).toBe(false);
		}
	});
});

describe("native feed authorization and sibling claims", () => {
	it("keeps a cold seed pending until a packet is emitted", () => {
		authorize();
		recipient("cold-worker", []);
		const cold = store.drainRecipient(scope("cold-worker"))!;
		expect(cold.seedNeeded).toBe(true);
		expect(cold.claimId).not.toBeNull();
		expect(store.markEmitted({ ...scope("cold-worker"), claimId: cold.claimId! })).toBe(true);
		expect(store.drainRecipient(scope("cold-worker"))?.seedNeeded).toBe(false);
	});
	it("routes only relevant sibling events once and reports an interrupted claim as a gap", () => {
		authorize();
		recipient("worker-a");
		recipient("worker-b");
		recipient("worker-c", ["src/other.ts"]);
		expect(
			store.publishFinding({
				...scope("worker-a"),
				kind: "invalidation",
				references: ["src/shared.ts"],
				summary: "Saved file changed.",
			}),
		).not.toBeNull();
		expect(store.drainRecipient(scope("worker-a"))?.events).toHaveLength(0);
		expect(store.drainRecipient(scope("worker-c"))?.events).toHaveLength(0);
		const first = store.drainRecipient({ ...scope("worker-b"), maxChars: 160 })!;
		expect(first.events).toHaveLength(1);
		expect(store.drainRecipient(scope("worker-b"))).toMatchObject({ events: [], gap: true });
	});
	it("rejects undeliverable reports and defers a valid report until the seed fits", () => {
		authorize();
		recipient("worker-a");
		recipient("worker-b");
		const finding = {
			...scope("worker-a"),
			kind: "reported" as const,
			references: ["src/shared.ts"],
			summary: "x".repeat(400),
			dedupeKey: "a".repeat(64),
		};
		expect(store.publishFinding(finding)).toBeNull();
		const short = { ...finding, summary: "Saved file changed." };
		const first = store.publishFinding(short)!;
		expect(store.publishFinding(short)?.id).toBe(first.id);
		const seed = store.drainRecipient({ ...scope("worker-b"), maxChars: 160, seedChars: 150 })!;
		expect(seed.events).toHaveLength(0);
		expect(
			store.markEmitted({
				...scope("worker-b"),
				claimId: seed.claimId!,
				authorizationIdentity: seed.authorizationIdentity,
			}),
		).toBe(true);
		expect(
			store
				.drainRecipient({ ...scope("worker-b"), maxChars: 160 })
				?.events.map((event) => event.summary),
		).toEqual(["Saved file changed."]);
	});
	it("replays retained events when a worker learns a path later, but never across roots", () => {
		authorize();
		recipient("worker-a");
		recipient("worker-b", []);
		store.publishFinding({
			...scope("worker-a"),
			kind: "reported",
			references: ["src/shared.ts"],
			summary: "Shared contract discovered.",
		});
		expect(store.drainRecipient(scope("worker-b"))?.events).toHaveLength(0);
		store.recordObservation({ ...scope("worker-b"), paths: ["src/shared.ts"] });
		expect(store.drainRecipient(scope("worker-b"))?.events).toHaveLength(1);
		const other = { ...scope("worker-d"), rootId: "another-root" };
		store.registerFeedRoot({ ...other, checkout });
		store.registerRecipient({ ...other, checkout, interests: ["src/shared.ts"] });
		expect(store.drainRecipient(other)?.events).toHaveLength(0);
	});
	it("does not claim a report that cannot fit the current packet", () => {
		authorize();
		recipient("worker-a");
		recipient("worker-b");
		const seed = store.drainRecipient(scope("worker-b"))!;
		store.markEmitted({
			...scope("worker-b"),
			claimId: seed.claimId!,
			authorizationIdentity: seed.authorizationIdentity,
		});
		store.publishFinding({
			...scope("worker-a"),
			kind: "reported",
			references: ["src/shared.ts"],
			summary: "A valid compact report.",
		});
		expect(store.drainRecipient({ ...scope("worker-b"), maxChars: 1 })).toMatchObject({
			events: [],
			gap: false,
			claimId: null,
		});
		expect(store.drainRecipient(scope("worker-b"))?.events).toHaveLength(1);
	});
	it("withdraws expired access and clears retained data when the epoch changes", () => {
		authorize();
		recipient("worker-a");
		recipient("worker-b");
		store.publishFinding({
			...scope("worker-a"),
			kind: "reported",
			references: ["src/shared.ts"],
			summary: "An old authorized report.",
		});
		time += 60_001;
		expect(store.drainRecipient(scope("worker-b"))).toBeNull();
		authorize(2);
		expect(store.drainRecipient(scope("worker-b"))?.events).toHaveLength(0);
	});
	it("consumes a local share receipt once and rejects accepted labels and path escapes", () => {
		authorize();
		recipient("worker-a");
		recipient("worker-b");
		const recipientToken = store.recipientCapability(scope("worker-a"))!;
		const receiptId = store.createShareReceipt({
			cohort,
			recipientToken,
			finding: { kind: "reported", summary: "A bounded report.", references: ["src/shared.ts"] },
		})!;
		expect(store.consumeShareReceipt({ ...scope("worker-a"), receiptId })).not.toBeNull();
		expect(store.consumeShareReceipt({ ...scope("worker-a"), receiptId })).toBeNull();
		expect(
			store.createShareReceipt({
				cohort,
				recipientToken,
				finding: { kind: "accepted" as "reported", summary: "spoof", references: [] },
			}),
		).toBeNull();
		expect(
			store.publishFinding({
				...scope("worker-a"),
				kind: "reported",
				summary: "escape",
				references: ["../secret"],
			}),
		).toBeNull();
	});
	it("atomically fences targeted invalidation and stale proof or worker publication", () => {
		const old = authorize();
		recipient("worker-a");
		const revision = store.readScopeRevision({ cohort })!,
			authorizationIdentity = store.currentAuthorizationIdentity({ cohort })!;
		expect(store.clearFeedScope({ cohort, expectedRevision: revision })).toBe(true);
		expect(store.readAccessProof({ cohort })).toBeNull();
		expect(store.putAccessProof({ cohort, proof: old, expectedRevision: revision })).toBe(false);
		authorize(2);
		recipient("worker-a");
		expect(
			store.publishFinding({
				...scope("worker-a"),
				kind: "reported",
				summary: "Old report.",
				references: ["src/shared.ts"],
				authorizationIdentity,
			}),
		).toBeNull();
		expect(store.clearFeedScope({ cohort, expectedRevision: revision })).toBe(false);
		expect(store.readAccessProof({ cohort })).not.toBeNull();
	});
	it("rejects a claimed old proof at handoff and a retargeted checkout", () => {
		authorize();
		recipient("worker-a");
		const packet = store.drainRecipient(scope("worker-a"))!;
		authorize(2);
		expect(
			store.markEmitted({
				...scope("worker-a"),
				claimId: packet.claimId!,
				authorizationIdentity: packet.authorizationIdentity,
			}),
		).toBe(false);
		writeFileSync(
			join(checkout, ".git", "config"),
			'[remote "origin"]\nurl = https://github.com/other/repo\n',
		);
		expect(store.readAccessProof({ cohort })).toBeNull();
	});
	it("binds a share capability and receipt to one live child and one proof", () => {
		authorize();
		recipient("worker-a");
		recipient("worker-b");
		const recipientToken = store.recipientCapability(scope("worker-a"))!;
		const finding = {
			kind: "reported" as const,
			summary: "A compact report.",
			references: ["src/shared.ts"],
		};
		const receiptId = store.createShareReceipt({ cohort, recipientToken, finding })!;
		expect(store.consumeShareReceipt({ ...scope("worker-b"), receiptId })).toBeNull();
		expect(store.consumeShareReceipt({ ...scope("worker-a"), receiptId })).not.toBeNull();
		authorize(2);
		recipient("worker-a");
		expect(store.createShareReceipt({ cohort, recipientToken, finding })).toBeNull();
		expect(store.recipientCapability(scope("worker-a"))).not.toBe(recipientToken);
	});
	it("refuses credential or source-shaped report content and references before persistence", () => {
		authorize();
		recipient("worker-a");
		const recipientToken = store.recipientCapability(scope("worker-a"))!;
		for (const summary of [
			"ghp_fixture_not_a_real_credential",
			"api_key=fixture-only",
			"Bearer fixture-credential",
			"const value = 1;",
			"```code```",
		]) {
			expect(
				store.publishFinding({
					...scope("worker-a"),
					kind: "reported",
					summary,
					references: ["src/shared.ts"],
				}),
			).toBeNull();
			expect(
				store.createShareReceipt({
					cohort,
					recipientToken,
					finding: { kind: "reported", summary, references: ["src/shared.ts"] },
				}),
			).toBeNull();
		}
		for (const reference of [
			"src/ghp_fixture_token.ts",
			"src/key?api_key=fixture",
			"src/secret=fixture.ts",
		]) {
			expect(
				store.publishFinding({
					...scope("worker-a"),
					kind: "reported",
					summary: "A report.",
					references: [reference],
				}),
			).toBeNull();
			expect(store.recordObservation({ ...scope("worker-a"), paths: [reference] })).toBe(false);
		}
		expect(
			readFileSync(join(feedRoot(options()), "state", `${cohort}.json`), "utf8"),
		).not.toContain("fixture-only");
	});
	it("expires abandoned data on disk and never jams on byte-heavy observations", () => {
		authorize();
		recipient("worker-a");
		for (let i = 0; i < 40; i++)
			expect(
				store.recordObservation({
					...scope("worker-a"),
					paths: Array.from({ length: 16 }, (_, j) => `src/${i}-${j}-${"x".repeat(450)}.ts`),
				}),
			).toBe(true);
		expect(
			store.publishFinding({
				...scope("worker-a"),
				kind: "reported",
				summary: "Still usable.",
				references: ["src/shared.ts"],
			}),
		).not.toBeNull();
		time += 30 * 60_000 + 1;
		expect(store.pruneExpired({ limit: 64 })).toBeGreaterThan(0);
		const base = feedRoot(options());
		expect(existsSync(join(base, "state", `${cohort}.json`))).toBe(false);
		expect(existsSync(join(base, "proofs", `${cohort}.json`))).toBe(false);
		expect(existsSync(join(base, "roots", cohort, `${feedHash(rootId)}.json`))).toBe(false);
	});
	it("contains no subprocess or networking imports in the transitive identity dependency graph", () => {
		const visited = new Set<string>();
		function visit(file: string) {
			if (visited.has(file)) return;
			visited.add(file);
			const text = readFileSync(file, "utf8");
			expect(text).not.toMatch(/from\s+["']node:(?:child_process|https?|net|tls)["']/);
			for (const match of text.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g))
				visit(resolve(dirname(file), match[1]));
		}
		visit(resolve(import.meta.dirname, "../runtime/feed-identity.mjs"));
		expect(visited.size).toBeGreaterThan(2);
	});
});
