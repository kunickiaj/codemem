import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";

export interface CoordinatorPeerRemovalLookupInput {
	peers: readonly { deviceId: string; publicKey?: string }[];
}
export interface CoordinatorPeerRemovalLookupResult {
	revoked: string[];
	removed: string[];
	enrolled: string[];
	removal_seq: number;
}
interface Entry {
	deviceId: string;
	publicKey: string | null;
	keyId: string | null;
}
const MAX_ENTRIES = 25;

/** Capture every entry before hashing can yield; preserve the existing metadata key parser. */
export async function capturePeerRemovalLookup(
	raw: CoordinatorPeerRemovalLookupInput,
): Promise<Entry[]> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_input");
	const input = raw.peers;
	if (!Array.isArray(input) || input.length > MAX_ENTRIES) throw new Error("invalid_input");
	const peers: { deviceId: string; publicKey: string | null }[] = [];
	for (const entry of input.slice(0, MAX_ENTRIES)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error("invalid_input");
		const { deviceId, publicKey } = entry;
		if (
			!isAuthControllerId(deviceId) ||
			(publicKey !== undefined &&
				(typeof publicKey !== "string" ||
					publicKey.length === 0 ||
					publicKey.length > 4096 ||
					publicKey.includes("\0")))
		)
			throw new Error("invalid_input");
		peers.push({ deviceId, publicKey: publicKey ?? null });
	}
	return Promise.all(
		peers.map(async (peer) => ({
			...peer,
			keyId: peer.publicKey === null ? null : await ed25519KeyIdForRevocation(peer.publicKey),
		})),
	);
}

const REVOKED_SQL = DEVICE_REVOCATION_SUBJECT_EXISTS_SQL.replace("?", "i.device_id").replace(
	"?",
	"i.key_id",
);
const MATCH_SQL = (row: string) => `(${row}.device_id = i.device_id
OR (i.key_id IS NOT NULL AND ${row}.key_id = i.key_id)
OR (i.public_key IS NOT NULL AND i.key_id IS NULL AND ${row}.public_key = i.public_key))`;

/**
 * A keyless request matches a tombstone only by ID. Its recorded key is used
 * solely to decide whether that particular removal still has an enrollment.
 * One surviving historical key cannot hide another effective removal.
 */
const REMOVED_SQL = `EXISTS (SELECT 1 FROM coordinator_device_removals t
WHERE t.lifted_at IS NULL AND ${MATCH_SQL("t")} AND NOT EXISTS (
  SELECT 1 FROM enrolled_devices surviving WHERE
  (t.key_id IS NOT NULL AND surviving.key_id = t.key_id)
  OR (t.key_id IS NULL AND surviving.public_key = t.public_key)))`;

/** Exactly two reads in one backend batch, with one JSON parameter regardless of entry count. */
export function peerRemovalSnapshotStatements(entries: readonly Entry[], available: string) {
	return [
		{
			sql: `SELECT (${available}) AS available,
COALESCE((SELECT MAX(removal_seq) FROM coordinator_device_removals), 0) AS removal_seq`,
			values: [] as string[],
			read: true,
		},
		{
			sql: `WITH input AS (SELECT j.key AS entry,
json_extract(j.value, '$.deviceId') AS device_id,
json_extract(j.value, '$.publicKey') AS public_key,
json_extract(j.value, '$.keyId') AS key_id FROM json_each(?) j)
SELECT i.entry, (${REVOKED_SQL}) AS revoked, (${REMOVED_SQL}) AS removed,
EXISTS (SELECT 1 FROM enrolled_devices e WHERE ${MATCH_SQL("e")}) AS enrolled
FROM input i ORDER BY i.entry`,
			values: [JSON.stringify(entries)],
			read: true,
		},
	];
}

const FLAGS = ["revoked", "removed", "enrolled"] as const;
function flagRow(raw: unknown, index: number): Record<(typeof FLAGS)[number], 0 | 1> {
	if (!raw || typeof raw !== "object") throw new Error("device_removal_incomplete");
	const row = raw as Record<string, unknown>;
	if (row.entry !== index || FLAGS.some((field) => row[field] !== 0 && row[field] !== 1))
		throw new Error("device_removal_incomplete");
	return row as Record<(typeof FLAGS)[number], 0 | 1>;
}

/** No backend evidence or IDs are copied into the result; IDs come only from captured entries. */
export function peerRemovalSnapshotResult(
	entries: readonly Entry[],
	state: { available: number; removal_seq: number },
	rows: unknown[],
): CoordinatorPeerRemovalLookupResult {
	if (
		!Number.isSafeInteger(state.removal_seq) ||
		state.removal_seq < 0 ||
		rows.length !== entries.length
	)
		throw new Error("device_removal_incomplete");
	const sets = {
		revoked: new Set<string>(),
		removed: new Set<string>(),
		enrolled: new Set<string>(),
	};
	for (const [index, raw] of rows.entries()) {
		const row = flagRow(raw, index);
		const entry = entries[index];
		if (!entry) throw new Error("device_removal_incomplete");
		for (const field of FLAGS) {
			if (row[field] === 1) sets[field].add(entry.deviceId);
		}
	}
	return {
		revoked: [...sets.revoked].sort(),
		removed: [...sets.removed].filter((id) => !sets.revoked.has(id)).sort(),
		enrolled: [...sets.enrolled].sort(),
		removal_seq: state.removal_seq,
	};
}
