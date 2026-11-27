/**
 * One Viewer per database. The Viewer's in-process locks, such as Team setup's
 * per-candidate claims, only serialize work inside one process, so two Viewers
 * on one store could interleave a draft change and a Finish. `codemem serve`
 * takes this lock before it opens the store and holds it until the process exits.
 *
 * The lock is a small SQLite file next to the database, kept in an open exclusive
 * transaction. SQLite takes an OS file lock for it, which the OS releases when the
 * process exits for any reason, so a crash never leaves a stale lock behind.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

export function viewerWriterLockPath(dbPath: string): string {
	return `${dbPath}.viewer-lock`;
}

function isBusy(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

/** Takes the lock or throws `ViewerWriterLockHeldError` without waiting. */
export function acquireViewerWriterLock(dbPath: string): ViewerWriterLock {
	const path = viewerWriterLockPath(dbPath);
	// A first start takes the lock before anything has created the data folder.
	mkdirSync(dirname(path), { recursive: true });
	const lock = new Database(path, { timeout: 0 });
	try {
		lock.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		lock.close();
		if (isBusy(error)) throw new ViewerWriterLockHeldError(path);
		throw error;
	}
	let released = false;
	return {
		path,
		release() {
			if (released) return;
			released = true;
			try {
				lock.exec("ROLLBACK");
			} finally {
				lock.close();
			}
		},
	};
}
