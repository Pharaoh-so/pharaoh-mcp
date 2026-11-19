export type RuntimeScope = { kind: "global" } | { kind: "local"; root: string };
export function runtimeScope(options?: { scope?: RuntimeScope }): RuntimeScope;
export function runtimeProfilePath(
	client: string,
	options?: { home?: string; env?: NodeJS.ProcessEnv },
): string;
export function runtimeProfileId(
	client: string,
	options?: { home?: string; env?: NodeJS.ProcessEnv },
): string | null;
export function runtimeTargetId(
	client: string,
	options?: { scope?: RuntimeScope; home?: string; env?: NodeJS.ProcessEnv },
): string;
export function runtimeScopeMatches(
	scope: RuntimeScope | undefined,
	options?: { cwd?: string; inputCwd?: string },
): boolean;
export function runtimeScopeArguments(scope?: RuntimeScope): string[];
export function runtimeScopeFromArguments(args: string[]): RuntimeScope | null;
