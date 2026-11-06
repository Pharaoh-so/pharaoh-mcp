/** A persistent, exact-version process launch written by the installer. */
export interface LaunchConfig {
	command: string;
	args: string[];
}

export type ClientId = "claude-code" | "codex" | "claude-desktop";

export type ClientInstallStatus =
	| "configured"
	| "already-configured"
	| "preserved-custom"
	| "preserved-disabled"
	| "unavailable"
	| "ambiguous"
	| "failed";

/** A registration result, distinct from a live connection or answered tool call. */
export interface ClientOutcome {
	client: ClientId;
	status: ClientInstallStatus;
	/** The guarded write created a user registration instead of replacing one. */
	created?: true;
	path?: string;
	detail?: string;
	recovery?: string;
}

/** A client for which local configuration or an installed executable was found. */
export interface ClientTarget {
	client: ClientId;
	path: string;
	cli?: string;
	unavailableReason?: string;
	ambiguousReason?: string;
	/** Desktop configuration can take precedence over the Code tab's user entry. */
	shadowPath?: string;
}

/** The exact legacy launch for which an operator may authorize migration. */
export interface LegacyMigration {
	client: ClientId;
	path: string;
	launch: LaunchConfig;
}

export interface ClientCommandOptions {
	env: NodeJS.ProcessEnv;
	timeout: number;
}

/** Inputs are injectable so fixtures never inspect or mutate real client settings. */
export interface ClientInstallOptions {
	home?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	execute?: (command: string, args: readonly string[], options: ClientCommandOptions) => string;
}
