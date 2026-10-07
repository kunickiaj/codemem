import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";
import { COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_GROUPS } from "./coordinator-legacy-team-completion.js";

/** Internal transport grants only: these confer no Team/Project access. */
export interface CoordinatorIdentityGroupGrant {
	readonly coordinator_id: string;
	readonly identity_id: string;
	readonly group_id: string;
	readonly status: "active" | "revoked";
	readonly revision: number;
	readonly source_kind: "controller_attestation";
	readonly source_receipt_id: string;
	readonly created_at: string;
	readonly revoked_at: string | null;
}

export interface CoordinatorIdentityGroupGrantIssueInput {
	coordinatorId: string;
	attestationId: string;
}
export interface CoordinatorIdentityGroupGrantScope {
	coordinatorId: string;
	identityId: string;
}
export interface CoordinatorIdentityGroupGrantRevokeInput
	extends CoordinatorIdentityGroupGrantScope {
	groupId: string;
	expectedRevision: number;
}
export type CoordinatorIdentityGroupGrantIssueResult =
	| { kind: "created" | "existing"; grant: CoordinatorIdentityGroupGrant }
	| { kind: "rejected"; error: "invalid_grant_input" | "grant_authority_unavailable" };

/** Future authenticated operators own invocation; no routes or automatic issuance. */
export interface CoordinatorIdentityGroupGrantStore {
	issueIdentityGroupGrantFromControllerAttestation(
		input: CoordinatorIdentityGroupGrantIssueInput,
	): Promise<CoordinatorIdentityGroupGrantIssueResult>;
	listIdentityGroupGrantRevisions(
		input: CoordinatorIdentityGroupGrantScope,
	): Promise<CoordinatorIdentityGroupGrant[]>;
	revokeIdentityGroupGrant(input: CoordinatorIdentityGroupGrantRevokeInput): Promise<boolean>;
}

/** Capture once before async I/O; do not invoke getters or accept inherited IDs. */
export function captureIdentityGroupGrantInput(
	input: unknown,
	fields: readonly string[],
): Record<string, string | number> | null {
	try {
		if (!input || typeof input !== "object" || Array.isArray(input)) return null;
		const captured: Record<string, string | number> = {};
		for (const field of fields) {
			const descriptor = Object.getOwnPropertyDescriptor(input, field);
			if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
			const value: unknown = descriptor.value;
			if (field === "expectedRevision") {
				if (
					typeof value !== "number" ||
					!Number.isSafeInteger(value) ||
					value < 1 ||
					value >= Number.MAX_SAFE_INTEGER
				)
					return null;
			} else if (!isAuthControllerId(value)) return null;
			captured[field] = value as string | number;
		}
		return captured;
	} catch {
		return null;
	}
}

const GRANT_FIELDS = [
	"coordinator_id",
	"identity_id",
	"group_id",
	"status",
	"revision",
	"source_kind",
	"source_receipt_id",
	"created_at",
	"revoked_at",
] as const;

function isCanonicalGrant(row: CoordinatorIdentityGroupGrant): boolean {
	if (!row) return false;
	if (
		![row.coordinator_id, row.identity_id, row.group_id, row.source_receipt_id].every(
			isAuthControllerId,
		)
	)
		return false;
	if (
		row.source_kind !== "controller_attestation" ||
		!Number.isSafeInteger(row.revision) ||
		row.revision < 1
	)
		return false;
	if (typeof row.created_at !== "string" || row.created_at.length === 0) return false;
	if (row.status === "active") return row.revoked_at === null;
	return (
		row.status === "revoked" && typeof row.revoked_at === "string" && row.revoked_at.length > 0
	);
}

function canonicalRevisionSet(
	rows: readonly CoordinatorIdentityGroupGrant[],
): Map<string, CoordinatorIdentityGroupGrant> | null {
	// Reuse the existing coordinator group-set limit; never truncate authority sets.
	if (
		!Array.isArray(rows) ||
		rows.length === 0 ||
		rows.length > COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_GROUPS
	)
		return null;
	const result = new Map<string, CoordinatorIdentityGroupGrant>();
	for (const row of rows) {
		if (!isCanonicalGrant(row)) return null;
		if (
			row.coordinator_id !== rows[0].coordinator_id ||
			row.identity_id !== rows[0].identity_id ||
			result.has(row.group_id)
		)
			return null;
		result.set(row.group_id, row);
	}
	return result;
}

