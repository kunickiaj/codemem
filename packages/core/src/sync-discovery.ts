/**
 * Peer discovery and address management for the codemem sync system.
 *
 * Handles address normalization, deduplication, peer address storage,
 * and mDNS stubs. Ported from codemem/sync/discovery.py.
 */

import { mergeAddresses, normalizeAddress } from "./address-utils.js";
import type { Database } from "./db.js";

// Re-export for consumers that import from sync-discovery
export { addressDedupeKey, mergeAddresses, normalizeAddress } from "./address-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SERVICE_TYPE = "_codemem._tcp.local.";

// ---------------------------------------------------------------------------
// Address selection
// ---------------------------------------------------------------------------

/**
 * Select addresses to dial, preferring mDNS-discovered addresses.
 *
 * mDNS addresses come first, then stored addresses (deduplicated).
 */
export function selectDialAddresses(options: { stored: string[]; mdns: string[] }): string[] {
	if (options.mdns.length === 0) {
		return mergeAddresses(options.stored, []);
	}
	return mergeAddresses(options.mdns, options.stored);
}

// ---------------------------------------------------------------------------
// Peer address storage (DB)
// ---------------------------------------------------------------------------

/**
 * Load stored addresses for a peer from the sync_peers table.
 */
export function loadPeerAddresses(db: Database, peerDeviceId: string): string[] {
	const row = db
		.prepare("SELECT addresses_json FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId) as { addresses_json: string | null } | undefined;
	if (!row?.addresses_json) return [];
	try {
		const raw = JSON.parse(row.addresses_json);
		if (!Array.isArray(raw)) return [];
		return raw.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

/**
 * Update stored addresses for a peer, merging with existing.
 *
 * Creates the sync_peers row if it doesn't exist (upsert).
 * Returns the merged address list.
 */
export function updatePeerAddresses(
	db: Database,
	peerDeviceId: string,
	addresses: string[],
	options?: {
		name?: string;
		pinnedFingerprint?: string;
		publicKey?: string;
	},
): string[] {
	const merged = mergeAddresses(loadPeerAddresses(db, peerDeviceId), addresses);
	const now = new Date().toISOString();
	const addressesJson = JSON.stringify(merged);

	// Atomic UPSERT — avoids TOCTOU race with concurrent sync workers
	db.prepare(
		`INSERT INTO sync_peers (
			peer_device_id, name, pinned_fingerprint, public_key,
			addresses_json, created_at, last_seen_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(peer_device_id) DO UPDATE SET
			name = COALESCE(excluded.name, name),
			pinned_fingerprint = COALESCE(excluded.pinned_fingerprint, pinned_fingerprint),
			public_key = COALESCE(excluded.public_key, public_key),
			addresses_json = excluded.addresses_json,
			last_seen_at = excluded.last_seen_at`,
	).run(
		peerDeviceId,
		options?.name ?? null,
		options?.pinnedFingerprint ?? null,
		options?.publicKey ?? null,
		addressesJson,
		now,
		now,
	);

	return merged;
}

/**
 * Record a sync attempt in the sync_attempts table and update peer status.
 */
export function recordSyncAttempt(
	db: Database,
	peerDeviceId: string,
	options: {
		ok: boolean;
		opsIn?: number;
		opsOut?: number;
		error?: string;
	},
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO sync_attempts (
			peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		peerDeviceId,
		now,
		now,
		options.ok ? 1 : 0,
		options.opsIn ?? 0,
		options.opsOut ?? 0,
		options.error ?? null,
	);

	if (options.ok) {
		db.prepare(
			"UPDATE sync_peers SET last_sync_at = ?, last_error = NULL WHERE peer_device_id = ?",
		).run(now, peerDeviceId);
	} else {
		db.prepare("UPDATE sync_peers SET last_error = ? WHERE peer_device_id = ?").run(
			options.error ?? null,
			peerDeviceId,
		);
	}
}

/**
 * Record a successful sync and promote the working address to the front.
 *
 * Returns the reordered address list.
 */
export function recordPeerSuccess(
	db: Database,
	peerDeviceId: string,
	address: string | null,
): string[] {
	const addresses = loadPeerAddresses(db, peerDeviceId);
	const normalized = normalizeAddress(address ?? "");
	let ordered = addresses;
	if (normalized) {
		const remaining = addresses.filter((item) => normalizeAddress(item) !== normalized);
		ordered = [normalized, ...remaining];
		db.prepare(
			`UPDATE sync_peers
			 SET addresses_json = ?, last_sync_at = ?, last_error = NULL
			 WHERE peer_device_id = ?`,
		).run(JSON.stringify(ordered), new Date().toISOString(), peerDeviceId);
	}
	return ordered;
}

// ---------------------------------------------------------------------------
// Project filters
// ---------------------------------------------------------------------------

/**
 * Set per-peer project include/exclude filters.
 *
 * Pass null for both to clear the override (inherit global config).
 */
export function setPeerProjectFilter(
	db: Database,
	peerDeviceId: string,
	options: {
		include: string[] | null;
		exclude: string[] | null;
	},
): void {
	const includeJson = options.include === null ? null : JSON.stringify(options.include);
	const excludeJson = options.exclude === null ? null : JSON.stringify(options.exclude);
	db.prepare(
		`UPDATE sync_peers
		 SET projects_include_json = ?,
		     projects_exclude_json = ?
		 WHERE peer_device_id = ?`,
	).run(includeJson, excludeJson, peerDeviceId);
}

/**
 * Set the claimed_local_actor flag for a peer.
 */
export function setPeerLocalActorClaim(db: Database, peerDeviceId: string, claimed: boolean): void {
	db.prepare("UPDATE sync_peers SET claimed_local_actor = ? WHERE peer_device_id = ?").run(
		claimed ? 1 : 0,
		peerDeviceId,
	);
}

// ---------------------------------------------------------------------------
// mDNS stubs (Phase 1)
// ---------------------------------------------------------------------------

export interface MdnsEntry {
	name?: string;
	host?: string;
	port?: number;
	address?: Uint8Array | string;
	properties?: Record<string, string | Uint8Array>;
}

/**
 * Check if mDNS discovery is enabled via the CODEMEM_SYNC_MDNS env var.
 */
export function mdnsEnabled(): boolean {
	const value = process.env.CODEMEM_SYNC_MDNS;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true";
}

/**
 * Advertise this device via mDNS.
 *
 * Phase 1 stub: logs the intent and returns a no-op closer.
 * Real implementation will use dns-sd (macOS) or bonjour-service (Linux).
 */
export function advertiseMdns(_deviceId: string, _port: number): { close(): void } {
	return { close() {} };
}

/**
 * Discover peers via mDNS.
 *
 * Phase 1 stub: returns an empty array.
 * Real implementation will use dns-sd (macOS) or bonjour-service (Linux).
 */
export function discoverPeersViaMdns(): MdnsEntry[] {
	return [];
}

/**
 * Extract addresses for a specific peer from mDNS discovery entries.
 */
export function mdnsAddressesForPeer(peerDeviceId: string, entries: MdnsEntry[]): string[] {
	const addresses: string[] = [];
	for (const entry of entries) {
		const props = entry.properties ?? {};
		let deviceId: string | Uint8Array | undefined =
			props.device_id ??
			((props as Record<string, unknown>).device_id as string | Uint8Array | undefined);
		if (deviceId == null) continue;
		if (deviceId instanceof Uint8Array) {
			deviceId = new TextDecoder().decode(deviceId);
		}
		if (deviceId !== peerDeviceId) continue;

		const port = entry.port ?? 0;
		if (!port) continue;

		// Prefer entry.address (resolved IP) over entry.host (service name).
		// mDNS responses often carry a service-name host (e.g. _codemem._tcp.local)
		// that isn't directly dialable, but include the usable IP in address.
		const address = (entry as Record<string, unknown>).address as string | undefined;
		const host = entry.host ?? "";
		const dialHost = address && !address.includes(".local") ? address : host;
		if (dialHost && !dialHost.includes("_tcp.local") && !dialHost.includes("_udp.local")) {
			addresses.push(`${dialHost}:${port}`);
		}
	}
	return addresses;
}
