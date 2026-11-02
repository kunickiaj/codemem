/**
 * Inert definitions only. A trusted writer must update the root by authority key
 * to a fixed captured successor and publish children in the same atomic batch.
 * Filtering by the old revision can update zero rows while later children use
 * another writer's revision. These triggers cannot prove batch provenance,
 * health observations, or authorization.
 */
export const TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
	`CREATE TABLE IF NOT EXISTS traversal_authority_policy (
 authority_id TEXT NOT NULL PRIMARY KEY CHECK (typeof(authority_id) = 'text'
  AND length(CAST(authority_id AS BLOB)) = 64
  AND authority_id NOT GLOB '*[^0-9a-f]*' AND instr(authority_id, char(0)) = 0),
 policy_revision INTEGER NOT NULL CHECK (typeof(policy_revision) = 'integer'
  AND policy_revision BETWEEN 1 AND 9007199254740991),
 operator_state TEXT NOT NULL DEFAULT 'disabled' CHECK (operator_state IN ('enabled','disabled'))
) WITHOUT ROWID;`,
	`CREATE TABLE IF NOT EXISTS traversal_realms (
 authority_id TEXT NOT NULL,
 group_id TEXT NOT NULL CHECK (typeof(group_id) = 'text'
  AND length(CAST(group_id AS BLOB)) BETWEEN 1 AND 128 AND instr(group_id, char(0)) = 0),
 operator_state TEXT NOT NULL DEFAULT 'disabled' CHECK (operator_state IN ('enabled','disabled')),
 changed_revision INTEGER NOT NULL CHECK (typeof(changed_revision) = 'integer'
  AND changed_revision BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (authority_id, group_id),
 FOREIGN KEY (authority_id) REFERENCES traversal_authority_policy(authority_id)
) WITHOUT ROWID;`,
	`CREATE TABLE IF NOT EXISTS traversal_readiness (
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
 FOREIGN KEY (authority_id) REFERENCES traversal_authority_policy(authority_id)
) WITHOUT ROWID;`,
	// BEFORE INSERT aborts collisions even with REPLACE, UPSERT or DO NOTHING.
	`CREATE TRIGGER IF NOT EXISTS traversal_policy_insert
 BEFORE INSERT ON traversal_authority_policy
 WHEN NEW.policy_revision IS NOT 1
 BEGIN SELECT RAISE(ABORT, 'traversal_policy_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_policy_collision
 BEFORE INSERT ON traversal_authority_policy
 WHEN EXISTS (SELECT 1 FROM traversal_authority_policy p WHERE p.authority_id = NEW.authority_id)
 BEGIN SELECT RAISE(ABORT, 'traversal_policy_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_policy_update
 BEFORE UPDATE ON traversal_authority_policy
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.policy_revision IS NOT OLD.policy_revision + 1
 BEGIN SELECT RAISE(ABORT, 'traversal_policy_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_policy_delete
 BEFORE DELETE ON traversal_authority_policy
 BEGIN SELECT RAISE(ABORT, 'traversal_policy_permanent'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_realm_collision
 BEFORE INSERT ON traversal_realms
 WHEN EXISTS (SELECT 1 FROM traversal_realms r
  WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
 BEGIN SELECT RAISE(ABORT, 'traversal_realm_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_realm_insert
 BEFORE INSERT ON traversal_realms
 WHEN NOT EXISTS (SELECT 1 FROM traversal_authority_policy p
  WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'traversal_realm_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_realm_update
 BEFORE UPDATE ON traversal_realms
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.group_id IS NOT OLD.group_id
  OR NEW.changed_revision <= OLD.changed_revision
  OR NOT EXISTS (SELECT 1 FROM traversal_authority_policy p
   WHERE p.authority_id = NEW.authority_id AND p.policy_revision = NEW.changed_revision)
 BEGIN SELECT RAISE(ABORT, 'traversal_realm_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_realm_delete
 BEFORE DELETE ON traversal_realms
 BEGIN SELECT RAISE(ABORT, 'traversal_realm_permanent'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_readiness_collision
 BEFORE INSERT ON traversal_readiness
 WHEN EXISTS (SELECT 1 FROM traversal_readiness h
  WHERE h.authority_id = NEW.authority_id AND h.scope = NEW.scope AND h.group_id = NEW.group_id)
 BEGIN SELECT RAISE(ABORT, 'traversal_readiness_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_readiness_insert
 BEFORE INSERT ON traversal_readiness
 WHEN NOT EXISTS (SELECT 1 FROM traversal_authority_policy p WHERE p.authority_id = NEW.authority_id)
  OR (NEW.scope = 'authority' AND NEW.revision IS NOT 1)
  OR (NEW.scope = 'realm' AND (
   NOT EXISTS (SELECT 1 FROM traversal_realms r
    WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
   OR NOT EXISTS (SELECT 1 FROM traversal_readiness ha
    WHERE ha.authority_id = NEW.authority_id AND ha.scope = 'authority'
     AND ha.group_id = '' AND ha.revision = NEW.revision)))
 BEGIN SELECT RAISE(ABORT, 'traversal_readiness_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_readiness_update
 BEFORE UPDATE ON traversal_readiness
 WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.scope IS NOT OLD.scope
  OR NEW.group_id IS NOT OLD.group_id
  OR (NEW.scope = 'authority' AND NEW.revision IS NOT OLD.revision + 1)
  OR (NEW.scope = 'realm' AND (NEW.revision <= OLD.revision
   OR NOT EXISTS (SELECT 1 FROM traversal_realms r
    WHERE r.authority_id = NEW.authority_id AND r.group_id = NEW.group_id)
   OR NOT EXISTS (SELECT 1 FROM traversal_readiness ha
    WHERE ha.authority_id = NEW.authority_id AND ha.scope = 'authority'
     AND ha.group_id = '' AND ha.revision = NEW.revision)))
 BEGIN SELECT RAISE(ABORT, 'traversal_readiness_revision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS traversal_readiness_delete
 BEFORE DELETE ON traversal_readiness
 BEGIN SELECT RAISE(ABORT, 'traversal_readiness_permanent'); END;`,
]);
