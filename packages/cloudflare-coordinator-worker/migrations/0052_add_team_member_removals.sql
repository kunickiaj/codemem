CREATE TABLE IF NOT EXISTS coordinator_team_member_removals (
 removal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
 group_id TEXT NOT NULL,
 team_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 removed_by_device_id TEXT,
 removed_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_team_member_removals_member
 ON coordinator_team_member_removals (group_id, team_id, identity_id);

CREATE INDEX IF NOT EXISTS idx_coordinator_team_member_removals_group
 ON coordinator_team_member_removals (group_id, removal_seq);

CREATE TRIGGER IF NOT EXISTS coordinator_team_member_removal_no_update
BEFORE UPDATE ON coordinator_team_member_removals
BEGIN
 SELECT RAISE(ABORT, 'team_member_removal_immutable');
END;

CREATE TRIGGER IF NOT EXISTS coordinator_team_member_removal_no_delete
BEFORE DELETE ON coordinator_team_member_removals
BEGIN
 SELECT RAISE(ABORT, 'team_member_removal_immutable');
END;
