import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";

// IS NOT 1 rejects NULL as well as invalid types/ranges before any quota check.
const INVALID_CLOCK_SQL = `(typeof(${RELAY_ADMISSION_CLOCK_SQL}) = 'integer'
 AND ${RELAY_ADMISSION_CLOCK_SQL} BETWEEN 0 AND 9007199254740991) IS NOT 1`;

/** Inert digest-only definitions. Row shape does not authenticate or authorize a request. */
export const TRAVERSAL_COORDINATOR_ATTEMPT_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
	`CREATE TABLE IF NOT EXISTS traversal_attempts (
 session_id TEXT NOT NULL PRIMARY KEY CHECK (typeof(session_id) = 'text'
  AND length(CAST(session_id AS BLOB)) = 32
  AND session_id NOT GLOB '*[^0-9a-f]*' AND instr(session_id, char(0)) = 0),
 authority_id TEXT NOT NULL CHECK (typeof(authority_id) = 'text'
  AND length(CAST(authority_id AS BLOB)) = 64
  AND authority_id NOT GLOB '*[^0-9a-f]*' AND instr(authority_id, char(0)) = 0),
 group_id TEXT NOT NULL CHECK (typeof(group_id) = 'text'
  AND length(CAST(group_id AS BLOB)) BETWEEN 1 AND 128 AND instr(group_id, char(0)) = 0),
 source_device_id TEXT NOT NULL CHECK (typeof(source_device_id) = 'text'
  AND length(CAST(source_device_id AS BLOB)) BETWEEN 1 AND 64
  AND source_device_id NOT GLOB '*[^!-~]*' AND instr(source_device_id, char(0)) = 0),
 source_key_id TEXT NOT NULL CHECK (typeof(source_key_id) = 'text'
  AND length(CAST(source_key_id AS BLOB)) = 64
  AND source_key_id NOT GLOB '*[^0-9a-f]*' AND instr(source_key_id, char(0)) = 0),
 target_device_id TEXT NOT NULL CHECK (typeof(target_device_id) = 'text'
  AND length(CAST(target_device_id AS BLOB)) BETWEEN 1 AND 64
  AND target_device_id NOT GLOB '*[^!-~]*' AND instr(target_device_id, char(0)) = 0),
 target_key_id TEXT NOT NULL CHECK (typeof(target_key_id) = 'text'
  AND length(CAST(target_key_id AS BLOB)) = 64
  AND target_key_id NOT GLOB '*[^0-9a-f]*' AND instr(target_key_id, char(0)) = 0),
 message_a_digest TEXT NOT NULL CHECK (typeof(message_a_digest) = 'text'
  AND length(CAST(message_a_digest AS BLOB)) = 64
  AND message_a_digest NOT GLOB '*[^0-9a-f]*' AND instr(message_a_digest, char(0)) = 0),
 prepare_created_at INTEGER NOT NULL CHECK (typeof(prepare_created_at) = 'integer'
  AND prepare_created_at BETWEEN 0 AND 9007199254740),
 attempt_not_after INTEGER NOT NULL CHECK (typeof(attempt_not_after) = 'integer'
  AND attempt_not_after BETWEEN 1 AND 9007199254740
  AND attempt_not_after = prepare_created_at + 55),
 policy_revision INTEGER NOT NULL CHECK (typeof(policy_revision) = 'integer'
  AND policy_revision BETWEEN 1 AND 9007199254740991),
 prepare_digest TEXT NOT NULL CHECK (typeof(prepare_digest) = 'text'
  AND length(CAST(prepare_digest AS BLOB)) = 64
  AND prepare_digest NOT GLOB '*[^0-9a-f]*' AND instr(prepare_digest, char(0)) = 0),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer'
  AND created_at_ms BETWEEN 0 AND 9007199254740991),
 phase INTEGER NOT NULL CHECK (typeof(phase) = 'integer' AND phase BETWEEN 1 AND 5),
 offer_digest TEXT CHECK (offer_digest IS NULL OR (typeof(offer_digest) = 'text'
  AND length(CAST(offer_digest AS BLOB)) = 64
  AND offer_digest NOT GLOB '*[^0-9a-f]*' AND instr(offer_digest, char(0)) = 0)),
 answer_digest TEXT CHECK (answer_digest IS NULL OR (typeof(answer_digest) = 'text'
  AND length(CAST(answer_digest AS BLOB)) = 64
  AND answer_digest NOT GLOB '*[^0-9a-f]*' AND instr(answer_digest, char(0)) = 0)),
 last_request_digest TEXT NOT NULL CHECK (typeof(last_request_digest) = 'text'
  AND length(CAST(last_request_digest AS BLOB)) = 64
  AND last_request_digest NOT GLOB '*[^0-9a-f]*' AND instr(last_request_digest, char(0)) = 0),
 last_nonce TEXT NOT NULL CHECK (typeof(last_nonce) = 'text'
  AND length(CAST(last_nonce AS BLOB)) = 32
  AND last_nonce NOT GLOB '*[^0-9a-f]*' AND instr(last_nonce, char(0)) = 0),
 exec_id TEXT NOT NULL CHECK (typeof(exec_id) = 'text'
  AND length(CAST(exec_id AS BLOB)) = 32
  AND exec_id NOT GLOB '*[^0-9a-f]*' AND instr(exec_id, char(0)) = 0),
 updated_at_ms INTEGER NOT NULL CHECK (typeof(updated_at_ms) = 'integer'
  AND updated_at_ms BETWEEN 0 AND 9007199254740991 AND updated_at_ms >= created_at_ms),
 CHECK (source_device_id <> target_device_id),
 CHECK ((offer_digest IS NOT NULL) = (phase >= 2)),
 CHECK ((answer_digest IS NOT NULL) = (phase >= 4)),
 CHECK (phase <> 2 OR last_request_digest IS offer_digest),
 CHECK (phase <> 4 OR last_request_digest IS answer_digest),
 FOREIGN KEY (authority_id, group_id) REFERENCES traversal_realms(authority_id, group_id)
) WITHOUT ROWID;`,
	`CREATE INDEX IF NOT EXISTS traversal_attempts_source
 ON traversal_attempts(authority_id, group_id, source_device_id, phase, attempt_not_after);`,
	`CREATE INDEX IF NOT EXISTS traversal_attempts_target
 ON traversal_attempts(authority_id, group_id, target_device_id, phase, attempt_not_after);`,
	`CREATE TRIGGER IF NOT EXISTS traversal_attempt_insert
 BEFORE INSERT ON traversal_attempts
 WHEN ${INVALID_CLOCK_SQL}
  OR NEW.phase IS NOT 1 OR NEW.offer_digest IS NOT NULL OR NEW.answer_digest IS NOT NULL
  OR NEW.last_request_digest IS NOT NEW.prepare_digest
 BEGIN SELECT RAISE(ABORT, 'traversal_attempt_initial'); END;`,
	// A collision must abort before SQLite applies any conflict-resolution path.
	`CREATE TRIGGER IF NOT EXISTS traversal_attempt_collision
 BEFORE INSERT ON traversal_attempts
 WHEN EXISTS (SELECT 1 FROM traversal_attempts a WHERE a.session_id = NEW.session_id)
 BEGIN SELECT RAISE(ABORT, 'traversal_attempt_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_attempt_quota
 BEFORE INSERT ON traversal_attempts
 WHEN ${INVALID_CLOCK_SQL}
  OR (NEW.phase < 5 AND ${RELAY_ADMISSION_CLOCK_SQL} < NEW.attempt_not_after * 1000 AND (
   EXISTS (SELECT 1 FROM traversal_attempts a
   WHERE a.authority_id = NEW.authority_id AND a.group_id = NEW.group_id
    AND a.source_device_id = NEW.source_device_id AND a.target_device_id = NEW.target_device_id
    AND a.phase < 5 AND ${RELAY_ADMISSION_CLOCK_SQL} < a.attempt_not_after * 1000)
  OR (SELECT COUNT(*) FROM traversal_attempts a
   WHERE a.authority_id = NEW.authority_id AND a.group_id = NEW.group_id
    AND a.source_device_id = NEW.source_device_id
    AND a.phase < 5 AND ${RELAY_ADMISSION_CLOCK_SQL} < a.attempt_not_after * 1000) >= 4
  OR (SELECT COUNT(*) FROM traversal_attempts a
   WHERE a.authority_id = NEW.authority_id AND a.group_id = NEW.group_id
    AND a.target_device_id = NEW.target_device_id
     AND a.phase < 5 AND ${RELAY_ADMISSION_CLOCK_SQL} < a.attempt_not_after * 1000) >= 4))
 BEGIN SELECT RAISE(ABORT, 'traversal_attempt_quota'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_attempt_update
 BEFORE UPDATE ON traversal_attempts
 WHEN ${INVALID_CLOCK_SQL}
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.authority_id IS NOT OLD.authority_id OR NEW.group_id IS NOT OLD.group_id
  OR NEW.source_device_id IS NOT OLD.source_device_id OR NEW.source_key_id IS NOT OLD.source_key_id
  OR NEW.target_device_id IS NOT OLD.target_device_id OR NEW.target_key_id IS NOT OLD.target_key_id
  OR NEW.message_a_digest IS NOT OLD.message_a_digest
  OR NEW.prepare_created_at IS NOT OLD.prepare_created_at
  OR NEW.attempt_not_after IS NOT OLD.attempt_not_after
  OR NEW.policy_revision IS NOT OLD.policy_revision OR NEW.prepare_digest IS NOT OLD.prepare_digest
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR OLD.phase >= 5 OR NEW.phase IS NOT OLD.phase + 1
  OR NEW.exec_id IS OLD.exec_id OR NEW.updated_at_ms < OLD.updated_at_ms
  OR (OLD.phase >= 2 AND NEW.offer_digest IS NOT OLD.offer_digest)
  OR (OLD.phase >= 4 AND NEW.answer_digest IS NOT OLD.answer_digest)
 BEGIN SELECT RAISE(ABORT, 'traversal_attempt_transition'); END;`,
	// Completed rows retain the same expiry-based tombstone protection.
	`CREATE TRIGGER IF NOT EXISTS traversal_attempt_delete
 BEFORE DELETE ON traversal_attempts
 WHEN ${INVALID_CLOCK_SQL}
  OR ${RELAY_ADMISSION_CLOCK_SQL} < OLD.attempt_not_after * 1000 + 120000
 BEGIN SELECT RAISE(ABORT, 'traversal_attempt_retention'); END;`,
]);
