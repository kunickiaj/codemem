import { eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { columnExists, type Database, tableExists } from "./db.js";
import * as schema from "./schema.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const SAME_PERSON_BINDING_PROVENANCE = new Set([
	"user_confirmed_identity_setup",
	"recipient_invite",
	"exact_project_invite",
	"review_resolution",
]);

/** Shared read-only resolver; authoritative bindings take precedence over legacy claims. */
export function resolveSameActorPeerIds(db: Database, actorId: string): string[] {
	const sets = resolveBindings(db, actorId);
	if (!sets) return [];
	if (!tableExists(db, "sync_peers")) return [...sets.deviceIds].sort();
	const hasAliasEvidence = ["peer_device_id", "public_key", "pinned_fingerprint"].every((column) =>
		columnExists(db, "sync_peers", column),
	);
	if (sets.boundDeviceIds.size > 0 && !hasAliasEvidence) return [...sets.deviceIds].sort();
	if (sets.boundDeviceIds.size > 0) resolveAliases(db, sets);
	const legacyRows = drizzle(db, { schema })
		.select({ peer_device_id: schema.syncPeers.peer_device_id })
		.from(schema.syncPeers)
		.where(or(eq(schema.syncPeers.claimed_local_actor, 1), eq(schema.syncPeers.actor_id, actorId)))
		.all();
	for (const row of legacyRows) {
		const deviceId = String(row.peer_device_id ?? "").trim();
		if (deviceId && !sets.boundDeviceIds.has(deviceId)) sets.deviceIds.add(deviceId);
	}
	return [...sets.deviceIds].sort();
}

type BindingSets = {
	deviceIds: Set<string>;
	boundDeviceIds: Set<string>;
	locallyBoundDeviceIds: Set<string>;
};

function activeActor(db: Database, actorId: string, bindingCount: number): boolean {
	if (bindingCount === 0 || !tableExists(db, "actors")) return false;
	if (
		!["actor_id", "status", "merged_into_actor_id"].every((column) =>
			columnExists(db, "actors", column),
		)
	)
		return false;
	const actor = db
		.prepare("SELECT status, merged_into_actor_id FROM actors WHERE actor_id = ?")
		.get(actorId) as { status: string; merged_into_actor_id: string | null } | undefined;
	return actor?.status === "active" && !actor.merged_into_actor_id;
}

function resolveBindings(db: Database, actorId: string): BindingSets | null {
	const sets: BindingSets = {
		deviceIds: new Set(),
		boundDeviceIds: new Set(),
		locallyBoundDeviceIds: new Set(),
	};
	const hasIdentityBindings =
		tableExists(db, "identity_devices") &&
		["device_id", "identity_id", "status", "provenance"].every((column) =>
			columnExists(db, "identity_devices", column),
		);
	if (tableExists(db, "identity_devices") && !hasIdentityBindings) return null;
	if (!hasIdentityBindings) return sets;
	const bindings = db
		.prepare("SELECT device_id, identity_id, status, provenance FROM identity_devices")
		.all() as Array<{
		device_id: string;
		identity_id: string;
		status: string;
		provenance: string;
	}>;
	const localActorIsActive = activeActor(db, actorId, bindings.length);
	for (const binding of bindings) {
		const deviceId = String(binding.device_id ?? "").trim();
		// A binding that device removal ended counts as no binding at all.
		if (!deviceId || binding.status === "removed") continue;
		sets.boundDeviceIds.add(deviceId);
		if (
			localActorIsActive &&
			String(binding.identity_id ?? "").trim() === actorId &&
			binding.status === "active" &&
			SAME_PERSON_BINDING_PROVENANCE.has(binding.provenance)
		) {
			sets.deviceIds.add(deviceId);
			sets.locallyBoundDeviceIds.add(deviceId);
		}
	}
	return sets;
}

type PeerEvidence = {
	peer_device_id: string;
	public_key: string | null;
	pinned_fingerprint: string | null;
};

function validatedFingerprint(row: PeerEvidence): string | null {
	const publicKey = String(row.public_key ?? "").trim();
	const pinned = String(row.pinned_fingerprint ?? "").trim();
	if (!publicKey) return pinned || null;
	const derived = fingerprintPublicKey(publicKey);
	return pinned && pinned !== derived ? null : pinned || derived;
}

function provenFingerprint(row: PeerEvidence): string | null {
	return String(row.public_key ?? "").trim() ? validatedFingerprint(row) : null;
}

function resolveAliases(db: Database, sets: BindingSets): void {
	const { deviceIds, boundDeviceIds } = sets;
	const peerEvidence = db
		.prepare("SELECT peer_device_id, public_key, pinned_fingerprint FROM sync_peers")
		.all() as PeerEvidence[];
	const { boundFingerprints, locallyBoundFingerprints } = resolveBoundFingerprints(
		peerEvidence,
		sets,
	);
	for (const row of peerEvidence) {
		const deviceId = String(row.peer_device_id ?? "").trim();
		const fingerprint = validatedFingerprint(row);
		if (!deviceId || !fingerprint || !boundFingerprints.has(fingerprint)) continue;
		const hasAuthoritativeBinding = boundDeviceIds.has(deviceId);
		boundDeviceIds.add(deviceId);
		if (
			!hasAuthoritativeBinding &&
			locallyBoundFingerprints.has(fingerprint) &&
			provenFingerprint(row)
		) {
			deviceIds.add(deviceId);
		}
	}
}

function resolveBoundFingerprints(peerEvidence: PeerEvidence[], sets: BindingSets) {
	const { boundDeviceIds, locallyBoundDeviceIds } = sets;
	const boundFingerprints = new Set<string>();
	const locallyBoundFingerprints = new Set<string>();
	const conflictingBoundFingerprints = new Set<string>();
	for (const row of peerEvidence) {
		const deviceId = String(row.peer_device_id ?? "").trim();
		const fingerprint = validatedFingerprint(row);
		if (!deviceId || !fingerprint || !boundDeviceIds.has(deviceId)) continue;
		boundFingerprints.add(fingerprint);
		if (locallyBoundDeviceIds.has(deviceId)) {
			if (provenFingerprint(row)) locallyBoundFingerprints.add(fingerprint);
		} else {
			conflictingBoundFingerprints.add(fingerprint);
		}
	}
	for (const fingerprint of conflictingBoundFingerprints)
		locallyBoundFingerprints.delete(fingerprint);
	return { boundFingerprints, locallyBoundFingerprints };
}
