/** Persistence of completed, trusted admin reviews, not authentication of request JSON.
 * Future routes must authenticate the configured admin before invoking this capability.
 * Enrollment identity labels alone never create controller authority.
 */
export interface CoordinatorAuthControllerReviewInput {
	attestationId: string;
	coordinatorId: string;
	identityId: string;
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	reviewReceiptId: string;
	evidenceDigest: string;
	/** Optional for legacy trusted seed callers; operator routes always supply it. */
	verifiedSnapshot?: CoordinatorAuthControllerVerifiedSnapshot;
}

export interface CoordinatorAuthControllerVerifiedSnapshot {
	enrollmentIdentityId: string | null;
	invites: {
		inviteId: string;
		kind: "team_member" | "add_device";
		actorId: string;
		assignedIdentityId: string | null;
		targetIdentityId: string | null;
		digest: string;
	}[];
}

export interface CoordinatorAuthControllerAttestation {
	readonly attestation_id: string;
	readonly coordinator_id: string;
	readonly identity_id: string;
	readonly group_id: string;
	readonly device_id: string;
	readonly public_key: string;
	readonly fingerprint: string;
	readonly review_receipt_id: string;
	readonly evidence_digest: string;
	readonly enrollment_identity_id: string | null;
	readonly revision: 1;
	readonly created_at: string;
	readonly revoked_at: string | null;
}

export type CoordinatorAuthControllerCreateResult =
	| { kind: "created" | "existing"; attestation: CoordinatorAuthControllerAttestation }
	| {
			kind: "rejected";
			error:
				| "invalid_review_input"
				| "enrollment_mismatch"
				| "review_stale"
				| "attestation_conflict"
				| "attestation_revoked";
	  };

export interface CoordinatorAuthControllerStore {
	createAuthControllerAttestation(
		input: CoordinatorAuthControllerReviewInput,
	): Promise<CoordinatorAuthControllerCreateResult>;
	getActiveAuthControllerAttestation(
		coordinatorId: string,
		attestationId: string,
	): Promise<CoordinatorAuthControllerAttestation | null>;
	revokeAuthControllerAttestation(coordinatorId: string, attestationId: string): Promise<boolean>;
}

const REVIEW_FIELDS = {
	attestationId: "attestation_id",
	coordinatorId: "coordinator_id",
	identityId: "identity_id",
	groupId: "group_id",
	deviceId: "device_id",
	publicKey: "public_key",
	fingerprint: "fingerprint",
	reviewReceiptId: "review_receipt_id",
	evidenceDigest: "evidence_digest",
} as const;

export function isAuthControllerId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}

function isReviewFieldValid(field: string, value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (field === "fingerprint" || field === "evidenceDigest") {
		return value.length === 64 && /^[a-f0-9]{64}$/.test(value);
	}
	if (field !== "publicKey") return isAuthControllerId(value);
	// PEM exports include a final line ending. Validate without line endings, but
	// retain the original bytes for the authoritative enrollment comparison.
	const withoutLineEndings = value.replace(/[\r\n]/g, "");
	return (
		withoutLineEndings.length > 0 &&
		value.length <= 4096 &&
		withoutLineEndings.trim() === withoutLineEndings &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(withoutLineEndings)
	);
}

type VerifiedInvite = CoordinatorAuthControllerVerifiedSnapshot["invites"][number];
function validSnapshotField(field: keyof VerifiedInvite, value: unknown): boolean {
	if (field === "kind") return value === "team_member" || value === "add_device";
	if (field === "digest") return isReviewFieldValid("evidenceDigest", value);
	if (field === "assignedIdentityId" || field === "targetIdentityId")
		return value === null || isAuthControllerId(value);
	return isAuthControllerId(value);
}
function captureVerifiedInvite(value: unknown): VerifiedInvite | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const fields = [
		"inviteId",
		"kind",
		"actorId",
		"assignedIdentityId",
		"targetIdentityId",
		"digest",
	] as const;
	const copy: Record<string, string | null> = {};
	for (const field of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
		if (!validSnapshotField(field, descriptor.value)) return null;
		copy[field] = descriptor.value;
	}
	return copy as VerifiedInvite;
}
function captureVerifiedInvites(value: unknown): VerifiedInvite[] | null {
	if (!Array.isArray(value)) return null;
	const length = Object.getOwnPropertyDescriptor(value, "length");
	if (
		!length ||
		!Object.hasOwn(length, "value") ||
		!Number.isSafeInteger(length.value) ||
		length.value > 4096
	)
		return null;
	const invites: VerifiedInvite[] = [];
	const ids = new Set<string>();
	for (let index = 0; index < length.value; index++) {
		const item = Object.getOwnPropertyDescriptor(value, String(index));
		if (!item || !Object.hasOwn(item, "value")) return null;
		const invite = captureVerifiedInvite(item.value);
		if (!invite || ids.has(invite.inviteId)) return null;
		ids.add(invite.inviteId);
		invites.push(invite);
	}
	return invites;
}
export function captureVerifiedSnapshot(
	value: unknown,
): CoordinatorAuthControllerVerifiedSnapshot | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const identity = Object.getOwnPropertyDescriptor(value, "enrollmentIdentityId");
	const list = Object.getOwnPropertyDescriptor(value, "invites");
	if (!identity || !Object.hasOwn(identity, "value") || !list || !Object.hasOwn(list, "value"))
		return null;
	if (identity.value !== null && !isAuthControllerId(identity.value)) return null;
	const invites = captureVerifiedInvites(list.value);
	if (!invites) return null;
	const snapshot = { enrollmentIdentityId: identity.value as string | null, invites };
	if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 1_000_000) return null;
	return snapshot;
}

