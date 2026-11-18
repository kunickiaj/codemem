import type { normalizeCoordinatorGrantScopeMembershipInput } from "./coordinator-store-input-rules.js";

/**
 * Pin the scope's group captured for this grant. A grouped scope also requires
 * an enabled enrollment in that live group. Group-less scopes retain their
 * existing exemption. A missing scope or a changed group authorizes no write.
 */
const LIVE_ENROLLMENT_SQL = `EXISTS (SELECT 1 FROM coordinator_scopes grant_scope
WHERE grant_scope.scope_id = ? AND grant_scope.group_id IS ?
AND (grant_scope.group_id IS NULL OR EXISTS (SELECT 1 FROM enrolled_devices grant_device
  WHERE grant_device.group_id = grant_scope.group_id AND grant_device.device_id = ?
    AND grant_device.enabled = 1)))`;

/**
 * Both insert and conflict-update branches own the same live-enrollment check.
 * The update repeats it so a BEFORE INSERT trigger cannot change that authority
 * between source selection and conflict resolution. Effects remain conditional
 * on this statement changing a row, as in the existing grant operation.
 */
export function membershipGrantStatement(
	input: ReturnType<typeof normalizeCoordinatorGrantScopeMembershipInput>,
	operation: { effectId: string; now: string },
) {
	const enrollment = [input.scopeId, input.groupId, input.deviceId];
	return {
		sql: `INSERT INTO coordinator_scope_memberships(
  scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id,
  manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at
) SELECT ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?
WHERE NOT EXISTS (SELECT 1 FROM coordinator_scope_membership_effect_receipts WHERE effect_id = ?)
AND ${LIVE_ENROLLMENT_SQL}
ON CONFLICT(scope_id, device_id) DO UPDATE SET
  role = excluded.role, status = 'active', membership_epoch = excluded.membership_epoch,
  coordinator_id = excluded.coordinator_id, group_id = excluded.group_id,
  manifest_issuer_device_id = excluded.manifest_issuer_device_id, manifest_hash = excluded.manifest_hash,
  signed_manifest_json = excluded.signed_manifest_json, updated_at = excluded.updated_at
WHERE (excluded.membership_epoch > coordinator_scope_memberships.membership_epoch
  OR (excluded.membership_epoch = coordinator_scope_memberships.membership_epoch
    AND coordinator_scope_memberships.status != 'revoked'))
AND ${LIVE_ENROLLMENT_SQL}`,
		values: [
			input.scopeId,
			input.deviceId,
			input.role,
			input.membershipEpoch,
			input.coordinatorId,
			input.groupId,
			input.manifestIssuerDeviceId,
			input.manifestHash,
			input.signedManifestJson,
			operation.now,
			operation.effectId,
			...enrollment,
			...enrollment,
		],
	};
}
