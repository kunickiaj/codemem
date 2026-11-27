import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { removalDependentStatements } from "./coordinator-device-removal-dependents.js";
import {
	captureRemovalDeviceIds,
	DEVICE_REMOVAL_MAX_TUPLE_BYTES,
	type DeviceRemovalTarget,
	TARGET_SET_SQL,
} from "./coordinator-device-removal-target.js";

export interface CoordinatorRemoveDeviceEnrollmentsInput {
	deviceIds: readonly string[];
	expectedDigest: string;
	actorId?: string | null;
}
export type CoordinatorRemoveDeviceEnrollmentsResult =
	| { kind: "rejected"; error: "removal_preview_stale" }
	| {
			kind: "removed";
			removal_id: string;
			removal_seq: number;
			device_ids: string[];
			key_id: string | null;
			removals: { removal_seq: number; group_id: string; device_id: string }[];
	  };

export function captureRemovalCommit(raw: CoordinatorRemoveDeviceEnrollmentsInput) {
	const deviceIds = captureRemovalDeviceIds(raw);
	const expectedDigest = raw.expectedDigest;
	const actorId = raw.actorId ?? null;
	if (
		typeof expectedDigest !== "string" ||
		!/^[a-f0-9]{64}$/u.test(expectedDigest) ||
		(actorId !== null && !isAuthControllerId(actorId))
	)
		throw new Error("invalid_input");
	return { deviceIds, expectedDigest, actorId };
}

/** Each pair makes an indexed active-tombstone lookup. The outer alias uses primary-key seeks. */
export const REMOVAL_OWN_SET_SQL = `SELECT owned.removal_seq
FROM json_each(?) p CROSS JOIN coordinator_device_removals owned
  INDEXED BY idx_coordinator_device_removals_active
WHERE owned.group_id = json_extract(p.value, '$[0]')
  AND owned.device_id = json_extract(p.value, '$[1]')
  AND owned.lifted_at IS NULL AND owned.removal_id = ?`;
const OWN_SQL = "t.removal_seq IN (SELECT removal_seq FROM own)";
const OWN_CTE = `WITH own AS MATERIALIZED (${REMOVAL_OWN_SET_SQL}) `;
const TUPLE_COLUMNS = "group_id, device_id, public_key, fingerprint, NULLIF(key_id, '')";
const EXPECTED_SQL = `expected AS MATERIALIZED (SELECT
json_extract(value, '$[0]') AS group_id, json_extract(value, '$[1]') AS device_id,
json_extract(value, '$[2]') AS public_key, json_extract(value, '$[3]') AS fingerprint,
json_extract(value, '$[4]') AS key_id FROM json_each(?))`;
const SAME_SET_SQL = `NOT EXISTS (SELECT ${TUPLE_COLUMNS} FROM targets
EXCEPT SELECT ${TUPLE_COLUMNS} FROM expected)
AND NOT EXISTS (SELECT ${TUPLE_COLUMNS} FROM expected
EXCEPT SELECT ${TUPLE_COLUMNS} FROM targets)`;

interface Statement {
	sql: string;
	values: (string | number | null)[];
	read?: boolean;
}
interface CommitOperation {
	removalId: string;
	actorId: string | null;
	now: string;
}

/**
 * The first write validates availability and the entire live set in both
 * directions. An invalid JSON path names the refusal in the backend error.
 * LIMIT evaluates before row iteration, including when targets is empty.
 */
function insertStatement(
	target: DeviceRemovalTarget,
	op: CommitOperation,
	available: string,
): Statement {
	const tuples = JSON.stringify(target.tuples);
	if (new TextEncoder().encode(tuples).byteLength > DEVICE_REMOVAL_MAX_TUPLE_BYTES)
		throw new Error("removal_target_too_large");
	return {
		sql: `${TARGET_SET_SQL}, ${EXPECTED_SQL}
INSERT INTO coordinator_device_removals(removal_id, group_id, device_id, public_key,
fingerprint, key_id, identity_id, display_name, actor_id, removed_at)
SELECT ?, e.group_id, e.device_id, e.public_key, e.fingerprint, NULLIF(e.key_id, ''),
e.identity_id, e.display_name, ?, ? FROM targets e
LIMIT CASE WHEN NOT (${available}) THEN json_extract('{}', 'device_removal_unavailable')
WHEN NOT (${SAME_SET_SQL}) THEN json_extract('{}', 'removal_preview_stale') ELSE -1 END`,
		values: [JSON.stringify(target.deviceIds), tuples, op.removalId, op.actorId, op.now],
	};
}

