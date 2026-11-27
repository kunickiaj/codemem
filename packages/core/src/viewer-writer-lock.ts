/**
 * One Viewer per database. The Viewer's in-process locks, such as Team setup's
 * per-candidate claims, only serialize work inside one process, so two Viewers
 * on one store could interleave a draft change and a Finish. `codemem serve`
 * takes this lock before it opens the store and holds it until the process exits.
 *
 * The lock is a small SQLite file next to the database, kept in an open exclusive
 * transaction. SQLite takes an OS file lock for it, which the OS releases when the
 * process exits for any reason, so a crash never leaves a stale lock behind.
 *
 * Every path here comes from the database's canonical path, so a database
 * reached through a symlink gets the same lock as its real path.
 */
import { spawnSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

export interface ViewerWriterLock {
	readonly path: string;
	release(): void;
}

/** Another process, normally another Viewer, holds the lock for this database. */
export class ViewerWriterLockHeldError extends Error {
	constructor(readonly path: string) {
		super(`viewer_writer_lock_held: ${path}`);
		this.name = "ViewerWriterLockHeldError";
	}
}

/** The lock or its owner record cannot be created, for example in a read-only folder. */
export class ViewerWriterLockUnavailableError extends Error {
	constructor(
		readonly path: string,
		readonly code: string,
		options?: { cause?: unknown },
	) {
		super(`viewer_writer_lock_unavailable: ${path} (${code})`, options);
		this.name = "ViewerWriterLockUnavailableError";
	}
}

/**
 * The process that took the lock. Written right after acquisition, so a holder
 * that never serves HTTP can still be identified and stopped.
 */
export interface ViewerWriterLockOwner {
	pid: number;
	/** The process start time from `ps`, so a reused pid does not match. */
	started: string;
	/** Canonical database path. */
	db_path: string;
	/** Where the holder intends to serve. */
	host: string;
	port: number;
}

/**
 * The database path with every symlink resolved. A path that does not exist yet
 * resolves through its nearest existing ancestor, and a symlink whose target
 * does not exist yet resolves to that target, where SQLite will create the file.
 */
export function canonicalViewerDbPath(dbPath: string): string {
	return canonicalPath(resolve(dbPath), 0);
}

/** Follows at most this many dangling symlinks, so a symlink loop cannot recurse forever. */
const MAX_DANGLING_LINKS = 32;

function canonicalPath(absolute: string, followedLinks: number): string {
	const missing: string[] = [];
	let existing = absolute;
	for (;;) {
		try {
			return join(realpathSync(existing), ...missing);
		} catch (error) {
			const target = followedLinks < MAX_DANGLING_LINKS ? danglingLinkTarget(existing) : null;
			if (target) return join(canonicalPath(target, followedLinks + 1), ...missing);
			const code = errorCode(error);
			const parent = dirname(existing);
			if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === existing) return absolute;
			missing.unshift(basename(existing));
			existing = parent;
		}
	}
}

/** Where a symlink points when `realpath` cannot follow it; null for anything else. */
function danglingLinkTarget(path: string): string | null {
	try {
		if (!lstatSync(path).isSymbolicLink()) return null;
		return resolve(dirname(path), readlinkSync(path));
	} catch {
		return null;
	}
}

/** The folder that holds a Viewer's runtime files, such as `viewer.pid`. */
export function viewerRuntimeDir(dbPath: string): string {
	return dirname(canonicalViewerDbPath(dbPath));
}

export function viewerWriterLockPath(dbPath: string): string {
	return `${canonicalViewerDbPath(dbPath)}.viewer-lock`;
}

export function viewerWriterLockOwnerPath(dbPath: string): string {
	return `${viewerWriterLockPath(dbPath)}.owner`;
}

function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "unknown";
}

function isBusy(error: unknown): boolean {
	const code = errorCode(error);
	return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

/** The start time `ps` reports for a process, or null when it cannot be read. */
export function processStartIdentity(pid: number): string | null {
	const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
		encoding: "utf-8",
		timeout: 1000,
		env: { ...process.env, LC_ALL: "C" },
	});
	if (result.status !== 0) return null;
	const started = (result.stdout || "").trim();
	return started.length > 0 ? started : null;
}

function openLock(path: string): InstanceType<typeof Database> {
	try {
		// A first start takes the lock before anything has created the data folder.
		mkdirSync(dirname(path), { recursive: true });
		return new Database(path, { timeout: 0 });
	} catch (error) {
		throw new ViewerWriterLockUnavailableError(path, errorCode(error), { cause: error });
	}
}

function writeOwner(path: string, owner: ViewerWriterLockOwner): void {
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw new ViewerWriterLockUnavailableError(path, errorCode(error), { cause: error });
	}
}

function removeOwnOwner(path: string): void {
	try {
		if (readOwnerFile(path)?.pid === process.pid) rmSync(path, { force: true });
	} catch {
		// Best effort: a stale record never verifies, because its pid or start time differs.
	}
}

/**
 * Takes the lock or throws without waiting: `ViewerWriterLockHeldError` while
 * another process holds it, `ViewerWriterLockUnavailableError` when it cannot
 * be created. With `owner`, records this process as the holder before returning.
 */
export function acquireViewerWriterLock(
	dbPath: string,
	options: { owner?: { host: string; port: number } } = {},
): ViewerWriterLock {
	const path = viewerWriterLockPath(dbPath);
	const lock = openLock(path);
	try {
		lock.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		lock.close();
		if (isBusy(error)) throw new ViewerWriterLockHeldError(path);
		throw new ViewerWriterLockUnavailableError(path, errorCode(error), { cause: error });
	}
	const ownerPath = `${path}.owner`;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		if (options.owner) removeOwnOwner(ownerPath);
		try {
			lock.exec("ROLLBACK");
		} finally {
			lock.close();
		}
	};
	if (options.owner) {
		try {
			writeOwner(ownerPath, {
				pid: process.pid,
				started: processStartIdentity(process.pid) ?? "",
				db_path: canonicalViewerDbPath(dbPath),
				host: options.owner.host,
				port: options.owner.port,
			});
		} catch (error) {
			release();
			throw error;
		}
	}
	return { path, release };
}

/**
 * Whether some process holds the lock now. Takes and releases the lock when it
 * is free, so a Viewer starting at that moment must retry rather than fail.
 */
export function isViewerWriterLockHeld(dbPath: string): boolean {
	let lock: InstanceType<typeof Database>;
	try {
		lock = new Database(viewerWriterLockPath(dbPath), { timeout: 0, fileMustExist: true });
	} catch {
		// No lock file: nothing has ever held it.
		return false;
	}
	try {
		lock.exec("BEGIN EXCLUSIVE");
		lock.exec("ROLLBACK");
		return false;
	} catch (error) {
		return isBusy(error);
	} finally {
		lock.close();
	}
}

function readOwnerFile(path: string): ViewerWriterLockOwner | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
	const owner = parsed as Partial<ViewerWriterLockOwner> | null;
	if (
		!owner ||
		!Number.isSafeInteger(owner.pid) ||
		(owner.pid ?? 0) <= 0 ||
		typeof owner.started !== "string" ||
		typeof owner.db_path !== "string" ||
		typeof owner.host !== "string" ||
		!Number.isSafeInteger(owner.port)
	)
		return null;
	return owner as ViewerWriterLockOwner;
}

/** The recorded holder, unverified: the caller must check it is still that process. */
export function readViewerWriterLockOwner(dbPath: string): ViewerWriterLockOwner | null {
	return readOwnerFile(viewerWriterLockOwnerPath(dbPath));
}
