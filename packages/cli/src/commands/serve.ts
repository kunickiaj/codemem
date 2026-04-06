import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import {
	applyRawEventRelinkPlan,
	initDatabase,
	isEmbeddingDisabled,
	type MemoryStore,
	ObserverClient,
	RawEventSweeper,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorSyncConfig,
	resolveDbPath,
	runSyncDaemon,
	SyncRetentionRunner,
} from "@codemem/core";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addViewerHostOptions,
	emitDeprecationWarning,
} from "../shared-options.js";
import {
	type LegacyServeOptions,
	type ResolvedServeInvocation,
	resolveServeInvocation,
	type ServeAction,
} from "./serve-invocation.js";

interface ViewerPidRecord {
	pid: number;
	host: string;
	port: number;
}

export function extractViewerPid(payload: unknown): number | null {
	if (!payload || typeof payload !== "object") return null;
	const rawPid = (payload as { viewer_pid?: unknown }).viewer_pid;
	if (typeof rawPid !== "number" || !Number.isFinite(rawPid) || rawPid <= 0) return null;
	return Math.trunc(rawPid);
}

export function isLocalHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return (
		normalized === "127.0.0.1" ||
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "0.0.0.0" ||
		normalized === "::"
	);
}

export function isLoopbackOnlyHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return (
		normalized === "localhost" ||
		/^127(?:\.\d{1,3}){0,3}$/.test(normalized) ||
		normalized === "::1" ||
		normalized === "0:0:0:0:0:0:0:1"
	);
}

function warnIfViewerExposed(host: string, port: number): void {
	if (isLoopbackOnlyHost(host)) return;
	p.log.warn(
		`Viewer bound to ${host}:${port}. codemem's viewer trust model assumes localhost-only access; do not expose it through a reverse proxy, tunnel, or public bind without adding your own auth layer.`,
	);
}

export function isLikelyViewerCommand(command: string): boolean {
	const lowered = command.toLowerCase();
	if (!/\bserve\s+start\b/.test(lowered)) return false;
	return (
		lowered.includes("codemem") ||
		lowered.includes("packages/cli/dist/index.js") ||
		lowered.includes("/cli/dist/index.js")
	);
}

export function prepareViewerDatabase(dbPath?: string | null): string {
	const path = initDatabase(dbPath ?? undefined).path;
	applyRawEventRelinkPlan(path, { dryRun: false });
	return path;
}

export function pickViewerPidCandidate(
	statsPid: number | null,
	listenerPid: number | null,
): number | null {
	if (statsPid && listenerPid && statsPid !== listenerPid) return null;
	return statsPid ?? listenerPid ?? null;
}

function lookupListeningPid(host: string, port: number): number | null {
	if (!isLocalHost(host)) return null;
	const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
		encoding: "utf-8",
		timeout: 1000,
	});
	if (result.status !== 0) return null;
	const first = (result.stdout || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!first) return null;
	const parsed = Number.parseInt(first, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readProcessCommand(pid: number): string | null {
	const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
		encoding: "utf-8",
		timeout: 1000,
	});
	if (result.status !== 0) return null;
	const cmd = (result.stdout || "").trim();
	return cmd.length > 0 ? cmd : null;
}

function isTrustedViewerPid(
	pid: number,
	target: { host: string; port: number },
	listenerPid: number | null,
): boolean {
	if (!isLocalHost(target.host)) return false;
	if (listenerPid && listenerPid !== pid) return false;
	const command = readProcessCommand(pid);
	if (!command) return false;
	return isLikelyViewerCommand(command);
}

function pidFilePath(dbPath: string): string {
	return join(dirname(dbPath), "viewer.pid");
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

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
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

async function lookupViewerPidFromStats(host: string, port: number): Promise<number | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1000);
		const res = await fetch(`http://${host}:${port}/api/stats`, {
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		const payload = await res.json();
		return extractViewerPid(payload);
	} catch {
		return null;
	}
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port });
		const done = (open: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(300);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

async function waitForProcessExit(pid: number, timeoutMs = 30000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessRunning(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return !isProcessRunning(pid);
}

async function waitForPortRelease(host: string, port: number, timeoutMs = 10000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await isPortOpen(host, port))) return true;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
}