const EXISTS_OWN = (condition: string) =>
	`EXISTS (SELECT 1 FROM coordinator_device_removals t WHERE ${OWN_SQL} AND ${condition})`;
function deletionStatements(): Statement[] {
	return [
		{
			sql: `DELETE FROM presence_records AS e WHERE ${EXISTS_OWN(
				"t.group_id = e.group_id AND t.device_id = e.device_id",
			)}`,
			values: [],
		},
		{
			sql: `DELETE FROM coordinator_reciprocal_approvals AS e WHERE ${EXISTS_OWN(
				"t.group_id = e.group_id AND t.device_id IN (e.requesting_device_id, e.requested_device_id)",
			)}`,
			values: [],
		},
		{
			sql: `DELETE FROM enrolled_devices AS e WHERE ${EXISTS_OWN(
				"t.group_id = e.group_id AND t.device_id = e.device_id AND t.public_key = e.public_key",
			)}`,
			values: [],
		},
	];
}

function completeStatement(count: number, dependentCheck: Statement): Statement {
	const remaining = [
		"EXISTS (SELECT 1 FROM enrolled_devices e WHERE e.group_id = t.group_id AND e.device_id = t.device_id)",
		"EXISTS (SELECT 1 FROM presence_records e WHERE e.group_id = t.group_id AND e.device_id = t.device_id)",
		`EXISTS (SELECT 1 FROM coordinator_reciprocal_approvals e WHERE e.group_id = t.group_id
AND t.device_id IN (e.requesting_device_id, e.requested_device_id))`,
	].join(" OR ");
	return {
		sql: `SELECT CASE WHEN (SELECT COUNT(*) FROM own) <> ?
OR ${EXISTS_OWN(`(${remaining})`)} OR (${dependentCheck.sql}) <> 1
THEN json('device_removal_incomplete') ELSE 1 END AS complete`,
		values: [count],
		read: true,
	};
}

/** Ten writes and three reads, independent of the number of enrollments. */
export function removalCommitStatements(
	target: DeviceRemovalTarget,
	op: CommitOperation,
	available: string,
): Statement[] {
	const pairs = JSON.stringify(target.rows.map((row) => [row.group_id, row.device_id]));
	const ownValues = [pairs, op.removalId];
	const dependents = removalDependentStatements({ sql: OWN_SQL, values: [] }, op);
	const following = [
		...deletionStatements(),
		...dependents.writes,
		completeStatement(target.rows.length, dependents.complete),
		{
			sql: `SELECT t.removal_seq, t.group_id, t.device_id
FROM coordinator_device_removals t WHERE ${OWN_SQL} ORDER BY t.group_id, t.device_id`,
			values: [],
			read: true,
		},
		{ sql: `SELECT (${available}) AS available`, values: [], read: true },
		dependents.invalidate,
	];
	return [
		insertStatement(target, op, available),
		...following.map((statement) => ({
			...statement,
			sql: OWN_CTE + statement.sql,
			values: [...ownValues, ...statement.values],
		})),
	];
}

/** Only this operation's deliberate first-write refusal paths become typed errors. */
export function removalCommitRefusal(error: unknown): string | null {
	if (!(error instanceof Error)) return null;
	const match =
		/^(?:D1_ERROR: )?bad JSON path: '(device_removal_unavailable|removal_preview_stale)'(?:: SQLITE_ERROR)?$/u.exec(
			error.message,
		);
	return match?.[1] ?? null;
}
