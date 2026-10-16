import type { CoordinatorAuthLinkSigner } from "./coordinator-auth-link-contract.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

interface AssignmentRecord {
	group_id: string;
	candidate_ref: string;
	manifest_version: number;
	completed_at: string;
	manifest_json: string;
}

// The canonical reference scopes one record to this coordinator and group, without fallback.
export const AUTH_LEGACY_ASSIGNMENT_CAPTURE_SQL = `SELECT json_object(
 'group_id', group_id, 'candidate_ref', candidate_ref, 'manifest_version', manifest_version,
 'completed_at', completed_at, 'manifest_json',
 CASE WHEN length(CAST(manifest_json AS BLOB)) <= ? THEN manifest_json ELSE NULL END)
 FROM coordinator_legacy_team_completions WHERE group_id = ? AND candidate_ref = ?`;

/** A capture is not authority: every consumer must recheck it inside its statement. */
export function captureCurrentLegacyAssignment(
	snapshot: string | null | undefined,
	input: {
		coordinatorId: string;
		identityId: string;
		signer: CoordinatorAuthLinkSigner;
		distinctKeys: string[];
	},
): string | null {
	try {
		if (typeof snapshot !== "string") return null;
		const row: AssignmentRecord | null = JSON.parse(snapshot);
		if (!row || typeof row.manifest_json !== "string") return null;
		const manifest = normalizeCoordinatorLegacyTeamCompletionManifest(
			JSON.parse(row.manifest_json),
		);
		if (
			canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest) !== row.manifest_json ||
			row.group_id !== input.signer.groupId ||
			row.candidate_ref !== legacyTeamCandidateId(input.coordinatorId, input.signer.groupId) ||
			row.candidate_ref !== manifest.candidate_ref ||
			row.manifest_version !== manifest.version ||
			row.completed_at !== manifest.completed_at ||
			manifest.coordinator_id !== input.coordinatorId
		)
			return null;
		const assigned = manifest.device_decisions.some(
			(d) =>
				d.device_id === input.signer.deviceId &&
				d.key_fingerprint === input.signer.fingerprint &&
				d.identity_id === input.identityId &&
				d.decision === "included" &&
				d.enabled,
		);
		return assigned ? JSON.stringify({ ...row, distinct_keys: input.distinctKeys }) : null;
	} catch {
		return null;
	}
}

// MATERIALIZED keeps the validated snapshot independent of deeper D1 predicates.
// Exact bytes and row metadata pin normalization to the record used by the writer.
export const AUTH_CURRENT_LEGACY_ASSIGNMENT_CTE = `claim_current_assignment AS MATERIALIZED (
 SELECT c.* FROM claim_input p JOIN coordinator_legacy_team_completions c
 ON c.group_id = p.group_id AND c.group_id = json_extract(p.assignment_snapshot, '$.group_id')
 AND c.candidate_ref = json_extract(p.assignment_snapshot, '$.candidate_ref')
 AND c.manifest_version = json_extract(p.assignment_snapshot, '$.manifest_version')
 AND c.completed_at = json_extract(p.assignment_snapshot, '$.completed_at')
 AND c.manifest_json = json_extract(p.assignment_snapshot, '$.manifest_json')
 WHERE json_extract(json_extract(p.assignment_snapshot, '$.manifest_json'), '$.coordinator_id') = p.coordinator_id
 AND EXISTS (SELECT 1 FROM json_each(json_extract(p.assignment_snapshot, '$.manifest_json'), '$.device_decisions') d
 WHERE json_extract(d.value, '$.device_id') = p.device_id
 AND json_extract(d.value, '$.key_fingerprint') = p.fingerprint
 AND json_extract(d.value, '$.identity_id') = p.identity_id
 AND json_extract(d.value, '$.decision') = 'included' AND json_extract(d.value, '$.enabled') = 1)
 AND EXISTS (SELECT 1 FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
 WHERE e.group_id = p.group_id AND e.device_id = p.device_id AND e.public_key = p.public_key
 AND e.fingerprint = p.fingerprint AND e.enabled = 1 AND g.archived_at IS NULL
 AND (e.identity_id IS NULL OR e.identity_id = p.identity_id))
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind = 'device_id' AND r.subject_value = p.device_id)
 OR (r.subject_kind = 'ed25519_key' AND r.subject_value = p.key_id)))`;

export const AUTH_CURRENT_LEGACY_ASSIGNMENT_SQL = "EXISTS (SELECT 1 FROM claim_current_assignment)";
