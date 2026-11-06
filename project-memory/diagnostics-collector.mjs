import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	atomicWrite,
	conversationMemoryBinding,
	DIAGNOSTIC_SHELL_TOOLS,
	diagnosticEventForEgress,
	protectLocalShellAttempt,
} from "./local.mjs";
import { requestMemory, requestMemoryPolicy } from "./memory-api.mjs";
import { readHookPreferences } from "./preferences.mjs";
import {
	activeMemoryRuntime,
	matchingMemoryHint,
	memoryClientRoot,
	projectMemoryHint,
	projectMemorySession,
	readMemoryCredentials,
	resolveMemoryHookTarget,
} from "./user-target.mjs";

export const COLLECTOR_VERSION = "native-v1";
export const CAPABILITY_SCHEMA_VERSION = "native-hooks-v1";
const TTL = 24 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const MAX_TURN_BYTES = 64 * 1024;
const MAX_EVENTS = 100;
const MAX_BATCH = 12_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FILE = /^event-[a-f0-9-]{36}\.json$/;
const CLIENTS = new Set(["claude-code", "codex"]);
const MEMORY = /(?:^|__)pharaoh_memory_(recall|expand|capture|feedback)$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

function privatePath(path, directory, max = MAX_BYTES) {
	const stat = lstatSync(path);
	if (
		(directory ? !stat.isDirectory() : !stat.isFile()) ||
		stat.uid !== process.getuid?.() ||
		stat.mode & 0o077 ||
		(!directory && stat.size > max)
	)
		throw new Error("Private diagnostic state is unavailable.");
	return stat;
}
function directory(client, home, create = false) {
	if (!CLIENTS.has(client)) return;
	const root = memoryClientRoot(home);
	if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
	privatePath(root, true);
	const parent = join(root, "diagnostics");
	if (create) mkdirSync(parent, { recursive: true, mode: 0o700 });
	privatePath(parent, true);
	const path = join(parent, client);
	if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
	privatePath(path, true);
	return path;
}
function read(path, max = MAX_BYTES) {
	try {
		privatePath(path, false, max);
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
}
function bounded(value, max) {
	if (typeof value !== "string") return;
	// Keep useful text; redact common credential forms, never promise exhaustive filtering.
	const safe = value
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
			"[redacted private key]",
		)
		.replace(
			/(?:phat|phrt|pss|dev)_[a-f\d]{64}|\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9_-]{16,})\b|Bearer[ \t]+\S+/gi,
			"[redacted]",
		)
		.replace(
			/(?:password|secret|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S{6,}/gi,
			"[redacted credential]",
		)
		.replace(/\p{Bidi_Control}/gu, "");
	const buffer = Buffer.from(
		[...safe]
			.filter((char) => {
				const code = char.charCodeAt(0);
				return (code >= 32 && code !== 127) || [9, 10, 13].includes(code);
			})
			.join(""),
	);
	return {
		text: buffer
			.subarray(0, max)
			.toString("utf8")
			.replace(/\uFFFD$/, ""),
		clipped: buffer.length > max,
	};
}
function identifier(value) {
	return typeof value === "string" &&
		value.length > 0 &&
		Buffer.byteLength(value) <= 256 &&
		![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
		? value
		: undefined;
}
function safePath(value, root) {
	if (
		typeof value !== "string" ||
		Buffer.byteLength(value) > 180 ||
		[...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
	)
		return;
	const path = isAbsolute(value) ? relative(root, value) : value;
	if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) return;
	return path;
}
function resultObject(input) {
	const response = input.tool_response ?? input.tool_result ?? input.result;
	if (typeof response === "string") {
		if (Buffer.byteLength(response) > MAX_TURN_BYTES) return;
		try {
			return JSON.parse(response);
		} catch {
			return;
		}
	}
	if (response?.structuredContent && typeof response.structuredContent === "object")
		return response.structuredContent;
	if (Array.isArray(response?.content)) {
		const texts = response.content.filter(
			(part) => part?.type === "text" && typeof part.text === "string",
		);
		if (texts.length === 1 && Buffer.byteLength(texts[0].text) <= MAX_TURN_BYTES) {
			try {
				return JSON.parse(texts[0].text);
			} catch {
				return;
			}
		}
	}
	return response && typeof response === "object"
		? {
				...response,
				...(response._meta && typeof response._meta === "object" ? response._meta : {}),
			}
		: undefined;
}
function toolPayload(input, target) {
	const name = identifier(input.tool_name);
	if (!name) return;
	const operation = MEMORY.exec(name)?.[1];
	const result = operation ? resultObject(input) : undefined;
	const outcome =
		input.tool_response?.isError === true ||
		input.tool_result?.isError === true ||
		input.is_error === true
			? "error"
			: result
				? "success"
				: "unknown";
	const rawCall = identifier(input.tool_use_id ?? input.tool_call_id);
	const call = rawCall
		? /^[A-Za-z0-9._:/-]{1,128}$/.test(rawCall)
			? rawCall
			: `call-${hash(rawCall)}`
		: undefined;
	if (operation) {
		const args = input.tool_input ?? input.tool_arguments;
		if (typeof args?.repo === "string" && args.repo.toLowerCase() !== target.repo.toLowerCase())
			return;
		return {
			kind: operation === "recall" ? "recall_observed" : "tool_observed",
			payload: {
				...(operation === "recall"
					? { outcome, recallId: UUID.test(result?.recallId ?? "") ? result.recallId : null }
					: { operation, status: outcome }),
				...(call && { toolCallId: call }),
				...(typeof result?.feedbackRequest?.requestId === "string" &&
					UUID.test(result.feedbackRequest.requestId) && {
						feedbackRequestId: result.feedbackRequest.requestId,
					}),
				records: (Array.isArray(result?.records)
					? result.records
					: result?.record
						? [result.record]
						: []
				)
					.slice(0, 5)
					.flatMap((record) =>
						UUID.test(record?.id) &&
						Number.isInteger(record?.version) &&
						record.version > 0 &&
						record.version <= 1_000_000
							? [{ id: record.id, version: record.version }]
							: [],
					),
			},
		};
	}
	const args = input.tool_input ?? input.tool_arguments;
	if (DIAGNOSTIC_SHELL_TOOLS.has(name)) {
		const response = input.tool_response ?? input.tool_result;
		const status =
			response?.isError === true ||
			(Number.isInteger(response?.exit_code) && response.exit_code !== 0)
				? "error"
				: response?.exit_code === 0
					? "success"
					: "unknown";
		return {
			kind: "tool_observed",
			payload: {
				operation: "shell_task",
				status,
				...(call && { toolCallId: call }),
			},
		};
	}
	if (!["Edit", "Write", "MultiEdit", "apply_patch"].includes(name)) return;
	const paths = [];
	if (name === "apply_patch") {
		const patch = typeof args?.patch === "string" ? args.patch : args?.command;
		if (typeof patch === "string")
			for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: ([^\n]+)$/gm)) {
				const path = safePath(match[1], target.root);
				if (path && paths.length < 12 && !paths.includes(path)) paths.push(path);
			}
	} else {
		const path = safePath(args?.file_path ?? args?.path, target.root);
		if (path) paths.push(path);
	}
	const response = input.tool_response ?? input.tool_result;
	const editStatus =
		outcome === "error"
			? "error"
			: typeof response === "string" && /^Success\. Updated the following files:/m.test(response)
				? "success"
				: "unknown";
	return {
		kind: "tool_observed",
		payload: { operation: "edit", status: editStatus, ...(call && { toolCallId: call }), paths },
	};
}
function diagnosticPromptClass(value) {
	const prompt = typeof value === "string" ? value.trim() : "";
	if (/^(?:skip|do not use|don't use) (?:pharaoh )?(?:project )?memory[.!]?\s*$/i.test(prompt))
		return "opt_out";
	if (
		!prompt ||
		prompt.startsWith("Pharaoh memory pilot follow-up.") ||
		/^(?:\/(?:clear|compact|exit|help|hooks|quit|settings)\b|(?:cancel|stop|never mind)[.!]?\s*$)/i.test(
			prompt,
		)
	)
		return "heuristic_skip";
	return "eligible";
}
export function diagnosticsPolicyEligible(policy) {
	return (
		policy?.enabled === true &&
		policy?.contentEnabled === true &&
		policy?.noticeSatisfied === true &&
		identifier(policy.policyVersion)
	);
}
export function clearDiagnosticQueue(client, home = homedir()) {
	try {
		const path = directory(client, home);
		rmSync(path, { recursive: true, force: true });
	} catch {
		/* Already absent or unsafe: never follow a linked path. */
	}
}
function entries(path, now) {
	const events = [];
	let total = 0;
	let expired = 0;
	for (const name of readdirSync(path)) {
		if (name === "sender.lock") continue;
		const location = join(path, name);
		try {
			const stat = privatePath(location, false);
			if (now - stat.mtimeMs > TTL) {
				if (FILE.test(name)) expired++;
				rmSync(location, { force: true });
				continue;
			}
			total += stat.size;
			if (FILE.test(name)) {
				const event = read(location, MAX_BATCH);
				if (event) events.push({ location, event, size: stat.size, mtime: stat.mtimeMs });
			}
		} catch {
			/* Do not follow or repair unsafe state. */
		}
	}
	if (expired) {
		const prior = read(join(path, "gaps.json"), 512);
		atomicWrite(join(path, "gaps.json"), JSON.stringify({ count: (prior?.count ?? 0) + expired }));
	}
	return { events: events.sort((a, b) => a.mtime - b.mtime), total, expired };
}
/** A dead owner can be reclaimed immediately; an unknown/reused PID stays fenced. */
function liveLease(path, name) {
	const location = join(path, name);
	const previous = read(location, 512);
	if (!previous) return Boolean(lstatSync(location, { throwIfNoEntry: false }));
	if (
		!Number.isInteger(previous.pid) ||
		previous.pid < 1 ||
		previous.pid > 2_147_483_647 ||
		typeof previous.owner !== "string"
	)
		return true;
	try {
		process.kill(previous.pid, 0);
		return true;
	} catch (error) {
		if (error.code !== "ESRCH") return true;
	}
	const current = read(location, 512);
	if (current?.owner !== previous.owner || current?.pid !== previous.pid) return true;
	rmSync(location, { force: true });
	return false;
}
function lock(path, name, now) {
	const location = join(path, name);
	try {
		if (liveLease(path, name)) return;
		const owner = randomUUID();
		writeFileSync(location, JSON.stringify({ owner, pid: process.pid, createdAt: now }), {
			flag: "wx",
			mode: 0o600,
		});
		return () => {
			if (read(location, 512)?.owner === owner) rmSync(location, { force: true });
		};
	} catch {
		return;
	}
}
function sameQueueScope(left, right) {
	return (
		left.repo.toLowerCase() === right.repo.toLowerCase() &&
		left.binding === right.binding &&
		left.collectionGeneration === right.collectionGeneration &&
		left.collectionPolicyVersion === right.collectionPolicyVersion
	);
}
function queueScopeKey(item) {
	return JSON.stringify([
		item.repo.toLowerCase(),
		item.binding,
		item.collectionGeneration,
		item.collectionPolicyVersion,
		item.metadataOnly === true,
	]);
}
function revokedPolicy(policy, queued) {
	const control = policy?.control;
	if (!control || typeof control.enabled !== "boolean" || !UUID.test(control.generation ?? ""))
		return false;
	return control.generation === queued.collectionGeneration
		? control.enabled === false
		: control.enabled === true;
}
/** Collect only allowlisted native fields. No transcript, file read, patch body or shell output enters the spool. */
export function collectDiagnosticEvent(
	input,
	{
		client,
		target,
		credentials,
		policy,
		runtime,
		home = homedir(),
		now = Date.now(),
		spawnSender = true,
	} = {},
) {
	if (
		!CLIENTS.has(client) ||
		!target?.root ||
		!target?.repo ||
		!diagnosticsPolicyEligible(policy) ||
		!UUID.test(policy.generation ?? "")
	)
		return;
	const choice = readHookPreferences(home)[client];
	if (
		choice?.memory === false ||
		choice?.diagnostics !== true ||
		choice.diagnosticsPolicyVersion !== policy.policyVersion ||
		choice.diagnosticsGeneration !== policy.generation ||
		!activeMemoryRuntime(client, runtime, home)
	)
		return;
	protectLocalShellAttempt(client, input, { home });
	const binding = projectMemorySession(credentials);
	if (!binding) return;
	const promptClass = diagnosticPromptClass(input.prompt);
	const optsOut = input.hook_event_name === "UserPromptSubmit" && promptClass === "opt_out";
	const path = directory(client, home, true);
	const release = lock(path, "collection.lock", now);
	if (!release) return;
	try {
		const inventory = entries(path, now);
		const session = identifier(input.session_id);
		const conversation = conversationMemoryBinding(client, session);
		const sessionRef = conversation?.sessionRef ?? `unknown-${randomUUID()}`;
		const statePath = join(path, `session-${sessionRef}.json`);
		const previous = read(statePath, 4096);
		const rawNativeTurn = identifier(input.turn_id ?? input.turnId);
		const nativeTurn = rawNativeTurn ? `native-${hash(rawNativeTurn)}` : undefined;
		const same =
			previous?.binding === binding &&
			previous.repo === target.repo &&
			(nativeTurn
				? previous.nativeTurn === nativeTurn
				: input.hook_event_name !== "UserPromptSubmit");
		const turnRef = nativeTurn ?? (same ? previous.turnRef : randomUUID());
		const identityProvenance =
			nativeTurn && session ? "native" : session ? "local_session" : "unknown";
		const state = same
			? previous
			: { binding, repo: target.repo, turnRef, nativeTurn, count: 0, size: 0 };
		if (optsOut) {
			state.optOut = true;
			atomicWrite(statePath, JSON.stringify(state));
			for (const item of inventory.events)
				if (item.event.event.sessionRef === sessionRef && item.event.event.turnRef === turnRef)
					rmSync(item.location, { force: true });
			return;
		}
		let observation;
		if (input.hook_event_name === "UserPromptSubmit") {
			// A sibling native hook may still be establishing local scope. Retain
			// turn coverage without spooling the prompt text in either hook order.
			observation = {
				kind: "turn_observed",
				payload: {
					coverage: {
						eligibility: promptClass,
						linkage: identityProvenance === "native" ? "native" : "unknown",
					},
				},
			};
		} else if (state.optOut) return;
		else if (input.hook_event_name === "PostToolUse") observation = toolPayload(input, target);
		else if (input.hook_event_name === "Stop") {
			const final = bounded(
				input.last_assistant_message ?? input.final_message ?? input.assistant_message,
				2048,
			);
			observation = {
				kind: "final_observed",
				payload: {
					...(final?.text?.trim() && { finalExcerpt: final.text, finalClipped: final.clipped }),
					completion: "stop_observed",
				},
			};
		} else if (["Interrupt", "StopFailure", "SessionEnd"].includes(input.hook_event_name))
			observation = { kind: "interruption_observed", payload: { reason: input.hook_event_name } };
		if (!observation) return;
		const observed = {
			eventId: randomUUID(),
			sessionRef,
			turnRef,
			identityProvenance,
			kind: observation.kind,
			observedAt: new Date(now).toISOString(),
			payload: observation.payload,
		};
		const event = diagnosticEventForEgress(client, observed, { home });
		if (!event) return;
		const queued = {
			repo: target.repo,
			...(event === observed ? { root: target.root } : { metadataOnly: true }),
			binding,
			collectionGeneration: policy.generation,
			collectionPolicyVersion: policy.policyVersion,
			event,
		};
		const size = bytes(queued);
		if (
			state.count >= MAX_EVENTS ||
			state.size + size > MAX_TURN_BYTES ||
			inventory.total + size + 4096 > MAX_BYTES
		) {
			const gaps = read(join(path, "gaps.json"), 512);
			atomicWrite(join(path, "gaps.json"), JSON.stringify({ count: (gaps?.count ?? 0) + 1 }));
			return;
		}
		const gapCount = read(join(path, "gaps.json"), 512)?.count ?? 0;
		if (
			gapCount &&
			inventory.total + size + 8192 < MAX_BYTES &&
			state.count < MAX_EVENTS - 1 &&
			state.size + size + 4096 < MAX_TURN_BYTES
		) {
			const gap = {
				...queued,
				event: {
					...event,
					eventId: randomUUID(),
					kind: "collector_gap",
					payload: { reason: "local_capacity_or_expiry", count: gapCount },
				},
			};
			const safeGap = diagnosticEventForEgress(client, gap.event, { home });
			if (safeGap && safeGap !== gap.event) {
				delete gap.root;
				gap.metadataOnly = true;
				gap.event = safeGap;
			}
			atomicWrite(join(path, `event-${gap.event.eventId}.json`), JSON.stringify(gap));
			rmSync(join(path, "gaps.json"), { force: true });
			state.count++;
			state.size += bytes(gap);
		}
		const finalEvent = diagnosticEventForEgress(client, event, { home });
		if (!finalEvent) return;
		if (finalEvent !== event) {
			delete queued.root;
			queued.metadataOnly = true;
		}
		queued.event = finalEvent;
		atomicWrite(join(path, `event-${event.eventId}.json`), JSON.stringify(queued));
		if (["final_observed", "interruption_observed"].includes(event.kind))
			atomicWrite(join(path, "terminal-wake.json"), JSON.stringify({ eventId: event.eventId }));
		state.count++;
		state.size += size;
		atomicWrite(statePath, JSON.stringify(state));
		return finalEvent;
	} finally {
		release();
		if (spawnSender) launchDiagnosticSender(client, { home, runtime });
	}
}
function launchDiagnosticSender(
	client,
	{ home = homedir(), runtime = dirname(fileURLToPath(import.meta.url)) } = {},
) {
	try {
		const path = directory(client, home);
		const release = lock(path, "sender-start.lock", Date.now());
		if (!release) return;
		try {
			if (liveLease(path, "sender.lock")) {
				release();
				return;
			}
			const child = spawn(process.execPath, [join(runtime, "diagnostics-sender.mjs"), client], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, HOME: home },
			});
			child.once("error", () => release());
			if (child.pid)
				atomicWrite(
					join(path, "sender-start.lock"),
					JSON.stringify({ owner: randomUUID(), pid: child.pid, createdAt: Date.now() }),
				);
			child.unref();
		} finally {
			/* The child removes the start lease after claiming the sender lease. */
		}
	} catch {
		/* A later native event retries undelivered evidence. */
	}
}
/** Independent ten-second sender lifetime lets the final hook return without killing delivery. */
export async function flushDiagnosticQueue(
	client,
	{
		home = homedir(),
		runtime = dirname(fileURLToPath(import.meta.url)),
		now = Date.now,
		request = requestMemory,
		readCredentials = readMemoryCredentials,
		policyRequest = requestMemoryPolicy,
		budgetMs = 9_000,
	} = {},
) {
	if (!CLIENTS.has(client)) return;
	let path;
	try {
		path = directory(client, home);
	} catch {
		return;
	}
	const release = lock(path, "sender.lock", now());
	if (!release) return;
	rmSync(join(path, "sender-start.lock"), { force: true });
	const deadline = performance.now() + Math.min(9_000, Math.max(1, budgetMs));
	const initialTerminal = read(join(path, "terminal-wake.json"), 512)?.eventId;
	let drained = false;
	const blocked = new Set();
	try {
		while (performance.now() < deadline) {
			const choice = readHookPreferences(home)[client];
			if (choice?.memory === false || choice?.diagnostics === false) {
				clearDiagnosticQueue(client, home);
				return;
			}
			// A replaced runtime or temporarily unreadable consent never implies server revocation.
			if (choice?.diagnostics !== true || !activeMemoryRuntime(client, runtime, home)) return;
			const inventory = entries(path, now());
			if (!inventory.events.length) {
				drained = true;
				return;
			}
			const credentials = await readCredentials();
			const binding = projectMemorySession(credentials);
			if (!credentials || !binding) return;
			const first = inventory.events.find(
				(item) => item.event.binding === binding && !blocked.has(queueScopeKey(item.event)),
			)?.event;
			if (!first) return;
			const scope = queueScopeKey(first);
			// Content-free events do not retain checkout paths. They still require
			// the live sign-in's repo hint and the scoped server policy below.
			const metadataOnly = first.metadataOnly === true;
			const target = metadataOnly
				? matchingMemoryHint(first, projectMemoryHint(credentials))
				: await resolveMemoryHookTarget(client, first.root, credentials, false, deadline);
			if (!target) {
				blocked.add(scope);
				continue;
			}
			let policy;
			try {
				policy = await policyRequest(first.repo, credentials, deadline, client);
			} catch {
				blocked.add(scope);
				continue;
			}
			if (revokedPolicy(policy, first)) {
				for (const item of inventory.events)
					if (sameQueueScope(item.event, first)) rmSync(item.location, { force: true });
				continue;
			}
			if (
				!diagnosticsPolicyEligible(policy) ||
				policy.policyVersion !== choice.diagnosticsPolicyVersion ||
				policy.generation !== choice.diagnosticsGeneration ||
				policy.policyVersion !== first.collectionPolicyVersion ||
				policy.generation !== first.collectionGeneration
			) {
				blocked.add(scope);
				continue;
			}

			const payload = {
				repo: first.repo,
				collectionGeneration: first.collectionGeneration,
				collectionPolicyVersion: first.collectionPolicyVersion,
				client,
				collectorVersion: COLLECTOR_VERSION,
				capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
				events: [],
			};
			const batch = [];
			// Terminal observations get a bounded delivery attempt even after a busy task.
			const pending = [...inventory.events].sort(
				(a, b) =>
					Number(["final_observed", "interruption_observed"].includes(b.event.event.kind)) -
					Number(["final_observed", "interruption_observed"].includes(a.event.event.kind)),
			);
			for (const item of pending) {
				if (batch.length >= 20) break;
				if (
					item.event.repo !== first.repo ||
					item.event.binding !== first.binding ||
					item.event.collectionGeneration !== first.collectionGeneration ||
					item.event.collectionPolicyVersion !== first.collectionPolicyVersion ||
					(item.event.metadataOnly === true) !== metadataOnly
				)
					continue;
				const event = diagnosticEventForEgress(client, item.event.event, { home, metadataOnly });
				if (!event) {
					rmSync(item.location, { force: true });
					continue;
				}
				payload.events.push(event);
				if (bytes(payload) >= MAX_BATCH) {
					payload.events.pop();
					break;
				}
				batch.push(item);
			}
			if (!batch.length) return;
			// Consent/runtime can change while policy/readiness awaited.
			const latest = readHookPreferences(home)[client];
			if (
				latest?.memory === false ||
				latest?.diagnostics !== true ||
				latest.diagnosticsPolicyVersion !== policy.policyVersion ||
				latest.diagnosticsGeneration !== policy.generation ||
				!activeMemoryRuntime(client, runtime, home)
			)
				return;
			let response;
			try {
				response = await request("diagnostics", payload, {
					credentials,
					home,
					timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
				});
			} catch {
				return;
			}
			const accepted = new Set(
				Array.isArray(response?.acceptedEventIds) ? response.acceptedEventIds : [],
			);
			const rejected = new Set(
				Array.isArray(response?.rejectedEventIds) ? response.rejectedEventIds : [],
			);
			let rejectedCount = 0;
			let removed = 0;
			for (const item of batch) {
				const eventId = item.event.event.eventId;
				if (accepted.has(eventId) || rejected.has(eventId)) {
					rmSync(item.location, { force: true });
					removed++;
				}
				if (rejected.has(eventId)) rejectedCount++;
			}
			if (rejectedCount) {
				const gaps = read(join(path, "gaps.json"), 512);
				atomicWrite(
					join(path, "gaps.json"),
					JSON.stringify({ count: Math.min(1_000_000, (gaps?.count ?? 0) + rejectedCount) }),
				);
			}
			if (!removed) return;
		}
	} finally {
		release();
		try {
			const terminal = read(join(path, "terminal-wake.json"), 512)?.eventId;
			// A terminal event can arrive while the previous sender is completing.
			// Hand off only a newly observed wake or the empty-queue race; failures
			// with an unchanged queue never create an unbounded retry chain.
			if ((drained || terminal !== initialTerminal) && entries(path, now()).events.length)
				launchDiagnosticSender(client, { home, runtime });
		} catch {
			/* Disable can remove the queue while a sender is finishing. */
		}
	}
}

