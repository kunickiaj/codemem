import type { Database } from "./db.js";

/**
 * Delivery denials written when a reviewed Team setup is quarantined.
 *
 * Quarantine deactivates the Team and revokes its Project recipients, but the
 * recipient policy reconciler and the daemon end each device's coordinator
 * membership later. Until then a device with a matching pin and a retained proof
 * could still be served the Team's scopes from this machine's cache. These rows
 * use the deny overlays every scoped sync check already reads, so the scopes are
 * refused to those devices in the same transaction that quarantines the Team.
 *
 * The rows are recognizable by both their project key and their reason, and
 * nothing else writes either value. The reconciler never lists them, because no
 * Project has that key, so they stay until one of these lifts them:
 *
 * - a reviewed activation of the same Team lifts them for the devices it
 *   includes (`liftTeamSetupQuarantineDenials` with those device IDs);
 * - Team recovery lifts them all (`liftTeamSetupQuarantineDenials` without
 *   device IDs) once it has verified the roster again.
 *
 * A device the next activation leaves out stays denied in these scopes until
 * recovery or a later activation includes it.
 */
export const TEAM_SETUP_QUARANTINE_DENY_REASON = "team_setup_quarantine";

/** The deny overlay project key that marks one Team's quarantine denials. */
export function teamSetupQuarantineDenyKey(teamId: string): string {
	return `team-setup-quarantine:${teamId}`;
}

// The setup's own coordinator group: every member except this device is denied.
const SETUP_GROUP_SCOPES_SQL = `SELECT DISTINCT scope.scope_id FROM replication_scopes AS scope
	JOIN legacy_team_setup_drafts AS draft
	  ON draft.coordinator_id = scope.coordinator_id AND draft.group_id = scope.group_id
	WHERE draft.candidate_id = ? AND draft.completed_team_id = ?
	  AND scope.authority_type = 'coordinator'`;

// Scopes a Team Project was mapped or later remapped to by setup, in any group.
const TEAM_PROJECT_SCOPES_SQL = `SELECT DISTINCT mapping.scope_id FROM project_scope_mappings AS mapping
	JOIN replication_scopes AS scope
	  ON scope.scope_id = mapping.scope_id AND scope.authority_type = 'coordinator'
	WHERE mapping.source = 'reviewed_team_setup' AND EXISTS (
	  SELECT 1 FROM project_recipients AS recipient
	  WHERE recipient.recipient_kind = 'team' AND recipient.recipient_id = ?
	    AND recipient.canonical_project_identity IN (mapping.workspace_identity, mapping.project_pattern)
	)`;

// Devices bound to a Team member in any binding state, or reviewed in its setup.
const TEAM_DEVICES_SQL = `SELECT device.device_id FROM identity_devices AS device
	WHERE device.identity_id IN (SELECT identity_id FROM policy_team_memberships WHERE team_id = ?)
	UNION
	SELECT reviewed.device_id FROM legacy_team_setup_draft_devices AS reviewed
	JOIN legacy_team_setup_drafts AS draft ON draft.attempt_id = reviewed.attempt_id
	WHERE draft.candidate_id = ?`;

function localDeviceId(db: Database): string | null {
	const id = db.prepare("SELECT device_id FROM sync_device LIMIT 1").pluck().get();
	return typeof id === "string" && id.trim() ? id : null;
}

function scopeMembers(db: Database, scopeId: string): string[] {
	return db
		.prepare("SELECT DISTINCT device_id FROM scope_memberships WHERE scope_id = ?")
		.pluck()
		.all(scopeId) as string[];
}

/** The scope and device pairs a quarantine denies, sorted. */
export function teamSetupQuarantineDenials(
	db: Database,
	binding: { candidateRef: string; teamId: string },
): Array<{ scopeId: string; deviceId: string }> {
	const local = localDeviceId(db);
	const setupScopes = new Set(
		db
			.prepare(SETUP_GROUP_SCOPES_SQL)
			.pluck()
			.all(binding.candidateRef, binding.teamId) as string[],
	);
	const projectScopes = db.prepare(TEAM_PROJECT_SCOPES_SQL).pluck().all(binding.teamId) as string[];
	const teamDevices = new Set(
		db.prepare(TEAM_DEVICES_SQL).pluck().all(binding.teamId, binding.candidateRef) as string[],
	);
	const pairs = new Map<string, { scopeId: string; deviceId: string }>();
	for (const scopeId of new Set([...setupScopes, ...projectScopes])) {
		for (const deviceId of scopeMembers(db, scopeId)) {
			if (deviceId === local) continue;
			// Another group's scope keeps its other members; only the Team's devices are denied there.
			if (!setupScopes.has(scopeId) && !teamDevices.has(deviceId)) continue;
			pairs.set(`${scopeId}\u0000${deviceId}`, { scopeId, deviceId });
		}
	}
	return [...pairs.values()].sort(
		(a, b) => a.scopeId.localeCompare(b.scopeId) || a.deviceId.localeCompare(b.deviceId),
	);
}

/** Records the quarantine's denials. Must run inside the quarantine transaction. */
export function denyQuarantinedTeamDelivery(
	db: Database,
	binding: { candidateRef: string; teamId: string; now: string },
): void {
	if (!db.inTransaction) throw new Error("team_setup_quarantine_transaction_required");
	const insert = db.prepare(
		`INSERT INTO recipient_policy_deny_overlays(
		 canonical_project_identity, scope_id, device_id, generation, reason_code, created_at, updated_at
		 ) VALUES (?, ?, ?, 0, ?, ?, ?)
		 ON CONFLICT(canonical_project_identity, scope_id, device_id) DO NOTHING`,
	);
	const key = teamSetupQuarantineDenyKey(binding.teamId);
	for (const { scopeId, deviceId } of teamSetupQuarantineDenials(db, binding)) {
		insert.run(key, scopeId, deviceId, TEAM_SETUP_QUARANTINE_DENY_REASON, binding.now, binding.now);
	}
}

/**
 * Removes this Team's quarantine denials, for the given devices or, without
 * device IDs, all of them. Other deny overlays are never touched.
 * Returns the number of rows removed.
 */
export function liftTeamSetupQuarantineDenials(
	db: Database,
	input: { teamId: string; deviceIds?: Iterable<string> },
): number {
	const key = teamSetupQuarantineDenyKey(input.teamId);
	const deleteRows = db.prepare(
		`DELETE FROM recipient_policy_deny_overlays
		 WHERE canonical_project_identity = ? AND reason_code = ?`,
	);
	if (input.deviceIds === undefined)
		return deleteRows.run(key, TEAM_SETUP_QUARANTINE_DENY_REASON).changes;
	const deleteDevice = db.prepare(
		`DELETE FROM recipient_policy_deny_overlays
		 WHERE canonical_project_identity = ? AND reason_code = ? AND device_id = ?`,
	);
	let removed = 0;
	for (const deviceId of new Set(input.deviceIds)) {
		removed += deleteDevice.run(key, TEAM_SETUP_QUARANTINE_DENY_REASON, deviceId).changes;
	}
	return removed;
}
