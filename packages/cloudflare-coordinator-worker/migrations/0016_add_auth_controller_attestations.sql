-- Empty by design: enrollment labels do not constitute admin-reviewed authority.
-- No foreign keys: retain revoked proofs even after enrollment removal.
CREATE TABLE IF NOT EXISTS coordinator_auth_controller_attestations (
	attestation_id TEXT NOT NULL,
	coordinator_id TEXT NOT NULL,
	identity_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	public_key TEXT NOT NULL,
	fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
	review_receipt_id TEXT NOT NULL,
	evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
	enrollment_identity_id TEXT,
	revision INTEGER NOT NULL DEFAULT 1 CHECK (revision = 1),
	created_at TEXT NOT NULL,
	revoked_at TEXT,
	PRIMARY KEY (coordinator_id, attestation_id),
	UNIQUE (coordinator_id, group_id, device_id, fingerprint),
	UNIQUE (coordinator_id, review_receipt_id)
);
