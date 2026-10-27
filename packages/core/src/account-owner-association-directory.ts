import { lstatSync, mkdirSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { syncOwnerProfileDirectory } from "./coordinator-owner-profile-files.js";

export function accountOwnerAssociationDirectory(): string {
	return join(homedir(), ".codemem", "account-owner-associations");
}

export type AccountOwnerAssociationDirectoryProblem =
	| "not_directory"
	| "wrong_owner"
	| "shared_write"
	| "not_private";

/**
 * A state directory that other local users could change. The message names the path and
 * the command that fixes it, because callers show it to the person who owns the directory.
 */
export class AccountOwnerAssociationDirectoryError extends Error {
	readonly code = "account_owner_association_directory_unsafe";
	constructor(
		readonly path: string,
		readonly problem: AccountOwnerAssociationDirectoryProblem,
	) {
		super(directoryProblemMessage(path, problem));
		this.name = "AccountOwnerAssociationDirectoryError";
	}
}

function directoryProblemMessage(
	path: string,
	problem: AccountOwnerAssociationDirectoryProblem,
): string {
	if (problem === "shared_write")
		return `${path} is writable by other users. Run \`chmod go-w ${path}\`, then try again.`;
	if (problem === "not_private")
		return `${path} must be private to you. Run \`chmod 700 ${path}\`, then try again.`;
	if (problem === "wrong_owner") return `${path} is owned by another user. Make it yours.`;
	return `${path} must be a real directory, not a file or symlink.`;
}

function directoryProblem(
	stat: Stats,
	options: { private?: boolean },
): AccountOwnerAssociationDirectoryProblem | null {
	if (!stat.isDirectory() || stat.isSymbolicLink()) return "not_directory";
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return "wrong_owner";
	if (options.private) return (stat.mode & 0o777) === 0o700 ? null : "not_private";
	return (stat.mode & 0o022) === 0 ? null : "shared_write";
}

function checkDirectory(path: string, options: { private?: boolean } = {}): boolean {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
	const problem = directoryProblem(stat, options);
	if (problem) throw new AccountOwnerAssociationDirectoryError(path, problem);
	return true;
}

/** Missing directories stay missing during reads. Never follow a state-directory symlink. */
export function readAccountOwnerAssociationDirectory(path: string): boolean {
	return checkDirectory(dirname(path)) && checkDirectory(path, { private: true });
}

function createDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
			throw error;
	}
}

/** Sync ancestors on every retry: an earlier mkdir may have become visible without its fsync. */
export function retainAccountOwnerAssociationDirectory(path: string): void {
	const parent = dirname(path);
	createDirectory(parent);
	if (!checkDirectory(parent)) throw new Error("account_owner_association_invalid");
	syncOwnerProfileDirectory(dirname(parent));
	createDirectory(path);
	if (!checkDirectory(path, { private: true }))
		throw new Error("account_owner_association_invalid");
	syncOwnerProfileDirectory(parent);
}
