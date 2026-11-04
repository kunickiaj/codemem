-- Relay admission tables, read by POST /v1/relay/admission-check. Every row
-- starts absent, which keeps admission off until trusted provisioning writes it.
-- Generated from packages/core/src/relay-admission-metadata-schema.ts. relay-migrations.test.ts checks parity.
CREATE TABLE IF NOT EXISTS relay_admission_authority_policy (
 authority_id TEXT NOT NULL PRIMARY KEY CHECK (typeof(authority_id) = 'text'
  AND length(CAST(authority_id AS BLOB)) = 64
  AND authority_id NOT GLOB '*[^0-9a-f]*' AND instr(authority_id, char(0)) = 0),
 policy_revision INTEGER NOT NULL CHECK (typeof(policy_revision) = 'integer'
  AND policy_revision BETWEEN 1 AND 9007199254740991),
 operator_state TEXT NOT NULL CHECK (operator_state IN ('enabled','disabled'))
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS relay_admission_audiences (
 authority_id TEXT NOT NULL,
 audience_id TEXT NOT NULL CHECK (typeof(audience_id) = 'text'
  AND length(CAST(audience_id AS BLOB)) = 64
  AND audience_id NOT GLOB '*[^0-9a-f]*' AND instr(audience_id, char(0)) = 0),
 state TEXT NOT NULL CHECK (state IN ('enabled','revoked')),
 changed_revision INTEGER NOT NULL CHECK (typeof(changed_revision) = 'integer'
  AND changed_revision BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (authority_id, audience_id),
 FOREIGN KEY (authority_id) REFERENCES relay_admission_authority_policy(authority_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS relay_admission_realms (
 authority_id TEXT NOT NULL,
 group_id TEXT NOT NULL CHECK (typeof(group_id) = 'text'
  AND length(CAST(group_id AS BLOB)) BETWEEN 1 AND 128 AND instr(group_id, char(0)) = 0),
 operator_state TEXT NOT NULL CHECK (operator_state IN ('enabled','disabled')),
 changed_revision INTEGER NOT NULL CHECK (typeof(changed_revision) = 'integer'
  AND changed_revision BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (authority_id, group_id),
 FOREIGN KEY (authority_id) REFERENCES relay_admission_authority_policy(authority_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS relay_admission_readiness (
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
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS relay_admission_policy_insert
 BEFORE INSERT ON relay_admission_authority_policy
 WHEN NEW.policy_revision IS NOT 1
 BEGIN SELECT RAISE(ABORT, 'relay_policy_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_policy_collision
 BEFORE INSERT ON relay_admission_authority_policy
 WHEN EXISTS (SELECT 1 FROM relay_admission_authority_policy p WHERE p.authority_id = NEW.authority_id)
 BEGIN SELECT RAISE(ABORT, 'relay_policy_collision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_policy_update
 BEFORE UPDATE ON relay_admission_authority_policy
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.policy_revision IS NOT OLD.policy_revision + 1
 BEGIN SELECT RAISE(ABORT, 'relay_policy_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_policy_delete
 BEFORE DELETE ON relay_admission_authority_policy
 BEGIN SELECT RAISE(ABORT, 'relay_policy_permanent'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_audience_collision
 BEFORE INSERT ON relay_admission_audiences
 WHEN EXISTS (SELECT 1 FROM relay_admission_audiences a
  WHERE a.authority_id = NEW.authority_id AND a.audience_id = NEW.audience_id)
 BEGIN SELECT RAISE(ABORT, 'relay_audience_collision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_audience_insert
 BEFORE INSERT ON relay_admission_audiences
 WHEN NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
  WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_audience_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_audience_update
 BEFORE UPDATE ON relay_admission_audiences
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.audience_id IS NOT OLD.audience_id
  OR OLD.state = 'revoked' OR NEW.changed_revision <= OLD.changed_revision
  OR NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
   WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_audience_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_audience_delete
 BEFORE DELETE ON relay_admission_audiences
 BEGIN SELECT RAISE(ABORT, 'relay_audience_permanent'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_realm_collision
 BEFORE INSERT ON relay_admission_realms
 WHEN EXISTS (SELECT 1 FROM relay_admission_realms r
  WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
 BEGIN SELECT RAISE(ABORT, 'relay_realm_collision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_realm_insert
 BEFORE INSERT ON relay_admission_realms
 WHEN NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
  WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_realm_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_realm_update
 BEFORE UPDATE ON relay_admission_realms
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.group_id IS NOT OLD.group_id
  OR NEW.changed_revision <= OLD.changed_revision
  OR NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p
   WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'relay_realm_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_realm_delete
 BEFORE DELETE ON relay_admission_realms
 BEGIN SELECT RAISE(ABORT, 'relay_realm_permanent'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_collision
 BEFORE INSERT ON relay_admission_readiness
 WHEN EXISTS (SELECT 1 FROM relay_admission_readiness h
  WHERE h.authority_id = NEW.authority_id AND h.scope = NEW.scope AND h.group_id = NEW.group_id)
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_collision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_insert
 BEFORE INSERT ON relay_admission_readiness
 WHEN NOT EXISTS (SELECT 1 FROM relay_admission_authority_policy p WHERE p.authority_id = NEW.authority_id)
  OR (NEW.scope = 'authority' AND NEW.revision IS NOT 1)
  OR (NEW.scope = 'realm' AND (
   NOT EXISTS (SELECT 1 FROM relay_admission_realms r
    WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
   OR NOT EXISTS (SELECT 1 FROM relay_admission_readiness ha
    WHERE ha.authority_id = NEW.authority_id AND ha.scope = 'authority'
     AND ha.group_id = '' AND ha.revision = NEW.revision)))
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_update
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
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_revision'); END;
CREATE TRIGGER IF NOT EXISTS relay_admission_readiness_delete
 BEFORE DELETE ON relay_admission_readiness
 BEGIN SELECT RAISE(ABORT, 'relay_readiness_permanent'); END;
