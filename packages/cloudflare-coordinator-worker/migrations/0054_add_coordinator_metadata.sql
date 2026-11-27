-- Named integer values of the coordinator database, such as the invitation token lookup fence.
-- Additive only: one new empty table. A Worker from before 0054 keeps working with it applied.
CREATE TABLE IF NOT EXISTS coordinator_metadata (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
