import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { InviteTokenSealError, parseInviteTokenKey } from "./coordinator-invite-token-seal.js";

/**
 * The file that holds a SQLite coordinator's generated invitation token key,
 * next to the database's canonical path. Every path that names the database,
 * such as one through a symbolic link, finds the same file.
 */
export function inviteTokenKeyFilePath(databasePath: string): string {
	return `${realpathSync(databasePath)}.invite-token-key`;
}

function refuse(path: string, reason: string): never {
	throw new InviteTokenSealError(
		"invite_token_key_file_invalid",
		`Invitation token key file ${path} ${reason}. Fix or remove it, or configure CODEMEM_INVITE_TOKEN_KEY.`,
	);
}

/**
 * The key in an existing key file, or null when there is none. The file must be
 * a regular file, not a link, owned by this user and readable by nobody else,
 * and hold one 32-byte key; anything else is refused.
 */
function readKeyFile(path: string): string | null {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (!stats.isFile()) refuse(path, "is not a regular file");
	if ((stats.mode & 0o077) !== 0) refuse(path, "can be read or written by other users");
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) refuse(path, "belongs to another user");
	const key = readFileSync(path, "utf8").trim();
	if (!parseInviteTokenKey(key)) refuse(path, "does not hold a 32-byte key");
	return key;
}

/** Writes a new key to a private temporary file next to `path`, flushed to disk. */
function writeTemporaryKey(path: string): string {
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeSync(descriptor, `${randomBytes(32).toString("hex")}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	return temporary;
}

/**
 * The generated invitation token key of a SQLite coordinator database. When the
 * file is missing and `create` is set, a new key is written in full to a private
 * temporary file and then linked to the final name. A link never replaces an
 * existing file, so when processes create it at once, every one of them uses the
 * key of the first link. The creator logs where it wrote the key, never the key.
 */
export function readOrCreateInviteTokenKeyFile(
	databasePath: string,
	options: { create: boolean; log?: (message: string) => void },
): string | null {
	const path = inviteTokenKeyFilePath(databasePath);
	const existing = readKeyFile(path);
	if (existing || !options.create) return existing;
	const temporary = writeTemporaryKey(path);
	let created = false;
	try {
		linkSync(temporary, path);
		created = true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// Without hard links the key cannot be put in place without racing another process.
		if (code !== "EEXIST")
			throw new InviteTokenSealError(
				"invite_token_key_file_unsupported",
				`Could not create invitation token key file ${path}: the filesystem refused a hard link (${code ?? "unknown error"}). Configure the key explicitly with CODEMEM_INVITE_TOKEN_KEY or sync_coordinator_invite_token_key in the codemem config file.`,
			);
	} finally {
		unlinkSync(temporary);
	}
	if (created) (options.log ?? console.warn)(`created invite token key at ${path}`);
	return readKeyFile(path);
}
