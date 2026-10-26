import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	decodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import {
	type DeviceRebindAttempt,
	verifyDeviceRebindCompletion,
} from "./coordinator-device-rebind-proof.js";
import {
	ed25519KeyIdForRevocation,
	parseSshEd25519PublicKeyForRevocation,
} from "./coordinator-ed25519-key-id-compat.js";

/** Finalized rebinds allowed per target Identity in any 24 hours (ADR 0005 Section 8). */
export const DEVICE_REBIND_DAILY_LIMIT = 3;
const DAY_MS = 86_400_000;

export type DeviceRebindReceipt = {
	kind: "finalized";
	attemptId: string;
	bindingId: string;
	deviceId: string;
	previousIdentityId: string;
	targetIdentityId: string;
	enrollmentCount: number;
	finalizedAtMs: number;
};

export type DeviceRebindCommitResult =
	| { kind: "committed"; receipt: DeviceRebindReceipt }
	| { kind: "prior_commit"; receipt: DeviceRebindReceipt }
	| { kind: "refused" };

const ATTEMPT = "coordinator_device_rebind_attempts";

/** A guard predicate on the live attempt `a`, with its own bound values. */
interface Guard {
	sql: string;
	values: readonly (string | number | null)[];
}

// Enrollment and attestation reads are bounded; above this the commit refuses.
const MAX_SCANNED_ROWS = 500;

/**
 * Text forms of one SSH key differ (comments, whitespace), so the same key can
 * hide under another public_key and fingerprint. This scan finds every
 * enrollment and attestation whose canonical key is the device's key. It
 * refuses when one belongs to another device or names another Identity, and
 * returns the exact row set so the commit can pin it.
 */
async function keyAliasScan(
	backend: AuthLinkBackend,
	a: DeviceRebindAttempt,
): Promise<{ enrollments: string; attestations: string } | null> {
	const enrollments = await backend.first<{ rows: string }>({
		sql: `SELECT json_group_array(json_object('groupId', group_id, 'deviceId', device_id,
 'publicKey', public_key, 'identityId', identity_id)) AS rows
 FROM (SELECT group_id, device_id, public_key, identity_id FROM enrolled_devices LIMIT ?)`,
		values: [MAX_SCANNED_ROWS + 1],
	});
	const attestations = await backend.first<{ rows: string }>({
		sql: `SELECT json_group_array(json_object('coordinatorId', coordinator_id,
 'attestationId', attestation_id, 'deviceId', device_id, 'publicKey', public_key,
 'identityId', identity_id)) AS rows
 FROM (SELECT coordinator_id, attestation_id, device_id, public_key, identity_id
 FROM coordinator_auth_controller_attestations WHERE revoked_at IS NULL LIMIT ?)`,
		values: [MAX_SCANNED_ROWS + 1],
	});
	if (!enrollments || !attestations) return null;
	const enrolled = JSON.parse(enrollments.rows) as KeyRow[];
	const attested = JSON.parse(attestations.rows) as KeyRow[];
	if (enrolled.length > MAX_SCANNED_ROWS || attested.length > MAX_SCANNED_ROWS) return null;
	if (!(await enrollmentsUseOnlyThisDevice(enrolled, a))) return null;
	if (!(await attestationsAgree(attested, a))) return null;
	return { enrollments: enrollments.rows, attestations: attestations.rows };
}

interface KeyRow {
	deviceId: string;
	publicKey: string;
	identityId: string | null;
}

/** Only this device's enrollments may use its key, and only in its exact text. */
async function enrollmentsUseOnlyThisDevice(
	rows: readonly KeyRow[],
	a: DeviceRebindAttempt,
): Promise<boolean> {
	for (const row of rows) {
		const sameKey = await sameCanonicalKey(row.publicKey, a.key_id);
		if (sameKey === null) return false;
		const thisDevice = row.deviceId === a.device_id;
		if (sameKey !== thisDevice || (sameKey && row.publicKey !== a.public_key)) return false;
	}
	return true;
}

/** No active attestation of this device or its key names any Identity but the target. */
async function attestationsAgree(
	rows: readonly KeyRow[],
	a: DeviceRebindAttempt,
): Promise<boolean> {
	for (const row of rows) {
		const sameKey = await sameCanonicalKey(row.publicKey, a.key_id);
		if (sameKey === null) return false;
		if ((sameKey || row.deviceId === a.device_id) && row.identityId !== a.target_identity_id)
			return false;
	}
	return true;
}

/** True or false for a parsable key; null (refuse) for a malformed Ed25519 key. */
async function sameCanonicalKey(publicKey: string, keyId: string): Promise<boolean | null> {
	if (parseSshEd25519PublicKeyForRevocation(publicKey).kind === "malformed_ed25519") return null;
	return (await ed25519KeyIdForRevocation(publicKey)) === keyId;
}

