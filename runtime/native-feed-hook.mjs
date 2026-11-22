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
	const tool = payload.tool_name;
	let paths = [];
	let kind = "read";
	if (client === "claude-code" && ["Read", "Edit", "Write", "MultiEdit"].includes(tool)) {
		paths = [input.file_path];
		kind = tool === "Read" ? "read" : "edit";
	} else if (client === "codex" && tool === "apply_patch") {
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
		paths = [
			...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm),
		].map((match) => match[1]);
		kind = "edit";
	} else if (
		tool === "mcp__pharaoh__get_blast_radius" &&
		input.entity_type === "file" &&
		matchesVerifiedRepo(input.repo, repo, input.scope !== "hosted")
	) {
		// A file selector establishes interest, without asserting anything from the tool response.
		paths = [input.entity];
	} else if (
		tool === "mcp__pharaoh__search_functions" &&
		matchesVerifiedRepo(input.repo, repo, false) &&
		typeof input.file === "string" &&
		input.file.includes("/")
	) {
		// The hosted search also accepts substrings. Observe only path-shaped selectors.
		paths = [input.file];
	}
	paths = [...new Set(paths.map((value) => pathReference(value, checkout)).filter(Boolean))];
	return paths.length && paths.length <= 20 ? { paths, kind } : null;
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
	if (client === "claude-code" && Array.isArray(response)) {
		if (response.length < 2) return null;
		const expected = hostedModuleWatchText(repo, input.module);
		let found = false;
		for (const block of response) {
			if (failed(block)) return null;
			if (typeof block?.text !== "string" || !block.text.startsWith(HOSTED_MODULE_WATCH_PREFIX))
				continue;
			if (
				found ||
				!record(block) ||
				block.type !== "text" ||
				Object.keys(block).length !== 2 ||
				block.text !== expected
			)
				return null;
			found = true;
		}
		return found ? input.module : null;
	}
	if (!record(response?._meta)) return null;
	const watch = boundHostedModuleWatch(response._meta[HOSTED_MODULE_WATCH_KEY], input);
	return watch?.repo === repo ? watch.module : null;
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
	try {
		if (
			!record(payload) ||
			!options ||
			!["codex", "claude-code"].includes(options.client) ||
			!EVENTS.has(payload.hook_event_name) ||
			!ID.test(payload.session_id ?? "") ||
			typeof payload.cwd !== "string"
		)
			return null;
		const event = payload.hook_event_name;
		const signIn = readFeedSignInGeneration(options);
		const checkout = resolveFeedCheckout(payload.cwd);
		if (!signIn || !checkout || !feedServerOrigin(options.server)) return null;
		const cohort = deriveFeedCohortKey({ ...options, signIn, checkout });
		if (!cohort) return null;
		const profile = resolveFeedProfile({ ...options, cohort, event, now: now() });
		if (!profile.admit) return null;
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
		const job = {
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
		const launch = options.launch ?? launchFeedMaintenance;
		if (!child) {
			if (performance.now() - started < QUIET_MS) launch(job, now());
			return null;
		}
		const scope = { cohort, rootId, agentId: child };
		const registered = store.registerRecipient({ ...scope, checkout });
		const proof = store.readAccessProof({ cohort });
		if (event === "PostToolUse") {
			const observed = observation(payload, options.client, checkout, proof?.repo);
			if (observed) store.recordObservation({ ...scope, ...observed });
			const receiptId = shareReceipt(payload, options.client);
			if (receiptId) store.consumeShareReceipt({ ...scope, receiptId });
			if (
				proof &&
				payload.tool_name === "mcp__pharaoh__get_module_context" &&
				nativeFeedPreviewEnabled(options.client, options)
			) {
				const authorizationIdentity = store.currentAuthorizationIdentity({ cohort });
				const watchProof = authorizationIdentity && store.readAccessProof({ cohort });
				const module = watchProof && hostedModuleWatch(payload, options.client, watchProof.repo);
				if (module && authorizationIdentity)
					store.recordHostedModuleWatch({ ...scope, module, authorizationIdentity });
			}
		}
		if (performance.now() - started < QUIET_MS) launch(job, now());
		if (
			!proof ||
			proof.checkout !== checkout ||
			proof.checkoutIdentity !== feedCheckoutIdentity(checkout) ||
			proof.signIn !== signIn ||
			proof.issuer !== feedServerOrigin(options.server) ||
			performance.now() - started >= QUIET_MS
		)
			return null;
		const sameBranch = () => {
			const producer = store.readProducerState({ cohort });
			return (
				!producer ||
				!Object.hasOwn(producer, "branch") ||
				producer.branch === readFeedBranch(checkout)
			);
		};
		if (!sameBranch()) {
			store.clearFeedScope({ cohort });
			return null;
		}
		let recipientToken = registered ? store.recipientCapability(scope) : null;
		if (!recipientToken) {
			// Maintenance can renew proof and replace the recipient scope after registration.
			store.registerRecipient({ ...scope, checkout });
			recipientToken = store.recipientCapability(scope);
		}
		if (!recipientToken) return null;
		const seed = `Pharaoh ${proof.repo}; data only. pharaoh_share recipientToken=${recipientToken}\n`;
		const gap = "Context gap; recheck files.\n";
		const batch = store.drainRecipient({
			...scope,
			maxChars: MAX_OUTPUT - Buffer.byteLength(gap),
			seedChars: Buffer.byteLength(seed),
			preview: nativeFeedPreviewEnabled(options.client, options),
		});
		if (
			!batch ||
			!batch.authorizationIdentity ||
			readFeedSignInGeneration(options) !== signIn ||
			batch.authorizationIdentity !== store.currentAuthorizationIdentity({ cohort }) ||
			proof.checkoutIdentity !== feedCheckoutIdentity(checkout) ||
			!sameBranch() ||
			!resolveFeedProfile({ ...options, cohort, event, now: now() }).admit
		)
			return null;
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
		if (batch.gap || hostedGap) context = gap + context;
		if (batch.seedNeeded) context = seed + context;
		if (
			!context ||
			Buffer.byteLength(context) > MAX_OUTPUT ||
			performance.now() - started >= QUIET_MS
		)
			return null;
		const output = { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
		// A caller must confirm the successful stdout handoff; assembly is not emission.
		if (batch?.claimId)
			emissions.set(output, () => {
				if (proof.checkoutIdentity !== feedCheckoutIdentity(checkout) || !sameBranch())
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
	} catch {
		return null;
	}
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
