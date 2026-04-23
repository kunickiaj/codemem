/**
 * Peer discovery and address management for the codemem sync system.
 *
 * Handles address normalization, deduplication, peer address storage,
 * and cross-platform mDNS advertise/discover via `bonjour-service`.
 */

import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mergeAddresses, normalizeAddress } from "./address-utils.js";
import { readCoordinatorSyncConfig } from "./coordinator-runtime.js";
import type { Database } from "./db.js";
import * as schema from "./schema.js";

const requireFromHere = createRequire(import.meta.url);

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
// mDNS peer discovery (cross-platform via bonjour-service)
// ---------------------------------------------------------------------------

export interface MdnsEntry {
	name?: string;
	host?: string;
	port?: number;
	address?: Uint8Array | string;
	properties?: Record<string, string | Uint8Array>;
}

const MDNS_SERVICE_TYPE = "codemem"; // advertises as _codemem._tcp.local.

/**
 * Returns true when mDNS discovery should be active on this device.
 *
 * Reads the merged codemem config (so the Settings UI toggle is
 * authoritative) with an env-var override (`CODEMEM_SYNC_MDNS`) for
 * one-off runs. Previously env-only, which silently ignored the UI
 * toggle.
 */
export function mdnsEnabled(): boolean {
	const envValue = process.env.CODEMEM_SYNC_MDNS;
	if (envValue) return envValue === "1" || envValue.toLowerCase() === "true";
	try {
		return readCoordinatorSyncConfig().syncMdns;
	} catch {
		return false;
	}
}

// Lazy-import `bonjour-service` so users who disable embeddings or run
// in environments where the multicast socket can't bind don't pay the
// startup cost. Returns null when the module isn't available.
interface BonjourLike {
	publish: (opts: { name: string; type: string; port: number; txt?: Record<string, string> }) => {
		stop: (cb?: () => void) => void;
	};
	find: (
		opts: { type: string },
		onUp?: (svc: {
			name: string;
			host?: string;
			fqdn?: string;
			port: number;
			addresses?: string[];
			txt?: Record<string, string>;
		}) => void,
	) => { stop: () => void };
	destroy: () => void;
}

type BonjourCtor = new (
	opts?: Record<string, unknown>,
	errorCallback?: (err: Error) => void,
) => BonjourLike;

function loadBonjour(): BonjourLike | null {
	try {
		const mod = requireFromHere("bonjour-service") as {
			Bonjour?: BonjourCtor;
			default?: BonjourCtor;
		};
		const Ctor = mod.Bonjour ?? mod.default;
		if (!Ctor) return null;
		// Pass an error callback so mDNS runtime errors (bind failures on
		// restricted containers, interface churn, multicast blocked) stay
		// contained instead of propagating as uncaught exceptions and
		// taking down the sync/viewer process. Degrades to no-op on error.
		return new Ctor(undefined, (err: Error) => {
			console.warn("[codemem] mDNS runtime error (non-fatal):", err?.message ?? err);
		});
	} catch {
		return null;
	}
}

// Shared Bonjour instance: advertise + discover reuse a single multicast
// socket, refcounted across callers. This avoids churn where each call would
// otherwise spin up a fresh bind-release cycle and race its own publish/find
// against destroy(). The instance is lazily created on first acquire and torn
// down when the last caller releases.
let sharedInstance: BonjourLike | null = null;
let sharedRefcount = 0;

function acquireBonjour(): BonjourLike | null {
	if (sharedInstance) {
		sharedRefcount += 1;
		return sharedInstance;
	}
	const instance = loadBonjour();
	if (!instance) return null;
	sharedInstance = instance;
	sharedRefcount = 1;
	return sharedInstance;
}

function releaseBonjour(): void {
	if (!sharedInstance) return;
	sharedRefcount = Math.max(0, sharedRefcount - 1);
	if (sharedRefcount > 0) return;
	const instance = sharedInstance;
	sharedInstance = null;
	try {
		instance.destroy();
	} catch {
		// best effort
	}
}

/**
 * Internal: reset shared instance state. Exposed for tests only.
 */
export function __resetMdnsForTests(): void {
	if (sharedInstance) {
		try {
			sharedInstance.destroy();
		} catch {
			// best effort
		}
	}
	sharedInstance = null;
	sharedRefcount = 0;
}

/**
 * Advertise this device as a codemem sync peer via mDNS.
 *
 * Returns a closer that tears down the advertisement. No-op when mDNS
 * is disabled, when `bonjour-service` failed to load, or when the
 * multicast socket cannot bind.
 */
export function advertiseMdns(deviceId: string, port: number): { close(): void } {
	if (!mdnsEnabled()) return { close() {} };
	if (!deviceId || !port || !Number.isFinite(port)) return { close() {} };

	const bonjour = acquireBonjour();
	if (!bonjour) return { close() {} };

	let advertisement: { stop: (cb?: () => void) => void } | null = null;
	try {
		advertisement = bonjour.publish({
			name: `codemem-${deviceId.slice(0, 12)}`,
			type: MDNS_SERVICE_TYPE,
			port,
			txt: { device_id: deviceId },
		});
	} catch {
		releaseBonjour();
		return { close() {} };
	}

	let closed = false;
	return {
		close() {
			if (closed) return;
			closed = true;
			const release = () => releaseBonjour();
			try {
				// Wait for publish to acknowledge the stop before releasing the
				// shared instance so the unpublish actually reaches the wire.
				advertisement?.stop(() => release());
			} catch {
				release();
			}
		},
	};
}

/**
 * Discover codemem sync peers via mDNS. Blocks up to `timeoutMs` (default
 * 1500) collecting `_codemem._tcp.local.` responders, then returns the
 * entries it saw. No-op / empty array when mDNS is disabled or the
 * module couldn't load.
 */
export async function discoverPeersViaMdns(timeoutMs = 1500): Promise<MdnsEntry[]> {
	if (!mdnsEnabled()) return [];

	const bonjour = acquireBonjour();
	if (!bonjour) return [];

	const found: MdnsEntry[] = [];
	const seen = new Set<string>();
	// Ignore late `onUp` callbacks that fire after the timeout elapses — the
	// browser's `stop()` is best-effort and can race in-flight dispatches.
	let acceptingResults = true;
	let browser: { stop: () => void } | null = null;
	try {
		browser = bonjour.find({ type: MDNS_SERVICE_TYPE }, (svc) => {
			if (!acceptingResults) return;
			const key = `${svc.name}|${svc.host ?? svc.fqdn ?? ""}|${svc.port}`;
			if (seen.has(key)) return;
			seen.add(key);
			const addresses = Array.isArray(svc.addresses) ? svc.addresses : [];
			const ipv4 = addresses.find((addr) => addr && /^[\d.]+$/.test(addr));
			const properties: Record<string, string> = {};
			const rawTxt = svc.txt ?? {};
			for (const [key, value] of Object.entries(rawTxt)) {
				properties[key] = String(value);
			}
			found.push({
				name: svc.name,
				host: (svc.host || svc.fqdn || "").replace(/\.$/, ""),
				port: svc.port,
				address: ipv4,
				properties,
			});
		});
		await new Promise<void>((resolve) => setTimeout(resolve, Math.max(100, timeoutMs)));
	} finally {
		acceptingResults = false;
		try {
			browser?.stop();
		} catch {
			// best effort
		}
		releaseBonjour();
	}
	return found;
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
