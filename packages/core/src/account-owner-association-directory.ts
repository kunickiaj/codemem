import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { syncOwnerProfileDirectory } from "./coordinator-owner-profile-files.js";

export function accountOwnerAssociationDirectory(): string {
	return join(homedir(), ".codemem", "account-owner-associations");
}

function checkDirectory(path: string, options: { private?: boolean } = {}): boolean {
	try {
		const stat = lstatSync(path);
		const unsafeMode = options.private ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o022) !== 0;
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			unsafeMode ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())
		)
			throw new Error("account_owner_association_invalid");
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
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
