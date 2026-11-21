import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { REJOIN_EVIDENCE_SELECT_SQL } from "./coordinator-device-rejoin-start-evidence.js";
import { ownerExcludedLegacyDecisionSql } from "./coordinator-owner-enrollment-commit.js";

const DESTINATION_SNAPSHOT_SQL = `WITH attempt AS MATERIALIZED (
 SELECT * FROM coordinator_device_rejoin_attempts WHERE coordinator_id = ? AND attempt_id = ?
), input AS (SELECT device_id, key_id, coordinator_id FROM attempt),
evidence AS MATERIALIZED (${REJOIN_EVIDENCE_SELECT_SQL}),
checked AS (
 SELECT a.* FROM attempt a CROSS JOIN evidence e
 WHERE e.binding_id = a.binding_id AND e.identity_id = a.identity_id
 AND e.own_tombstones_json = a.own_tombstones_json
 AND e.alias_removal_seqs_json = a.alias_removal_seqs_json
 AND json_array_length(e.own_tombstones_json) > 0
), groups_with_reasons AS (
 SELECT t.group_id, r.revision, CASE
  WHEN g.group_id IS NULL THEN 'missing_group'
  WHEN g.archived_at IS NOT NULL THEN 'archived'
  WHEN r.group_id IS NOT NULL AND (r.status <> 'active' OR r.revoked_at IS NOT NULL) THEN 'grant_revoked'
  WHEN ${ownerExcludedLegacyDecisionSql("t.group_id")} THEN 'excluded'
  WHEN r.group_id IS NULL AND t.identity_id IS NOT a.identity_id THEN 'identity_changed'
 END AS reason
 FROM checked a
 JOIN json_each(a.own_tombstones_json) p
 JOIN coordinator_device_removals t ON t.removal_seq = json_extract(p.value, '$[0]')
 LEFT JOIN groups g ON g.group_id = t.group_id
 LEFT JOIN coordinator_identity_group_grants r ON r.coordinator_id = a.coordinator_id
  AND r.identity_id = a.identity_id AND r.group_id = t.group_id
)
SELECT (SELECT json_group_array(json_array(group_id, revision, reason))
 FROM (SELECT * FROM groups_with_reasons ORDER BY group_id COLLATE BINARY)) AS groups_json
FROM checked`;

type NonDestinationReason = "archived" | "grant_revoked" | "excluded" | "identity_changed";

export interface DeviceRejoinDestinations {
	destinations: { groupId: string; grantRevision: number | null }[];
	nonDestinations: { groupId: string; reason: NonDestinationReason }[];
}

function isNonDestinationReason(value: unknown): value is NonDestinationReason {
	return (
		value === "archived" ||
		value === "grant_revoked" ||
		value === "excluded" ||
		value === "identity_changed"
	);
}

function readGroups(encoded: string): DeviceRejoinDestinations | null {
	const groups: unknown = JSON.parse(encoded);
	if (!Array.isArray(groups) || groups.length === 0) return null;
	const result: DeviceRejoinDestinations = { destinations: [], nonDestinations: [] };
	for (const entry of groups) {
		if (!Array.isArray(entry) || entry.length !== 3) return null;
		const [groupId, grantRevision, reason] = entry;
		if (typeof groupId !== "string") return null;
		if (isNonDestinationReason(reason)) {
			result.nonDestinations.push({ groupId, reason });
			continue;
		}
		if (
			reason !== null ||
			(grantRevision !== null &&
				(typeof grantRevision !== "number" ||
					!Number.isSafeInteger(grantRevision) ||
					grantRevision < 1))
		)
			return null;
		result.destinations.push({ groupId, grantRevision });
	}
	return result;
}

/**
 * Reads current destinations for a trusted internal attempt reference. Null means
 * the evidence is missing or no longer matches. An empty destinations list can
 * still explain why groups were refused. This read does not authorize a write.
 */
export async function readDeviceRejoinDestinations(
	backend: Pick<AuthLinkBackend, "first">,
	attempt: { coordinatorId: string; attemptId: string },
): Promise<DeviceRejoinDestinations | null> {
	const row = await backend.first<{ groups_json: string }>({
		sql: DESTINATION_SNAPSHOT_SQL,
		values: [attempt.coordinatorId, attempt.attemptId],
	});
	return row ? readGroups(row.groups_json) : null;
}
