import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import {
	ObserverClient,
	RawEventSweeper,
	readCodememConfigFile,
	resolveDbPath,
	runSyncDaemon,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

function pidFilePath(dbPath: string): string {
	return join(dirname(dbPath), "viewer.pid");
}

interface ViewerPidRecord {
	pid: number;
	host: string;
	port: number;
}

function readViewerPidRecord(dbPath: string): ViewerPidRecord | null {
	const pidPath = pidFilePath(dbPath);
	if (!existsSync(pidPath)) return null;
	const raw = readFileSync(pidPath, "utf-8").trim();
	try {
		const parsed = JSON.parse(raw) as Partial<ViewerPidRecord>;
		if (
			typeof parsed.pid === "number" &&
			typeof parsed.host === "string" &&
			typeof parsed.port === "number"
		) {
			return { pid: parsed.pid, host: parsed.host, port: parsed.port };
		}
	} catch {
		const pid = Number.parseInt(raw, 10);
		if (Number.isFinite(pid) && pid > 0) {
			return { pid, host: "127.0.0.1", port: 38888 };
		}
	}
	return null;
}

async function respondsLikeCodememViewer(record: ViewerPidRecord): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1000);
		const res = await fetch(`http://${record.host}:${record.port}/api/stats`, {
			signal: controller.signal,
		});
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
			await new Promise((resolve) => setTimeout(resolve, 100));
		} catch {
			return;
		}
	}
}

async function stopExistingViewer(dbPath: string): Promise<void> {
	const pidPath = pidFilePath(dbPath);
	const record = readViewerPidRecord(dbPath);
	if (!record) return;
	// Only signal the process if the recorded endpoint still looks like codemem.
	if (await respondsLikeCodememViewer(record)) {
		try {
			process.kill(record.pid, "SIGTERM");
			await waitForProcessExit(record.pid);
		} catch {
			// stale pidfile or already exited
		}
	}
	try {
		rmSync(pidPath);
	} catch {
		// ignore
	}
}

export const serveCommand = new Command("serve")
	.configureHelp(helpStyle)
	.description("Start the viewer server")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--host <host>", "bind host", "127.0.0.1")
	.option("--port <port>", "bind port", "38888")
	.option("--background", "run under a caller-managed background process")
	.option("--stop", "stop an existing viewer process")
	.option("--restart", "restart an existing viewer process")
	.action(
		async (opts: {
			db?: string;
			host: string;
			port: string;
			background?: boolean;
			stop?: boolean;
			restart?: boolean;
		}) => {
			// Dynamic import to avoid loading hono/server deps for non-serve commands
			const { createApp, closeStore, getStore } = await import("@codemem/viewer-server");
			const { serve } = await import("@hono/node-server");

			const dbPath = resolveDbPath(opts.db);
			if (opts.stop || opts.restart) {
				await stopExistingViewer(dbPath);
				if (opts.stop && !opts.restart) return;
			}
			process.env.CODEMEM_DB = dbPath;

			const port = Number.parseInt(opts.port, 10);
			// Start the raw event sweeper — shares the same store as the viewer
			const observer = new ObserverClient();
			const sweeper = new RawEventSweeper(getStore(), { observer });
			sweeper.start();

			// Start the sync daemon if enabled — shares the same DB path.
			// Uses an AbortController so serve shutdown cleanly stops sync.
			const syncAbort = new AbortController();
			let syncRunning = false;
			const config = readCodememConfigFile();
			const syncEnabled =
				config.sync_enabled === true ||
				process.env.CODEMEM_SYNC_ENABLED?.toLowerCase() === "true" ||
				process.env.CODEMEM_SYNC_ENABLED === "1";

			if (syncEnabled) {
				syncRunning = true;
				const syncIntervalS =
					typeof config.sync_interval_s === "number" ? config.sync_interval_s : 120;
				runSyncDaemon({
					dbPath,
					intervalS: syncIntervalS,
					host: opts.host,
					port,
					signal: syncAbort.signal,
				})
					.catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err);
						p.log.error(`Sync daemon failed: ${msg}`);
						// Non-fatal — viewer continues without sync
					})
					.finally(() => {
						syncRunning = false;
					});
			}

			const app = createApp({ storeFactory: getStore, sweeper });
			const pidPath = pidFilePath(dbPath);

			const server = serve({ fetch: app.fetch, hostname: opts.host, port }, (info) => {
				writeFileSync(
					pidPath,
					JSON.stringify({ pid: process.pid, host: opts.host, port }),
					"utf-8",
				);
				p.intro("codemem viewer");
				p.log.success(`Listening on http://${info.address}:${info.port}`);
				p.log.info(`Database: ${dbPath}`);
				p.log.step("Raw event sweeper started");
				if (syncRunning) p.log.step("Sync daemon started");
			});

			const shutdown = async () => {
				p.outro("shutting down");
				// Stop sync daemon via abort signal
				syncAbort.abort();
				// Stop sweeper first and wait for any in-flight tick to drain.
				await sweeper.stop();
				// Close HTTP server, wait for in-flight requests to drain
				server.close(() => {
					try {
						rmSync(pidPath);
					} catch {
						// ignore
					}
					closeStore();
					process.exit(0);
				});
				// Force exit after 5s if graceful shutdown stalls
				setTimeout(() => {
					try {
						rmSync(pidPath);
					} catch {
						// ignore
					}
					closeStore();
					process.exit(1);
				}, 5000).unref();
			};
			process.on("SIGINT", () => {
				void shutdown();
			});
			process.on("SIGTERM", () => {
				void shutdown();
			});
		},
	);
