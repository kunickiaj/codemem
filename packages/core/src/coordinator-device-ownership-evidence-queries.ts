/**
 * Limits and column lists of the ownership evidence categories. The reads themselves are
 * in coordinator-owner-negative-reads.ts.
 */
export const ROW_LIMIT = 500;
export const BYTE_LIMIT = 750_000;

const controllerColumns =
	"attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at,revoked_at";
export const CONTROLLER_COLUMNS = controllerColumns.split(",");
export const RESOLUTION_COLUMNS =
	"coordinator_id,resolution_id,resolution_version,device_id,key_id,owner_identity_id,purpose,scope,source_attestation_id,source_group_id,source_controller_revision,source_public_key,source_fingerprint,source_enrollment_identity_id,source_created_at,source_review_receipt_id,source_evidence_digest,resolution_evidence_digest,reviewed_weak_labels_json,created_at".split(
		",",
	);
