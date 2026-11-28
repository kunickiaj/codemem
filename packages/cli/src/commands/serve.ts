import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import {
	canonicalViewerDbPath,
	initDatabase,
	isEmbeddingDisabled,
	isViewerWriterLockHeld,
	type MemoryStore,
	ObserverClient,
	probeRequiredNativeRuntime,
	RawEventSweeper,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorSyncConfig,
	readViewerWriterLockOwner,
	recordConfiguredCoordinatorHistory,
	resolveCodememConfigPath,
	resolveDbPath,
	resolveKeyPaths,
	runSyncDaemon,
	type SyncDaemonTickCallback,
	VERSION,
	type ViewerWriterLock,
	viewerPidFilePaths,
	viewerRuntimeDir,
} from "@codemem/core";
import type { ReconcileConfiguredCoordinatorEnrollmentResult } from "@codemem/server";
import { Command, Option } from "commander";
import { forwardChildStderr } from "../child-stderr-forward.js";
import { helpStyle } from "../help-style.js";
import { ObserverRuntimeController } from "../observer-runtime-controller.js";
import {
	addConfigOption,
	addDbOption,
	addViewerHostOptions,
	emitDeprecationWarning,
} from "../shared-options.js";
import {
	isLoopbackHost,
	parseViewerPidRecord,
	probeCodememViewerLiveness,
	type ViewerPidRecord,
	viewerUrl,
} from "../viewer-runtime.js";
import { createServeCoordinatorRefresh } from "./serve-coordinator-refresh.js";
import {
	type LegacyServeOptions,
	type ResolvedServeInvocation,
	resolveServeInvocation,
	type ServeAction,
} from "./serve-invocation.js";
import {
	claimViewerWriterLock,
	reportViewerStartup,
	VIEWER_LOCK_WAIT_MS,
	VIEWER_STARTUP_REPORT_ENV,
	type ViewerLockClaimDependencies,
	viewerLockHolderHint,
	waitForViewerStartup,
	waitForViewerWriterLockRelease,
} from "./viewer-lock-claim.js";
import {
	isLikelyViewerCommand,
	listeningPid,
	type ProcessIdentity,
	readProcessCommand,
	readProcessIdentity,
	sameProcess,
	type VerificationDependencies,
	type VerifiedViewer,
	verifyViewerForDatabase,
} from "./viewer-stop-verification.js";

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
	return isLoopbackHost(host);
}

function warnIfViewerExposed(host: string, port: number): void {
	if (isLoopbackOnlyHost(host)) return;
	p.log.warn(
		`Viewer bound to ${host}:${port}. codemem's viewer trust model assumes localhost-only access; do not expose it through a reverse proxy, tunnel, or public bind without adding your own auth layer.`,
	);
}

export { isLikelyViewerCommand } from "./viewer-stop-verification.js";

export function prepareViewerDatabase(dbPath?: string | null): string {
	return initDatabase(dbPath ?? undefined).path;
}

export function pickViewerPidCandidate(
	statsPid: number | null,
	listenerPid: number | null,
): number | null {
	if (statsPid && listenerPid && statsPid !== listenerPid) return null;
	return statsPid ?? listenerPid ?? null;
}

// Runtime files sit beside the canonical database, so a database reached through
// a symlink shares them with its real path, as it shares the Viewer lock.
function pidFilePath(dbPath: string): string {
	return join(viewerRuntimeDir(dbPath), "viewer.pid");
}

export function maintenanceWorkerPidFilePath(dbPath: string): string {
	return join(viewerRuntimeDir(dbPath), "maintenance-worker.pid");
}

function readMaintenanceWorkerPidRecordAt(
	pidPath: string,
): { pid: number; dbPath: string | null } | null {
	if (!existsSync(pidPath)) return null;
	const raw = readFileSync(pidPath, "utf-8").trim();
	try {
		const parsed = JSON.parse(raw) as { pid?: unknown; dbPath?: unknown } | number;
		if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
			return { pid: Math.trunc(parsed), dbPath: null };
		}
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof parsed.pid === "number" &&
			Number.isFinite(parsed.pid) &&
			parsed.pid > 0
		) {
			return {
				pid: Math.trunc(parsed.pid),
				dbPath: typeof parsed.dbPath === "string" ? resolveDbPath(parsed.dbPath) : null,
			};
		}
	} catch {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return { pid: parsed, dbPath: null };
	}
	return null;
}

