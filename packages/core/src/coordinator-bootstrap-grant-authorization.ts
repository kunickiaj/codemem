import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";
import type {
	CoordinatorBootstrapGrant,
	CoordinatorBootstrapGrantAuthorizationError,
	CoordinatorBootstrapGrantAuthorizationInput,
	CoordinatorBootstrapGrantAuthorizationResult,
	CoordinatorEnrollment,
} from "./coordinator-store-contract.js";

const ENROLLMENT_FIELDS = [
	"group_id",
	"device_id",
	"public_key",
	"fingerprint",
	"identity_id",
	"display_name",
	"enabled",
	"created_at",
] as const;
type EnrollmentFields = Pick<CoordinatorEnrollment, (typeof ENROLLMENT_FIELDS)[number]>;
type ParticipantAliases<P extends string> = {
	[K in keyof EnrollmentFields as `${P}_${K}`]: EnrollmentFields[K] | null;
};
export type BootstrapAuthorizationRow = CoordinatorBootstrapGrant &
	ParticipantAliases<"seed_enrollment"> &
	ParticipantAliases<"worker_enrollment"> & {
		target_group_id: string | null;
		archived_at: string | null;
		status?: CoordinatorBootstrapGrantAuthorizationError | "authorized";
	};

const COLUMNS_SQL = `b.grant_id, b.group_id, b.seed_device_id, b.worker_device_id,
b.expires_at, b.created_at, b.created_by, b.revoked_at,
g.group_id AS target_group_id, g.archived_at,
${ENROLLMENT_FIELDS.map((f) => `s.${f} AS seed_enrollment_${f}, w.${f} AS worker_enrollment_${f}`).join(", ")}`;
const JOINS_SQL = `FROM coordinator_bootstrap_grants b
LEFT JOIN groups g ON g.group_id = b.group_id
LEFT JOIN enrolled_devices s ON s.group_id = b.group_id AND s.device_id = b.seed_device_id
LEFT JOIN enrolled_devices w ON w.group_id = b.group_id AND w.device_id = b.worker_device_id`;
export const BOOTSTRAP_AUTHORIZATION_SOURCE_SQL = `SELECT ${COLUMNS_SQL}
${JOINS_SQL} WHERE b.grant_id = ?`;

function own(input: unknown, key: string): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(input, key);
	if (!descriptor) return undefined;
	if (!("value" in descriptor)) throw new Error("invalid_input");
	return descriptor.value;
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

/** Capture every caller-owned primitive before even the source read can yield. */
export function captureBootstrapAuthorizationInput(
	raw: unknown,
): CoordinatorBootstrapGrantAuthorizationInput {
	const grantId = own(raw, "grantId"),
		nowMs = own(raw, "nowMs");
	if (!text(grantId) || typeof nowMs !== "number" || !Number.isSafeInteger(nowMs) || nowMs < 0)
		throw new Error("invalid_input");
	const expectation = own(raw, "expectedSeed");
	if (expectation === undefined) return { grantId, nowMs };
	const groupId = own(expectation, "groupId"),
		deviceId = own(expectation, "deviceId");
	const publicKey = own(expectation, "publicKey"),
		fingerprint = own(expectation, "fingerprint");
	if (!text(groupId) || !text(deviceId) || !text(publicKey) || !text(fingerprint))
		throw new Error("invalid_input");
	return { grantId, nowMs, expectedSeed: { groupId, deviceId, publicKey, fingerprint } };
}

export function rejectBootstrapAuthorization(
	error: CoordinatorBootstrapGrantAuthorizationError,
): CoordinatorBootstrapGrantAuthorizationResult {
	return { kind: "rejected", error };
}

export function bootstrapAuthorizationSourceError(
	input: CoordinatorBootstrapGrantAuthorizationInput,
	row: BootstrapAuthorizationRow | null,
): CoordinatorBootstrapGrantAuthorizationError | null {
	if (!row?.target_group_id) return "grant_not_found";
	const expected = input.expectedSeed;
	if (
		expected &&
		(expected.groupId !== row.group_id ||
			expected.deviceId !== row.seed_device_id ||
			expected.publicKey !== row.seed_enrollment_public_key ||
			expected.fingerprint !== row.seed_enrollment_fingerprint)
	)
		return "grant_not_found";
	return null;
}

function participant(
	row: BootstrapAuthorizationRow,
	prefix: "seed_enrollment" | "worker_enrollment",
): CoordinatorEnrollment {
	const group_id = row[`${prefix}_group_id`],
		device_id = row[`${prefix}_device_id`];
	const public_key = row[`${prefix}_public_key`],
		fingerprint = row[`${prefix}_fingerprint`];
	const identity_id = row[`${prefix}_identity_id`],
		display_name = row[`${prefix}_display_name`];
	const enabled = row[`${prefix}_enabled`],
		created_at = row[`${prefix}_created_at`];
	if (
		!text(group_id) ||
		!text(device_id) ||
		!text(public_key) ||
		!text(fingerprint) ||
		(identity_id !== null && typeof identity_id !== "string") ||
		(display_name !== null && typeof display_name !== "string") ||
		enabled !== 1 ||
		!text(created_at)
	)
		throw new Error("bootstrap_authorization_unavailable");
	return {
		group_id,
		device_id,
		public_key,
		fingerprint,
		identity_id,
		display_name,
		enabled,
		created_at,
	};
}