async function stopExistingViewer(
	dbPath: string,
	target: { host: string; port: number },
): Promise<{ stopped: boolean; pid: number | null }> {
	const terminatePid = async (pid: number): Promise<boolean> => {
		try {
			process.kill(pid, "SIGTERM");
			return await waitForProcessExit(pid);
		} catch {
			return true;
		}
	};

	const pidPath = pidFilePath(dbPath);
	const record = readViewerPidRecord(dbPath);
	const viewerPidFromStats = await lookupViewerPidFromStats(target.host, target.port);
	const listenerPid = lookupListeningPid(target.host, target.port);
	const viewerPid = pickViewerPidCandidate(viewerPidFromStats, listenerPid);
	if (viewerPid && isTrustedViewerPid(viewerPid, target, listenerPid)) {
		const stopped = await terminatePid(viewerPid);
		if (!stopped) return { stopped: false, pid: viewerPid };
		try {
			rmSync(pidPath);
		} catch {
			// ignore
		}
		return { stopped: true, pid: viewerPid };
	}

	if (!record) return { stopped: false, pid: null };

	if (await respondsLikeCodememViewer(record)) {
		const stopped = await terminatePid(record.pid);
		if (!stopped) return { stopped: false, pid: record.pid };
	}
	try {
		rmSync(pidPath);
	} catch {
		// ignore
	}
	return { stopped: true, pid: record.pid };
}

export function buildForegroundRunnerArgs(
	scriptPath: string,
	invocation: ResolvedServeInvocation,
	execArgv: string[] = process.execArgv,
): string[] {
	const args = [
		...execArgv,
		scriptPath,
		"serve",
		"start",
		"--foreground",
		"--host",
		invocation.host,
		"--port",
		String(invocation.port),
	];
	if (invocation.dbPath) {
		args.push("--db-path", invocation.dbPath);
	}
	return args;
}

export function isSqliteVecLoadFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const text = error.message.toLowerCase();
	return (
		text.includes("sqlite-vec") ||
		text.includes("vec_version") ||
		text.includes("vec0") ||
		(text.includes("sqlite") && text.includes("vec"))
	);
}

export function sqliteVecFailureDiagnostics(error: unknown, dbPath: string): string[] {
	const message = error instanceof Error ? error.message : String(error);
	return [
		`db=${dbPath}`,
		`node=${process.version}`,
		`exec=${process.execPath}`,
		`cwd=${process.cwd()}`,
		`embedding_disabled=${process.env.CODEMEM_EMBEDDING_DISABLED ?? ""}`,
		`error=${message}`,
	];
}

async function startBackgroundViewer(invocation: ResolvedServeInvocation): Promise<void> {
	warnIfViewerExposed(invocation.host, invocation.port);
	if (await isPortOpen(invocation.host, invocation.port)) {
		p.log.warn(`Viewer already running at http://${invocation.host}:${invocation.port}`);
		return;
	}
	const scriptPath = process.argv[1];
	if (!scriptPath) {
		p.log.error("Unable to resolve CLI entrypoint for background launch");
		process.exitCode = 1;
		return;
	}
	const child = spawn(process.execPath, buildForegroundRunnerArgs(scriptPath, invocation), {
		cwd: process.cwd(),
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			...(invocation.dbPath ? { CODEMEM_DB: invocation.dbPath } : {}),
			...(invocation.configPath ? { CODEMEM_CONFIG: invocation.configPath } : {}),
		},
	});
	child.unref();
	if (invocation.dbPath) {
		writeFileSync(
			pidFilePath(invocation.dbPath),
			JSON.stringify({ pid: child.pid, host: invocation.host, port: invocation.port }),
			"utf-8",
		);
	}
	p.intro("codemem viewer");
	p.outro(
		`Viewer started in background (pid ${child.pid}) at http://${invocation.host}:${invocation.port}`,
	);
}

