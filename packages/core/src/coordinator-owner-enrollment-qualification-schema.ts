/**
 * Inert storage only, not an issuer or proof of authority. Future issuance must
 * resolve every fact server-side from the exact link, claim and genuine review.
 * No subject/email copy or cascading references: historical evidence survives
 * removal or revocation of the original device. Nothing installs this on open.
 */
export interface CoordinatorOwnerEnrollmentQualificationRow {
	readonly qualification_id: string;
	readonly coordinator_id: string;
	readonly link_id: string;
	readonly device_claim_id: string;
	readonly identity_id: string;
	readonly source_group_id: string;
	readonly device_id: string;
	readonly public_key: string;
	readonly fingerprint: string;
	readonly key_id: string;
	readonly controller_attestation_id: string;
	readonly controller_attestation_revision: number;
	readonly controller_attestation_created_at: string;
	readonly review_receipt_id: string;
	readonly evidence_digest: string;
	readonly enrollment_identity_id: string | null;
	readonly link_attempt_id: string;
	readonly link_auth_config_revision: string;
	readonly link_created_at_ms: number;
	readonly created_at_ms: number;
	readonly revoked_at_ms: number | null;
}

// Separate complete statements allow native D1 batches without splitting triggers.
export const COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS = [
	`
CREATE TABLE IF NOT EXISTS coordinator_owner_enrollment_qualifications (
 qualification_id TEXT PRIMARY KEY NOT NULL CHECK (typeof(qualification_id) = 'text' AND length(qualification_id) BETWEEN 1 AND 256 AND qualification_id = trim(qualification_id) AND length(trim(qualification_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(qualification_id, char(0)) = 0),
 coordinator_id TEXT NOT NULL CHECK (typeof(coordinator_id) = 'text' AND length(coordinator_id) BETWEEN 1 AND 256 AND coordinator_id = trim(coordinator_id) AND length(trim(coordinator_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(coordinator_id, char(0)) = 0),
 link_id TEXT NOT NULL CHECK (typeof(link_id) = 'text' AND length(link_id) BETWEEN 1 AND 256 AND link_id = trim(link_id) AND length(trim(link_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(link_id, char(0)) = 0),
 device_claim_id TEXT NOT NULL CHECK (typeof(device_claim_id) = 'text' AND length(device_claim_id) BETWEEN 1 AND 256 AND device_claim_id = trim(device_claim_id) AND length(trim(device_claim_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(device_claim_id, char(0)) = 0),
 identity_id TEXT NOT NULL CHECK (typeof(identity_id) = 'text' AND length(identity_id) BETWEEN 1 AND 256 AND identity_id = trim(identity_id) AND length(trim(identity_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(identity_id, char(0)) = 0),
 source_group_id TEXT NOT NULL CHECK (typeof(source_group_id) = 'text' AND length(source_group_id) BETWEEN 1 AND 256 AND source_group_id = trim(source_group_id) AND length(trim(source_group_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(source_group_id, char(0)) = 0),
 device_id TEXT NOT NULL CHECK (typeof(device_id) = 'text' AND length(device_id) BETWEEN 1 AND 256 AND device_id = trim(device_id) AND length(trim(device_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(device_id, char(0)) = 0),
 public_key TEXT NOT NULL CHECK (typeof(public_key) = 'text' AND length(public_key) BETWEEN 1 AND 4096 AND length(trim(public_key, char(9)||char(10)||char(13)||' ')) > 0 AND instr(public_key, char(0)) = 0),
 fingerprint TEXT NOT NULL CHECK (typeof(fingerprint) = 'text' AND length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*' AND instr(fingerprint, char(0)) = 0),
 key_id TEXT NOT NULL CHECK (typeof(key_id) = 'text' AND length(key_id) = 64 AND key_id NOT GLOB '*[^0-9a-f]*' AND instr(key_id, char(0)) = 0),
 controller_attestation_id TEXT NOT NULL CHECK (typeof(controller_attestation_id) = 'text' AND length(controller_attestation_id) BETWEEN 1 AND 256 AND controller_attestation_id = trim(controller_attestation_id) AND length(trim(controller_attestation_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(controller_attestation_id, char(0)) = 0),
 controller_attestation_revision INTEGER NOT NULL CHECK (typeof(controller_attestation_revision) = 'integer' AND controller_attestation_revision = 1),
 controller_attestation_created_at TEXT NOT NULL CHECK (typeof(controller_attestation_created_at) = 'text' AND length(trim(controller_attestation_created_at, char(9)||char(10)||char(13)||' ')) > 0 AND instr(controller_attestation_created_at, char(0)) = 0),
 review_receipt_id TEXT NOT NULL CHECK (typeof(review_receipt_id) = 'text' AND length(review_receipt_id) BETWEEN 1 AND 256 AND review_receipt_id = trim(review_receipt_id) AND length(trim(review_receipt_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(review_receipt_id, char(0)) = 0),
 evidence_digest TEXT NOT NULL CHECK (typeof(evidence_digest) = 'text' AND length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*' AND instr(evidence_digest, char(0)) = 0),
 enrollment_identity_id TEXT CHECK (enrollment_identity_id IS NULL OR (typeof(enrollment_identity_id) = 'text' AND length(enrollment_identity_id) BETWEEN 1 AND 256 AND enrollment_identity_id = trim(enrollment_identity_id) AND length(trim(enrollment_identity_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(enrollment_identity_id, char(0)) = 0)),
 link_attempt_id TEXT NOT NULL CHECK (typeof(link_attempt_id) = 'text' AND length(link_attempt_id) BETWEEN 1 AND 256 AND link_attempt_id = trim(link_attempt_id) AND length(trim(link_attempt_id, char(9)||char(10)||char(13)||' ')) > 0 AND instr(link_attempt_id, char(0)) = 0),
 link_auth_config_revision TEXT NOT NULL CHECK (typeof(link_auth_config_revision) = 'text' AND length(link_auth_config_revision) = 64 AND link_auth_config_revision NOT GLOB '*[^0-9a-f]*' AND instr(link_auth_config_revision, char(0)) = 0),
 link_created_at_ms INTEGER NOT NULL CHECK (typeof(link_created_at_ms) = 'integer' AND link_created_at_ms BETWEEN 0 AND 9007199254740991),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN link_created_at_ms AND 9007199254740991),
 revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR (typeof(revoked_at_ms) = 'integer' AND revoked_at_ms BETWEEN created_at_ms AND 9007199254740991)),
 UNIQUE (coordinator_id, link_id)
);
`,
	`
-- Each collision probe uses a unique index, never a coordinator-wide OR scan.
-- Reject even same-value UPSERT/REPLACE: revocation must use explicit UPDATE.
CREATE TRIGGER IF NOT EXISTS owner_enrollment_qualification_insert_collision
BEFORE INSERT ON coordinator_owner_enrollment_qualifications
WHEN EXISTS (SELECT 1 FROM coordinator_owner_enrollment_qualifications WHERE rowid = NEW.rowid)
 OR EXISTS (SELECT 1 FROM coordinator_owner_enrollment_qualifications WHERE qualification_id = NEW.qualification_id)
 OR EXISTS (SELECT 1 FROM coordinator_owner_enrollment_qualifications WHERE coordinator_id = NEW.coordinator_id AND link_id = NEW.link_id)
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_qualification_collision'); END;
`,
	`
-- BEFORE INSERT sees an unspecified rowid when it is autogenerated. Reject all
-- nonpositive stored rowids after assignment so none can poison that probe.
CREATE TRIGGER IF NOT EXISTS owner_enrollment_qualification_positive_rowid
AFTER INSERT ON coordinator_owner_enrollment_qualifications
WHEN NEW.rowid <= 0
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_qualification_positive_rowid'); END;
`,
	`
-- Pin rowid as well, preventing UPDATE OR REPLACE from deleting another row.
-- Compare storage classes explicitly, including the nullable enrollment snapshot.
CREATE TRIGGER IF NOT EXISTS owner_enrollment_qualification_immutable_update
BEFORE UPDATE ON coordinator_owner_enrollment_qualifications
WHEN OLD.rowid IS NOT NEW.rowid
 OR OLD.qualification_id IS NOT NEW.qualification_id OR typeof(NEW.qualification_id) <> 'text'
 OR OLD.coordinator_id IS NOT NEW.coordinator_id OR typeof(NEW.coordinator_id) <> 'text'
 OR OLD.link_id IS NOT NEW.link_id OR typeof(NEW.link_id) <> 'text'
 OR OLD.device_claim_id IS NOT NEW.device_claim_id OR typeof(NEW.device_claim_id) <> 'text'
 OR OLD.identity_id IS NOT NEW.identity_id OR typeof(NEW.identity_id) <> 'text'
 OR OLD.source_group_id IS NOT NEW.source_group_id OR typeof(NEW.source_group_id) <> 'text'
 OR OLD.device_id IS NOT NEW.device_id OR typeof(NEW.device_id) <> 'text'
 OR OLD.public_key IS NOT NEW.public_key OR typeof(NEW.public_key) <> 'text'
 OR OLD.fingerprint IS NOT NEW.fingerprint OR typeof(NEW.fingerprint) <> 'text'
 OR OLD.key_id IS NOT NEW.key_id OR typeof(NEW.key_id) <> 'text'
 OR OLD.controller_attestation_id IS NOT NEW.controller_attestation_id OR typeof(NEW.controller_attestation_id) <> 'text'
 OR OLD.controller_attestation_revision IS NOT NEW.controller_attestation_revision OR typeof(NEW.controller_attestation_revision) <> 'integer'
 OR OLD.controller_attestation_created_at IS NOT NEW.controller_attestation_created_at OR typeof(NEW.controller_attestation_created_at) <> 'text'
 OR OLD.review_receipt_id IS NOT NEW.review_receipt_id OR typeof(NEW.review_receipt_id) <> 'text'
 OR OLD.evidence_digest IS NOT NEW.evidence_digest OR typeof(NEW.evidence_digest) <> 'text'
 OR OLD.enrollment_identity_id IS NOT NEW.enrollment_identity_id OR typeof(OLD.enrollment_identity_id) <> typeof(NEW.enrollment_identity_id)
 OR OLD.link_attempt_id IS NOT NEW.link_attempt_id OR typeof(NEW.link_attempt_id) <> 'text'
 OR OLD.link_auth_config_revision IS NOT NEW.link_auth_config_revision OR typeof(NEW.link_auth_config_revision) <> 'text'
 OR OLD.link_created_at_ms IS NOT NEW.link_created_at_ms OR typeof(NEW.link_created_at_ms) <> 'integer'
 OR OLD.created_at_ms IS NOT NEW.created_at_ms OR typeof(NEW.created_at_ms) <> 'integer'
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_qualification_immutable'); END;
`,
	`
CREATE TRIGGER IF NOT EXISTS owner_enrollment_qualification_revocation_update
BEFORE UPDATE ON coordinator_owner_enrollment_qualifications
WHEN (OLD.revoked_at_ms IS NOT NULL AND OLD.revoked_at_ms IS NOT NEW.revoked_at_ms)
 OR (NEW.revoked_at_ms IS NOT NULL AND (typeof(NEW.revoked_at_ms) <> 'integer'
  OR NEW.revoked_at_ms < OLD.created_at_ms OR NEW.revoked_at_ms > 9007199254740991))
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_qualification_revocation_monotonic'); END;
`,
	`
CREATE TRIGGER IF NOT EXISTS owner_enrollment_qualification_immutable_delete
BEFORE DELETE ON coordinator_owner_enrollment_qualifications
BEGIN SELECT RAISE(ABORT, 'owner_enrollment_qualification_immutable'); END;
`,
] as const;

export const COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_SQL =
	COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS.join("\n");
