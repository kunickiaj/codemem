import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { verifyDeviceRejoinProof } from "./coordinator-device-rejoin-proof.js";
import {
	type DeviceRejoinStartInput,
	isFreshDeviceRejoinStart,
} from "./coordinator-device-rejoin-start-input.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";

// Keep ownership, revocation, and the complete active tombstone set in one snapshot.
const START_EVIDENCE_SQL = `WITH input(device_id, key_id, coordinator_id) AS (VALUES (?, ?, ?))
SELECT b.binding_id, b.identity_id,
 (SELECT json_group_array(json_array(removal_seq, group_id, public_key, fingerprint))
  FROM (SELECT removal_seq, group_id, public_key, fingerprint FROM coordinator_device_removals t
   WHERE t.lifted_at IS NULL AND t.device_id = i.device_id AND t.key_id = i.key_id
   ORDER BY removal_seq)) AS own_tombstones_json,
 (SELECT json_group_array(removal_seq)
  FROM (SELECT removal_seq FROM coordinator_device_removals t
   WHERE t.lifted_at IS NULL AND t.key_id = i.key_id AND t.device_id <> i.device_id
   ORDER BY removal_seq)) AS alias_removal_seqs_json
FROM input i JOIN coordinator_device_ownership_bindings b
 ON b.device_id = i.device_id AND b.key_id = i.key_id AND b.coordinator_id = i.coordinator_id
WHERE (SELECT COUNT(*) FROM coordinator_device_ownership_bindings other
 WHERE other.device_id = i.device_id OR other.key_id = i.key_id) = 1
AND NOT EXISTS (
 SELECT 1 FROM coordinator_device_removals t
 WHERE t.lifted_at IS NULL AND t.device_id = i.device_id AND t.key_id IS NOT i.key_id
)
AND NOT EXISTS (
 SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind = 'device_id' AND r.subject_value = i.device_id)
    OR (r.subject_kind = 'ed25519_key' AND r.subject_value = i.key_id)
)`;

type OwnTombstone = [removalSeq: number, groupId: string, publicKey: string, fingerprint: string];

function isRemovalSeq(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOwnTombstone(value: unknown): value is OwnTombstone {
	return (
		Array.isArray(value) &&
		value.length === 4 &&
		isRemovalSeq(value[0]) &&
		typeof value[1] === "string" &&
		typeof value[2] === "string" &&
		typeof value[3] === "string"
	);
}

function rejoinPins(row: Record<string, unknown>, deviceId: string, keyId: string) {
	const {
		binding_id: bindingId,
		identity_id: identityId,
		own_tombstones_json: ownJson,
		alias_removal_seqs_json: aliasJson,
	} = row;
	if (
		typeof bindingId !== "string" ||
		typeof identityId !== "string" ||
		typeof ownJson !== "string" ||
		typeof aliasJson !== "string"
	)
		return null;
	const ownTombstones: unknown = JSON.parse(ownJson);
	const aliasRemovalSeqs: unknown = JSON.parse(aliasJson);
	if (
		!Array.isArray(ownTombstones) ||
		ownTombstones.length === 0 ||
		!ownTombstones.every(isOwnTombstone) ||
		!Array.isArray(aliasRemovalSeqs) ||
		!aliasRemovalSeqs.every(isRemovalSeq)
	)
		return null;
	return { bindingId, identityId, deviceId, keyId, ownTombstones, aliasRemovalSeqs };
}

/**
 * Verifies a parsed start request against current removal evidence. A null result
 * gives no reason for refusal. The future writer must still compare these pins
 * and check live admission policy in the statement that creates the attempt.
 */
export async function readVerifiedRejoinStartEvidence(
	backend: Pick<AuthLinkBackend, "first">,
	config: { coordinatorId: string | null; origin: string },
	input: DeviceRejoinStartInput,
	now: number,
) {
	const { coordinatorId, origin } = config;
	const { signature, ...proof } = input;
	if (!isAuthControllerId(coordinatorId) || !isFreshDeviceRejoinStart(proof.timestampMs, now))
		return null;
	const keyId = await ed25519KeyId(proof.publicKey);
	if (!keyId) return null;
	const row = await backend.first<Record<string, unknown>>({
		sql: START_EVIDENCE_SQL,
		values: [proof.deviceId, keyId, coordinatorId],
	});
	const pins = row ? rejoinPins(row, proof.deviceId, keyId) : null;
	const first = pins?.ownTombstones[0];
	if (!pins || !first) return null;
	if (
		!(await verifyDeviceRejoinProof(
			{ ...proof, operation: "start", origin, keyId },
			{ tombstonePublicKey: first[2], signature },
		))
	)
		return null;
	for (const publicKey of new Set(pins.ownTombstones.map((tombstone) => tombstone[2]))) {
		if (publicKey !== first[2] && (await ed25519KeyId(publicKey)) !== keyId) return null;
	}
	const encoded = JSON.stringify([
		[pins.bindingId, pins.identityId, pins.deviceId, pins.keyId],
		pins.ownTombstones,
		pins.aliasRemovalSeqs,
	]);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
	const removalDigest = Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	return { ...pins, removalDigest };
}