function guards(
	a: DeviceRebindAttempt,
	now: number,
	revision: string,
	scan: { enrollments: string; attestations: string },
): Guard[] {
	return [
		{
			sql: `a.state = 'confirmed' AND a.expires_at_ms > ? AND a.auth_config_revision = ?
 AND a.confirmation_hash = ? AND a.completion_secret_hash = ?`,
			values: [now, revision, a.confirmation_hash, a.completion_secret_hash],
		},
		{
			sql: `EXISTS (SELECT 1 FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = a.coordinator_id AND l.link_id = a.link_id
 AND l.identity_id = a.target_identity_id AND l.issuer = a.issuer AND l.subject = a.account_subject
 AND l.authority_kind = a.link_authority_kind AND l.revoked_at_ms IS NULL)`,
			values: [],
		},
		// Accounts are never merged: the current Identity must have no active link.
		{
			sql: `NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = a.coordinator_id AND l.identity_id = a.current_identity_id
 AND l.revoked_at_ms IS NULL)`,
			values: [],
		},
		// Bindings are immutable, so a device is bound at most once.
		{
			sql: `NOT EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b
 WHERE b.device_id = a.device_id OR b.key_id = a.key_id)`,
			values: [],
		},
		{
			sql: `NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind = 'device_id' AND r.subject_value = a.device_id)
 OR (r.subject_kind = 'ed25519_key' AND r.subject_value = a.key_id))`,
			values: [],
		},
		// This device's enrollments: exactly the confirmed count, this key, and no
		// third Identity. Rows already naming the target are left as they are.
		{
			sql: `(SELECT count(*) FROM enrolled_devices e WHERE e.device_id = a.device_id) = a.enrollment_count
 AND NOT EXISTS (SELECT 1 FROM enrolled_devices e WHERE e.device_id = a.device_id
 AND (e.public_key <> a.public_key OR e.fingerprint <> a.fingerprint
 OR (e.identity_id IS NOT NULL AND e.identity_id NOT IN (a.current_identity_id, a.target_identity_id))))`,
			values: [],
		},
		// The key-alias scan above still describes every enrollment and active
		// attestation, field for field: rows may be edited in place, not just added.
		{
			sql: `(SELECT count(*) FROM enrolled_devices) = json_array_length(?)
 AND NOT EXISTS (SELECT 1 FROM enrolled_devices e WHERE NOT EXISTS (SELECT 1 FROM json_each(?) k
 WHERE e.group_id = json_extract(k.value, '$.groupId') AND e.device_id = json_extract(k.value, '$.deviceId')
 AND e.public_key = json_extract(k.value, '$.publicKey')
 AND e.identity_id IS json_extract(k.value, '$.identityId')))
 AND (SELECT count(*) FROM coordinator_auth_controller_attestations WHERE revoked_at IS NULL)
 = json_array_length(?)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_controller_attestations t WHERE t.revoked_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM json_each(?) k
 WHERE t.coordinator_id = json_extract(k.value, '$.coordinatorId')
 AND t.attestation_id = json_extract(k.value, '$.attestationId')
 AND t.device_id = json_extract(k.value, '$.deviceId')
 AND t.public_key = json_extract(k.value, '$.publicKey')
 AND t.identity_id = json_extract(k.value, '$.identityId')))`,
			values: [scan.enrollments, scan.enrollments, scan.attestations, scan.attestations],
		},
		{
			sql: `NOT EXISTS (SELECT 1 FROM coordinator_auth_controller_attestations t
 WHERE t.coordinator_id = a.coordinator_id AND (t.device_id = a.device_id OR t.public_key = a.public_key)
 AND t.revoked_at IS NULL AND t.identity_id <> a.target_identity_id)`,
			values: [],
		},
		{
			sql: `(SELECT count(*) FROM coordinator_device_rebind_audit_log r
 WHERE r.coordinator_id = a.coordinator_id AND r.target_identity_id = a.target_identity_id
 AND r.created_at_ms > ?) < ${DEVICE_REBIND_DAILY_LIMIT}`,
			values: [now - DAY_MS],
		},
	];
}

// Only coordinators that ran migration 0037 have legacy owner resolutions.
const NO_OTHER_LEGACY_OWNER: Guard = {
	sql: `NOT EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions o
 WHERE o.coordinator_id = a.coordinator_id AND (o.device_id = a.device_id OR o.key_id = a.key_id)
 AND o.owner_identity_id <> a.target_identity_id)`,
	values: [],
};

