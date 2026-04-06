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
	applyBootstrapSnapshot,
	buildAuthHeaders,
	buildBaseUrl,
	ensureDeviceIdentity,
	fetchAllSnapshotPages,
	fingerprintPublicKey,
	hasUnsyncedSharedMemoryChanges,
	loadPublicKey,
	MemoryStore,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorSyncConfig,
	requestJson,
	resolveDbPath,
	runSyncPass,
	schema,
	setPeerProjectFilter,
	syncPassPreflight,
	updatePeerAddresses,
	writeCodememConfigFile,
} from "@codemem/core";
import { Command, Option } from "commander";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	addLegacyServiceFlags,
	addViewerHostOptions,
	emitDeprecationWarning,
	emitJsonError,
	resolveDbOpt,
} from "../shared-options.js";
import { buildCoordinatorCommand } from "./coordinator.js";
import {
	buildServeLifecycleArgs,
	collectAdvertiseAddresses,
	formatSyncAttempt,
	formatSyncOnceResult,
	parseProjectList,
	type SyncLifecycleOptions,
} from "./sync-helpers.js";

function readCliConfig(configPath?: string): Record<string, unknown> {
	return configPath ? readCodememConfigFileAtPath(configPath) : readCodememConfigFile();
}

function writeCliConfig(config: Record<string, unknown>, configPath?: string): string {
	return writeCodememConfigFile(config, configPath || undefined);
}

function parseAttemptsLimit(value: string): number {
	if (!/^\d+$/.test(value.trim())) {
		throw new Error(`Invalid --limit: ${value}`);
	}
	return Number.parseInt(value, 10);
}

function parsePositiveIntegerOption(
	value: string | undefined,
	flagName: string,
): number | undefined {
	if (value == null) return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(`Invalid ${flagName}: ${value}`);
	}
	return Number.parseInt(trimmed, 10);
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
	config?: string;
	db?: string;
	dbPath?: string;
	json?: boolean;
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
		const config = readCoordinatorSyncConfig(readCliConfig(opts.config));
		if (config.syncEnabled !== true) {
			p.log.error("Sync is disabled. Run `codemem sync enable` first.");
			process.exitCode = 1;
			return;
		}
		// Don't pass sync_host/sync_port as viewer bind values.
		// The viewer binds its own host/port (default 127.0.0.1:38888)
		// and the sync protocol listener reads sync_host/sync_port
		// internally from readCoordinatorSyncConfig().
	}
	const dbResolved = resolveDbOpt(opts);
	const args = buildServeLifecycleArgs(action, opts, process.argv[1] ?? "", process.execArgv);
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: process.cwd(),
			stdio: "inherit",
			env: {
				...process.env,
				...(dbResolved ? { CODEMEM_DB: dbResolved } : {}),
				...(opts.config ? { CODEMEM_CONFIG: opts.config } : {}),
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

// ---- sync attempts ----

const attemptsCmd = new Command("attempts")
	.configureHelp(helpStyle)
	.description("Show recent sync attempts")
	.option("--limit <n>", "max attempts", "10");
addDbOption(attemptsCmd);
addJsonOption(attemptsCmd);
attemptsCmd.action((opts: { db?: string; dbPath?: string; limit: string; json?: boolean }) => {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
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
});
syncCommand.addCommand(attemptsCmd);

// ---- sync start/stop/restart [deprecated] ----

function addDeprecatedLifecycleCommand(action: "start" | "stop" | "restart") {
	const cmd = new Command(action)
		.configureHelp(helpStyle)
		.description(`[deprecated] ${action} sync daemon — use 'codemem serve ${action}'`);
	addDbOption(cmd);
	addConfigOption(cmd);
	addViewerHostOptions(cmd);
	addLegacyServiceFlags(cmd);
	cmd.action(async (opts: SyncLifecycleOptions) => {
		emitDeprecationWarning(`codemem sync ${action}`, `codemem serve ${action}`);
		await runServeLifecycle(action, opts);
	});
	syncCommand.addCommand(cmd, { hidden: true });
}

addDeprecatedLifecycleCommand("start");
addDeprecatedLifecycleCommand("stop");
addDeprecatedLifecycleCommand("restart");

// ---- sync once ----

const onceCmd = new Command("once")
	.configureHelp(helpStyle)
	.description("Run a single sync pass")
	.option("--peer <peer>", "peer device id or name");
addDbOption(onceCmd);
addJsonOption(onceCmd);
onceCmd.action(async (opts: { db?: string; dbPath?: string; peer?: string; json?: boolean }) => {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
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
						if (opts.json) {
							emitJsonError("ambiguous_peer", `Peer name is ambiguous: ${opts.peer}`);
							return [];
						}
						p.log.error(`Peer name is ambiguous: ${opts.peer}`);
						process.exitCode = 1;
						return [];
					}
					return nameMatches;
				})()
			: d.select({ peer_device_id: schema.syncPeers.peer_device_id }).from(schema.syncPeers).all();

		if (rows.length === 0) {
			if (process.exitCode) return; // already set by ambiguous peer
			if (opts.json) {
				emitJsonError("no_peers", "No peers available for sync");
				return;
			}
			p.log.warn("No peers available for sync");
			process.exitCode = 1;
			return;
		}

		let hadFailure = false;
		const results: Array<{
			peer_device_id: string;
			ok: boolean;
			error?: string;
		}> = [];
		for (const row of rows) {
			const result = await runSyncPass(store.db, row.peer_device_id, { keysDir });
			if (!result.ok) hadFailure = true;
			results.push({
				peer_device_id: row.peer_device_id,
				ok: result.ok,
				...(result.error ? { error: result.error } : {}),
			});
			if (!opts.json) {
				console.log(formatSyncOnceResult(row.peer_device_id, result));
			}
		}
		if (opts.json) {
			console.log(JSON.stringify({ ok: !hadFailure, results }, null, 2));
		}
		if (hadFailure) {
			process.exitCode = 1;
		}
	} finally {
		store.close();
	}
});
syncCommand.addCommand(onceCmd);

