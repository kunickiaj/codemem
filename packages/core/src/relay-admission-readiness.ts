import {
	type RelayAdmissionNonceReceipt,
	readRelayAdmissionNonceReceipt,
} from "./relay-admission-clock.js";

export const RELAY_READINESS_VALIDITY_MS = 50_000;
export const RELAY_READINESS_MAX_LEAD_MS = 10_000;

export interface RelayAdmissionReadinessStamp {
	readonly revision: number;
	readonly state: "ready";
	readonly observedAtMs: number;
	readonly validUntilMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Shape parser only. It cannot prove health, execution, commit or a grant.
 * Supply the raw row of the same gated nonce INSERT and its captured receipt,
 * never an envelope, later SELECT or another query's receipt. Obtain that receipt
 * through readRelayAdmissionNonceReceipt(rawRow, expectedAssociation), where the
 * expected association comes from the current request, including its fresh
 * attemptId. Do not cast the raw row to a receipt or derive the expected
 * association from the row itself. Structural types cannot prove provenance.
 * Future admission still requires full authority checks, durable budgets,
 * a trusted controller and production clock evidence. No input state flag can
 * authorize readiness.
 */
export function readRelayAdmissionReadinessStamp(
	row: unknown,
	receipt: RelayAdmissionNonceReceipt,
): RelayAdmissionReadinessStamp | null {
	try {
		if (!isRecord(row) || !isRecord(receipt)) return null;
		// External getters are read once. Only local snapshots reach the clock parser.
		const {
			deviceId,
			nonce,
			attemptId,
			decidedAtMs,
			createdAt,
			readinessRevision,
			readinessObservedAtMs,
			policyRevision,
		} = row;
		const captured = {
			deviceId: receipt.deviceId,
			nonce: receipt.nonce,
			attemptId: receipt.attemptId,
			decidedAtMs: receipt.decidedAtMs,
			createdAt: receipt.createdAt,
		};
		const clock = readRelayAdmissionNonceReceipt(
			{ deviceId, nonce, attemptId, decidedAtMs, createdAt },
			captured,
		);
		if (
			!clock ||
			clock.decidedAtMs !== captured.decidedAtMs ||
			clock.createdAt !== captured.createdAt
		) {
			return null;
		}
		if (!isRevision(readinessRevision) || !isRevision(policyRevision)) return null;
		if (
			typeof readinessObservedAtMs !== "number" ||
			!Number.isSafeInteger(readinessObservedAtMs) ||
			readinessObservedAtMs < 0 ||
			readinessObservedAtMs > Number.MAX_SAFE_INTEGER - RELAY_READINESS_VALIDITY_MS
		) {
			return null;
		}
		const validUntilMs = readinessObservedAtMs + RELAY_READINESS_VALIDITY_MS;
		if (
			readinessObservedAtMs > clock.decidedAtMs + RELAY_READINESS_MAX_LEAD_MS ||
			validUntilMs <= clock.decidedAtMs
		) {
			return null;
		}
		return {
			revision: readinessRevision,
			state: "ready",
			observedAtMs: readinessObservedAtMs,
			validUntilMs,
		};
	} catch {
		// Private getter failures yield the same denial shape as invalid fields.
		return null;
	}
}
