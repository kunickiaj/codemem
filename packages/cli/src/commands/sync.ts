/**
 * Sync CLI commands — enable/disable/status/peers/connect.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

import * as p from "@clack/prompts";
import {
	coordinatorCreateGroupAction,
	coordinatorCreateInviteAction,
	coordinatorDisableDeviceAction,
	coordinatorEnrollDeviceAction,
	coordinatorImportInviteAction,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	coordinatorListJoinRequestsAction,
	coordinatorRemoveDeviceAction,
	coordinatorRenameDeviceAction,
	coordinatorReviewJoinRequestAction,
	createBetterSqliteCoordinatorApp,
	DEFAULT_COORDINATOR_DB_PATH,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	loadPublicKey,
	MemoryStore,
	readCodememConfigFile,
	resolveDbPath,
	runSyncPass,
	schema,
	setPeerProjectFilter,
	syncPassPreflight,
	updatePeerAddresses,
	writeCodememConfigFile,
} from "@codemem/core";
import { serve as honoServe } from "@hono/node-server";
import { Command } from "commander";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { helpStyle } from "../help-style.js";
import {
	buildServeLifecycleArgs,
	collectAdvertiseAddresses,
	formatSyncAttempt,
	formatSyncOnceResult,
	parseProjectList,
	type SyncLifecycleOptions,
} from "./sync-helpers.js";

function parseAttemptsLimit(value: string): number {
	if (!/^\d+$/.test(value.trim())) {
		throw new Error(`Invalid --limit: ${value}`);
	}
	return Number.parseInt(value, 10);
}

interface SyncOnceOptions {
	db?: string;
	dbPath?: string;
	peer?: string;
}

interface SyncPairOptions {
	accept?: string;
	acceptFile?: string;
	payloadOnly?: boolean;
	name?: string;
	address?: string;
	include?: string;
	exclude?: string;
	all?: boolean;
	default?: boolean;
	dbPath?: string;
}

function resolvePeerMatch(
	db: ReturnType<typeof drizzle>,
	peerRef: string,
): { peer_device_id: string; name: string | null } | null | "ambiguous" {
	const trimmed = peerRef.trim();
	if (!trimmed) return null;
	const byId = db
		.select({ peer_device_id: schema.syncPeers.peer_device_id, name: schema.syncPeers.name })
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, trimmed))
		.get();
	if (byId) return byId;
	const byName = db
		.select({ peer_device_id: schema.syncPeers.peer_device_id, name: schema.syncPeers.name })
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.name, trimmed))
		.all();
	if (byName.length > 1) return "ambiguous";
	return byName[0] ?? null;
}

function readCoordinatorPublicKey(opts: { publicKey?: string; publicKeyFile?: string }): string {
	const inline = String(opts.publicKey ?? "").trim();
	const filePath = String(opts.publicKeyFile ?? "").trim();
	if (inline && filePath) throw new Error("Use only one of --public-key or --public-key-file");
	if (filePath) {
		const text = readFileSync(filePath, "utf8").trim();
		if (!text) throw new Error(`Public key file is empty: ${filePath}`);
		return text;
	}
	if (!inline) throw new Error("Public key required via --public-key or --public-key-file");
	return inline;
}

async function portOpen(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port });
		const done = (ok: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(300);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

function readViewerBinding(dbPath: string): { host: string; port: number } | null {
	try {
		const raw = readFileSync(join(dirname(dbPath), "viewer.pid"), "utf8");
		const parsed = JSON.parse(raw) as Partial<{ host: string; port: number }>;
		if (typeof parsed.host === "string" && typeof parsed.port === "number") {
			return { host: parsed.host, port: parsed.port };
		}
	} catch {
		// ignore malformed or missing pidfile
	}
	return null;
}

function parseStoredAddressEndpoint(value: string): { host: string; port: number } | null {
	try {
		const normalized = value.includes("://") ? value : `http://${value}`;
		const url = new URL(normalized);
		const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
		if (!url.hostname || !Number.isFinite(port)) return null;
		return { host: url.hostname, port };
	} catch {
		return null;
	}
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
		// Don't pass sync_host/sync_port as viewer bind values.
		// The viewer binds its own host/port (default 127.0.0.1:38888)
		// and the sync protocol listener reads sync_host/sync_port
		// internally from readCoordinatorSyncConfig().
	}
	const args = buildServeLifecycleArgs(action, opts, process.argv[1] ?? "", process.execArgv);
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
		child.once("exit", (code: number | null) => {
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

syncCommand.addCommand(
	new Command("once")
		.configureHelp(helpStyle)
		.description("Run a single sync pass")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--peer <peer>", "peer device id or name")
		.action(async (opts: SyncOnceOptions) => {
			const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
			try {
				syncPassPreflight(store.db);
				const d = drizzle(store.db, { schema });
				const rows = opts.peer
					? (() => {
							const deviceMatches = d
								.select({ peer_device_id: schema.syncPeers.peer_device_id })
								.from(schema.syncPeers)
								.where(eq(schema.syncPeers.peer_device_id, opts.peer))
								.all();
							if (deviceMatches.length > 0) return deviceMatches;
							const nameMatches = d
								.select({ peer_device_id: schema.syncPeers.peer_device_id })
								.from(schema.syncPeers)
								.where(eq(schema.syncPeers.name, opts.peer))
								.all();
							if (nameMatches.length > 1) {
								p.log.error(`Peer name is ambiguous: ${opts.peer}`);
								process.exitCode = 1;
								return [];
							}
							return nameMatches;
						})()
					: d
							.select({ peer_device_id: schema.syncPeers.peer_device_id })
							.from(schema.syncPeers)
							.all();

				if (rows.length === 0) {
					p.log.warn("No peers available for sync");
					process.exitCode = 1;
					return;
				}

				let hadFailure = false;
				for (const row of rows) {
					const result = await runSyncPass(store.db, row.peer_device_id);
					if (!result.ok) hadFailure = true;
					console.log(formatSyncOnceResult(row.peer_device_id, result));
				}
				if (hadFailure) {
					process.exitCode = 1;
				}
			} finally {
				store.close();
			}
		}),
);

syncCommand.addCommand(
	new Command("pair")
		.configureHelp(helpStyle)
		.description("Print pairing payload or accept a peer payload")
		.option("--accept <json>", "accept pairing payload JSON from another device")
		.option("--accept-file <path>", "accept pairing payload from file path, or '-' for stdin")
		.option("--payload-only", "when generating pairing payload, print JSON only")
		.option("--name <name>", "label for the peer")
		.option("--address <host:port>", "override peer address (host:port)")
		.option("--include <projects>", "outbound-only allowlist for accepted peer")
		.option("--exclude <projects>", "outbound-only blocklist for accepted peer")
		.option("--all", "with --accept, push all projects to that peer")
		.option("--default", "with --accept, use default/global push filters")
		.option("--db-path <path>", "database path")
		.action(async (opts: SyncPairOptions) => {
			const store = new MemoryStore(resolveDbPath(opts.dbPath));
			try {
				const acceptModeRequested = opts.accept != null || opts.acceptFile != null;
				if (opts.payloadOnly && acceptModeRequested) {
					p.log.error("--payload-only cannot be combined with --accept or --accept-file");
					process.exitCode = 1;
					return;
				}
				if (opts.accept && opts.acceptFile) {
					p.log.error("Use only one of --accept or --accept-file");
					process.exitCode = 1;
					return;
				}

				let acceptText = opts.accept;
				if (opts.acceptFile) {
					try {
						acceptText =
							opts.acceptFile === "-"
								? await new Promise<string>((resolve, reject) => {
										let text = "";
										process.stdin.setEncoding("utf8");
										process.stdin.on("data", (chunk) => {
											text += chunk;
										});
										process.stdin.on("end", () => resolve(text));
										process.stdin.on("error", reject);
									})
								: readFileSync(opts.acceptFile, "utf8");
					} catch (error) {
						p.log.error(
							error instanceof Error
								? `Failed to read pairing payload from ${opts.acceptFile}: ${error.message}`
								: `Failed to read pairing payload from ${opts.acceptFile}`,
						);
						process.exitCode = 1;
						return;
					}
				}

				if (acceptModeRequested && !(acceptText ?? "").trim()) {
					p.log.error("Empty pairing payload; provide JSON via --accept or --accept-file");
					process.exitCode = 1;
					return;
				}

				if (!acceptText && (opts.include || opts.exclude || opts.all || opts.default)) {
					p.log.error(
						"Project filters are outbound-only and must be set on the device running --accept",
					);
					process.exitCode = 1;
					return;
				}

				if (acceptText?.trim()) {
					if (opts.all && opts.default) {
						p.log.error("Use only one of --all or --default");
						process.exitCode = 1;
						return;
					}
					if ((opts.all || opts.default) && (opts.include || opts.exclude)) {
						p.log.error("--include/--exclude cannot be combined with --all/--default");
						process.exitCode = 1;
						return;
					}

					let payload: Record<string, unknown>;
					try {
						payload = JSON.parse(acceptText) as Record<string, unknown>;
					} catch (error) {
						p.log.error(
							error instanceof Error
								? `Invalid pairing payload: ${error.message}`
								: "Invalid pairing payload",
						);
						process.exitCode = 1;
						return;
					}

					const deviceId = String(payload.device_id || "").trim();
					const fingerprint = String(payload.fingerprint || "").trim();
					const publicKey = String(payload.public_key || "").trim();
					const resolvedAddresses = opts.address?.trim()
						? [opts.address.trim()]
						: Array.isArray(payload.addresses)
							? (payload.addresses as unknown[])
									.filter(
										(item): item is string => typeof item === "string" && item.trim().length > 0,
									)
									.map((item) => item.trim())
							: [];
					if (!deviceId || !fingerprint || !publicKey || resolvedAddresses.length === 0) {
						p.log.error("Pairing payload missing device_id, fingerprint, public_key, or addresses");
						process.exitCode = 1;
						return;
					}
					if (fingerprintPublicKey(publicKey) !== fingerprint) {
						p.log.error("Pairing payload fingerprint mismatch");
						process.exitCode = 1;
						return;
					}

					updatePeerAddresses(store.db, deviceId, resolvedAddresses, {
						name: opts.name,
						pinnedFingerprint: fingerprint,
						publicKey,
					});

					if (opts.default) {
						setPeerProjectFilter(store.db, deviceId, { include: null, exclude: null });
					} else if (opts.all || opts.include || opts.exclude) {
						setPeerProjectFilter(store.db, deviceId, {
							include: opts.all ? [] : parseProjectList(opts.include),
							exclude: opts.all ? [] : parseProjectList(opts.exclude),
						});
					}

					p.log.success(`Paired with ${deviceId}`);
					return;
				}

				const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
				const [deviceId, fingerprint] = ensureDeviceIdentity(store.db, { keysDir });
				const publicKey = loadPublicKey(keysDir);
				if (!publicKey) {
					p.log.error("Public key missing");
					process.exitCode = 1;
					return;
				}

				const config = readCodememConfigFile();
				const explicitAddress = opts.address?.trim();
				const configuredHost = typeof config.sync_host === "string" ? config.sync_host : null;
				const configuredPort = typeof config.sync_port === "number" ? config.sync_port : 7337;
				const addresses = collectAdvertiseAddresses(
					explicitAddress ?? null,
					configuredHost,
					configuredPort,
					networkInterfaces(),
				);
				const payload = {
					device_id: deviceId,
					fingerprint,
					public_key: publicKey,
					address: addresses[0] ?? "",
					addresses,
				};
				const payloadText = JSON.stringify(payload);

				if (opts.payloadOnly) {
					process.stdout.write(`${payloadText}\n`);
					return;
				}

				const escaped = payloadText.replaceAll("'", "'\\''");
				console.log("Pairing payload");
				console.log(payloadText);
				console.log("On the other device, save this JSON to pairing.json, then run:");
				console.log("  codemem sync pair --accept-file pairing.json");
				console.log("If you prefer inline JSON, run:");
				console.log(`  codemem sync pair --accept '${escaped}'`);
				console.log("For machine-friendly output next time, run:");
				console.log("  codemem sync pair --payload-only");
				console.log(
					"On the accepting device, --include/--exclude control both what it sends and what it accepts from that peer.",
				);
			} finally {
				store.close();
			}
		}),
);

syncCommand.addCommand(
	new Command("doctor")
		.configureHelp(helpStyle)
		.description("Diagnose common sync setup and connectivity issues")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.action(async (opts: { db?: string; dbPath?: string }) => {
			const config = readCodememConfigFile();
			const dbPath = resolveDbPath(opts.db ?? opts.dbPath);
			const store = new MemoryStore(dbPath);
			try {
				const d = drizzle(store.db, { schema });
				const device = d
					.select({ device_id: schema.syncDevice.device_id })
					.from(schema.syncDevice)
					.limit(1)
					.get();
				const daemonState = d
					.select()
					.from(schema.syncDaemonState)
					.where(eq(schema.syncDaemonState.id, 1))
					.get();
				const peers = d
					.select({
						peer_device_id: schema.syncPeers.peer_device_id,
						addresses_json: schema.syncPeers.addresses_json,
						pinned_fingerprint: schema.syncPeers.pinned_fingerprint,
						public_key: schema.syncPeers.public_key,
					})
					.from(schema.syncPeers)
					.all();

				const issues: string[] = [];
				const syncHost = typeof config.sync_host === "string" ? config.sync_host : "0.0.0.0";
				const syncPort = typeof config.sync_port === "number" ? config.sync_port : 7337;
				const viewerBinding = readViewerBinding(dbPath);

				console.log("Sync doctor");
				console.log(`- Enabled: ${config.sync_enabled === true}`);
				console.log(`- Listen: ${syncHost}:${syncPort}`);
				console.log(`- mDNS: ${process.env.CODEMEM_SYNC_MDNS ? "env-configured" : "default/off"}`);

				const reachable = viewerBinding
					? await portOpen(viewerBinding.host, viewerBinding.port)
					: false;
				console.log(`- Daemon: ${reachable ? "running" : "not running"}`);
				if (!reachable) issues.push("daemon not running");

				if (!device) {
					console.log("- Identity: missing (run `codemem sync enable`)");
					issues.push("identity missing");
				} else {
					console.log(`- Identity: ${device.device_id}`);
				}

				if (
					daemonState?.last_error &&
					(!daemonState.last_ok_at || daemonState.last_ok_at < (daemonState.last_error_at ?? ""))
				) {
					console.log(
						`- Daemon error: ${daemonState.last_error} (at ${daemonState.last_error_at ?? "unknown"})`,
					);
					issues.push("daemon error");
				}

				if (peers.length === 0) {
					console.log("- Peers: none (pair a device first)");
					issues.push("no peers");
				} else {
					console.log(`- Peers: ${peers.length}`);
					for (const peer of peers) {
						const addresses = peer.addresses_json
							? (JSON.parse(peer.addresses_json) as string[])
							: [];
						const endpoint = parseStoredAddressEndpoint(addresses[0] ?? "");
						const reach = endpoint
							? (await portOpen(endpoint.host, endpoint.port))
								? "ok"
								: "unreachable"
							: "unknown";
						const pinned = Boolean(peer.pinned_fingerprint);
						const hasKey = Boolean(peer.public_key);
						console.log(
							`  - ${peer.peer_device_id}: addresses=${addresses.length} reach=${reach} pinned=${pinned} public_key=${hasKey}`,
						);
						if (reach !== "ok") issues.push(`peer ${peer.peer_device_id} unreachable`);
						if (!pinned || !hasKey) issues.push(`peer ${peer.peer_device_id} not pinned`);
					}
				}

				if (!config.sync_enabled) issues.push("sync is disabled");

				if (issues.length > 0) {
					console.log(`WARN: ${[...new Set(issues)].slice(0, 3).join(", ")}`);
				} else {
					console.log("OK: sync looks healthy");
				}
			} finally {
				store.close();
			}
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
const peersCommand = new Command("peers")
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
	});

peersCommand.addCommand(
	new Command("remove")
		.configureHelp(helpStyle)
		.description("Remove a sync peer by device id or exact name")
		.argument("<peer>", "peer device id or exact name")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--json", "output as JSON")
		.action((peerRef: string, opts: { db?: string; dbPath?: string; json?: boolean }) => {
			const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
			try {
				const d = drizzle(store.db, { schema });
				const match = resolvePeerMatch(d, peerRef);
				if (match === "ambiguous") {
					p.log.error(`Peer name is ambiguous: ${peerRef.trim()}`);
					process.exitCode = 1;
					return;
				}
				if (!match) {
					p.log.error(`Peer not found: ${peerRef.trim()}`);
					process.exitCode = 1;
					return;
				}
				d.delete(schema.replicationCursors)
					.where(eq(schema.replicationCursors.peer_device_id, match.peer_device_id))
					.run();
				d.delete(schema.syncPeers)
					.where(eq(schema.syncPeers.peer_device_id, match.peer_device_id))
					.run();
				const payload = {
					ok: true,
					peer_device_id: match.peer_device_id,
					name: match.name,
				};
				if (opts.json) {
					console.log(JSON.stringify(payload, null, 2));
					return;
				}
				p.intro("codemem sync peers remove");
				p.log.success(`Removed peer ${match.name || match.peer_device_id}`);
				p.outro(match.peer_device_id);
			} finally {
				store.close();
			}
		}),
);

syncCommand.addCommand(peersCommand);

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

const coordinatorCommand = new Command("coordinator")
	.configureHelp(helpStyle)
	.description("Manage coordinator invites, join requests, and relay server");

coordinatorCommand.addCommand(
	new Command("group-create")
		.configureHelp(helpStyle)
		.description("Create a coordinator group in the local store")
		.argument("<group>", "group id")
		.option("--name <name>", "display name override")
		.option("--db <path>", "coordinator database path")
		.option("--db-path <path>", "coordinator database path")
		.option("--json", "output as JSON")
		.action(
			async (
				groupId: string,
				opts: { name?: string; db?: string; dbPath?: string; json?: boolean },
			) => {
				const group = await coordinatorCreateGroupAction({
					groupId,
					displayName: opts.name?.trim() || null,
					dbPath: opts.db ?? opts.dbPath ?? null,
				});
				if (opts.json) {
					console.log(JSON.stringify(group, null, 2));
					return;
				}
				p.intro("codemem sync coordinator group-create");
				p.log.success(`Group ready: ${groupId.trim()}`);
				p.outro(String(group.display_name ?? group.group_id ?? groupId.trim()));
			},
		),
);

coordinatorCommand.addCommand(
	new Command("list-groups")
		.configureHelp(helpStyle)
		.description("List coordinator groups from the local store")
		.option("--db <path>", "coordinator database path")
		.option("--db-path <path>", "coordinator database path")
		.option("--json", "output as JSON")
		.action(async (opts: { db?: string; dbPath?: string; json?: boolean }) => {
			const groups = await coordinatorListGroupsAction({ dbPath: opts.db ?? opts.dbPath ?? null });
			if (opts.json) {
				console.log(JSON.stringify(groups, null, 2));
				return;
			}
			p.intro("codemem sync coordinator list-groups");
			if (groups.length === 0) {
				p.outro("No coordinator groups found");
				return;
			}
			for (const group of groups) {
				p.log.message(
					`- ${String(group.group_id ?? "")}${group.display_name ? ` (${String(group.display_name)})` : ""}`,
				);
			}
			p.outro(`${groups.length} group(s)`);
		}),
);

coordinatorCommand.addCommand(
	new Command("enroll-device")
		.configureHelp(helpStyle)
		.description("Enroll a device in a local coordinator group")
		.argument("<group>", "group id")
		.argument("<device-id>", "device id")
		.option("--fingerprint <fingerprint>", "device fingerprint")
		.option("--public-key <key>", "device public key")
		.option("--public-key-file <path>", "path to device public key")
		.option("--name <name>", "display name")
		.option("--db <path>", "coordinator database path")
		.option("--db-path <path>", "coordinator database path")
		.option("--json", "output as JSON")
		.action(
			async (
				groupId: string,
				deviceId: string,
				opts: {
					fingerprint?: string;
					publicKey?: string;
					publicKeyFile?: string;
					name?: string;
					db?: string;
					dbPath?: string;
					json?: boolean;
				},
			) => {
				const publicKey = readCoordinatorPublicKey(opts);
				const fingerprint = String(opts.fingerprint ?? "").trim();
				if (!fingerprint) {
					p.log.error("Fingerprint required via --fingerprint");
					process.exitCode = 1;
					return;
				}
				const actualFingerprint = fingerprintPublicKey(publicKey);
				if (actualFingerprint !== fingerprint) {
					p.log.error("Fingerprint does not match the provided public key");
					process.exitCode = 1;
					return;
				}
				const enrollment = await coordinatorEnrollDeviceAction({
					groupId,
					deviceId,
					fingerprint,
					publicKey,
					displayName: opts.name?.trim() || null,
					dbPath: opts.db ?? opts.dbPath ?? null,
				});
				if (opts.json) {
					console.log(JSON.stringify(enrollment, null, 2));
					return;
				}
				p.intro("codemem sync coordinator enroll-device");
				p.log.success(`Enrolled ${deviceId.trim()} in ${groupId.trim()}`);
				p.outro(String(enrollment.display_name ?? enrollment.device_id ?? deviceId.trim()));
			},
		),
);

coordinatorCommand.addCommand(
	new Command("list-devices")
		.configureHelp(helpStyle)
		.description("List enrolled devices in a local coordinator group")
		.argument("<group>", "group id")
		.option("--include-disabled", "include disabled devices")
		.option("--db <path>", "coordinator database path")
		.option("--db-path <path>", "coordinator database path")
		.option("--json", "output as JSON")
		.action(
			async (
				groupId: string,
				opts: { includeDisabled?: boolean; db?: string; dbPath?: string; json?: boolean },
			) => {
				const rows = await coordinatorListDevicesAction({
					groupId,
					includeDisabled: opts.includeDisabled === true,
					dbPath: opts.db ?? opts.dbPath ?? null,
				});
				if (opts.json) {
					console.log(JSON.stringify(rows, null, 2));
					return;
				}
				p.intro("codemem sync coordinator list-devices");
				if (rows.length === 0) {
					p.outro(`No enrolled devices for ${groupId.trim()}`);
					return;
				}
				for (const row of rows) {
					const label =
						String(row.display_name ?? row.device_id ?? "").trim() || String(row.device_id ?? "");
					const enabled = Number(row.enabled ?? 1) === 1 ? "enabled" : "disabled";
					p.log.message(`- ${label} (${String(row.device_id ?? "")}) ${enabled}`);
				}
				p.outro(`${rows.length} device(s)`);
			},
		),
);

coordinatorCommand.addCommand(
	new Command("rename-device")
		.configureHelp(helpStyle)
		.description("Rename an enrolled device in the local coordinator store")
		.argument("<group>", "group id")
		.argument("<device-id>", "device id")
		.requiredOption("--name <name>", "display name")
		.option("--db <path>", "coordinator database path")
		.option("--db-path <path>", "coordinator database path")
		.option("--json", "output as JSON")
		.action(
			async (
				groupId: string,
				deviceId: string,
				opts: { name: string; db?: string; dbPath?: string; json?: boolean },
			) => {
				const result = await coordinatorRenameDeviceAction({
					groupId,
					deviceId,
					displayName: opts.name.trim(),
					dbPath: opts.db ?? opts.dbPath ?? null,
				});
				if (!result) {
					p.log.error(`Device not found: ${deviceId.trim()}`);
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				p.intro("codemem sync coordinator rename-device");
				p.log.success(`Renamed ${deviceId.trim()} in ${groupId.trim()}`);
				p.outro(String(result.display_name ?? result.device_id ?? deviceId.trim()));
			},
		),
);

coordinatorCommand.addCommand(
	new Command("disable-device")
		.configureHelp(helpStyle)
		.description("Disable an enrolled device in the local coordinator store")
		.argument("<group>", "group id")
		.argument("<device-id>", "device id")
		.option("--db <path>", "coordinator database path")
		.option("--db-path <path>", "coordinator database path")
		.option("--json", "output as JSON")
		.action(
			async (
				groupId: string,
				deviceId: string,
				opts: { db?: string; dbPath?: string; json?: boolean },
			) => {
				const ok = await coordinatorDisableDeviceAction({
					groupId,
					deviceId,
					dbPath: opts.db ?? opts.dbPath ?? null,
				});
				if (!ok) {
					p.log.error(`Device not found: ${deviceId.trim()}`);
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					console.log(
						JSON.stringify(
							{ ok: true, group_id: groupId.trim(), device_id: deviceId.trim() },
							null,
							2,
						),
					);
					return;
				}
				p.intro("codemem sync coordinator disable-device");
				p.log.success(`Disabled ${deviceId.trim()} in ${groupId.trim()}`);
				p.outro("disabled");
			},
		),
);

coordinatorCommand.addCommand(
	new Command("remove-device")
		.configureHelp(helpStyle)
		.description("Remove an enrolled device from the local coordinator store")
		.argument("<group>", "group id")
		.argument("<device-id>", "device id")
		.option("--db <path>", "coordinator database path")
		.option("--db-path <path>", "coordinator database path")
		.option("--json", "output as JSON")
		.action(
			async (
				groupId: string,
				deviceId: string,
				opts: { db?: string; dbPath?: string; json?: boolean },
			) => {
				const ok = await coordinatorRemoveDeviceAction({
					groupId,
					deviceId,
					dbPath: opts.db ?? opts.dbPath ?? null,
				});
				if (!ok) {
					p.log.error(`Device not found: ${deviceId.trim()}`);
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					console.log(
						JSON.stringify(
							{ ok: true, group_id: groupId.trim(), device_id: deviceId.trim() },
							null,
							2,
						),
					);
					return;
				}
				p.intro("codemem sync coordinator remove-device");
				p.log.success(`Removed ${deviceId.trim()} from ${groupId.trim()}`);
				p.outro("removed");
			},
		),
);

coordinatorCommand.addCommand(
	new Command("serve")
		.configureHelp(helpStyle)
		.description("Run the coordinator relay HTTP server")
		.option("--db <path>", "coordinator database path")
		.option("--db-path <path>", "coordinator database path")
		.option("--host <host>", "bind host", "127.0.0.1")
		.option("--port <port>", "bind port", "7347")
		.action(async (opts: { db?: string; dbPath?: string; host?: string; port?: string }) => {
			const host = String(opts.host ?? "127.0.0.1").trim() || "127.0.0.1";
			const port = Number.parseInt(String(opts.port ?? "7347"), 10);
			const dbPath = opts.db ?? opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH;
			const app = createBetterSqliteCoordinatorApp({ dbPath });
			p.intro("codemem sync coordinator serve");
			p.log.success(`Coordinator listening at http://${host}:${port}`);
			p.log.info(`DB: ${dbPath}`);
			honoServe({ fetch: app.fetch, hostname: host, port });
		}),
);

coordinatorCommand.addCommand(
	new Command("create-invite")
		.configureHelp(helpStyle)
		.description("Create a coordinator team invite")
		.argument("[group]", "group id")
		.option("--group <group>", "group id")
		.option("--coordinator-url <url>", "coordinator URL override")
		.option("--policy <policy>", "invite policy", "auto_admit")
		.option("--ttl-hours <hours>", "invite TTL hours", "24")
		.option("--db <path>", "coordinator database path")
		.option("--db-path <path>", "coordinator database path")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override")
		.option("--json", "output as JSON")
		.action(
			async (
				groupArg: string | undefined,
				opts: {
					group?: string;
					coordinatorUrl?: string;
					policy?: string;
					ttlHours?: string;
					db?: string;
					dbPath?: string;
					remoteUrl?: string;
					adminSecret?: string;
					json?: boolean;
				},
			) => {
				const ttlHours = Number.parseInt(String(opts.ttlHours ?? "24"), 10);
				const groupId = String(opts.group ?? "").trim() || String(groupArg ?? "").trim();
				const result = await coordinatorCreateInviteAction({
					groupId,
					coordinatorUrl: opts.coordinatorUrl?.trim() || null,
					policy: String(opts.policy ?? "auto_admit").trim(),
					ttlHours,
					createdBy: null,
					dbPath: opts.db ?? opts.dbPath ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				p.intro("codemem sync coordinator create-invite");
				p.log.success(`Invite created for ${groupId}`);
				if (typeof result.link === "string") p.log.message(`- link: ${result.link}`);
				if (typeof result.encoded === "string") p.log.message(`- invite: ${result.encoded}`);
				for (const warning of Array.isArray(result.warnings) ? result.warnings : []) {
					p.log.warn(String(warning));
				}
				p.outro("Invite ready");
			},
		),
);

coordinatorCommand.addCommand(
	new Command("import-invite")
		.configureHelp(helpStyle)
		.description("Import a coordinator invite")
		.argument("<invite>", "invite value or link")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--keys-dir <path>", "keys directory")
		.option("--config <path>", "config path")
		.option("--json", "output as JSON")
		.action(
			async (
				invite: string,
				opts: { db?: string; dbPath?: string; keysDir?: string; config?: string; json?: boolean },
			) => {
				const result = await coordinatorImportInviteAction({
					inviteValue: invite,
					dbPath: opts.db ?? opts.dbPath ?? null,
					keysDir: opts.keysDir ?? null,
					configPath: opts.config ?? null,
				});
				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				p.intro("codemem sync coordinator import-invite");
				p.log.success(`Invite imported for ${result.group_id}`);
				p.log.message(`- coordinator: ${result.coordinator_url}`);
				p.log.message(`- status: ${result.status}`);
				p.outro("Coordinator config updated");
			},
		),
);

coordinatorCommand.addCommand(
	new Command("list-join-requests")
		.configureHelp(helpStyle)
		.description("List pending coordinator join requests")
		.argument("[group]", "group id")
		.option("--group <group>", "group id")
		.option("--db <path>", "coordinator database path")
		.option("--db-path <path>", "coordinator database path")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override")
		.option("--json", "output as JSON")
		.action(
			async (
				groupArg: string | undefined,
				opts: {
					group?: string;
					db?: string;
					dbPath?: string;
					remoteUrl?: string;
					adminSecret?: string;
					json?: boolean;
				},
			) => {
				const groupId = String(opts.group ?? "").trim() || String(groupArg ?? "").trim();
				const rows = await coordinatorListJoinRequestsAction({
					groupId,
					dbPath: opts.db ?? opts.dbPath ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (opts.json) {
					console.log(JSON.stringify(rows, null, 2));
					return;
				}
				p.intro("codemem sync coordinator list-join-requests");
				if (rows.length === 0) {
					p.outro(`No pending join requests for ${groupId}`);
					return;
				}
				for (const row of rows) {
					const displayName = row.display_name || row.device_id;
					p.log.message(`- ${displayName} (${row.device_id}) request_id=${row.request_id}`);
				}
				p.outro(`${rows.length} pending join request(s)`);
			},
		),
);

function addReviewJoinRequestCommand(
	name: "approve-join-request" | "deny-join-request",
	approve: boolean,
) {
	coordinatorCommand.addCommand(
		new Command(name)
			.configureHelp(helpStyle)
			.description(`${approve ? "Approve" : "Deny"} a coordinator join request`)
			.argument("<request-id>", "join request id")
			.option("--db <path>", "coordinator database path")
			.option("--db-path <path>", "coordinator database path")
			.option("--remote-url <url>", "remote coordinator URL override")
			.option("--admin-secret <secret>", "remote coordinator admin secret override")
			.option("--json", "output as JSON")
			.action(
				async (
					requestId: string,
					opts: {
						db?: string;
						dbPath?: string;
						remoteUrl?: string;
						adminSecret?: string;
						json?: boolean;
					},
				) => {
					const request = await coordinatorReviewJoinRequestAction({
						requestId: requestId.trim(),
						approve,
						reviewedBy: null,
						dbPath: opts.db ?? opts.dbPath ?? null,
						remoteUrl: opts.remoteUrl?.trim() || null,
						adminSecret: opts.adminSecret?.trim() || null,
					});
					if (!request) {
						p.log.error(`Join request not found: ${requestId.trim()}`);
						process.exitCode = 1;
						return;
					}
					if (opts.json) {
						console.log(JSON.stringify(request, null, 2));
						return;
					}
					p.intro(`codemem sync coordinator ${name}`);
					p.log.success(`${approve ? "Approved" : "Denied"} join request ${requestId.trim()}`);
					p.outro(String(request.status ?? "updated"));
				},
			),
	);
}

addReviewJoinRequestCommand("approve-join-request", true);
addReviewJoinRequestCommand("deny-join-request", false);

syncCommand.addCommand(coordinatorCommand);
