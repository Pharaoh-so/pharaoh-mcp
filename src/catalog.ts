/**
 * Pharaoh's agent-facing surface as bundled into this package at build time:
 * the server instructions and the tool catalog in inspect-tools.json, written by
 * the main repo's scripts/generate-inspect-schemas.ts from the same code the
 * production server runs.
 *
 * The proxy answers Claude Code's `initialize` and first `tools/list` before it
 * has reached (or signed in to) mcp.pharaoh.so, and the client reads instructions
 * only once, at connect. So it serves this copy rather than a stub. See VISION.md
 * § Every connection path delivers the same instructions and tool metadata.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Instructions and tools exactly as the Pharaoh server sends them. */
export interface BundledCatalog {
	/** Server instructions (getInstructions() in the main repo). */
	instructions: string;
	/** Every tool the server lists, with descriptions, schemas and `_meta`. */
	tools: Tool[];
}

let cached: BundledCatalog | null = null;

/**
 * Load the bundled instructions and tool catalog (read once per process).
 *
 * @returns The catalog shipped in this package's inspect-tools.json.
 * @throws If the file is missing or lacks instructions or tools — a packaging bug.
 */
export function loadBundledCatalog(): BundledCatalog {
	if (cached) return cached;
	// Resolved from the module URL: the package supports Node 18, before the dirname shortcut.
	const path = join(dirname(fileURLToPath(import.meta.url)), "..", "inspect-tools.json");
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<BundledCatalog>;
	if (typeof parsed.instructions !== "string" || !Array.isArray(parsed.tools)) {
		throw new Error(`${path} has no instructions or tools — rebuild the package`);
	}
	cached = { instructions: parsed.instructions, tools: parsed.tools };
	return cached;
}
