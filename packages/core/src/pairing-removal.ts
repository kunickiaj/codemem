import type { Database } from "./db.js";
import { wakeRecipientPoliciesForIdentities } from "./device-identity-binding.js";
import { retainRetirementPeerTrust } from "./memory-retirement-trust.js";
import { canonicalKeyId, recordRetiredDeviceAliases } from "./retired-device-aliases.js";
import { endRetainedScopeAuthorization } from "./scope-membership-evidence.js";
import { deletePeerSyncChannelProgress } from "./sync-channel-progress.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import {
	clearUnpairedPeerPins,
	readUnpairedPeerPin,
	recordUnpairedPeerPin,
} from "./unpaired-peer-pin.js";

/*
 * The only code that deletes a pairing. A pairing's sync progress lives in three
 * tables: the two replication cursor tables and the channel pass's per-scope
 * progress. Progress left behind makes a later pairing with the same device ID
 * resume from the old position and skip history in that direction. Every removal
 * therefore deletes the pairing and all of its progress in one transaction.
 *
 * Removal also ends the device's Identity binding by status, unless the reason
 * is `disconnect` or `policy`. The row stays, because deleting it would delete
 * the device's per-Team decisions and a later rejoin would then widen access
 * past a recorded exclusion.
 *
 * The same reasons end the device's cached scope authorization on every scope.
 * Without it a bootstrap grant could recreate the pairing and the cached
 * membership would authorize the device again. A later coordinator refresh
 * restores what the coordinator still grants, so a rejoin regains access.
 */

export type RetiredDeviceAliasRecord = Parameters<typeof recordRetiredDeviceAliases>[1][number];

/** A coordinator-policy pairing, named by the discovery fields its cleanup requires. */
export interface PolicyPairing {
	deviceId: string;
	coordinatorId: string;
	groupId: string;
}

export type PairingRemoval =
	/** The coordinator removed the device, or this device removed it locally. It may pair again. */
	| { reason: "removed" | "local"; deviceIds: string[] }
	/**
	 * This device withdrew its own connection to the device. The binding stays active,
	 * because this device may not change the other device's access.
	 */
	| { reason: "disconnect"; deviceIds: string[] }
	/**
	 * The coordinator blocked the device. Without `retiredAliases`, each validated
	 * pinned key is recorded as a key-only alias.
	 */
	| { reason: "revoked"; deviceIds: string[]; retiredAliases?: RetiredDeviceAliasRecord[] }
	/** A coordinator-policy pairing lost its last shared Project. Its binding stays active. */
	| { reason: "policy"; pairings: PolicyPairing[] };

/** Rows changed in each table. */
export interface PairingRemovalCounts {
	syncPeers: number;
	replicationCursors: number;
	replicationCursorsV2: number;
	syncChannelProgress: number;
	/** Bindings whose status changed from `active` to `removed`. */
	identityDevices: number;
}

export type PairingRemovalInput = PairingRemoval & { localDeviceId: string };

/**
 * The peer's pinned key as a key-only alias, only when its fingerprint matches the stored key.
 * A device this device unpaired has no pairing, so its recorded pin stands in.
 */
function pinnedKeyAlias(
	db: Database,
	localDeviceId: string,
	deviceId: string,
): RetiredDeviceAliasRecord[] {
	const live = db
		.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.get(deviceId) as { public_key: string | null; pinned_fingerprint: string | null } | undefined;
	const recorded = live ? null : readUnpairedPeerPin(db, { localDeviceId, peerDeviceId: deviceId });
	const row = live ?? {
		public_key: recorded?.publicKey ?? null,
		pinned_fingerprint: recorded?.pinnedFingerprint ?? null,
	};
	if (!row.public_key || !row.pinned_fingerprint) return [];
	if (fingerprintPublicKey(row.public_key) !== row.pinned_fingerprint) return [];
	return [
		{
			deviceId,
			kind: "key",
			fingerprint: row.pinned_fingerprint,
			keyId: canonicalKeyId(row.public_key),
		},
	];
}

function deletePairing(db: Database, deviceId: string): number {
	return db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(deviceId).changes;
}

/** Deletes only a row that is still the policy-derived pairing the caller selected. */
function deletePolicyPairing(db: Database, pairing: PolicyPairing): number {
	return db
		.prepare(
			`DELETE FROM sync_peers
			 WHERE peer_device_id = ? AND claimed_local_actor = 0
			 AND actor_id IS NULL AND pending_bootstrap_grant_id IS NULL
			 AND trust_provenance = 'coordinator_policy'
			 AND discovered_via_coordinator_id = ? AND discovered_via_group_id = ?`,
		)
		.run(pairing.deviceId, pairing.coordinatorId, pairing.groupId).changes;
}

