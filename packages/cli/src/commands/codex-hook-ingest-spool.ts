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

const DEFAULT_LOCK_TTL_S = 120;
const DEFAULT_LOCK_GRACE_S = 2;
const LOCK_ACQUIRE_ATTEMPTS = 20;
const LOCK_ACQUIRE_BACKOFF_MS = 50;

type LockSnapshot = { pid: string; ts: number | null; owner: string };
type LockConfig = { lockDir: string; ttlSeconds: number; graceSeconds: number };

export class CodexHookLockBusyError extends Error {
	constructor() {
		super("codex-hook-ingest lock busy");
		this.name = "CodexHookLockBusyError";
	}
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function envInt(name: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function lockConfig(): LockConfig {
	return {
		lockDir: expandHome(
			process.env.CODEMEM_CODEX_HOOK_LOCK_DIR?.trim() || "~/.codemem/codex-hook-ingest.lock",
		),
		ttlSeconds: Math.max(1, envInt("CODEMEM_CODEX_HOOK_LOCK_TTL_S", DEFAULT_LOCK_TTL_S)),
		graceSeconds: Math.max(1, envInt("CODEMEM_CODEX_HOOK_LOCK_GRACE_S", DEFAULT_LOCK_GRACE_S)),
	};
}

export function codexHookSpoolDir(): string {
	return expandHome(
		process.env.CODEMEM_CODEX_HOOK_SPOOL_DIR?.trim() || "~/.codemem/codex-hook-spool",
	);
}

export function codexHookLockTtlSeconds(): number {
	return lockConfig().ttlSeconds;
}

export function hasCodexHookSpooledEntries(): boolean {
	let entries: string[];
	try {
		entries = readdirSync(codexHookSpoolDir());
	} catch {
		return false;
	}
	return entries.some(
		(name) => name.endsWith(".json") && !name.startsWith(".hook-tmp-") && !name.startsWith(".bad-"),
	);
}

function readTrimmed(path: string): string {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return "";
	}
}

function readLockMetadata(lockDir: string): LockSnapshot {
	const rawTs = readTrimmed(join(lockDir, "ts"));
	const ts = rawTs === "" ? null : Number.parseInt(rawTs, 10);
	return {
		pid: readTrimmed(join(lockDir, "pid")),
		ts: ts === null || !Number.isFinite(ts) ? null : ts,
		owner: readTrimmed(join(lockDir, "owner")),
	};
}

function isPidAlive(pidText: string): boolean {
	const pid = Number.parseInt(pidText, 10);
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
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
			return { stale: snapshot.ts !== null && nowS - snapshot.ts > cfg.ttlSeconds, snapshot };
		}
		return { stale: true, snapshot };
	}
	if (snapshot.ts !== null) return { stale: nowS - snapshot.ts > cfg.graceSeconds, snapshot };
	try {
		return {
			stale: nowS - Math.floor(statSync(cfg.lockDir).mtimeMs / 1000) > cfg.graceSeconds,
			snapshot,
		};
	} catch {
		return { stale: true, snapshot };
	}
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

function cleanupLockDirIfUnchanged(lockDir: string, snapshot: LockSnapshot): void {
	const current = readLockMetadata(lockDir);
	if (
		current.pid === snapshot.pid &&
		current.ts === snapshot.ts &&
		current.owner === snapshot.owner
	) {
		cleanupLockDir(lockDir);
	}
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withCodexHookIngestLock<T>(fn: () => Promise<T> | T): Promise<T> {
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
				if (stale) cleanupLockDirIfUnchanged(cfg.lockDir, snapshot);
			}
			await sleep(LOCK_ACQUIRE_BACKOFF_MS);
			continue;
		}

		try {
			writeFileSync(join(cfg.lockDir, "ts"), String(Math.floor(Date.now() / 1000)), "utf8");
			writeFileSync(join(cfg.lockDir, "pid"), String(process.pid), "utf8");
			writeFileSync(join(cfg.lockDir, "owner"), ownerToken, "utf8");
			acquired = true;
			break;
		} catch {
			cleanupLockDir(cfg.lockDir);
			await sleep(LOCK_ACQUIRE_BACKOFF_MS);
		}
	}

	if (!acquired) throw new CodexHookLockBusyError();
	try {
		return await fn();
	} finally {
		if (readTrimmed(join(cfg.lockDir, "owner")) === ownerToken) cleanupLockDir(cfg.lockDir);
	}
}

export function spoolCodexHookPayload(payload: Record<string, unknown>): boolean {
	const dir = codexHookSpoolDir();
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		logHookEvent("codemem codex-hook-ingest failed to create spool dir");
		return false;
	}

	const tmpPath = join(
		dir,
		`.hook-tmp-${process.pid}-${Date.now()}-${randomInt(1000, 10000)}.json`,
	);
	try {
		writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
	} catch {
		logHookEvent("codemem codex-hook-ingest failed to allocate spool temp file");
		return false;
	}

	const finalPath = join(
		dir,
		`hook-${Math.floor(Date.now() / 1000)}-${process.pid}-${randomInt(1000, 10000)}.json`,
	);
	try {
		renameSync(tmpPath, finalPath);
	} catch {
		try {
			unlinkSync(tmpPath);
		} catch {
			// best-effort
		}
		logHookEvent("codemem codex-hook-ingest failed to spool payload");
		return false;
	}
	logHookEvent(`codemem codex-hook-ingest spooled payload: ${finalPath}`);
	return true;
}

export function recoverStaleCodexHookTmpSpool(ttlSeconds: number): void {
	const dir = codexHookSpoolDir();
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
		try {
			if (nowS - statSync(tmpPath).mtimeMs / 1000 <= ttlSeconds) continue;
			renameSync(
				tmpPath,
				join(
					dir,
					`hook-recovered-${Math.floor(nowS)}-${process.pid}-${randomInt(1000, 10000)}.json`,
				),
			);
		} catch {
			// best-effort
		}
	}
}

function quarantineSpoolEntry(dir: string, name: string, reason: string): void {
	try {
		renameSync(
			join(dir, name),
			join(dir, `.bad-${reason}-${Date.now()}-${randomInt(1000, 10000)}-${name}`),
		);
	} catch {
		try {
			unlinkSync(join(dir, name));
		} catch {
			// best-effort
		}
	}
}

export type CodexSpoolHandler = (payload: Record<string, unknown>) => Promise<boolean> | boolean;

export async function drainCodexHookSpool(
	handler: CodexSpoolHandler,
): Promise<{ processed: number; failed: number }> {
	const dir = codexHookSpoolDir();
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

	const result = { processed: 0, failed: 0 };
	for (const name of entries
		.filter(
			(entry) =>
				entry.endsWith(".json") && !entry.startsWith(".hook-tmp-") && !entry.startsWith(".bad-"),
		)
		.sort()) {
		const path = join(dir, name);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			quarantineSpoolEntry(dir, name, "parse-error");
			result.failed++;
			continue;
		}
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
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
		if (!ok) {
			result.failed++;
			continue;
		}
		try {
			unlinkSync(path);
			result.processed++;
		} catch {
			// best-effort
		}
	}
	return result;
}
