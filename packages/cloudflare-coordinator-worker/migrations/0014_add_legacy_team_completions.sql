CREATE TABLE IF NOT EXISTS coordinator_legacy_team_completions (
  group_id TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  manifest_version INTEGER NOT NULL CHECK (manifest_version = 1),
  manifest_json TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, candidate_ref)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_legacy_team_completions_group
ON coordinator_legacy_team_completions(group_id, completed_at, candidate_ref);
