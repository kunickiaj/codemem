import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	type Stats,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES,
	RawEventSpoolInspectionError,
	type RejectedRawEventDeliveryResult,
	type RejectedRawEventInspection,
	type RejectedRawEventMetadata,
} from "../../../opencode-plugin/.opencode/lib/raw-event-spool.js";
import { spoolDir } from "./claude-hook-ingest-spool.js";
import { codexHookSpoolDir } from "./codex-hook-ingest-spool.js";
import { piHookSpoolDir } from "./pi-hook-ingest-spool.js";

export type NativeHookProvider = "claude" | "codex" | "pi";
const originalPattern =
	/^(?:hook-(?:recovered-)?[0-9]+-[1-9][0-9]*-[1-9][0-9]{3}|zz-hook-live-[0-9]{13}-z[0-9]{20}-[1-9][0-9]*-[1-9][0-9]{3})\.json$/;
const retainedPattern = /^rejected-(400-invalid_payload|413-payload_too_large)-(.+)\.retained$/;
const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const posix = process.platform !== "win32";
const lockPurpose = "native-hook-receipt";
function isOriginalName(name: string): boolean {
	return originalPattern.exec(name)?.[0] === name;
}

type NativeHookRecoveryState =
	| {
			delivery: "not_attempted";
			cleanup: "not_attempted";
			reason:
				| "invalid_receipt"
				| "invalid_provider"
				| "invalid_delivery"
				| "receipt_not_found"
				| "inspection_failed"
				| "unsafe_directory"
				| "unsafe_entry"
				| "invalid"
				| "read_limit_exceeded"
				| "changed_during_read"
				| "lock_busy"
				| "lock_repair_required"
				| "lock_failed";
	  }
	| {
			delivery: "unacknowledged";
			cleanup: "not_attempted";
			reason: "delivery_failed" | "delivery_rejected" | "invalid_acknowledgement";
	  }
	| {
			delivery: "accepted";
			acknowledgement: "queued" | "ingested";
			cleanup: "changed" | "failed" | "removed" | "kept" | "uncertain";
	  };
export type NativeHookRecoveryResult = NativeHookRecoveryState & {
	lock: "not_acquired" | "released" | "release_failed";
};
type NativeHookDelivery = (entry: {
	serialized: string;
}) => RejectedRawEventDeliveryResult | Promise<RejectedRawEventDeliveryResult>;
type NativeHookSnapshot = {
	dir: string;
	dirFd: number;
	path: string;
	fd: number;
	details: Stats;
	serialized: string;
	lock: ReturnType<typeof acquireLock>;
};

function nativeRecoveryFailure(
	error: unknown,
): Extract<NativeHookRecoveryState, { delivery: "not_attempted" }> {
	const safeCodes = [
		"invalid_receipt",
		"invalid_provider",
		"invalid_delivery",
		"unsafe_directory",
		"unsafe_entry",
		"changed_during_read",
		"lock_busy",
		"lock_repair_required",
		"lock_failed",
	] as const;
	let reason: Extract<NativeHookRecoveryState, { delivery: "not_attempted" }>["reason"] =
		"inspection_failed";
	if (hasCode(error, "ENOENT")) reason = "receipt_not_found";
	if (error instanceof RawEventSpoolInspectionError) {
		const code = safeCodes.find((candidate) => candidate === error.code);
		if (code) reason = code;
	}
	return { delivery: "not_attempted", cleanup: "not_attempted", reason };
}

async function nativeDeliveryAcknowledgement(
	deliver: NativeHookDelivery,
	serialized: string,
): Promise<
	| Extract<NativeHookRecoveryState, { delivery: "unacknowledged" }>
	| Omit<Extract<NativeHookRecoveryState, { delivery: "accepted" }>, "cleanup">