/** Snapshot equality only, NOT authorization for a future enrollment write. */
export function compareIdentityGroupGrantRevisions(
	expected: readonly CoordinatorIdentityGroupGrant[],
	current: readonly CoordinatorIdentityGroupGrant[],
): boolean {
	const left = canonicalRevisionSet(expected);
	const right = canonicalRevisionSet(current);
	if (!left || !right || left.size !== right.size) return false;
	for (const [groupId, row] of left) {
		const other = right.get(groupId);
		if (!other || GRANT_FIELDS.some((field) => row[field] !== other[field])) return false;
	}
	return true;
}

// Independent tombstones: deliberately no enrollment/controller foreign keys.
export const IDENTITY_GROUP_GRANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_identity_group_grants (
 coordinator_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
 revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
 source_kind TEXT NOT NULL CHECK (source_kind = 'controller_attestation'),
 source_receipt_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 revoked_at TEXT,
 PRIMARY KEY (coordinator_id, identity_id, group_id),
 CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);`;

const CURRENT_CONTROLLER_FROM_SQL = `
 FROM coordinator_auth_controller_attestations a
 JOIN enrolled_devices e ON e.group_id = a.group_id AND e.device_id = a.device_id
 JOIN groups g ON g.group_id = a.group_id`;
const CURRENT_CONTROLLER_EVIDENCE_SQL = `
 a.coordinator_id = ? AND a.attestation_id = ? AND a.revoked_at IS NULL
 AND g.archived_at IS NULL AND e.enabled = 1
 AND e.public_key = a.public_key AND e.fingerprint = a.fingerprint
 AND e.identity_id IS a.enrollment_identity_id
 AND (e.identity_id IS NULL OR e.identity_id = a.identity_id)`;

/** Read the actual current enrollment, never caller-provided key metadata. */
export const IDENTITY_GROUP_GRANT_SOURCE_SQL = `
 SELECT e.* ${CURRENT_CONTROLLER_FROM_SQL} WHERE ${CURRENT_CONTROLLER_EVIDENCE_SQL}`;

// Pin the hashed enrollment across D1 awaits; both issuance and retry recheck revocation.
const CURRENT_CONTROLLER_WHERE_SQL = `${CURRENT_CONTROLLER_EVIDENCE_SQL}
 AND e.group_id = ? AND e.device_id = ? AND e.public_key = ?
 AND e.fingerprint = ? AND e.identity_id IS ?
 AND NOT ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL}`;

export const IDENTITY_GROUP_GRANT_INSERT_SQL = `
 INSERT INTO coordinator_identity_group_grants (
 coordinator_id, identity_id, group_id, status, revision, source_kind, source_receipt_id, created_at, revoked_at
 ) SELECT a.coordinator_id, a.identity_id, a.group_id, 'active', 1, 'controller_attestation', a.review_receipt_id, ?, NULL
 ${CURRENT_CONTROLLER_FROM_SQL} WHERE ${CURRENT_CONTROLLER_WHERE_SQL}
 ON CONFLICT (coordinator_id, identity_id, group_id) DO NOTHING
 RETURNING *`;

/** Retry checks the grant and exact current evidence together in ONE read. */
export const IDENTITY_GROUP_GRANT_RETRY_SQL = `
 SELECT r.* ${CURRENT_CONTROLLER_FROM_SQL}
 JOIN coordinator_identity_group_grants r ON r.coordinator_id = a.coordinator_id
 AND r.identity_id = a.identity_id AND r.group_id = a.group_id
 WHERE ${CURRENT_CONTROLLER_WHERE_SQL}
 AND r.status = 'active' AND r.source_kind = 'controller_attestation'
 AND r.source_receipt_id = a.review_receipt_id`;

/** Listing intentionally does not depend on the old controller device/key. */
export const IDENTITY_GROUP_GRANT_LIST_SQL = `
 SELECT * FROM coordinator_identity_group_grants
 WHERE coordinator_id = ? AND identity_id = ? ORDER BY group_id COLLATE BINARY`;
export const IDENTITY_GROUP_GRANT_REVOKE_SQL = `
 UPDATE coordinator_identity_group_grants SET status = 'revoked', revision = revision + 1, revoked_at = ?
 WHERE coordinator_id = ? AND identity_id = ? AND group_id = ? AND status = 'active' AND revision = ?`;
