import type { Stats } from "node:fs";

/** Validate a regular path and its owner-only mode or ACL. */
export function privatePath(path: string, directory?: boolean): Stats;

/** Create one owner-private directory or validate an existing one. */
export function ensurePrivateDirectory(path: string): void;

/** Register the reader from the exact pinned Windows analyzer. */
export function setWindowsPrivatePathHelper(reader: string): void;
