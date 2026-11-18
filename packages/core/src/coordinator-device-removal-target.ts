import { isAuthControllerId } from "./coordinator-auth-controller.js";

/** A removal request names at most this many device IDs. */
export const DEVICE_REMOVAL_MAX_DEVICE_IDS = 8;
/** One removal deletes at most this many enrollments. */
export const DEVICE_REMOVAL_MAX_ENROLLMENTS = 50;
/**
 * The enrollment tuples of one removal, as JSON in UTF-8, stay under this size.
 * The commit binds them as one value, and D1 refuses a value above 2 MB.
 */
export const DEVICE_REMOVAL_MAX_TUPLE_BYTES = 1_000_000;

export interface CoordinatorDeviceRemovalPreviewInput {
	/** One to eight device IDs. Order and repetition do not matter. */
	deviceIds: readonly string[];
}

export interface CoordinatorDeviceRemovalEnrollment {
	readonly group_id: string;
	readonly device_id: string;
	readonly fingerprint: string;
	readonly display_name: string | null;
	readonly identity_id: string | null;
}

export type CoordinatorDeviceRemovalRefusal =
	| "removal_target_not_enrolled"
	| "removal_target_conflict"
	| "removal_target_too_large";

export type CoordinatorDeviceRemovalPreviewResult =
	| {
			kind: "ready";
			/** The request, without repetition and sorted. */
			device_ids: string[];
			/** The canonical key ID of the enrollments, or null for an opaque key. */
			key_id: string | null;
			/** Every enrollment the removal would delete, including those the key added. */
			enrollments: CoordinatorDeviceRemovalEnrollment[];
			/** Advice for the confirmation text. It authorizes nothing. */
			rejoin: "invitation" | "sign_in" | "none";
			expected_digest: string;
	  }
	| { kind: "rejected"; error: CoordinatorDeviceRemovalRefusal };

