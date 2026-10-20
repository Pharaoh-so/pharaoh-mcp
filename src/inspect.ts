/**
 * Inspect mode — serves Pharaoh's instructions and tool schemas over stdio for
 * Glama inspection.
 *
 * Serves the bundled catalog (catalog.ts — inspect-tools.json, generated at build
 * time by the main repo's `generate-inspect-schemas.ts`) verbatim: the same
 * instructions, descriptions, schemas, annotations and `_meta` the production
 * server sends. Any tool call returns a "connect to mcp.pharaoh.so" message.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type BundledCatalog, loadBundledCatalog } from "./catalog.js";
import { registerTraceResource } from "./trace-resource.js";
import { getPackageVersion } from "./version.js";

const INSPECT_MSG =
	"This is Pharaoh's inspection server for directory listings. " +
	"Connect to https://mcp.pharaoh.so for actual usage.";

/** Run the inspect server on stdio until the client disconnects. */
export async function runInspect(): Promise<void> {
	let catalog: BundledCatalog;
	try {
		catalog = loadBundledCatalog();
	} catch (err) {
		process.stderr.write(`Pharaoh: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}

	const server = new Server(
		{ name: "pharaoh", version: getPackageVersion() },
		{ capabilities: { tools: {} }, instructions: catalog.instructions },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.tools }));
	server.setRequestHandler(CallToolRequestSchema, async () => ({
		content: [{ type: "text" as const, text: INSPECT_MSG }],
	}));
	registerTraceResource(server);

	await server.connect(new StdioServerTransport());
}
