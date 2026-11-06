/** Finite local metadata helpers; model recognition never grants calibration. */
import type { RuntimeExplorationMetadata } from "./runtime-contract.mjs";
export function normalizeNativeMetadata(
	model: unknown,
): Pick<RuntimeExplorationMetadata, "modelId" | "modelState" | "modelFamily">;
export function nativeRegistration(
	client: string,
	clientBuild: string,
	proxyBuild: string,
	now: number,
	metadataVersion?: 1 | 2,
): {
	id: string;
	hooks: string[];
	capability: RuntimeExplorationMetadata["capability"];
	clientBuild: string;
	proxyBuild: string;
	buildObservedAt: string;
};
