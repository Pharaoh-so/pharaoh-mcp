/**
 * One-shot shell access to Pharaoh's six question tools. Uses the same proxy
 * dispatch as MCP clients without running interactive setup or installers.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadBundledCatalog } from "./catalog.js";
import { type Credentials, readCredentials } from "./credentials.js";
import { NPX_COMMAND, parseArgs, printLines } from "./helpers.js";
import { TenantSuspendedError, TokenExpiredError } from "./proxy.js";
import { createSseProxyServer } from "./proxy-server.js";
import { originBoundRefresh, type RefreshFailureAction } from "./refresh.js";
import { getPackageVersion } from "./version.js";

const CLI_TOOLS = [
	"get_codebase_map",
	"get_module_context",
	"search_functions",
	"get_blast_radius",
	"get_unused_code",
	"pharaoh_recon",
];
const CALL_TIMEOUT_MS = 5 * 60_000;
const SIGN_IN = `Pharaoh: not signed in. Run ${NPX_COMMAND} in a terminal to sign in.`;
// Wire code from src/mcp/plan-wall.ts; the npm proxy ships independently.
const PLAN_WALL_ERROR_CODE = "plan_wall:map_only";
const LEGACY_PLAN_WALL_PREFIX = "This needs Pro: ";
const EXIT = { answer: 0, failure: 1, usage: 2, signIn: 3, plan: 4 };

function authFailure(action: RefreshFailureAction = "reauth"): void {
	const needsSignIn = action === "reauth";
	printLines(needsSignIn ? SIGN_IN : "Pharaoh: could not refresh credentials. Try again.");
	process.exitCode = needsSignIn ? EXIT.signIn : EXIT.failure;
}

type Schema = {
	type?: string;
	description?: string;
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema;
};
class UsageError extends Error {}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new UsageError("Malformed JSON. Use <tool> --help for flags.");
	}
}

// Validate shapes, leaving enums, numeric ranges and other value rules to the server.
function validate(value: unknown, schema: Schema, name: string): void {
	if (schema.type === "object") {
		if (!object(value)) throw new UsageError(`Invalid ${name}: expected object.`);
		for (const key of schema.required ?? []) {
			if (value[key] === undefined) throw new UsageError(`Missing required ${name}.${key}.`);
		}
		for (const [key, item] of Object.entries(value)) {
			const property = schema.properties?.[key];
			if (!Object.hasOwn(schema.properties ?? {}, key) || !property)
				throw new UsageError(`Unknown argument ${name}.${key}.`);
			validate(item, property, `${name}.${key}`);
		}
		return;
	}
	if (schema.type === "array" && Array.isArray(value)) {
		for (const item of value) validate(item, schema.items ?? {}, name);
		return;
	}
	if (schema.type === "integer" ? Number.isSafeInteger(value) : typeof value === schema.type)
		return;
	throw new UsageError(`Invalid ${name}: expected ${schema.type}.`);
}

function parse(argv: string[], schema: Schema) {
	let base: Record<string, unknown> = {};
	const flags: Record<string, unknown> = {};
	let serverFlag: string | undefined;
	let asJson = false;
	for (let i = 1; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--json") {
			asJson = true;
			continue;
		}
		if (!flag.startsWith("--")) throw new UsageError(`Unexpected argument ${flag}.`);
		const name = flag.slice(2).replaceAll("-", "_");
		const property = Object.hasOwn(schema.properties ?? {}, name)
			? schema.properties?.[name]
			: undefined;
		if (!property && name !== "args" && name !== "server")
			throw new UsageError(`Unknown flag ${flag}. Use <tool> --help for flags.`);
		const next = argv[i + 1];
		if (property?.type === "boolean") {
			flags[name] = next !== "false";
			if (next === "true" || next === "false") i++;
			continue;
		}
		if (next === undefined || next.startsWith("--"))
			throw new UsageError(`Missing value for ${flag}.`);
		i++;
		if (name === "server") serverFlag = next;
		else if (name === "args") {
			const parsed = json(next);
			if (!object(parsed)) throw new UsageError("--args must be a JSON object.");
			base = parsed;
		} else if (property?.type === "array") {
			flags[name] =
				property.items?.type === "string"
					? [...((flags[name] as string[]) ?? []), next]
					: json(next);
		} else flags[name] = property?.type === "integer" ? Number(next) : next;
	}
	const args = { ...base, ...flags };
	validate(args, schema, "arguments");
	if (serverFlag !== undefined) {
		let url: URL;
		try {
			url = new URL(serverFlag);
		} catch {
			throw new UsageError("--server must be a valid HTTPS URL (HTTP allowed on loopback).");
		}
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
			throw new UsageError("--server requires HTTPS (HTTP allowed on loopback).");
	}
	const { server } = parseArgs(serverFlag === undefined ? [] : ["--server", serverFlag]);
	return { args, server, asJson };
}

function help(name: string, schema: Schema): void {
	const lines = [`Usage: ${NPX_COMMAND} ${name} --repo <name> [flags] [--json]`, "", "Flags:"];
	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		const value = property.type === "boolean" ? " [true|false]" : ` <${property.type}>`;
		const required = schema.required?.includes(key) ? " (required)" : "";
		lines.push(`  --${key.replaceAll("_", "-")}${value}${required}  ${property.description ?? ""}`);
	}
	lines.push(
		"  --args <json>   Argument object; explicit flags override it",
		"  --json          Full CallToolResult JSON (content contains text, not records)",
		"  --server <url>  Server URL (HTTPS, or HTTP on loopback)",
		"  --help          Show these flags (snake_case aliases are accepted)",
	);
	process.stdout.write(`${lines.join("\n")}\n`);
}

function maskOutput() {
	const secrets = new Set<string>();
	const remember = (creds: Credentials | null) => {
		if (creds?.access_token) secrets.add(creds.access_token);
		if (creds?.refresh_token) secrets.add(creds.refresh_token);
	};
	remember(readCredentials());
	const restore = [process.stdout, process.stderr].map((stream) => {
		const original = stream.write;
		stream.write = ((chunk, encoding, callback) => {
			let safe = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			for (const secret of secrets) safe = safe.replaceAll(secret, "[REDACTED]");
			return typeof encoding === "function"
				? original.call(stream, safe, encoding)
				: original.call(stream, safe, encoding, callback);
		}) as typeof stream.write;
		return () => {
			stream.write = original;
		};
	});
	return {
		remember,
		restore: () => {
			for (const restoreWrite of restore) restoreWrite();
		},
	};
}

async function call(creds: Credentials, name: string, args: Record<string, unknown>) {
	const proxy = createSseProxyServer(creds, CALL_TIMEOUT_MS);
	const client = new Client({ name: "pharaoh-cli", version: getPackageVersion() });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	try {
		await proxy.startWithTransport(serverTransport);
		await client.connect(clientTransport);
		return (await client.callTool({ name, arguments: args }, undefined, {
			timeout: CALL_TIMEOUT_MS,
		})) as CallToolResult;
	} finally {
		await client.close().finally(() => proxy.stop());
	}
}

function resultExitCode(name: string, result: CallToolResult): number {
	if (result.isError) return EXIT.failure;
	const { errorCode, guidance } = result._meta ?? {};
	if (errorCode === PLAN_WALL_ERROR_CODE) return EXIT.plan;
	if ((typeof errorCode === "string" && errorCode.length > 0) || guidance === true)
		return EXIT.failure;
	// Older servers expose the plan refusal only in the first text block.
	const firstText = result.content.find((block) => block.type === "text");
	return name !== "get_codebase_map" && firstText?.text.startsWith(LEGACY_PLAN_WALL_PREFIX)
		? EXIT.plan
		: EXIT.answer;
}

/**
 * Execute one question tool, printing its result and setting the shell exit code.
 * @param argv - Tool name followed by schema-derived flags and CLI options.
 * @returns When output is written and both MCP connections have been closed.
 */
