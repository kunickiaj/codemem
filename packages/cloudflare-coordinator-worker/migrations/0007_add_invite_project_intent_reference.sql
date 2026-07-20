ALTER TABLE coordinator_invites ADD COLUMN operation_id TEXT;
ALTER TABLE coordinator_invites ADD COLUMN reviewed_project_set_digest TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_coordinator_invites_operation_id
ON coordinator_invites(operation_id) WHERE operation_id IS NOT NULL;