async function startForegroundViewer(invocation: ResolvedServeInvocation): Promise<void> {
	const { createApp, createSyncApp, closeStore, getStore } = await import("@codemem/server");
	const { serve } = await import("@hono/node-server");

	if (invocation.dbPath) process.env.CODEMEM_DB = invocation.dbPath;
	if (invocation.configPath) process.env.CODEMEM_CONFIG = invocation.configPath;
	warnIfViewerExposed(invocation.host, invocation.port);
	if (await isPortOpen(invocation.host, invocation.port)) {
		p.log.warn(`Viewer already running at http://${invocation.host}:${invocation.port}`);
		process.exitCode = 1;
		return;
	}
	const preparedDb = prepareViewerDatabase(invocation.dbPath);

	const observer = new ObserverClient();
	let store: MemoryStore;
	try {
		store = getStore();
	} catch (err) {
		if (isEmbeddingDisabled() || !isSqliteVecLoadFailure(err)) {
			throw err;
		}

		p.log.warn("sqlite-vec failed to load; retrying viewer startup with embeddings disabled");
		for (const line of sqliteVecFailureDiagnostics(
			err,
			resolveDbPath(invocation.dbPath ?? undefined),
		)) {
			p.log.warn(`sqlite-vec diagnostic: ${line}`);
		}
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		closeStore();
		store = getStore();
		p.log.warn("Embeddings disabled for this viewer process; raw-event ingestion remains active.");
	}

	const sweeper = new RawEventSweeper(store, { observer });
	sweeper.start();

	const syncAbort = new AbortController();
	const retentionAbort = new AbortController();
	const config = invocation.configPath
		? readCodememConfigFileAtPath(invocation.configPath)
		: readCodememConfigFile();
	const syncConfig = readCoordinatorSyncConfig(config);
	const syncEnabled = syncConfig.syncEnabled;
	const retentionRunner = new SyncRetentionRunner({
		dbPath: resolveDbPath(invocation.dbPath ?? undefined),
		signal: retentionAbort.signal,
	});
	const syncRuntimeStatus: {
		phase: "starting" | "running" | "stopping" | "error" | "disabled" | null;
		detail: string | null;
	} = {
		phase: syncEnabled ? "starting" : "disabled",
		detail: syncEnabled ? "Waiting for viewer startup to finish" : "Sync is disabled",
	};

	const appOpts = {
		storeFactory: () => store,
		sweeper,
		observer,
		getSyncRuntimeStatus: () => syncRuntimeStatus,
	};
	const app = createApp(appOpts);
	const dbPath = resolveDbPath(invocation.dbPath ?? undefined);
	const pidPath = pidFilePath(dbPath);

	// Sync protocol listener — separate port, network-accessible for peers.
	// syncServerRef is never nulled after creation so shutdown always drains it.
	let syncServer: ReturnType<typeof serve> | null = null;
	let syncListenerReady = false;
	if (syncEnabled) {
		const syncApp = createSyncApp(appOpts);
		syncServer = serve(
			{ fetch: syncApp.fetch, hostname: syncConfig.syncHost, port: syncConfig.syncPort },
			(info) => {
				syncListenerReady = true;
				p.log.step(`Sync protocol listening on http://${info.address}:${info.port}`);
			},
		);
		syncServer.on("error", (err: NodeJS.ErrnoException) => {
			if (!syncListenerReady && err.code === "EADDRINUSE") {
				p.log.warn(
					`Sync port ${syncConfig.syncPort} already in use; peer sync protocol unavailable`,
				);
			} else {
				p.log.warn(`Sync listener error: ${err.message}`);
			}
			// Non-fatal — viewer continues. syncServer ref is kept for shutdown drain.
		});
	}

	const server = serve(
		{ fetch: app.fetch, hostname: invocation.host, port: invocation.port },
		(info) => {
			writeFileSync(
				pidPath,
				JSON.stringify({ pid: process.pid, host: invocation.host, port: invocation.port }),
				"utf-8",
			);
			p.intro("codemem viewer");
			p.log.success(`Listening on http://${info.address}:${info.port}`);
			p.log.info(`Database: ${preparedDb}`);
			p.log.step("Raw event sweeper started");
			if (syncConfig.syncRetentionEnabled) {
				retentionRunner.start();
				p.log.step("Retention maintenance runner started");
			}
			if (syncEnabled) {
				const syncStartDelayMs = 3000;
				p.log.step(`Sync daemon will start in background (${syncStartDelayMs / 1000}s delay)`);
				setTimeout(() => {
					syncRuntimeStatus.phase = "starting";
					syncRuntimeStatus.detail = "Starting sync in background";
					void runSyncDaemon({
						dbPath: resolveDbPath(invocation.dbPath ?? undefined),
						intervalS: syncConfig.syncIntervalS,
						host: syncConfig.syncHost,
						port: syncConfig.syncPort,
						signal: syncAbort.signal,
						onPhaseChange: (phase) => {
							if (phase === "running") {
								syncRuntimeStatus.phase = null;
								syncRuntimeStatus.detail = null;
							} else {
								syncRuntimeStatus.phase = phase;
								syncRuntimeStatus.detail =
									phase === "starting"
										? "Running initial sync in background"
										: "Stopping sync daemon";
							}
						},
					})
						.catch((err: unknown) => {
							const msg = err instanceof Error ? err.message : String(err);
							syncRuntimeStatus.phase = "error";
							syncRuntimeStatus.detail = msg;
							p.log.error(`Sync daemon failed: ${msg}`);
						})
						.finally(() => {
							if (syncRuntimeStatus.phase !== "error") {
								syncRuntimeStatus.phase = syncAbort.signal.aborted ? "stopping" : null;
								syncRuntimeStatus.detail = syncAbort.signal.aborted ? "Sync stopped" : null;
							}
						});
				}, syncStartDelayMs).unref();
			}
		},
	);

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			p.log.warn(`Viewer already running at http://${invocation.host}:${invocation.port}`);
		} else {
			p.log.error(err.message);
		}
		process.exit(1);
	});

	// Periodic WAL checkpoint — keeps the WAL file bounded.
	// Without this, long-running viewer processes accumulate a WAL that can
	// grow to match the main DB size when concurrent readers hold it open.
	const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
	const walCheckpointTimer = setInterval(() => {
		try {
			store.db.pragma("wal_checkpoint(TRUNCATE)");
		} catch (err) {
			p.log.warn(`WAL checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, WAL_CHECKPOINT_INTERVAL_MS);
	walCheckpointTimer.unref();

	const shutdown = async () => {
		p.outro("shutting down");
		clearInterval(walCheckpointTimer);
		syncAbort.abort();
		retentionAbort.abort();
		await sweeper.stop();
		await retentionRunner.stop();

		// Drain both listeners before closing the shared store.
		await new Promise<void>((resolve) => {
			let remaining = syncServer ? 2 : 1;
			const done = () => {
				if (--remaining === 0) resolve();
			};
			syncServer?.close(done);
			server.close(done);
		}).catch(() => {
			// Best-effort drain — proceed to cleanup.
		});

		try {
			rmSync(pidPath);
		} catch {
			// ignore
		}
		closeStore();
		process.exit(0);
	};

	// Force-exit safety net if graceful shutdown stalls for an unusually long time.
	const forceShutdown = () => {
		setTimeout(() => {
			try {
				rmSync(pidPath);
			} catch {
				// ignore
			}
			closeStore();
			process.exit(1);
		}, 30000).unref();
	};
	process.on("SIGINT", () => {
		forceShutdown();
		void shutdown();
	});
	process.on("SIGTERM", () => {
		forceShutdown();
		void shutdown();
	});
}

async function runServeInvocation(invocation: ResolvedServeInvocation): Promise<void> {
	const dbPath = resolveDbPath(invocation.dbPath ?? undefined);
	if (invocation.mode === "stop" || invocation.mode === "restart") {
		const result = await stopExistingViewer(dbPath, {
			host: invocation.host,
			port: invocation.port,
		});
		if (result.stopped) {
			p.intro("codemem viewer");
			p.log.success(`Stopped viewer${result.pid ? ` (pid ${result.pid})` : ""}`);
			if (invocation.mode === "stop") {
				p.outro("done");
				return;
			}
			// Wait for port to be fully released before restarting.
			const released = await waitForPortRelease(invocation.host, invocation.port);
			if (!released) {
				p.log.warn(`Port ${invocation.port} still in use after stop — restart may fail`);
			}
		} else if (result.pid) {
			p.intro("codemem viewer");
			p.log.error(`Viewer is still shutting down (pid ${result.pid})`);
			process.exitCode = 1;
			return;
		} else if (invocation.mode === "stop") {
			p.intro("codemem viewer");
			p.outro("No background viewer found");
			return;
		}
	}

	if (invocation.mode === "start" || invocation.mode === "restart") {
		if (invocation.background) {
			await startBackgroundViewer({ ...invocation, dbPath });
			return;
		}
		await startForegroundViewer({ ...invocation, dbPath });
	}
}

const serveCmd = new Command("serve")
	.configureHelp(helpStyle)
	.description("Run or manage the viewer")
	.argument("[action]", "lifecycle action (start|stop|restart)");

addDbOption(serveCmd);
addConfigOption(serveCmd);
addViewerHostOptions(serveCmd);

// Legacy lifecycle flags — hidden from --help, emit deprecation warnings when used.
serveCmd.addOption(new Option("--background", "run viewer in background").hideHelp());
serveCmd.addOption(new Option("--foreground", "run viewer in foreground").hideHelp());
serveCmd.addOption(new Option("--stop", "stop background viewer").hideHelp());
serveCmd.addOption(new Option("--restart", "restart background viewer").hideHelp());

export const serveCommand = serveCmd.action(
	async (action: string | undefined, opts: LegacyServeOptions) => {
		try {
			// Emit deprecation warnings for legacy flags
			if (opts.stop) emitDeprecationWarning("--stop", "codemem serve stop");
			if (opts.restart) emitDeprecationWarning("--restart", "codemem serve restart");
			if (opts.background) emitDeprecationWarning("--background", "codemem serve start");
			if (opts.foreground)
				emitDeprecationWarning("--foreground", "codemem serve start --foreground");

			const normalizedAction =
				action === undefined
					? undefined
					: action === "start" || action === "stop" || action === "restart"
						? (action as ServeAction)
						: null;
			if (normalizedAction === null) {
				p.log.error(`Unknown serve action: ${action}`);
				process.exitCode = 1;
				return;
			}
			await runServeInvocation(resolveServeInvocation(normalizedAction, opts));
		} catch (err) {
			p.log.error(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	},
);