async function hasTable(backend: AuthLinkBackend, name: string): Promise<boolean> {
	return (
		(await backend.first({
			sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
			values: [name],
		})) !== null
	);
}

/**
 * Each guard is its own column, so the winning UPDATE stays shallow on D1
 * (expression depth limit 100).
 */
async function guardStatement(
	backend: AuthLinkBackend,
	a: DeviceRebindAttempt,
	checks: Guard[],
): Promise<AuthLinkStatement> {
	const all = [...checks];
	if (await hasTable(backend, "coordinator_legacy_owner_resolutions"))
		all.push(NO_OTHER_LEGACY_OWNER);
	return {
		sql: `WITH rebind_guards AS MATERIALIZED (SELECT ${all
			.map((guard, index) => `(${guard.sql}) AS g${index}`)
			.join(",\n ")}
 FROM ${ATTEMPT} a WHERE a.coordinator_id = ? AND a.attempt_id = ?),
 rebind_ok AS MATERIALIZED (SELECT ${all.map((_, index) => `g${index}`).join(" AND ")} AS ok
 FROM rebind_guards)`,
		values: [...all.flatMap((guard) => guard.values), a.coordinator_id, a.attempt_id],
	};
}

const WINNER = "coordinator_id = ? AND attempt_id = ? AND state = 'finalized' AND binding_id = ?";

/** A row-count mismatch updates the finalized row, which its trigger aborts with the batch. */
function assertWrite(winner: readonly string[], expected: number): AuthLinkStatement {
	return {
		sql: `UPDATE ${ATTEMPT} SET state = 'failed' WHERE ${WINNER} AND changes() <> ?`,
		values: [...winner, expected],
	};
}

function statements(
	a: DeviceRebindAttempt,
	guard: AuthLinkStatement,
	fields: { now: number; bindingId: string; eventId: string; keyProofHash: string },
): AuthLinkStatement[] {
	const { now, bindingId, eventId, keyProofHash } = fields;
	const winner = [a.coordinator_id, a.attempt_id, bindingId];
	const count = a.enrollment_count ?? 0;
	const outcome = JSON.stringify({ kind: "finalized", bindingId, enrollmentCount: count });
	return [
		{
			sql: `${guard.sql} UPDATE ${ATTEMPT} SET state = 'finalized', finalized_at_ms = ?,
 binding_id = ?, audit_event_id = ?, final_key_proof_hash = ?, final_outcome_json = ?,
 loopback_redirect = NULL
 WHERE coordinator_id = ? AND attempt_id = ? AND (SELECT ok FROM rebind_ok) = 1`,
			values: [
				...guard.values,
				now,
				bindingId,
				eventId,
				keyProofHash,
				outcome,
				a.coordinator_id,
				a.attempt_id,
			],
		},
		assertWrite(winner, 1),
		{
			sql: `INSERT INTO coordinator_device_ownership_bindings
 (device_id, key_id, identity_id, coordinator_id, binding_id, provenance, source_ref, bound_at)
 SELECT device_id, key_id, target_identity_id, coordinator_id, binding_id, 'owner_enrollment',
 'rebind:' || attempt_id, ? FROM ${ATTEMPT} WHERE ${WINNER}`,
			values: [new Date(now).toISOString(), ...winner],
		},
		assertWrite(winner, 1),
		{
			sql: `UPDATE enrolled_devices SET identity_id = ?
 WHERE device_id = ? AND EXISTS (SELECT 1 FROM ${ATTEMPT} WHERE ${WINNER})`,
			values: [a.target_identity_id, a.device_id, ...winner],
		},
		assertWrite(winner, count),
		{
			sql: `INSERT INTO coordinator_device_rebind_audit_log
 (coordinator_id, event_id, attempt_id, action, binding_id, device_id, previous_identity_id,
 target_identity_id, enrollment_count, created_at_ms)
 SELECT coordinator_id, audit_event_id, attempt_id, 'owner_device_rebound', binding_id, device_id,
 current_identity_id, target_identity_id, enrollment_count, finalized_at_ms
 FROM ${ATTEMPT} WHERE ${WINNER}`,
			values: winner,
		},
		assertWrite(winner, 1),
	];
}

async function readAttempt(
	backend: AuthLinkBackend,
	coordinatorId: string,
	attemptId: string,
): Promise<DeviceRebindAttempt | null> {
	return backend.first<DeviceRebindAttempt>({
		sql: `SELECT * FROM ${ATTEMPT} WHERE coordinator_id = ? AND attempt_id = ?`,
		values: [coordinatorId, attemptId],
	});
}