export async function runCli(argv: string[]): Promise<void> {
	const mask = maskOutput();
	const onOutputError = (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") process.exit(EXIT.answer);
		printLines("Pharaoh: could not write the answer.");
		process.exitCode = EXIT.failure;
	};
	process.stdout.on("error", onOutputError);
	try {
		const name = argv[0];
		const tool = loadBundledCatalog().tools.find((tool) => tool.name === name);
		if (!CLI_TOOLS.includes(name) || !tool)
			throw new UsageError(`Unknown question tool. Choose: ${CLI_TOOLS.join(", ")}.`);
		const schema = tool.inputSchema as Schema;
		if (argv.includes("--help") || argv.includes("-h")) return help(name, schema);
		const { args, server, asJson } = parse(argv, schema);
		const credentials = originBoundRefresh(server);
		const auth = await credentials.load();
		if (!auth || !auth.ok) {
			return authFailure(auth ? auth.action : "reauth");
		}
		mask.remember(auth.creds);
		let result: CallToolResult;
		try {
			result = await call(auth.creds, name, args);
		} catch (error) {
			if (!(error instanceof TokenExpiredError)) throw error;
			const refreshed = await credentials.renew(auth.creds);
			if (!refreshed.ok) {
				return authFailure(refreshed.action);
			}
			mask.remember(refreshed.creds);
			try {
				result = await call(refreshed.creds, name, args);
			} catch (retryError) {
				if (!(retryError instanceof TokenExpiredError)) throw retryError;
				return authFailure();
			}
		}
		process.exitCode = resultExitCode(name, result);
		const output = asJson
			? JSON.stringify(result)
			: result.content
					.filter(
						(block) =>
							block.type === "text" &&
							!(
								block.annotations?.audience?.length === 1 &&
								block.annotations.audience[0] === "user"
							),
					)
					.map((block) => (block.type === "text" ? block.text : ""))
					.join("\n");
		await new Promise<void>((resolve, reject) => {
			process.stdout.write(`${output}\n`, (error) => (error ? reject(error) : resolve()));
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "EPIPE") {
			process.exitCode = EXIT.answer;
			return;
		}
		const showMessage =
			error instanceof UsageError ||
			error instanceof TenantSuspendedError ||
			process.env.PHARAOH_DEBUG === "1";
		printLines(
			`Pharaoh: ${showMessage && error instanceof Error ? error.message : "request failed. Set PHARAOH_DEBUG=1 for details."}`,
		);
		process.exitCode = error instanceof UsageError ? EXIT.usage : EXIT.failure;
	} finally {
		// Backend telemetry is fire-and-forget; mask late diagnostics until it drains.
		process.once("beforeExit", () => {
			mask.restore();
			process.stdout.off("error", onOutputError);
		});
	}
}
