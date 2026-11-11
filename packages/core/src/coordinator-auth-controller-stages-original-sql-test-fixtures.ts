/**
 * Test-only. This file exists only to pin equivalence with the pre-port SQL.
 *
 * Between the markers are the controller review's history guard from
 * coordinator-auth-controller-history.ts and its owner stage and guard from
 * coordinator-auth-controller-owner.ts, as they were on main at 075d46647, copied
 * verbatim. Production no longer builds statements from them. The other pre-port
 * fixtures import them from here. Do not edit the copy to follow later changes; delete
 * this file with the last fixture that imports it.
 */
import { CONNECTION_NOT_REVOKED_SQL } from "./coordinator-account-connection-storage.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";

// ---- verbatim copy starts ----
export const CONTROLLER_HISTORY_GUARD = `AND (
 (SELECT value FROM history_input) IS NULL OR (
 json_extract((SELECT value FROM history_input), '$.deviceId') = e.device_id
 AND json_extract((SELECT value FROM history_input), '$.publicKey') = e.public_key
 AND json_extract((SELECT value FROM history_input), '$.fingerprint') = e.fingerprint
 AND (SELECT count(*) FROM live_history) = (SELECT count(*) FROM snapshot_history)
 AND NOT EXISTS (SELECT * FROM live_history EXCEPT SELECT * FROM snapshot_history)
 AND NOT EXISTS (SELECT * FROM live_history_keys EXCEPT SELECT * FROM snapshot_history_keys)
 AND NOT EXISTS (SELECT * FROM snapshot_history_keys EXCEPT SELECT * FROM live_history_keys)
 AND NOT EXISTS (SELECT * FROM live_discovery_keys EXCEPT SELECT * FROM snapshot_discovery_keys)
 AND NOT EXISTS (SELECT * FROM snapshot_discovery_keys EXCEPT SELECT * FROM live_discovery_keys)
 ))`;

/** Recovery-only root WITH stage: ordinary seed schemas need no V3 tables.
 * Keep the independent provenance expression outside the enrollment/history
 * expression tree to fit D1's depth 100 limit. Both still share one statement.
 */
export const AUTH_CONTROLLER_OWNER_CTE = `controller_owner_connection AS MATERIALIZED (
 SELECT l.coordinator_id,l.identity_id FROM coordinator_auth_account_links l CROSS JOIN snapshot s
 WHERE l.coordinator_id=json_extract(s.value,'$.accountOwnerTarget.coordinatorId')
 AND l.identity_id=json_extract(s.value,'$.accountOwnerTarget.targetIdentityId')
 AND l.issuer=json_extract(s.value,'$.accountOwnerTarget.issuer')
 AND l.link_id=json_extract(s.value,'$.accountOwnerTarget.linkId')
 AND l.auth_config_revision=json_extract(s.value,'$.accountOwnerTarget.authConfigRevision')
 AND l.created_at_ms=json_extract(s.value,'$.accountOwnerTarget.createdAtMs')
 AND ${CONNECTION_NOT_REVOKED_SQL}
 AND ${authAccountLinkProvenanceSql("l", { connections: true })})`;

export const AUTH_CONTROLLER_OWNER_GUARD = `AND EXISTS (
 SELECT 1 FROM controller_owner_connection l
 WHERE NOT EXISTS (SELECT 1 FROM coordinator_auth_device_claims d
 WHERE d.coordinator_id=l.coordinator_id AND (d.device_id=e.device_id OR d.key_id=?)
 AND (d.identity_id<>l.identity_id OR d.group_id<>e.group_id
 OR d.device_id<>e.device_id OR d.public_key<>e.public_key OR d.fingerprint<>e.fingerprint))
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_controller_attestations other
 WHERE other.coordinator_id=l.coordinator_id AND other.group_id=e.group_id
 AND other.device_id=e.device_id AND other.fingerprint=e.fingerprint
 AND (other.identity_id<>l.identity_id OR other.public_key<>e.public_key OR other.revoked_at IS NOT NULL))
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_controller_attestations other
 WHERE other.coordinator_id=l.coordinator_id AND other.identity_id<>l.identity_id
 AND (other.device_id=e.device_id OR other.public_key=e.public_key
 OR other.public_key IN (SELECT public_key FROM snapshot_history_keys))))`;
// ---- verbatim copy ends ----