export function isLikelyMaintenanceWorkerCommand(command: string): boolean {
	const lowered = command.toLowerCase();
	if (!/\bmaintenance\s+worker\b/.test(lowered)) return false;
	return (
		lowered.includes("codemem") ||
		lowered.includes("packages/cli/dist/index.js") ||
		lowered.includes("/cli/dist/index.js") ||
		lowered.includes("packages/cli/src/index.ts")
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function commandHasExactDbPath(command: string, dbPath: string): boolean {
	const escapedPath = escapeRegExp(resolveDbPath(dbPath));
	return new RegExp(`(?:^|\\s)--db-path(?:=|\\s+)${escapedPath}(?:\\s|$)`).test(command);
}

/** The PID records for this database: the current location, then where earlier releases wrote it. */
function readViewerPidRecords(dbPath: string): Array<{ path: string; record: ViewerPidRecord }> {
	return viewerPidFilePaths(resolveDbPath(dbPath)).flatMap((path) => {
		const record = readViewerPidRecordAt(path);
		return record ? [{ path, record }] : [];
	});
}

function readViewerPidRecord(dbPath: string): ViewerPidRecord | null {
	return readViewerPidRecordAt(pidFilePath(dbPath));
}

function readViewerPidRecordAt(pidPath: string): ViewerPidRecord | null {
	if (!existsSync(pidPath)) return null;
	// Shared strict parser keeps `serve` and `codemem status` agreeing on
	// what counts as a valid viewer PID record.
	const parsed = parseViewerPidRecord(readFileSync(pidPath, "utf-8"));
	if (parsed.state === "valid") return parsed.record;
	if (parsed.state === "legacy") return { pid: parsed.pid, host: "127.0.0.1", port: 38888 };
	return null;
}

function removeOwnedViewerPidFile(dbPath: string): void {
	try {
		if (readViewerPidRecord(dbPath)?.pid !== process.pid) return;
		rmSync(pidFilePath(dbPath));
	} catch {
		// Best-effort cleanup; a failed startup may not own a PID record.
	}
}

function normalizeViewerHost(host: string): string {
	const normalized = host.trim().toLowerCase();
	if (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "[::1]"
	) {
		return "loopback";
	}
	return normalized;
}

/** A live Viewer for this database at another address, from either PID record location. */
async function findRuntimeViewerConflict(
	dbPath: string,
	target: { host: string; port: number },
): Promise<ViewerPidRecord | null> {
	for (const { record } of readViewerPidRecords(dbPath)) {
		if (
			normalizeViewerHost(record.host) === normalizeViewerHost(target.host) &&
			record.port === target.port
		)
			continue;
		if (!isProcessRunning(record.pid)) continue;
		if (await respondsLikeCodememViewer(record)) return record;
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

export async function respondsLikeCodememViewer(
	record: ViewerPidRecord,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const result = await probeCodememViewerLiveness(record, {
		fetch: fetchImpl,
		timeoutMs: 1000,
	});
	return result.state === "live";
}

async function lookupViewerPidFromStats(host: string, port: number): Promise<number | null> {
	try {
		const res = await fetch(viewerUrl({ host, port }, "/api/stats"), {
			signal: AbortSignal.timeout(1000),
		});
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

export interface TerminateOptions {
	gracefulMs?: number;
	forceMs?: number;
	/** Reads the process's identity; tests replace it. */
	readIdentity?: (pid: number) => ProcessIdentity | null;
}

/** The outcome of a stop: whether a signal was sent, and whether the process is gone. */
export interface Termination {
	signalled: boolean;
	stopped: boolean;
}

type Confirmation = "same" | "changed" | "not-target" | "unknown";

/**
 * Whether `pid` still names the verified process. The proof that chose it runs first and
 * the identity read last, so nothing is checked between that read and the signal.
 * "changed" means the pid names another process now: the verified one has exited.
 */
function confirmVerified(
	viewer: Pick<VerifiedViewer, "pid" | "identity" | "recheck">,
	readIdentity: (pid: number) => ProcessIdentity | null,
): Confirmation {
	const proven = viewer.recheck();
	const now = readIdentity(viewer.pid);
	if (now && !sameProcess(now, viewer.identity)) return "changed";
	if (!proven) return "not-target";
	return now ? "same" : "unknown";
}

/**
 * Stops a verified process: SIGTERM, then after the wait SIGKILL. Each signal is sent only
 * when the pid still names the process as it was verified and it still passes its proof.
 * A process that exited during the wait, whose pid may name another process now, is
 * never signalled again.
 */
async function terminateVerified(
	viewer: Pick<VerifiedViewer, "pid" | "identity" | "recheck">,
	options: TerminateOptions = {},
): Promise<Termination> {
	const readIdentity = options.readIdentity ?? readProcessIdentity;
	const { pid } = viewer;
	if (confirmVerified(viewer, readIdentity) !== "same") return { signalled: false, stopped: false };
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return { signalled: true, stopped: true };
	}
	if (await waitForProcessExit(pid, options.gracefulMs ?? 30000))
		return { signalled: true, stopped: true };

	// A stuck better-sqlite3 maintenance query blocks the target process's JS signal
	// handler, so graceful shutdown can never run, and lifecycle commands escalate rather
	// than require a manual kill -9.
	const confirmation = confirmVerified(viewer, readIdentity);
	if (confirmation === "changed") return { signalled: true, stopped: true };
	if (confirmation !== "same") return { signalled: true, stopped: false };
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		return { signalled: true, stopped: true };
	}
	return { signalled: true, stopped: await waitForProcessExit(pid, options.forceMs ?? 5000) };
}

/**
 * Stops a process its caller has just checked, such as a maintenance worker. Its identity
 * is read once before SIGTERM and must match again before SIGKILL; when it cannot be read,
 * SIGTERM is the only signal.
 */
async function terminateProcessPid(pid: number, options: TerminateOptions = {}): Promise<boolean> {
	const readIdentity = options.readIdentity ?? readProcessIdentity;
	const identity = readIdentity(pid);
	if (!identity) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return true;
		}
		return waitForProcessExit(pid, options.gracefulMs ?? 30000);
	}
	return (await terminateVerified({ pid, identity, recheck: () => true }, options)).stopped;
}

/** Stops a Viewer that `verifyViewerForDatabase` verified. */
export async function terminateVerifiedViewer(
	viewer: Pick<VerifiedViewer, "pid" | "identity" | "recheck">,
	options: TerminateOptions = {},
): Promise<Termination> {
	return terminateVerified(viewer, options);
}

/**
 * Stops a leftover maintenance worker for this database. Reads the current PID
 * record and the one an older release left beside the database path as given,
 * where a worker that outlived a Viewer started through a symlink recorded
 * itself. False when a recorded worker is not trusted or did not stop.
 */
export async function terminateTrustedMaintenanceWorker(
	dbPath: string,
	timeouts: TerminateOptions = {},
): Promise<boolean> {
	const paths = [
		...new Set([
			maintenanceWorkerPidFilePath(dbPath),
			join(dirname(resolveDbPath(dbPath)), "maintenance-worker.pid"),
		]),
	];
	let allStopped = true;
	for (const pidPath of paths) {
		if (!(await terminateRecordedMaintenanceWorker(pidPath, dbPath, timeouts))) allStopped = false;
	}
	return allStopped;
}

async function terminateRecordedMaintenanceWorker(
	pidPath: string,
	dbPath: string,
	timeouts: TerminateOptions,
): Promise<boolean> {
	const record = readMaintenanceWorkerPidRecordAt(pidPath);
	if (!record) return true;
	const isThisDb = (path: string | null): path is string =>
		path !== null && canonicalViewerDbPath(path) === canonicalViewerDbPath(dbPath);
	if (record.dbPath && !isThisDb(record.dbPath)) return false;
	if (!isProcessRunning(record.pid)) {
		removeFile(pidPath);
		return true;
	}
	const command = readProcessCommand(record.pid);
	if (!command || !isLikelyMaintenanceWorkerCommand(command)) return false;
	// The worker runs with the path it was started with, which may be a symlink.
	if (!isThisDb(record.dbPath) || !commandHasExactDbPath(command, record.dbPath)) return false;
	const stopped = await terminateProcessPid(record.pid, timeouts);
	if (stopped) removeFile(pidPath);
	return stopped;
}

async function waitForPortRelease(host: string, port: number, timeoutMs = 10000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await isPortOpen(host, port))) return true;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
}

