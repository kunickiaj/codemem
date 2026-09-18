/**
 * Durability layer for `pi-hook-ingest`. The lock/spool/drain/
 * quarantine machinery is shared in `hook-ingest-spool.ts`; this file
 * wires the pi-specific config (dirs, TTL 300s, 20 acquire attempts,
 * error name/message) and keeps the pi flush predicate.
 */
import { removeLiveHookPayload, spoolLiveHookPayload } from "./hook-ingest-live-spool.js";
import { createHookIngestSpool, hasHookIngestSpoolReceipt } from "./hook-ingest-spool.js";

export type { SpoolDrainResult, SpoolHandler } from "./hook-ingest-spool.js";

const spool = createHookIngestSpool({
	logPrefix: "codemem pi-hook-ingest",
	lockDirEnv: "CODEMEM_PI_HOOK_LOCK_DIR",
	lockDirDefault: "~/.codemem/pi-hook-ingest.lock",
	lockTtlEnv: "CODEMEM_PI_HOOK_LOCK_TTL_S",
	lockTtlDefault: 300,
	lockGraceEnv: "CODEMEM_PI_HOOK_LOCK_GRACE_S",
	lockGraceDefault: 2,
	lockAcquireAttempts: 20,
	spoolDirEnv: "CODEMEM_PI_HOOK_SPOOL_DIR",
	spoolDirDefault: "~/.codemem/pi-hook-spool",
	lockBusyErrorName: "PiHookLockBusyError",
	lockBusyErrorMessage: "pi-hook-ingest lock busy",
});

export const PiHookLockBusyError = spool.LockBusyError;
export const withPiHookIngestLock = spool.withLock;
export const spoolPiHookPayload = spool.spoolPayload;
export const spoolPiHookPayloadWithReceipt = (payload: Record<string, unknown>): string | null =>
	spoolLiveHookPayload(spool.spoolDir(), payload, "codemem pi-hook-ingest");
export const removeSpooledPiHookPayload = (name: string): boolean =>
	removeLiveHookPayload(spool.spoolDir(), name);
export const drainPiHookSpool = spool.drainSpool;
export const hasPiHookSpooledEntries = spool.hasSpooledEntries;
export const hasSpooledPiHookPayload = (receipt: string): boolean =>
	hasHookIngestSpoolReceipt(spool.spoolDir(), receipt);
export const recoverStalePiHookTmpSpool = spool.recoverStaleTmpSpool;
export const piHookLockTtlSeconds = spool.lockTtlSeconds;
export const piHookSpoolDir = spool.spoolDir;

/**
 * Boundary flush for pi: compaction and session end both trigger extraction.
 * session_before_compact is observe-only (never stored as transcript).
 * session_shutdown maps to session_end and also flushes pending events.
 */
export function shouldForcePiBoundaryFlush(payload: Record<string, unknown>): boolean {
	const eventName = coercePiEventName(payload);
	return eventName === "session_before_compact" || eventName === "session_shutdown";
}

function coercePiEventName(payload: Record<string, unknown>): string {
	for (const key of ["piEvent", "pi_event", "event", "type"] as const) {
		const value = payload[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}
