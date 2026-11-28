/**
 * Which process `codemem serve stop` and `restart` may signal for a database.
 *
 * A Viewer is signalled only when it is shown to serve this database, and only while its
 * pid still names the process that was shown to. Verification happens once and records the
 * process's identity (start time and command line) and which proof it passed. Right
 * before each signal, that same proof runs again without HTTP, then the identity is read
 * again and must match exactly, so the last thing checked before a signal is which process
 * the pid names.
 *
 * A Viewer must be the process listening on its port. A CLI or MCP process that has the
 * database open, or that an answer at the port names, is never a candidate.
 *
 * Proofs:
 * - A Viewer that holds the database's lock records itself as its owner. The record must
 *   name the pid, its start time and the canonical database, and the lock must be held.
 * - A Viewer from a release before the lock records nothing. It must be the process
 *   listening on its port, report this database in its prompt-pack profile, and have the
 *   database file or its write-ahead log open, as `lsof` shows. Each is required: a
 *   process can have a database open without serving it. Those releases cannot read a
 *   transitioned store, so for one only the lock proof is accepted.
 *
 * On macOS and Linux, a check that needs `lsof` refuses when `lsof` cannot run. On native
 * Windows there is no `lsof` or `ps`: a Viewer there cannot be identified at all, and the
 * database proofs that need `lsof` are not asked of it.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
	canonicalViewerDbPath,
	isViewerWriterLockHeld,
	processStartIdentity,
	readDeviceStorageShape,
	readViewerWriterLockOwner,
	viewerUrl,
} from "@codemem/core";

export interface ProcessIdentity {
	/** The start time `ps` reports, so a reused pid does not match. */
	started: string;
	command: string;
}

export interface ViewerAddress {
	host: string;
	port: number;
}

export function isLikelyViewerCommand(command: string): boolean {
	const lowered = command.toLowerCase();
	if (!/\b(?:serve|service)\s+start\b/.test(lowered)) return false;
	return (
		lowered.includes("codemem") ||
		lowered.includes("packages/cli/dist/index.js") ||
		lowered.includes("/cli/dist/index.js") ||
		lowered.includes("packages/cli/src/index.ts")
	);
}

export function readProcessCommand(pid: number): string | null {
	const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
		encoding: "utf-8",
		timeout: 1000,
	});
	if (result.status !== 0) return null;
	const cmd = (result.stdout || "").trim();
	return cmd.length > 0 ? cmd : null;
}

export function readProcessIdentity(pid: number): ProcessIdentity | null {
	const started = processStartIdentity(pid);
	const command = readProcessCommand(pid);
	return started && command ? { started, command } : null;
}

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
	return a.started === b.started && a.command === b.command;
}

type LsofResult = { ok: true; lines: string[] } | { ok: false; reason: string };

const LSOF_TIMEOUT_MS = 2000;

/** Why `lsof` could not answer, from the error Node reports for the attempt. */
function lsofFailure(error: NodeJS.ErrnoException): string {
	if (error.code === "ENOENT") return "lsof is not installed or not on PATH";
	if (error.code === "ETIMEDOUT") return `lsof did not answer within ${LSOF_TIMEOUT_MS} ms`;
	if (error.code === "EACCES" || error.code === "EPERM")
		return "lsof could not be run (permission denied)";
	return `lsof could not be run (${error.code ?? error.message})`;
}

/**
 * The lines `lsof` prints, or why it could not run. `lsof` exits 1 when it finds nothing
 * to list; that is an answer, and the lines are then empty. With `-w` it prints no
 * warnings, so anything on stderr then is a failure.
 */
function runLsof(args: string[]): LsofResult {
	const result = spawnSync("lsof", ["-w", ...args], {
		encoding: "utf-8",
		timeout: LSOF_TIMEOUT_MS,
	});
	if (result.error) return { ok: false, reason: lsofFailure(result.error) };
	if (result.signal) return { ok: false, reason: `lsof was stopped by ${result.signal}` };
	const stderr = (result.stderr || "").trim();
	if (result.status !== 0 && (result.status !== 1 || stderr)) {
		const detail = stderr.split(/\r?\n/)[0];
		return {
			ok: false,
			reason: `lsof failed with status ${result.status}${detail ? `: ${detail}` : ""}`,
		};
	}
	const lines = (result.stdout || "").split(/\r?\n/).filter((line) => line.length > 0);
	return { ok: true, lines };
}

export type ListenerLookup = { ok: true; pid: number | null } | { ok: false; reason: string };