export const viewerLockDependencies: ViewerLockClaimDependencies = {
	isLockHeld: isViewerWriterLockHeld,
	isLiveViewer: (owner) =>
		respondsLikeCodememViewer({ pid: owner.pid, host: owner.host, port: owner.port }),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface StopViewerResult {
	stopped: boolean;
	pid: number | null;
	/** A Viewer that was found but not signalled, and why. */
	refused?: { pid: number; host: string; port: number; reason: string };
}

export type StopViewerOptions = Pick<TerminateOptions, "gracefulMs" | "forceMs" | "readIdentity"> &
	Pick<VerificationDependencies, "platform">;

type Candidate = { pid: number } | null;

/**
 * The codemem Viewer to consider at `target`: on macOS and Linux the process listening on
 * the port, else the pid its answer names, which verification then refuses because it is
 * not the listener. Null when no codemem Viewer is there, so that an unrelated listener is
 * not reported.
 */
async function viewerCandidateAt(
	target: { host: string; port: number },
	options: StopViewerOptions,
): Promise<Candidate> {
	if (!isLocalHost(target.host)) return null;
	const statsPid = await lookupViewerPidFromStats(target.host, target.port);
	if ((options.platform ?? process.platform) === "win32")
		return statsPid ? { pid: statsPid } : null;
	const listener = listeningPid(target.port);
	// Without a listener to name, the answering pid goes to verification, which refuses it
	// and says why.
	const pid = (listener.ok ? listener.pid : null) ?? statsPid;
	if (!pid) return null;
	const command = (options.readIdentity ?? readProcessIdentity)(pid)?.command;
	return command && isLikelyViewerCommand(command) ? { pid } : null;
}

type StopAttempt =
	| { stopped: boolean; pid: number }
	| { refused: NonNullable<StopViewerResult["refused"]> };

/** Verifies that Viewer `pid` at `address` serves this database, then stops it. */
async function stopVerifiedViewer(
	pid: number,
	address: { host: string; port: number },
	dbPath: string,
	options: StopViewerOptions,
): Promise<StopAttempt> {
	const verification = await verifyViewerForDatabase(pid, address, dbPath, options);
	if (!verification.ok) return { refused: { pid, ...address, reason: verification.reason } };
	const termination = await terminateVerifiedViewer(verification.viewer, options);
	if (!termination.signalled)
		return {
			refused: {
				pid,
				...address,
				reason: "its process changed or stopped serving the database before it could be signalled",
			},
		};
	return { stopped: termination.stopped, pid };
}

/** Tries the Viewers this database's PID records name; the first stopped, or the first refusal. */
async function stopRecordedViewers(
	dbPath: string,
	options: StopViewerOptions,
): Promise<StopAttempt | null> {
	let refusal: StopAttempt | null = null;
	// The current record first, then the one an older release left beside the
	// database path as given. Each passes the same checks before it is stopped.
	for (const { path, record } of readViewerPidRecords(dbPath)) {
		if (!isLocalHost(record.host) || !(await respondsLikeCodememViewer(record))) continue;
		const attempt = await stopVerifiedViewer(record.pid, record, dbPath, options);
		if ("refused" in attempt) {
			refusal ??= attempt;
			continue;
		}
		if (attempt.stopped) removeFile(path);
		return attempt;
	}
	return refusal;
}

export async function stopExistingViewer(
	dbPath: string,
	target: { host: string; port: number },
	/** Timeouts and readers that tests replace. */
	options: StopViewerOptions = {},
): Promise<StopViewerResult> {
	const candidate = await viewerCandidateAt(target, options);
	const atPort = candidate
		? await stopVerifiedViewer(candidate.pid, target, dbPath, options)
		: null;
	if (atPort && !("refused" in atPort)) {
		if (atPort.stopped) removeStoppedViewerPidRecords(dbPath, atPort.pid);
		return atPort;
	}
	const recorded = await stopRecordedViewers(dbPath, options);
	if (recorded && !("refused" in recorded)) return recorded;
	const refusal = atPort ?? recorded;
	return {
		stopped: false,
		pid: null,
		...(refusal && "refused" in refusal ? { refused: refusal.refused } : {}),
	};
}

function removeFile(path: string): void {
	try {
		rmSync(path);
	} catch {
		// ignore
	}
}

/** After a stop: the current PID record, and an older release's record for the same process. */
function removeStoppedViewerPidRecords(dbPath: string, pid: number): void {
	const [current, ...older] = viewerPidFilePaths(resolveDbPath(dbPath));
	if (current) removeFile(current);
	for (const path of older) if (readViewerPidRecordAt(path)?.pid === pid) removeFile(path);
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

export function buildMaintenanceWorkerArgs(
	scriptPath: string,
	invocation: ResolvedServeInvocation,
	execArgv: string[] = process.execArgv,
): string[] {
	const args = [...execArgv, scriptPath, "maintenance", "worker"];
	if (invocation.dbPath) args.push("--db-path", invocation.dbPath);
	if (invocation.configPath) args.push("--config", invocation.configPath);
	return args;
}

const MAINTENANCE_WORKER_LOG_PREFIX = "[maintenance-worker] ";

function startMaintenanceWorkerProcess(invocation: ResolvedServeInvocation): ChildProcess | null {
	const scriptPath = process.argv[1];
	if (!scriptPath) {
		p.log.warn("Unable to resolve CLI entrypoint for maintenance worker launch");
		return null;
	}
	const dbPath = resolveDbPath(invocation.dbPath ?? undefined);
	const child = spawn(process.execPath, buildMaintenanceWorkerArgs(scriptPath, invocation), {
		cwd: process.cwd(),
		// Forward stderr so the worker's warnings and failures reach the viewer's logs.
		stdio: ["ignore", "ignore", "pipe"],
		env: {
			...process.env,
			CODEMEM_DB: dbPath,
			...(invocation.configPath ? { CODEMEM_CONFIG: invocation.configPath } : {}),
		},
	});
	if (child.stderr) {
		forwardChildStderr(child.stderr, { prefix: MAINTENANCE_WORKER_LOG_PREFIX });
		// Like child.unref(): the open pipe must not keep the viewer alive on its own.
		(child.stderr as Partial<Socket>).unref?.();
	}
	child.unref();
	if (child.pid) {
		writeFileSync(
			maintenanceWorkerPidFilePath(dbPath),
			JSON.stringify({ pid: child.pid, dbPath }),
			"utf-8",
		);
		p.log.step(`Maintenance worker started (pid ${child.pid})`);
	}
	return child;
}

async function stopMaintenanceWorkerProcess(
	child: ChildProcess | null,
	dbPath: string,
): Promise<void> {
	if (child?.pid && isProcessRunning(child.pid)) {
		await terminateProcessPid(child.pid, { gracefulMs: 5000, forceMs: 5000 });
	} else {
		await terminateTrustedMaintenanceWorker(dbPath, { gracefulMs: 5000, forceMs: 5000 });
	}
	try {
		rmSync(maintenanceWorkerPidFilePath(dbPath));
	} catch {
		// ignore
	}
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

export interface RequiredNativeRuntimeDiagnosticContext {
	version: string;
	nodeVersion: string;
	platform: NodeJS.Platform;
	arch: string;
}

export function requiredNativeRuntimeFailureDiagnostics(
	error: unknown,
	context: RequiredNativeRuntimeDiagnosticContext = {
		version: VERSION,
		nodeVersion: process.version,
		platform: process.platform,
		arch: process.arch,
	},
): string[] {
	const detail = error instanceof Error ? error.message : String(error);
	return [
		"Required SQLite native binding is unavailable.",
		`Runtime: Node ${context.nodeVersion} on ${context.platform}/${context.arch}.`,
		`Details: ${detail}`,
		`Reinstall this exact codemem version: npm install -g codemem@${context.version}`,
		"Use Node 24.15+ on a supported 64-bit macOS, Linux, or Windows target; see the native install matrix for current platform coverage.",
		"This required better-sqlite3 failure is separate from optional sqlite-vec loading, which can fall back to lexical search.",
	];
}

export type ServeNativeRuntimePreflightResult =
	| { state: "ready" }
	| { state: "already_running" }
	| { state: "unavailable"; diagnostics: string[] };

export async function preflightServeNativeRuntime(
	invocation: ResolvedServeInvocation,
	dependencies: {
		isPortOpen: (host: string, port: number) => Promise<boolean>;
		probe: () => void;
	} = {
		isPortOpen,
		probe: probeRequiredNativeRuntime,
	},
): Promise<ServeNativeRuntimePreflightResult> {
	if (
		invocation.mode === "start" &&
		(await dependencies.isPortOpen(invocation.host, invocation.port))
	) {
		return { state: "already_running" };
	}

	try {
		dependencies.probe();
		return { state: "ready" };
	} catch (error) {
		return { state: "unavailable", diagnostics: requiredNativeRuntimeFailureDiagnostics(error) };
	}
}

async function nativeRuntimeAllowsServeStart(
	invocation: ResolvedServeInvocation,
): Promise<boolean> {
	if (invocation.mode !== "start" && invocation.mode !== "restart") return true;

	const preflight = await preflightServeNativeRuntime(invocation);
	if (preflight.state === "already_running") {
		const message = `Viewer already running at http://${invocation.host}:${invocation.port}`;
		p.log.warn(message);
		reportViewerStartup({ state: "failed", message });
		if (!invocation.background) process.exitCode = 1;
		return false;
	}
	if (preflight.state === "ready") return true;

	p.intro("codemem viewer");
	for (const line of preflight.diagnostics) p.log.error(line);
	reportViewerStartup({ state: "failed", message: preflight.diagnostics.join(" ") });
	process.exitCode = 1;
	return false;
}

export interface ServeCoordinatorMaintenanceResult {
	projectShares: { processed: number; failed: number };
	coordinatorEnrollment: {
		groupsProcessed: number;
		failedGroups: number;
		issues?: number;
		failures?: ReconcileConfiguredCoordinatorEnrollmentResult["failures"];
	};
	recipientPolicies: { processed: number; failed: number };
	legacyPairingAssignments: { status: string; waitingReason: string | null };
}

type ServeCoordinatorMaintenanceDependencies = Parameters<typeof runServeCoordinatorMaintenance>[1];

function createServeCoordinatorMaintenanceDependencies(
	server: typeof import("@codemem/server"),
): ServeCoordinatorMaintenanceDependencies {
	return {
		advancePendingProjectShares: (store, options) =>
			server.advancePendingProjectSharesOperation(store, {
				...options,
				advanceOperation: server.advanceProjectShareOperation,
			}),
		reconcileConfiguredCoordinatorEnrollment: server.reconcileConfiguredCoordinatorEnrollment,
		convertLegacyPairingAssignments: server.convertLegacyPairingAssignmentsOperation,
		reconcileRecipientPolicyProjects: (store, options) =>
			server.reconcileRecipientPolicyProjectsOperation(store, {
				...options,
				effects: server.createRecipientPolicyReconcilerEffects(store),
			}),
	};
}

function coordinatorEnrollmentFailureMessage(result: {
	failedGroups: number;
	issues?: number;
	failures?: ReconcileConfiguredCoordinatorEnrollmentResult["failures"];
}): string {
	const groupLabel = result.failedGroups === 1 ? "group" : "groups";
	const issueCount = result.issues ?? 0;
	const issueLabel = issueCount === 1 ? "issue" : "issues";
	const failures = result.failures ?? [];
	const failureDetail = failures.length
		? ` [${failures
				.slice(0, 3)
				.map((failure) => `${failure.groupId}:${failure.stage}:${failure.code}`)
				.join(", ")}${failures.length > 3 ? `, +${failures.length - 3} more` : ""}]`
		: "";
	const hiddenTimeout = failures.slice(3).some((failure) => failure.code === "request_timeout");
	return `coordinator enrollment maintenance failed for ${result.failedGroups} ${groupLabel} with ${issueCount} reconciliation ${issueLabel}${failureDetail}${hiddenTimeout ? " (coordinator_timeout)" : ""}`;
}

export async function runServeCoordinatorMaintenance(
	store: MemoryStore,
	dependencies: {
		advancePendingProjectShares: (
			store: MemoryStore,
			options: { limit: number },
		) => Promise<{ processed: number; failed: number }>;
		reconcileRecipientPolicyProjects: (
			store: MemoryStore,
			options: { limit: number },
		) => Promise<{ processed: number; failed: number }>;
		reconcileConfiguredCoordinatorEnrollment: (store: MemoryStore) => Promise<{
			groupsProcessed: number;
			failedGroups: number;
			issues?: number;
			failures?: ReconcileConfiguredCoordinatorEnrollmentResult["failures"];
		}>;
		convertLegacyPairingAssignments: (
			store: MemoryStore,
		) => Promise<{ status: string; waitingReason: string | null }>;
	},
): Promise<ServeCoordinatorMaintenanceResult> {
	const projectShares = await dependencies.advancePendingProjectShares(store, { limit: 3 });
	const coordinatorEnrollment = await dependencies.reconcileConfiguredCoordinatorEnrollment(store);
	const enrollmentIssues = coordinatorEnrollment.issues ?? 0;
	// After enrollment, so a binding the coordinator supplies wins. Before policies, which read bindings.
	const legacyPairingAssignments = await dependencies.convertLegacyPairingAssignments(store);
	const recipientPolicies = await dependencies.reconcileRecipientPolicyProjects(store, {
		limit: 3,
	});
	if (projectShares.failed > 0) {
		throw new Error(
			`share operation maintenance failed for ${projectShares.failed} of ${projectShares.processed} operations`,
		);
	}
	if (coordinatorEnrollment.failedGroups > 0) {
		throw new Error(coordinatorEnrollmentFailureMessage(coordinatorEnrollment));
	}
	if (enrollmentIssues > 0) {
		const issueLabel = enrollmentIssues === 1 ? "issue" : "issues";
		throw new Error(
			`coordinator enrollment reconciliation found ${enrollmentIssues} ${issueLabel}`,
		);
	}
	if (recipientPolicies.failed > 0) {
		throw new Error(
			`recipient policy maintenance failed for ${recipientPolicies.failed} of ${recipientPolicies.processed} projects`,
		);
	}
	return { projectShares, coordinatorEnrollment, recipientPolicies, legacyPairingAssignments };
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
		// The IPC channel carries the startup result and closes once the Viewer reports it.
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		env: {
			...process.env,
			...(invocation.dbPath ? { CODEMEM_DB: invocation.dbPath } : {}),
			...(invocation.configPath ? { CODEMEM_CONFIG: invocation.configPath } : {}),
			[VIEWER_STARTUP_REPORT_ENV]: "1",
		},
	});
	// The Viewer writes its own PID record once it holds the lock and serves, so a
	// start that loses the lock never replaces the running Viewer's record.
	const startup = await waitForViewerStartup(child, BACKGROUND_STARTUP_WAIT_MS);
	child.unref();
	p.intro("codemem viewer");
	if (startup.state === "failed") {
		p.log.error(startup.message);
		process.exitCode = 1;
		return;
	}
	const url = `http://${invocation.host}:${invocation.port}`;
	p.outro(
		startup.state === "listening"
			? `Viewer started in background (pid ${child.pid}) at ${url}`
			: `Viewer is starting in background (pid ${child.pid}) at ${url}`,
	);
}

/**
 * How long a background start waits for the Viewer's startup result. It covers
 * the Viewer's own wait for a releasing lock holder and stays under the plugin's
 * default 20-second command timeout. A Viewer that holds the lock but is still
 * preparing its database at that point counts as starting.
 */
const BACKGROUND_STARTUP_WAIT_MS = 15_000;

function startRawEventProcessing(
	dbPath: string,
	store: MemoryStore,
	observer: ObserverClient,
	createInbox: typeof import("@codemem/server").createViewerRawEventInbox,
) {
	const sweeper = new RawEventSweeper(store, { observer });
	const observerRuntime = new ObserverRuntimeController(
		observer,
		sweeper,
		() => new ObserverClient(),
	);
	sweeper.start();
	const queue = createInbox({
		dbPath,
		sweeper,
		onDrainError: () => {
			p.log.warn("Raw-event database ingestion is delayed; accepted events remain queued");
		},
		onDrainRecovered: () => {
			p.log.info("Raw-event database ingestion recovered");
		},
		onCorruptEntries: (count) => {
			p.log.error(`Raw-event queue contains ${count} corrupt retained entries`);
		},
		onBacklog: (pending, oldestAgeMs) => {
			p.log.warn(
				`Raw-event queue backlog is sustained (${pending} pending, oldest ${Math.ceil(oldestAgeMs / 1000)}s)`,
			);
		},
		onBacklogRecovered: () => {
			p.log.info("Raw-event queue backlog recovered");
		},
	});
	queue.inbox.start();
	const rawEventTarget = createRawEventTargetState(store);
	return {
		appOptions: {
			rawEventInbox: queue.inbox,
			rawEventTarget,
			sweeper,
			getObserver: () => observerRuntime.getObserver(),
			scheduleObserverApply: () => observerRuntime.requestApply(),
			getObserverApplyStatus: () => observerRuntime.getStatus(),
		},
		stop: async () => {
			rawEventTarget.stop();
			await observerRuntime.stop();
			await queue.stop();
			await sweeper.stop();
		},
	};
}

export function createRawEventTargetState(
	store: Pick<
		MemoryStore,
		| "actorId"
		| "dbPath"
		| "deviceId"
		| "hasCurrentConfiguredIdentity"
		| "hasCurrentIdentity"
		| "onIdentityChanged"
	>,
) {
	let hasCurrentIdentity = false;
	let actorId = store.actorId;
	let deviceId = store.deviceId;
	const refreshCurrentIdentity = () => {
		try {
			hasCurrentIdentity = store.hasCurrentIdentity();
		} catch {
			hasCurrentIdentity = false;
		}
		actorId = store.actorId;
		deviceId = store.deviceId;
	};
	refreshCurrentIdentity();
	const stop = store.onIdentityChanged(refreshCurrentIdentity);
	return {
		dbPath: store.dbPath,
		hasCurrentIdentity: () => {
			if (!hasCurrentIdentity || actorId !== store.actorId || deviceId !== store.deviceId) {
				return false;
			}
			try {
				return store.hasCurrentConfiguredIdentity();
			} catch {
				return false;
			}
		},
		stop,
	};
}

function createOptionalOwnerRecovery(
	serverModule: typeof import("@codemem/server"),
	options: Parameters<typeof serverModule.createAccountOwnerRecoveryService>[0],
) {
	if (
		!("createAccountOwnerRecoveryService" in serverModule) ||
		typeof serverModule.createAccountOwnerRecoveryService !== "function"
	)
		return undefined;
	return serverModule.createAccountOwnerRecoveryService(options);
}

/** The People name Sharing shows for an Identity; absent when the local store has none. */
function localIdentityName(store: MemoryStore, identityId: string): string | undefined {
	try {
		const row = store.db
			.prepare("SELECT display_name FROM actors WHERE actor_id = ? AND status <> 'deactivated'")
			.get(identityId) as { display_name?: unknown } | undefined;
		const name = typeof row?.display_name === "string" ? row.display_name.trim() : "";
		return name || undefined;
	} catch {
		return undefined;
	}
}

function createViewerAccountLink(
	store: MemoryStore,
	invocation: ResolvedServeInvocation,
	serverModule: typeof import("@codemem/server"),
) {
	const configPath = resolveCodememConfigPath(invocation.configPath ?? undefined).resolved.path;
	const keysDir = dirname(resolveKeyPaths(process.env.CODEMEM_KEYS_DIR?.trim() || undefined)[0]);
	const identityName = (identityId: string) => localIdentityName(store, identityId);
	const readContext = serverModule.createAccountContextReader({
		getProfile: () => ({
			dbPath: store.dbPath,
			deviceId: store.deviceId,
			identityId: store.actorId,
			identityLabel: store.actorDisplayName,
		}),
		readConfig: () => readCodememConfigFileAtPath(configPath),
		configPath,
		keysDir,
	});
	const registry = serverModule.createAccountLinkRegistry({
		readContext,
		rebind: serverModule.createAccountRebindRunner(store),
	});
	// A switch an earlier run left open resumes from its record; failures wait for the next start.
	void serverModule.resumeAccountRebind(store, { keysDir, configPath }).catch(() => {});
	const ownerRecovery = createOptionalOwnerRecovery(serverModule, {
		readContext,
		registry,
		readAdminSecret: () => {
			const envSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET?.trim();
			if (envSecret) return envSecret;
			const secret = readCodememConfigFileAtPath(configPath).sync_coordinator_admin_secret;
			return typeof secret === "string" ? secret.trim() : null;
		},
		readCoordinatorTimeoutS: () =>
			readCoordinatorSyncConfig(readCodememConfigFileAtPath(configPath)).syncCoordinatorTimeoutS,
	});
	let actualBoundPort: number | null = null;
	return {
		registry,
		ownerRecovery,
		close: async () => {
			if (ownerRecovery) await ownerRecovery.close();
			await registry.close();
		},
		setBoundPort: (port: number) => {
			actualBoundPort = port;
		},
		options: {
			readContext,
			registry,
			ownerRecovery,
			identityName,
			getListenerAddress: () =>
				actualBoundPort === null ? null : { host: invocation.host, port: actualBoundPort },
		},
	};
}
function announceViewerStartup(options: {
	pidPath: string;
	invocation: ResolvedServeInvocation;
	preparedDb: string;
	info: { address: string; port: number };
}): void {
	const { pidPath, invocation, preparedDb, info } = options;
	writeFileSync(
		pidPath,
		JSON.stringify({ pid: process.pid, host: invocation.host, port: invocation.port }),
		"utf-8",
	);
	p.intro("codemem viewer");
	p.log.success(`Listening on http://${info.address}:${info.port}`);
	p.log.info(`Database: ${preparedDb}`);
	p.log.step("Raw event sweeper started");
}
type ServeSyncRuntimeStatus = {
	phase: "starting" | "running" | "stopping" | "error" | "disabled" | null;
	detail: string | null;
};

type ServeRelay = Pick<
	import("@codemem/server").ViewerRelayReachability,
	"reachability" | "refresh" | "close"
>;

const logRelay = (message: string, level: "info" | "warn") =>
	level === "warn" ? p.log.warn(message) : p.log.info(message);

/**
 * Relay additions to the sync daemon options. Without relay this returns the
 * callback unchanged and no `reachability`, so sync runs exactly as before.
 * With relay, groups re-resolve after every coordinator refresh, even a failed one.
 */
export function serveRelayDaemonOptions(
	relay: ServeRelay | null,
	onAfterCoordinatorRefresh: SyncDaemonTickCallback,
): {
	reachability?: ServeRelay["reachability"];
	onAfterCoordinatorRefresh: SyncDaemonTickCallback;
} {
	if (!relay) return { onAfterCoordinatorRefresh };
	return {
		reachability: relay.reachability,
		onAfterCoordinatorRefresh: async (context) => {
			try {
				await onAfterCoordinatorRefresh(context);
			} finally {
				await relay.refresh();
			}
		},
	};
}

function applySyncPhase(
	status: ServeSyncRuntimeStatus,
	phase: "starting" | "running" | "stopping",
): void {
	if (phase === "running") {
		status.phase = null;
		status.detail = null;
		return;
	}
	status.phase = phase;
	status.detail =
		phase === "starting" ? "Running initial sync in background" : "Stopping sync daemon";
}

function startServeSyncDaemon(options: {
	invocation: ResolvedServeInvocation;
	syncConfig: ReturnType<typeof readCoordinatorSyncConfig>;
	store: MemoryStore;
	signal: AbortSignal;
	status: ServeSyncRuntimeStatus;
	maintenance: ServeCoordinatorMaintenanceDependencies;
	relay: ServeRelay | null;
	coordinatorRefresh: ReturnType<typeof createServeCoordinatorRefresh>["daemon"];
}): void {
	const { syncConfig, store, signal, status, relay } = options;
	status.phase = "starting";
	status.detail = "Starting sync in background";
	void relay?.refresh();
	void runSyncDaemon({
		dbPath: resolveDbPath(options.invocation.dbPath ?? undefined),
		intervalS: syncConfig.syncIntervalS,
		host: syncConfig.syncHost,
		port: syncConfig.syncPort,
		signal,
		...options.coordinatorRefresh,
		// Foreground mode: hand the daemon the same workspace-aware
		// scanner the local writes use, so workspace `secret_scanner`
		// rules apply to inbound peer payloads instead of the daemon
		// silently falling back to the built-in default ruleset.
		scanner: store.scanner,
		...serveRelayDaemonOptions(relay, async () => {
			await runServeCoordinatorMaintenance(store, options.maintenance);
		}),
		onPhaseChange: (phase) => applySyncPhase(status, phase),
	})
		.catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			status.phase = "error";
			status.detail = msg;
			p.log.error(`Sync daemon failed: ${msg}`);
		})
		.finally(() => {
			void relay?.close();
			if (status.phase !== "error") {
				status.phase = signal.aborted ? "stopping" : null;
				status.detail = signal.aborted ? "Sync stopped" : null;
			}
		});
}

