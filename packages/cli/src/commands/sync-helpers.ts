import { resolveDbOpt } from "../shared-options.js";

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
	config?: string;
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
	const dbResolved = resolveDbOpt(opts);
	if (dbResolved) args.push("--db-path", dbResolved);
	if (opts.config) args.push("--config", opts.config);
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

export function parseProjectList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

type InterfaceMap = Record<
	string,
	Array<{ address: string; family?: string | number; internal?: boolean }> | undefined
>;

export function collectAdvertiseAddresses(
	explicitAddress: string | null,
	configuredHost: string | null,
	port: number,
	interfaces: InterfaceMap,
): string[] {
	if (explicitAddress && !["auto", "default"].includes(explicitAddress.toLowerCase())) {
		return [explicitAddress];
	}
	if (configuredHost && configuredHost !== "0.0.0.0") {
		return [`${configuredHost}:${port}`];
	}
	const addresses = Object.values(interfaces)
		.flatMap((entries) => entries ?? [])
		.filter((entry) => !entry.internal)
		.map((entry) => entry.address)
		.filter((address) => address && address !== "127.0.0.1" && address !== "::1")
		.map((address) => `${address}:${port}`);
	return [...new Set(addresses)];
}
