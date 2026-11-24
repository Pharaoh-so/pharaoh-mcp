/** Synchronous, bounded native child context delivery; preparation runs in a separate process. */
import { readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	deriveFeedCohortKey,
	feedCheckoutIdentity,
	feedServerOrigin,
	nativeFeedPreviewEnabled,
	readFeedBranch,
	readFeedSignInGeneration,
	resolveFeedCheckout,
	resolveFeedProfile,
} from "./feed-identity.mjs";
import { launchFeedMaintenance } from "./feed-launcher.mjs";
import {
	boundHostedModuleWatch,
	createFeedStore,
	FEED_PACKET_BYTES,
	formatFeedEvent,
	HOSTED_MODULE_WATCH_KEY,
	HOSTED_MODULE_WATCH_PREFIX,
	hostedModuleWatchText,
	isHostedFeedModule,
} from "./feed-store.mjs";

const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "SubagentStart", "PostToolUse"]);
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const QUIET_MS = 150;
// A byte ceiling is deliberately conservative across native model tokenizers.
const MAX_OUTPUT = FEED_PACKET_BYTES;
const GAP = "Context gap; recheck files.\n";
const emissions = new WeakMap();

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value);
}
function pathReference(value, checkout) {
	if (typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value)) return null;
	const candidate = isAbsolute(value) ? relative(checkout, value) : value;
	if (
		!candidate ||
		isAbsolute(candidate) ||
		candidate.split(/[\\/]/).some((part) => !part || part === ".." || part === ".git") ||
		candidate.length > 240
	)
		return null;
	return candidate.split(sep).join("/");
}
function failed(response) {
	return (
		record(response) &&
		(response.isError === true || response.is_error === true || response.success === false)
	);
}
function responseTexts(response, allowArray = false) {
	if (typeof response === "string") return [response];
	const blocks = allowArray && Array.isArray(response) ? response : response?.content;
	return Array.isArray(blocks)
		? blocks.flatMap((item) =>
				item?.type === "text" && typeof item.text === "string" ? [item.text] : [],
			)
		: [];
}
function matchesVerifiedRepo(value, repo, allowShort) {
	if (typeof value !== "string" || !repo) return false;
	const slug = repo.toLowerCase();
	const selector = value.toLowerCase();
	return selector === slug || (allowShort && selector === slug.split("/")[1]);
}
function observation(payload, client, checkout, repo) {
	if (failed(payload.tool_response)) return null;
	const input = record(payload.tool_input) ? payload.tool_input : {};
	const selected = observedSelection(payload, input, client, repo);
	if (!selected) return null;
	const paths = [
		...new Set(selected.paths.map((value) => pathReference(value, checkout)).filter(Boolean)),
	];
	return paths.length && paths.length <= 20 ? { paths, kind: selected.kind } : null;
}
function observedSelection(payload, input, client, repo) {
	const tool = payload.tool_name;
	if (client === "claude-code" && ["Read", "Edit", "Write", "MultiEdit"].includes(tool))
		return { paths: [input.file_path], kind: tool === "Read" ? "read" : "edit" };
	if (client === "codex" && tool === "apply_patch") return patchSelection(payload, input);
	return { paths: [pharaohFileSelector(tool, input, repo)], kind: "read" };
}
function patchSelection(payload, input) {
	const patch = typeof input.command === "string" ? input.command : input.patch;
	if (
		typeof patch !== "string" ||
		patch.length > 64_000 ||
		!patch.startsWith("*** Begin Patch\n") ||
		!responseTexts(payload.tool_response).some((text) =>
			/^Success\. Updated the following files:/m.test(text),
		)
	)
		return null;
	return {
		paths: [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(
			(match) => match[1],
		),
		kind: "edit",
	};
}
function pharaohFileSelector(tool, input, repo) {
	if (
		tool === "mcp__pharaoh__get_blast_radius" &&
		input.entity_type === "file" &&
		matchesVerifiedRepo(input.repo, repo, input.scope !== "hosted")
	)
		// A file selector establishes interest, without asserting anything from the tool response.
		return input.entity;
	if (
		tool === "mcp__pharaoh__search_functions" &&
		matchesVerifiedRepo(input.repo, repo, false) &&
		typeof input.file === "string" &&
		input.file.includes("/")
	)
		// The hosted search also accepts substrings. Observe only path-shaped selectors.
		return input.file;
	return null;
}
function hostedModuleWatch(payload, client, repo) {
	const input = payload.tool_input;
	const response = payload.tool_response;
	if (
		payload.tool_name !== "mcp__pharaoh__get_module_context" ||
		!record(input) ||
		failed(response) ||
		!matchesVerifiedRepo(input.repo, repo, false) ||
		!isHostedFeedModule(input.module)
	)
		return null;
	if (client === "claude-code" && Array.isArray(response))
		return contentArrayWatch(response, repo, input.module);
	if (!record(response?._meta)) return null;
	const watch = boundHostedModuleWatch(response._meta[HOSTED_MODULE_WATCH_KEY], input);
	return watch?.repo === repo ? watch.module : null;
}
function contentArrayWatch(response, repo, module) {
	if (response.length < 2) return null;
	const expected = hostedModuleWatchText(repo, module);
	let found = false;
	for (const block of response) {
		if (failed(block)) return null;
		if (typeof block?.text !== "string" || !block.text.startsWith(HOSTED_MODULE_WATCH_PREFIX))
			continue;
		if (found || !isExactWatchBlock(block, expected)) return null;
		found = true;
	}
	return found ? module : null;
}
function isExactWatchBlock(block, expected) {
	return (
		record(block) &&
		block.type === "text" &&
		Object.keys(block).length === 2 &&
		block.text === expected
	);
}
function shareReceipt(payload, client) {
	if (payload.tool_name !== "mcp__pharaoh__pharaoh_share" || failed(payload.tool_response))
		return null;
	for (const text of responseTexts(payload.tool_response, client === "claude-code")) {
		if (text.length > 1024) continue;
		try {
			const value = JSON.parse(text);
			if (
				value?.version === 1 &&
				value.state === "awaiting_child_hook" &&
				typeof value.receiptId === "string" &&
				/^[a-f0-9-]{36}$/.test(value.receiptId)
			)
				return value.receiptId;
		} catch {
			/* Not a structured successful local receipt. */
		}
	}
	return null;
}

/** Process one verified native boundary, returning bounded additionalContext or a quiet null. */
export function runNativeFeedHook(payload, options) {
	const started = options?.startedAt ?? performance.now();
	const now = options?.now ?? Date.now;
	// Launching needs time left; delivery stops once none is. Both read the same clock.
	const quiet = () => performance.now() - started < QUIET_MS;
	const late = () => performance.now() - started >= QUIET_MS;
	try {
		const boundary = admittedBoundary(payload, options, now);
		if (!boundary) return null;
		const { checkout, cohort, profile } = boundary;
		const store = createFeedStore(options);
		const rootId = payload.session_id;
		store.registerFeedRoot({
			cohort,
			rootId,
			checkout,
			basis: profile.basis,
			exactVersion: profile.exactVersion,
		});
		const child =
			typeof payload.agent_id === "string" && ID.test(payload.agent_id) ? payload.agent_id : null;
		const job = maintenanceJob(options, boundary, rootId);
		const launch = options.launch ?? launchFeedMaintenance;
		const maintain = () => {
			if (quiet()) launch(job, now());
		};
		if (!child) {
			maintain();
			return null;
		}
		const scope = { cohort, rootId, agentId: child };
		return childPacket({ ...boundary, payload, options, store, scope, maintain, late, now });
	} catch {
		return null;
	}
}

function maintenanceJob(options, { cohort, signIn, checkout }, rootId) {
	return {
		client: options.client,
		registration: options.registration,
		server: options.server,
		serverArgv: options.serverArgv ?? [],
		cohort,
		signIn,
		checkout,
		rootId,
		home: options.home ?? homedir(),
		credentialsPath: options.credentialsPath,
	};
}

/** The boundary's sign-in, checkout, cohort and profile once it is admitted; otherwise null. */
function admittedBoundary(payload, options, now) {
	if (!validBoundary(payload, options)) return null;
	const event = payload.hook_event_name;
	const signIn = readFeedSignInGeneration(options);
	const checkout = resolveFeedCheckout(payload.cwd);
	if (!signIn || !checkout || !feedServerOrigin(options.server)) return null;
	const cohort = deriveFeedCohortKey({ ...options, signIn, checkout });
	if (!cohort) return null;
	const profile = resolveFeedProfile({ ...options, cohort, event, now: now() });
	return profile.admit ? { event, signIn, checkout, cohort, profile } : null;
}
function validBoundary(payload, options) {
	return (
		record(payload) &&
		options &&
		["codex", "claude-code"].includes(options.client) &&
		EVENTS.has(payload.hook_event_name) &&
		ID.test(payload.session_id ?? "") &&
		typeof payload.cwd === "string"
	);
}

/** A native child's packet: record its tool use, then drain what it may see while proof holds. */
function childPacket(run) {
	const { event, signIn, checkout, cohort, payload, options, store, scope } = run;
	const registered = store.registerRecipient({ ...scope, checkout });
	const proof = store.readAccessProof({ cohort });
	if (event === "PostToolUse") recordToolUse(payload, options, store, scope, checkout, proof);
	run.maintain();
	if (proofStale(proof, checkout, signIn, options.server) || run.late()) return null;
	if (!onSameBranch(store, cohort, checkout)) {
		store.clearFeedScope({ cohort });
		return null;
	}
	const recipientToken = recipientCapability(store, scope, checkout, registered);
	if (!recipientToken) return null;
	const seed = `Pharaoh ${proof.repo}; data only. pharaoh_share recipientToken=${recipientToken}\n`;
	const batch = store.drainRecipient({
		...scope,
		maxChars: MAX_OUTPUT - Buffer.byteLength(GAP),
		seedChars: Buffer.byteLength(seed),
		preview: nativeFeedPreviewEnabled(options.client, options),
	});
	if (batchStale(batch, run, proof)) return null;
	const packet = renderPacket(batch, store, cohort, options, seed);
	if (!packet.context || Buffer.byteLength(packet.context) > MAX_OUTPUT || run.late()) return null;
	return emission(run, proof, batch, packet);
}
function recordToolUse(payload, options, store, scope, checkout, proof) {
	const observed = observation(payload, options.client, checkout, proof?.repo);
	if (observed) store.recordObservation({ ...scope, ...observed });
	const receiptId = shareReceipt(payload, options.client);
	if (receiptId) store.consumeShareReceipt({ ...scope, receiptId });
	if (
		proof &&
		payload.tool_name === "mcp__pharaoh__get_module_context" &&
		nativeFeedPreviewEnabled(options.client, options)
	)
		recordModuleWatch(payload, options.client, store, scope);
}
function recordModuleWatch(payload, client, store, scope) {
	const { cohort } = scope;
	const authorizationIdentity = store.currentAuthorizationIdentity({ cohort });
	const watchProof = authorizationIdentity && store.readAccessProof({ cohort });
	const module = watchProof && hostedModuleWatch(payload, client, watchProof.repo);
	if (module && authorizationIdentity)
		store.recordHostedModuleWatch({ ...scope, module, authorizationIdentity });
}
function proofStale(proof, checkout, signIn, server) {
	return (
		!proof ||
		proof.checkout !== checkout ||
		proof.checkoutIdentity !== feedCheckoutIdentity(checkout) ||
		proof.signIn !== signIn ||
		proof.issuer !== feedServerOrigin(server)
	);
}
function onSameBranch(store, cohort, checkout) {
	const producer = store.readProducerState({ cohort });
	return (
		!producer || !Object.hasOwn(producer, "branch") || producer.branch === readFeedBranch(checkout)
	);
}
function recipientCapability(store, scope, checkout, registered) {
	let recipientToken = registered ? store.recipientCapability(scope) : null;
	if (!recipientToken) {
		// Maintenance can renew proof and replace the recipient scope after registration.
		store.registerRecipient({ ...scope, checkout });
		recipientToken = store.recipientCapability(scope);
	}
	return recipientToken;
}
function batchStale(batch, { options, signIn, store, cohort, checkout, event, now }, proof) {
	return (
		!batch ||
		!batch.authorizationIdentity ||
		readFeedSignInGeneration(options) !== signIn ||
		batch.authorizationIdentity !== store.currentAuthorizationIdentity({ cohort }) ||
		proof.checkoutIdentity !== feedCheckoutIdentity(checkout) ||
		!onSameBranch(store, cohort, checkout) ||
		!resolveFeedProfile({ ...options, cohort, event, now: now() }).admit
	);
}
function renderPacket(batch, store, cohort, options, seed) {
	const hostedIds = batch.events.filter((entry) => entry.hosted).map((entry) => entry.id);
	const hostedCurrent = hostedIds.length
		? new Set(
				store.currentHostedModuleNoticeIds({
					cohort,
					authorizationIdentity: batch.authorizationIdentity,
					ids: hostedIds,
				}),
			)
		: undefined;
	const previewStillEnabled =
		(batch.hostedGap || batch.events.some((entry) => entry.previewOnly === true)) &&
		nativeFeedPreviewEnabled(options.client, options);
	const hostedGap = batch.hostedGap && previewStillEnabled;
	const visible = batch.events.filter(
		(entry) =>
			entry.previewOnly !== true ||
			(previewStillEnabled && (!entry.hosted || hostedCurrent?.has(entry.id))),
	);
	// Claims are independent. Only hide a fallback when its fact reached this packet.
	const enriched = new Set(
		visible
			.filter((entry) => entry.previewOnly === true && entry.kind === "fact" && entry.dedupeKey)
			.map((entry) => entry.dedupeKey),
	);
	const rendered = visible.filter(
		(entry) => entry.kind !== "invalidation" || !enriched.has(entry.dedupeKey),
	);
	let context = rendered.map(formatFeedEvent).join("\n");
	if (batch.gap || hostedGap) context = GAP + context;
	if (batch.seedNeeded) context = seed + context;
	return { context, hostedIds, hostedGap, rendered };
}
function emission({ event, checkout, store, cohort, scope }, proof, batch, packet) {
	const { context, hostedIds, hostedGap, rendered } = packet;
	const output = { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
	// A caller must confirm the successful stdout handoff; assembly is not emission.
	if (batch?.claimId)
		emissions.set(output, () => {
			if (
				proof.checkoutIdentity !== feedCheckoutIdentity(checkout) ||
				!onSameBranch(store, cohort, checkout)
			)
				return false;
			return store.markEmitted({
				...scope,
				claimId: batch.claimId,
				authorizationIdentity: batch.authorizationIdentity,
				hostedGap,
				hostedNoticeIds: hostedIds.length
					? rendered.filter((entry) => entry.hosted).map((entry) => entry.id)
					: undefined,
			});
		});
	return output;
}

/** Record stdout handoff once; this never claims that a model consumed or used the context. */
export function confirmNativeFeedEmission(output) {
	const complete = emissions.get(output);
	emissions.delete(output);
	return complete?.() ?? false;
}

function argumentsForHook(args) {
	const options = { server: "https://mcp.pharaoh.so", serverArgv: [] };
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		if (flag === "--pharaoh-native-feed-v1") continue;
		if (!["--client", "--feed-registration", "--server"].includes(flag) || !args[index + 1])
			return null;
		const value = args[++index];
		if (flag === "--client") {
			if (options.client) return null;
			options.client = value;
		} else if (flag === "--feed-registration") {
			if (options.registration) return null;
			options.registration = value;
		} else {
			if (options.serverArgv.length) return null;
			options.server = value;
			options.serverArgv = ["--server", value];
		}
	}
	return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.stdout.on("error", () => {});
	try {
		const bytes = Buffer.alloc(65_537);
		let length = 0;
		for (;;) {
			const count = readSync(0, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
			if (length > 65_536) break;
		}
		if (length <= 65_536) {
			const options = argumentsForHook(process.argv.slice(2));
			if (options) options.startedAt = performance.now() - process.uptime() * 1000;
			const output = runNativeFeedHook(
				JSON.parse(bytes.subarray(0, length).toString("utf8")),
				options,
			);
			if (output)
				process.stdout.write(`${JSON.stringify(output)}\n`, (error) => {
					if (!error) confirmNativeFeedEmission(output);
				});
		}
	} catch {
		/* Native hooks are optional and always quiet on failure. */
	}
}
