import { HEADLESS_CODE_LIMITS_TABLE as TABLE } from "./coordinator-auth-headless-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";

/** Fixed windows: a window opens at the first failure after the previous one expired. */
export const HEADLESS_CODE_ENTRY_WINDOW_MS = 15 * 60 * 1000;
export const HEADLESS_CODE_ENTRY_CLIENT_LIMIT = 10;
export const HEADLESS_CODE_ENTRY_COORDINATOR_LIMIT = 200;
/** Expired rows removed per recorded failure, so cleanup cost per request stays fixed. */
export const HEADLESS_CODE_ENTRY_CLEANUP_LIMIT = 32;

const MAX_COORDINATOR_ID_LENGTH = 256;
const MAX_CLIENT_KEY_LENGTH = 1024;

export interface HeadlessCodeEntryInput {
	coordinatorId: string;
	/** Raw client key such as an IP address. Only its SHA-256 hash is stored. */
	clientKey: string;
	nowMs: number;
}
export type HeadlessCodeEntryDecision =
	| { allowed: true }
	| { allowed: false; retryAfterMs: number };

type Backend = Pick<AuthLinkBackend, "first" | "batch">;
interface Captured {
	coordinatorId: string;
	keyHash: string;
	nowMs: number;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Callers are trusted server code; malformed input is a programming error, not a client miss.
async function captureInput(input: HeadlessCodeEntryInput): Promise<Captured> {
	const { coordinatorId, clientKey, nowMs } = input;
	if (
		typeof coordinatorId !== "string" ||
		coordinatorId.length === 0 ||
		coordinatorId.length > MAX_COORDINATOR_ID_LENGTH ||
		typeof clientKey !== "string" ||
		clientKey.length === 0 ||
		clientKey.length > MAX_CLIENT_KEY_LENGTH ||
		!Number.isSafeInteger(nowMs) ||
		nowMs < 0
	)
		throw new Error("headless_code_entry_invalid_input");
	return { coordinatorId, keyHash: await sha256Hex(clientKey), nowMs };
}

const CHECK_SQL = `SELECT max(window_start_ms + ${HEADLESS_CODE_ENTRY_WINDOW_MS} - ?) AS retry_after_ms
 FROM ${TABLE} WHERE coordinator_id = ? AND window_start_ms + ${HEADLESS_CODE_ENTRY_WINDOW_MS} > ?
 AND ((scope = 'client' AND key_hash = ? AND failures >= ${HEADLESS_CODE_ENTRY_CLIENT_LIMIT})
  OR (scope = 'coordinator' AND key_hash = '' AND failures >= ${HEADLESS_CODE_ENTRY_COORDINATOR_LIMIT}))`;

/** Allowed unless the client's or the coordinator's current window has reached its failure limit. */
export async function checkHeadlessCodeEntry(
	backend: Backend,
	input: HeadlessCodeEntryInput,
): Promise<HeadlessCodeEntryDecision> {
	const i = await captureInput(input);
	const row = await backend.first<{ retry_after_ms: number | null }>({
		sql: CHECK_SQL,
		values: [i.nowMs, i.coordinatorId, i.nowMs, i.keyHash],
	});
	const retryAfterMs = row?.retry_after_ms;
	if (retryAfterMs === null || retryAfterMs === undefined) return { allowed: true };
	// A stored window that starts after nowMs (clock skew between instances) still waits one window at most.
	return {
		allowed: false,
		retryAfterMs: Math.min(Math.max(retryAfterMs, 1), HEADLESS_CODE_ENTRY_WINDOW_MS),
	};
}

// One statement per scope: SQLite evaluates every SET expression against the old row,
// so an expired window restarts at this failure and a live one counts it.
const UPSERT_SQL = `INSERT INTO ${TABLE} (coordinator_id, scope, key_hash, window_start_ms, failures)
 VALUES (?, ?, ?, ?, 1)
 ON CONFLICT (coordinator_id, scope, key_hash) DO UPDATE SET
 failures = CASE WHEN window_start_ms + ${HEADLESS_CODE_ENTRY_WINDOW_MS} <= excluded.window_start_ms
  THEN 1 ELSE failures + 1 END,
 window_start_ms = CASE WHEN window_start_ms + ${HEADLESS_CODE_ENTRY_WINDOW_MS} <= excluded.window_start_ms
  THEN excluded.window_start_ms ELSE window_start_ms END`;

const CLEANUP_SQL = `DELETE FROM ${TABLE} WHERE (coordinator_id, scope, key_hash) IN (
 SELECT coordinator_id, scope, key_hash FROM ${TABLE}
 WHERE window_start_ms + ${HEADLESS_CODE_ENTRY_WINDOW_MS} <= ? LIMIT ${HEADLESS_CODE_ENTRY_CLEANUP_LIMIT})`;

function recordStatements(i: Captured): AuthLinkStatement[] {
	return [
		{ sql: UPSERT_SQL, values: [i.coordinatorId, "client", i.keyHash, i.nowMs] },
		{ sql: UPSERT_SQL, values: [i.coordinatorId, "coordinator", "", i.nowMs] },
		{ sql: CLEANUP_SQL, values: [i.nowMs] },
	];
}

/**
 * Counts one wrong code against the client and the coordinator in one atomic
 * batch, then removes a limited number of expired windows. Successful entries
 * are never recorded.
 */
export async function recordHeadlessCodeEntryFailure(
	backend: Backend,
	input: HeadlessCodeEntryInput,
): Promise<void> {
	await backend.batch(recordStatements(await captureInput(input)));
}
