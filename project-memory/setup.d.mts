export function syncMemoryHooks(options?: {
	credentials?: {
		sse_url: string;
		project_memory?: Array<{ repo: string; revision: string | null }>;
		project_memory_status?: "unavailable";
	};
	clients?: string[];
	home?: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	node?: string;
	removeLegacy?: boolean;
	packageRoot?: URL;
}): string[];
