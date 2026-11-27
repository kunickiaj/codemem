/**
 * Which file a store has open.
 *
 * A second connection to a store is opened by path. The file at that path can be replaced
 * while the first connection keeps the old file open, and the two connections would then
 * read different databases whose row IDs overlap. So the file is identified when the store
 * opens it, by device and inode, and anything that opens the path later compares against
 * that. The open connection keeps the old inode in use, so a replacement cannot reuse it.
 *
 * The write-ahead log is part of what a connection reads, so its file is identified too
 * when it exists at that moment. It stays the same file for as long as the store's
 * connection is open.
 *
 * Device and inode are read as bigints. As numbers, two inodes above 2^53 can compare equal.
 *
 * What this does not cover: a second connection is still opened by path, and the path is
 * compared before and after that open. A process that can write to the store's directory
 * could put another file at the path only for the instant of the open and restore the
 * original before the second comparison. Such a process can already read and change the
 * store itself.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface DatabaseFileIdentity {
	/** The resolved path the file was opened at. */
	path: string;
	/** Device and inode of the database file. */
	fileIdentity: string;
	/** Device and inode of its write-ahead log, or null when there was none. */
	walIdentity: string | null;
}

/** Device and inode as text, exact for any value the file system reports. */
export function fileIdentityOf(stat: { dev: bigint; ino: bigint }): string {
	return `${stat.dev}:${stat.ino}`;
}

function regularFileIdentity(path: string): string | null {
	try {
		const stat = statSync(path, { bigint: true });
		return stat.isFile() ? fileIdentityOf(stat) : null;
	} catch {
		return null;
	}
}

/** The regular file at `path` now, with its write-ahead log, or null when there is none. */
export function databaseFileAt(path: string): DatabaseFileIdentity | null {
	if (!isAbsolute(path)) return null;
	let resolved: string;
	try {
		resolved = realpathSync(path);
	} catch {
		return null;
	}
	const fileIdentity = regularFileIdentity(resolved);
	if (fileIdentity === null) return null;
	return { path: resolved, fileIdentity, walIdentity: regularFileIdentity(`${resolved}-wal`) };
}

/**
 * Whether `now` is the file that was identified as `opened`: the same path, the same
 * database file, and the same write-ahead log when one was identified. A log that appeared
 * later belongs to the connection that was already open and is not compared.
 */
export function isSameDatabaseFile(
	opened: DatabaseFileIdentity,
	now: DatabaseFileIdentity | null,
): boolean {
	if (now === null || now.path !== opened.path || now.fileIdentity !== opened.fileIdentity) {
		return false;
	}
	return opened.walIdentity === null || now.walIdentity === opened.walIdentity;
}

/**
 * The file a connection to `path` opened, given what was at the path just before it opened.
 * Null when the database file changed while the connection opened, because then nothing
 * says which of the two files the connection holds. A file the connection created has no
 * `before`. The connection may create the write-ahead log, so the log is taken as it is
 * after the open.
 */
export function databaseFileOpened(
	before: DatabaseFileIdentity | null,
	path: string,
): DatabaseFileIdentity | null {
	const after = databaseFileAt(path);
	if (!after) return null;
	if (before && (before.path !== after.path || before.fileIdentity !== after.fileIdentity)) {
		return null;
	}
	return after;
}

/** Whether the path still leads to the file, and the log, that were identified at open. */
export function isDatabaseFileUnchanged(opened: DatabaseFileIdentity): boolean {
	return isSameDatabaseFile(opened, databaseFileAt(opened.path));
}
