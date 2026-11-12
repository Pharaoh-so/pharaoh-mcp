// Native hook payloads are client-defined JSON; the module validates every field it reads.
type HookInput = Record<string, unknown>;
type Request = (
	operation: string,
	payload: Record<string, unknown>,
	options?: Record<string, unknown>,
) => Promise<unknown>;
type CaptureOptions = {
	client: "claude-code" | "codex";
	target: { root: string; repo: string };
	directory: string;
	memorySession?: string;
	binding?: { client: string; sessionRef: string } | null;
	now?: number;
};

export const UNDO_COMMAND: string;
export const OFF_COMMAND: string;
export function captureDirectory(root: string): string;
export function checkCommand(
	command: unknown,
	prefix?: string,
): { command: string; piped: boolean } | undefined;
export function beginTurn(input: HookInput, options: CaptureOptions): void;
export function recordToolEvent(input: HookInput, options: CaptureOptions): string | undefined;
export function stopDecision(
	input: HookInput,
	options: CaptureOptions & { launch?: (path: string) => void },
): { decision?: "block"; reason?: string; systemMessage?: string } | undefined;
export function sendCapture(
	path: string,
	options?: { request?: Request; credentials?: Record<string, unknown>; now?: number },
): Promise<void>;
export function undoLastCapture(options?: {
	request?: Request;
	home?: string;
	/** The sign-in refresh module (dist/refresh.js) when run outside an installed bundle. */
	helper?: unknown;
}): Promise<{ undone: number; repo: string | undefined }>;
