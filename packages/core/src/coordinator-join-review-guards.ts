import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";
import {
	DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL,
	LEGACY_ENROLLMENT_SOURCE_MATCH_SQL,
} from "./coordinator-legacy-device-ownership.js";
import type {
	CoordinatorEnrollment,
	CoordinatorJoinRequest,
} from "./coordinator-store-contract.js";

export const JOIN_REVIEW_COLUMNS = `request_id, group_id, device_id, public_key, fingerprint,
 display_name, token, status, created_at, reviewed_at, reviewed_by`;

/** Evidence captured before hashing must remain current at every approval writer. */
export function joinReviewGuardEvidence(
	row: CoordinatorJoinRequest & { public_key: string },
	seed: CoordinatorEnrollment | null,
	keys: { recipient: string | null; seed: string | null; current: string | null },
	currentPublicKey: string | null,
) {
	const revocationSql = `${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} OR ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL}`;
	const revocationValues = [row.device_id, keys.recipient, seed?.device_id ?? null, keys.seed];
	// Reviewer/seed identity is not recipient ownership proof. Retain the old key even after upsert.
	const ownershipSql = `${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL} OR ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}`;
	const ownershipValues = [row.device_id, keys.recipient, row.device_id, keys.current];
	const sourceValues = [
		currentPublicKey,
		row.group_id,
		row.device_id,
		row.group_id,
		row.device_id,
		currentPublicKey,
	];
	const tupleSql = `EXISTS (SELECT 1 FROM coordinator_join_requests jr
 WHERE jr.request_id = ? AND jr.group_id = ? AND jr.device_id = ?
 AND jr.public_key = ? AND jr.fingerprint = ? AND jr.display_name IS ?
 AND jr.token = ? AND jr.created_at = ?)`;
	const tupleValues = [
		row.request_id,
		row.group_id,
		row.device_id,
		row.public_key,
		row.fingerprint,
		row.display_name ?? null,
		row.token,
		row.created_at,
	];
	const seedSql = `(? = 0 OR EXISTS (SELECT 1 FROM enrolled_devices se
 WHERE se.group_id = ? AND se.device_id = ? AND se.public_key = ?
 AND se.fingerprint = ? AND se.enabled = 1))`;
	return {
		revocationSql,
		revocationValues,
		ownershipSql,
		ownershipValues,
		sourceSql: LEGACY_ENROLLMENT_SOURCE_MATCH_SQL,
		sourceValues,
		eligibilitySql: `${tupleSql} AND ${seedSql} AND NOT (${revocationSql}) AND NOT (${ownershipSql})`,
		eligibilityValues: [
			...tupleValues,
			seed ? 1 : 0,
			row.group_id,
			seed?.device_id ?? null,
			seed?.public_key ?? null,
			seed?.fingerprint ?? null,
			...revocationValues,
			...ownershipValues,
		],
	};
}

export function joinReviewResultChanges(result: unknown): number {
	if (
		!result ||
		typeof result !== "object" ||
		("success" in result && result.success === false) ||
		!("meta" in result) ||
		!result.meta ||
		typeof result.meta !== "object" ||
		!("changes" in result.meta) ||
		!Number.isSafeInteger(result.meta.changes) ||
		(result.meta.changes as number) < 0
	)
		throw new Error("join_review_incomplete");
	return result.meta.changes as number;
}

export function assertJoinReviewConfirmation(result: unknown): void {
	if (
		!result ||
		typeof result !== "object" ||
		("success" in result && result.success === false) ||
		!("results" in result) ||
		!Array.isArray(result.results) ||
		result.results.length !== 1 ||
		result.results[0]?.confirmed !== 1
	) {
		throw new Error("join_review_incomplete");
	}
}
