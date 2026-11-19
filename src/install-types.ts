/** A persistent, exact-version process launch written by the installer. */
export interface LaunchConfig {
	command: string;
	args: string[];
}

export type ClientId = "claude-code" | "codex" | "claude-desktop";

/** The client activation boundary; shared credentials and binaries are independent of it. */
export type InstallScope = { kind: "global" } | { kind: "local"; root: string };

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
	/** Verified managed native feed setup, absent for custom, disabled, or unsupported clients. */
	nativeFeed?: { registration: string; home: string; settingsPath: string; serverArgv: string[] };
	client: ClientId;
	status: ClientInstallStatus;
	/** The guarded write created a user registration instead of replacing one. */
	created?: true;
	path?: string;
	detail?: string;
	recovery?: string;
	/** Claude Desktop was open when its registration changed: it may save its earlier settings back. */
	desktopOpen?: true;
}

/** A client for which local configuration or an installed executable was found. */
export interface ClientTarget {
	client: ClientId;
	path: string;
	cli?: string;
	/** Semver observed from the installed CLI, used for project-hook capability gates. */
	version?: string;
	unavailableReason?: string;
	ambiguousReason?: string;
	/** Desktop configuration can take precedence over the Code tab's user entry. */
	shadowPath?: string;
	/** The checkout whose project configuration owns this registration. Omitted means Global. */
	scope?: InstallScope;
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
	/** The project in which a read-only client capability check runs. */
	cwd?: string;
}

/** Inputs are injectable so fixtures never inspect or mutate real client settings. */
export interface ClientInstallOptions {
	/** Add the ordinary managed native context registration to supported coding clients. */
	nativeFeed?: boolean;
	home?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** Omitted retains the historical Global installation. */
	scope?: InstallScope;
	/** Limit a scoped cleanup to one supported client. */
	client?: ClientId;
	execute?: (command: string, args: readonly string[], options: ClientCommandOptions) => string;
}
