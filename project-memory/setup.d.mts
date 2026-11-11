type MemoryCredentials = {
	sse_url: string;
	project_memory?: Array<{ repo: string; revision: string | null }>;
	project_memory_status?: "unavailable";
	/** Set by a completed hint check; without it, no hint means "not checked yet". */
	project_memory_checked_at?: string;
};

type MemoryHookChoices = {
	accepted: string[];
	declined: string[];
	graphClients: string[];
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
};

export function chooseMemoryHooks(options: {
	credentials?: MemoryCredentials;
	clients: string[];
	requested?: boolean;
	ask: (question: string, defaultAnswer: boolean) => Promise<boolean | null>;
	home?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<MemoryHookChoices>;

export function applyMemoryHookChoices(
	decision: MemoryHookChoices,
	options?: MemoryHookSetup,
): string[];

export function syncMemoryHooks(
	options?: MemoryHookSetup & { clients?: string[]; graphClients?: string[]; enable?: boolean },
): string[];

export function ensureMemoryHooks(
	info: { name?: string; version?: string } | undefined,
	credentials: MemoryCredentials | null | undefined,
	options?: MemoryHookSetup,
): string[];
