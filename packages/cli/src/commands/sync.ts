/**
 * Sync CLI commands — enable/disable/status/peers/connect.
 */

import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import {
	ensureDeviceIdentity,
	MemoryStore,
	readCodememConfigFile,
	resolveDbPath,
	schema,
	writeCodememConfigFile,
} from "@codemem/core";
import { Command } from "commander";
import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { helpStyle } from "../help-style.js";

interface SyncAttemptRow {
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

function parseAttemptsLimit(value: string): number {
	if (!/^\d+$/.test(value.trim())) {
		throw new Error(`Invalid --limit: ${value}`);
	}
	return Number.parseInt(value, 10);
}

interface SyncLifecycleOptions {
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
	scriptPath = process.argv[1],
	execArgv: string[] = process.execArgv,
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

async function runServeLifecycle(
	action: "start" | "stop" | "restart",
	opts: SyncLifecycleOptions,
): Promise<void> {
	if (opts.user === false || opts.system === true) {
		p.log.warn(
			"TS sync lifecycle currently manages the local viewer process, not separate user/system services.",
		);
	}
	if (action === "start") {
		const config = readCodememConfigFile();
		if (config.sync_enabled !== true) {
			p.log.error("Sync is disabled. Run `codemem sync enable` first.");
			process.exitCode = 1;
			return;
		}
		const configuredHost = typeof config.sync_host === "string" ? config.sync_host : "0.0.0.0";
		const configuredPort = typeof config.sync_port === "number" ? String(config.sync_port) : "7337";
		opts.host ??= configuredHost;
		opts.port ??= configuredPort;
	} else if (action === "restart") {
		const config = readCodememConfigFile();
		const configuredHost = typeof config.sync_host === "string" ? config.sync_host : "0.0.0.0";
		const configuredPort = typeof config.sync_port === "number" ? String(config.sync_port) : "7337";
		opts.host ??= configuredHost;
		opts.port ??= configuredPort;
	}
	const args = buildServeLifecycleArgs(action, opts);
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: process.cwd(),
			stdio: "inherit",
			env: {
				...process.env,
				...((opts.db ?? opts.dbPath) ? { CODEMEM_DB: opts.db ?? opts.dbPath } : {}),
			},
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code && code !== 0) {
				process.exitCode = code;
			}
			resolve();
		});
	});
}

export const syncCommand = new Command("sync")
	.configureHelp(helpStyle)
	.description("Sync configuration and peer management");

// codemem sync attempts
syncCommand.addCommand(
	new Command("attempts")
		.configureHelp(helpStyle)
		.description("Show recent sync attempts")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--limit <n>", "max attempts", "10")
		.option("--json", "output as JSON")
		.action((opts: { db?: string; dbPath?: string; limit: string; json?: boolean }) => {
			const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
			try {
				const d = drizzle(store.db, { schema });
				const limit = parseAttemptsLimit(opts.limit);
				const rows = d
					.select({
						peer_device_id: schema.syncAttempts.peer_device_id,
						ok: schema.syncAttempts.ok,
						ops_in: schema.syncAttempts.ops_in,
						ops_out: schema.syncAttempts.ops_out,
						error: schema.syncAttempts.error,
						finished_at: schema.syncAttempts.finished_at,
					})
					.from(schema.syncAttempts)
					.orderBy(desc(schema.syncAttempts.finished_at))
					.limit(limit)
					.all();

				if (opts.json) {
					console.log(JSON.stringify(rows, null, 2));
					return;
				}

				for (const row of rows) {
					console.log(formatSyncAttempt(row));
				}
			} finally {
				store.close();
			}
		}),
);

syncCommand.addCommand(
	new Command("start")
		.configureHelp(helpStyle)
		.description("Start sync daemon")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--host <host>", "viewer host")
		.option("--port <port>", "viewer port")
		.option("--user", "accepted for compatibility", true)
		.option("--system", "accepted for compatibility")
		.action(async (opts: SyncLifecycleOptions) => {
			await runServeLifecycle("start", opts);
		}),
);