/** The pid listening on TCP `port`, null when none is, or why that could not be read. */
export function listeningPid(port: number): ListenerLookup {
	const result = runLsof(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
	if (!result.ok) return result;
	const first = result.lines.map((line) => line.trim()).find((line) => line.length > 0);
	const parsed = first ? Number.parseInt(first, 10) : Number.NaN;
	return { ok: true, pid: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null };
}

type OpenCheck = { ok: true; open: boolean } | { ok: false; reason: string };

/**
 * Whether process `pid` has the database file, or its write-ahead log, open. A name `lsof`
 * marks ` (deleted)`, as Linux does for a file removed while open, is another file than the
 * one at the path now and does not count. Names are resolved as the database's is.
 */
function holdsDatabaseOpen(pid: number, canonical: string): OpenCheck {
	const result = runLsof(["-p", String(pid), "-Fn"]);
	if (!result.ok) return result;
	const wanted = new Set([canonical, `${canonical}-wal`]);
	const names = new Set([basename(canonical), `${basename(canonical)}-wal`]);
	const open = result.lines.some((line) => {
		if (!line.startsWith("n/")) return false;
		const file = line.slice(1);
		if (!names.has(basename(file))) return false;
		return wanted.has(canonicalViewerDbPath(file));
	});
	return { ok: true, open };
}

/** The database a Viewer reports in its prompt-pack profile, or null when it reports none. */
async function reportedDatabase(address: ViewerAddress, fetchImpl: typeof fetch) {
	try {
		const response = await fetchImpl(viewerUrl(address, "/api/prompt-pack-profile"), {
			signal: AbortSignal.timeout(1000),
		});
		if (!response.ok) return null;
		const payload = (await response.json()) as { db_path?: unknown } | null;
		return typeof payload?.db_path === "string" && payload.db_path ? payload.db_path : null;
	} catch {
		return null;
	}
}

export interface VerifiedViewer {
	pid: number;
	/** The process as it was verified; each signal requires the pid to name it still. */
	identity: ProcessIdentity;
	proof: "lock" | "open-database" | "unidentifiable-platform";
	/** The same proof again, without HTTP: a Viewer stuck in a query cannot answer. */
	recheck(): boolean;
}

export type ViewerVerification =
	| { ok: true; viewer: VerifiedViewer }
	| { ok: false; reason: string };

export interface VerificationDependencies {
	platform?: NodeJS.Platform;
	fetch?: typeof fetch;
	readIdentity?: (pid: number) => ProcessIdentity | null;
}

function lockProof(pid: number, identity: ProcessIdentity, dbPath: string): boolean {
	const owner = readViewerWriterLockOwner(dbPath);
	return (
		owner?.pid === pid &&
		owner.db_path === canonicalViewerDbPath(dbPath) &&
		owner.started === identity.started &&
		isViewerWriterLockHeld(dbPath)
	);
}

function refuse(reason: string): ViewerVerification {
	return { ok: false, reason };
}

/** The listener and open-file proofs of a Viewer from before the lock; a reason when they fail. */
function openDatabaseProof(pid: number, port: number, canonical: string): string | null {
	const listener = listeningPid(port);
	if (!listener.ok) return listener.reason;
	if (listener.pid !== pid) return `it is not the process listening on port ${port}`;
	const open = holdsDatabaseOpen(pid, canonical);
	if (!open.ok) return open.reason;
	return open.open ? null : "it does not have the database open";
}

/** Why the process is not a codemem Viewer listening at its address, or null when it is. */
function viewerProcessFailure(
	pid: number,
	identity: ProcessIdentity | null,
	port: number,
	platform: NodeJS.Platform,
): string | null {
	if (!identity) return "its process could not be identified";
	if (!isLikelyViewerCommand(identity.command))
		return "its process does not look like a codemem viewer";
	if (platform === "win32") return null;
	const listener = listeningPid(port);
	if (!listener.ok) return listener.reason;
	return listener.pid === pid ? null : `it is not the process listening on port ${port}`;
}

function verified(
	pid: number,
	identity: ProcessIdentity,
	proof: VerifiedViewer["proof"],
	recheck: () => boolean,
): ViewerVerification {
	return { ok: true, viewer: { pid, identity, proof, recheck } };
}

/**
 * Why a Viewer without the lock cannot be serving this database, or null. Releases
 * from before the lock cannot read a transitioned store, so for one the lock is the
 * only proof. A store whose names cannot be read is refused rather than guessed.
 */
function transitionedStoreRefusal(dbPath: string): string | null {
	if (!existsSync(dbPath)) return null;
	try {
		if (readDeviceStorageShape(dbPath) === "legacy") return null;
		return "it does not hold the database's lock, and only a Viewer that holds it can serve this database's storage format";
	} catch (error) {
		return `the database's storage format could not be read (${error instanceof Error ? error.message : String(error)})`;
	}
}

/** The proof for a Viewer from before the lock: listener, open database, reported database. */
async function verifyPreLockViewer(
	pid: number,
	identity: ProcessIdentity,
	address: ViewerAddress,
	canonical: string,
	fetchImpl: typeof fetch,
): Promise<ViewerVerification> {
	const failed = openDatabaseProof(pid, address.port, canonical);
	if (failed) return refuse(failed);
	const reported = await reportedDatabase(address, fetchImpl);
	if (reported === null) return refuse("it did not report which database it serves");
	if (canonicalViewerDbPath(reported) !== canonical) return refuse("it reports another database");
	return verified(pid, identity, "open-database", () => {
		return openDatabaseProof(pid, address.port, canonical) === null;
	});
}

/**
 * Whether the codemem Viewer `pid`, answering at `address`, serves the database at
 * `dbPath`. Returns what to recheck before each signal, or why it is refused.
 */
export async function verifyViewerForDatabase(
	pid: number,
	address: ViewerAddress,
	dbPath: string,
	deps: VerificationDependencies = {},
): Promise<ViewerVerification> {
	const identity = (deps.readIdentity ?? readProcessIdentity)(pid);
	const platform = deps.platform ?? process.platform;
	const notViewer = viewerProcessFailure(pid, identity, address.port, platform);
	if (notViewer || !identity) return refuse(notViewer ?? "its process could not be identified");
	const owner = readViewerWriterLockOwner(dbPath);
	if (owner?.pid === pid) {
		if (!lockProof(pid, identity, dbPath))
			return refuse(
				"the database's lock record names it with another start time or database, or the lock is not held",
			);
		return verified(pid, identity, "lock", () => lockProof(pid, identity, dbPath));
	}
	if (owner && isViewerWriterLockHeld(dbPath))
		return refuse("another process holds the database's lock");
	const format = transitionedStoreRefusal(dbPath);
	if (format) return refuse(format);
	if (platform === "win32") return verified(pid, identity, "unidentifiable-platform", () => true);
	return verifyPreLockViewer(
		pid,
		identity,
		address,
		canonicalViewerDbPath(dbPath),
		deps.fetch ?? fetch,
	);
}
