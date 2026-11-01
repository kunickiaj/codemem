/**
 * Trusted static SQL, never query data. SQLite's UTC 'now' is stable within one
 * sqlite3_step. Use this in both the conditional INSERT predicate and RETURNING
 * of the same single-row statement, avoiding floating-point epoch multiplication.
 * SQLite exposes whole milliseconds, not a guaranteed future-rounded UTC reading.
 * Final policy must include up to 1 ms of resolution error in its clock-error bound.
 * https://www.sqlite.org/lang_datefunc.html
 */
export const RELAY_ADMISSION_CLOCK_SQL: string =
	"(CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";

export interface RelayAdmissionNonceAssociation {
	readonly deviceId: string;
	readonly nonce: string;
	/** Fresh per database execution and bound into RETURNING, separate from the replay-ledger nonce. */
	readonly attemptId: string;
}

export interface RelayAdmissionNonceReceipt extends RelayAdmissionNonceAssociation {
	readonly decidedAtMs: number;
	readonly createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAssociation(
	value: Record<string, unknown>,
): value is Record<string, unknown> & RelayAdmissionNonceAssociation {
	return (
		typeof value.deviceId === "string" &&
		value.deviceId.length >= 1 &&
		value.deviceId.length <= 64 &&
		!/[^\x21-\x7e]/.test(value.deviceId) &&
		typeof value.nonce === "string" &&
		value.nonce.length === 32 &&
		/^[0-9a-f]{32}$/.test(value.nonce) &&
		typeof value.attemptId === "string" &&
		value.attemptId.length === 32 &&
		/^[0-9a-f]{32}$/.test(value.attemptId)
	);
}

/**
 * Parse only the current INSERT RETURNING row from a trusted execution path
 * (.get(), .first(), or one .all().results row), never an envelope or later read.
 * Shape validation cannot prove execution or commit and does not grant admission.
 * Callers still need final authority checks, durable budgets, and production
 * clock evidence. No application-clock fallback or freshness check occurs here.
 */
export function readRelayAdmissionNonceReceipt(
	row: unknown,
	expected: RelayAdmissionNonceAssociation,
): RelayAdmissionNonceReceipt | null {
	try {
		if (!isRecord(expected) || !isRecord(row)) return null;
		// Snapshot external getters once so validation and output use identical values.
		const association = {
			deviceId: expected.deviceId,
			nonce: expected.nonce,
			attemptId: expected.attemptId,
		};
		const { deviceId, nonce, attemptId, decidedAtMs, createdAt } = row;
		if (!isAssociation(association)) return null;
		if (
			deviceId !== association.deviceId ||
			nonce !== association.nonce ||
			attemptId !== association.attemptId
		) {
			return null;
		}
		if (
			typeof decidedAtMs !== "number" ||
			!Number.isSafeInteger(decidedAtMs) ||
			decidedAtMs < 0 ||
			typeof createdAt !== "string"
		) {
			return null;
		}
		if (new Date(decidedAtMs).toISOString() !== createdAt) return null;
		return {
			deviceId: association.deviceId,
			nonce: association.nonce,
			attemptId: association.attemptId,
			decidedAtMs,
			createdAt,
		};
	} catch {
		// Getter failures and unrenderable dates expose no partial receipt or detail.
		return null;
	}
}
