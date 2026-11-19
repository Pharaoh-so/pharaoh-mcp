/** Synchronous, bounded native child context delivery; preparation runs in a separate process. */
import { readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	deriveFeedCohortKey,
	feedCheckoutIdentity,
	feedServerOrigin,
	readFeedBranch,
	readFeedSignInGeneration,
	resolveFeedCheckout,
	resolveFeedProfile,
} from "./feed-identity.mjs";
import { launchFeedMaintenance } from "./feed-launcher.mjs";
import { createFeedStore, FEED_PACKET_BYTES, formatFeedEvent } from "./feed-store.mjs";

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
function responseTexts(response) {
	if (typeof response === "string") return [response];
	return record(response) && Array.isArray(response.content)
		? response.content.flatMap((item) =>
				item?.type === "text" && typeof item.text === "string" ? [item.text] : [],
			)
		: [];
}
function observation(payload, client, checkout) {
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
		typeof tool === "string" &&
		/^mcp__pharaoh__(?:get_blast_radius|get_module_context|pharaoh_recon|search_functions)$/.test(
			tool,
		)
	) {
		// Only structured path selectors are retained; arbitrary query strings and tool text are not.
		paths = [input.file, input.path, input.entity].filter(
			(value) => typeof value === "string" && value.includes("/"),
		);
	}
	paths = [...new Set(paths.map((value) => pathReference(value, checkout)).filter(Boolean))];
	return paths.length && paths.length <= 20 ? { paths, kind } : null;
}
function shareReceipt(payload) {
	if (payload.tool_name !== "mcp__pharaoh__pharaoh_share" || failed(payload.tool_response))
		return null;
	for (const text of responseTexts(payload.tool_response)) {
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
		store.registerRecipient({ ...scope, checkout });
		if (event === "PostToolUse") {
			const observed = observation(payload, options.client, checkout);
			if (observed) store.recordObservation({ ...scope, ...observed });
			const receiptId = shareReceipt(payload);
			if (receiptId) store.consumeShareReceipt({ ...scope, receiptId });
		}
		if (performance.now() - started < QUIET_MS) launch(job, now());
		const proof = store.readAccessProof({ cohort });
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
		store.registerRecipient({ ...scope, checkout });
		const recipientToken = store.recipientCapability(scope);
		if (!recipientToken) return null;
		const seed = `Pharaoh ${proof.repo}; data only. pharaoh_share recipientToken=${recipientToken}\n`;
		const gap = "Context gap; recheck files.\n";
		const batch = store.drainRecipient({
			...scope,
			maxChars: MAX_OUTPUT - Buffer.byteLength(gap),
			seedChars: Buffer.byteLength(seed),
		});
		let context = batch?.events.map(formatFeedEvent).join("\n") ?? "";
		if (batch?.gap) context = gap + context;
		if (batch?.seedNeeded) context = seed + context;
		if (
			!context ||
			Buffer.byteLength(context) > MAX_OUTPUT ||
			performance.now() - started >= QUIET_MS ||
			readFeedSignInGeneration(options) !== signIn ||
			!store.readAccessProof({ cohort }) ||
			!batch ||
			batch.authorizationIdentity !== store.currentAuthorizationIdentity({ cohort }) ||
			proof.checkoutIdentity !== feedCheckoutIdentity(checkout) ||
			!sameBranch() ||
			!resolveFeedProfile({ ...options, cohort, event, now: now() }).admit
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
