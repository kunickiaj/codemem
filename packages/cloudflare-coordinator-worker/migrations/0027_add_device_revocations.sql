CREATE TABLE IF NOT EXISTS coordinator_device_revocations (
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('device_id', 'ed25519_key')),
  subject_value TEXT NOT NULL CHECK(
    (subject_kind = 'device_id' AND length(subject_value) BETWEEN 1 AND 256) OR
    (subject_kind = 'ed25519_key' AND length(subject_value) = 64
      AND subject_value NOT GLOB '*[^a-f0-9]*')),
  revocation_id TEXT NOT NULL,
  evidence_group_id TEXT NOT NULL,
  evidence_device_id TEXT NOT NULL,
  evidence_public_key TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subject_kind, subject_value)
);
