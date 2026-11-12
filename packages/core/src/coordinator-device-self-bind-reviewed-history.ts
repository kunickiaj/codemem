/**
 * An explicit historical-label resolution removes only the exact included label from
 * the negative history check. It grants no binding authority: the caller still requires
 * matching device reviews, account provenance, fresh browser consent and key proof.
 * The existing negative-owner read set validates resolution metadata and pins its rows.
 * This verdict additionally requires this receipt's entire original source to remain live.
 * Outer aliases c and d are a completion and one device decision from that completion.
 */
export const SELF_BIND_REVIEWED_LABEL_SQL = `EXISTS (
 SELECT 1 FROM coordinator_legacy_owner_resolutions r
 JOIN coordinator_auth_controller_attestations t
 ON t.coordinator_id=r.coordinator_id AND t.attestation_id=r.source_attestation_id
 AND t.identity_id=r.owner_identity_id AND t.group_id=r.source_group_id
 AND t.device_id=r.device_id AND t.public_key=r.source_public_key
 AND t.fingerprint=r.source_fingerprint AND t.review_receipt_id=r.source_review_receipt_id
 AND t.evidence_digest=r.source_evidence_digest
 AND t.enrollment_identity_id IS r.source_enrollment_identity_id
 AND t.revision=r.source_controller_revision AND t.created_at=r.source_created_at
 AND t.revoked_at IS NULL,
 json_each(CASE WHEN json_valid(r.reviewed_weak_labels_json) THEN r.reviewed_weak_labels_json ELSE '[]' END) w
 WHERE r.coordinator_id=? AND r.device_id=? AND r.key_id=? AND r.owner_identity_id=?
 AND r.source_public_key=? AND r.source_fingerprint=?
 AND r.resolution_version=1 AND r.purpose='existing_account_owner'
 AND r.scope='historical_included_owner_labels_only'
 AND json_extract(d.value,'$.decision')='included'
 AND json_extract(d.value,'$.enabled')=1
 AND json_type(d.value,'$.identity_evidence') IS NULL
 AND json_extract(d.value,'$.device_id')=? AND json_extract(d.value,'$.key_fingerprint')=?
 AND json_extract(w.value,'$.kind')='legacy_included_owner_label'
 AND json_extract(w.value,'$.effect')='account_owner_display_only'
 AND json_extract(w.value,'$.group_id')=c.group_id
 AND json_extract(w.value,'$.device_id')=json_extract(d.value,'$.device_id')
 AND json_extract(w.value,'$.label')=json_extract(d.value,'$.identity_id')
 AND json_extract(w.value,'$.evidence_ref')=json_extract(c.manifest_json,'$.source_digest')
)`;
