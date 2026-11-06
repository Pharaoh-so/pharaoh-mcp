/** Finite native model provenance; no prompts, transcripts or arbitrary model strings survive. */
import { randomUUID } from "node:crypto";
import { EXPLORATION_MODELS } from "./runtime-contract.mjs";
import { updateRuntimeHooks } from "./runtime-hooks.mjs";
import { EVENT_TTL_MS, runtimeRef } from "./runtime-native.mjs";

/** Recognize exact registry candidates and anchored unknown families without retaining raw input. */
export function normalizeNativeMetadata(model) {
	const present = typeof model === "string" && model.length > 0;
	const known = EXPLORATION_MODELS.includes(model);
	return {
		modelId: known ? model : null,
		modelState: known ? "known" : present ? "unrecognized" : "absent",
		modelFamily: !present
			? "unknown"
			: /^claude-opus-\d+(?:[-.]|$)/.test(model)
				? "opus"
				: /^gpt-6(?:\.\d+)?(?:-|$)/.test(model)
					? "gpt6"
					: "other",
	};
}

/** Bind only registered hooks and observed installation builds to a finite capability tier. */
export function nativeRegistration(client, clientBuild, proxyBuild, now, metadataVersion = 1) {
	const version = typeof clientBuild === "string" ? clientBuild.split(".").map(Number) : [];
	const switchCapable =
		version.length === 3 &&
		(version[0] > 2 ||
			(version[0] === 2 && (version[1] > 1 || (version[1] === 1 && version[2] >= 251))));
	const hooks = Object.keys(
		updateRuntimeHooks(
			{},
			client,
			"registered",
			"node",
			clientBuild,
			randomUUID(),
			undefined,
			metadataVersion,
		).hooks,
	);
	return {
		id: randomUUID(),
		hooks,
		capability:
			metadataVersion === 2 &&
			client === "claude-code" &&
			switchCapable &&
			hooks.includes("PostModelSwitch")
				? "claude-session-switch-v2"
				: client === "codex"
					? "codex-uncorrelated-v2"
					: "unsupported",
		clientBuild,
		proxyBuild,
		buildObservedAt: new Date(now).toISOString(),
	};
}

/** Advance one bounded native session; callers persist it atomically with emitted observations.
 * The session choice is deliberately separate from the native turn used by exact calibration.
 */
export function updateNativeSessionState(client, input, previous, registration, key, now) {
	const event = input.hook_event_name;
	const expired = previous && now - previous.at >= EVENT_TTL_MS;
	let selection = expired ? null : (previous ?? null);
	let invalidateGeneration = expired ? previous.generation : undefined;
	let lifecycle;
	if (event === "SessionStart" || event === "PostModelSwitch") {
		if (selection && (selection.active || event === "PostModelSwitch"))
			invalidateGeneration = selection?.generation;
		lifecycle = event === "SessionStart" ? "start" : "switch";
		selection = {
			...normalizeNativeMetadata(event === "PostModelSwitch" ? input.to : input.model),
			generation: runtimeRef(key, "native-selection", randomUUID()),
			at: now,
			active: false,
			registration: registration?.id ?? null,
		};
	} else if (event === "SessionEnd") {
		if (selection?.active) invalidateGeneration = selection.generation;
		lifecycle = "end";
		selection = null;
	} else if (selection && selection.registration !== registration?.id) {
		invalidateGeneration = selection.generation;
		selection = null;
		lifecycle = "ambiguous";
	} else if (selection) {
		selection = {
			...selection,
			at: now,
			active:
				event === "UserPromptSubmit"
					? true
					: ["Stop", "StopFailure", "Interrupt"].includes(event)
						? false
						: selection.active,
		};
	}
	const model =
		client === "claude-code"
			? (selection ?? normalizeNativeMetadata(null))
			: normalizeNativeMetadata(input.model);
	const fresh = registration && now - Date.parse(registration.buildObservedAt) < EVENT_TTL_MS;
	return {
		selection,
		lifecycle,
		invalidateGeneration,
		metadata: {
			version: 2,
			modelId: model.modelId,
			modelState: model.modelState,
			modelFamily: model.modelFamily,
			modelBasis:
				client === "claude-code" && selection
					? "session_selected"
					: client === "codex" && event === "PostModelRequest"
						? "request_observed"
						: "unknown",
			selectionGeneration: selection?.generation ?? null,
			capability: registration?.capability ?? "unsupported",
			buildBasis: fresh ? "installation_observed" : "unknown",
			buildObservedAt: registration?.buildObservedAt ?? null,
			clientBuild: registration?.clientBuild ?? "unknown",
			proxyBuild: registration?.proxyBuild ?? "unknown",
			adapterVersion: "native-v2",
		},
	};
}
