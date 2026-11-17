import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import type { Database } from "./db.js";
import {
	type DeviceIdentityInventoryItemV1,
	listDeviceIdentityInventory,
} from "./device-identity-inventory.js";
import { removePairingState } from "./pairing-removal.js";
import {
	canonicalKeyId,
	listRetiredDeviceAliases,
	retiredAliasApplies,
} from "./retired-device-aliases.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/*
 * One device can appear under several IDs that share a key: a local pairing, a
 * coordinator enrollment, and an Identity binding. Coordinator revocation blocks
 * the chosen enrollment's device ID and the key's canonical ID under every device
 * ID, so retirement works on the whole group. The group comes from the device
 * inventory Devices shows. Every safety check compares canonical key IDs, because
 * different key text can carry the same canonical key.
 */

export interface RetireTarget {
	/** Every ID in the device's inventory group except this device. */
	aliasDeviceIds: string[];
	displayName: string;
	fingerprint: string;
	/** The canonical key ID the coordinator revokes under every device ID. */
	keyId: string;
	/** The enrollment the coordinator needs as revocation evidence. */
	groupId: string;
	enrollmentDeviceId: string;
}

export type RetireTargetError =
	| "device_not_enrolled"
	| "cannot_retire_this_device"
	| "local_identity_unverified"
	| "device_already_retired"
	| "device_enrollment_conflict"
	| "device_key_unrecognized"
	| "device_evidence_incomplete";

export interface RetireTargetInput {
	localDeviceId: string;
	enrollments: CoordinatorEnrollment[];
	deviceId: string;
}

const FINGERPRINT_CONFLICTS = new Set(["fingerprint_conflict", "fingerprint_invalid"]);

/**
 * This device's canonical key ID, only when exactly one consistent identity row
 * exists for the ID the viewer runs as. Anything else can hide this device from
 * the inventory, so retirement refuses rather than guess.
 */
function verifiedLocalKeyId(db: Database, localDeviceId: string): string | null {
	const rows = db
		.prepare("SELECT device_id, public_key, fingerprint FROM sync_device")
		.all() as Array<{
		device_id: string;
		public_key: string | null;
		fingerprint: string | null;
	}>;
	const [row] = rows;
	if (rows.length !== 1 || !row || row.device_id !== localDeviceId || !row.public_key) return null;
	if (row.fingerprint !== fingerprintPublicKey(row.public_key)) return null;
	return canonicalKeyId(row.public_key);
}

function inventoryGroup(
	db: Database,
	input: RetireTargetInput,
): DeviceIdentityInventoryItemV1 | RetireTargetError {
	const inventory = listDeviceIdentityInventory(
		db,
		{
			localDeviceId: input.localDeviceId,
			coordinator: {
				availability: "available",
				safeErrorCode: null,
				enrollments: input.enrollments,
			},
		},
		{ limit: 2_000 },
	);
	if (inventory.truncated) return "device_evidence_incomplete";
	return (
		inventory.items.find((item) => item.evidenceDeviceIds.includes(input.deviceId)) ??
		"device_not_enrolled"
	);
}

function groupError(item: DeviceIdentityInventoryItemV1): RetireTargetError | null {
	if (item.isLocal) return "cannot_retire_this_device";
	if (item.state === "retired") return "device_already_retired";
	if (item.conflictCodes.some((code) => FINGERPRINT_CONFLICTS.has(code)))
		return "device_enrollment_conflict";
	if (!item.validatedFingerprint) return "device_enrollment_conflict";
	return null;
}

function pinnedKeys(
	db: Database,
): Array<{ deviceId: string; publicKey: string; fingerprint: string | null }> {
	return (
		db
			.prepare(
				"SELECT peer_device_id, public_key, pinned_fingerprint FROM sync_peers WHERE public_key IS NOT NULL",
			)
			.all() as Array<{
			peer_device_id: string;
			public_key: string;
			pinned_fingerprint: string | null;
		}>
	).map((row) => ({
		deviceId: row.peer_device_id,
		publicKey: row.public_key,
		fingerprint: row.pinned_fingerprint?.trim() || null,
	}));
}

/** True when evidence outside the group carries the same canonical key, which revocation would also block. */
function canonicalKeyCollides(
	db: Database,
	input: RetireTargetInput,
	group: Set<string>,
	keyId: string,
): boolean {
	const outside = [
		...input.enrollments.map((row) => ({ deviceId: row.device_id, publicKey: row.public_key })),
		...pinnedKeys(db),
	].filter((row) => !group.has(row.deviceId));
	return outside.some((row) => canonicalKeyId(row.publicKey) === keyId);
}

