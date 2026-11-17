import {
	enrollmentKeyIdColumn,
	enrollmentKeyIdSql,
	type RemovalColumnSql,
} from "./coordinator-device-removal.js";
import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";
import type { projectInviteGuardEvidence } from "./coordinator-project-invite-guards.js";
import type {
	CoordinatorConsumeProjectInviteInput,
	CoordinatorEnrollDeviceInput,
} from "./coordinator-store-contract.js";

export function captureLegacyProjectInviteInput(
	input: CoordinatorConsumeProjectInviteInput,
): CoordinatorConsumeProjectInviteInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_input");
	const captured: Record<string, unknown> = {};
	for (const field of [
		"token",
		"operationId",
		"deviceId",
		"publicKey",
		"fingerprint",
		"recipientActorId",
		"recipientDisplayName",
		"deviceDisplayName",
		"now",
	]) {
		const descriptor = legacyEnrollmentDescriptor(input, field);
		if (descriptor && !("value" in descriptor)) throw new Error("invalid_input");
		const value = descriptor?.value;
		if (typeof value !== "string") throw new Error("invalid_input");
		captured[field] = value;
	}
	return captured as unknown as CoordinatorConsumeProjectInviteInput;
}

/** Global ownership metadata, not proof. Bind actual device ID and canonical key ID (or null). */
export const DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL = `EXISTS (
SELECT 1 FROM coordinator_device_ownership_bindings WHERE device_id = ? OR key_id = ?)`;

/** Project actor labels never prove ownership; only the target enrollment is mutated. */
export function legacyProjectInviteOwnershipEvidence(
	evidence: ReturnType<typeof projectInviteGuardEvidence>,
	deviceId: string,
	keyIds: { incoming: string | null; current: string | null },
) {
	const ownershipSql = `${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL} OR ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}`;
	const ownershipValues = [deviceId, keyIds.incoming, deviceId, keyIds.current];
	return {
		...evidence,
		ownershipSql,
		ownershipValues,
		eligibilitySql: `${evidence.eligibilitySql} AND NOT (${ownershipSql})`,
		eligibilityValues: [...evidence.eligibilityValues, ...ownershipValues],
		boundEligibilitySql: `${evidence.boundEligibilitySql} AND NOT (${ownershipSql})`,
		boundEligibilityValues: [...evidence.boundEligibilityValues, ...ownershipValues],
	};
}

export const LEGACY_DEVICE_DENIAL_SQL = `SELECT CASE
WHEN ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} THEN 'device_revoked'
WHEN ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL} THEN 'device_ownership_requires_verified_identity'
ELSE 'invite_identity_conflict' END AS denial`;

/** Bind captured public key (null for absence), group/device, then group/device/public key. */
export const LEGACY_ENROLLMENT_SOURCE_MATCH_SQL = `((? IS NULL AND NOT EXISTS (
SELECT 1 FROM enrolled_devices WHERE group_id = ? AND device_id = ?)) OR EXISTS (
SELECT 1 FROM enrolled_devices WHERE group_id = ? AND device_id = ? AND public_key = ?))`;

/** Incoming revocation, incoming ownership, captured current ownership, then source tuple.
 * Source drift deliberately falls through the denial validator to the unavailable error.
 */
export const LEGACY_ENROLLMENT_DENIAL_SQL = `SELECT CASE
WHEN ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} THEN 'device_revoked'
WHEN ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL} OR ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}
THEN 'device_ownership_requires_verified_identity'
WHEN NOT ${LEGACY_ENROLLMENT_SOURCE_MATCH_SQL} THEN 'device_ownership_authorization_unavailable'
ELSE 'invite_identity_conflict' END AS denial`;

/** Incoming revocation, incoming ownership, captured current ownership, then source tuple. */
const LEGACY_ENROLLMENT_GUARD_SQL = `NOT ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL}
AND NOT ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}
AND NOT ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}
AND ${LEGACY_ENROLLMENT_SOURCE_MATCH_SQL}`;

/** No captured enrollment: the source match holds only while no row exists. */
const legacyEnrollmentInsertSql = (keyId: RemovalColumnSql) => `INSERT INTO enrolled_devices(
group_id, device_id, public_key, fingerprint, identity_id, display_name, enabled, created_at${keyId.column}
) SELECT ?, ?, ?, ?, ?, ?, 1, ?${keyId.value}
WHERE ${LEGACY_ENROLLMENT_GUARD_SQL}`;

/** The captured row, an Identity that does not conflict, then the shared guard. */
const LEGACY_ENROLLMENT_ROW_GUARD_SQL = `public_key = ?
AND (? IS NULL OR identity_id IS NULL OR identity_id = ?)
AND ${LEGACY_ENROLLMENT_GUARD_SQL}`;

