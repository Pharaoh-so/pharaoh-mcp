/** The bundled, tenant-neutral renderer. Resource reads never touch a backend. */
import { readFileSync } from "node:fs";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	ErrorCode,
	ListResourcesRequestSchema,
	McpError,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TRACE_RESOURCE_URI = "ui://pharaoh/trace/v1.1.html";
export const TRACE_MIME_TYPE = "text/html;profile=mcp-app";

const resourceMeta = {
	ui: {
		prefersBorder: false,
		csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
		permissions: {},
	},
};
let html: string | undefined;

export function registerTraceResource(server: Server): void {
	server.registerCapabilities({ resources: {} });
	server.setRequestHandler(ListResourcesRequestSchema, async () => ({
		resources: [
			{
				name: "pharaoh-trace",
				title: "Pharaoh Trace",
				description: "Compact, expandable evidence from Pharaoh tool results.",
				uri: TRACE_RESOURCE_URI,
				mimeType: TRACE_MIME_TYPE,
				_meta: resourceMeta,
			},
		],
	}));
	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
		if (request.params.uri !== TRACE_RESOURCE_URI) {
			throw new McpError(ErrorCode.InvalidParams, "Unknown Trace resource");
		}
		// Package-root assets are shared by src/ and dist/. The request URI is
		// never used as a filesystem path or forwarded to the authenticated server.
		html ??= readFileSync(new URL("../trace-app.html", import.meta.url), "utf8");
		return {
			contents: [
				{ uri: TRACE_RESOURCE_URI, mimeType: TRACE_MIME_TYPE, text: html, _meta: resourceMeta },
			],
		};
	});
}