function captureOptionalSnapshot(
	input: object,
): CoordinatorAuthControllerVerifiedSnapshot | null | undefined {
	const snapshot = Object.getOwnPropertyDescriptor(input, "verifiedSnapshot");
	if (!snapshot) return "verifiedSnapshot" in input ? null : undefined;
	if (!Object.hasOwn(snapshot, "value")) return null;
	return captureVerifiedSnapshot(snapshot.value);
}

/** Capture own data properties once, without coercion, inherited fields or getters. */
export function captureAuthControllerReview(
	input: unknown,
): CoordinatorAuthControllerReviewInput | null {
	if (!input || typeof input !== "object") return null;
	const captured: Partial<CoordinatorAuthControllerReviewInput> = {};
	try {
		if (Array.isArray(input)) return null;
		const fields = Object.keys(REVIEW_FIELDS) as (keyof typeof REVIEW_FIELDS)[];
		for (const field of fields) {
			const descriptor = Object.getOwnPropertyDescriptor(input, field);
			if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
			if (!isReviewFieldValid(field, descriptor.value)) return null;
			captured[field] = descriptor.value;
		}
		const snapshot = captureOptionalSnapshot(input);
		if (snapshot === null) return null;
		if (snapshot !== undefined) captured.verifiedSnapshot = snapshot;
	} catch {
		return null;
	}
	return captured as CoordinatorAuthControllerReviewInput;
}

export function authControllerRetryResult(
	input: CoordinatorAuthControllerReviewInput,
	row: CoordinatorAuthControllerAttestation | null,
): CoordinatorAuthControllerCreateResult {
	if (
		!row ||
		Object.entries(REVIEW_FIELDS).some(
			([field, column]) =>
				input[field as keyof CoordinatorAuthControllerReviewInput] !== row[column],
		)
	) {
		return { kind: "rejected", error: "attestation_conflict" };
	}
	if (row.revoked_at !== null) return { kind: "rejected", error: "attestation_revoked" };
	return { kind: "existing", attestation: row };
}

/** Only uniqueness violations are domain conflicts; other backend failures propagate. */
export function isAuthControllerUniqueError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
	return (
		code === "SQLITE_CONSTRAINT_UNIQUE" ||
		code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
		/\bUNIQUE constraint failed\b/i.test(error.message)
	);
}

export const AUTH_CONTROLLER_SCHEMA_SQL = `
	CREATE TABLE IF NOT EXISTS coordinator_auth_controller_attestations (
		attestation_id TEXT NOT NULL,
		coordinator_id TEXT NOT NULL,
		identity_id TEXT NOT NULL,
		group_id TEXT NOT NULL,
		device_id TEXT NOT NULL,
		public_key TEXT NOT NULL,
		fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
		review_receipt_id TEXT NOT NULL,
		evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
		enrollment_identity_id TEXT,
		revision INTEGER NOT NULL DEFAULT 1 CHECK (revision = 1),
		created_at TEXT NOT NULL,
		revoked_at TEXT,
		PRIMARY KEY (coordinator_id, attestation_id),
		UNIQUE (coordinator_id, group_id, device_id, fingerprint),
		UNIQUE (coordinator_id, review_receipt_id)
	);`;

// No foreign keys: removal of an enrollment must not erase revocation tombstones.
// One JSON bind keeps the exact set comparison below D1's parameter limit.
const AUTH_CONTROLLER_SNAPSHOT_CTE = `
	WITH snapshot(value) AS (SELECT ?), live_invites AS (
		SELECT i.* FROM coordinator_invites i
		WHERE i.group_id = ? AND i.bound_device_id = ? AND i.bound_public_key = ?
			AND i.bound_fingerprint = ? AND i.revoked_at IS NULL
			AND i.consumed_at IS NOT NULL AND i.consumed_at != ''
			AND i.invite_kind IN ('team_member', 'add_device')
	)`;
