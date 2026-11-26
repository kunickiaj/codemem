import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";

export interface CoordinatorPeerRemovalLookupInput {
	peers: readonly { deviceId: string; publicKey?: string }[];
	/**
	 * The signed caller and the group it was authenticated in. Key evidence is
	 * given only for devices that are or were enrolled in a group the caller is
	 * enrolled in now. Without a caller, no key evidence is given.
	 */
	caller?: { groupId: string; deviceId: string };
}
/**
 * What the coordinator holds for the exact key each ID was sent with, limited to
 * devices related to the caller: the ID and key are, or were, enrolled together
 * in a group where the caller holds an enabled enrollment with its current key,
 * and the group is not archived. That is the group membership peer discovery
 * uses. Both lists only ever state a positive fact. An ID in neither list has no
 * evidence, which a client must not read as "not removed" or "not enrolled".
 * Revoked IDs, entries sent without a key and unrelated devices never appear.
 */
export interface CoordinatorPeerKeyEvidence {
	/**
	 * IDs whose sent key was removed under that ID in a shared group, with no
	 * surviving enrollment of that key anywhere.
	 */
	removed: string[];
	/**
	 * IDs whose sent key is enabled under that ID in a shared group. Every entry
	 * the request sent for the ID must say so.
	 */
	enrolled: string[];
}
export interface CoordinatorPeerRemovalLookupResult {
	revoked: string[];
	removed: string[];
	enrolled: string[];
	removal_seq: number;
	key_evidence: CoordinatorPeerKeyEvidence;
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

/** The caller, or null when the lookup has no signed caller to relate devices to. */
export function capturePeerRemovalCaller(
	raw: CoordinatorPeerRemovalLookupInput,
): { groupId: string; deviceId: string } | null {
	const caller = raw?.caller;
	if (caller === undefined) return null;
	if (
		!caller ||
		typeof caller !== "object" ||
		typeof caller.groupId !== "string" ||
		caller.groupId.length === 0 ||
		!isAuthControllerId(caller.deviceId)
	)
		throw new Error("invalid_input");
	return { groupId: caller.groupId, deviceId: caller.deviceId };
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

/** Matches the entry's own key only, never its ID. A keyless entry matches nothing. */
const KEY_MATCH_SQL = (row: string) => `((i.key_id IS NOT NULL AND ${row}.key_id = i.key_id)
OR (i.public_key IS NOT NULL AND i.key_id IS NULL AND ${row}.public_key = i.public_key))`;

/**
 * Groups the caller is enrolled in now: enabled, under the key it was
 * authenticated with in the requested group, in a group that is not archived.
 * These are the groups whose enabled devices peer discovery would show it.
 */
const CALLER_GROUPS_SQL = `SELECT c.group_id FROM doc
JOIN enrolled_devices own ON own.group_id = json_extract(doc.value, '$.caller.groupId')
  AND own.device_id = json_extract(doc.value, '$.caller.deviceId') AND own.enabled = 1
JOIN enrolled_devices c ON c.device_id = own.device_id AND c.enabled = 1 AND c.key_id = own.key_id
JOIN groups g ON g.group_id = c.group_id AND g.archived_at IS NULL`;

/** The sent key was removed under the sent ID in a shared group, and no enrollment of it survives. */
const KEY_REMOVED_SQL = `EXISTS (SELECT 1 FROM caller_groups cg
JOIN coordinator_device_removals t ON t.group_id = cg.group_id AND t.device_id = i.device_id
WHERE t.lifted_at IS NULL AND ${KEY_MATCH_SQL("t")} AND NOT EXISTS (
  SELECT 1 FROM enrolled_devices surviving WHERE
  (t.key_id IS NOT NULL AND surviving.key_id = t.key_id)
  OR (t.key_id IS NULL AND surviving.public_key = t.public_key)))`;

/** The sent key is enabled under the sent ID in a shared group. */
const KEY_ENROLLED_SQL = `EXISTS (SELECT 1 FROM caller_groups cg
JOIN enrolled_devices e ON e.group_id = cg.group_id AND e.device_id = i.device_id
WHERE e.enabled = 1 AND ${KEY_MATCH_SQL("e")})`;

/** Exactly two reads in one backend batch, with one JSON parameter regardless of entry count. */
export function peerRemovalSnapshotStatements(
	entries: readonly Entry[],
	available: string,
	caller: { groupId: string; deviceId: string } | null = null,
) {
	return [
		{
			sql: `SELECT (${available}) AS available,
COALESCE((SELECT MAX(removal_seq) FROM coordinator_device_removals), 0) AS removal_seq`,
			values: [] as string[],
			read: true,
		},
		{
			sql: `WITH doc AS (SELECT ? AS value),
input AS (SELECT j.key AS entry,
json_extract(j.value, '$.deviceId') AS device_id,
json_extract(j.value, '$.publicKey') AS public_key,
json_extract(j.value, '$.keyId') AS key_id FROM doc, json_each(doc.value, '$.entries') j),
caller_groups AS (${CALLER_GROUPS_SQL})
SELECT i.entry, (${REVOKED_SQL}) AS revoked, (${REMOVED_SQL}) AS removed,
EXISTS (SELECT 1 FROM enrolled_devices e WHERE ${MATCH_SQL("e")}) AS enrolled,
(${KEY_REMOVED_SQL}) AS key_removed, (${KEY_ENROLLED_SQL}) AS key_enrolled
FROM input i ORDER BY i.entry`,
			values: [JSON.stringify({ entries, caller })],
			read: true,
		},
	];
}

const FLAGS = ["revoked", "removed", "enrolled", "key_removed", "key_enrolled"] as const;
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
		key_removed: new Set<string>(),
		key_enrolled: new Set<string>(),
	};
	// An ID sent more than once counts as enrolled by key only when every entry shows it.
	const notKeyEnrolled = new Set<string>();
	for (const [index, raw] of rows.entries()) {
		const row = flagRow(raw, index);
		const entry = entries[index];
		if (!entry) throw new Error("device_removal_incomplete");
		for (const field of FLAGS) {
			if (row[field] === 1) sets[field].add(entry.deviceId);
		}
		if (entry.publicKey === null || row.key_enrolled !== 1) notKeyEnrolled.add(entry.deviceId);
	}
	return {
		revoked: [...sets.revoked].sort(),
		removed: [...sets.removed].filter((id) => !sets.revoked.has(id)).sort(),
		enrolled: [...sets.enrolled].sort(),
		removal_seq: state.removal_seq,
		// A blocked ID gets no key evidence: the legacy reply reports it only as revoked.
		key_evidence: {
			removed: [...sets.key_removed].filter((id) => !sets.revoked.has(id)).sort(),
			enrolled: [...sets.key_enrolled]
				.filter((id) => !notKeyEnrolled.has(id) && !sets.revoked.has(id))
				.sort(),
		},
	};
}
