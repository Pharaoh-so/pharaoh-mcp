/** Types for the stable launcher's helpers (launcher-v1.mjs). */
export declare const LAUNCHER_NAME: string;
export declare function newerVersion(candidate: unknown, current: unknown): boolean;
export declare function readPointer(root: string, name: string): Record<string, unknown> | null;
export declare function writePointer(
	root: string,
	name: string,
	value: Record<string, unknown>,
): void;
export declare function removePointer(root: string, name: string): void;
export declare function packageRoot(root: string, version: string): string;
export declare function usableVersion(root: string, version: unknown): string | null;
export declare function receiptDigest(root: string, version: string): string | null;
export declare function withActivateLock<T>(
	root: string,
	work: () => T | Promise<T>,
	options?: { waitMs?: number; now?: () => number },
): Promise<{ held: true; value: T } | { held: false }>;
export declare function withActivateLockSync<T>(
	root: string,
	work: () => T,
): { held: true; value: T } | { held: false };
export declare function logUpdate(root: string, entry: Record<string, unknown>): void;
export declare function activatePending(root: string): Promise<string | null>;
export declare function selectVersion(
	root: string,
	options?: { log?: boolean },
): { version: string; entry: string } | null;