> {
	let result: unknown;
	try {
		result = await deliver({ serialized });
	} catch {
		return { delivery: "unacknowledged", cleanup: "not_attempted", reason: "delivery_failed" };
	}
	try {
		const record = result && typeof result === "object" && !Array.isArray(result) ? result : null;
		const keys = record ? Reflect.ownKeys(record).sort().join() : "";
		const acknowledged: unknown = record
			? Object.getOwnPropertyDescriptor(record, "acknowledged")?.value
			: undefined;
		const acknowledgement: unknown = record
			? Object.getOwnPropertyDescriptor(record, "acknowledgement")?.value
			: undefined;
		if (result === false || (keys === "acknowledged" && acknowledged === false))
			return { delivery: "unacknowledged", cleanup: "not_attempted", reason: "delivery_rejected" };
		if (
			keys === "acknowledged,acknowledgement" &&
			acknowledged === true &&
			(acknowledgement === "queued" || acknowledgement === "ingested")
		)
			return { delivery: "accepted", acknowledgement };
	} catch {
		/* Unverifiable acknowledgements never authorize removal. */
	}
	return {
		delivery: "unacknowledged",
		cleanup: "not_attempted",
		reason: "invalid_acknowledgement",
	};
}

function assertNativeRecoverySnapshot(snapshot: NativeHookSnapshot): void {
	const { dir, dirFd, path, fd, details, serialized, lock } = snapshot;
	if (!sameInode(requireSafeSpoolDirectory(dir), fstatSync(dirFd))) fail("unsafe_directory");
	assertLock(lock);
	for (const current of [fstatSync(fd), lstatSync(path)]) {
		requireFile(current);
		if (!sameSnapshot(details, current)) fail("changed_during_read");
	}
	const bytes = readLimited(fd, MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES);
	if (
		!bytes?.equals(Buffer.from(serialized, "utf8")) ||
		!sameSnapshot(details, fstatSync(fd)) ||
		!sameSnapshot(details, lstatSync(path))
	)
		fail("changed_during_read");
	if (!sameInode(requireSafeSpoolDirectory(dir), fstatSync(dirFd))) fail("unsafe_directory");
	assertLock(lock);
}

function finishNativeRecovery(
	snapshot: NativeHookSnapshot,
	keepReceipt?: boolean,
): Extract<NativeHookRecoveryState, { delivery: "accepted" }>["cleanup"] {
	try {
		assertNativeRecoverySnapshot(snapshot);
	} catch (error) {
		if (
			error instanceof RawEventSpoolInspectionError ||
			hasCode(error, "ENOENT") ||
			hasCode(error, "ELOOP")
		)
			return "changed";
		return "failed";
	}
	if (keepReceipt === true) return "kept";
	try {
		unlinkSync(snapshot.path);
	} catch {
		return "failed";
	}
	try {
		fsyncSync(snapshot.dirFd);
		return "removed";
	} catch {
		return "uncertain";
	}
}

async function deliverNativeRecovery(
	snapshot: Omit<NativeHookSnapshot, "fd" | "details" | "serialized">,
	metadata: Omit<RejectedRawEventMetadata, "bytes">,
	deliver: NativeHookDelivery,
	keepReceipt?: boolean,
): Promise<NativeHookRecoveryState> {
	const fd = openFile(snapshot.path);
	try {
		const details = fstatSync(fd);
		const inspection = inspectOpened(fd, snapshot.path, metadata);
		if (inspection.validation !== "valid")
			return { delivery: "not_attempted", cleanup: "not_attempted", reason: inspection.validation };
		const opened = { ...snapshot, fd, details, serialized: inspection.serialized };
		assertNativeRecoverySnapshot(opened);
		const delivery = await nativeDeliveryAcknowledgement(deliver, inspection.serialized);
		if (delivery.delivery !== "accepted") return delivery;
		return { ...delivery, cleanup: finishNativeRecovery(opened, keepReceipt) };
	} finally {
		closeNativeRecoveryFd(fd);
	}
}

