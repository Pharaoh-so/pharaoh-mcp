/** Pure filesystem native feed primitives. */
export function feedHash(value: string): string;
export function feedRoot(options?: { home?: string; credentialsPath?: string }): string;
export function privateFeedPath(path: string, directory?: boolean): import("node:fs").Stats;
export function ensureFeedDirectory(path: string): string;
export function ensureFeedRoot(options?: { home?: string; credentialsPath?: string }): string;
export function readFeedJSON(path: string, limit?: number): unknown;
export function writeFeedJSON(
	directory: string,
	name: string,
	value: unknown,
	limit?: number,
): void;
export function removeFeedFile(path: string): void;
export function feedLock<T>(
	directory: string,
	operation: () => T,
	name?: string,
	now?: number,
): T | null;
