/**
 * Durability layer for `codex-hook-ingest`. The lock/spool/drain/
 * quarantine machinery is shared in `hook-ingest-spool.ts`; this file
 * wires the codex-specific config (dirs, TTL 120s, 20 acquire attempts,
 * error name/message).
 */

import { createHookIngestSpool } from "./hook-ingest-spool.js";

export type { SpoolDrainResult } from "./hook-ingest-spool.js";

const spool = createHookIngestSpool({
	logPrefix: "codemem codex-hook-ingest",
	lockDirEnv: "CODEMEM_CODEX_HOOK_LOCK_DIR",
	lockDirDefault: "~/.codemem/codex-hook-ingest.lock",
	lockTtlEnv: "CODEMEM_CODEX_HOOK_LOCK_TTL_S",
	lockTtlDefault: 120,
	lockGraceEnv: "CODEMEM_CODEX_HOOK_LOCK_GRACE_S",
	lockGraceDefault: 2,
	lockAcquireAttempts: 20,
	spoolDirEnv: "CODEMEM_CODEX_HOOK_SPOOL_DIR",
	spoolDirDefault: "~/.codemem/codex-hook-spool",
	lockBusyErrorName: "CodexHookLockBusyError",
	lockBusyErrorMessage: "codex-hook-ingest lock busy",
});

export const CodexHookLockBusyError = spool.LockBusyError;
export const withCodexHookIngestLock = spool.withLock;
export const spoolCodexHookPayload = spool.spoolPayload;
export const drainCodexHookSpool = spool.drainSpool;
export const hasCodexHookSpooledEntries = spool.hasSpooledEntries;
export const recoverStaleCodexHookTmpSpool = spool.recoverStaleTmpSpool;
export const codexHookLockTtlSeconds = spool.lockTtlSeconds;
export const codexHookSpoolDir = spool.spoolDir;