syncCommand.addCommand(
	new Command("stop")
		.configureHelp(helpStyle)
		.description("Stop sync daemon")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--host <host>", "viewer host")
		.option("--port <port>", "viewer port")
		.option("--user", "accepted for compatibility", true)
		.option("--system", "accepted for compatibility")
		.action(async (opts: SyncLifecycleOptions) => {
			await runServeLifecycle("stop", opts);
		}),
);

syncCommand.addCommand(
	new Command("restart")
		.configureHelp(helpStyle)
		.description("Restart sync daemon")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--host <host>", "viewer host")
		.option("--port <port>", "viewer port")
		.option("--user", "accepted for compatibility", true)
		.option("--system", "accepted for compatibility")
		.action(async (opts: SyncLifecycleOptions) => {
			await runServeLifecycle("restart", opts);
		}),
);

// codemem sync status
syncCommand.addCommand(
	new Command("status")
		.configureHelp(helpStyle)
		.description("Show sync configuration and peer summary")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--json", "output as JSON")
		.action((opts: { db?: string; dbPath?: string; json?: boolean }) => {
			const config = readCodememConfigFile();
			const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
			try {
				const d = drizzle(store.db, { schema });
				const deviceRow = d
					.select({
						device_id: schema.syncDevice.device_id,
						fingerprint: schema.syncDevice.fingerprint,
					})
					.from(schema.syncDevice)
					.limit(1)
					.get();
				const peers = d
					.select({
						peer_device_id: schema.syncPeers.peer_device_id,
						name: schema.syncPeers.name,
						last_sync_at: schema.syncPeers.last_sync_at,
						last_error: schema.syncPeers.last_error,
					})
					.from(schema.syncPeers)
					.all();

				if (opts.json) {
					console.log(
						JSON.stringify(
							{
								enabled: config.sync_enabled === true,
								host: config.sync_host ?? "0.0.0.0",
								port: config.sync_port ?? 7337,
								interval_s: config.sync_interval_s ?? 120,
								device_id: deviceRow?.device_id ?? null,
								fingerprint: deviceRow?.fingerprint ?? null,
								coordinator_url: config.sync_coordinator_url ?? null,
								peers: peers.map((peer) => ({
									device_id: peer.peer_device_id,
									name: peer.name,
									last_sync: peer.last_sync_at,
									status: peer.last_error ?? "ok",
								})),
							},
							null,
							2,
						),
					);
					return;
				}

				p.intro("codemem sync status");
				p.log.info(
					[
						`Enabled:    ${config.sync_enabled === true ? "yes" : "no"}`,
						`Host:       ${config.sync_host ?? "0.0.0.0"}`,
						`Port:       ${config.sync_port ?? 7337}`,
						`Interval:   ${config.sync_interval_s ?? 120}s`,
						`Coordinator: ${config.sync_coordinator_url ?? "(not configured)"}`,
					].join("\n"),
				);
				if (deviceRow) {
					p.log.info(`Device ID:   ${deviceRow.device_id}\nFingerprint: ${deviceRow.fingerprint}`);
				} else {
					p.log.warn("Device identity not initialized (run `codemem sync enable`)");
				}
				if (peers.length === 0) {
					p.log.info("Peers: none");
				} else {
					for (const peer of peers) {
						const label = peer.name || peer.peer_device_id;
						p.log.message(
							`  ${label}: last_sync=${peer.last_sync_at ?? "never"}, status=${peer.last_error ?? "ok"}`,
						);
					}
				}
				p.outro(`${peers.length} peer(s)`);
			} finally {
				store.close();
			}
		}),
);