function closeNativeRecoveryFd(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		/* Closing must not replace delivery or cleanup results. */
	}
}

export async function recoverNativeHookReceipt({
	provider,
	receipt,
	deliver,
	keepReceipt,
}: {
	provider: NativeHookProvider;
	receipt: string;
	deliver: NativeHookDelivery;
	keepReceipt?: boolean;
}): Promise<NativeHookRecoveryResult> {
	let dirFd: number | undefined;
	let lock: ReturnType<typeof acquireLock> | undefined;
	let result: NativeHookRecoveryState;
	try {
		const metadata = parseReceipt(receipt);
		if (typeof deliver !== "function") fail("invalid_delivery");
		const dir = providerDirectory(provider);
		const directory = requireSafeSpoolDirectory(dir);
		dirFd = openSync(dir, flags | (constants.O_DIRECTORY ?? 0));
		if (!sameInode(directory, fstatSync(dirFd))) fail("unsafe_directory");
		const original = receipt.slice(
			`rejected-${metadata.status}-${metadata.reason}-`.length,
			-".retained".length,
		);
		lock = acquireLock(dir, original, dirFd);
		result = await deliverNativeRecovery(
			{ dir, dirFd, path: join(dir, receipt), lock },
			metadata,
			deliver,
			keepReceipt,
		);
	} catch (error) {
		result = nativeRecoveryFailure(error);
	}
	let lockStatus: NativeHookRecoveryResult["lock"] = "not_acquired";
	if (lock && dirFd !== undefined)
		lockStatus = releaseLock(lock, dirFd) ? "released" : "release_failed";
	if (dirFd !== undefined) closeNativeRecoveryFd(dirFd);
	return { ...result, lock: lockStatus };
}