/** Revocation carries only the prior consent generation, never queued excerpts. */
export async function revokeDiagnosticConsent(
	client,
	{ home = homedir(), request = requestMemory, readCredentials = readMemoryCredentials } = {},
) {
	if (!CLIENTS.has(client)) return;
	const choice = readHookPreferences(home)[client];
	const marker = join(memoryClientRoot(home), `diagnostics-revocation-${client}.json`);
	const pending = read(marker, 512);
	const generation =
		pending?.generation ??
		(choice?.diagnostics !== true || choice?.memory === false
			? choice?.diagnosticsGeneration
			: undefined);
	const policyVersion = pending?.policyVersion ?? choice?.diagnosticsPolicyVersion;
	if (!UUID.test(generation ?? "")) return;
	if (
		choice?.diagnostics === true &&
		choice?.memory !== false &&
		choice?.diagnosticsGeneration === generation
	)
		return;
	const credentials = await readCredentials();
	if (!credentials || !Array.isArray(credentials.project_memory)) return;
	let confirmed = credentials.project_memory.length > 0;
	for (const hint of credentials.project_memory) {
		const current = readHookPreferences(home)[client];
		if (
			current?.diagnostics === true &&
			current?.memory !== false &&
			current?.diagnosticsGeneration === generation
		)
			return;
		try {
			const result = await request(
				"diagnostics/control",
				{ repo: hint.repo, clientName: client, enabled: false, generation, policyVersion },
				{ credentials, timeoutMs: 1_200 },
			);
			if (result?.enabled !== false) confirmed = false;
		} catch {
			confirmed = false;
		}
	}
	// Retry the content-free tombstone during the next setup if offline now.
	if (confirmed && read(marker, 512)?.generation === generation) rmSync(marker, { force: true });
}
