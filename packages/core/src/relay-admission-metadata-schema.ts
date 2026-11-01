import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";

/**
 * Inert, opt-in definitions only. Nothing installs or queries this schema here.
 * A future trusted writer must set a fixed captured policy revision + 1 by
 * authority key and publish all child changes in one atomic batch. The update
 * trigger must abort a stale batch. A revision-filtered zero-row UPDATE alone
 * cannot stop later children from using another writer's revision. Constraints
 * cannot prove batch provenance or the controller's health observations.
 * Root counters start at 1 so initialization cannot exhaust future updates.
 */
export const RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
	`CREATE TABLE IF NOT EXISTS relay_admission_authority_policy (
 authority_id TEXT NOT NULL PRIMARY KEY CHECK (typeof(authority_id) = 'text'
  AND length(CAST(authority_id AS BLOB)) = 64
  AND authority_id NOT GLOB '*[^0-9a-f]*' AND instr(authority_id, char(0)) = 0),
 policy_revision INTEGER NOT NULL CHECK (typeof(policy_revision) = 'integer'
  AND policy_revision BETWEEN 1 AND 9007199254740991),
 operator_state TEXT NOT NULL CHECK (operator_state IN ('enabled','disabled'))
) WITHOUT ROWID;`,
	`CREATE TABLE IF NOT EXISTS relay_admission_audiences (
 authority_id TEXT NOT NULL,
 audience_id TEXT NOT NULL CHECK (typeof(audience_id) = 'text'
  AND length(CAST(audience_id AS BLOB)) = 64
  AND audience_id NOT GLOB '*[^0-9a-f]*' AND instr(audience_id, char(0)) = 0),
 state TEXT NOT NULL CHECK (state IN ('enabled','revoked')),
 changed_revision INTEGER NOT NULL CHECK (typeof(changed_revision) = 'integer'
  AND changed_revision BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (authority_id, audience_id),
 FOREIGN KEY (authority_id) REFERENCES relay_admission_authority_policy(authority_id)
) WITHOUT ROWID;`,
	`CREATE TABLE IF NOT EXISTS relay_admission_realms (
 authority_id TEXT NOT NULL,
 group_id TEXT NOT NULL CHECK (typeof(group_id) = 'text'
  AND length(CAST(group_id AS BLOB)) BETWEEN 1 AND 128 AND instr(group_id, char(0)) = 0),
 operator_state TEXT NOT NULL CHECK (operator_state IN ('enabled','disabled')),
 changed_revision INTEGER NOT NULL CHECK (typeof(changed_revision) = 'integer'
  AND changed_revision BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (authority_id, group_id),
 FOREIGN KEY (authority_id) REFERENCES relay_admission_authority_policy(authority_id)
) WITHOUT ROWID;`,
	`CREATE TABLE IF NOT EXISTS relay_admission_readiness (
 authority_id TEXT NOT NULL,
 scope TEXT NOT NULL CHECK (scope IN ('authority','realm')),
 group_id TEXT NOT NULL CHECK (typeof(group_id) = 'text' AND instr(group_id, char(0)) = 0
  AND ((scope = 'authority' AND group_id = '')
   OR (scope = 'realm' AND length(CAST(group_id AS BLOB)) BETWEEN 1 AND 128))),
 revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer'
  AND revision BETWEEN 1 AND 9007199254740991),
 state TEXT NOT NULL CHECK (state IN ('ready','paused','tripped')),
 observed_at_ms INTEGER CHECK (observed_at_ms IS NULL OR (typeof(observed_at_ms) = 'integer'
  AND observed_at_ms BETWEEN 0 AND 9007199254690991)),
 CHECK (state <> 'ready' OR observed_at_ms IS NOT NULL),
 PRIMARY KEY (authority_id, scope, group_id),
 FOREIGN KEY (authority_id) REFERENCES relay_admission_authority_policy(authority_id)
) WITHOUT ROWID;`,
	// BEFORE INSERT collisions must abort even REPLACE, UPSERT and DO NOTHING.
	`CREATE TRIGGER IF NOT EXISTS relay_admission_policy_insert
 BEFORE INSERT ON relay_admission_authority_policy
 WHEN NEW.policy_revision IS NOT 1
 BEGIN SELECT RAISE(ABORT, 'relay_policy_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_policy_collision
 BEFORE INSERT ON relay_admission_authority_policy
 WHEN EXISTS (SELECT 1 FROM relay_admission_authority_policy p WHERE p.authority_id = NEW.authority_id)
 BEGIN SELECT RAISE(ABORT, 'relay_policy_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_policy_update
 BEFORE UPDATE ON relay_admission_authority_policy
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.policy_revision IS NOT OLD.policy_revision + 1
 BEGIN SELECT RAISE(ABORT, 'relay_policy_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_policy_delete
 BEFORE DELETE ON relay_admission_authority_policy
 BEGIN SELECT RAISE(ABORT, 'relay_policy_permanent'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_audience_collision
 BEFORE INSERT ON relay_admission_audiences
 WHEN EXISTS (SELECT 1 FROM relay_admission_audiences a
  WHERE a.authority_id = NEW.authority_id AND a.audience_id = NEW.audience_id)
 BEGIN SELECT RAISE(ABORT, 'relay_audience_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_audience_insert
 BEFORE INSERT ON relay_admission_audiences
 WHEN NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
  WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_audience_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_audience_update
 BEFORE UPDATE ON relay_admission_audiences
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.audience_id IS NOT OLD.audience_id
  OR OLD.state = 'revoked' OR NEW.changed_revision <= OLD.changed_revision
  OR NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
   WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_audience_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_audience_delete
 BEFORE DELETE ON relay_admission_audiences
 BEGIN SELECT RAISE(ABORT, 'relay_audience_permanent'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_realm_collision
 BEFORE INSERT ON relay_admission_realms
 WHEN EXISTS (SELECT 1 FROM relay_admission_realms r
  WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
 BEGIN SELECT RAISE(ABORT, 'relay_realm_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_realm_insert
 BEFORE INSERT ON relay_admission_realms
 WHEN NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
  WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_realm_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_realm_update
 BEFORE UPDATE ON relay_admission_realms
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.group_id IS NOT OLD.group_id
  OR NEW.changed_revision <= OLD.changed_revision
  OR NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
   WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_realm_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_realm_delete
 BEFORE DELETE ON relay_admission_realms
 BEGIN SELECT RAISE(ABORT, 'relay_realm_permanent'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_collision
 BEFORE INSERT ON relay_admission_readiness
 WHEN EXISTS (SELECT 1 FROM relay_admission_readiness h
  WHERE h.authority_id = NEW.authority_id AND h.scope = NEW.scope AND h.group_id = NEW.group_id)
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_insert
 BEFORE INSERT ON relay_admission_readiness
 WHEN NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p WHERE p.authority_id = NEW.authority_id)
  OR (NEW.scope = 'authority' AND NEW.revision IS NOT 1)
  OR (NEW.scope = 'realm' AND (
   NOT EXISTS (SELECT 1 FROM relay_admission_realms r
    WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
   OR NOT EXISTS (SELECT 1 FROM relay_admission_readiness ha
    WHERE ha.authority_id = NEW.authority_id AND ha.scope = 'authority'
     AND ha.group_id = '' AND ha.revision = NEW.revision)))
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_update
 BEFORE UPDATE ON relay_admission_readiness
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.scope IS NOT OLD.scope
  OR NEW.group_id IS NOT OLD.group_id
  OR (NEW.scope = 'authority' AND NEW.revision IS NOT OLD.revision + 1)
  OR (NEW.scope = 'realm' AND (NEW.revision <= OLD.revision
   OR NOT EXISTS (SELECT 1 FROM relay_admission_realms r
    WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
   OR NOT EXISTS (SELECT 1 FROM relay_admission_readiness ha
    WHERE ha.authority_id = NEW.authority_id AND ha.scope = 'authority'
     AND ha.group_id = '' AND ha.revision = NEW.revision)))
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_delete
 BEFORE DELETE ON relay_admission_readiness
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_permanent'); END;`,
]);