function inspectionError(code: string): RawEventSpoolInspectionError {
	let message = code.startsWith("lock_")
		? "Retained event lock is unavailable. Stop capture before repairing its lock."
		: "Could not inspect or retain the receipt safely. Files were left in place for inspection.";
	if (code === "lock_failed") {
		message = "Could not create the receipt lock. Check storage and write access, then retry.";
	}
	if (code === "unsafe_directory") {
		message =
			"Stop capture and verify directory safety before retrying. The spool and its immediate parent must be real directories, not symlinks. On POSIX, the spool must be owned by the current user and not group- or other-writable. Its parent must be owned by the current user or root and must not be group- or other-writable unless sticky.";
	}
	if (code === "unsafe_entry") {
		message =
			"Stop capture and verify the receipt before retrying. It must remain the same regular file, not a symlink. On POSIX, it must not be group- or other-writable. No permissions were changed.";
	}
	return new RawEventSpoolInspectionError(code, message);
}
function fail(code: string): never {
	throw inspectionError(code);
}
function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function sameInode(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}
function sameSnapshot(a: Stats, b: Stats): boolean {
	return sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function requireFile(stat: Stats): void {
	if (!stat.isFile() || stat.isSymbolicLink() || (posix && (stat.mode & 0o022) !== 0))
		fail("unsafe_entry");
}
function requireDirectory(dir: string): Stats {
	const stat = lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_directory");
	return stat;
}
function requireSafeSpoolDirectory(dir: string): Stats {
	const stat = requireDirectory(dir);
	const parent = requireDirectory(dirname(resolve(dir)));
	if (
		posix &&
		(stat.uid !== process.geteuid?.() ||
			(stat.mode & 0o022) !== 0 ||
			(parent.uid !== process.geteuid?.() && parent.uid !== 0) ||
			((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0))
	)
		fail("unsafe_directory");
	return stat;
}
function openFile(path: string): number {
	const expected = lstatSync(path);
	requireFile(expected);
	const fd = openSync(path, flags);
	try {
		for (const actual of [fstatSync(fd), lstatSync(path)]) {
			requireFile(actual);
			if (!sameInode(actual, expected)) fail("unsafe_entry");
		}
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}
function readLimited(fd: number, limit: number): Buffer | null {
	const chunks: Buffer[] = [];
	let total = 0;
	while (total <= limit) {
		const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
		const count = readSync(fd, chunk, 0, chunk.length, total);
		if (count === 0) return Buffer.concat(chunks, total);
		total += count;
		if (total > limit) return null;
		chunks.push(chunk.subarray(0, count));
	}
	return null;
}
function parseReceipt(receipt: string): Omit<RejectedRawEventMetadata, "bytes"> {
	if (typeof receipt !== "string" || receipt.includes("/") || receipt.includes("\\"))
		fail("invalid_receipt");
	const match = retainedPattern.exec(receipt);
	if (!match?.[2] || match[0] !== receipt || !isOriginalName(match[2])) fail("invalid_receipt");
	if (match[1] === "400-invalid_payload")
		return { receipt, status: 400, reason: "invalid_payload" };
	return { receipt, status: 413, reason: "payload_too_large" };
}
function providerDirectory(provider: NativeHookProvider): string {
	if (provider === "claude") return spoolDir();
	if (provider === "codex") return codexHookSpoolDir();
	if (provider === "pi") return piHookSpoolDir();
	return fail("invalid_provider");
}
function safeFailure(error: unknown, lock?: "release_failed"): never {
	let failure: RawEventSpoolInspectionError;
	if (error instanceof RawEventSpoolInspectionError) failure = error;
	else
		failure = inspectionError(hasCode(error, "ENOENT") ? "receipt_not_found" : "inspection_failed");
	if (lock) Object.assign(failure, { lock });
	throw failure;
}

export function listNativeHookRejectedReceipts({
	provider,
}: {
	provider: NativeHookProvider;
}): (RejectedRawEventMetadata & { validation: "not_checked" })[] {
	try {
		const dir = providerDirectory(provider);
		try {
			requireSafeSpoolDirectory(dir);
		} catch (error) {
			if (hasCode(error, "ENOENT")) return [];
			throw error;
		}
		const entries: (RejectedRawEventMetadata & { validation: "not_checked" })[] = [];
		for (const name of readdirSync(dir).sort()) {
			let metadata: Omit<RejectedRawEventMetadata, "bytes">;
			try {
				metadata = parseReceipt(name);
			} catch {
				continue;
			}
			try {
				const stat = lstatSync(join(dir, name));
				requireFile(stat);
				entries.push({ ...metadata, bytes: stat.size, validation: "not_checked" });
			} catch (error) {
				if (!hasCode(error, "ENOENT")) throw error;
			}
		}
		return entries;
	} catch (error) {
		return safeFailure(error);
	}
}

function inspectOpened(
	fd: number,
	path: string,
	metadata: Omit<RejectedRawEventMetadata, "bytes">,
): RejectedRawEventInspection {
	const before = fstatSync(fd);
	const result = { ...metadata, bytes: before.size };
	if (before.size > MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES)
		return { ...result, validation: "read_limit_exceeded" };
	const bytes = readLimited(fd, MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES);
	const after = fstatSync(fd);
	let named: Stats;
	try {
		named = lstatSync(path);
	} catch {
		return { ...result, validation: "changed_during_read" };
	}
	if (!sameSnapshot(before, after) || !sameSnapshot(before, named))
		return { ...result, validation: "changed_during_read" };
	if (!bytes) return { ...result, validation: "read_limit_exceeded" };
	try {
		if (!isUtf8(bytes)) return { ...result, validation: "invalid" };
		const serialized = bytes.toString("utf8");
		const parsed: unknown = JSON.parse(serialized);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return { ...result, validation: "invalid" };
		return { ...result, validation: "valid", serialized };
	} catch {
		return { ...result, validation: "invalid" };
	}
}
export function inspectNativeHookRejectedReceipt({
	provider,
	receipt,
}: {
	provider: NativeHookProvider;
	receipt: string;
}): RejectedRawEventInspection {
	try {
		const metadata = parseReceipt(receipt);
		const dir = providerDirectory(provider);
		requireSafeSpoolDirectory(dir);
		const path = join(dir, receipt);
		const fd = openFile(path);
		try {
			return inspectOpened(fd, path, metadata);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		return safeFailure(error);
	}
}

function classifyLock(path: string, receipt: string): never {
	let code = "lock_repair_required";
	try {
		const fd = openFile(path);
		try {
			const before = fstatSync(fd);
			const bytes = before.size <= 1024 ? readLimited(fd, 1024) : null;
			if (!bytes || !sameSnapshot(before, fstatSync(fd)) || !sameSnapshot(before, lstatSync(path)))
				fail(code);
			const record = JSON.parse(bytes.toString("utf8"));
			if (
				Object.keys(record).sort().join() !== "pid,purpose,receipt,token,version" ||
				record.purpose !== lockPurpose ||
				record.version !== 1 ||
				record.receipt !== receipt ||
				!Number.isSafeInteger(record.pid) ||
				record.pid <= 0 ||
				typeof record.token !== "string" ||
				!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.token)
			)
				fail(code);
			try {
				process.kill(record.pid, 0);
				code = "lock_busy";
			} catch (error) {
				if (!hasCode(error, "ESRCH")) code = "lock_busy";
			}
		} finally {
			closeSync(fd);
		}
	} catch {
		/* Unverifiable locks require manual repair, never age-based removal. */
	}
	return fail(code);
}
function cleanupNewLock(fd: number, path: string, dirFd: number): boolean {
	try {
		if (
			!sameInode(requireSafeSpoolDirectory(dirname(path)), fstatSync(dirFd)) ||
			!sameInode(fstatSync(fd), lstatSync(path))
		)
			return false;
		unlinkSync(path);
		fsyncSync(dirFd);
		return true;
	} catch {
		return false;
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* Preserve the safe acquisition error if closing fails. */
		}
	}
}
function acquireLock(dir: string, receipt: string, dirFd: number) {
	const path = join(dir, `.native-retain-${receipt}.lock`);
	let fd: number;
	try {
		fd = openSync(
			path,
			constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
	} catch (error) {
		if (hasCode(error, "EEXIST")) return classifyLock(path, receipt);
		return fail("lock_failed");
	}
	try {
		const serialized = JSON.stringify({
			purpose: lockPurpose,
			version: 1,
			receipt,
			pid: process.pid,
			token: randomUUID(),
		});
		const data = Buffer.from(serialized);
		if (writeSync(fd, data) !== data.length) fail("lock_repair_required");
		fsyncSync(fd);
		const details = fstatSync(fd);
		requireFile(details);
		if (!sameSnapshot(details, lstatSync(path))) fail("lock_repair_required");
		return { fd, path, serialized, details };
	} catch {
		return fail(cleanupNewLock(fd, path, dirFd) ? "lock_failed" : "lock_repair_required");
	}
}
function assertLock(lock: ReturnType<typeof acquireLock>): void {
	const bytes = readLimited(lock.fd, 1024);
	if (
		!bytes ||
		bytes.toString("utf8") !== lock.serialized ||
		!sameSnapshot(lock.details, fstatSync(lock.fd)) ||
		!sameSnapshot(lock.details, lstatSync(lock.path))
	)
		fail("lock_repair_required");
}
function releaseLock(lock: ReturnType<typeof acquireLock>, dirFd: number): boolean {
	try {
		if (!sameInode(requireSafeSpoolDirectory(dirname(lock.path)), fstatSync(dirFd))) return false;
		assertLock(lock);
		unlinkSync(lock.path);
		fsyncSync(dirFd);
		return true;
	} catch {
		return false;
	} finally {
		try {
			closeSync(lock.fd);
		} catch {
			/* A release failure must not replace the primary error. */
		}
	}
}
function statIfPresent(path: string): Stats | undefined {
	try {
		const stat = lstatSync(path);
		requireFile(stat);
		return stat;
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
}
function linkIfAbsent(source: string, target: string): void {
	try {
		linkSync(source, target);
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error;
	}
}
function requireLinkedSnapshot(path: string, before: Stats): void {
	const current = lstatSync(path);
	requireFile(current);
	if (!sameInode(before, current)) fail("retention_conflict");
	if (before.size !== current.size || before.mtimeMs !== current.mtimeMs) fail("unsafe_entry");
}
function retainLinked(
	dir: string,
	dirFd: number,
	receipt: string,
	metadata: Omit<RejectedRawEventMetadata, "bytes">,
	assertOwnership: () => void,
) {
	const source = join(dir, receipt);
	const target = join(dir, metadata.receipt);
	const alternateStatus = metadata.status === 400 ? "413-payload_too_large" : "400-invalid_payload";
	if (statIfPresent(join(dir, `rejected-${alternateStatus}-${receipt}.retained`)))
		fail("retention_conflict");
	const existing = statIfPresent(target);
	if (!statIfPresent(source)) {
		if (!existing) fail("receipt_not_found");
		const fd = openFile(target);
		try {
			assertOwnership();
			fsyncSync(fd);
			fsyncSync(dirFd);
			return { ...metadata, bytes: fstatSync(fd).size, outcome: "already_retained" as const };
		} finally {
			closeSync(fd);
		}
	}
	const fd = openFile(source);
	try {
		const before = fstatSync(fd);
		if (existing && !sameInode(existing, before)) fail("retention_conflict");
		fsyncSync(fd);
		if (!sameSnapshot(before, lstatSync(source))) fail("unsafe_entry");
		assertOwnership();
		if (!existing) linkIfAbsent(source, target);
		// Persist both names before removing the source. Never substitute copy/delete.
		fsyncSync(dirFd);
		assertOwnership();
		for (const path of [source, target]) {
			requireLinkedSnapshot(path, before);
		}
		unlinkSync(source);
		fsyncSync(dirFd);
		return { ...metadata, bytes: before.size, outcome: "retained" as const };
	} finally {
		closeSync(fd);
	}
}
/** Delivery callers must also hold the provider's ingest lock to coordinate ordinary drain cleanup. */
export function retainNativeHookReceipt({
	dir,
	receipt,
	status,
	reason,
}: {
	dir: string;
	receipt: string;
	status: 400 | 413;
	reason: "invalid_payload" | "payload_too_large";
}): RejectedRawEventMetadata & {
	outcome: "retained" | "already_retained";
	lock?: "release_failed";
} {
	try {
		if (typeof receipt !== "string" || !isOriginalName(receipt)) fail("invalid_receipt");
		const metadata = parseReceipt(`rejected-${status}-${reason}-${receipt}.retained`);
		const directory = requireSafeSpoolDirectory(dir);
		const dirFd = openSync(dir, flags | (constants.O_DIRECTORY ?? 0));
		try {
			if (!sameInode(directory, fstatSync(dirFd))) fail("unsafe_directory");
			const lock = acquireLock(dir, receipt, dirFd);
			let result: ReturnType<typeof retainLinked> | undefined;
			try {
				result = retainLinked(dir, dirFd, receipt, metadata, () => {
					if (!sameInode(directory, requireSafeSpoolDirectory(dir))) fail("unsafe_directory");
					assertLock(lock);
				});
			} catch (error) {
				const released = releaseLock(lock, dirFd);
				return safeFailure(error, released ? undefined : "release_failed");
			}
			const released = releaseLock(lock, dirFd);
			return released ? result : { ...result, lock: "release_failed" };
		} finally {
			closeSync(dirFd);
		}
	} catch (error) {
		return safeFailure(error);
	}
}
