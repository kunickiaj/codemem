/**
 * Which file a store has open.
 *
 * A second connection to a store is opened by path. The file at that path can be replaced
 * while the first connection keeps the old file open, and the two connections would then
 * read different databases whose row IDs overlap. So the file is identified when the store
 * opens it, by device and inode, and anything that opens the path later compares against
 * that. The open connection keeps the old inode in use, so a replacement cannot reuse it.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface DatabaseFileIdentity {
	/** The resolved path the file was opened at. */
	path: string;
	/** Device and inode of the file. */
	fileIdentity: string;
}

/** The regular file at `path` now, or null when there is none. */
export function databaseFileAt(path: string): DatabaseFileIdentity | null {
	if (!isAbsolute(path)) return null;
	try {
		const resolved = realpathSync(path);
		const stat = statSync(resolved);
		if (!stat.isFile()) return null;
		return { path: resolved, fileIdentity: `${stat.dev}:${stat.ino}` };
	} catch {
		return null;
	}
}

function sameFile(a: DatabaseFileIdentity, b: DatabaseFileIdentity): boolean {
	return a.path === b.path && a.fileIdentity === b.fileIdentity;
}

/**
 * The file a connection to `path` opened, given what was at the path just before it opened.
 * Null when the file changed while the connection opened, because then nothing says which
 * of the two files the connection holds. A file the connection created has no `before`.
 */
export function databaseFileOpened(
	before: DatabaseFileIdentity | null,
	path: string,
): DatabaseFileIdentity | null {
	const after = databaseFileAt(path);
	if (!after) return null;
	if (before && !sameFile(before, after)) return null;
	return after;
}

/** Whether the path still leads to the file that was opened. */
export function isDatabaseFileUnchanged(opened: DatabaseFileIdentity): boolean {
	const now = databaseFileAt(opened.path);
	return now !== null && sameFile(opened, now);
}
