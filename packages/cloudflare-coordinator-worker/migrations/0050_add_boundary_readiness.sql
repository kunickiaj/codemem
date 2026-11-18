-- Readiness records (0.50): one per device and group, sent by a device that can
-- move each shared Project to its own boundary. A record lists the Projects the
-- device holds under an older scope and the boundary each one needs. It grants
-- nothing. Mirror of packages/core/src/coordinator-boundary-readiness.ts.
CREATE TABLE IF NOT EXISTS coordinator_boundary_readiness (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  record_id TEXT NOT NULL,
  omitted_projects INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, device_id)
);

CREATE TABLE IF NOT EXISTS coordinator_boundary_readiness_projects (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  boundary_scope_id TEXT NOT NULL,
  source_scope_id TEXT NOT NULL,
  state TEXT NOT NULL,
  own_rows_in_source INTEGER NOT NULL,
  own_rows_in_boundary INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id, boundary_scope_id, source_scope_id)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_boundary_readiness_projects_boundary
  ON coordinator_boundary_readiness_projects(group_id, boundary_scope_id);