function scheduleServeSyncDaemon(options: Parameters<typeof startServeSyncDaemon>[0]): void {
	const delayMs = 3000;
	p.log.step(`Sync daemon will start in background (${delayMs / 1000}s delay)`);
	setTimeout(() => startServeSyncDaemon(options), delayMs).unref();
}

/**
 * Runs a memory tool for a thin host through the same in-process MCP handlers
 * as stdio and `codemem memory-tool`. Loaded lazily so viewer startup does not
 * pull in the MCP SDK until a host actually calls a tool.
 */
export async function callMemoryToolForHost(
	store: MemoryStore,
	name: string,
	args: Record<string, unknown>,
	caller: {
		cwd: string;
		envProject: string | null;
		sessionId?: string;
		requestId?: string;
		statelessLedger: true;
	},
): Promise<unknown> {
	const { callCodememToolLocally } = await import("@codemem/mcp");
	return callCodememToolLocally(store, name, args, caller);
}

/** How often the running service checks Team setup completions with the coordinator. */
const TEAM_SETUP_RECONCILIATION_INTERVAL_MS = 5 * 60_000;

function foregroundAppOptions(
	store: MemoryStore,
	rawEventOptions: ReturnType<typeof startRawEventProcessing>["appOptions"],
	options: {
		accountLink: ReturnType<typeof createViewerAccountLink>;
		relay: ServeRelay | null;
		syncRuntimeStatus: ServeSyncRuntimeStatus;
		coordinatorRefresh: ReturnType<typeof createServeCoordinatorRefresh>["viewer"];
	},
) {
	return {
		accountLink: options.accountLink.options,
		storeFactory: () => store,
		syncReachability: options.relay?.reachability,
		...rawEventOptions,
		...options.coordinatorRefresh,
		getSyncRuntimeStatus: () => options.syncRuntimeStatus,
		// Team setup checks completions with the coordinator off the request path.
		teamSetupReconciliationIntervalMs: TEAM_SETUP_RECONCILIATION_INTERVAL_MS,
	};
}

