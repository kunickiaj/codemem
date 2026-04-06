export type ServeMode = "start" | "stop" | "restart";

export type ServeAction = ServeMode | undefined;

export interface LegacyServeOptions {
	db?: string;
	dbPath?: string;
	config?: string;
	host: string;
	port: string;
	background?: boolean;
	foreground?: boolean;
	stop?: boolean;
	restart?: boolean;
}

export interface StartServeOptions {
	db?: string;
	dbPath?: string;
	config?: string;
	host: string;
	port: string;
	foreground?: boolean;
}

export interface StopRestartServeOptions {
	db?: string;
	dbPath?: string;
	config?: string;
	host: string;
	port: string;
}

export interface ResolvedServeInvocation {
	mode: ServeMode;
	dbPath: string | null;
	configPath: string | null;
	host: string;
	port: number;
	background: boolean;
}

function parsePort(rawPort: string): number {
	const port = Number.parseInt(rawPort, 10);
	if (!Number.isFinite(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid port: ${rawPort}`);
	}
	return port;
}

export function resolveLegacyServeInvocation(opts: LegacyServeOptions): ResolvedServeInvocation {
	if (opts.stop && opts.restart) {
		throw new Error("Use only one of --stop or --restart");
	}
	if (opts.foreground && opts.background) {
		throw new Error("Use only one of --background or --foreground");
	}
	const dbPath = opts.db ?? opts.dbPath ?? null;
	return {
		mode: opts.stop ? "stop" : opts.restart ? "restart" : "start",
		dbPath,
		configPath: opts.config ?? null,
		host: opts.host,
		port: parsePort(opts.port),
		background: opts.restart ? true : opts.background ? true : false,
	};
}

export function resolveServeInvocation(
	action: ServeAction,
	opts: LegacyServeOptions,
): ResolvedServeInvocation {
	if (action === undefined) {
		return resolveLegacyServeInvocation(opts);
	}
	if (opts.stop || opts.restart) {
		throw new Error("Do not combine lifecycle flags with a serve action");
	}
	if (action === "start") {
		return resolveStartServeInvocation(opts);
	}
	return resolveStopRestartInvocation(action, opts);
}

export function resolveStartServeInvocation(opts: StartServeOptions): ResolvedServeInvocation {
	const dbPath = opts.db ?? opts.dbPath ?? null;
	return {
		mode: "start",
		dbPath,
		configPath: opts.config ?? null,
		host: opts.host,
		port: parsePort(opts.port),
		background: !opts.foreground,
	};
}

export function resolveStopRestartInvocation(
	mode: "stop" | "restart",
	opts: StopRestartServeOptions,
): ResolvedServeInvocation {
	const dbPath = opts.db ?? opts.dbPath ?? null;
	return {
		mode,
		dbPath,
		configPath: opts.config ?? null,
		host: opts.host,
		port: parsePort(opts.port),
		background: mode === "restart",
	};
}
