/** Retained trusted controller rows are ownership evidence even if their Team or
 * enrollment is gone. Weak historical Team assignments are not consulted here.
 */
export const AUTH_CONTROLLER_SUBJECT_OWNER_CONFLICT_SQL = `WITH owner_subject(value) AS (SELECT ?)
 SELECT 1 AS conflict FROM coordinator_auth_controller_attestations other CROSS JOIN owner_subject s
 WHERE other.coordinator_id=json_extract(s.value,'$.coordinatorId') AND other.identity_id<>?
 AND (other.device_id=json_extract(s.value,'$.deviceId')
 OR other.public_key=json_extract(s.value,'$.publicKey')
 OR other.public_key IN (SELECT json_extract(j.value,'$.public_key') FROM json_each(s.value,'$.keys') j))
 LIMIT 1`;

export interface CoordinatorAuthControllerOwnerSnapshot {
	purpose: "existing_account_owner";
	coordinatorId: string;
	targetIdentityId: string;
	issuer: string;
	linkId: string;
	authConfigRevision: string;
	createdAtMs: number;
}
