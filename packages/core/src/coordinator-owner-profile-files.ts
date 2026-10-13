import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSshEd25519PublicKey } from "./coordinator-ed25519-key-id.js";
import {
	type OwnerProfileReview,
	ownerProfileConflict,
} from "./coordinator-owner-profile-adoption.js";
import type { Database } from "./db.js";
import {
	atomicReplaceConfigFile,
	type ConfigFileMetadata,
	expandUserPath,
	stripJsonComments,
	stripTrailingCommas,
} from "./observer-config.js";
import { loadPrivateKey, loadPublicKey, loadRuntimeSigningPublicKey } from "./sync-identity.js";

export type OwnerProfilePaths = {
	dbPath: string;
	configPath: string;
	keysDir: string;
	stateDir: string;
};
export type OwnerFileSnapshot = { text: string; dev: string; ino: string; ctime: string };
export type OwnerProfileLockAuthentication = {
	privateKey: Buffer;
	reviewDigest: string;
	databaseFile: string;
	keyId: string;
	deviceId: string;
	bindingId: string;
};
export function ownerDatabaseFile(path: string): string {
	const node = lstatSync(path, { bigint: true });
	if (!node.isFile() || node.isSymbolicLink()) return ownerProfileConflict();
	return `${node.dev}:${node.ino}`;
}
/** Wire spelling only. Never edits an existing key file or the stored device tuple. */
export function ownerProfileWireKey(publicKey: string): string {
	const parsed = parseSshEd25519PublicKey(publicKey);
	if (parsed.kind !== "ed25519") return ownerProfileConflict();
	return `ssh-ed25519 ${Buffer.from(parsed.blob).toString("base64")}`;
}
export function ownerObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return ownerProfileConflict();
	return value as Record<string, unknown>;
}
function assertFile(path: string, options: { private?: boolean } = {}): void {
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(options.private && (stat.mode & 0o777) !== 0o600) ||
		stat.size > 1_048_576
	)
		ownerProfileConflict();
}
export function ownerFileSnapshot(path: string): OwnerFileSnapshot {
	assertFile(path);
	const node = lstatSync(path, { bigint: true });
	return {
		text: readFileSync(path, "utf8"),
		dev: String(node.dev),
		ino: String(node.ino),
		ctime: String(node.ctimeNs),
	};
}
export function assertOwnerFileSnapshot(path: string, expected: OwnerFileSnapshot): void {
	if (JSON.stringify(ownerFileSnapshot(path)) !== JSON.stringify(expected)) ownerProfileConflict();
}
export function readOwnerState(path: string): Record<string, unknown> {
	assertFile(path, { private: true });
	return ownerObject(JSON.parse(readFileSync(path, "utf8")));
}
function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
/** Sync an existing POSIX directory without changing its permissions or contents. */
export function syncOwnerProfileDirectory(path: string): void {
	syncDirectory(path);
}
/** Durable, create-only publication; never overwrite a retained final request. */
export function retainOwnerState(path: string, value: unknown): void {
	const text = JSON.stringify(value);
	if (text === undefined) ownerProfileConflict();
	const staged = stageOwnerState(path, text);
	// The complete temporary name is durable before publication can become ambiguous.
	// Any link or directory-sync failure must leave that recovery evidence intact.
	linkSync(staged.path, path);
	syncDirectory(dirname(path));
	assertPublishedConfigLock(path, staged.snapshot);
	assertPublishedConfigLock(staged.path, staged.snapshot);
	unlinkSync(staged.path);
	syncDirectory(dirname(path));
}
function stageOwnerState(
	path: string,
	text: string,
): {
	path: string;
	snapshot: OwnerFileSnapshot;
} {
	const temporary = `${path}.tmp-${randomUUID()}`;
	const fd = openSync(temporary, "wx", 0o600);
	let identity: Pick<OwnerFileSnapshot, "dev" | "ino"> | undefined;
	let closeAttempted = false;
	try {
		const node = fstatSync(fd, { bigint: true });
		identity = { dev: String(node.dev), ino: String(node.ino) };
		writeFileSync(fd, text);
		fsyncSync(fd);
		const snapshot = ownerFileSnapshot(temporary);
		if (snapshot.dev !== identity.dev || snapshot.ino !== identity.ino || snapshot.text !== text)
			ownerProfileConflict();
		syncDirectory(dirname(path));
		closeAttempted = true;
		closeSync(fd);
		return { path: temporary, snapshot };
	} catch (error) {
		if (identity) cleanupUnpublishedConfigLock(temporary, identity);
		if (!closeAttempted) closeSync(fd);
		throw error;
	}
}
export function assertOwnerEnvironment(paths: OwnerProfilePaths): void {
	if (
		process.env.CODEMEM_ACTOR_ID !== undefined ||
		process.env.CODEMEM_DEVICE_ID !== undefined ||
		process.env.CODEMEM_ACTOR_DISPLAY_NAME !== undefined ||
		process.env.CODEMEM_SYNC_KEY_STORE?.toLowerCase() === "keychain"
	)
		ownerProfileConflict();
	const configOverride = process.env.CODEMEM_CONFIG?.trim();
	const dbOverride = process.env.CODEMEM_DB;
	const keysOverride = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
	// Match runtime resolvers; DB spaces remain literal and key-directory tildes are not expanded.
	for (const [override, path] of [
		[configOverride ? expandUserPath(configOverride) : undefined, paths.configPath],
		[dbOverride ? expandUserPath(dbOverride) : undefined, paths.dbPath],
		[keysOverride, paths.keysDir],
	] as const) {
		if (override !== undefined && resolve(override) !== resolve(path)) ownerProfileConflict();
	}
	for (const name of [
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_GROUP",
		"CODEMEM_WORKSPACE_ID",
	]) {
		if (process.env[name] !== undefined) ownerProfileConflict();
	}
}
export function readOwnerProfileConfig(path: string): Record<string, unknown> {
	return ownerObject(
		JSON.parse(stripTrailingCommas(stripJsonComments(ownerFileSnapshot(path).text))),
	);
}
export function readOwnerProfileKey(input: {
	paths: OwnerProfilePaths;
	db: Database;
	deviceId: string;
}): Buffer {
	assertOwnerEnvironment(input.paths);
	assertFile(join(input.paths.keysDir, "device.key"), { private: true });
	assertFile(join(input.paths.keysDir, "device.key.pub"));
	const privateKey = loadPrivateKey(input.paths.keysDir, undefined, input.deviceId);
	const actual = loadRuntimeSigningPublicKey(input.db, {
		keysDir: input.paths.keysDir,
		deviceId: input.deviceId,
	});
	const publicKey = loadPublicKey(input.paths.keysDir);
	if (!privateKey || !actual || !publicKey || actual !== ownerProfileWireKey(publicKey))
		return ownerProfileConflict();
	return privateKey;
}
export function assertOwnerRuntime(input: {
	paths: OwnerProfilePaths;
	db: Database;
	review: OwnerProfileReview;
	privateKey: Buffer;
	config: OwnerFileSnapshot;
	databaseFile: string;
}): void {
	if (ownerDatabaseFile(input.paths.dbPath) !== input.databaseFile) ownerProfileConflict();
	assertOwnerFileSnapshot(input.paths.configPath, input.config);
	const current = readOwnerProfileKey({ ...input, deviceId: input.review.deviceId });
	if (
		!current.equals(input.privateKey) ||
		ownerProfileWireKey(loadPublicKey(input.paths.keysDir) ?? "") !==
			ownerProfileWireKey(input.review.publicKey)
	)
		ownerProfileConflict();
}
type OwnerProfileConfigInput = {
	paths: OwnerProfilePaths;
	snapshot: OwnerFileSnapshot;
	identityId: string;
	coordinatorOrigin: string;
	groupId: string;
	assertRuntime: () => void;
	/** Only the authenticated adoption caller may reclaim its own dead writer. */
	lockAuthentication?: OwnerProfileLockAuthentication;
};
function configLockOperation(input: OwnerProfileConfigInput): string | undefined {
	const auth = input.lockAuthentication;
	if (!auth) return undefined;
	return createHash("sha256")
		.update(
			JSON.stringify([
				"owner-profile-config-operation-v1",
				resolve(input.paths.configPath),
				resolve(input.paths.dbPath),
				resolve(input.paths.keysDir),
				resolve(input.paths.stateDir),
				auth.reviewDigest,
				auth.databaseFile,
				auth.keyId,
				auth.deviceId,
				auth.bindingId,
				input.identityId,
				input.coordinatorOrigin,
				input.groupId,
			]),
		)
		.digest("hex");
}
function configLockMac(key: Buffer, record: Record<string, unknown>): Buffer {
	return createHmac("sha256", key)
		.update(
			JSON.stringify([
				"owner-profile-config-lock-v1",
				record.purpose,
				record.token,
				record.pid,
				record.operation,
			]),
		)
		.digest();
}
function assertDeadConfigWriter(pid: number): void {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		ownerProfileConflict();
	}
	// A live PID, including a reused PID, never authorizes recovery.
	ownerProfileConflict();
}
function reclaimOwnerConfigLock(input: OwnerProfileConfigInput, path: string): void {
	const auth = input.lockAuthentication;
	if (!auth) ownerProfileConflict();
	assertFile(path, { private: true });
	const snapshot = ownerFileSnapshot(path);
	const record = ownerObject(JSON.parse(snapshot.text));
	if (
		Object.keys(record).sort().join() !== "mac,operation,pid,purpose,token" ||
		record.purpose !== "owner-profile-config-v1" ||
		typeof record.pid !== "number" ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.token !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.token) ||
		record.operation !== configLockOperation(input) ||
		typeof record.mac !== "string" ||
		!/^[0-9a-f]{64}$/.test(record.mac) ||
		!timingSafeEqual(Buffer.from(record.mac, "hex"), configLockMac(auth.privateKey, record))
	)
		ownerProfileConflict();
	input.assertRuntime();
	assertDeadConfigWriter(record.pid);
	assertFile(path, { private: true });
	assertOwnerFileSnapshot(path, snapshot);
	unlinkSync(path);
	syncDirectory(dirname(path));
}
function ownerConfigLockText(input: OwnerProfileConfigInput): string {
	const record = {
		purpose: "owner-profile-config-v1",
		token: randomUUID(),
		pid: process.pid,
		operation: configLockOperation(input),
	};
	const mac = input.lockAuthentication
		? configLockMac(input.lockAuthentication.privateKey, record).toString("hex")
		: undefined;
	return JSON.stringify({ ...record, mac });
}
function stageOwnerConfigLock(
	input: OwnerProfileConfigInput,
	path: string,
): { path: string; snapshot: OwnerFileSnapshot; fd: number } {
	const temporary = `${path}.tmp-${randomUUID()}`;
	const fd = openSync(temporary, "wx", 0o600);
	let identity: Pick<OwnerFileSnapshot, "dev" | "ino"> | undefined;
	try {
		const node = fstatSync(fd, { bigint: true });
		identity = { dev: String(node.dev), ino: String(node.ino) };
		writeFileSync(fd, ownerConfigLockText(input));
		fsyncSync(fd);
		const snapshot = ownerFileSnapshot(temporary);
		if (snapshot.dev !== identity.dev || snapshot.ino !== identity.ino) ownerProfileConflict();
		return { path: temporary, snapshot, fd };
	} catch (error) {
		if (identity) cleanupUnpublishedConfigLock(temporary, identity);
		closeSync(fd);
		throw error;
	}
}
function cleanupUnpublishedConfigLock(
	path: string,
	identity: Pick<OwnerFileSnapshot, "dev" | "ino">,
): void {
	try {
		const node = lstatSync(path, { bigint: true });
		if (
			!node.isFile() ||
			node.isSymbolicLink() ||
			node.nlink !== 1n ||
			String(node.dev) !== identity.dev ||
			String(node.ino) !== identity.ino
		)
			return;
		unlinkSync(path);
	} catch {
		// Never remove an unverifiable replacement or hide the original publication failure.
	}
}
function publishOwnerConfigLock(
	input: OwnerProfileConfigInput,
	temporary: string,
	path: string,
): void {
	try {
		linkSync(temporary, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		reclaimOwnerConfigLock(input, path);
		// Exclusive creation still refuses a writer that won the race after recovery.
		linkSync(temporary, path);
	}
}
function acquireOwnerConfigLock(input: OwnerProfileConfigInput, path: string): OwnerFileSnapshot {
	const temporary = stageOwnerConfigLock(input, path);
	try {
		publishOwnerConfigLock(input, temporary.path, path);
		assertPublishedConfigLock(temporary.path, temporary.snapshot);
		unlinkSync(temporary.path);
		// Removing the temporary hard link changes ctime; snapshot only after that change.
		// On a directory-sync failure, retain the complete authenticated named lock for recovery.
		syncDirectory(dirname(path));
		return assertPublishedConfigLock(path, temporary.snapshot);
	} catch (error) {
		// Keep the fd open so the owned inode cannot be recycled during cleanup.
		// Multiple links mean publication may have committed: leave them for authenticated recovery.
		cleanupUnpublishedConfigLock(temporary.path, temporary.snapshot);
		throw error;
	} finally {
		closeSync(temporary.fd);
	}
}
function assertPublishedConfigLock(path: string, staged: OwnerFileSnapshot): OwnerFileSnapshot {
	const current = ownerFileSnapshot(path);
	if (current.dev !== staged.dev || current.ino !== staged.ino || current.text !== staged.text)
		ownerProfileConflict();
	return current;
}
function ownerConfigMetadata(path: string, snapshot: OwnerFileSnapshot): ConfigFileMetadata {
	const node = lstatSync(path, { bigint: true });
	if (
		!node.isFile() ||
		node.isSymbolicLink() ||
		String(node.dev) !== snapshot.dev ||
		String(node.ino) !== snapshot.ino ||
		String(node.ctimeNs) !== snapshot.ctime
	)
		ownerProfileConflict();
	assertOwnerFileSnapshot(path, snapshot);
	return { mode: Number(node.mode & 0o7777n), uid: Number(node.uid), gid: Number(node.gid) };
}
/** Config CAS preserves every unrelated value, including nested config. DB is already committed. */
export function applyOwnerProfileConfig(input: OwnerProfileConfigInput): void {
	const path = input.paths.configPath;
	const lockPath = `${path}.lock`;
	const lock = acquireOwnerConfigLock(input, lockPath);
	try {
		const verify = () => {
			input.assertRuntime();
			assertOwnerFileSnapshot(path, input.snapshot);
			assertOwnerFileSnapshot(lockPath, lock);
		};
		verify();
		const metadata = ownerConfigMetadata(path, input.snapshot);
		const config = ownerObject(
			JSON.parse(stripTrailingCommas(stripJsonComments(input.snapshot.text))),
		);
		atomicReplaceConfigFile(
			path,
			`${JSON.stringify({ ...config, actor_id: input.identityId, sync_coordinator_url: input.coordinatorOrigin, sync_coordinator_group: input.groupId }, null, 2)}\n`,
			metadata,
			undefined,
			verify,
			{ followSymlink: false },
		);
	} finally {
		assertOwnerFileSnapshot(lockPath, lock);
		unlinkSync(lockPath);
		syncDirectory(dirname(path));
	}
}
