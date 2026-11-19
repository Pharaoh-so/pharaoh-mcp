/** Local status reports authorized retained metadata and distinguishes claims from delivery. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeFeedRegistration, setNativeFeedEnabled } from "../runtime/feed-hooks.mjs";
import {
	deriveFeedCohortKey,
	feedCheckoutIdentity,
	readFeedSignInGeneration,
} from "../runtime/feed-identity.mjs";
import { feedRoot } from "../runtime/feed-io.mjs";
import { createFeedStore, type FeedAccessProof } from "../runtime/feed-store.mjs";
import { saveAuthorizedCredentials } from "../src/credentials.js";
import { nativeFeedStatus } from "../src/native-feed-status.js";

let home: string, credentialsPath: string, checkout: string, cohort: string, generation: string;
let store: ReturnType<typeof createFeedStore>;
const ROOT = "root";
const options = () => ({ home, credentialsPath });
function proof(epoch = 1): FeedAccessProof {
	return {
		version: 1,
		issuer: "https://mcp.pharaoh.so",
		actor: 123,
		owner: 456,
		repo: "fixture/repo",
		epoch,
		signIn: generation,
		checkout,
		checkoutIdentity: feedCheckoutIdentity(checkout)!,
		requestedAt: Date.now(),
		expiresAt: Date.now() + 60_000,
	};
}
function recipient(agentId: string) {
	expect(store.registerFeedRoot({ cohort, rootId: ROOT, checkout })).toBe(true);
	expect(
		store.registerRecipient({
			cohort,
			rootId: ROOT,
			agentId,
			checkout,
			interests: ["src/example.ts"],
		}),
	).toBe(true);
}
function publish() {
	recipient("writer");
	recipient("reader");
	expect(
		store.publishFinding({
			cohort,
			rootId: ROOT,
			agentId: "writer",
			kind: "reported",
			references: ["src/example.ts"],
			summary: "DO_NOT_INCLUDE_REPORT_CONTENT",
		}),
	).not.toBeNull();
}
beforeEach(async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
	home = realpathSync(mkdtempSync(join(tmpdir(), "pharaoh-feed-status-")));
	mkdirSync(join(home, ".pharaoh"), { mode: 0o700 });
	checkout = join(home, "repo");
	mkdirSync(checkout);
	mkdirSync(join(checkout, ".git"));
	credentialsPath = join(home, ".pharaoh", "credentials.json");
	await saveAuthorizedCredentials(
		{
			version: 2,
			access_token: "fixture-access",
			refresh_token: "fixture-refresh",
			expires_in: 604800,
			expires_at: "2999-01-01T00:00:00Z",
			refresh_expires_at: "2999-02-01T00:00:00Z",
			sse_url: "https://mcp.pharaoh.so/sse/fixture",
			github_login: "fixture",
			tenant_name: "fixture",
			repos: ["fixture/repo"],
		},
		credentialsPath,
	);
	generation = readFeedSignInGeneration(options())!;
	const registration = nativeFeedRegistration("codex", { home });
	cohort = deriveFeedCohortKey({
		client: "codex",
		registration,
		server: "https://mcp.pharaoh.so",
		signIn: generation,
		checkout,
	})!;
	store = createFeedStore(options());
	expect(
		store.recordFeedConnection({
			id: randomUUID(),
			cohort,
			client: "codex",
			signIn: generation,
			checkout,
			state: "initialized",
			name: "codex-mcp-client",
			clientVersion: "0.166.0",
		}),
	).toBe(true);
	expect(store.putAccessProof({ cohort, proof: proof() })).toBe(true);
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(home, { recursive: true, force: true });
});

describe("native feed status", () => {
	it("counts queued events, claims and confirmed output separately without exposing report contents", () => {
		publish();
		const pending = store.drainRecipient({ cohort, rootId: ROOT, agentId: "reader" })!;
		const before = nativeFeedStatus(options());
		expect(before.status).toBe("available");
		expect(before.cohorts[0]).toMatchObject({
			repo: "fixture/repo",
			compatibility: "eligible",
			queuedEvents: 1,
			recipients: 2,
			claimedEvents: 1,
			emittedPackets: 0,
			pendingClaims: 1,
			events: [{ kind: "reported", references: ["src/example.ts"] }],
		});
		expect(JSON.stringify(before)).not.toContain("DO_NOT_INCLUDE_REPORT_CONTENT");
		expect(JSON.stringify(before)).not.toContain("fixture-access");
		expect(JSON.stringify(before)).not.toContain(checkout);
		expect(before.semantics.emitted).toContain("not model consumption");
		expect(
			store.markEmitted({ cohort, rootId: ROOT, agentId: "reader", claimId: pending.claimId! }),
		).toBe(true);
		expect(nativeFeedStatus(options()).cohorts[0]).toMatchObject({
			claimedEvents: 1,
			emittedPackets: 1,
			pendingClaims: 0,
		});
	});

	it("marks disabled delivery unavailable while preserving the current authorized inspection", () => {
		publish();
		setNativeFeedEnabled("codex", false, { home });
		expect(nativeFeedStatus(options()).cohorts[0]).toMatchObject({
			compatibility: "unavailable",
			queuedEvents: 1,
		});
	});

	it("does not expose records after proof expiry or a changed sign-in", async () => {
		publish();
		vi.advanceTimersByTime(60_001);
		const expired = nativeFeedStatus(options());
		expect(expired.status).toBe("unavailable");
		expect(expired.cohorts).toEqual([]);
		expect(expired.unavailableCohorts).toBe(1);
		await saveAuthorizedCredentials(
			{
				version: 2,
				access_token: "replacement",
				refresh_token: "replacement-refresh",
				expires_in: 604800,
				expires_at: "2999-01-01T00:00:00Z",
				refresh_expires_at: "2999-02-01T00:00:00Z",
				sse_url: "https://mcp.pharaoh.so/sse/replaced",
				github_login: "new-person",
				tenant_name: "other",
				repos: [],
			},
			credentialsPath,
		);
		expect(nativeFeedStatus(options()).cohorts).toEqual([]);
	});

	it("reports malformed state as unavailable, not an empty successful queue", () => {
		writeFileSync(join(feedRoot(options()), "state", `${cohort}.json`), '{"version":1}', {
			mode: 0o600,
		});
		const result = nativeFeedStatus(options());
		expect(result.status).toBe("unavailable");
		expect(result.unavailableCohorts).toBe(1);
		expect(result.cohorts).toEqual([]);
	});

	it("caps inspection at thirty-two cohort files and states that coverage is incomplete", () => {
		for (let index = 1; index <= 33; index++) {
			const key = index.toString(16).padStart(64, "0");
			expect(store.putAccessProof({ cohort: key, proof: proof() })).toBe(true);
		}
		const result = nativeFeedStatus(options());
		expect(result.cohorts).toHaveLength(32);
		expect(result.truncated).toBe(true);
		expect(result.status).toBe("partial");
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65_536);
	});

	it("does not create any files when native feed state is absent", () => {
		const absent = join(home, "absent");
		expect(nativeFeedStatus({ home: absent }).status).toBe("unavailable");
		expect(existsSync(absent)).toBe(false);
	});
});
