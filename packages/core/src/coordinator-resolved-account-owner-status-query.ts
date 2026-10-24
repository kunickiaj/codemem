import { connectionProfileColumns } from "./coordinator-account-connection-session.js";
import { CONNECTION_NOT_REVOKED_SQL } from "./coordinator-account-connection-storage.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { RESOLUTION_COLUMNS } from "./coordinator-device-ownership-evidence-queries.js";
import type { LegacyOwnerResolutionRecord } from "./coordinator-legacy-owner-resolution-metadata.js";

export interface ResolvedOwnerProfileRow {
	link_count: number;
	link_id: string | null;
	not_revoked: number | null;
	valid_link: string | null;
	display_name: unknown;
	email: unknown;
	email_verified: unknown;
	picture_url: unknown;
}

/** All thirteen original fields belong to the same source, including SQL NULLs. */
const sourceMatch = `c.attestation_id=r.source_attestation_id
 AND c.coordinator_id=r.coordinator_id AND c.identity_id=r.owner_identity_id
 AND c.group_id=r.source_group_id AND c.device_id=r.device_id
 AND c.public_key=r.source_public_key AND c.fingerprint=r.source_fingerprint
 AND c.review_receipt_id=r.source_review_receipt_id AND c.evidence_digest=r.source_evidence_digest
 AND c.enrollment_identity_id IS r.source_enrollment_identity_id
 AND c.revision=r.source_controller_revision AND c.created_at=r.source_created_at
 AND c.revoked_at IS NULL`;

export function resolvedOwnerProfileQuery(options: {
	signer: CoordinatorAuthLinkSigner;
	config: CoordinatorAuthLinkConfig;
	resolution: LegacyOwnerResolutionRecord;
	keyId: string;
	recheck: AuthLinkStatement;
}): AuthLinkStatement {
	const { signer, config, resolution, keyId, recheck } = options;
	return {
		sql: `WITH resolved_input AS MATERIALIZED (SELECT ? AS coordinator_id,? AS owner_id,
 ? AS group_id,? AS device_id,? AS public_key,? AS fingerprint,? AS key_id,? AS issuer,? AS fact),
 resolved_evidence AS MATERIALIZED (${recheck.sql}),
 resolved_fact AS MATERIALIZED (
 SELECT r.resolution_id FROM resolved_input i
 JOIN coordinator_legacy_owner_resolutions r ON r.coordinator_id=i.coordinator_id
 AND r.device_id=i.device_id AND r.key_id=i.key_id AND r.owner_identity_id=i.owner_id
 JOIN coordinator_auth_controller_attestations c ON ${sourceMatch}
 WHERE ${RESOLUTION_COLUMNS.map((field) => `r.${field} IS json_extract(i.fact,'$.${field}')`).join(" AND ")}),
 resolved_requester AS MATERIALIZED (
 SELECT 1 AS present FROM resolved_input i JOIN enrolled_devices e
 ON e.group_id=i.group_id AND e.device_id=i.device_id
 JOIN groups g ON g.group_id=e.group_id
 WHERE e.public_key=i.public_key AND e.fingerprint=i.fingerprint AND e.enabled=1
 AND g.archived_at IS NULL AND NOT EXISTS (
 SELECT 1 FROM coordinator_device_revocations v
 WHERE (v.subject_kind='device_id' AND v.subject_value=i.device_id)
 OR (v.subject_kind='ed25519_key' AND v.subject_value=i.key_id))),
 resolved_links AS MATERIALIZED (
 SELECT l.*,CASE WHEN ${CONNECTION_NOT_REVOKED_SQL} THEN 1 ELSE 0 END AS not_revoked
 FROM coordinator_auth_account_links l JOIN resolved_input i
 ON l.coordinator_id=i.coordinator_id AND l.identity_id=i.owner_id LIMIT 2),
 resolved_valid_links AS MATERIALIZED (
 SELECT l.* FROM resolved_links l JOIN resolved_input i ON l.issuer=i.issuer
 WHERE ${authAccountLinkProvenanceSql("l", { connections: true })}),
 resolved_profiles AS MATERIALIZED (
 SELECT l.link_id,${connectionProfileColumns("p")}
 FROM resolved_valid_links l LEFT JOIN coordinator_auth_account_profiles p
 ON p.coordinator_id=l.coordinator_id AND p.link_id=l.link_id
 LEFT JOIN coordinator_auth_link_profiles b ON b.coordinator_id=l.coordinator_id
 AND b.link_id=l.link_id AND b.attempt_id=l.attempt_id AND b.issuer=l.issuer
 AND b.subject=l.subject AND b.auth_config_revision=l.auth_config_revision
 WHERE l.not_revoked=1)
 SELECT (SELECT count(*) FROM resolved_links) AS link_count,l.link_id,l.not_revoked,
 v.link_id AS valid_link,p.display_name,p.email,p.email_verified,p.picture_url
 FROM resolved_fact f JOIN resolved_evidence evidence ON evidence.matches=1
 JOIN resolved_requester requester ON requester.present=1
 LEFT JOIN resolved_links l ON 1
 LEFT JOIN resolved_valid_links v ON v.link_id=l.link_id
 LEFT JOIN resolved_profiles p ON p.link_id=v.link_id LIMIT 1`,
		values: [
			config.coordinatorId,
			resolution.owner_identity_id,
			signer.groupId,
			signer.deviceId,
			signer.publicKey,
			signer.fingerprint,
			keyId,
			config.issuer,
			JSON.stringify(resolution),
			...recheck.values,
		],
	};
}
