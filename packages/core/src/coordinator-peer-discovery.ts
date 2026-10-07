export interface CapturedPeerEnrollment {
	readonly group_id: string;
	readonly device_id: string;
	readonly public_key: string;
	readonly fingerprint: string;
	readonly identity_id: string | null;
	readonly enabled: number;
}

export const CAPTURE_PEER_ENROLLMENTS_SQL = `SELECT group_id, device_id, public_key,
	fingerprint, identity_id, enabled FROM enrolled_devices
	WHERE group_id = ? AND enabled = 1 AND device_id != ?
	ORDER BY device_id ASC`;

/** Copy every primitive before async hashing can yield to enrollment changes. */
export function capturePeerEnrollments(
	rows: readonly CapturedPeerEnrollment[],
): CapturedPeerEnrollment[] {
	return rows.map((row) => ({
		group_id: row.group_id,
		device_id: row.device_id,
		public_key: row.public_key,
		fingerprint: row.fingerprint,
		identity_id: row.identity_id,
		enabled: row.enabled,
	}));
}

// One JSON parameter keeps the bind count constant even for large groups. Only
// unchanged captured candidates survive; metadata and presence come from this read.
export const READ_CURRENT_PEERS_SQL = `SELECT e.device_id, e.public_key, e.fingerprint,
	e.display_name, p.addresses_json, p.last_seen_at, p.expires_at, p.capabilities_json
	FROM json_each(?) AS captured
	JOIN enrolled_devices AS e
	  ON e.group_id = json_extract(captured.value, '$.group_id')
	 AND e.device_id = json_extract(captured.value, '$.device_id')
	 AND e.public_key = json_extract(captured.value, '$.public_key')
	 AND e.fingerprint = json_extract(captured.value, '$.fingerprint')
	 AND e.identity_id IS json_extract(captured.value, '$.identity_id')
	 AND e.enabled = json_extract(captured.value, '$.enabled')
	LEFT JOIN presence_records AS p
	  ON p.group_id = e.group_id AND p.device_id = e.device_id
	WHERE e.group_id = ? AND e.enabled = 1 AND e.device_id != ?
	  AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations AS r WHERE
	    (r.subject_kind = 'device_id' AND r.subject_value = e.device_id)
	    OR (r.subject_kind = 'ed25519_key'
	        AND r.subject_value = json_extract(captured.value, '$.keyId')))
	ORDER BY e.device_id ASC`;

/** A malformed backend response is not an empty discovery result. */
export function requirePeerDiscoveryRows(rows: unknown): Record<string, unknown>[] {
	if (!Array.isArray(rows)) throw new Error("peer_discovery_unavailable");
	for (const row of rows) requirePeerDiscoveryRow(row);
	return rows;
}

function requirePeerDiscoveryRow(row: unknown): void {
	if (!row || typeof row !== "object" || Array.isArray(row)) {
		throw new Error("peer_discovery_unavailable");
	}
	const record = row as Record<string, unknown>;
	for (const field of ["device_id", "public_key", "fingerprint"]) {
		if (typeof record[field] !== "string") throw new Error("peer_discovery_unavailable");
	}
	for (const field of [
		"display_name",
		"addresses_json",
		"last_seen_at",
		"expires_at",
		"capabilities_json",
	]) {
		if (record[field] !== null && typeof record[field] !== "string") {
			throw new Error("peer_discovery_unavailable");
		}
	}
}