function createBoundApp(
	createApp: typeof import("@codemem/server").createApp,
	options: Parameters<typeof createApp>[0],
	listener: {
		invocation: ResolvedServeInvocation;
		accountLink: ReturnType<typeof createViewerAccountLink>;
	},
) {
	let boundAddress: { host: string; port: number; address: string } | null = null;
	return {
		app: createApp({
			...options,
			viewerAuthority: { getListenerAddress: () => boundAddress },
			memoryToolCall: callMemoryToolForHost,
		}),
		setBoundAddress: (info: { address: string; port: number }) => {
			boundAddress = { host: listener.invocation.host, port: info.port, address: info.address };
			listener.accountLink.setBoundPort(info.port);
		},
	};
}

/** Referenced for the process lifetime, so its connection, and the lock, stay open. */
let heldViewerWriterLock: ViewerWriterLock | null = null;

/**
 * Takes the database's Viewer lock, then stops a leftover maintenance worker;
 * false when another Viewer holds the lock. The pid file check before it is
 * advisory and can race. The lock cannot, so two Viewers never interleave Team
 * setup changes whose locks only work inside one process.
 */
async function takeOverViewerRuntime(
	dbPath: string,
	target: { host: string; port: number },
): Promise<boolean> {
	const claim = await claimViewerWriterLock(dbPath, target, viewerLockDependencies);
	if (claim.status === "refused") {
		reportViewerStartup({ state: "failed", message: claim.message });
		p.intro("codemem viewer");
		p.log.error(claim.message);
		process.exitCode = 1;
		return false;
	}
	// Held until this process exits; the OS releases it even after a crash.
	heldViewerWriterLock = claim.lock;
	reportViewerStartup({ state: "lock_acquired" });
	if (!(await terminateTrustedMaintenanceWorker(dbPath, { gracefulMs: 1000, forceMs: 5000 }))) {
		p.log.warn(
			"Existing maintenance worker is not trusted or did not stop; starting viewer anyway",
		);
	}
	return true;
}