// ---- sync pair ----

const pairCmd = new Command("pair")
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
	.option("--default", "with --accept, use default/global push filters");
addDbOption(pairCmd);
addConfigOption(pairCmd);
addJsonOption(pairCmd);
pairCmd.action(async (opts: SyncPairOptions) => {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		const acceptModeRequested = opts.accept != null || opts.acceptFile != null;
		if (opts.payloadOnly && acceptModeRequested) {
			if (opts.json) {
				emitJsonError(
					"usage_error",
					"--payload-only cannot be combined with --accept or --accept-file",
					2,
				);
				return;
			}
			p.log.error("--payload-only cannot be combined with --accept or --accept-file");
			process.exitCode = 1;
			return;
		}
		if (opts.accept && opts.acceptFile) {
			if (opts.json) {
				emitJsonError("usage_error", "Use only one of --accept or --accept-file", 2);
				return;
			}
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
				const msg =
					error instanceof Error
						? `Failed to read pairing payload from ${opts.acceptFile}: ${error.message}`
						: `Failed to read pairing payload from ${opts.acceptFile}`;
				if (opts.json) {
					emitJsonError("read_error", msg);
					return;
				}
				p.log.error(msg);
				process.exitCode = 1;
				return;
			}
		}

		if (acceptModeRequested && !(acceptText ?? "").trim()) {
			if (opts.json) {
				emitJsonError(
					"usage_error",
					"Empty pairing payload; provide JSON via --accept or --accept-file",
					2,
				);
				return;
			}
			p.log.error("Empty pairing payload; provide JSON via --accept or --accept-file");
			process.exitCode = 1;
			return;
		}

		if (!acceptText && (opts.include || opts.exclude || opts.all || opts.default)) {
			if (opts.json) {
				emitJsonError(
					"usage_error",
					"Project filters are outbound-only and must be set on the device running --accept",
					2,
				);
				return;
			}
			p.log.error(
				"Project filters are outbound-only and must be set on the device running --accept",
			);
			process.exitCode = 1;
			return;
		}

		if (acceptText?.trim()) {
			if (opts.all && opts.default) {
				if (opts.json) {
					emitJsonError("usage_error", "Use only one of --all or --default", 2);
					return;
				}
				p.log.error("Use only one of --all or --default");
				process.exitCode = 1;
				return;
			}
			if ((opts.all || opts.default) && (opts.include || opts.exclude)) {
				if (opts.json) {
					emitJsonError(
						"usage_error",
						"--include/--exclude cannot be combined with --all/--default",
						2,
					);
					return;
				}
				p.log.error("--include/--exclude cannot be combined with --all/--default");
				process.exitCode = 1;
				return;
			}

			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(acceptText) as Record<string, unknown>;
			} catch (error) {
				const msg =
					error instanceof Error
						? `Invalid pairing payload: ${error.message}`
						: "Invalid pairing payload";
				if (opts.json) {
					emitJsonError("invalid_payload", msg);
					return;
				}
				p.log.error(msg);
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
							.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
							.map((item) => item.trim())
					: [];
			if (!deviceId || !fingerprint || !publicKey || resolvedAddresses.length === 0) {
				const msg = "Pairing payload missing device_id, fingerprint, public_key, or addresses";
				if (opts.json) {
					emitJsonError("invalid_payload", msg);
					return;
				}
				p.log.error(msg);
				process.exitCode = 1;
				return;
			}
			if (fingerprintPublicKey(publicKey) !== fingerprint) {
				if (opts.json) {
					emitJsonError("fingerprint_mismatch", "Pairing payload fingerprint mismatch");
					return;
				}
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

			if (opts.json) {
				console.log(JSON.stringify({ ok: true, peer_device_id: deviceId }));
				return;
			}
			p.log.success(`Paired with ${deviceId}`);
			return;
		}

		const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
		const [deviceId, fingerprint] = ensureDeviceIdentity(store.db, { keysDir });
		const publicKey = loadPublicKey(keysDir);
		if (!publicKey) {
			if (opts.json) {
				emitJsonError("missing_key", "Public key missing");
				return;
			}
			p.log.error("Public key missing");
			process.exitCode = 1;
			return;
		}

		const config = readCliConfig(opts.config);
		const explicitAddress = opts.address?.trim();
		const configuredHost = typeof config.sync_host === "string" ? config.sync_host : null;
		const configuredPort = typeof config.sync_port === "number" ? config.sync_port : 7337;
		const addresses = collectAdvertiseAddresses(
			explicitAddress ?? null,
			configuredHost,
			configuredPort,
			networkInterfaces(),
		);
		const payloadObj = {
			device_id: deviceId,
			fingerprint,
			public_key: publicKey,
			address: addresses[0] ?? "",
			addresses,
		};
		const payloadText = JSON.stringify(payloadObj);

		if (opts.payloadOnly || opts.json) {
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
});
syncCommand.addCommand(pairCmd);

// ---- sync doctor ----

const doctorCmd = new Command("doctor")
	.configureHelp(helpStyle)
	.description("Diagnose common sync setup and connectivity issues");
addDbOption(doctorCmd);
addConfigOption(doctorCmd);
addJsonOption(doctorCmd);
doctorCmd.action(
	async (opts: { db?: string; dbPath?: string; config?: string; json?: boolean }) => {
		const config = readCliConfig(opts.config);
		const dbPath = resolveDbPath(resolveDbOpt(opts));
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

			const reachable = viewerBinding
				? await portOpen(viewerBinding.host, viewerBinding.port)
				: false;

			if (!reachable) issues.push("daemon not running");
			if (!device) issues.push("identity missing");
			if (
				daemonState?.last_error &&
				(!daemonState.last_ok_at || daemonState.last_ok_at < (daemonState.last_error_at ?? ""))
			) {
				issues.push("daemon error");
			}
			if (peers.length === 0) issues.push("no peers");
			if (!config.sync_enabled) issues.push("sync is disabled");

			const peerDetails: Array<{
				peer_device_id: string;
				addresses: number;
				reachable: string;
				pinned: boolean;
				has_public_key: boolean;
			}> = [];

			for (const peer of peers) {
				const addresses = peer.addresses_json ? (JSON.parse(peer.addresses_json) as string[]) : [];
				const endpoint = parseStoredAddressEndpoint(addresses[0] ?? "");
				const reach = endpoint
					? (await portOpen(endpoint.host, endpoint.port))
						? "ok"
						: "unreachable"
					: "unknown";
				const pinned = Boolean(peer.pinned_fingerprint);
				const hasKey = Boolean(peer.public_key);
				peerDetails.push({
					peer_device_id: peer.peer_device_id,
					addresses: addresses.length,
					reachable: reach,
					pinned,
					has_public_key: hasKey,
				});
				if (reach !== "ok") issues.push(`peer ${peer.peer_device_id} unreachable`);
				if (!pinned || !hasKey) issues.push(`peer ${peer.peer_device_id} not pinned`);
			}

			if (opts.json) {
				console.log(
					JSON.stringify({
						enabled: config.sync_enabled === true,
						listen: `${syncHost}:${syncPort}`,
						mdns: process.env.CODEMEM_SYNC_MDNS ? "env-configured" : "default/off",
						daemon: reachable ? "running" : "not running",
						identity: device?.device_id ?? null,
						daemon_error: daemonState?.last_error ?? null,
						peers: peerDetails,
						issues: [...new Set(issues)],
						ok: issues.length === 0,
					}),
				);
				return;
			}

			console.log("Sync doctor");
			console.log(`- Enabled: ${config.sync_enabled === true}`);
			console.log(`- Listen: ${syncHost}:${syncPort}`);
			console.log(`- mDNS: ${process.env.CODEMEM_SYNC_MDNS ? "env-configured" : "default/off"}`);
			console.log(`- Daemon: ${reachable ? "running" : "not running"}`);

			if (!device) {
				console.log("- Identity: missing (run `codemem sync enable`)");
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
			}

			if (peers.length === 0) {
				console.log("- Peers: none (pair a device first)");
			} else {
				console.log(`- Peers: ${peers.length}`);
				for (const detail of peerDetails) {
					console.log(
						`  - ${detail.peer_device_id}: addresses=${detail.addresses} reach=${detail.reachable} pinned=${detail.pinned} public_key=${detail.has_public_key}`,
					);
				}
			}

			if (issues.length > 0) {
				console.log(`WARN: ${[...new Set(issues)].slice(0, 3).join(", ")}`);
			} else {
				console.log("OK: sync looks healthy");
			}
		} finally {
			store.close();
		}
	},
);
syncCommand.addCommand(doctorCmd);