/**
 * Fixed private SQL ABI shared with the future single nonce INSERT:
 * ?1 device, ?2 nonce, ?3 fresh attempt, ?4 admitBeforeMs, ?5 authority,
 * ?6 exact group, ?7 audience, ?8 required captured policy revision.
 * Participants start at ?9. Bind every runtime value. No startup override applies.
 * This predicate checks metadata only, not full eligibility or durable budgets.
 */
export const RELAY_ADMISSION_METADATA_GATE_SQL: string = `EXISTS (
 SELECT 1 FROM relay_admission_authority_policy p
 JOIN relay_admission_audiences a ON a.authority_id = p.authority_id AND a.audience_id = ?7
 JOIN relay_admission_realms r ON r.authority_id = p.authority_id AND r.group_id = ?6
 JOIN relay_admission_readiness ha ON ha.authority_id = p.authority_id
  AND ha.scope = 'authority' AND ha.group_id = ''
 JOIN relay_admission_readiness hr ON hr.authority_id = p.authority_id
  AND hr.scope = 'realm' AND hr.group_id = ?6
 WHERE p.authority_id = ?5 AND p.policy_revision = ?8
  AND p.operator_state = 'enabled' AND a.state = 'enabled' AND r.operator_state = 'enabled'
  AND a.changed_revision <= p.policy_revision AND r.changed_revision <= p.policy_revision
  AND ha.state = 'ready' AND hr.state = 'ready' AND hr.revision <= ha.revision
  AND MAX(ha.observed_at_ms, hr.observed_at_ms) <= ${RELAY_ADMISSION_CLOCK_SQL} + 10000
  AND MIN(ha.observed_at_ms, hr.observed_at_ms) + 50000 > ${RELAY_ADMISSION_CLOCK_SQL}
)`;

/**
 * Three projections, without a leading comma, for that same gated INSERT only.
 * Metadata is unchanged by the INSERT. Scalar subqueries use bound context,
 * never nonce-row columns. The authority counter orders all health publications.
 */
export const RELAY_ADMISSION_METADATA_RETURNING_SQL: string = `
 (SELECT ha.revision FROM relay_admission_readiness ha
  WHERE ha.authority_id = ?5 AND ha.scope = 'authority' AND ha.group_id = '') AS readinessRevision,
 (SELECT MIN(ha.observed_at_ms, hr.observed_at_ms)
  FROM relay_admission_readiness ha
  JOIN relay_admission_readiness hr ON hr.authority_id = ha.authority_id
   AND hr.scope = 'realm' AND hr.group_id = ?6
  WHERE ha.authority_id = ?5 AND ha.scope = 'authority' AND ha.group_id = '') AS readinessObservedAtMs,
 (SELECT p.policy_revision FROM relay_admission_authority_policy p
  WHERE p.authority_id = ?5) AS policyRevision`;