/**
 * Open the Viewer's store. When sqlite-vec cannot load, the Viewer starts with embeddings
 * disabled. The Viewer answers requests while packs are built, so its store assembles
 * packs in a worker thread.
 */
async function openViewerStore(
	dbPath: string,
	server: { getStore: () => MemoryStore; closeStoreAsync: () => Promise<void> },
): Promise<MemoryStore> {
	let store: MemoryStore;
	try {
		store = server.getStore();
	} catch (err) {
		if (isEmbeddingDisabled() || !isSqliteVecLoadFailure(err)) {
			throw err;
		}

		p.log.warn("sqlite-vec failed to load; retrying viewer startup with embeddings disabled");
		for (const line of sqliteVecFailureDiagnostics(err, dbPath)) {
			p.log.warn(`sqlite-vec diagnostic: ${line}`);
		}
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		await server.closeStoreAsync();
		store = server.getStore();
		p.log.warn("Embeddings disabled for this viewer process; raw-event ingestion remains active.");
	}
	store.enablePackWorker();
	// Before any listener opens, so a coordinator set in the config file or the environment is
	// on record even when no refresh runs.
	recordConfiguredCoordinatorHistory(store.db, readCoordinatorSyncConfig());
	return store;
}

/**
 * The sync listener is network-facing, so it runs on the guarded server. Its
 * routes and any direct Noise streams share one request limiter.
 */
