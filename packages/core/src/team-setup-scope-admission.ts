import type { Database } from "./db.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import { mappingsHoldProject, readScopeMappings } from "./scope-project-mappings.js";
import { readTeamDeviceEligibility } from "./team-device-eligibility-read.js";
import { teamRecoveryExcludedDeviceIds } from "./team-recovery-exclusions.js";

/**
 * Scope admission for devices tied to a reviewed Team setup, decided from the
 * current state on every check instead of rows written at quarantine.
 *
 * A device is refused a scope when all of these hold now:
 * - the scope holds a Project of a reviewed setup Team: a setup target, a
 *   current mapping of any provenance (an exact one, or a pattern-only one that
 *   matches the Project), or stored memories from that Project;
 * - the device is tied to that Team: bound to a Team member in any binding
 *   state, or reviewed in the Team's setup. This device is never refused;
 * - the Team is quarantined (inactive, needing setup), or it is active and the
 *   device is not eligible for it now.
 *
 * On an active Team, a device with no `included` decision, or one a Team
 * recovery left out, is refused outright. An `included` decision alone does not
 * admit a device either: its person must still be an active member with an
 * active identity, and its binding must be active at the decided version. A
 * device that fails that is refused unless current policy gives it every Team
 * Project the scope holds some other way, such as a direct share. A Project
 * whose Team recipient quarantine revoked and recovery skipped still counts as
 * a Team Project here.
 *
 * Devices with no tie to the Team keep their access, and a Team device keeps
 * scopes that hold none of the Team's Projects. Nothing is stored, so the Team
 * leaving quarantine (a reviewed activation, or Team recovery) is the only
 * lift, and a membership cached after quarantine cannot grant a Team device.
 */

// Reviewed setup Teams in a state where admission applies, with their setup candidate.
const SETUP_TEAMS_SQL = `SELECT team.team_id, team.status,
	(SELECT draft.candidate_id FROM legacy_team_setup_drafts AS draft
	 WHERE draft.completed_team_id = team.team_id LIMIT 1) AS candidate_id
	FROM policy_teams AS team
	WHERE team.provenance = 'reviewed_team_candidate'
	  AND team.device_eligibility_mode = 'reviewed_allowlist'
	  AND (team.status = 'active' OR (team.status = 'inactive' AND team.migration_state = 'needs_setup'))`;

const TEAM_DEVICE_SQL = `SELECT 1 WHERE EXISTS (
	SELECT 1 FROM identity_devices AS device
	JOIN policy_team_memberships AS member ON member.identity_id = device.identity_id
	WHERE device.device_id = ? AND member.team_id = ?
) OR EXISTS (
	SELECT 1 FROM legacy_team_setup_draft_devices AS reviewed
	JOIN legacy_team_setup_drafts AS draft ON draft.attempt_id = reviewed.attempt_id
	WHERE reviewed.device_id = ? AND draft.candidate_id = ?
)`;

const INCLUDED_SQL = `SELECT 1 FROM policy_team_device_decisions
	WHERE team_id = ? AND device_id = ? AND decision = 'included'`;

// The Team's Project identities, from its setup and its recipients. A recipient
// counts while active, or revoked by quarantine, which keeps the setup provenance
// and marks it as needing setup. A Project someone removed from the Team does not.
const TEAM_PROJECTS_SQL = `SELECT canonical_project_identity AS identity FROM project_recipients
	WHERE recipient_kind = 'team' AND recipient_id = ? AND (
	  status = 'active'
	  OR (status = 'revoked' AND provenance = 'reviewed_team_setup' AND migration_state = 'needs_setup')
	)
	UNION
	SELECT project.resolved_project_identity FROM legacy_team_setup_draft_projects AS project
	JOIN legacy_team_setup_drafts AS draft ON draft.attempt_id = project.attempt_id
	WHERE draft.candidate_id = ? AND project.resolved_project_identity IS NOT NULL
	UNION
	SELECT project.source_project_identity FROM legacy_team_setup_draft_projects AS project
	JOIN legacy_team_setup_drafts AS draft ON draft.attempt_id = project.attempt_id
	WHERE draft.candidate_id = ?`;

const SETUP_TARGET_SQL = `SELECT 1 FROM legacy_team_setup_draft_projects AS project
	JOIN legacy_team_setup_drafts AS draft ON draft.attempt_id = project.attempt_id
	WHERE draft.candidate_id = ? AND project.target_scope_id = ? LIMIT 1`;

// The same, for one Project by its resolved or source identity.
const SETUP_TARGET_PROJECT_SQL = `SELECT 1 FROM legacy_team_setup_draft_projects AS project
	JOIN legacy_team_setup_drafts AS draft ON draft.attempt_id = project.attempt_id
	WHERE draft.candidate_id = ? AND project.target_scope_id = ?
	  AND (project.resolved_project_identity = ? OR project.source_project_identity = ?) LIMIT 1`;

// Memories stored in the scope from a session of one of the Projects.
const STORED_SQL = `SELECT 1 FROM memory_items AS memory
	JOIN sessions AS session ON session.id = memory.session_id
	WHERE memory.scope_id = ? AND (
	  TRIM(session.git_remote) IN (SELECT value FROM json_each(?))
	  OR TRIM(session.cwd) IN (SELECT value FROM json_each(?))
	) LIMIT 1`;

interface SetupTeam {
	team_id: string;
	status: string;
	candidate_id: string | null;
}

