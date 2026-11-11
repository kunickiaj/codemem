import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES,
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_GROUPS,
	CoordinatorLegacyTeamCompletionConflictError,
	type CoordinatorLegacyTeamCompletionWriteResult,
	legacyDecisionCountsAsOwnerSql,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "./coordinator-legacy-team-completion.js";
import { LEGACY_TEAM_SETUP_MAX_DEVICES } from "./legacy-team-setup-limits.js";

const MAX_KEYS = COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_GROUPS * LEGACY_TEAM_SETUP_MAX_DEVICES;

/** Both the early replay and the post-INSERT winner retain the canonical row. */
export function legacyCompletionWriteResult(
	storedJson: string,
	requestedJson: string,
	status: CoordinatorLegacyTeamCompletionWriteResult["status"],
): CoordinatorLegacyTeamCompletionWriteResult {
	if (storedJson !== requestedJson) throw new CoordinatorLegacyTeamCompletionConflictError();
	return {
		status,
		manifest: normalizeCoordinatorLegacyTeamCompletionManifest(JSON.parse(storedJson)),
	};
}

const completionJson = `CASE WHEN json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END`;

/** Only requesters and ownership-bearing evidence need canonical-key inference.
 * Keep discovery and the winning statement on the same sources: an ownerless
 * enrollment becomes relevant if it acquires an owner or an included completion.
 * Ledger bindings already carry canonical key IDs and need no text classification.
 */
const ownerSourceKeysSql = `legacy_owner_source_keys AS NOT MATERIALIZED (
 SELECT e.public_key FROM legacy_owner_input p,
 json_each(p.manifest, '$.device_decisions') d
 JOIN enrolled_devices e ON e.group_id = p.group_id
 AND e.device_id = json_extract(d.value, '$.device_id')
 AND e.fingerprint = json_extract(d.value, '$.key_fingerprint') AND e.enabled = 1
 WHERE json_extract(d.value, '$.decision') = 'included'
 UNION
 SELECT public_key FROM enrolled_devices WHERE identity_id IS NOT NULL
 UNION
 SELECT e.public_key FROM coordinator_legacy_team_completions c,
 json_each(${completionJson}, '$.device_decisions') d, legacy_owner_input p
 JOIN enrolled_devices e ON e.group_id = c.group_id
 AND e.device_id = json_extract(d.value, '$.device_id')
 AND e.fingerprint = json_extract(d.value, '$.key_fingerprint')
 WHERE json_extract(${completionJson}, '$.coordinator_id') = json_extract(p.manifest, '$.coordinator_id')
 AND (json_extract(d.value, '$.decision') = 'included' AND ${legacyDecisionCountsAsOwnerSql("d.value")})
)`;

/** Bind canonical manifest JSON, then target group. */
export const LEGACY_OWNER_KEYS_SQL = `WITH legacy_owner_input(manifest, group_id) AS (
 VALUES (?, ?)
), ${ownerSourceKeysSql}
 SELECT public_key FROM legacy_owner_source_keys
 WHERE EXISTS (SELECT 1 FROM legacy_owner_input p, json_each(p.manifest, '$.device_decisions')
 WHERE json_extract(value, '$.decision') = 'included')
 ORDER BY public_key LIMIT ${MAX_KEYS + 1}`;

/** Classify server-held text aliases, never a fingerprint supplied as ownership proof.
 * Invalid unrelated keys supply no key inference; included requesters must have a
 * verified current key in the winning statement. No database I/O occurs here.
 */
export async function legacyOwnerKeyMetadata(
	rows: readonly { public_key: string }[],
): Promise<string> {
	if (rows.length > MAX_KEYS) throw new Error("completion_manifest_unavailable");
	const encoder = new TextEncoder();
	if (
		encoder.encode(JSON.stringify(rows)).byteLength > COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES
	)
		throw new Error("completion_manifest_unavailable");
	const metadata = [];
	for (const { public_key } of rows) {
		const keyId = await ed25519KeyIdForRevocation(public_key);
		let fingerprint: string | null = null;
		if (keyId) {
			const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(public_key));
			fingerprint = Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
		}
		metadata.push({ public_key, key_id: keyId, fingerprint });
	}
	const json = JSON.stringify(metadata);
	if (encoder.encode(json).byteLength > COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES)
		throw new Error("completion_manifest_unavailable");
	return json;
}

