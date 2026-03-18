/**
 * Sync CLI commands — enable/disable/status/peers/connect.
 *
 * Simplified port of codemem/commands/sync_cmds.py. Since the TS
 * architecture consolidates the sync daemon into `codemem serve`
 * (PR #301), these commands manage configuration and device identity
 * rather than a separate daemon process.
 */

import * as p from "@clack/prompts";
import {
	ensureDeviceIdentity,
	MemoryStore,
	readCodememConfigFile,
	resolveDbPath,
	writeCodememConfigFile,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const syncCommand = new Command("sync")
	.configureHelp(helpStyle)
	.description("Sync configuration and peer management");

// codemem sync status
syncCommand.addCommand(
	new Command("status")
		.configureHelp(helpStyle)
		.description("Show sync configuration and peer summary")
		.option("--db <path>", "database path")
		.option("--json", "output as JSON")
		.action((opts: { db?: string; json?: boolean }) => {
			const config = readCodememConfigFile();
			const store = new MemoryStore(resolveDbPath(opts.db));
			try {
				const deviceRow = store.db
					.prepare("SELECT device_id, fingerprint FROM sync_device LIMIT 1")
					.get() as { device_id: string; fingerprint: string } | undefined;
				const peers = store.db
					.prepare("SELECT peer_device_id, name, last_sync_at, last_error FROM sync_peers")
					.all() as Array<{
					peer_device_id: string;
					name: string | null;
					last_sync_at: string | null;
					last_error: string | null;
				}>;

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
		.option("--host <host>", "sync listen host")
		.option("--port <port>", "sync listen port")
		.option("--interval <seconds>", "sync interval in seconds")
		.action((opts: { db?: string; host?: string; port?: string; interval?: string }) => {
			const store = new MemoryStore(resolveDbPath(opts.db));
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
		}),
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
		.option("--json", "output as JSON")
		.action((opts: { db?: string; json?: boolean }) => {
			const store = new MemoryStore(resolveDbPath(opts.db));
			try {
				const peers = store.db
					.prepare(
						"SELECT peer_device_id, name, addresses, last_sync_at, last_error FROM sync_peers ORDER BY last_sync_at DESC",
					)
					.all() as Array<{
					peer_device_id: string;
					name: string | null;
					addresses: string | null;
					last_sync_at: string | null;
					last_error: string | null;
				}>;

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
