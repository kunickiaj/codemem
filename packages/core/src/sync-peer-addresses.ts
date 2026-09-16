import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mergeAddresses } from "./address-utils.js";
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

export function updatePeerAddresses(
	db: Database,
	peerDeviceId: string,
	addresses: string[],
	options?: {
		name?: string;
		pinnedFingerprint?: string;
		publicKey?: string;
		replaceTrust?: boolean;
	},
): string[] {
	const merged = mergeAddresses(loadPeerAddresses(db, peerDeviceId), addresses);
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
				last_seen_at: sql`excluded.last_seen_at`,
			},
		})
		.run();

	return merged;
}