// codemem sync enable
syncCommand.addCommand(
	new Command("enable")
		.configureHelp(helpStyle)
		.description("Enable sync and initialize device identity")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--host <host>", "sync listen host")
		.option("--port <port>", "sync listen port")
		.option("--interval <seconds>", "sync interval in seconds")
		.action(
			(opts: { db?: string; dbPath?: string; host?: string; port?: string; interval?: string }) => {
				const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
				try {
					const [deviceId, fingerprint] = ensureDeviceIdentity(store.db);
					const config = readCodememConfigFile();
					config.sync_enabled = true;
					if (opts.host) config.sync_host = opts.host;
					if (opts.port) config.sync_port = Number.parseInt(opts.port, 10);
					if (opts.interval) config.sync_interval_s = Number.parseInt(opts.interval, 10);
					writeCodememConfigFile(config);

					p.intro("codemem sync enable");
					p.log.success(
						[
							`Device ID:   ${deviceId}`,
							`Fingerprint: ${fingerprint}`,
							`Host:        ${config.sync_host ?? "0.0.0.0"}`,
							`Port:        ${config.sync_port ?? 7337}`,
							`Interval:    ${config.sync_interval_s ?? 120}s`,
						].join("\n"),
					);
					p.outro("Sync enabled — restart `codemem serve` to activate");
				} finally {
					store.close();
				}
			},
		),
);

// codemem sync disable
syncCommand.addCommand(
	new Command("disable")
		.configureHelp(helpStyle)
		.description("Disable sync without deleting keys or peers")
		.action(() => {
			const config = readCodememConfigFile();
			config.sync_enabled = false;
			writeCodememConfigFile(config);
			p.intro("codemem sync disable");
			p.outro("Sync disabled — restart `codemem serve` to take effect");
		}),
);

// codemem sync peers
syncCommand.addCommand(
	new Command("peers")
		.configureHelp(helpStyle)
		.description("List known sync peers")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--json", "output as JSON")
		.action((opts: { db?: string; dbPath?: string; json?: boolean }) => {
			const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
			try {
				const d = drizzle(store.db, { schema });
				const peers = d
					.select({
						peer_device_id: schema.syncPeers.peer_device_id,
						name: schema.syncPeers.name,
						addresses: schema.syncPeers.addresses_json,
						last_sync_at: schema.syncPeers.last_sync_at,
						last_error: schema.syncPeers.last_error,
					})
					.from(schema.syncPeers)
					.orderBy(desc(schema.syncPeers.last_sync_at))
					.all();

				if (opts.json) {
					console.log(JSON.stringify(peers, null, 2));
					return;
				}

				p.intro("codemem sync peers");
				if (peers.length === 0) {
					p.outro("No peers configured");
					return;
				}
				for (const peer of peers) {
					const label = peer.name || peer.peer_device_id;
					const addrs = peer.addresses || "(no addresses)";
					p.log.message(
						`${label}\n  addresses: ${addrs}\n  last_sync: ${peer.last_sync_at ?? "never"}\n  status: ${peer.last_error ?? "ok"}`,
					);
				}
				p.outro(`${peers.length} peer(s)`);
			} finally {
				store.close();
			}
		}),
);

// codemem sync connect <coordinator-url>
syncCommand.addCommand(
	new Command("connect")
		.configureHelp(helpStyle)
		.description("Configure coordinator URL for cloud sync")
		.argument("<url>", "coordinator URL (e.g. https://coordinator.example.com)")
		.option("--group <group>", "sync group ID")
		.action((url: string, opts: { group?: string }) => {
			const config = readCodememConfigFile();
			config.sync_coordinator_url = url.trim();
			if (opts.group) config.sync_coordinator_group = opts.group.trim();
			writeCodememConfigFile(config);
			p.intro("codemem sync connect");
			p.log.success(`Coordinator: ${url.trim()}`);
			if (opts.group) p.log.info(`Group: ${opts.group.trim()}`);
			p.outro("Restart `codemem serve` to activate coordinator sync");
		}),
);