function syncListenerOptions(
	serverModule: typeof import("@codemem/server"),
	appOpts: ReturnType<typeof foregroundAppOptions>,
	syncConfig: { syncHost: string; syncPort: number },
) {
	const limiter = serverModule.createInMemoryRequestRateLimiter();
	const syncApp = serverModule.createSyncApp({ ...appOpts, syncRequestRateLimit: { limiter } });
	const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
	return {
		fetch: syncApp.fetch,
		hostname: syncConfig.syncHost,
		port: syncConfig.syncPort,
		createServer: serverModule.createGuardedSyncServer({
			limiter,
			directNoise: { storeFactory: appOpts.storeFactory, keysDir },
		}),
	};
}

export async function startForegroundViewer(invocation: ResolvedServeInvocation): Promise<void> {
	const serverModule = await import("@codemem/server");
	const { createApp, closeStoreAsync, createViewerRawEventInbox, getStore } = serverModule;
	const createRawEventInbox = createViewerRawEventInbox;
	const coordinatorMaintenanceDependencies =
		createServeCoordinatorMaintenanceDependencies(serverModule);
	const { serve } = await import("@hono/node-server");

	if (invocation.dbPath) process.env.CODEMEM_DB = invocation.dbPath;
	if (invocation.configPath) process.env.CODEMEM_CONFIG = invocation.configPath;
	warnIfViewerExposed(invocation.host, invocation.port);
	const dbPath = resolveDbPath(invocation.dbPath ?? undefined);
	if (!(await takeOverViewerRuntime(dbPath, invocation))) return;
	const preparedDb = prepareViewerDatabase(invocation.dbPath);

	const observer = new ObserverClient();
	const store = await openViewerStore(dbPath, { getStore, closeStoreAsync });

	const rawEventProcessing = startRawEventProcessing(dbPath, store, observer, createRawEventInbox);

	const syncAbort = new AbortController();
	const config = invocation.configPath
		? readCodememConfigFileAtPath(invocation.configPath)
		: readCodememConfigFile();
	const syncConfig = readCoordinatorSyncConfig(config);
	const syncEnabled = syncConfig.syncEnabled;
	const accountLink = createViewerAccountLink(store, invocation, serverModule);
	// Null unless sync, a coordinator, and relay are all configured, so direct sync stays unchanged.
	const relay = syncEnabled
		? serverModule.createViewerRelayReachability({
				store,
				config,
				// Same key directory as the daemon and the account link.
				keysDir: process.env.CODEMEM_KEYS_DIR?.trim() || undefined,
				signal: syncAbort.signal,
				log: logRelay,
			})
		: null;
	const syncRuntimeStatus: ServeSyncRuntimeStatus = {
		phase: syncEnabled ? "starting" : "disabled",
		detail: syncEnabled ? "Waiting for viewer startup to finish" : "Sync is disabled",
	};
	const coordinatorRefresh = createServeCoordinatorRefresh({ store, signal: syncAbort.signal });

	const appOpts = foregroundAppOptions(store, rawEventProcessing.appOptions, {
		accountLink,
		relay,
		syncRuntimeStatus,
		coordinatorRefresh: coordinatorRefresh.viewer,
	});
	const { app, setBoundAddress } = createBoundApp(createApp, appOpts, { invocation, accountLink });
	const pidPath = pidFilePath(dbPath);
	let maintenanceWorker: ChildProcess | null = null;

	// Sync protocol listener — separate port, network-accessible for peers.
	// syncServerRef is never nulled after creation so shutdown always drains it.
	let syncServer: ReturnType<typeof serve> | null = null;
	let syncListenerReady = false;
	if (syncEnabled) {
		syncServer = serve(syncListenerOptions(serverModule, appOpts, syncConfig), (info) => {
			syncListenerReady = true;
			p.log.step(`Sync protocol listening on http://${info.address}:${info.port}`);
		});
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
			setBoundAddress(info);
			announceViewerStartup({ pidPath, invocation, preparedDb, info });
			reportViewerStartup({ state: "listening" });
			maintenanceWorker = startMaintenanceWorkerProcess(invocation);
			if (syncEnabled) {
				scheduleServeSyncDaemon({
					invocation,
					syncConfig,
					store,
					signal: syncAbort.signal,
					status: syncRuntimeStatus,
					maintenance: coordinatorMaintenanceDependencies,
					relay,
					coordinatorRefresh: coordinatorRefresh.daemon,
				});
			}
		},
	);

	server.on("error", (err: NodeJS.ErrnoException) => {
		reportViewerListenError(err, invocation);
		requestShutdown(1);
	});

	let shutdownPromise: Promise<void> | undefined;
	let shutdownExitCode = 0;
	const shutdown = (exitCode = 0): Promise<void> => {
		shutdownExitCode = Math.max(shutdownExitCode, exitCode);
		shutdownPromise ??= finishShutdown();
		return shutdownPromise;
	};
	const finishShutdown = async () => {
		p.outro("shutting down");
		syncAbort.abort();

		try {
			try {
				// Skip the await without relay so shutdown timing stays as before.
				if (relay) await relay.close();
				await accountLink.close();
				await stopMaintenanceWorkerProcess(maintenanceWorker, dbPath);
			} finally {
				await closeViewerListeners(syncServer ? [syncServer, server] : [server]);
				await rawEventProcessing.stop();
			}
		} catch (error) {
			shutdownExitCode = 1;
			logViewerShutdownError(error);
		} finally {
			removeOwnedViewerPidFile(dbPath);
			try {
				await closeStoreAsync();
			} catch (error) {
				shutdownExitCode = 1;
				logViewerShutdownError(error);
			}
			// The store is closed, so another Viewer may take the database now.
			heldViewerWriterLock?.release();
		}
		process.exit(shutdownExitCode);
	};

	// Force-exit safety net if graceful shutdown stalls for an unusually long time.
	const requestShutdown = (exitCode = 0) => {
		if (!shutdownPromise) forceViewerShutdown(maintenanceWorker, dbPath);
		void shutdown(exitCode).catch((error: unknown) => {
			logViewerShutdownError(error);
		});
	};
	process.on("SIGINT", () => requestShutdown());
	process.on("SIGTERM", () => requestShutdown());
}

function reportViewerListenError(
	err: NodeJS.ErrnoException,
	invocation: ResolvedServeInvocation,
): void {
	if (err.code === "EADDRINUSE") {
		const message = `Viewer already running at http://${invocation.host}:${invocation.port}`;
		p.log.warn(message);
		reportViewerStartup({ state: "failed", message });
		return;
	}
	p.log.error(err.message);
	reportViewerStartup({ state: "failed", message: err.message });
}

function logViewerShutdownError(error: unknown): void {
	p.log.error(error instanceof Error ? error.message : String(error));
}

function closeViewerListeners(
	listeners: readonly { close(callback: () => void): unknown }[],
): Promise<void> {
	return new Promise<void>((resolve) => {
		let remaining = listeners.length;
		const done = () => {
			if (--remaining === 0) resolve();
		};
		for (const listener of listeners) listener.close(done);
	}).catch(() => {
		// Best-effort drain — proceed to cleanup.
	});
}

