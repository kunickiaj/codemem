/**
 * Durability layer for `claude-hook-ingest`: file-based mutex to
 * serialize concurrent invocations, on-disk spool that captures
 * payloads when both HTTP and direct ingestion paths fail, and a
 * recovery routine that promotes stale temp files back into the queue.
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
import { logHookFailure } from "./claude-hook-plugin-log.js";

const DEFAULT_LOCK_TTL_S = 300;
const DEFAULT_LOCK_GRACE_S = 2;
const LOCK_ACQUIRE_ATTEMPTS = 100;
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

export class LockBusyError extends Error {
	constructor() {
		super("claude-hook-ingest lock busy");
		this.name = "LockBusyError";
	}
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

function envTruthy(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function lockConfig(): LockConfig {
	const lockDir = expandHome(
		process.env.CODEMEM_CLAUDE_HOOK_LOCK_DIR?.trim() || "~/.codemem/claude-hook-ingest.lock",
	);
	return {
		lockDir,
		ttlSeconds: Math.max(1, envInt("CODEMEM_CLAUDE_HOOK_LOCK_TTL_S", DEFAULT_LOCK_TTL_S)),
		graceSeconds: Math.max(1, envInt("CODEMEM_CLAUDE_HOOK_LOCK_GRACE_S", DEFAULT_LOCK_GRACE_S)),
	};
}

export function spoolDir(): string {
	return expandHome(
		process.env.CODEMEM_CLAUDE_HOOK_SPOOL_DIR?.trim() || "~/.codemem/claude-hook-spool",
	);
}

/**
 * Cheap pre-check used by the unlocked HTTP-success path to decide
 * whether it needs to acquire the ingest lock and drain queued
 * payloads. Returns true when the spool directory contains at least
 * one active entry (a `*.json` file that is neither an in-flight
 * `.hook-tmp-*` nor a quarantined `.bad-*` file). Any I/O failure
 * is treated as "no entries" so callers stay on the fast path.
 */
export function hasSpooledEntries(): boolean {
	const dir = spoolDir();
	let entries: string[];
	try {
		entries = readdirSync(dir);
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

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding the claude-hook-ingest lock. Throws
 * `LockBusyError` when the lock cannot be acquired within
 * `LOCK_ACQUIRE_ATTEMPTS` attempts.
 *
 * The lock is a directory at `lockDir`, with three sentinel files
 * (`pid`, `ts`, `owner`) recording who currently holds it. Stale locks
 * are detected via PID liveness, TTL, and a grace window for the
 * race between mkdir and writing pid/ts.
 */
export async function withClaudeHookIngestLock<T>(fn: () => Promise<T> | T): Promise<T> {
	const cfg = lockConfig();
	mkdirSync(dirname(cfg.lockDir), { recursive: true });
	const ownerToken = `${process.pid}-${Math.floor(Date.now() / 1000)}-${randomInt(1000, 10000)}`;

	let acquired = false;
	for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
		try {
			mkdirSync(cfg.lockDir);
		} catch (err) {
			if (isErrnoException(err) && err.code === "EEXIST") {
				const { stale, snapshot } = lockIsStale(cfg);
				if (stale) {
					cleanupLockDirIfUnchanged(cfg.lockDir, snapshot);
				}
				await sleep(LOCK_ACQUIRE_BACKOFF_MS);
				continue;
			}
			await sleep(LOCK_ACQUIRE_BACKOFF_MS);
			continue;
		}

		try {
			writeFileSync(join(cfg.lockDir, "ts"), String(Math.floor(Date.now() / 1000)), {
				encoding: "utf8",
			});
			writeFileSync(join(cfg.lockDir, "pid"), String(process.pid), { encoding: "utf8" });
			writeFileSync(join(cfg.lockDir, "owner"), ownerToken, { encoding: "utf8" });
			acquired = true;
			break;
		} catch {
			cleanupLockDir(cfg.lockDir);
			await sleep(LOCK_ACQUIRE_BACKOFF_MS);
		}
	}

	if (!acquired) {
		throw new LockBusyError();
	}

	try {
		return await fn();
	} finally {
		const currentOwner = readFileTrimmedOrEmpty(join(cfg.lockDir, "owner"));
		if (currentOwner === ownerToken) {
			cleanupLockDir(cfg.lockDir);
		}
	}
}

/**
 * Persist a payload to the spool directory using a tmp+rename so that
 * a partially-written file is never visible to the drainer. Returns
 * true on success, false on any I/O failure.
 */
export function spoolPayload(payload: Record<string, unknown>): boolean {
	const dir = spoolDir();
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		logHookFailure("codemem claude-hook-ingest failed to create spool dir");
		return false;
	}

	const payloadText = JSON.stringify(payload);
	const tmpName = `.hook-tmp-${process.pid}-${Date.now()}-${randomInt(1000, 10000)}.json`;
	const tmpPath = join(dir, tmpName);
	try {
		writeFileSync(tmpPath, payloadText, { encoding: "utf8" });
	} catch {
		logHookFailure("codemem claude-hook-ingest failed to allocate spool temp file");
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
		logHookFailure("codemem claude-hook-ingest failed to spool payload");
		return false;
	}
	logHookFailure(`codemem claude-hook-ingest spooled payload: ${finalPath}`);
	return true;
}