/** Code unit order, which does not depend on the database's collation. */
export function byCodeUnit(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

/** The request's device IDs without repetition, sorted. Throws `invalid_input`. */
export function captureRemovalDeviceIds(input: unknown): string[] {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const { deviceIds } = source;
	if (
		!Array.isArray(deviceIds) ||
		deviceIds.length < 1 ||
		deviceIds.length > DEVICE_REMOVAL_MAX_DEVICE_IDS ||
		!deviceIds.every(isAuthControllerId)
	)
		throw new Error("invalid_input");
	return [...new Set(deviceIds as string[])].sort(byCodeUnit);
}

/**
 * Bind the device IDs once, as one JSON array. `named` holds every enrollment of
 * those IDs in any group. `targets` adds every enrollment whose key ID equals a
 * non-empty key ID of a named enrollment, under any device ID. An opaque key has
 * an empty key ID and adds nothing.
 */
export const TARGET_SET_SQL = `WITH ids AS (SELECT value AS device_id FROM json_each(?)),
named AS (SELECT * FROM enrolled_devices WHERE device_id IN (SELECT device_id FROM ids)),
targets AS (SELECT e.* FROM enrolled_devices e
  WHERE e.device_id IN (SELECT device_id FROM ids)
    OR (e.key_id <> '' AND e.key_id IN (SELECT key_id FROM named WHERE key_id <> '')))`;

export interface RemovalTargetStatement {
	sql: string;
	values: string[];
	read: true;
}

/**
 * Two reads for one transaction or batch: the counts that decide a refusal, and
 * the target enrollments. `availableSql` is the condition under which a removal
 * can be recorded at all. One row more than the limit is enough to know the set
 * is too large.
 */
export function removalTargetStatements(
	deviceIds: readonly string[],
	availableSql: string,
): RemovalTargetStatement[] {
	const values = [JSON.stringify(deviceIds)];
	return [
		{
			sql: `${TARGET_SET_SQL}
SELECT (${availableSql}) AS available,
(SELECT COUNT(*) FROM named) AS named,
(SELECT COUNT(DISTINCT key_id) FROM named WHERE key_id <> '') AS canonical_keys,
(SELECT COUNT(DISTINCT public_key) FROM named WHERE key_id = '') AS opaque_texts,
(SELECT COUNT(*) FROM targets) AS targets,
EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b
  WHERE b.device_id IN (SELECT device_id FROM targets)
    OR b.key_id IN (SELECT key_id FROM named WHERE key_id <> '')) AS bound`,
			values,
			read: true,
		},
		{
			sql: `${TARGET_SET_SQL}
SELECT group_id, device_id, public_key, fingerprint, key_id, display_name, identity_id
FROM targets ORDER BY group_id, device_id LIMIT ${DEVICE_REMOVAL_MAX_ENROLLMENTS + 1}`,
			values,
			read: true,
		},
	];
}

export interface RemovalTargetState {
	available: number;
	named: number;
	canonical_keys: number;
	opaque_texts: number;
	targets: number;
	bound: number;
}

export interface RemovalTargetRow extends CoordinatorDeviceRemovalEnrollment {
	readonly public_key: string;
	/** Empty for an opaque key. */
	readonly key_id: string;
}

/** `[group_id, device_id, public_key, fingerprint, key_id]`, with null for an opaque key. */
export type RemovalTuple = [string, string, string, string, string | null];

export interface DeviceRemovalTarget {
	deviceIds: string[];
	keyId: string | null;
	/** Sorted by group ID, then device ID. */
	rows: RemovalTargetRow[];
	tuples: RemovalTuple[];
	/** An ownership binding names a target device ID or the key. */
	bound: boolean;
}

const COUNTS: readonly (keyof RemovalTargetState)[] = [
	"available",
	"named",
	"canonical_keys",
	"opaque_texts",
	"targets",
	"bound",
];

/** The refusal that the counts alone decide, in the order the contract gives, or null. */
function refusalByCounts(state: RemovalTargetState): CoordinatorDeviceRemovalRefusal | null {
	if (state.named === 0) return "removal_target_not_enrolled";
	const keys = state.canonical_keys;
	const texts = state.opaque_texts;
	if (keys > 1 || texts > 1 || (keys > 0 && texts > 0)) return "removal_target_conflict";
	if (state.targets > DEVICE_REMOVAL_MAX_ENROLLMENTS) return "removal_target_too_large";
	return null;
}

function isTargetRow(row: unknown): row is RemovalTargetRow {
	if (!row || typeof row !== "object") return false;
	const value = row as Record<string, unknown>;
	const text = ["group_id", "device_id", "public_key", "fingerprint", "key_id"];
	const optional = ["display_name", "identity_id"];
	return (
		text.every((field) => typeof value[field] === "string") &&
		optional.every((field) => value[field] === null || typeof value[field] === "string")
	);
}

/**
 * Decides the target set from the two reads. Returns the refusal code, the
 * target, or null for reads that do not describe one consistent set of an
 * available removal. The caller has already refused an unavailable one.
 */
export function readRemovalTarget(
	deviceIds: string[],
	state: RemovalTargetState | undefined,
	rows: readonly unknown[],
): CoordinatorDeviceRemovalRefusal | DeviceRemovalTarget | null {
	if (!state || COUNTS.some((count) => !Number.isSafeInteger(state[count]))) return null;
	if (state.available !== 1) return null;
	const refusal = refusalByCounts(state);
	if (refusal) return refusal;
	if (rows.length !== state.targets || !rows.every(isTargetRow)) return null;
	const sorted = [...rows].sort(
		(a, b) => byCodeUnit(a.group_id, b.group_id) || byCodeUnit(a.device_id, b.device_id),
	);
	const keyId = sorted.find((row) => row.key_id !== "")?.key_id ?? null;
	if ((keyId === null) !== (state.canonical_keys === 0)) return null;
	const tuples = sorted.map(
		(row): RemovalTuple => [
			row.group_id,
			row.device_id,
			row.public_key,
			row.fingerprint,
			row.key_id || null,
		],
	);
	const bytes = new TextEncoder().encode(JSON.stringify(tuples)).byteLength;
	if (bytes > DEVICE_REMOVAL_MAX_TUPLE_BYTES) return "removal_target_too_large";
	return { deviceIds, keyId, rows: sorted, tuples, bound: state.bound === 1 };
}

/**
 * What a commit must present to remove exactly the previewed set: SHA-256 over
 * an action and version domain, the request's device IDs, the key ID, and each
 * enrollment tuple. Both stores compute it here, from values sorted here. It is
 * not a secret or an access token.
 */
export async function deviceRemovalDigest(
	target: Pick<DeviceRemovalTarget, "deviceIds" | "keyId" | "tuples">,
): Promise<string> {
	const text = JSON.stringify([
		"codemem-device-removal",
		1,
		"remove",
		target.deviceIds,
		target.keyId,
		target.tuples,
	]);
	const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function removalPreviewEnrollments(
	rows: readonly RemovalTargetRow[],
): CoordinatorDeviceRemovalEnrollment[] {
	return rows.map(({ group_id, device_id, fingerprint, display_name, identity_id }) => ({
		group_id,
		device_id,
		fingerprint,
		display_name,
		identity_id,
	}));
}
