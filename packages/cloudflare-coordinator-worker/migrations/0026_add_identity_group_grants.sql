-- Empty by design; only server-trusted controller attestations can issue grants.
-- Independent tombstones have no device/controller foreign keys.
CREATE TABLE IF NOT EXISTS coordinator_identity_group_grants (
 coordinator_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
 revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
 source_kind TEXT NOT NULL CHECK (source_kind = 'controller_attestation'),
 source_receipt_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 revoked_at TEXT,
 PRIMARY KEY (coordinator_id, identity_id, group_id),
 CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);