const AUTH_CONTROLLER_SNAPSHOT_GUARD = `
	AND ((SELECT value FROM snapshot) IS NULL OR (
		e.identity_id IS json_extract((SELECT value FROM snapshot), '$.enrollmentIdentityId')
		AND (SELECT count(*) FROM live_invites) =
			(SELECT count(*) FROM json_each((SELECT value FROM snapshot), '$.invites'))
		AND NOT EXISTS (
			SELECT 1 FROM live_invites i WHERE NOT EXISTS (
				SELECT 1 FROM json_each((SELECT value FROM snapshot), '$.invites') j
				WHERE i.invite_id = json_extract(j.value, '$.inviteId')
					AND i.invite_kind = json_extract(j.value, '$.kind')
					AND i.recipient_actor_id IS json_extract(j.value, '$.actorId')
					AND i.assigned_identity_id IS json_extract(j.value, '$.assignedIdentityId')
					AND i.target_identity_id IS json_extract(j.value, '$.targetIdentityId')
					AND i.reviewed_preview_digest IS json_extract(j.value, '$.digest')
			)
		)
	))`;

function authControllerSnapshotValues(
	input: CoordinatorAuthControllerReviewInput,
): (string | null)[] {
	return [
		input.verifiedSnapshot ? JSON.stringify(input.verifiedSnapshot) : null,
		input.groupId,
		input.deviceId,
		input.publicKey,
		input.fingerprint,
	];
}

export const AUTH_CONTROLLER_INSERT_SQL = `
	${AUTH_CONTROLLER_SNAPSHOT_CTE}
	INSERT INTO coordinator_auth_controller_attestations (
		attestation_id, coordinator_id, identity_id, group_id, device_id, public_key,
		fingerprint, review_receipt_id, evidence_digest, enrollment_identity_id, revision, created_at, revoked_at
	)
	SELECT ?, ?, ?, e.group_id, e.device_id, e.public_key, e.fingerprint, ?, ?, e.identity_id, 1, ?, NULL
	FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
	WHERE e.group_id = ? AND e.device_id = ? AND e.enabled = 1 AND g.archived_at IS NULL
		AND e.public_key = ? AND e.fingerprint = ? AND (e.identity_id IS NULL OR e.identity_id = ?)
		${AUTH_CONTROLLER_SNAPSHOT_GUARD}`;

/** Retry eligibility is read atomically with all the same live evidence guards. */
export const AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL = `
	${AUTH_CONTROLLER_SNAPSHOT_CTE}
	SELECT 1 AS eligible FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
	WHERE e.group_id = ? AND e.device_id = ? AND e.enabled = 1 AND g.archived_at IS NULL
		AND e.public_key = ? AND e.fingerprint = ? AND (e.identity_id IS NULL OR e.identity_id = ?)
		${AUTH_CONTROLLER_SNAPSHOT_GUARD}`;

export function authControllerRetryEligibleValues(
	input: CoordinatorAuthControllerReviewInput,
): (string | null)[] {
	return [
		...authControllerSnapshotValues(input),
		input.groupId,
		input.deviceId,
		input.publicKey,
		input.fingerprint,
		input.identityId,
	];
}

export function authControllerInsertValues(
	input: CoordinatorAuthControllerReviewInput,
	createdAt: string,
): (string | null)[] {
	return [
		...authControllerSnapshotValues(input),
		input.attestationId,
		input.coordinatorId,
		input.identityId,
		input.reviewReceiptId,
		input.evidenceDigest,
		createdAt,
		input.groupId,
		input.deviceId,
		input.publicKey,
		input.fingerprint,
		input.identityId,
	];
}

export const AUTH_CONTROLLER_ACTIVE_SQL = `
	SELECT a.* FROM coordinator_auth_controller_attestations a
	JOIN enrolled_devices e ON e.group_id = a.group_id AND e.device_id = a.device_id
	JOIN groups g ON g.group_id = a.group_id
	WHERE a.coordinator_id = ? AND a.attestation_id = ? AND a.revoked_at IS NULL
		AND e.enabled = 1 AND g.archived_at IS NULL AND e.public_key = a.public_key
		AND e.fingerprint = a.fingerprint AND (e.identity_id IS NULL OR e.identity_id = a.identity_id)`;

export const AUTH_CONTROLLER_CONFLICT_SQL = `
	SELECT * FROM coordinator_auth_controller_attestations
	WHERE coordinator_id = ? AND (attestation_id = ? OR review_receipt_id = ?
		OR (group_id = ? AND device_id = ? AND fingerprint = ?))
	ORDER BY CASE WHEN attestation_id = ? THEN 0 ELSE 1 END LIMIT 1`;

export function authControllerConflictValues(
	input: CoordinatorAuthControllerReviewInput,
): string[] {
	return [
		input.coordinatorId,
		input.attestationId,
		input.reviewReceiptId,
		input.groupId,
		input.deviceId,
		input.fingerprint,
		input.attestationId,
	];
}

export const AUTH_CONTROLLER_REVOKE_SQL = `
	UPDATE coordinator_auth_controller_attestations SET revoked_at = COALESCE(revoked_at, ?)
	WHERE coordinator_id = ? AND attestation_id = ?`;
