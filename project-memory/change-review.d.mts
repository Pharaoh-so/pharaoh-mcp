/** Native JSON is validated by the local review implementation. */
export type ReviewInput = Record<string, unknown>;
export type ReviewOptions = {
	client: "claude-code" | "codex";
	target: { root: string; repo: string };
	directory: string;
	home?: string;
	scope?: { kind: "local"; root: string };
	now?: number;
	proofPath?: string;
	deadline?: number;
	expectedServer?: "pharaoh";
	captureEnabled?: boolean;
};
export type ReviewManifest = {
	head: string;
	fingerprint: string;
	codeFingerprint: string;
	productionFingerprint: string;
	configFingerprint: string;
	files: string[];
	fileHashes: Array<[string, string | null]>;
	links: Record<string, { target: string; resolved: string }>;
	codeHashes: Array<[string, string | null]>;
};
export function changeReviewDirectory(root: string): string;
export function reviewPath(root: string, name: string): string;
export function reviewManifest(root: string, deadline?: number): ReviewManifest;
export function readReviewRun(directory: string, id: string): Record<string, unknown>;
export function writeReviewRun(directory: string, run: Record<string, unknown>): void;
export function cleanupReviewRuns(directory: string, now?: number): number;
export function beginReviewTurn(input: ReviewInput, options: ReviewOptions): string | undefined;
export function reviewTurnInput(input: ReviewInput, options: ReviewOptions): ReviewInput;
export function reviewStop(
	input: ReviewInput,
	options: ReviewOptions,
): { decision: "block"; reason: string } | undefined;
export function observeReviewTool(input: ReviewInput, options: ReviewOptions): void;
export function completionBoundary(
	input: ReviewInput,
	options: ReviewOptions,
): { previousReviewTurn: string | null } | undefined;
export function bindCompletionTurn(
	input: ReviewInput,
	options: ReviewOptions,
): { reviewTurn: string } | undefined;
export function takeReviewCaptureCheck(
	input: ReviewInput,
	options: ReviewOptions,
): { paths: string[]; check: string; evidence: string } | undefined;
export function consumeReviewReceipt(
	input: ReviewInput,
	options: ReviewOptions,
): { message: string } | undefined;
