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

/** Capture own data properties once, without coercion, inherited fields or getters. */
export function captureAuthControllerReview(
	input: unknown,
): CoordinatorAuthControllerReviewInput | null {
	if (!input || typeof input !== "object") return null;
	const captured: Partial<CoordinatorAuthControllerReviewInput> = {};
	try {
		if (Array.isArray(input)) return null;
		const fields = Object.keys(REVIEW_FIELDS) as (keyof CoordinatorAuthControllerReviewInput)[];
		for (const field of fields) {
			const descriptor = Object.getOwnPropertyDescriptor(input, field);
			if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
			if (!isReviewFieldValid(field, descriptor.value)) return null;
			captured[field] = descriptor.value;
		}
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
export const AUTH_CONTROLLER_INSERT_SQL = `
	INSERT INTO coordinator_auth_controller_attestations (
		attestation_id, coordinator_id, identity_id, group_id, device_id, public_key,
		fingerprint, review_receipt_id, evidence_digest, enrollment_identity_id, revision, created_at, revoked_at
	)
	SELECT ?, ?, ?, e.group_id, e.device_id, e.public_key, e.fingerprint, ?, ?, e.identity_id, 1, ?, NULL
	FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
	WHERE e.group_id = ? AND e.device_id = ? AND e.enabled = 1 AND g.archived_at IS NULL
		AND e.public_key = ? AND e.fingerprint = ? AND (e.identity_id IS NULL OR e.identity_id = ?)`;

export function authControllerInsertValues(
	input: CoordinatorAuthControllerReviewInput,
	createdAt: string,
): string[] {
	return [
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
