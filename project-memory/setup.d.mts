export function syncMemoryHooks(options?: {
	credentials?: {
		sse_url: string;
		project_memory?: Array<{ repo: string; revision: string | null }>;
		project_memory_status?: "unavailable";
	};
	clients?: string[];
	enable?: boolean;
	home?: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	node?: string;
	packageRoot?: URL;
}): string[];