const EXPLICIT_OFFSET_EXPIRY =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Parse an explicit-zone timestamp without accepting normalized invalid calendar dates. */
export function parseBootstrapExpiry(value: unknown): number {
	if (typeof value !== "string") return Number.NaN;
	const parts = EXPLICIT_OFFSET_EXPIRY.exec(value);
	if (!parts) return Number.NaN;
	const year = Number(parts[1]);
	const month = Number(parts[2]);
	const day = Number(parts[3]);
	const hour = Number(parts[4]);
	const minute = Number(parts[5]);
	const second = Number(parts[6]);
	const offsetHour = Number(parts[7] ?? 0);
	const offsetMinute = Number(parts[8] ?? 0);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const februaryDays = leapYear ? 29 : 28;
	const monthDays = [31, februaryDays, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0)) {
		return Number.NaN;
	}
	if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
		return Number.NaN;
	}
	return Date.parse(value);
}

// The revocation subjects remain the captured participants even if their keys disappear or rotate.
// Success pins both tuples and the exact expiry text whose parsed milliseconds were validated.
export function bootstrapAuthorizationDecision(
	input: CoordinatorBootstrapGrantAuthorizationInput,
	row: BootstrapAuthorizationRow,
	keys: { seed: string | null; worker: string | null },
) {
	const expiryMs = parseBootstrapExpiry(row.expires_at);
	const expiryValid = Number.isFinite(expiryMs);
	const expected = input.expectedSeed;
	return {
		sql: `SELECT ${COLUMNS_SQL}, CASE
WHEN g.group_id IS NULL THEN 'grant_not_found'
WHEN ? = 1 AND (b.group_id IS NOT ? OR b.seed_device_id IS NOT ?) THEN 'grant_not_found'
WHEN ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} OR ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} THEN 'device_revoked'
WHEN b.revoked_at IS NOT NULL THEN 'grant_revoked'
WHEN g.archived_at IS NOT NULL THEN 'group_archived'
WHEN b.group_id IS NOT ? OR b.seed_device_id IS NOT ? OR b.worker_device_id IS NOT ?
 OR b.expires_at IS NOT ? OR b.revoked_at IS NOT ? THEN 'bootstrap_authorization_unavailable'
WHEN s.device_id IS NULL OR s.enabled != 1 THEN 'seed_enrollment_not_found'
WHEN w.device_id IS NULL OR w.enabled != 1 THEN 'worker_enrollment_not_found'
WHEN s.public_key IS NOT ? OR s.fingerprint IS NOT ? OR s.identity_id IS NOT ?
 OR s.group_id IS NOT ? OR s.device_id IS NOT ? OR s.enabled IS NOT ?
 OR w.public_key IS NOT ? OR w.fingerprint IS NOT ? OR w.identity_id IS NOT ?
 OR w.group_id IS NOT ? OR w.device_id IS NOT ? OR w.enabled IS NOT ? THEN 'bootstrap_authorization_unavailable'
WHEN ? = 0 THEN 'bootstrap_authorization_unavailable'
WHEN ? <= ? THEN 'grant_expired'
ELSE 'authorized' END AS status
${JOINS_SQL} WHERE b.grant_id = ?`,
		values: [
			expected ? 1 : 0,
			expected?.groupId ?? null,
			expected?.deviceId ?? null,
			row.seed_device_id,
			keys.seed,
			row.worker_device_id,
			keys.worker,
			row.group_id,
			row.seed_device_id,
			row.worker_device_id,
			row.expires_at,
			row.revoked_at,
			row.seed_enrollment_public_key,
			row.seed_enrollment_fingerprint,
			row.seed_enrollment_identity_id,
			row.seed_enrollment_group_id,
			row.seed_enrollment_device_id,
			row.seed_enrollment_enabled,
			row.worker_enrollment_public_key,
			row.worker_enrollment_fingerprint,
			row.worker_enrollment_identity_id,
			row.worker_enrollment_group_id,
			row.worker_enrollment_device_id,
			row.worker_enrollment_enabled,
			expiryValid ? 1 : 0,
			expiryValid ? expiryMs : 0,
			input.nowMs,
			input.grantId,
		],
	};
}

export function bootstrapAuthorizationResult(
	row: BootstrapAuthorizationRow | null,
): CoordinatorBootstrapGrantAuthorizationResult {
	if (!row) return rejectBootstrapAuthorization("bootstrap_authorization_unavailable");
	if (row.status !== "authorized") {
		const errors: CoordinatorBootstrapGrantAuthorizationError[] = [
			"grant_not_found",
			"seed_enrollment_not_found",
			"worker_enrollment_not_found",
			"grant_revoked",
			"grant_expired",
			"group_archived",
			"device_revoked",
			"bootstrap_authorization_unavailable",
		];
		if (!row.status || !errors.includes(row.status))
			return rejectBootstrapAuthorization("bootstrap_authorization_unavailable");
		return rejectBootstrapAuthorization(row.status);
	}
	const grant: CoordinatorBootstrapGrant = {
		grant_id: row.grant_id,
		group_id: row.group_id,
		seed_device_id: row.seed_device_id,
		worker_device_id: row.worker_device_id,
		expires_at: row.expires_at,
		created_at: row.created_at,
		created_by: row.created_by,
		revoked_at: row.revoked_at,
	};
	return {
		kind: "authorized",
		authorizationVersion: 1,
		grant,
		seedEnrollment: participant(row, "seed_enrollment"),
		workerEnrollment: participant(row, "worker_enrollment"),
	};
}