/**
 * Promote any `.hook-tmp-*.json` files older than `ttlSeconds` to a
 * recovered name so they are picked up by the next drain. Caller is
 * responsible for passing the same TTL used by lock acquisition so
 * that an in-flight write inside an active locked region is never
 * mistaken for a crashed-writer leftover.
 */
export function recoverStaleTmpSpool(ttlSeconds: number): void {
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
			logHookFailure(
				`codemem claude-hook-ingest recovered stale temp spool payload: ${recoveredPath}`,
			);
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
		logHookFailure(
			`codemem claude-hook-ingest quarantined corrupt spool payload (${reason}): ${quarantineName}`,
		);
	} catch {
		// If rename fails, fall back to delete; either way the broken
		// entry must not stay in the active queue.
		try {
			unlinkSync(sourcePath);
			logHookFailure(
				`codemem claude-hook-ingest dropped corrupt spool payload (${reason}): ${name}`,
			);
		} catch {
			// best-effort
		}
	}
}

export type SpoolHandler = (payload: Record<string, unknown>) => Promise<boolean> | boolean;

export type SpoolDrainResult = {
	processed: number;
	failed: number;
};

/**
 * Process every queued payload in the spool directory in lexicographic
 * order (which approximates oldest-first because filenames embed the
 * second-precision creation timestamp). The handler returns true to
 * indicate the payload has been durably accepted; only then is the
 * spool entry deleted. Failed entries are left on disk for the next
 * drain attempt.
 */
export async function drainSpool(handler: SpoolHandler): Promise<SpoolDrainResult> {
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
			logHookFailure(`codemem claude-hook-ingest failed to read spooled payload: ${path}`);
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
			logHookFailure(`codemem claude-hook-ingest failed processing spooled payload: ${path}`);
			result.failed++;
		}
	}
	return result;
}

/**
 * Whether the boundary-flush write-through should run for this hook
 * payload. SessionEnd defaults to forcing a flush; Stop only flushes
 * when both CODEMEM_CLAUDE_HOOK_FLUSH and CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP
 * are truthy.
 */
export function shouldForceBoundaryFlush(payload: Record<string, unknown>): boolean {
	const eventName =
		typeof payload.hook_event_name === "string" ? payload.hook_event_name.trim() : "";
	if (eventName !== "Stop" && eventName !== "SessionEnd") return false;
	if (eventName === "SessionEnd") {
		return envTruthy("CODEMEM_CLAUDE_HOOK_FLUSH", true);
	}
	if (!envTruthy("CODEMEM_CLAUDE_HOOK_FLUSH", false)) return false;
	return envTruthy("CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP", false);
}

/**
 * Returns the configured lock TTL so callers (`claude-hook-ingest`)
 * can pass the same value to `recoverStaleTmpSpool` without re-reading
 * the env.
 */
export function lockTtlSeconds(): number {
	return lockConfig().ttlSeconds;
}