function forceViewerShutdown(maintenanceWorker: ChildProcess | null, dbPath: string): void {
	setTimeout(() => {
		if (maintenanceWorker?.pid && isProcessRunning(maintenanceWorker.pid)) {
			try {
				process.kill(maintenanceWorker.pid, "SIGKILL");
			} catch {
				// ignore
			}
		}
		removeOwnedViewerPidFile(dbPath);
		try {
			rmSync(maintenanceWorkerPidFilePath(dbPath));
		} catch {
			// ignore
		}
		// Forced exit cannot wait for worker joins; never close SQLite underneath them.
		process.exit(1);
	}, 30000).unref();
}

export async function runServeInvocation(
	invocation: ResolvedServeInvocation,
	dependencies: {
		nativeRuntimeAllowsServeStart: (invocation: ResolvedServeInvocation) => Promise<boolean>;
		stopExistingViewer: typeof stopExistingViewer;
		startViewer?: (invocation: ResolvedServeInvocation) => Promise<void>;
	} = {
		nativeRuntimeAllowsServeStart,
		stopExistingViewer,
	},
): Promise<void> {
	const dbPath = resolveDbPath(invocation.dbPath ?? undefined);
	const runtimeConflict = await findRuntimeViewerConflict(dbPath, {
		host: invocation.host,
		port: invocation.port,
	});
	if (runtimeConflict) {
		const message = `Database runtime at ${viewerRuntimeDir(dbPath)} is already managed by viewer ${runtimeConflict.host}:${runtimeConflict.port} (pid ${runtimeConflict.pid})`;
		p.intro("codemem viewer");
		p.log.error(message);
		p.log.info(
			"Use the matching --host/--port, stop the existing viewer first, or use a separate db/runtime folder for another viewer.",
		);
		// A background start's parent waits for this Viewer's result.
		reportViewerStartup({ state: "failed", message });
		process.exitCode = 1;
		return;
	}
	if (!(await dependencies.nativeRuntimeAllowsServeStart(invocation))) return;
	const stopping = invocation.mode === "stop" || invocation.mode === "restart";
	if (stopping && !(await stopBeforeStart(invocation, dbPath, dependencies.stopExistingViewer)))
		return;

	if (invocation.mode === "start" || invocation.mode === "restart") {
		await (dependencies.startViewer ?? startViewer)({ ...invocation, dbPath });
	}
}

async function stopMaintenanceWorkerAfterStop(dbPath: string): Promise<void> {
	const workerStopped = await terminateTrustedMaintenanceWorker(dbPath, {
		gracefulMs: 5000,
		forceMs: 5000,
	});
	if (!workerStopped) {
		p.log.warn("Maintenance worker pidfile exists but did not match trusted worker command");
	}
}

/**
 * Stops the existing Viewer for `stop` and `restart`. Returns true when a restart
 * may start the new Viewer: the old one has stopped, its port is free or reported,
 * and it no longer holds the database's lock.
 */
async function stopBeforeStart(
	invocation: ResolvedServeInvocation,
	dbPath: string,
	stop: typeof stopExistingViewer,
): Promise<boolean> {
	const result = await stop(dbPath, { host: invocation.host, port: invocation.port });
	if (result.refused) {
		// Restart too: starting this database's Viewer on that port would only fail.
		reportRefusedViewer(dbPath, result.refused);
		return false;
	}
	if (result.pid && !result.stopped) {
		p.intro("codemem viewer");
		p.log.error(`Viewer is still shutting down (pid ${result.pid})`);
		process.exitCode = 1;
		return false;
	}
	if (!result.stopped) {
		if (invocation.mode !== "stop") return true;
		p.intro("codemem viewer");
		await stopMaintenanceWorkerAfterStop(dbPath);
		reportNothingStopped(dbPath);
		return false;
	}
	p.intro("codemem viewer");
	p.log.success(`Stopped viewer${result.pid ? ` (pid ${result.pid})` : ""}`);
	await stopMaintenanceWorkerAfterStop(dbPath);
	if (invocation.mode === "stop") {
		p.outro("done");
		return false;
	}
	return waitForStoppedViewer(invocation, dbPath);
}

/** A Viewer that answered but was not shown to serve this database. Nothing was signalled. */
function reportRefusedViewer(
	dbPath: string,
	viewer: { pid: number; host: string; port: number; reason: string },
): void {
	p.intro("codemem viewer");
	p.log.error(
		`The viewer at ${viewer.host}:${viewer.port} (pid ${viewer.pid}) could not be confirmed to serve ${dbPath}: ${viewer.reason}. Nothing was stopped.`,
	);
	p.log.info(
		"It may serve another database, or come from a release that does not record its database. Pass the --db-path and --port it was started with, or stop it yourself after checking it.",
	);
	process.exitCode = 1;
}

/**
 * After a stop that found no Viewer to stop: whether something still holds the
 * database. The owner record is only reported; nothing is signalled because of it.
 */
function reportNothingStopped(dbPath: string): void {
	if (!isViewerWriterLockHeld(dbPath)) {
		p.outro("No background viewer found");
		return;
	}
	const owner = readViewerWriterLockOwner(dbPath);
	const holder = owner ? `pid ${owner.pid}, unverified` : "no holder recorded";
	p.log.error(`The database is locked by another process (${holder}).`);
	p.log.info(viewerLockHolderHint(owner));
	process.exitCode = 1;
}

async function waitForStoppedViewer(
	invocation: ResolvedServeInvocation,
	dbPath: string,
): Promise<boolean> {
	// Wait for port to be fully released before restarting.
	const released = await waitForPortRelease(invocation.host, invocation.port);
	if (!released) {
		p.log.warn(`Port ${invocation.port} still in use after stop — restart may fail`);
	}
	// The stopped Viewer releases the database's lock only as its process exits.
	const lockReleased = await waitForViewerWriterLockRelease(dbPath, viewerLockDependencies, {
		timeoutMs: VIEWER_LOCK_WAIT_MS,
	});
	if (lockReleased) return true;
	p.log.error(`The stopped viewer still holds ${dbPath}; not starting another one.`);
	process.exitCode = 1;
	return false;
}

function startViewer(invocation: ResolvedServeInvocation): Promise<void> {
	return invocation.background
		? startBackgroundViewer(invocation)
		: startForegroundViewer(invocation);
}

const serveCmd = new Command("serve")
	.configureHelp(helpStyle)
	.description("Run the local service (compatibility entrypoint; see service)")
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
			// Emit deprecation warnings only when the legacy bare-flag form is
			// used (no lifecycle action). When an action is present (start,
			// stop, restart) the flags are being consumed by the modern
			// subcommand form — e.g. `codemem serve start --foreground` — and
			// should not be flagged as deprecated.
			if (action === undefined) {
				if (opts.stop) emitDeprecationWarning("--stop", "codemem serve stop");
				if (opts.restart) emitDeprecationWarning("--restart", "codemem serve restart");
				if (opts.background) emitDeprecationWarning("--background", "codemem serve start");
				if (opts.foreground)
					emitDeprecationWarning("--foreground", "codemem serve start --foreground");
			}

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
			const message = err instanceof Error ? err.message : String(err);
			p.log.error(message);
			reportViewerStartup({ state: "failed", message });
			process.exitCode = 1;
		}
	},
);
