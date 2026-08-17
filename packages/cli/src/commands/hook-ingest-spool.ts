/**
 * Shared durability layer for the hook ingest commands (claude, codex):
 * a file-based mutex that serializes concurrent invocations, an on-disk
 * spool that captures payloads when both HTTP and direct ingestion fail,
 * and a recovery routine that promotes stale temp files back into the
 * queue. Each client instantiates its own copy via `createHookIngestSpool`
 * with its own lock/spool dirs, TTL, retry budget, log prefix, and
 * client-specific `LockBusyError` name/message. Per-client flush
 * predicates stay in the client files.
 */

import { randomInt } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logHookEvent } from "./claude-hook-plugin-log.js";

const LOCK_ACQUIRE_BACKOFF_MS = 50;

type LockSnapshot = {
	pid: string;
	ts: number | null;
	owner: string;
};

type LockConfig = {
	lockDir: string;
	ttlSeconds: number;
	graceSeconds: number;
};

export type SpoolHandler = (payload: Record<string, unknown>) => Promise<boolean> | boolean;

export type SpoolDrainResult = {
	processed: number;
	failed: number;
};

export type HookIngestSpoolConfig = {
	/** Log prefix, e.g. "codemem claude-hook-ingest". */
	logPrefix: string;
	lockDirEnv: string;
	lockDirDefault: string;
	lockTtlEnv: string;
	lockTtlDefault: number;
	lockGraceEnv: string;
	lockGraceDefault: number;
	lockAcquireAttempts: number;
	spoolDirEnv: string;
	spoolDirDefault: string;
	lockBusyErrorName: string;
	lockBusyErrorMessage: string;
};

export type HookIngestSpool = {
	LockBusyError: new () => Error;
	spoolDir: () => string;
	lockTtlSeconds: () => number;
	hasSpooledEntries: () => boolean;
	withLock: <T>(fn: () => Promise<T> | T) => Promise<T>;
	spoolPayload: (payload: Record<string, unknown>) => boolean;
	recoverStaleTmpSpool: (ttlSeconds: number) => void;
	drainSpool: (handler: SpoolHandler) => Promise<SpoolDrainResult>;
};

/**
 * Boolean-shaped env toggle used by per-client flush predicates
 * (claude's `shouldForceBoundaryFlush`).
 */
