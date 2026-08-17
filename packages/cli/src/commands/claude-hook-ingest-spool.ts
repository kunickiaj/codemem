/**
 * Durability layer for `claude-hook-ingest`. The lock/spool/drain/
 * quarantine machinery is shared in `hook-ingest-spool.ts`; this file
 * wires the claude-specific config (dirs, TTL 300s, 100 acquire
 * attempts, error name/message) and keeps the claude flush predicate.
 */

import { createHookIngestSpool, envTruthy } from "./hook-ingest-spool.js";

export type { SpoolDrainResult, SpoolHandler } from "./hook-ingest-spool.js";

const spool = createHookIngestSpool({
	logPrefix: "codemem claude-hook-ingest",
	lockDirEnv: "CODEMEM_CLAUDE_HOOK_LOCK_DIR",
	lockDirDefault: "~/.codemem/claude-hook-ingest.lock",
	lockTtlEnv: "CODEMEM_CLAUDE_HOOK_LOCK_TTL_S",
	lockTtlDefault: 300,
	lockGraceEnv: "CODEMEM_CLAUDE_HOOK_LOCK_GRACE_S",
	lockGraceDefault: 2,
	lockAcquireAttempts: 100,
	spoolDirEnv: "CODEMEM_CLAUDE_HOOK_SPOOL_DIR",
	spoolDirDefault: "~/.codemem/claude-hook-spool",
	lockBusyErrorName: "LockBusyError",
	lockBusyErrorMessage: "claude-hook-ingest lock busy",
});

export const LockBusyError = spool.LockBusyError;
export const withClaudeHookIngestLock = spool.withLock;
export const spoolPayload = spool.spoolPayload;
export const drainSpool = spool.drainSpool;
export const hasSpooledEntries = spool.hasSpooledEntries;
export const recoverStaleTmpSpool = spool.recoverStaleTmpSpool;
export const lockTtlSeconds = spool.lockTtlSeconds;
export const spoolDir = spool.spoolDir;

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
