import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	ed25519KeyIdForRevocation,
	parseSshEd25519PublicKeyForRevocation,
} from "./coordinator-ed25519-key-id-compat.js";
import { COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_RECORDS } from "./coordinator-legacy-team-completion.js";
import {
	type OwnerAuthorityAttempt as OwnerAttempt,
	ownerEnrollmentConfirmationHash,
	validOwnerEnrollmentReceiptMetadata,
	verifyOwnerEnrollmentCompletion,
} from "./coordinator-owner-enrollment-proof.js";
import {
	prepareNegativeOwnerConsistency,
	withNegativeOwnerWrite,
} from "./coordinator-owner-negative-consistency.js";
import { readOwnerLinkAuthority } from "./owner-enrollment-link-authority.js";
import { matchesAdmissionOwner } from "./owner-enrollment-owner-pin.js";

export {
	type OwnerAttempt,
	verifyOwnerEnrollmentSignature,
} from "./coordinator-owner-enrollment-proof.js";

/** Matches the optional Worker owner-enrollment audit migration. */
export const COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_owner_enrollment_audit_log (
 coordinator_id TEXT NOT NULL, event_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK (action = 'owner_device_enrolled'),
 binding_id TEXT NOT NULL, device_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
 PRIMARY KEY (coordinator_id, event_id), UNIQUE (coordinator_id, attempt_id)
);`;

/** Historical link provenance is equality only: never consult the old controller/device. */
export const OWNER_ACTIVE_LINK_SQL = `EXISTS (SELECT 1 FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = a.coordinator_id AND l.link_id = a.link_id
 AND l.authority_kind = 'controller_attestation' AND l.controller_attestation_id IS NOT NULL AND l.device_claim_id IS NULL
 AND l.issuer = a.issuer AND l.subject = a.account_subject AND l.identity_id = a.identity_id
 AND l.attempt_id = a.link_attempt_id AND l.controller_attestation_id = a.link_controller_attestation_id
 AND l.auth_config_revision = a.link_auth_config_revision AND l.revoked_at_ms IS NULL)`;

// Private SQL expressions only: a is the stored attempt in both callers.
export function ownerExcludedLegacyDecisionSql(
	groupExpression: "r.group_id" | "json_extract(p.value,'$.groupId')",
): string {
	return `EXISTS (SELECT 1 FROM coordinator_legacy_team_completions c, json_each(c.manifest_json,'$.device_decisions') d
 WHERE c.group_id = ${groupExpression} AND json_extract(c.manifest_json,'$.coordinator_id') = a.coordinator_id
 AND json_extract(d.value,'$.decision') = 'excluded'
 AND (json_extract(d.value,'$.device_id') = a.device_id OR json_extract(d.value,'$.key_fingerprint') = a.fingerprint
 OR NOT EXISTS (SELECT 1 FROM enrolled_devices e WHERE e.group_id = c.group_id
    AND e.device_id = json_extract(d.value,'$.device_id') AND e.fingerprint = json_extract(d.value,'$.key_fingerprint'))))`;
}

const LIVE_GRANTS = `json_array_length(a.grant_revisions_json) BETWEEN 1 AND 50
 AND NOT EXISTS (SELECT 1 FROM json_each(a.grant_revisions_json) p
 WHERE NOT EXISTS (SELECT 1 FROM coordinator_identity_group_grants r JOIN groups g ON g.group_id = r.group_id
 WHERE r.coordinator_id = a.coordinator_id AND r.identity_id = a.identity_id
 AND r.group_id = json_extract(p.value,'$.groupId') AND r.revision = json_extract(p.value,'$.revision')
 AND r.status = 'active' AND r.revoked_at IS NULL AND g.archived_at IS NULL)
 OR ${ownerExcludedLegacyDecisionSql("json_extract(p.value,'$.groupId')")})`;

const NO_REVOCATION = `NOT EXISTS (SELECT 1 FROM coordinator_device_revocations
 WHERE (subject_kind = 'device_id' AND subject_value = a.device_id)
 OR (subject_kind = 'ed25519_key' AND subject_value = a.key_id))`;

interface EnrollmentKey {
	groupId: string;
	deviceId: string;
	publicKey: string;
}
async function collisionSnapshot(
	backend: AuthLinkBackend,
	row: OwnerAttempt,
): Promise<string | null> {
	// This bounded scan fails closed above 500 enrollments; it is not an enrollment quota.
	const source = await backend.first<{ rows: string }>({
		sql: `SELECT json_group_array(json_object('groupId',group_id,'deviceId',device_id,'publicKey',public_key)) AS rows FROM
   (SELECT group_id,device_id,public_key FROM enrolled_devices LIMIT ?)`,
		values: [COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_RECORDS + 1],
	});
	if (!source) return null;
	const rows = JSON.parse(source.rows) as EnrollmentKey[];
	if (rows.length > COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_RECORDS) return null;
	for (const existing of rows) {
		if (existing.deviceId === row.device_id) return null;
		const parsed = parseSshEd25519PublicKeyForRevocation(existing.publicKey);
		if (parsed.kind === "malformed_ed25519") return null;
		if ((await ed25519KeyIdForRevocation(existing.publicKey)) === row.key_id) return null;
	}
	return source.rows;
}

// Every stored key must still belong to the scanned set inside the winning SQL update.
// Concurrent unrelated enrollment changes deliberately deny this attempt.
const SAME_KEYS = `(SELECT count(*) FROM enrolled_devices) = json_array_length(?)
 AND NOT EXISTS (SELECT 1 FROM enrolled_devices e WHERE NOT EXISTS (SELECT 1 FROM json_each(?) k
 WHERE e.group_id = json_extract(k.value,'$.groupId') AND e.device_id = json_extract(k.value,'$.deviceId')
 AND e.public_key = json_extract(k.value,'$.publicKey')))`;
const WINNER = `coordinator_id = ? AND attempt_id = ? AND state = 'finalized' AND binding_id = ?`;
function assertWrite(winner: string[], expected: number): AuthLinkStatement {
	// The finalized-row trigger (and invalid-state CHECK) aborts the native batch on a count mismatch.
	return {
		sql: `UPDATE coordinator_owner_enrollment_attempts SET state = 'invalid' WHERE ${WINNER} AND changes() <> ?`,
		values: [...winner, expected],
	};
}

interface OwnerEnrollmentCommitInput {
	backend: AuthLinkBackend;
	row: OwnerAttempt;
	revision: string;
	now: number;
	completionSecret: string;
	signature: string;
}

/** Internal atomic finalization, not a package export or standalone ownership writer.
 * The later ceremony caller must supply trusted current config and a stored confirmed attempt.
 * SQL failures propagate: a failed post-commit read must not claim nothing changed.
 */
export async function commitOwnerEnrollment(input: OwnerEnrollmentCommitInput): Promise<boolean> {
	const { backend, revision, now, completionSecret, signature } = input;
	const a = Object.freeze({ ...input.row });
	const proof = await verifyOwnerEnrollmentCompletion(
		a,
		revision,
		now,
		completionSecret,
		signature,
	);
	if (!proof || !(await matchesAdmissionOwner(a))) return false;
	const { grants } = proof;
	const snapshot = await collisionSnapshot(backend, a);
	if (snapshot === null) return false;
	const consistency = await prepareEnrollmentNegativeConsistency(backend, a);
	if (!consistency) return false;
	const bindingId = globalThis.crypto.randomUUID();
	const eventId = globalThis.crypto.randomUUID();
	const outcome = JSON.stringify({
		kind: "finalized",
		bindingId,
		groups: grants.map((g) => g.groupId),
	});
	const winner = [a.coordinator_id, a.attempt_id, bindingId];
	const authority = await readOwnerLinkAuthority(backend, now, {
		sql: "l.coordinator_id=? AND l.link_id=?",
		values: [a.coordinator_id, a.link_id],
	});
	if (!authority.hasPin && a.owner_qualification_id != null) return false;
	const update = winningUpdate(a, {
		revision,
		now,
		bindingId,
		eventId,
		outcome,
		snapshot,
		...proof,
	});
	// UPDATE FROM keeps the full live-link proof separate from final pins and grants.
	// Both stages still evaluate inside this one winning statement in the atomic batch.
	// Scope the retained attempt before materialization, not just in the final UPDATE.
	update.sql = `${authority.with ? `${authority.with},` : "WITH"} owner_commit_links AS MATERIALIZED (
 SELECT a.coordinator_id,a.attempt_id FROM coordinator_owner_enrollment_attempts a
 WHERE a.coordinator_id=? AND a.attempt_id=? AND ${authority.active}) ${update.sql
		.replace("loopback_redirect = NULL", "loopback_redirect = NULL FROM owner_commit_links p")
		.replace(
			OWNER_ACTIVE_LINK_SQL,
			"p.coordinator_id=a.coordinator_id AND p.attempt_id=a.attempt_id",
		)}`;
	update.values.unshift(...authority.values, a.coordinator_id, a.attempt_id);
	if (authority.hasPin) {
		update.sql += " AND a.owner_qualification_id IS ?";
		update.values.push(a.owner_qualification_id ?? null);
	}
	await backend.batch([
		withEnrollmentNegativeOwner(update, consistency),
		...dependentWrites(winner, now, grants.length, consistency),
	]);
	return readCommittedOwnerEnrollment(backend, winner);
}

/** Join the already materialized negative result rather than adding its SELECT
 * tree beneath the UPDATE's long chain of ordinary pins (native D1 depth 100).
 * These markers belong only to this module's trusted winning UPDATE template.
 */
function withEnrollmentNegativeOwner(
	update: AuthLinkStatement,
	consistency: AuthLinkStatement,
): AuthLinkStatement {
	const checked = withNegativeOwnerWrite(update, consistency);
	const source = "FROM owner_commit_links p";
	const guard = "AND (SELECT matches FROM negative_owner_consistency)";
	if (!checked.sql.includes(source) || !checked.sql.includes(guard))
		throw new Error("owner_enrollment_statement_invalid");
	return {
		sql: checked.sql
			.replace(source, `${source} CROSS JOIN negative_owner_consistency negative`)
			.replace(guard, "AND negative.matches"),
		values: checked.values,
	};
}

async function readCommittedOwnerEnrollment(backend: AuthLinkBackend, winner: string[]) {
	const committed = await backend.first({
		sql: `SELECT 1 FROM coordinator_owner_enrollment_attempts WHERE ${WINNER}`,
		values: winner,
	});
	return committed !== null;
}

function prepareEnrollmentNegativeConsistency(backend: AuthLinkBackend, a: OwnerAttempt) {
	return prepareNegativeOwnerConsistency(backend, {
		coordinatorId: a.coordinator_id,
		ownerIdentityId: a.identity_id ?? "",
		deviceId: a.device_id,
		publicKey: a.public_key,
		fingerprint: a.fingerprint,
	});
}
const WINNING_UPDATE_SQL = `UPDATE coordinator_owner_enrollment_attempts AS a SET state = 'finalized',
 finalized_at_ms = ?, binding_id = ?, audit_event_id = ?, final_outcome_json = ?,
 final_key_proof_hash = ?, loopback_redirect = NULL
 WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.purpose = 'owner_enroll'
 AND a.state = 'confirmed' AND a.created_at_ms <= ? AND a.expires_at_ms > ?
 AND a.auth_config_revision = ? AND a.origin = ? AND a.issuer = ?
 AND a.admission_owner_hash IS ?
 AND a.device_id = ? AND a.public_key = ? AND a.key_id = ? AND a.fingerprint = ?
 AND a.browser_start_hash = ? AND a.browser_transaction_hash = ? AND a.browser_binder_hash = ?
 AND a.account_subject = ? AND a.identity_id = ? AND a.link_id = ?
 AND a.link_attempt_id = ? AND a.link_controller_attestation_id IS ? AND a.link_auth_config_revision = ?
 AND a.grant_revisions_json = ? AND a.confirmation_hash = ? AND a.completion_secret_hash = ?
 AND a.loopback_redirect = ? AND a.created_at_ms = ? AND a.expires_at_ms = ?
 AND ${OWNER_ACTIVE_LINK_SQL} AND ${LIVE_GRANTS} AND ${NO_REVOCATION}
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b WHERE b.device_id = a.device_id OR b.key_id = a.key_id)
 AND ${SAME_KEYS}`;
function winningPins(a: OwnerAttempt): AuthLinkStatement["values"] {
	return [
		a.origin,
		a.issuer,
		a.admission_owner_hash,
		a.device_id,
		a.public_key,
		a.key_id,
		a.fingerprint,
		a.browser_start_hash,
		a.browser_transaction_hash,
		a.browser_binder_hash,
		a.account_subject,
		a.identity_id,
		a.link_id,
		a.link_attempt_id,
		a.link_controller_attestation_id,
		a.link_auth_config_revision,
		a.grant_revisions_json,
		a.confirmation_hash,
	];
}
function winningUpdate(
	a: OwnerAttempt,
	options: {
		revision: string;
		now: number;
		bindingId: string;
		eventId: string;
		outcome: string;
		snapshot: string;
		completionHash: string;
		keyProofHash: string;
	},
): AuthLinkStatement {
	const { revision, now, bindingId, eventId, outcome, snapshot, completionHash, keyProofHash } =
		options;
	return {
		sql: WINNING_UPDATE_SQL,
		values: [
			now,
			bindingId,
			eventId,
			outcome,
			keyProofHash,
			a.coordinator_id,
			a.attempt_id,
			now,
			now,
			revision,
			...winningPins(a),
			completionHash,
			a.loopback_redirect,
			a.created_at_ms,
			a.expires_at_ms,
			snapshot,
			snapshot,
		],
	};
}
function dependentWrites(
	winner: string[],
	now: number,
	grantCount: number,
	consistency: AuthLinkStatement,
): AuthLinkStatement[] {
	const binding: AuthLinkStatement = {
		sql: `INSERT INTO coordinator_device_ownership_bindings
   (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
   SELECT device_id,key_id,identity_id,coordinator_id,binding_id,'owner_enrollment',attempt_id,?
   FROM coordinator_owner_enrollment_attempts WHERE ${WINNER} AND changes() = 1`,
		values: [new Date(now).toISOString(), ...winner],
	};
	const enrollment: AuthLinkStatement = {
		sql: `INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at)
   SELECT r.group_id,a.device_id,a.public_key,a.fingerprint,a.identity_id,1,?
   FROM coordinator_owner_enrollment_attempts a JOIN json_each(a.grant_revisions_json) p
   JOIN coordinator_identity_group_grants r ON r.coordinator_id = a.coordinator_id AND r.identity_id = a.identity_id
   AND r.group_id = json_extract(p.value,'$.groupId') AND r.revision = json_extract(p.value,'$.revision')
   JOIN groups g ON g.group_id = r.group_id
   WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.state = 'finalized' AND a.binding_id = ?
   AND r.status = 'active' AND r.revoked_at IS NULL AND g.archived_at IS NULL`,
		values: [new Date(now).toISOString(), ...winner],
	};
	const audit: AuthLinkStatement = {
		sql: `INSERT INTO coordinator_owner_enrollment_audit_log
   (coordinator_id,event_id,attempt_id,action,binding_id,device_id,created_at_ms)
   SELECT coordinator_id,audit_event_id,attempt_id,'owner_device_enrolled',binding_id,device_id,finalized_at_ms
   FROM coordinator_owner_enrollment_attempts WHERE ${WINNER}`,
		values: winner,
	};
	return [
		withNegativeOwnerWrite(binding, consistency),
		assertWrite(winner, 1),
		enrollment,
		assertWrite(winner, grantCount),
		audit,
		assertWrite(winner, 1),
	];
}

const RECEIPT_SQL = `SELECT 1 FROM coordinator_device_ownership_bindings b
 WHERE b.device_id = ? AND b.key_id = ? AND b.identity_id = ? AND b.coordinator_id = ?
 AND b.binding_id = ? AND b.provenance = 'owner_enrollment' AND b.source_ref = ? AND b.bound_at = ?
 AND EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a
  WHERE a.coordinator_id = b.coordinator_id AND a.attempt_id = b.source_ref AND a.state = 'finalized'
  AND a.binding_id = b.binding_id AND a.device_id = b.device_id AND a.key_id = b.key_id AND a.identity_id = b.identity_id
  AND a.final_outcome_json = ? AND a.finalized_at_ms = ? AND a.audit_event_id = ?
  AND a.grant_revisions_json = ? AND a.public_key = ? AND a.fingerprint = ?
  AND a.purpose = ? AND a.origin = ? AND a.issuer = ? AND a.auth_config_revision = ?
  AND a.admission_owner_hash IS ?
  AND a.account_subject = ? AND a.link_id = ? AND a.link_attempt_id IS ?
  AND a.link_controller_attestation_id IS ? AND a.link_auth_config_revision IS ?
  AND a.browser_start_hash = ? AND a.browser_transaction_hash IS ? AND a.browser_binder_hash IS ?
  AND a.confirmation_hash IS ? AND a.completion_secret_hash IS ? AND a.final_key_proof_hash IS ?
  AND a.created_at_ms = ? AND a.expires_at_ms = ? AND a.loopback_redirect IS ?)
 AND NOT EXISTS (SELECT 1 FROM coordinator_owner_enrollment_audit_log e
  WHERE e.coordinator_id = ? AND (e.attempt_id = ? OR e.event_id = ?) AND
  (e.event_id <> ? OR e.attempt_id <> ? OR e.action <> 'owner_device_enrolled' OR e.binding_id <> ? OR e.device_id <> ? OR e.created_at_ms <> ?))
 AND NOT EXISTS (SELECT 1 FROM enrolled_devices e, json_each(?) g
  WHERE e.group_id = json_extract(g.value,'$.groupId') AND e.device_id = ?
  AND (e.public_key <> ? OR e.fingerprint <> ? OR e.identity_id IS NOT ? OR e.created_at <> ?))`;
function receiptValues(row: OwnerAttempt): AuthLinkStatement["values"] {
	const timestamp = new Date(row.finalized_at_ms as number).toISOString();
	return [
		row.device_id,
		row.key_id,
		row.identity_id,
		row.coordinator_id,
		row.binding_id,
		row.attempt_id,
		timestamp,
		row.final_outcome_json,
		row.finalized_at_ms,
		row.audit_event_id,
		row.grant_revisions_json,
		row.public_key,
		row.fingerprint,
		row.purpose,
		row.origin,
		row.issuer,
		row.auth_config_revision,
		row.admission_owner_hash,
		row.account_subject,
		row.link_id,
		row.link_attempt_id,
		row.link_controller_attestation_id,
		row.link_auth_config_revision,
		row.browser_start_hash,
		row.browser_transaction_hash,
		row.browser_binder_hash,
		row.confirmation_hash,
		row.completion_secret_hash,
		row.final_key_proof_hash,
		row.created_at_ms,
		row.expires_at_ms,
		row.loopback_redirect,
		row.coordinator_id,
		row.attempt_id,
		row.audit_event_id,
		row.audit_event_id,
		row.attempt_id,
		row.binding_id,
		row.device_id,
		row.finalized_at_ms,
		row.grant_revisions_json,
		row.device_id,
		row.public_key,
		row.fingerprint,
		row.identity_id,
		timestamp,
	];
}
/** Prior writes only; missing enrollment/audit rows are never repaired and revocations are never undone. */
export async function readOwnerEnrollmentReceipt(
	backend: AuthLinkBackend,
	row: OwnerAttempt,
): Promise<boolean> {
	const a = Object.freeze({ ...row });
	if (!validOwnerEnrollmentReceiptMetadata(a) || !(await matchesAdmissionOwner(a))) return false;
	if ((await ownerEnrollmentConfirmationHash(a)) !== a.confirmation_hash) return false;
	const authority = await readOwnerLinkAuthority(backend);
	if (!authority.hasPin && a.owner_qualification_id != null) return false;
	let sql = RECEIPT_SQL;
	const values = receiptValues(a);
	if (authority.hasPin) {
		sql += ` AND EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a
 WHERE a.coordinator_id=b.coordinator_id AND a.attempt_id=b.source_ref AND a.owner_qualification_id IS ?)`;
		values.push(a.owner_qualification_id ?? null);
	}
	const found = await backend.first({ sql, values });
	return found !== null;
}
