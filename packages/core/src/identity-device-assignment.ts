import type { Database } from "./db.js";

export type IdentityDeviceAssignmentExpectation =
	| { kind: "absent" }
	| { kind: "existing"; assignmentVersion: number; identityId: string };

export interface IdentityDeviceAssignmentInsertValues {
	displayName: string;
	provenance: string;
	revision: string;
	migrationState: string;
	sourceFingerprint?: string | null;
	idempotencyKey: string;
}

export interface AssignIdentityDeviceInput {
	deviceId: string;
	targetIdentityId: string;
	expectation: IdentityDeviceAssignmentExpectation;
	insert?: IdentityDeviceAssignmentInsertValues;
	now?: string;
}

export interface AssignIdentityDeviceResult {
	assignmentVersion: number;
	changed: boolean;
	invalidatedDecisionCount: number;
	invalidatedTeamCount: number;
}

export type IdentityDeviceAssignmentErrorCode =
	| "team_setup_assignment_changed"
	| "identity_device_assignment_insert_values_required"
	| "identity_device_assignment_transaction_required";

export class IdentityDeviceAssignmentError extends Error {
	readonly code: IdentityDeviceAssignmentErrorCode;

	constructor(code: IdentityDeviceAssignmentErrorCode) {
		super(code);
		this.name = "IdentityDeviceAssignmentError";
		this.code = code;
	}
}

interface AssignmentRow {
	identity_id: string;
	assignment_version: number;
	status: string;
}

function assignmentChanged(): never {
	throw new IdentityDeviceAssignmentError("team_setup_assignment_changed");
}

function isDeviceIdConflict(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
	);
}

function currentAssignment(db: Database, deviceId: string): AssignmentRow | null {
	return (
		(db
			.prepare(
				`SELECT identity_id, assignment_version, status
				 FROM identity_devices
				 WHERE device_id = ?`,
			)
			.get(deviceId) as AssignmentRow | undefined) ?? null
	);
}

function requireExpectedAssignment(
	row: AssignmentRow | null,
	expectation: IdentityDeviceAssignmentExpectation,
): void {
	if (expectation.kind === "absent") {
		if (row) assignmentChanged();
		return;
	}
	if (
		row?.status !== "active" ||
		row.identity_id !== expectation.identityId ||
		row.assignment_version !== expectation.assignmentVersion
	) {
		assignmentChanged();
	}
}

/**
 * Applies one canonical device assignment mutation inside the caller's transaction.
 * Reassignments revoke reviewed-Team inclusion until those Teams are reviewed again.
 */
export function assignIdentityDeviceInTransaction(
	db: Database,
	input: AssignIdentityDeviceInput,
): AssignIdentityDeviceResult {
	if (!db.inTransaction) {
		throw new IdentityDeviceAssignmentError("identity_device_assignment_transaction_required");
	}

	const before = currentAssignment(db, input.deviceId);
	requireExpectedAssignment(before, input.expectation);
	if (before?.status === "active" && before?.identity_id === input.targetIdentityId) {
		return {
			assignmentVersion: before.assignment_version,
			changed: false,
			invalidatedDecisionCount: 0,
			invalidatedTeamCount: 0,
		};
	}

	const now = input.now ?? new Date().toISOString();
	if (!before) {
		const insert = input.insert;
		if (!insert) {
			throw new IdentityDeviceAssignmentError("identity_device_assignment_insert_values_required");
		}
		try {
			db.prepare(
				`INSERT INTO identity_devices(
				 device_id, identity_id, display_name, status, provenance, revision,
				 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
				 ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				input.deviceId,
				input.targetIdentityId,
				insert.displayName,
				insert.provenance,
				insert.revision,
				insert.migrationState,
				insert.sourceFingerprint ?? null,
				insert.idempotencyKey,
				now,
				now,
			);
		} catch (error) {
			if (isDeviceIdConflict(error)) assignmentChanged();
			throw error;
		}
	} else {
		const expectation = input.expectation;
		if (expectation.kind !== "existing") assignmentChanged();
		// A reassignment to a DIFFERENT identity invalidates metadata bound to
		// the former one: an invite-provenance `source_fingerprint` describes
		// the old binding, and leaving it in place makes recipient onboarding
		// reject every later valid invite for the corrected binding as a
		// `device_binding_conflict`. Clearing it marks the binding as reviewed
		// rather than invite-keyed; same-identity CAS refreshes keep it.
		const identityChanged = expectation.identityId !== input.targetIdentityId;
		const updated = db
			.prepare(
				`UPDATE identity_devices
				 SET identity_id = ?, ${identityChanged ? "source_fingerprint = NULL," : ""} updated_at = ?
				 WHERE device_id = ?
				   AND identity_id = ?
				   AND assignment_version = ?
				   AND status = 'active'`,
			)
			.run(
				input.targetIdentityId,
				now,
				input.deviceId,
				expectation.identityId,
				expectation.assignmentVersion,
			);
		if (updated.changes !== 1) assignmentChanged();
	}

	const after = currentAssignment(db, input.deviceId);
	if (after?.status !== "active" || after.identity_id !== input.targetIdentityId) {
		assignmentChanged();
	}

	if (!before) {
		return {
			assignmentVersion: after.assignment_version,
			changed: true,
			invalidatedDecisionCount: 0,
			invalidatedTeamCount: 0,
		};
	}

	const affectedTeams = db
		.prepare(
			`SELECT d.team_id
			 FROM policy_team_device_decisions d
			 JOIN policy_teams t ON t.team_id = d.team_id
			 WHERE d.device_id = ?
			   AND d.decision = 'included'
			   AND t.device_eligibility_mode = 'reviewed_allowlist'`,
		)
		.all(input.deviceId) as Array<{ team_id: string }>;
	const invalidatedDecisions = db
		.prepare(
			`UPDATE policy_team_device_decisions
			 SET decision = 'unresolved', updated_at = ?
			 WHERE device_id = ?
			   AND decision = 'included'
			   AND team_id IN (
			     SELECT team_id FROM policy_teams
			     WHERE device_eligibility_mode = 'reviewed_allowlist'
			   )`,
		)
		.run(now, input.deviceId);

	for (const team of affectedTeams) {
		// Clear the stale completion fingerprint so compatibility diagnostics and
		// older non-terminal migration records fail closed after reassignment.
		db.prepare(
			`UPDATE policy_teams
			 SET source_fingerprint = NULL, updated_at = ?
			 WHERE team_id = ?`,
		).run(now, team.team_id);
	}

	return {
		assignmentVersion: after.assignment_version,
		changed: true,
		invalidatedDecisionCount: invalidatedDecisions.changes,
		invalidatedTeamCount: affectedTeams.length,
	};
}