/**
 * Reads a finalized rebind from records that never change: the finalized
 * attempt, its binding, and its audit event. Enrollments are not consulted,
 * because an admin may change them after the commit. Resolves an unknown commit outcome
 * without retrying the write. Null means "not committed as recorded".
 */
export async function readDeviceRebindReceipt(
	backend: AuthLinkBackend,
	coordinatorId: string,
	attemptId: string,
): Promise<DeviceRebindReceipt | null> {
	const row = await backend.first<DeviceRebindAttempt & { binding_ok: number; audit_ok: number }>({
		sql: `SELECT a.*,
 EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b WHERE b.binding_id = a.binding_id
  AND b.device_id = a.device_id AND b.key_id = a.key_id AND b.identity_id = a.target_identity_id
  AND b.coordinator_id = a.coordinator_id AND b.source_ref = 'rebind:' || a.attempt_id) AS binding_ok,
 EXISTS (SELECT 1 FROM coordinator_device_rebind_audit_log l WHERE l.coordinator_id = a.coordinator_id
  AND l.event_id = a.audit_event_id AND l.attempt_id = a.attempt_id AND l.binding_id = a.binding_id
  AND l.device_id = a.device_id AND l.previous_identity_id = a.current_identity_id
  AND l.target_identity_id = a.target_identity_id AND l.enrollment_count = a.enrollment_count
  AND l.created_at_ms = a.finalized_at_ms) AS audit_ok
 FROM ${ATTEMPT} a WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.state = 'finalized'`,
		values: [coordinatorId, attemptId],
	});
	if (row?.binding_ok !== 1 || row.audit_ok !== 1) return null;
	return {
		kind: "finalized",
		attemptId: row.attempt_id,
		bindingId: row.binding_id as string,
		deviceId: row.device_id,
		previousIdentityId: row.current_identity_id,
		targetIdentityId: row.target_identity_id as string,
		enrollmentCount: row.enrollment_count as number,
		finalizedAtMs: row.finalized_at_ms as number,
	};
}

interface DeviceRebindCommitInput {
	backend: AuthLinkBackend;
	coordinatorId: string;
	attemptId: string;
	/** Trusted current auth config revision, never a client value. */
	revision: string;
	now: number;
	completionSecret: string;
	signature: string;
}

/**
 * One atomic commit: finalize the attempt, write the immutable ownership
 * binding, move every enrollment of the device key to the target Identity, and
 * record the audit event. Team memberships and grants are untouched. An exact
 * retry of an already finalized attempt returns its receipt; anything else
 * writes nothing. SQL errors propagate so an unknown outcome is never reported
 * as a refusal; callers resolve it with readDeviceRebindReceipt.
 */
export async function commitDeviceRebind(
	input: DeviceRebindCommitInput,
): Promise<DeviceRebindCommitResult> {
	const { backend, now, revision } = input;
	const row = await readAttempt(backend, input.coordinatorId, input.attemptId);
	if (!row) return { kind: "refused" };
	if (row.state === "finalized") return priorCommit(backend, row, input);
	const proof = await verifyDeviceRebindCompletion(row, input);
	if (!proof) return { kind: "refused" };
	const scan = await keyAliasScan(backend, row);
	if (!scan) return { kind: "refused" };
	const guard = await guardStatement(backend, row, guards(row, now, revision, scan));
	const bindingId = globalThis.crypto.randomUUID();
	await backend.batch(
		statements(row, guard, {
			now,
			bindingId,
			eventId: globalThis.crypto.randomUUID(),
			keyProofHash: proof.keyProofHash,
		}),
	);
	const receipt = await readDeviceRebindReceipt(backend, row.coordinator_id, row.attempt_id);
	if (!receipt) return { kind: "refused" };
	// A concurrent exact retry may have won; this call then wrote nothing itself.
	return receipt.bindingId === bindingId
		? { kind: "committed", receipt }
		: { kind: "prior_commit", receipt };
}

/** An exact retry carries the same completion secret and the same signature. */
async function priorCommit(
	backend: AuthLinkBackend,
	row: DeviceRebindAttempt,
	input: { completionSecret: string; signature: string },
): Promise<DeviceRebindCommitResult> {
	const secret = decodeCoordinatorAuthProof32(input.completionSecret);
	if (!secret || (await hashCoordinatorAuthProofBytes32(secret)) !== row.completion_secret_hash)
		return { kind: "refused" };
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input.signature),
	);
	const keyProofHash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	if (keyProofHash !== row.final_key_proof_hash) return { kind: "refused" };
	const receipt = await readDeviceRebindReceipt(backend, row.coordinator_id, row.attempt_id);
	return receipt ? { kind: "prior_commit", receipt } : { kind: "refused" };
}
