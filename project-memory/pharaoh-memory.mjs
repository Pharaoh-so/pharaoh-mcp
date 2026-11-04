import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { executeTurn } from "./execute-turn.mjs";
import { checkout, readStdin, turnStore } from "./local.mjs";
import { PilotError, refreshHelper } from "./memory-api.mjs";
import {
	activeMemoryRuntime,
	cachedMemoryCheckout,
	readMemoryCredentials,
} from "./user-target.mjs";

async function main(args) {
	const [operation, option, token, compactFlag, ...extra] = args;
	if (operation === "doctor" && args.length === 1) {
		await refreshHelper();
		process.stdout.write("The local Pharaoh refresh helper is ready.\n");
		return;
	}
	if (
		option !== "--turn" ||
		!/^[a-f0-9]{64}$/.test(token) ||
		extra.length > 0 ||
		(compactFlag !== undefined && (compactFlag !== "--compact" || operation !== "recall")) ||
		!["recall", "expand", "capture", "nothing-material", "receipt"].includes(operation)
	) {
		throw new PilotError(
			"Use doctor, or recall, expand, capture, receipt, or nothing-material with the active hook's --turn token.",
		);
	}
	const cwd = process.cwd();
	const target = checkout(cwd);
	if (!target) throw new PilotError("Run this inside the enrolled GitHub checkout.");
	const runtime = dirname(fileURLToPath(import.meta.url));
	const active =
		activeMemoryRuntime("claude-code", runtime) || activeMemoryRuntime("codex", runtime);
	const eligible = active && (await cachedMemoryCheckout(cwd, await readMemoryCredentials()));
	const result = await executeTurn(operation, token, {
		target: eligible ? { ...target, runtime } : target,
		store: turnStore(),
		read: () => readStdin(8_192),
		compact: compactFlag === "--compact" || process.env.PHARAOH_PROJECT_MEMORY_COMPACT === "true",
	});
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
	await main(process.argv.slice(2));
} catch (error) {
	const message =
		error instanceof PilotError
			? error.message
			: "Pharaoh project memory is temporarily unavailable.";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