/** A captured enrollment: the source match holds only while the row keeps the captured key. */
const legacyEnrollmentUpdateSql = (
	keyId: RemovalColumnSql,
) => `UPDATE enrolled_devices SET public_key = ?, fingerprint = ?,
identity_id = COALESCE(identity_id, ?), display_name = ?, enabled = 1${keyId.assignment}
WHERE group_id = ? AND device_id = ? AND ${LEGACY_ENROLLMENT_ROW_GUARD_SQL}`;

/** First statement of a key text change that keeps the stored key ID value. */
const LEGACY_KEY_ID_RESET_SQL = `UPDATE enrolled_devices SET key_id = ''
WHERE group_id = ? AND device_id = ? AND ${LEGACY_ENROLLMENT_ROW_GUARD_SQL}`;

/**
 * Second statement of that change. It writes only when the reset before it changed
 * the row, and it carries every guard again. A guard that fails here raises, so the
 * transaction or batch rolls the reset back and no row keeps the empty key ID.
 */
const LEGACY_KEY_TEXT_UPDATE_SQL = `UPDATE enrolled_devices SET public_key = ?, fingerprint = ?,
identity_id = COALESCE(identity_id, ?), display_name = ?, enabled = 1, key_id = ?
WHERE group_id = ? AND device_id = ?
AND CASE WHEN changes() <> 1 THEN 0 WHEN ${LEGACY_ENROLLMENT_ROW_GUARD_SQL} THEN 1
ELSE json('enrollment_key_text_incomplete') END`;

/**
 * Third statement of that change, a read in the same transaction or batch. A row
 * that still passes every guard still has the captured key text, so the rewrite
 * did not change it: a trigger suppressed the reset or the rewrite without an
 * error. The read then raises, which rolls the reset back before anything commits.
 * A count read after a D1 batch would come too late for that.
 */
const LEGACY_KEY_TEXT_COMPLETE_SQL = `SELECT CASE WHEN EXISTS (SELECT 1 FROM enrolled_devices
WHERE group_id = ? AND device_id = ? AND ${LEGACY_ENROLLMENT_ROW_GUARD_SQL})
THEN json('enrollment_key_text_incomplete') ELSE 1 END AS complete`;

/**
 * True when a write replaces the stored key text and the stored `key_id` value
 * stays the same: another text form of one canonical key, or one opaque key in
 * place of another. The stale-key trigger refuses a key text change whose key ID
 * it cannot see change, so such a write first resets the key ID to the empty
 * string and then writes the new text with the recomputed ID.
 */
export function changesKeyTextOnly(key: {
	publicKey: string;
	keyId: string | null;
	currentPublicKey: string | null;
	currentKeyId: string | null;
}): boolean {
	if (key.currentPublicKey === null || key.publicKey === key.currentPublicKey) return false;
	return enrollmentKeyIdColumn(key.keyId) === enrollmentKeyIdColumn(key.currentKeyId);
}

export interface LegacyEnrollmentWrite {
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	identityId: string | null;
	displayName: string | null;
	createdAt: string;
	/** Canonical key ID of the incoming key, or null for a key that is not SSH Ed25519. */
	keyId: string | null;
	/** Public key of the enrollment read before this write, or null when none existed. */
	currentPublicKey: string | null;
	currentKeyId: string | null;
	/** False on a schema without the `key_id` column, where the key ID is not stored. */
	storeKeyId: boolean;
}

export interface LegacyEnrollmentStatement {
	sql: string;
	values: (string | null)[];
	/** A read that raises on an incomplete write. It changes no row and has no count. */
	assertion?: true;
}

/**
 * The enrollment write: an INSERT when no enrollment was captured, an UPDATE
 * when one was, and two UPDATEs followed by a completion assertion for a key
 * text change that keeps the key ID value (see changesKeyTextOnly). The
 * enrollment triggers abort an insert over an existing row, so this table takes
 * no ON CONFLICT clause. Every statement pins the captured source, and a source
 * that moved leaves it without effect. The caller runs the statements in order
 * in one transaction or atomic batch and reads the outcome of the writes with
 * legacyEnrollmentWritten.
 */
