import type { MemoryInstallScope } from "./install-scope.mjs";

type MemoryCredentials = {
	sse_url: string;
	access_token?: string;
	expires_at?: string;
	project_memory?: Array<{ repo: string; revision: string | null }>;
	project_memory_status?: "unavailable";
	/** Set by a completed hint check; without it, no hint means "not checked yet". */
	project_memory_checked_at?: string;
};

type MemoryHookChoices = {
	accepted: string[];
	declined: string[];
	graphClients: string[];
	/** Clients whose selected installation may retain or enable diagnostic hooks. */
	diagnosticClients?: string[];
	notices: string[];
	removeUnentitled?: boolean;
};

type MemoryHookSetup = {
	credentials?: MemoryCredentials;
	home?: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	node?: string;
	packageRoot?: URL;
	scope?: MemoryInstallScope;
};

export function chooseMemoryHooks(options: {
	credentials?: MemoryCredentials;
	clients: string[];
	requested?: boolean;
	ask: (question: string, defaultAnswer: boolean) => Promise<boolean | null>;
	home?: string;
	env?: NodeJS.ProcessEnv;
	scope?: MemoryInstallScope;
}): Promise<MemoryHookChoices>;

export function applyMemoryHookChoices(
	decision: MemoryHookChoices,
	options?: MemoryHookSetup,
): string[];

export function syncMemoryHooks(
	options?: MemoryHookSetup & {
		clients?: string[];
		graphClients?: string[];
		diagnosticClients?: string[];
		enable?: boolean;
		/** Preserve handler removals while toggling only the change-review feature. */
		preserveHandlers?: boolean;
	},
): string[];

export function ensureMemoryHooks(
	info: { name?: string; version?: string } | undefined,
	credentials: MemoryCredentials | null | undefined,
	options?: MemoryHookSetup,
): string[];

/** Enable or disable the selected existing Claude installation's automatic change review. */
export function configureChangeReview(enabled: boolean, options?: MemoryHookSetup): string[];
