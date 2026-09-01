-- `listInvites` runs `SELECT ... FROM coordinator_invites WHERE group_id = ?
-- ORDER BY created_at DESC`, which scanned the whole table and then sorted it
-- through a temp b-tree. Invites are never pruned, so that scan grows with
-- every invite ever issued. Ordering the index by created_at DESC lets one
-- index seek satisfy both the filter and the ordering.
CREATE INDEX IF NOT EXISTS idx_coordinator_invites_group_created
ON coordinator_invites(group_id, created_at DESC);
