export interface SyncAttemptRow {
	peer_device_id: string;
	ok: number;
	ops_in: number;
	ops_out: number;
	error: string | null;
	finished_at: string | null;
}

export function formatSyncAttempt(row: SyncAttemptRow): string {
	const status = row.ok ? "ok" : "error";
	const error = String(row.error || "");
	const suffix = error ? ` | ${error}` : "";
	return `${row.peer_device_id}|${status}|in=${row.ops_in}|out=${row.ops_out}|${row.finished_at ?? ""}${suffix}`;
}

export interface SyncLifecycleOptions {
	db?: string;
	dbPath?: string;
	host?: string;
	port?: string;
	user?: boolean;
	system?: boolean;
}

export function buildServeLifecycleArgs(
	action: "start" | "stop" | "restart",
	opts: SyncLifecycleOptions,
	scriptPath: string,
	execArgv: string[] = [],
): string[] {
	if (!scriptPath) throw new Error("Unable to resolve CLI entrypoint for sync lifecycle command");
	const args = [...execArgv, scriptPath, "serve"];
	if (action === "start") {
		args.push("--restart");
	} else if (action === "stop") {
		args.push("--stop");
	} else {
		args.push("--restart");
	}
	if (opts.db ?? opts.dbPath) args.push("--db-path", opts.db ?? opts.dbPath ?? "");
	if (opts.host) args.push("--host", opts.host);
	if (opts.port) args.push("--port", opts.port);
	return args;
}

export function formatSyncOnceResult(
	peerDeviceId: string,
	result: { ok: boolean; error?: string },
): string {
	if (result.ok) return `- ${peerDeviceId}: ok`;
	const suffix = result.error ? `: ${result.error}` : "";
	return `- ${peerDeviceId}: error${suffix}`;
}