export function envTruthy(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function createHookIngestSpool(cfg: HookIngestSpoolConfig): HookIngestSpool {
	class LockBusyError extends Error {
		constructor() {
			super(cfg.lockBusyErrorMessage);
			this.name = cfg.lockBusyErrorName;
		}
	}

	function lockConfig(): LockConfig {
		return {
			lockDir: expandHome(process.env[cfg.lockDirEnv]?.trim() || cfg.lockDirDefault),
			ttlSeconds: Math.max(1, envInt(cfg.lockTtlEnv, cfg.lockTtlDefault)),
			graceSeconds: Math.max(1, envInt(cfg.lockGraceEnv, cfg.lockGraceDefault)),
		};
	}

	function spoolDir(): string {
		return expandHome(process.env[cfg.spoolDirEnv]?.trim() || cfg.spoolDirDefault);
	}

	/**
	 * Returns the configured lock TTL so callers (hook-ingest commands)
	 * can pass the same value to `recoverStaleTmpSpool` without re-reading
	 * the env.
	 */
	function lockTtlSeconds(): number {
		return lockConfig().ttlSeconds;
	}

	/**
	 * Cheap pre-check used by the unlocked HTTP-success path to decide
	 * whether it needs to acquire the ingest lock and drain queued
	 * payloads. Returns true when the spool directory contains at least
	 * one active entry (a `*.json` file that is neither an in-flight
	 * `.hook-tmp-*` nor a quarantined `.bad-*` file). Any I/O failure
	 * is treated as "no entries" so callers stay on the fast path.
	 */
	function hasSpooledEntries(): boolean {
		let entries: string[];
		try {
			entries = readdirSync(spoolDir());
		} catch {
			return false;
		}
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			if (name.startsWith(".hook-tmp-") || name.startsWith(".bad-")) continue;
			return true;
		}
		return false;
	}

	function readFileTrimmedOrEmpty(path: string): string {
		try {
			return readFileSync(path, "utf8").trim();
		} catch {
			return "";
		}
	}

	function readLockMetadata(lockDir: string): LockSnapshot {
		const pid = readFileTrimmedOrEmpty(join(lockDir, "pid"));
		const owner = readFileTrimmedOrEmpty(join(lockDir, "owner"));
		const tsRaw = readFileTrimmedOrEmpty(join(lockDir, "ts"));
		const ts = tsRaw === "" ? null : Number.parseInt(tsRaw, 10);
		return {
			pid,
			ts: ts === null || !Number.isFinite(ts) ? null : ts,
			owner,
		};
	}

	function isPidAlive(pidText: string): boolean {
		const pid = Number.parseInt(pidText, 10);
		if (!Number.isFinite(pid) || pid <= 0) return false;
		try {
			// Signal 0 performs the existence check without delivering a signal.
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	function lockIsStale(cfg: LockConfig): { stale: boolean; snapshot: LockSnapshot } {
		const snapshot = readLockMetadata(cfg.lockDir);
		const nowS = Math.floor(Date.now() / 1000);

		if (snapshot.pid) {
			if (isPidAlive(snapshot.pid)) {
				if (snapshot.ts === null) return { stale: false, snapshot };
				return { stale: nowS - snapshot.ts > cfg.ttlSeconds, snapshot };
			}
			return { stale: true, snapshot };
		}

		if (snapshot.ts !== null) {
			return { stale: nowS - snapshot.ts > cfg.graceSeconds, snapshot };
		}

		let mtimeS: number;
		try {
			mtimeS = Math.floor(statSync(cfg.lockDir).mtimeMs / 1000);
		} catch {
			return { stale: true, snapshot };
		}
		return { stale: nowS - mtimeS > cfg.graceSeconds, snapshot };
	}

	function cleanupLockDir(lockDir: string): void {
		for (const name of ["pid", "ts", "owner"]) {
			try {
				unlinkSync(join(lockDir, name));
			} catch {
				// best-effort
			}
		}
		try {
			rmdirSync(lockDir);
		} catch {
			// best-effort
		}
	}

	function snapshotsEqual(a: LockSnapshot, b: LockSnapshot): boolean {
		return a.pid === b.pid && a.ts === b.ts && a.owner === b.owner;
	}

	function cleanupLockDirIfUnchanged(lockDir: string, snapshot: LockSnapshot): void {
		const current = readLockMetadata(lockDir);
		if (snapshotsEqual(current, snapshot)) {
			cleanupLockDir(lockDir);
		}
	}

	function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
		return typeof err === "object" && err !== null && "code" in err;
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Run `fn` while holding the client's ingest lock. Throws the
	 * client-specific `LockBusyError` when the lock cannot be acquired
	 * within `cfg.lockAcquireAttempts` attempts.
	 *
	 * The lock is a directory at `lockDir`, with three sentinel files
	 * (`pid`, `ts`, `owner`) recording who currently holds it. Stale locks
	 * are detected via PID liveness, TTL, and a grace window for the
	 * race between mkdir and writing pid/ts.
	 */
	async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
		const lock = lockConfig();
		mkdirSync(dirname(lock.lockDir), { recursive: true });
		const ownerToken = `${process.pid}-${Math.floor(Date.now() / 1000)}-${randomInt(1000, 10000)}`;

		let acquired = false;
		for (let attempt = 0; attempt < cfg.lockAcquireAttempts; attempt++) {
			try {
				mkdirSync(lock.lockDir);
			} catch (err) {
				if (isErrnoException(err) && err.code === "EEXIST") {
					const { stale, snapshot } = lockIsStale(lock);
					if (stale) {
						cleanupLockDirIfUnchanged(lock.lockDir, snapshot);
					}
				}
				await sleep(LOCK_ACQUIRE_BACKOFF_MS);
				continue;
			}

			try {
				writeFileSync(join(lock.lockDir, "ts"), String(Math.floor(Date.now() / 1000)), {
					encoding: "utf8",
				});
				writeFileSync(join(lock.lockDir, "pid"), String(process.pid), { encoding: "utf8" });
				writeFileSync(join(lock.lockDir, "owner"), ownerToken, { encoding: "utf8" });
				acquired = true;
				break;
			} catch {
				cleanupLockDir(lock.lockDir);
				await sleep(LOCK_ACQUIRE_BACKOFF_MS);
			}
		}

		if (!acquired) {
			throw new LockBusyError();
		}

		try {
			return await fn();
		} finally {
			const currentOwner = readFileTrimmedOrEmpty(join(lock.lockDir, "owner"));
			if (currentOwner === ownerToken) {
				cleanupLockDir(lock.lockDir);
			}
		}
	}

	/**
	 * Persist a payload to the spool directory using a tmp+rename so that
	 * a partially-written file is never visible to the drainer. Returns
	 * true on success, false on any I/O failure.
	 */
	function spoolPayload(payload: Record<string, unknown>): boolean {
		const dir = spoolDir();
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			logHookEvent(`${cfg.logPrefix} failed to create spool dir`);
			return false;
		}

		const payloadText = JSON.stringify(payload);
		const tmpName = `.hook-tmp-${process.pid}-${Date.now()}-${randomInt(1000, 10000)}.json`;
		const tmpPath = join(dir, tmpName);
		try {
			writeFileSync(tmpPath, payloadText, { encoding: "utf8" });
		} catch {
			logHookEvent(`${cfg.logPrefix} failed to allocate spool temp file`);
			return false;
		}

		const finalName = `hook-${Math.floor(Date.now() / 1000)}-${process.pid}-${randomInt(1000, 10000)}.json`;
		const finalPath = join(dir, finalName);
		try {
			renameSync(tmpPath, finalPath);
		} catch {
			try {
				unlinkSync(tmpPath);
			} catch {
				// best-effort
			}
			logHookEvent(`${cfg.logPrefix} failed to spool payload`);
			return false;
		}
		logHookEvent(`${cfg.logPrefix} spooled payload: ${finalPath}`);
		return true;
	}

	/**
	 * Promote any `.hook-tmp-*.json` files older than `ttlSeconds` to a
	 * recovered name so they are picked up by the next drain. Caller is
	 * responsible for passing the same TTL used by lock acquisition so
	 * that an in-flight write inside an active locked region is never
	 * mistaken for a crashed-writer leftover.
	 */
	function recoverStaleTmpSpool(ttlSeconds: number): void {
		const dir = spoolDir();
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			return;
		}

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		const nowS = Date.now() / 1000;
		for (const name of entries) {
			if (!name.startsWith(".hook-tmp-") || !name.endsWith(".json")) continue;
			const tmpPath = join(dir, name);
			let mtimeS: number;
			try {
				mtimeS = statSync(tmpPath).mtimeMs / 1000;
			} catch {
				continue;
			}
			if (nowS - mtimeS <= ttlSeconds) continue;

			const recoveredName = `hook-recovered-${Math.floor(nowS)}-${process.pid}-${randomInt(1000, 10000)}.json`;
			const recoveredPath = join(dir, recoveredName);
			try {
				renameSync(tmpPath, recoveredPath);
				logHookEvent(`${cfg.logPrefix} recovered stale temp spool payload: ${recoveredPath}`);
			} catch {
				// best-effort
			}
		}
	}

	/**
	 * Move a permanently-broken spool entry out of the queue so that it
	 * stops being picked up by future drains. The entry is renamed in
	 * place with a `.bad-<reason>-` prefix so an operator can inspect or
	 * delete it manually.
	 */
	function quarantineSpoolEntry(dir: string, name: string, reason: string): void {
		const sourcePath = join(dir, name);
		const quarantineName = `.bad-${reason}-${Date.now()}-${randomInt(1000, 10000)}-${name}`;
		try {
			renameSync(sourcePath, join(dir, quarantineName));
			logHookEvent(
				`${cfg.logPrefix} quarantined corrupt spool payload (${reason}): ${quarantineName}`,
			);
		} catch {
			// If rename fails, fall back to delete; either way the broken
			// entry must not stay in the active queue.
			try {
				unlinkSync(sourcePath);
				logHookEvent(`${cfg.logPrefix} dropped corrupt spool payload (${reason}): ${name}`);
			} catch {
				// best-effort
			}
		}
	}

	/**
	 * Process every queued payload in the spool directory in lexicographic
	 * order (which approximates oldest-first because filenames embed the
	 * second-precision creation timestamp). The handler returns true to
	 * indicate the payload has been durably accepted; only then is the
	 * spool entry deleted. Failed entries are left on disk for the next
	 * drain attempt.
	 */
	async function drainSpool(handler: SpoolHandler): Promise<SpoolDrainResult> {
		const dir = spoolDir();
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			return { processed: 0, failed: 0 };
		}

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return { processed: 0, failed: 0 };
		}

		const queued = entries
			.filter(
				(name) =>
					name.endsWith(".json") && !name.startsWith(".hook-tmp-") && !name.startsWith(".bad-"),
			)
			.sort();

		const result: SpoolDrainResult = { processed: 0, failed: 0 };
		for (const name of queued) {
			const path = join(dir, name);
			let raw: string;
			try {
				raw = readFileSync(path, "utf8");
			} catch {
				// Genuine I/O failure — leave the file alone so the next drain
				// can retry, and surface the failure to the plugin log.
				logHookEvent(`${cfg.logPrefix} failed to read spooled payload: ${path}`);
				result.failed++;
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// Permanently corrupt content — keeping the file around would
				// loop forever every drain. Quarantine it under a `.bad-` prefix
				// so an operator can inspect it without it being picked up again.
				quarantineSpoolEntry(dir, name, "parse-error");
				result.failed++;
				continue;
			}
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
				// Parseable but wrong shape — same problem, same fix.
				quarantineSpoolEntry(dir, name, "wrong-shape");
				result.failed++;
				continue;
			}

			let ok = false;
			try {
				ok = await handler(parsed as Record<string, unknown>);
			} catch {
				ok = false;
			}

			if (ok) {
				try {
					unlinkSync(path);
					result.processed++;
				} catch {
					// best-effort
				}
			} else {
				logHookEvent(`${cfg.logPrefix} failed processing spooled payload: ${path}`);
				result.failed++;
			}
		}
		return result;
	}

	return {
		LockBusyError,
		spoolDir,
		lockTtlSeconds,
		hasSpooledEntries,
		withLock,
		spoolPayload,
		recoverStaleTmpSpool,
		drainSpool,
	};
}