function deleteSyncProgress(db: Database, deviceId: string) {
	return {
		replicationCursors: db
			.prepare("DELETE FROM replication_cursors WHERE peer_device_id = ?")
			.run(deviceId).changes,
		replicationCursorsV2: db
			.prepare("DELETE FROM replication_cursors_v2 WHERE peer_device_id = ?")
			.run(deviceId).changes,
		syncChannelProgress: deletePeerSyncChannelProgress(db, deviceId),
	};
}

/** Ends the device's active binding and returns its Identity, or null when none was active. */
function endBinding(db: Database, deviceId: string, now: string): string | null {
	const ended = db
		.prepare(
			`UPDATE identity_devices SET status = 'removed', updated_at = ?
			 WHERE device_id = ? AND status = 'active' RETURNING identity_id`,
		)
		.get(now, deviceId) as { identity_id: string } | undefined;
	return ended?.identity_id ?? null;
}

function addCounts(
	total: PairingRemovalCounts,
	part: Omit<PairingRemovalCounts, "identityDevices">,
): void {
	total.syncPeers += part.syncPeers;
	total.replicationCursors += part.replicationCursors;
	total.replicationCursorsV2 += part.replicationCursorsV2;
	total.syncChannelProgress += part.syncChannelProgress;
}

function removePolicyPairings(
	db: Database,
	localDeviceId: string,
	pairings: PolicyPairing[],
): PairingRemovalCounts {
	const counts = emptyCounts();
	for (const pairing of pairings) {
		// Content sync stops, but retirement controls still need this peer's pinned key.
		retainRetirementPeerTrust(db, { localDeviceId, peerDeviceId: pairing.deviceId });
		const syncPeers = deletePolicyPairing(db, pairing);
		// A pairing that no longer matches is live, and its progress rows hold its position.
		if (syncPeers === 0) continue;
		addCounts(counts, { syncPeers, ...deleteSyncProgress(db, pairing.deviceId) });
	}
	return counts;
}

function removeDevices(
	db: Database,
	input: Extract<PairingRemovalInput, { deviceIds: string[] }>,
): PairingRemovalCounts {
	const counts = emptyCounts();
	const deviceIds = [...new Set(input.deviceIds)];
	if (input.reason === "revoked") {
		// A retired alias stops the ID from pairing again with the blocked key.
		recordRetiredDeviceAliases(
			db,
			input.retiredAliases ??
				deviceIds.flatMap((deviceId) => pinnedKeyAlias(db, input.localDeviceId, deviceId)),
		);
	}
	const now = new Date().toISOString();
	const endedIdentityIds = new Set<string>();
	if (input.reason !== "disconnect")
		endRetainedScopeAuthorization(
			db,
			deviceIds.filter((deviceId) => deviceId !== input.localDeviceId),
		);
	for (const deviceId of deviceIds) {
		// Content sync stops, but retirement controls still need this peer's pinned key.
		retainRetirementPeerTrust(db, { localDeviceId: input.localDeviceId, peerDeviceId: deviceId });
		// Unpairing deletes the pin that Remove needs, so keep the last verified one for it.
		if (input.reason === "disconnect" && deviceId !== input.localDeviceId)
			recordUnpairedPeerPin(db, {
				localDeviceId: input.localDeviceId,
				peerDeviceId: deviceId,
				recordedAt: now,
			});
		addCounts(counts, {
			syncPeers: deletePairing(db, deviceId),
			...deleteSyncProgress(db, deviceId),
		});
		if (input.reason === "disconnect") continue;
		// This device's own binding is never ended by removing a pairing.
		if (deviceId === input.localDeviceId) continue;
		const identityId = endBinding(db, deviceId, now);
		if (!identityId) continue;
		counts.identityDevices += 1;
		endedIdentityIds.add(identityId);
	}
	// Remove, a removal answer and a revocation have dealt with the device, pin included.
	if (input.reason !== "disconnect") clearUnpairedPeerPins(db, deviceIds);
	if (endedIdentityIds.size === 0) return counts;
	// Projects shared with those Identities no longer include the device.
	wakeRecipientPoliciesForIdentities(db, endedIdentityIds, now);
	return counts;
}

function emptyCounts(): PairingRemovalCounts {
	return {
		syncPeers: 0,
		replicationCursors: 0,
		replicationCursorsV2: 0,
		syncChannelProgress: 0,
		identityDevices: 0,
	};
}

/**
 * Removes each device's pairing and sync progress, and ends its Identity binding
 * and cached scope authorization unless the reason is `disconnect` or `policy`.
 * Memory retirement trust is retained first, and
 * `sync_attempts` and `sync_scope_rejections` stay as diagnostic history (sync attempt
 * retention trims a removed peer's attempts by the same rule as any peer's). One
 * immediate transaction: any failure leaves every table unchanged.
 */
export function removePairingState(db: Database, input: PairingRemovalInput): PairingRemovalCounts {
	return db
		.transaction(() =>
			input.reason === "policy"
				? removePolicyPairings(db, input.localDeviceId, input.pairings)
				: removeDevices(db, input),
		)
		.immediate();
}
