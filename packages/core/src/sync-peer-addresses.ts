import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
	MAX_PEER_ADDRESSES,
	mergeAddresses,
	mergeCoordinatorPeerAddresses,
} from "./address-utils.js";
import type { Database } from "./db.js";
import * as schema from "./schema.js";

export function loadPeerAddresses(db: Database, peerDeviceId: string): string[] {
	const d = drizzle(db, { schema });
	const row = d
		.select({ addresses_json: schema.syncPeers.addresses_json })
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.get();
	if (!row?.addresses_json) return [];
	try {
		const raw = JSON.parse(row.addresses_json);
		if (!Array.isArray(raw)) return [];
		return raw.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

/** Null means the peer predates source tracking; its existing addresses must be preserved on first refresh. */
export function loadManualPeerAddresses(db: Database, peerDeviceId: string): string[] | null {
	const row = db
		.prepare("SELECT manual_addresses_json FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId) as { manual_addresses_json: string | null } | undefined;
	if (row?.manual_addresses_json == null) return null;
	try {
		const raw: unknown = JSON.parse(row.manual_addresses_json);
		return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

export function loadSuccessfulPeerAddress(db: Database, peerDeviceId: string): string | null {
	const row = db
		.prepare("SELECT last_success_address FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId) as { last_success_address: string | null } | undefined;
	return row?.last_success_address ?? null;
}

export function updatePeerAddresses(
	db: Database,
	peerDeviceId: string,
	addresses: string[],
	options?: {
		name?: string;
		pinnedFingerprint?: string;
		publicKey?: string;
		replaceTrust?: boolean;
		coordinatorCandidates?: boolean;
	},
): string[] {
	const existingAddresses = loadPeerAddresses(db, peerDeviceId);
	const storedManual = loadManualPeerAddresses(db, peerDeviceId);
	const legacyManual = storedManual == null ? existingAddresses : storedManual;
	const manual =
		options?.replaceTrust && addresses.length > 0
			? mergeAddresses(legacyManual, addresses)
			: legacyManual;
	const successfulAddress = loadSuccessfulPeerAddress(db, peerDeviceId) ?? undefined;
	let merged = mergeAddresses(existingAddresses, addresses);
	if (options?.coordinatorCandidates) {
		merged = mergeCoordinatorPeerAddresses(existingAddresses, addresses, manual, {
			successfulAddress,
		});
	} else if (options?.replaceTrust && addresses.length > 0) {
		merged = mergeCoordinatorPeerAddresses(existingAddresses, addresses, manual, {
			requiredFreshAddresses: Math.min(mergeAddresses(addresses, []).length, MAX_PEER_ADDRESSES),
			successfulAddress,
		});
	}
	const now = new Date().toISOString();
	const addressesJson = JSON.stringify(merged);

	// Atomic UPSERT — avoids TOCTOU race with concurrent sync workers
	const d = drizzle(db, { schema });
	d.insert(schema.syncPeers)
		.values({
			peer_device_id: peerDeviceId,
			name: options?.name ?? null,
			pinned_fingerprint: options?.pinnedFingerprint ?? null,
			public_key: options?.publicKey ?? null,
			addresses_json: addressesJson,
			manual_addresses_json: JSON.stringify(manual),
			created_at: now,
			last_seen_at: now,
		})
		.onConflictDoUpdate({
			target: schema.syncPeers.peer_device_id,
			set: {
				name: sql`COALESCE(excluded.name, ${schema.syncPeers.name})`,
				pinned_fingerprint: options?.replaceTrust
					? sql`COALESCE(excluded.pinned_fingerprint, ${schema.syncPeers.pinned_fingerprint})`
					: sql`COALESCE(${schema.syncPeers.pinned_fingerprint}, excluded.pinned_fingerprint)`,
				public_key: options?.replaceTrust
					? sql`COALESCE(excluded.public_key, ${schema.syncPeers.public_key})`
					: sql`COALESCE(${schema.syncPeers.public_key}, excluded.public_key)`,
				addresses_json: sql`excluded.addresses_json`,
				manual_addresses_json: sql`excluded.manual_addresses_json`,
				last_seen_at: sql`excluded.last_seen_at`,
			},
		})
		.run();

	return merged;
}
