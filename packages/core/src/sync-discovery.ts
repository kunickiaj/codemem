/**
 * Peer discovery and address management for the codemem sync system.
 *
 * Handles address normalization, deduplication, peer address storage,
 * and mDNS stubs. Ported from codemem/sync/discovery.py.
 */

import { execFileSync, spawn } from "node:child_process";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mergeAddresses, normalizeAddress } from "./address-utils.js";
import type { Database } from "./db.js";
import * as schema from "./schema.js";

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
				pinned_fingerprint: sql`COALESCE(excluded.pinned_fingerprint, ${schema.syncPeers.pinned_fingerprint})`,
				public_key: sql`COALESCE(excluded.public_key, ${schema.syncPeers.public_key})`,
				addresses_json: sql`excluded.addresses_json`,
				last_seen_at: sql`excluded.last_seen_at`,
			},
		})
		.run();

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
	const d = drizzle(db, { schema });
	const now = new Date().toISOString();
	d.insert(schema.syncAttempts)
		.values({
			peer_device_id: peerDeviceId,
			started_at: now,
			finished_at: now,
			ok: options.ok ? 1 : 0,
			ops_in: options.opsIn ?? 0,
			ops_out: options.opsOut ?? 0,
			error: options.error ?? null,
		})
		.run();

	if (options.ok) {
		d.update(schema.syncPeers)
			.set({ last_sync_at: now, last_error: null })
			.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
			.run();
	} else {
		d.update(schema.syncPeers)
			.set({ last_error: options.error ?? null })
			.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
			.run();
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
	const normalized = normalizeAddress(address ?? "");
	const now = new Date().toISOString();
	const promote = db.transaction((deviceId: string, promotedAddress: string, syncedAt: string) => {
		const addresses = loadPeerAddresses(db, deviceId);
		const remaining = promotedAddress
			? addresses.filter((item) => normalizeAddress(item) !== promotedAddress)
			: addresses;
		const ordered = promotedAddress ? [promotedAddress, ...remaining] : addresses;
		const d = drizzle(db, { schema });
		d.update(schema.syncPeers)
			.set({
				addresses_json: JSON.stringify(ordered),
				last_sync_at: syncedAt,
				last_seen_at: syncedAt,
				last_error: null,
			})
			.where(eq(schema.syncPeers.peer_device_id, deviceId))
			.run();
		return ordered;
	});
	return promote.immediate(peerDeviceId, normalized, now);
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
	const d = drizzle(db, { schema });
	d.update(schema.syncPeers)
		.set({ projects_include_json: includeJson, projects_exclude_json: excludeJson })
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.run();
}

/**
 * Set the claimed_local_actor flag for a peer.
 */
export function setPeerLocalActorClaim(db: Database, peerDeviceId: string, claimed: boolean): void {
	const d = drizzle(db, { schema });
	d.update(schema.syncPeers)
		.set({ claimed_local_actor: claimed ? 1 : 0 })
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.run();
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

function commandAvailable(command: string): boolean {
	try {
		execFileSync("which", [command], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function runDnsSd(args: string[], timeoutMs = 1200): string {
	try {
		return execFileSync("dns-sd", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		});
	} catch (err) {
		if (err && typeof err === "object") {
			const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
			const out = [e.stdout, e.stderr]
				.map((part) => {
					if (typeof part === "string") return part;
					if (part instanceof Buffer) return part.toString("utf8");
					return "";
				})
				.filter(Boolean)
				.join("\n");
			return out;
		}
		return "";
	}
}

function discoverServiceNamesDnsSd(): string[] {
	const output = runDnsSd(["-B", "_codemem._tcp", "local."], 1200);
	if (!output) return [];
	const names = new Set<string>();
	for (const line of output.split(/\r?\n/)) {
		if (!line.includes("Add")) continue;
		let name = "";
		const columnMatch = line.match(/\bAdd\b.*\slocal\.\s+_codemem\._tcp\.\s+(.+)$/);
		if (columnMatch) {
			name = String(columnMatch[1] ?? "").trim();
		} else {
			const legacyMatch = line.match(/\sAdd\s+\S+\s+\S+\s+\S+\s+(.+)\._codemem\._tcp\./);
			if (legacyMatch) name = String(legacyMatch[1] ?? "").trim();
		}
		if (name) names.add(name);
	}
	return [...names];
}

function resolveServiceDnsSd(name: string): MdnsEntry | null {
	const output = runDnsSd(["-L", name, "_codemem._tcp", "local."], 1200);
	if (!output) return null;

	const hostPortMatch = output.match(/can be reached at\s+([^:\s]+)\.?:(\d+)/i);
	const host = hostPortMatch?.[1] ? String(hostPortMatch[1]).trim() : "";
	const port = hostPortMatch?.[2] ? Number.parseInt(String(hostPortMatch[2]), 10) : 0;

	const txtDeviceIdMatch = output.match(/device_id=([^\s"',]+)/i);
	const deviceId = txtDeviceIdMatch?.[1] ? String(txtDeviceIdMatch[1]).trim() : "";

	if (!host || !port || Number.isNaN(port)) return null;
	const properties: Record<string, string> = {};
	if (deviceId) properties.device_id = deviceId;

	return {
		name,
		host,
		port,
		properties,
	};
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
	if (!mdnsEnabled()) return { close() {} };
	if (process.platform !== "darwin") return { close() {} };
	if (!commandAvailable("dns-sd")) return { close() {} };

	const serviceName = `codemem-${_deviceId.slice(0, 12)}`;
	const child = spawn(
		"dns-sd",
		["-R", serviceName, "_codemem._tcp", "local.", String(_port), `device_id=${_deviceId}`],
		{
			stdio: "ignore",
			detached: false,
		},
	);

	return {
		close() {
			if (!child.killed) {
				try {
					child.kill("SIGTERM");
				} catch {
					// best effort
				}
			}
		},
	};
}

/**
 * Discover peers via mDNS.
 *
 * Phase 1 stub: returns an empty array.
 * Real implementation will use dns-sd (macOS) or bonjour-service (Linux).
 */
export function discoverPeersViaMdns(): MdnsEntry[] {
	if (!mdnsEnabled()) return [];
	if (process.platform !== "darwin") return [];
	if (!commandAvailable("dns-sd")) return [];

	const names = discoverServiceNamesDnsSd();
	if (names.length === 0) return [];

	const entries: MdnsEntry[] = [];
	for (const name of names) {
		const resolved = resolveServiceDnsSd(name);
		if (resolved) entries.push(resolved);
	}
	return entries;
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