function hasRow(db: Database, sql: string, ...values: unknown[]): boolean {
	return db.prepare(sql).get(...values) !== undefined;
}

function localDeviceId(db: Database): string | null {
	const id = db.prepare("SELECT device_id FROM sync_device LIMIT 1").pluck().get();
	return typeof id === "string" ? id : null;
}

function isTeamDevice(db: Database, team: SetupTeam, deviceId: string): boolean {
	return hasRow(db, TEAM_DEVICE_SQL, deviceId, team.team_id, deviceId, team.candidate_id ?? "");
}

function teamProjectIdentities(db: Database, team: SetupTeam): string[] {
	const candidate = team.candidate_id ?? "";
	return db.prepare(TEAM_PROJECTS_SQL).pluck().all(team.team_id, candidate, candidate) as string[];
}

/** The Team's Project identities that the scope holds: a setup target, a mapping, or stored memories. */
function teamProjectsInScope(db: Database, team: SetupTeam, scopeId: string): string[] {
	const mappings = readScopeMappings(db, scopeId);
	return teamProjectIdentities(db, team).filter((identity) => {
		if (hasRow(db, SETUP_TARGET_PROJECT_SQL, team.candidate_id ?? "", scopeId, identity, identity))
			return true;
		if (mappingsHoldProject(mappings, [identity])) return true;
		const json = JSON.stringify([identity]);
		return hasRow(db, STORED_SQL, scopeId, json, json);
	});
}

function scopeHoldsTeamProject(db: Database, team: SetupTeam, scopeId: string): boolean {
	if (hasRow(db, SETUP_TARGET_SQL, team.candidate_id ?? "", scopeId)) return true;
	const identities = teamProjectIdentities(db, team);
	if (identities.length === 0) return false;
	if (mappingsHoldProject(readScopeMappings(db, scopeId), identities)) return true;
	const json = JSON.stringify(identities);
	return hasRow(db, STORED_SQL, scopeId, json, json);
}

/** Whether current policy gives the device the Project by any path. */
function policyAuthorizes(db: Database, projectIdentity: string, deviceId: string): boolean {
	const derivation = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, projectIdentity);
	if (derivation.status === "blocked") return false;
	return derivation.devices.some((device) => device.deviceId === deviceId);
}

/**
 * Whether an active Team refuses the scope to one of its devices. The cheap
 * rows are read first: most devices are eligible and never reach the Projects.
 */
function activeTeamRefuses(
	db: Database,
	team: SetupTeam,
	input: { scopeId: string; deviceId: string },
): boolean {
	const { scopeId, deviceId } = input;
	const leftOut = teamRecoveryExcludedDeviceIds(db, team.team_id).has(deviceId);
	if (leftOut || !hasRow(db, INCLUDED_SQL, team.team_id, deviceId))
		return scopeHoldsTeamProject(db, team, scopeId);
	const eligibility = readTeamDeviceEligibility(db, team.team_id);
	if (eligibility?.status === "eligible" && eligibility.eligibleDeviceIds.includes(deviceId))
		return false;
	// Included, but its person or binding no longer makes it a Team device.
	return teamProjectsInScope(db, team, scopeId).some(
		(identity) => !policyAuthorizes(db, identity, deviceId),
	);
}

// Answers are reused until any connection commits or this one writes, so a sync
// pass that checks the same scope for every op reads the tables once. Inside a
// transaction nothing is cached or reused: total_changes() keeps counting writes
// a rollback undoes, so an answer made there could outlive the rolled-back state.
const answerCache = new WeakMap<Database, { version: string; answers: Map<string, boolean> }>();

function storeVersion(db: Database): string {
	// A read-only statement: reads on read-only connections must not call db.pragma.
	const dataVersion = db.prepare("PRAGMA data_version").pluck().get();
	const changes = db.prepare("SELECT total_changes()").pluck().get();
	return `${dataVersion}:${changes}`;
}

/** Whether a reviewed setup Team's state refuses this scope to this device now. */
export function teamSetupRefusesScope(
	db: Database,
	input: { scopeId: string; deviceId: string },
): boolean {
	if (db.inTransaction) return decideTeamSetupRefusal(db, input);
	const version = storeVersion(db);
	let cached = answerCache.get(db);
	if (!cached || cached.version !== version) {
		cached = { version, answers: new Map() };
		answerCache.set(db, cached);
	}
	const key = `${input.scopeId}\u0000${input.deviceId}`;
	const known = cached.answers.get(key);
	if (known !== undefined) return known;
	const answer = decideTeamSetupRefusal(db, input);
	cached.answers.set(key, answer);
	return answer;
}

function decideTeamSetupRefusal(
	db: Database,
	input: { scopeId: string; deviceId: string },
): boolean {
	let teams: SetupTeam[];
	try {
		teams = db.prepare(SETUP_TEAMS_SQL).all() as SetupTeam[];
	} catch (error) {
		// A store without recipient policy tables has no Teams to enforce.
		if (error instanceof Error && /no such table/u.test(error.message)) return false;
		throw error;
	}
	if (teams.length === 0 || input.deviceId === localDeviceId(db)) return false;
	return teams.some((team) => {
		if (!isTeamDevice(db, team, input.deviceId)) return false;
		if (team.status !== "active") return scopeHoldsTeamProject(db, team, input.scopeId);
		return activeTeamRefuses(db, team, input);
	});
}
