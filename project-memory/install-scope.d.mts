/** The private installation boundary shared by setup and bundled memory hooks. */
export type MemoryInstallScope = { kind: "global" } | { kind: "local"; root: string };
export function setMemoryInstallScope(scope?: MemoryInstallScope): void;
export function memoryInstallScope(): MemoryInstallScope | undefined;
export function memoryScopeKey(scope?: MemoryInstallScope): string | null;
export function memoryActivePath(root: string, scope?: MemoryInstallScope): string;
export function memorySettingsPath(
	client: string,
	home: string,
	env: NodeJS.ProcessEnv,
	scope?: MemoryInstallScope,
): string;
export function memoryScopeMatches(cwd: unknown, scope?: MemoryInstallScope): boolean;
/** Exclude untracked generated files locally, or throw before writing tracked or unsafe paths. */
export function ensureLocalPrivatePaths(
	scope: MemoryInstallScope | undefined,
	paths: string[],
): void;