/** Bind canonical manifest JSON, target group, then server-derived key metadata.
 * Ownership-bearing enrollments are re-read at INSERT time. Reject newly relevant
 * text keys rather than letting an unclassified alias evade a canonical-key comparison.
 * Materialize the size-limited key metadata and requested rows so correlated
 * owner checks reuse them instead of repeatedly expanding their JSON inputs.
 * Join requested enrollments directly by group/device; a left-joined enrollment
 * CTE can materialize all groups sharing a key even with NOT MATERIALIZED.
 */
export const LEGACY_OWNER_INPUT_SQL = `WITH legacy_owner_input(manifest, group_id, keys) AS (
 VALUES (?, ?, ?)
 ), ${ownerSourceKeysSql}, legacy_owner_keys AS MATERIALIZED (
 SELECT json_extract(value, '$.public_key') AS public_key,
 json_extract(value, '$.key_id') AS key_id,
 json_extract(value, '$.fingerprint') AS fingerprint
 FROM legacy_owner_input p, json_each(p.keys)
), legacy_owner_enrollments AS NOT MATERIALIZED (
 SELECT e.*, k.key_id FROM enrolled_devices e JOIN legacy_owner_keys k
 ON k.public_key = e.public_key AND k.fingerprint = e.fingerprint AND k.key_id IS NOT NULL
), legacy_owner_requested AS MATERIALIZED (
 SELECT json_extract(d.value, '$.device_id') AS device_id,
 json_extract(d.value, '$.key_fingerprint') AS fingerprint,
  json_extract(d.value, '$.identity_id') AS identity_id, k.key_id
 FROM legacy_owner_input p, json_each(p.manifest, '$.device_decisions') d
  LEFT JOIN enrolled_devices e ON e.group_id = p.group_id
 AND e.device_id = json_extract(d.value, '$.device_id')
  AND e.fingerprint = json_extract(d.value, '$.key_fingerprint') AND e.enabled = 1
  LEFT JOIN legacy_owner_keys k ON k.public_key = e.public_key
  AND k.fingerprint = e.fingerprint AND k.key_id IS NOT NULL
 WHERE json_extract(d.value, '$.decision') = 'included'
)`;

// Missing/changed enrollment evidence is unavailable, not an inferred owner clash.
export const LEGACY_OWNER_SOURCE_CURRENT_SQL = `(NOT EXISTS (SELECT 1 FROM legacy_owner_requested)
 OR (NOT EXISTS (
 SELECT public_key FROM legacy_owner_source_keys EXCEPT SELECT public_key FROM legacy_owner_keys
) AND NOT EXISTS (SELECT 1 FROM legacy_owner_requested WHERE key_id IS NULL)))`;

/** Only included owner assignments compete. Labels, exclusions, and other people
 * never supply ownership. A stored label (another device's guess) never blocks a
 * later upload. Requested rows are all checked, labels included, so a new guess
 * still cannot contradict recorded ownership. Old fingerprints need a verified current enrollment
 * for the historical group/device; the exact device ID needs no key inference.
 * This predicate belongs in the winning INSERT, not just a preview/read check.
 */
export const LEGACY_OWNER_COMPATIBLE_SQL = `NOT EXISTS (
 SELECT 1 FROM legacy_owner_requested r WHERE
 EXISTS (SELECT 1 FROM legacy_owner_requested other
 WHERE other.key_id = r.key_id AND other.identity_id <> r.identity_id)
 OR EXISTS (SELECT 1 FROM enrolled_devices e
 WHERE e.identity_id IS NOT NULL AND e.identity_id <> r.identity_id
 AND (e.device_id = r.device_id OR EXISTS (
 SELECT 1 FROM legacy_owner_enrollments verified
 WHERE verified.group_id = e.group_id AND verified.device_id = e.device_id
 AND verified.key_id = r.key_id)))
 OR EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b
 WHERE (b.device_id = r.device_id OR b.key_id = r.key_id) AND b.identity_id <> r.identity_id)
 OR EXISTS (SELECT 1 FROM coordinator_legacy_team_completions c,
 json_each(${completionJson}, '$.device_decisions') d, legacy_owner_input p
 WHERE json_extract(${completionJson}, '$.coordinator_id') = json_extract(p.manifest, '$.coordinator_id')
 AND (json_extract(d.value, '$.decision') = 'included' AND ${legacyDecisionCountsAsOwnerSql("d.value", "deny")})
 AND json_extract(d.value, '$.identity_id') <> r.identity_id
 AND (json_extract(d.value, '$.device_id') = r.device_id OR EXISTS (
 SELECT 1 FROM legacy_owner_enrollments e WHERE e.group_id = c.group_id
 AND e.device_id = json_extract(d.value, '$.device_id')
 AND e.fingerprint = json_extract(d.value, '$.key_fingerprint') AND e.key_id = r.key_id)))
)`;