function alreadyRetired(db: Database, group: string[]): boolean {
	const aliases = listRetiredDeviceAliases(db);
	const pinned = new Map(pinnedKeys(db).map((row) => [row.deviceId, row]));
	return group.some((id) => retiredAliasApplies(aliases.get(id), pinned.get(id) ?? null));
}

function revocationEvidence(
	input: RetireTargetInput,
	item: DeviceIdentityInventoryItemV1,
	fingerprint: string,
): CoordinatorEnrollment | undefined {
	return input.enrollments
		.filter(
			(row) => item.evidenceDeviceIds.includes(row.device_id) && row.fingerprint === fingerprint,
		)
		.toSorted(
			(a, b) => a.group_id.localeCompare(b.group_id) || a.device_id.localeCompare(b.device_id),
		)[0];
}

/**
 * The full alias group for a device the person picked by any of its IDs, plus the
 * enrollment the coordinator revokes. Fails closed on any ambiguity.
 */
export function resolveRetireTarget(
	db: Database,
	input: RetireTargetInput,
): RetireTarget | RetireTargetError {
	const localKeyId = verifiedLocalKeyId(db, input.localDeviceId);
	if (!localKeyId) return "local_identity_unverified";
	if (input.deviceId === input.localDeviceId) return "cannot_retire_this_device";
	const item = inventoryGroup(db, input);
	if (typeof item === "string") return item;
	const error = groupError(item);
	if (error) return error;
	if (alreadyRetired(db, item.evidenceDeviceIds)) return "device_already_retired";
	const fingerprint = item.validatedFingerprint as string;
	const evidence = revocationEvidence(input, item, fingerprint);
	if (!evidence) return "device_not_enrolled";
	const keyId = canonicalKeyId(evidence.public_key);
	if (!keyId) return "device_key_unrecognized";
	if (keyId === localKeyId) return "cannot_retire_this_device";
	if (canonicalKeyCollides(db, input, new Set(item.evidenceDeviceIds), keyId))
		return "device_enrollment_conflict";
	return {
		aliasDeviceIds: item.evidenceDeviceIds.filter((id) => id !== input.localDeviceId),
		displayName: item.displayName,
		fingerprint,
		keyId,
		groupId: evidence.group_id,
		enrollmentDeviceId: evidence.device_id,
	};
}

/**
 * Deletes each revoked peer's pairing and cursors and ends its binding, whatever its
 * trust source. The coordinator doesn't say which subject matched, so each pinned key
 * is recorded as a key-only alias that a later pairing with a different key clears.
 */
export function removeRevokedPeers(
	db: Database,
	localDeviceId: string,
	peerDeviceIds: string[],
): number {
	const deviceIds = peerDeviceIds.filter((id) => id !== localDeviceId);
	if (deviceIds.length === 0) return 0;
	return removePairingState(db, { localDeviceId, reason: "revoked", deviceIds }).syncPeers;
}

/**
 * Whether the ID's current pairing, if any, still pins the revoked key. A pairing
 * can change while the coordinator commit is in flight, and the coordinator only
 * revoked the old key for an ID other than the enrollment's.
 */
function stillPinsRetiredKey(db: Database, deviceId: string, target: RetireTarget): boolean {
	const row = db
		.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.get(deviceId) as { public_key: string | null; pinned_fingerprint: string | null } | undefined;
	if (!row) return true;
	const revoked = { kind: "key" as const, fingerprint: target.fingerprint, keyId: target.keyId };
	return retiredAliasApplies(revoked, {
		publicKey: row.public_key,
		fingerprint: row.pinned_fingerprint,
	});
}

/**
 * After a confirmed coordinator revocation: record every alias that still carries
 * the revoked key, then unpair them and end their bindings. The enrollment's ID is
 * revoked outright.
 */
export function retireDeviceLocally(db: Database, localDeviceId: string, target: RetireTarget) {
	return db
		.transaction(() => {
			const deviceIds = target.aliasDeviceIds.filter(
				(id) =>
					id !== localDeviceId &&
					(id === target.enrollmentDeviceId || stillPinsRetiredKey(db, id, target)),
			);
			return removePairingState(db, {
				localDeviceId,
				reason: "revoked",
				deviceIds,
				retiredAliases: deviceIds.map((deviceId) => ({
					deviceId,
					// Only the evidence enrollment's ID is revoked outright; the others lose the key.
					kind: deviceId === target.enrollmentDeviceId ? ("device_id" as const) : ("key" as const),
					fingerprint: target.fingerprint,
					keyId: target.keyId,
				})),
			}).syncPeers;
		})
		.immediate();
}
