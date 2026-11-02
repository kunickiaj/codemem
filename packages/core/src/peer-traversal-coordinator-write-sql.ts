import { RELAY_ADMISSION_CLOCK_SQL as CLOCK } from "./relay-admission-clock.js";
import { currentParticipantSql } from "./relay-admission-participant-nonce.js";

const METADATA_GATE = `EXISTS (
 SELECT 1 FROM traversal_authority_policy p
 JOIN traversal_realms r ON r.authority_id = p.authority_id AND r.group_id = ?6
 JOIN traversal_readiness ha ON ha.authority_id = p.authority_id
  AND ha.scope = 'authority' AND ha.group_id = ''
 JOIN traversal_readiness hr ON hr.authority_id = p.authority_id
  AND hr.scope = 'realm' AND hr.group_id = ?6
 WHERE p.authority_id = ?5 AND p.policy_revision = ?8
  AND p.operator_state = 'enabled' AND r.operator_state = 'enabled'
  AND r.changed_revision <= p.policy_revision
  AND ha.state = 'ready' AND hr.state = 'ready' AND hr.revision <= ha.revision
  AND MAX(ha.observed_at_ms, hr.observed_at_ms) <= ${CLOCK} + 10000
  AND MIN(ha.observed_at_ms, hr.observed_at_ms) + 50000 > ${CLOCK}
)`;

const METADATA_RETURNING = `
 (SELECT ha.revision FROM traversal_readiness ha
  WHERE ha.authority_id = ?5 AND ha.scope = 'authority' AND ha.group_id = '') AS readinessRevision,
 (SELECT MIN(ha.observed_at_ms, hr.observed_at_ms) FROM traversal_readiness ha
  JOIN traversal_readiness hr ON hr.authority_id = ha.authority_id
   AND hr.scope = 'realm' AND hr.group_id = ?6
  WHERE ha.authority_id = ?5 AND ha.scope = 'authority' AND ha.group_id = '') AS readinessObservedAtMs,
 (SELECT p.policy_revision FROM traversal_authority_policy p
  WHERE p.authority_id = ?5) AS policyRevision`;

// Slots 1–12 are shared. The state INSERT additionally binds Message A and packet digests.
const PREPARE_GATE = `typeof(${CLOCK}) = 'integer'
 AND ${CLOCK} BETWEEN 0 AND 9007199254740991
 AND ?11 <= ${CLOCK} + 5000 AND ${CLOCK} < ?4
 AND ?12 - ${CLOCK} > 0 AND ?12 - ${CLOCK} <= 60000
 AND json_extract(?9, '$.device_id') = ?1
 AND ${currentParticipantSql("?9")} AND ${currentParticipantSql("?10")}
 AND ${METADATA_GATE}
 AND NOT EXISTS (SELECT 1 FROM traversal_attempts a WHERE a.session_id = ?7)`;

export const TRAVERSAL_NONCE_SQL = `INSERT INTO request_nonces(device_id, nonce, created_at)
 SELECT ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${PREPARE_GATE}
 ON CONFLICT(device_id, nonce) DO NOTHING
 RETURNING device_id AS deviceId, nonce, ?3 AS attemptId,
 ${CLOCK} AS decidedAtMs, created_at AS createdAt, ${METADATA_RETURNING}`;

export const TRAVERSAL_STATE_SQL = `INSERT INTO traversal_attempts(
 session_id, authority_id, group_id, source_device_id, source_key_id,
 target_device_id, target_key_id, message_a_digest, prepare_created_at,
 attempt_not_after, policy_revision, prepare_digest, created_at_ms, updated_at_ms,
 phase, offer_digest, answer_digest, last_request_digest, last_nonce, exec_id)
 SELECT ?7, ?5, ?6, ?1, json_extract(?9, '$.keyId'),
 json_extract(?10, '$.device_id'), json_extract(?10, '$.keyId'), ?13, ?11 / 1000,
 ?12 / 1000, ?8, ?14, ${CLOCK}, ${CLOCK}, 1, NULL, NULL, ?14, ?2, ?3
 WHERE ${PREPARE_GATE}
 RETURNING ?1 AS deviceId, last_nonce AS nonce, exec_id AS attemptId,
 ${CLOCK} AS decidedAtMs, strftime('%Y-%m-%dT%H:%M:%fZ','now') AS createdAt,
 session_id AS sessionId, phase, last_request_digest AS packetDigest,
 updated_at_ms AS updatedAtMs, ${METADATA_RETURNING}`;