// ---- sync status ----

const statusCmd = new Command("status")
	.configureHelp(helpStyle)
	.description("Show sync configuration and peer summary");
addDbOption(statusCmd);
addConfigOption(statusCmd);
addJsonOption(statusCmd);
statusCmd.action((opts: { db?: string; dbPath?: string; config?: string; json?: boolean }) => {
	const config = readCliConfig(opts.config);
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
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
});
syncCommand.addCommand(statusCmd);

// ---- sync enable ----

const enableCmd = new Command("enable")
	.configureHelp(helpStyle)
	.description("Enable sync and initialize device identity")
	.option("--sync-host <host>", "sync listen host")
	.option("--sync-port <port>", "sync listen port")
	.option("--interval <seconds>", "sync interval in seconds");
addDbOption(enableCmd);
addConfigOption(enableCmd);
addJsonOption(enableCmd);
// Hidden aliases for backwards compat
enableCmd.addOption(new Option("--host <host>", "sync listen host").hideHelp());
enableCmd.addOption(new Option("--port <port>", "sync listen port").hideHelp());
enableCmd.action(
	(opts: {
		db?: string;
		dbPath?: string;
		config?: string;
		syncHost?: string;
		syncPort?: string;
		host?: string;
		port?: string;
		interval?: string;
		json?: boolean;
	}) => {
		// Emit deprecation warnings for legacy --host/--port
		if (opts.host && !opts.syncHost) {
			emitDeprecationWarning("--host on sync enable", "--sync-host");
		}
		if (opts.port && !opts.syncPort) {
			emitDeprecationWarning("--port on sync enable", "--sync-port");
		}
		const effectiveHost = opts.syncHost ?? opts.host;
		const effectivePort = opts.syncPort ?? opts.port;

		const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
		try {
			const [deviceId, fingerprint] = ensureDeviceIdentity(store.db);
			const config = readCliConfig(opts.config);
			config.sync_enabled = true;
			if (effectiveHost) config.sync_host = effectiveHost;
			const syncPort = parsePositiveIntegerOption(effectivePort, "--sync-port");
			const syncInterval = parsePositiveIntegerOption(opts.interval, "--interval");
			if (syncPort != null) config.sync_port = syncPort;
			if (syncInterval != null) config.sync_interval_s = syncInterval;
			writeCliConfig(config, opts.config);

			if (opts.json) {
				console.log(
					JSON.stringify({
						ok: true,
						device_id: deviceId,
						fingerprint,
						host: config.sync_host ?? "0.0.0.0",
						port: config.sync_port ?? 7337,
						interval_s: config.sync_interval_s ?? 120,
					}),
				);
				return;
			}

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
);
syncCommand.addCommand(enableCmd);

// ---- sync disable ----

const disableCmd = new Command("disable")
	.configureHelp(helpStyle)
	.description("Disable sync without deleting keys or peers");
addConfigOption(disableCmd);
disableCmd.action((opts: { config?: string }) => {
	const config = readCliConfig(opts.config);
	config.sync_enabled = false;
	writeCliConfig(config, opts.config);
	p.intro("codemem sync disable");
	p.outro("Sync disabled — restart `codemem serve` to take effect");
});
syncCommand.addCommand(disableCmd);

// ---- sync peers ----

const peersCommand = new Command("peers")
	.configureHelp(helpStyle)
	.description("List known sync peers");
addDbOption(peersCommand);
addJsonOption(peersCommand);
peersCommand.action((opts: { db?: string; dbPath?: string; json?: boolean }) => {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
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

const peersRemoveCmd = new Command("remove")
	.configureHelp(helpStyle)
	.description("Remove a sync peer by device id or exact name")
	.argument("<peer>", "peer device id or exact name");
addDbOption(peersRemoveCmd);
addJsonOption(peersRemoveCmd);
peersRemoveCmd.action((peerRef: string, opts: { db?: string; dbPath?: string; json?: boolean }) => {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		const d = drizzle(store.db, { schema });
		const match = resolvePeerMatch(d, peerRef);
		if (match === "ambiguous") {
			if (opts.json) {
				emitJsonError("ambiguous_peer", `Peer name is ambiguous: ${peerRef.trim()}`);
				return;
			}
			p.log.error(`Peer name is ambiguous: ${peerRef.trim()}`);
			process.exitCode = 1;
			return;
		}
		if (!match) {
			if (opts.json) {
				emitJsonError("peer_not_found", `Peer not found: ${peerRef.trim()}`);
				return;
			}
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
});
peersCommand.addCommand(peersRemoveCmd);
syncCommand.addCommand(peersCommand);

// ---- sync bootstrap <peer-device-id> ----

const bootstrapCmd = new Command("bootstrap")
	.configureHelp(helpStyle)
	.description("Fast-bootstrap memories from a peer (full snapshot transfer)")
	.argument("[peer-device-id]", "peer device ID to bootstrap from")
	.option("--bootstrap-grant <grant-id>", "bootstrap grant id for seed-authorized bootstrap")
	.option("--page-size <n>", "items per snapshot page (default: 2000)", "2000")
	.option("--keys-dir <path>", "keys directory")
	.option("--force", "skip dirty-local-state safety check");
addDbOption(bootstrapCmd);
addJsonOption(bootstrapCmd);
// Hidden alias for backwards compat
bootstrapCmd.addOption(new Option("--peer <device-id>", "peer device ID").hideHelp());
bootstrapCmd.action(
	async (
		peerArg: string | undefined,
		opts: {
			peer?: string;
			bootstrapGrant?: string;
			pageSize: string;
			db?: string;
			dbPath?: string;
			keysDir?: string;
			force?: boolean;
			json?: boolean;
		},
	) => {
		// Resolve peer from positional or hidden --peer alias
		const peerDeviceId = (peerArg || opts.peer || "").trim();
		if (!peerDeviceId) {
			if (opts.json) {
				emitJsonError("usage_error", "missing required argument: <peer-device-id>", 2);
				return;
			}
			p.log.error("missing required argument: <peer-device-id>");
			process.exitCode = 2;
			return;
		}

		const dbPath = resolveDbPath(resolveDbOpt(opts));
		const store = new MemoryStore(dbPath);
		try {
			const pageSize = Math.max(1, Number.parseInt(opts.pageSize, 10) || 2000);
			const keysDir = opts.keysDir ?? undefined;
			const d = drizzle(store.db, { schema });

			// Look up peer
			const peer = d
				.select()
				.from(schema.syncPeers)
				.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
				.get();
			if (!peer) {
				if (opts.json) {
					emitJsonError("peer_not_found", `Peer ${peerDeviceId} not found in sync_peers.`);
				} else {
					p.log.error(`Peer ${peerDeviceId} not found in sync_peers.`);
				}
				process.exitCode = 1;
				return;
			}
			if (!peer.pinned_fingerprint) {
				if (opts.json) {
					emitJsonError(
						"peer_not_pinned",
						`Peer ${peerDeviceId} has no pinned fingerprint. Accept it first.`,
					);
				} else {
					p.log.error(`Peer ${peerDeviceId} has no pinned fingerprint. Accept it first.`);
				}
				process.exitCode = 1;
				return;
			}

			// Safety check
			if (!opts.force) {
				const dirty = hasUnsyncedSharedMemoryChanges(store.db);
				if (dirty.dirty) {
					if (opts.json) {
						emitJsonError(
							"local_unsynced_changes",
							`${dirty.count} unsynced shared memory change(s) would be lost. Use --force to override.`,
						);
					} else {
						p.log.error(
							`${dirty.count} unsynced shared memory change(s) would be lost. Use --force to override.`,
						);
					}
					process.exitCode = 1;
					return;
				}
			}

			// Resolve device identity
			const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });

			// Get peer status to obtain reset boundary
			const addresses = JSON.parse(String(peer.addresses_json ?? "[]")) as string[];
			if (!addresses.length) {
				if (opts.json) {
					emitJsonError(
						"no_peer_addresses",
						"Peer has no known addresses. Run a sync first or add addresses.",
					);
				} else {
					p.log.error("Peer has no known addresses. Run a sync first or add addresses.");
				}
				process.exitCode = 1;
				return;
			}

			let boundary: {
				generation: number;
				snapshot_id: string;
				baseline_cursor: string | null;
			} | null = null;
			let baseUrl = "";
			const addressResults: Array<{ address: string; result: string }> = [];

			for (const address of addresses) {
				const candidate = buildBaseUrl(address);
				if (!candidate) continue;
				const statusUrl = `${candidate}/v1/status`;
				const headers = buildAuthHeaders({
					deviceId,
					method: "GET",
					url: statusUrl,
					bodyBytes: Buffer.alloc(0),
					bootstrapGrantId: opts.bootstrapGrant,
					keysDir,
				});
				try {
					const [code, payload] = await requestJson("GET", statusUrl, { headers });
					if (code !== 200 || !payload) {
						addressResults.push({ address: candidate, result: `status ${code}` });
						continue;
					}
					if (payload.fingerprint !== peer.pinned_fingerprint) {
						addressResults.push({ address: candidate, result: "fingerprint mismatch" });
						continue;
					}
					const reset = payload.sync_reset as Record<string, unknown> | undefined;
					if (
						reset &&
						typeof reset.generation === "number" &&
						typeof reset.snapshot_id === "string"
					) {
						boundary = {
							generation: reset.generation,
							snapshot_id: reset.snapshot_id,
							baseline_cursor:
								typeof reset.baseline_cursor === "string" ? reset.baseline_cursor : null,
						};
						baseUrl = candidate;
						addressResults.push({ address: candidate, result: "ok" });
						break;
					}
					addressResults.push({ address: candidate, result: "missing sync_reset boundary" });
				} catch (err) {
					addressResults.push({
						address: candidate,
						result: err instanceof Error ? err.message : String(err),
					});
				}
			}

			if (!boundary || !baseUrl) {
				const summary = addressResults.map((r) => `${r.address}: ${r.result}`).join("; ");
				const detail = summary
					? `no reachable peer with valid reset boundary. Tried: ${summary}`
					: "peer unreachable or missing reset boundary";
				if (opts.json) {
					console.log(JSON.stringify({ ok: false, error: detail, addresses: addressResults }));
				} else {
					p.log.error(detail);
				}
				process.exitCode = 1;
				return;
			}

			if (!opts.json) {
				p.intro("codemem sync bootstrap");
				p.log.step(`Bootstrapping from ${peer.name || peerDeviceId}...`);
			}

			const resetInfo = {
				generation: boundary.generation,
				snapshot_id: boundary.snapshot_id,
				baseline_cursor: boundary.baseline_cursor,
				retained_floor_cursor: null,
				reset_required: true as const,
				reason: "initial_bootstrap" as const,
			};

			const { items } = await fetchAllSnapshotPages(baseUrl, resetInfo, deviceId, {
				keysDir,
				bootstrapGrantId: opts.bootstrapGrant,
				pageSize,
			});

			const result = applyBootstrapSnapshot(store.db, peerDeviceId, items, resetInfo);

			if (opts.json) {
				console.log(
					JSON.stringify({
						ok: result.ok,
						applied: result.applied,
						deleted: result.deleted,
						error: result.error ?? null,
					}),
				);
			} else {
				if (result.ok) {
					p.log.success(`Applied ${result.applied} memories (removed ${result.deleted} stale).`);
				} else {
					p.log.error(result.error || "Bootstrap apply failed.");
				}
				p.outro(result.ok ? "Bootstrap complete" : "Bootstrap failed");
			}
			if (!result.ok) process.exitCode = 1;
		} finally {
			store.close();
		}
	},
);
syncCommand.addCommand(bootstrapCmd);

// ---- sync connect <coordinator-url> ----

const connectCmd = new Command("connect")
	.configureHelp(helpStyle)
	.description("Configure coordinator URL for cloud sync")
	.argument("<url>", "coordinator URL (e.g. https://coordinator.example.com)")
	.option("--group <group>", "sync group ID");
addConfigOption(connectCmd);
connectCmd.action((url: string, opts: { group?: string; config?: string }) => {
	const config = readCliConfig(opts.config);
	config.sync_coordinator_url = url.trim();
	if (opts.group) config.sync_coordinator_group = opts.group.trim();
	writeCliConfig(config, opts.config);
	p.intro("codemem sync connect");
	p.log.success(`Coordinator: ${url.trim()}`);
	if (opts.group) p.log.info(`Group: ${opts.group.trim()}`);
	p.outro("Restart `codemem serve` to activate coordinator sync");
});
syncCommand.addCommand(connectCmd);

// ---- Deprecation alias: sync coordinator → coordinator ----
// Build a separate coordinator command tree for the sync alias (Commander
// re-parents commands on addCommand, so sharing instances is not possible).
// The canonical coordinatorCommand lives in coordinator.ts and is registered
// at the top level by index.ts.

const syncCoordinatorAlias = buildCoordinatorCommand();

syncCoordinatorAlias.hook("preAction", (_thisCmd: Command, actionCmd: Command) => {
	const subName = actionCmd.name();
	emitDeprecationWarning(`codemem sync coordinator ${subName}`, `codemem coordinator ${subName}`);
});

syncCommand.addCommand(syncCoordinatorAlias);