/** Used only to explain a refused INSERT; this cannot authorize a write. */
export const LEGACY_OWNER_DENIAL_SQL = `${LEGACY_OWNER_INPUT_SQL}
 SELECT CASE WHEN NOT ${LEGACY_OWNER_SOURCE_CURRENT_SQL} THEN 'completion_manifest_unavailable'
 WHEN NOT (${LEGACY_OWNER_COMPATIBLE_SQL}) THEN 'completion_conflict'
 ELSE 'completion_manifest_unavailable' END AS denial`;

/**
 * The winning completion INSERT. Every ordinary completion check and both owner checks
 * run in it, so they decide at write time; the capture's guards lead its batch. `proof`
 * starts with the three LEGACY_OWNER_INPUT_SQL values.
 */
export function legacyCompletionInsertStatement(input: {
	proof: {
		ctes: string;
		currentSql: string;
		compatibleSql: string;
		values: readonly (string | number | null)[];
	};
	groupId: string;
	manifest: { candidate_ref: string; version: number; completed_at: string };
	manifestJson: string;
	coordinatorId: string | null;
	createdAt: string;
}): AuthLinkStatement {
	const { proof, groupId, manifest, manifestJson } = input;
	return {
		sql: `${LEGACY_OWNER_INPUT_SQL}${proof.ctes}
 INSERT OR IGNORE INTO coordinator_legacy_team_completions(
 group_id, candidate_ref, manifest_version, manifest_json, completed_at, created_at
 ) SELECT ?, ?, ?, ?, ?, ?
 FROM groups
 WHERE group_id = ? AND archived_at IS NULL
 AND NOT EXISTS (
 SELECT 1
 FROM json_each(?, '$.project_mappings') AS requested
 LEFT JOIN coordinator_scopes AS scope
 ON scope.scope_id = json_extract(requested.value, '$.scope_id')
 AND scope.authority_type = 'coordinator'
 AND scope.coordinator_id = ?
 AND scope.group_id = ?
 AND scope.status = 'active'
 WHERE scope.scope_id IS NULL
 )
 AND NOT EXISTS (
 SELECT 1 FROM enrolled_devices AS enrolled
 WHERE enrolled.group_id = ?
 AND NOT EXISTS (
 SELECT 1 FROM json_each(?, '$.device_decisions') AS requested
 WHERE json_extract(requested.value, '$.device_id') = enrolled.device_id
 AND json_extract(requested.value, '$.key_fingerprint') = enrolled.fingerprint
 AND json_extract(requested.value, '$.enabled') = enrolled.enabled
 )
 )
 AND NOT EXISTS (
 SELECT 1 FROM json_each(?, '$.device_decisions') AS requested
 WHERE json_extract(requested.value, '$.decision') = 'included'
 AND NOT EXISTS (
 SELECT 1 FROM enrolled_devices AS enrolled
 WHERE enrolled.group_id = ?
 AND enrolled.device_id = json_extract(requested.value, '$.device_id')
 AND enrolled.fingerprint = json_extract(requested.value, '$.key_fingerprint')
 AND enrolled.enabled = 1
 )
 ) AND ${LEGACY_OWNER_SOURCE_CURRENT_SQL}
 AND (${proof.currentSql}) AND (${proof.compatibleSql})`,
		values: [
			...proof.values,
			groupId,
			manifest.candidate_ref,
			manifest.version,
			manifestJson,
			manifest.completed_at,
			input.createdAt,
			groupId,
			manifestJson,
			input.coordinatorId,
			groupId,
			groupId,
			manifestJson,
			manifestJson,
			groupId,
		],
	};
}
