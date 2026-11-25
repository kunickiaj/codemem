import type { CoordinatorDeviceAuthLinkStore } from "./coordinator-device-auth-link.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";

type Source = CoordinatorStore & Pick<CoordinatorDeviceAuthLinkStore, "readDeviceRejoinBackend">;
type Device = { device_id: string; public_key: string; fingerprint: string };
type Marker = Device & { rejoined_at_ms: number };

function deviceKey(row: Device): string {
	return JSON.stringify([row.device_id, row.public_key, row.fingerprint]);
}

// A rejoin wrote the current enrollment only if its latest own removal links
// the exact group/key tuple and the enrollment was created by that lift.
const REJOIN_DISPLAY_SQL = `SELECT e.device_id, e.public_key, e.fingerprint,
	a.finalized_at_ms AS rejoined_at_ms
FROM enrolled_devices e
JOIN coordinator_device_removals r ON r.removal_seq = (
	SELECT max(r2.removal_seq) FROM coordinator_device_removals r2
	WHERE r2.device_id = e.device_id AND r2.group_id = e.group_id
)
JOIN coordinator_device_rejoin_attempts a ON a.attempt_id = r.lifted_by_attempt_id
	AND a.device_id = e.device_id AND a.key_id = e.key_id AND a.state = 'finalized'
JOIN coordinator_device_rejoin_audit_log l ON l.coordinator_id = a.coordinator_id
	AND l.attempt_id = a.attempt_id AND l.finalized_at_ms = a.finalized_at_ms
WHERE e.group_id = ? AND r.public_key = e.public_key AND r.fingerprint = e.fingerprint
	AND r.lifted_at = e.created_at
	AND EXISTS (SELECT 1 FROM json_each(a.final_receipt_json, '$.group_ids') g
		WHERE g.value = e.group_id)
	AND EXISTS (SELECT 1 FROM json_each(a.final_receipt_json, '$.lifted_removal_seqs') s
		WHERE s.value = r.removal_seq)`;

/** Display metadata must not prevent discovery on old or unavailable storage. */
export async function withDeviceRejoinDisplay<T extends Device>(
	store: Source,
	groupId: string,
	items: T[],
): Promise<(T & { rejoined_at_ms?: number })[]> {
	if (items.length === 0) return items;
	try {
		const backend = await store.readDeviceRejoinBackend?.();
		if (!backend?.all) return items;
		const rows = await backend.all<Marker>({ sql: REJOIN_DISPLAY_SQL, values: [groupId] });
		const markers = new Map(rows.map((row) => [deviceKey(row), row.rejoined_at_ms]));
		return items.map((item) => {
			const timestamp = markers.get(deviceKey(item));
			return timestamp === undefined ? item : { ...item, rejoined_at_ms: timestamp };
		});
	} catch {
		return items;
	}
}