export function legacyEnrollmentWriteStatements(
	input: LegacyEnrollmentWrite,
): LegacyEnrollmentStatement[] {
	const { groupId, deviceId, currentPublicKey } = input;
	const guards = [
		deviceId,
		input.keyId,
		deviceId,
		input.keyId,
		deviceId,
		input.currentKeyId,
		currentPublicKey,
		groupId,
		deviceId,
		groupId,
		deviceId,
		currentPublicKey,
	];
	const keyIdSql = enrollmentKeyIdSql(input.storeKeyId);
	const keyIdValues = input.storeKeyId ? [enrollmentKeyIdColumn(input.keyId)] : [];
	if (currentPublicKey === null) {
		return [
			{
				sql: legacyEnrollmentInsertSql(keyIdSql),
				values: [
					groupId,
					deviceId,
					input.publicKey,
					input.fingerprint,
					input.identityId,
					input.displayName,
					input.createdAt,
					...keyIdValues,
					...guards,
				],
			},
		];
	}
	const row = [groupId, deviceId, currentPublicKey, input.identityId, input.identityId, ...guards];
	const assignments = [input.publicKey, input.fingerprint, input.identityId, input.displayName];
	if (input.storeKeyId && changesKeyTextOnly(input)) {
		return [
			{ sql: LEGACY_KEY_ID_RESET_SQL, values: row },
			{ sql: LEGACY_KEY_TEXT_UPDATE_SQL, values: [...assignments, ...keyIdValues, ...row] },
			{ sql: LEGACY_KEY_TEXT_COMPLETE_SQL, values: row, assertion: true },
		];
	}
	return [
		{ sql: legacyEnrollmentUpdateSql(keyIdSql), values: [...assignments, ...keyIdValues, ...row] },
	];
}

/**
 * True when every write changed its row, false when none did. Anything else is
 * not a result this writer can produce. The completion assertion has already
 * rolled back a reset that its rewrite did not follow.
 */
export function legacyEnrollmentWritten(changes: readonly number[]): boolean {
	if (changes.every((count) => count === 1)) return true;
	if (changes.every((count) => count === 0)) return false;
	throw new Error("device_ownership_authorization_unavailable");
}

export function captureLegacyEnrollmentPublicKey(row: unknown): string | null {
	if (row === null) return null;
	if (!row || typeof row !== "object")
		throw new Error("device_ownership_authorization_unavailable");
	const descriptor = Object.getOwnPropertyDescriptor(row, "public_key");
	if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
		throw new Error("device_ownership_authorization_unavailable");
	}
	return descriptor.value;
}

export function captureLegacyEnrollment(
	groupId: string,
	input: CoordinatorEnrollDeviceInput,
): CoordinatorEnrollDeviceInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_input");
	const captured: Record<string, unknown> = {};
	for (const field of ["deviceId", "publicKey", "fingerprint", "identityId", "displayName"]) {
		const descriptor = legacyEnrollmentDescriptor(input, field);
		if (descriptor && !("value" in descriptor)) throw new Error("invalid_input");
		captured[field] = descriptor?.value;
	}
	assertLegacyDeviceScope(groupId, captured.deviceId);
	if (
		typeof captured.publicKey !== "string" ||
		typeof captured.fingerprint !== "string" ||
		(captured.identityId != null && typeof captured.identityId !== "string") ||
		(captured.displayName != null && typeof captured.displayName !== "string")
	)
		throw new Error("invalid_input");
	return captured as unknown as CoordinatorEnrollDeviceInput;
}

function legacyEnrollmentDescriptor(input: object, field: string): PropertyDescriptor | undefined {
	try {
		return Object.getOwnPropertyDescriptor(input, field);
	} catch {
		throw new Error("invalid_input");
	}
}

export function assertLegacyDeviceScope(groupId: unknown, deviceId: unknown): void {
	if (typeof groupId !== "string" || typeof deviceId !== "string") throw new Error("invalid_input");
}

export function legacyDeviceWriteChanges(result: unknown): number {
	if (!result || typeof result !== "object" || ("success" in result && result.success === false)) {
		throw new Error("device_ownership_authorization_unavailable");
	}
	let changes: unknown;
	if (
		"meta" in result &&
		result.meta &&
		typeof result.meta === "object" &&
		"changes" in result.meta
	) {
		changes = result.meta.changes;
	}
	if (typeof changes !== "number" || !Number.isSafeInteger(changes) || changes < 0 || changes > 1) {
		throw new Error("device_ownership_authorization_unavailable");
	}
	return changes;
}

export function legacyDeviceDenial(row: unknown): string {
	if (
		row &&
		typeof row === "object" &&
		!("success" in row && row.success === false) &&
		"denial" in row
	) {
		const denial = row.denial;
		if (
			denial === "device_revoked" ||
			denial === "device_ownership_requires_verified_identity" ||
			denial === "invite_identity_conflict"
		)
			return denial;
	}
	throw new Error("device_ownership_authorization_unavailable");
}

export function legacyDeviceAuthorizationFailure(error: unknown): never {
	if (
		error instanceof Error &&
		[
			"device_revoked",
			"device_ownership_requires_verified_identity",
			"invite_identity_conflict",
		].includes(error.message)
	)
		throw error;
	throw new Error("device_ownership_authorization_unavailable");
}
