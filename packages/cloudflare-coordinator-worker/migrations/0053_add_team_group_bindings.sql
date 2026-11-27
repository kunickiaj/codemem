CREATE TABLE IF NOT EXISTS coordinator_team_group_bindings (
 team_id TEXT PRIMARY KEY,
 group_id TEXT NOT NULL,
 bound_at TEXT NOT NULL,
 source TEXT NOT NULL CHECK (source IN ('invitation', 'backfill', 'admin'))
);

CREATE INDEX IF NOT EXISTS idx_coordinator_team_group_bindings_group
 ON coordinator_team_group_bindings (group_id, team_id);

CREATE TRIGGER IF NOT EXISTS coordinator_team_group_binding_no_update
BEFORE UPDATE ON coordinator_team_group_bindings
BEGIN
 SELECT RAISE(ABORT, 'team_group_binding_immutable');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_team_group_binding_no_delete
BEFORE DELETE ON coordinator_team_group_bindings
BEGIN
 SELECT RAISE(ABORT, 'team_group_binding_immutable');
END;

INSERT OR IGNORE INTO coordinator_team_group_bindings (team_id, group_id, bound_at, source)
SELECT policy_team_id, MIN(group_id), MIN(created_at), 'backfill' FROM coordinator_invites
 WHERE invite_kind = 'team_member' AND policy_team_id IS NOT NULL
 GROUP BY policy_team_id HAVING COUNT(DISTINCT group_id) = 1;
