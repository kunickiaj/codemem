import { HEADLESS_CODE_LIMITS_TABLE as TABLE } from "./coordinator-auth-headless-schema.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";

/** Fixed windows: a window opens at the first entry after the previous one expired. */
export const HEADLESS_CODE_ENTRY_WINDOW_MS = 15 * 60 * 1000;
export const HEADLESS_CODE_ENTRY_CLIENT_LIMIT = 10;
export const HEADLESS_CODE_ENTRY_COORDINATOR_LIMIT = 200;
/** Expired rows removed per entry, so cleanup cost per request stays fixed. */
export const HEADLESS_CODE_ENTRY_CLEANUP_LIMIT = 32;

const MAX_COORDINATOR_ID_LENGTH = 256;
const MAX_CLIENT_ADDRESS_LENGTH = 1024;
const CLIENT_KEY_HASH = /^[0-9a-f]{64}$/;

export interface HeadlessCodeEntryInput {
	coordinatorId: string;
	/** hashHeadlessCodeEntryClient output. The raw client address is never stored. */
	clientKeyHash: string;
	nowMs: number;
}
export type HeadlessCodeEntryDecision =
	| { allowed: true }
	| { allowed: false; retryAfterMs: number };

type Backend = Pick<AuthLinkBackend, "first" | "run">;
type CryptoKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;
type Scope = "client" | "coordinator";
interface Counted {
	failures: number;
	window_start_ms: number;
}

/**
 * Keys the stored client hash with a coordinator secret, so a leaked table
 * cannot be matched against guessed addresses. A new key yields new hashes, so
 * rotating the secret starts every client window over.
 */
export async function hashHeadlessCodeEntryClient(
	key: CryptoKey,
	clientAddress: string,
): Promise<string> {
	if (
		typeof clientAddress !== "string" ||
		clientAddress.length === 0 ||
		clientAddress.length > MAX_CLIENT_ADDRESS_LENGTH
	)
		throw new Error("headless_code_entry_invalid_input");
	const mac = await globalThis.crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(clientAddress),
	);
	return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Callers are trusted server code; malformed input is a programming error, not a client miss.
function captureInput(input: HeadlessCodeEntryInput): HeadlessCodeEntryInput {
	const { coordinatorId, clientKeyHash, nowMs } = input;
	if (
		typeof coordinatorId !== "string" ||
		coordinatorId.length === 0 ||
		coordinatorId.length > MAX_COORDINATOR_ID_LENGTH ||
		typeof clientKeyHash !== "string" ||
		!CLIENT_KEY_HASH.test(clientKeyHash) ||
		!Number.isSafeInteger(nowMs) ||
		nowMs < 0
	)
		throw new Error("headless_code_entry_invalid_input");
	return { coordinatorId, clientKeyHash, nowMs };
}

// SQLite evaluates every SET expression against the old row, so an expired
// window restarts at this entry and a live one counts it. RETURNING reports the
// count this statement wrote, so concurrent entries each see a distinct count.
const RESERVE_SQL = `INSERT INTO ${TABLE} (coordinator_id, scope, key_hash, window_start_ms, failures)
 VALUES (?, ?, ?, ?, 1)
 ON CONFLICT (coordinator_id, scope, key_hash) DO UPDATE SET
 failures = CASE WHEN window_start_ms + ${HEADLESS_CODE_ENTRY_WINDOW_MS} <= excluded.window_start_ms
  THEN 1 ELSE failures + 1 END,
 window_start_ms = CASE WHEN window_start_ms + ${HEADLESS_CODE_ENTRY_WINDOW_MS} <= excluded.window_start_ms
  THEN excluded.window_start_ms ELSE window_start_ms END
 RETURNING failures, window_start_ms`;

const CLEANUP_SQL = `DELETE FROM ${TABLE} WHERE (coordinator_id, scope, key_hash) IN (
 SELECT coordinator_id, scope, key_hash FROM ${TABLE}
 WHERE window_start_ms + ${HEADLESS_CODE_ENTRY_WINDOW_MS} <= ? LIMIT ${HEADLESS_CODE_ENTRY_CLEANUP_LIMIT})`;

async function count(backend: Backend, i: HeadlessCodeEntryInput, scope: Scope): Promise<Counted> {
	const keyHash = scope === "client" ? i.clientKeyHash : "";
	const row = await backend.first<Counted>({
		sql: RESERVE_SQL,
		values: [i.coordinatorId, scope, keyHash, i.nowMs],
	});
	if (!row || !Number.isSafeInteger(row.failures) || !Number.isSafeInteger(row.window_start_ms))
		throw new Error("headless_code_entry_unavailable");
	return row;
}

function denied(row: Counted, nowMs: number): HeadlessCodeEntryDecision {
	const remaining = row.window_start_ms + HEADLESS_CODE_ENTRY_WINDOW_MS - nowMs;
	// A window that starts after nowMs (clock skew between instances) still waits one window at most.
	return {
		allowed: false,
		retryAfterMs: Math.min(Math.max(remaining, 1), HEADLESS_CODE_ENTRY_WINDOW_MS),
	};
}

/**
 * Counts this code entry before any code lookup and allows it only when the
 * counts it wrote stay within both limits. Every entry counts, including ones
 * that succeed: a person links a device a few times at most, and never
 * releasing a slot keeps the ceiling exact.
 *
 * Each scope is one UPSERT ... RETURNING statement, which SQLite and D1 run
 * atomically, so no more than the limit of concurrent entries can be allowed
 * in one window. The client is counted first; an entry the client limit
 * refuses never touches the coordinator count, so one client cannot spend the
 * shared budget. The stored `failures` column holds this entry count.
 */
export async function reserveHeadlessCodeEntry(
	backend: Backend,
	input: HeadlessCodeEntryInput,
): Promise<HeadlessCodeEntryDecision> {
	const i = captureInput(input);
	await backend.run({ sql: CLEANUP_SQL, values: [i.nowMs] });
	const client = await count(backend, i, "client");
	if (client.failures > HEADLESS_CODE_ENTRY_CLIENT_LIMIT) return denied(client, i.nowMs);
	const coordinator = await count(backend, i, "coordinator");
	if (coordinator.failures > HEADLESS_CODE_ENTRY_COORDINATOR_LIMIT)
		return denied(coordinator, i.nowMs);
	return { allowed: true };
}
