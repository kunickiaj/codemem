import { networkInterfaces } from "node:os";
import {
	formatHostPort,
	mergeAddresses,
	mergeAddressesPreferCandidates,
	normalizeAddress,
} from "./address-utils.js";
import type { CoordinatorReciprocalApproval } from "./coordinator-store-contract.js";
import type { Database } from "./db.js";
import { getCodememEnvOverrides, readCodememConfigFile } from "./observer-config.js";
import { getCachedScopeAuthorization } from "./scope-membership-cache.js";
import type { MemoryStore } from "./store.js";
import { buildAuthHeaders } from "./sync-auth.js";
import { LOCAL_SYNC_CAPABILITY, LOCAL_SYNC_FEATURES } from "./sync-capability.js";
import { updatePeerAddresses } from "./sync-discovery.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";

type ConfigRecord = Record<string, unknown>;
type PresenceStoreLike = Pick<MemoryStore, "db" | "dbPath">;

function clean(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function parseIntOr(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string" && /^-?\d+$/.test(value.trim()))
		return Number.parseInt(value.trim(), 10);
	return fallback;
}

function parseBoolOr(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
	}
	return fallback;
}

function parseStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return [];
}

function mergeStringLists(existing: string[], candidates: string[]): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const value of [...existing, ...candidates]) {
		const cleanValue = value.trim();
		if (!cleanValue || seen.has(cleanValue)) continue;
		seen.add(cleanValue);
		merged.push(cleanValue);
	}
	return merged;
}

export interface CoordinatorSyncConfig {
	syncEnabled: boolean;
	syncHost: string;
	syncPort: number;
	syncIntervalS: number;
	syncAdvertise: string;
	syncMdns: boolean;
	syncRetentionEnabled: boolean;
	syncRetentionMaxAgeDays: number;
	syncRetentionMaxSizeMb: number;
	syncRetentionIntervalS: number;
	syncRetentionMaxRuntimeMs: number;
	syncRetentionMaxOpsPerPass: number;
	rawEventsRetentionEnabled: boolean;
	/** Whether raw_events_retention_enabled was explicitly set (file or env), so
	 * callers can treat an explicit `false` as authoritative over legacy knobs. */
	rawEventsRetentionConfigured: boolean;
	rawEventsRetentionMaxAgeDays: number;
	syncProjectsInclude: string[];
	syncProjectsExclude: string[];
	syncOpsLimit: number;
	syncCoordinatorUrl: string;
	syncCoordinatorGroup: string;
	syncCoordinatorGroups: string[];
	syncCoordinatorTimeoutS: number;
	syncCoordinatorPresenceTtlS: number;
	syncCoordinatorAdminSecret: string;
}

type PresenceStatus = "posted" | "not_enrolled" | "error";

interface PresenceSnapshot {
	status: PresenceStatus;
	error: string | null;
	advertisedAddresses: unknown;
	nextRefreshAtMs: number;
}

interface CoordinatorStatusCacheEntry {
	snapshot: Record<string, unknown>;
	discoveredPeers: Record<string, unknown>[];
	nextRefreshAtMs: number;
}

const coordinatorPresenceCache = new Map<string, PresenceSnapshot>();
const coordinatorStatusCache = new Map<string, CoordinatorStatusCacheEntry>();
const COORDINATOR_STATUS_SNAPSHOT_CACHE_MS = 5_000;

function presenceCacheKey(store: PresenceStoreLike, config: CoordinatorSyncConfig): string {
	const groups = [...config.syncCoordinatorGroups].sort().join(",");
	return [
		store.dbPath,
		config.syncCoordinatorUrl,
		groups,
		coordinatorStatusIdentityCacheSegment(store),
		config.syncHost,
		config.syncPort,
		config.syncAdvertise,
		config.syncCoordinatorPresenceTtlS,
	].join("|");
}

function coordinatorStatusIdentityCacheSegment(store: PresenceStoreLike): string {
	const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || "";
	try {
		const row = store.db.prepare("SELECT device_id, fingerprint FROM sync_device LIMIT 1").get() as
			| { device_id?: string | null; fingerprint?: string | null }
			| undefined;
		return `${keysDir}|${row?.device_id ?? ""}|${row?.fingerprint ?? ""}`;
	} catch {
		return keysDir;
	}
}

function coordinatorStatusCacheKey(
	store: PresenceStoreLike,
	config: CoordinatorSyncConfig,
): string {
	return [
		presenceCacheKey(store, config),
		config.syncEnabled ? "sync-enabled" : "sync-disabled",
		config.syncHost,
		config.syncPort,
		config.syncAdvertise,
		config.syncCoordinatorPresenceTtlS,
	].join("|");
}

function pairedPeerCount(store: PresenceStoreLike): number {
	return Number(
		(
			store.db.prepare("SELECT COUNT(1) AS total FROM sync_peers").get() as
				| { total?: number }
				| undefined
		)?.total ?? 0,
	);
}

function presenceRefreshIntervalMs(config: CoordinatorSyncConfig): number {
	const ttl = Math.max(1, config.syncCoordinatorPresenceTtlS);
	const halfTtl = Math.floor(ttl / 2);
	const refreshS = Math.max(5, Math.min(60, halfTtl > 0 ? halfTtl : 1));
	return refreshS * 1000;
}

function presenceRetryIntervalMs(): number {
	return 30_000;
}

export function readCoordinatorSyncConfig(config?: ConfigRecord): CoordinatorSyncConfig {
	const raw = { ...(config ?? readCodememConfigFile()) } as ConfigRecord;
	const envOverrides = getCodememEnvOverrides();
	for (const key of Object.keys(envOverrides)) {
		const value = process.env[envOverrides[key] as string];
		if (value != null) raw[key] = value;
	}
	const syncCoordinatorGroup = clean(raw.sync_coordinator_group);
	const syncCoordinatorGroups = parseStringList(raw.sync_coordinator_groups);
	return {
		syncEnabled: parseBoolOr(raw.sync_enabled, false),
		syncHost: clean(raw.sync_host) || "0.0.0.0",
		syncPort: parseIntOr(raw.sync_port, 7337),
		syncIntervalS: parseIntOr(raw.sync_interval_s, 120),
		syncAdvertise: clean(raw.sync_advertise) || "auto",
		syncMdns: parseBoolOr(raw.sync_mdns, false),
		syncRetentionEnabled: parseBoolOr(raw.sync_retention_enabled, false),
		syncRetentionMaxAgeDays: Math.max(1, parseIntOr(raw.sync_retention_max_age_days, 30)),
		syncRetentionMaxSizeMb: Math.max(1, parseIntOr(raw.sync_retention_max_size_mb, 512)),
		syncRetentionIntervalS: Math.max(5, parseIntOr(raw.sync_retention_interval_s, 300)),
		syncRetentionMaxRuntimeMs: Math.max(100, parseIntOr(raw.sync_retention_max_runtime_ms, 2000)),
		syncRetentionMaxOpsPerPass: Math.max(1, parseIntOr(raw.sync_retention_max_ops_per_pass, 5000)),
		rawEventsRetentionEnabled: parseBoolOr(raw.raw_events_retention_enabled, false),
		rawEventsRetentionConfigured: raw.raw_events_retention_enabled !== undefined,
		rawEventsRetentionMaxAgeDays: Math.max(
			1,
			parseIntOr(raw.raw_events_retention_max_age_days, 90),
		),
		syncProjectsInclude: parseStringList(raw.sync_projects_include),
		syncProjectsExclude: parseStringList(raw.sync_projects_exclude),
		syncOpsLimit: Math.max(1, Math.min(1000, parseIntOr(raw.sync_ops_limit, 500))),
		syncCoordinatorUrl: clean(raw.sync_coordinator_url),
		syncCoordinatorGroup,
		syncCoordinatorGroups:
			syncCoordinatorGroups.length > 0
				? syncCoordinatorGroups
				: syncCoordinatorGroup
					? [syncCoordinatorGroup]
					: [],
		syncCoordinatorTimeoutS: parseIntOr(raw.sync_coordinator_timeout_s, 3),
		syncCoordinatorPresenceTtlS: parseIntOr(raw.sync_coordinator_presence_ttl_s, 180),
		syncCoordinatorAdminSecret: clean(raw.sync_coordinator_admin_secret),
	};
}

export function coordinatorEnabled(config: CoordinatorSyncConfig): boolean {
	return Boolean(config.syncCoordinatorUrl && config.syncCoordinatorGroups.length > 0);
}

export function advertisedSyncAddresses(config: CoordinatorSyncConfig): string[] {
	const advertise = config.syncAdvertise.toLowerCase();
	if (advertise && advertise !== "auto" && advertise !== "default") {
		return mergeAddresses(
			[],
			advertise
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
			{ defaultHttpPort: config.syncPort },
		);
	}
	if (config.syncHost && config.syncHost !== "0.0.0.0") {
		return [normalizeAddress(formatHostPort(config.syncHost, config.syncPort))].filter(Boolean);
	}
	const addresses = Object.values(networkInterfaces())
		.flatMap((entries) => entries ?? [])
		.filter((entry) => !entry.internal)
		.map((entry) => entry.address)
		.filter((address) => address && address !== "127.0.0.1" && address !== "::1")
		.map((address) => normalizeAddress(formatHostPort(address, config.syncPort)))
		.filter(Boolean);
	return [...new Set(addresses)];
}

export async function registerCoordinatorPresence(
	store: PresenceStoreLike,
	config: CoordinatorSyncConfig,
	options?: { keysDir?: string },
): Promise<{ groups: string[]; responses: Record<string, unknown>[] } | null> {
	if (!coordinatorEnabled(config)) return null;
	const keysDir = options?.keysDir ?? (process.env.CODEMEM_KEYS_DIR?.trim() || undefined);
	const [deviceId, fingerprint] = ensureDeviceIdentity(store.db, { keysDir });
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("public key missing");
	const baseUrl = buildBaseUrl(config.syncCoordinatorUrl);
	const payload = {
		fingerprint,
		public_key: publicKey,
		addresses: advertisedSyncAddresses(config),
		ttl_s: Math.max(1, config.syncCoordinatorPresenceTtlS),
		capabilities: {
			sync_capability: LOCAL_SYNC_CAPABILITY,
			sync_features: LOCAL_SYNC_FEATURES,
		},
	};
	const responses: Record<string, unknown>[] = [];
	for (const groupId of config.syncCoordinatorGroups) {
		const groupPayload = { ...payload, group_id: groupId };
		const bodyBytes = Buffer.from(JSON.stringify(groupPayload), "utf8");
		const url = `${baseUrl}/v1/presence`;
		const headers = buildAuthHeaders({
			deviceId,
			dbPath: store.dbPath,
			method: "POST",
			url,
			bodyBytes,
			keysDir,
		});
		const [status, response] = await requestJson("POST", url, {
			headers,
			body: groupPayload,
			bodyBytes,
			timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
		});
		if (status !== 200 || !response) {
			const detail = typeof response?.error === "string" ? response.error : "unknown";
			throw new Error(`coordinator presence failed (${status}: ${detail})`);
		}
		responses.push(response);
	}
	return { groups: config.syncCoordinatorGroups, responses };
}

export async function lookupCoordinatorPeers(
	store: PresenceStoreLike,
	config: CoordinatorSyncConfig,
	options?: { keysDir?: string },
): Promise<Record<string, unknown>[]> {
	if (!coordinatorEnabled(config)) return [];
	const keysDir = options?.keysDir ?? (process.env.CODEMEM_KEYS_DIR?.trim() || undefined);
	const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
	const baseUrl = buildBaseUrl(config.syncCoordinatorUrl);
	const merged = new Map<string, Record<string, unknown>>();
	for (const groupId of config.syncCoordinatorGroups) {
		const url = `${baseUrl}/v1/peers?group_id=${encodeURIComponent(groupId)}`;
		const headers = buildAuthHeaders({
			deviceId,
			dbPath: store.dbPath,
			method: "GET",
			url,
			bodyBytes: Buffer.alloc(0),
			keysDir,
		});
		const [status, response] = await requestJson("GET", url, {
			headers,
			timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
		});
		if (status !== 200 || !response) {
			const detail = typeof response?.error === "string" ? response.error : "unknown";
			throw new Error(`coordinator lookup failed (${status}: ${detail})`);
		}
		const items = Array.isArray(response.items) ? response.items : [];
		for (const item of items) {
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			const device = clean(record.device_id);
			const fingerprint = clean(record.fingerprint);
			if (!device) continue;
			const freshAddresses = record.stale
				? []
				: Array.isArray(record.addresses)
					? record.addresses.filter((x): x is string => typeof x === "string")
					: [];
			const key = `${device}:${fingerprint}`;
			const existing = merged.get(key);
			if (!existing) {
				merged.set(key, {
					...record,
					addresses: mergeAddresses([], freshAddresses),
					coordinator_id: baseUrl,
					groups: [groupId],
					fresh_groups: record.stale ? [] : [groupId],
				});
				continue;
			}
			existing.addresses = mergeAddresses(
				(Array.isArray(existing.addresses) ? existing.addresses : []) as string[],
				freshAddresses,
			);
			existing.groups = mergeStringLists(
				(Array.isArray(existing.groups) ? existing.groups : []) as string[],
				[groupId],
			);
			existing.fresh_groups = mergeStringLists(
				(Array.isArray(existing.fresh_groups) ? existing.fresh_groups : []) as string[],
				record.stale ? [] : [groupId],
			);
			const wasStale = Boolean(existing.stale);
			const isStale = Boolean(record.stale);
			existing.stale = wasStale && isStale;
			const shouldUpdateFreshnessMetadata =
				(!isStale && (wasStale || clean(record.last_seen_at) > clean(existing.last_seen_at))) ||
				(isStale && wasStale && clean(record.last_seen_at) > clean(existing.last_seen_at));
			if (shouldUpdateFreshnessMetadata) {
				existing.last_seen_at = record.last_seen_at;
				existing.expires_at = record.expires_at;
			}
		}
	}
	return [...merged.values()];
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function coordinatorPeerGroups(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const groups: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item.trim()) return null;
		groups.push(item.trim());
	}
	return groups;
}

function parseAddressCache(value: unknown): string[] {
	if (typeof value !== "string" || value.trim().length === 0) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return stringList(parsed);
	} catch {
		return [];
	}
}

/**
 * Refresh cached transport addresses for existing, already-trusted peers from
 * coordinator discovery results.
 *
 * This intentionally does not create peers or change trust/scope metadata. A
 * discovered device can refresh a local peer only when both the device id and
 * the pinned fingerprint match the existing row.
 */
export function refreshStoredCoordinatorPeerAddresses(
	db: Database,
	peers: Record<string, unknown>[],
): number {
	const discoveredAddressesByPinnedPeer = new Map<string, string[]>();
	for (const peer of peers) {
		if (peer.stale) continue;
		const deviceId = clean(peer.device_id);
		const fingerprint = clean(peer.fingerprint);
		if (!deviceId || !fingerprint) continue;
		const addresses = stringList(peer.addresses);
		if (addresses.length === 0) continue;
		const key = `${deviceId}:${fingerprint}`;
		discoveredAddressesByPinnedPeer.set(
			key,
			mergeAddresses(discoveredAddressesByPinnedPeer.get(key) ?? [], addresses),
		);
	}
	if (discoveredAddressesByPinnedPeer.size === 0) return 0;

	const rows = db
		.prepare("SELECT peer_device_id, pinned_fingerprint, addresses_json FROM sync_peers")
		.all() as Array<{
		peer_device_id: string | null;
		pinned_fingerprint: string | null;
		addresses_json: string | null;
	}>;
	const update = db.prepare(
		"UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = ? AND pinned_fingerprint = ?",
	);
	let updated = 0;
	const refresh = db.transaction(() => {
		for (const row of rows) {
			const deviceId = clean(row.peer_device_id);
			const fingerprint = clean(row.pinned_fingerprint);
			if (!deviceId || !fingerprint) continue;
			const discoveredAddresses = discoveredAddressesByPinnedPeer.get(`${deviceId}:${fingerprint}`);
			if (!discoveredAddresses?.length) continue;

			const existingAddresses = mergeAddresses(parseAddressCache(row.addresses_json), []);
			const mergedAddresses = mergeAddressesPreferCandidates(
				existingAddresses,
				discoveredAddresses,
			);
			if (JSON.stringify(mergedAddresses) === JSON.stringify(existingAddresses)) continue;
			update.run(JSON.stringify(mergedAddresses), deviceId, fingerprint);
			updated += 1;
		}
	});
	refresh.immediate();
	return updated;
}

type SharedManagedScopeState =
	| { state: "authorized"; groupId: string }
	| { state: "not_authorized" | "indeterminate" };

function sharedManagedScopeState(
	db: Database,
	localDeviceId: string,
	peerDeviceId: string,
	coordinatorId: string,
	peerGroupIds: string[],
): SharedManagedScopeState {
	const candidateScopes = db
		.prepare(
			`SELECT scope.scope_id, scope.coordinator_id, scope.group_id
			 FROM scope_memberships local_member
			 JOIN scope_memberships peer_member
			   ON peer_member.scope_id = local_member.scope_id
			 JOIN replication_scopes scope
			   ON scope.scope_id = local_member.scope_id
			 WHERE local_member.device_id = ?
			   AND peer_member.device_id = ?
			   AND scope.status = 'active'
			   AND scope.kind = 'managed_project'
			   AND scope.authority_type = 'coordinator'`,
		)
		.all(localDeviceId, peerDeviceId) as Array<{
		scope_id: string;
		coordinator_id: string | null;
		group_id: string | null;
	}>;
	let indeterminate = false;
	for (const scope of candidateScopes) {
		const scopeId = clean(scope.scope_id);
		const groupId = clean(scope.group_id);
		if (
			!scopeId ||
			clean(scope.coordinator_id) !== coordinatorId ||
			!groupId ||
			!peerGroupIds.includes(groupId)
		) {
			continue;
		}
		const authority = { coordinatorId, groupId };
		const localAuthorization = getCachedScopeAuthorization(db, {
			deviceId: localDeviceId,
			scopeId,
			authority,
		});
		const peerAuthorization = getCachedScopeAuthorization(db, {
			deviceId: peerDeviceId,
			scopeId,
			authority,
		});
		if (localAuthorization.freshness !== "fresh" || peerAuthorization.freshness !== "fresh") {
			indeterminate = true;
			continue;
		}
		if (localAuthorization.authorized && peerAuthorization.authorized) {
			return { state: "authorized", groupId };
		}
	}
	return { state: indeterminate ? "indeterminate" : "not_authorized" };
}

/**
 * Trust coordinator-discovered devices only after local policy proves that
 * both devices are active members of a Project managed by the exact
 * coordinator and group that supplied the discovered key.
 */
export function trustCoordinatorPeersWithSharedManagedScopes(
	db: Database,
	localDeviceId: string,
	peers: Record<string, unknown>[],
): number {
	let trusted = 0;
	for (const peer of peers) {
		const peerDeviceId = clean(peer.device_id);
		const publicKey = clean(peer.public_key);
		const fingerprint = clean(peer.fingerprint);
		const coordinatorId = clean(peer.coordinator_id);
		const peerGroupIds = coordinatorPeerGroups(peer.groups);
		if (
			!peerDeviceId ||
			peerDeviceId === localDeviceId ||
			!publicKey ||
			!fingerprint ||
			!coordinatorId ||
			!peerGroupIds
		) {
			continue;
		}
		try {
			if (fingerprintPublicKey(publicKey) !== fingerprint) continue;
		} catch {
			continue;
		}
		const sharedScope = sharedManagedScopeState(
			db,
			localDeviceId,
			peerDeviceId,
			coordinatorId,
			peerGroupIds,
		);
		if (sharedScope.state !== "authorized") continue;
		const existing = db
			.prepare(
				`SELECT pinned_fingerprint, public_key, claimed_local_actor, actor_id,
				 pending_bootstrap_grant_id, trust_provenance
				 FROM sync_peers WHERE peer_device_id = ? LIMIT 1`,
			)
			.get(peerDeviceId) as
			| {
					pinned_fingerprint: string | null;
					public_key: string | null;
					claimed_local_actor: number;
					actor_id: string | null;
					pending_bootstrap_grant_id: string | null;
					trust_provenance: string | null;
			  }
			| undefined;
		if (
			existing &&
			(existing.claimed_local_actor === 1 ||
				(clean(existing.pinned_fingerprint) &&
					clean(existing.pinned_fingerprint) !== fingerprint) ||
				(clean(existing.public_key) && clean(existing.public_key) !== publicKey))
		) {
			continue;
		}
		const existingHasTrust = Boolean(
			clean(existing?.pinned_fingerprint) || clean(existing?.public_key),
		);
		const policyDerivedTrust =
			!existing ||
			(existing.claimed_local_actor === 0 &&
				existing.actor_id == null &&
				existing.pending_bootstrap_grant_id == null &&
				(!existingHasTrust || existing.trust_provenance === "coordinator_policy"));
		const addresses = peer.stale ? [] : stringList(peer.addresses);
		updatePeerAddresses(db, peerDeviceId, addresses, {
			name: clean(peer.display_name) || undefined,
			pinnedFingerprint: fingerprint,
			publicKey,
		});
		if (policyDerivedTrust) {
			db.prepare(
				`UPDATE sync_peers SET discovered_via_coordinator_id = ?,
				 discovered_via_group_id = ?, trust_provenance = 'coordinator_policy'
				 WHERE peer_device_id = ?
				 AND claimed_local_actor = 0 AND actor_id IS NULL
				 AND pending_bootstrap_grant_id IS NULL`,
			).run(coordinatorId, sharedScope.groupId, peerDeviceId);
		}
		trusted += 1;
	}
	return trusted;
}

/** Delete only policy-derived peer rows after their last fresh shared scope ends. */
export function revokeUnauthorizedCoordinatorPeerTrust(
	db: Database,
	localDeviceId: string,
): number {
	const peers = db
		.prepare(
			`SELECT peer_device_id, discovered_via_coordinator_id, discovered_via_group_id
			 FROM sync_peers
			 WHERE claimed_local_actor = 0
			   AND actor_id IS NULL
			   AND pending_bootstrap_grant_id IS NULL
			   AND trust_provenance = 'coordinator_policy'
			   AND discovered_via_coordinator_id IS NOT NULL
			   AND discovered_via_group_id IS NOT NULL
			   AND (pinned_fingerprint IS NOT NULL OR public_key IS NOT NULL)`,
		)
		.all() as Array<{
		peer_device_id: string;
		discovered_via_coordinator_id: string;
		discovered_via_group_id: string;
	}>;
	let revoked = 0;
	for (const peer of peers) {
		const peerDeviceId = clean(peer.peer_device_id);
		const coordinatorId = clean(peer.discovered_via_coordinator_id);
		const groupId = clean(peer.discovered_via_group_id);
		if (!peerDeviceId || !coordinatorId || !groupId) continue;
		const sharedScope = sharedManagedScopeState(db, localDeviceId, peerDeviceId, coordinatorId, [
			groupId,
		]);
		if (sharedScope.state !== "not_authorized") continue;
		const result = db
			.prepare(
				`DELETE FROM sync_peers
				 WHERE peer_device_id = ? AND claimed_local_actor = 0
				 AND actor_id IS NULL AND pending_bootstrap_grant_id IS NULL
				 AND trust_provenance = 'coordinator_policy'
				 AND discovered_via_coordinator_id = ? AND discovered_via_group_id = ?`,
			)
			.run(peerDeviceId, coordinatorId, groupId);
		revoked += result.changes;
	}
	return revoked;
}

export async function refreshAuthorizedCoordinatorPeerTrust(
	store: PresenceStoreLike,
	config: CoordinatorSyncConfig,
	options?: { keysDir?: string },
): Promise<{ peers: Record<string, unknown>[]; trusted: number }> {
	if (!coordinatorEnabled(config)) return { peers: [], trusted: 0 };
	const keysDir = options?.keysDir ?? (process.env.CODEMEM_KEYS_DIR?.trim() || undefined);
	const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir });
	const peers = await lookupCoordinatorPeers(store, config, { keysDir });
	refreshStoredCoordinatorPeerAddresses(store.db, peers);
	const trusted = trustCoordinatorPeersWithSharedManagedScopes(store.db, localDeviceId, peers);
	revokeUnauthorizedCoordinatorPeerTrust(store.db, localDeviceId);
	return { peers, trusted };
}

/**
 * Fetch the set of coordinator peer device IDs whose presence has expired.
 *
 * Returns an empty set when the coordinator is disabled or the lookup fails.
 * Intended as a best-effort preflight for the sync daemon — failures degrade
 * gracefully to the existing reactive shouldSkipOfflinePeer backoff.
 */
export async function fetchCoordinatorStalePeers(
	db: Database,
	dbPath: string,
	keysDir?: string,
): Promise<Set<string>> {
	const config = readCoordinatorSyncConfig();
	if (!coordinatorEnabled(config)) return new Set();
	try {
		const peers = await lookupCoordinatorPeers({ db, dbPath }, config, { keysDir });
		refreshStoredCoordinatorPeerAddresses(db, peers);
		// A device may appear under multiple fingerprints (key rotation, multi-group).
		// Skip device-wide only when all entries are stale, but also return pinned
		// peer keys so an old trusted fingerprint stays fail-closed even when the
		// same device id has a fresh replacement fingerprint.
		const freshDevices = new Set<string>();
		const staleDevices = new Set<string>();
		const freshPinnedPeers = new Set<string>();
		const stalePinnedPeers = new Set<string>();
		for (const peer of peers) {
			const deviceId = clean(peer.device_id);
			if (!deviceId) continue;
			const fingerprint = clean(peer.fingerprint);
			const pinnedPeerKey = fingerprint ? `${deviceId}:${fingerprint}` : "";
			if (peer.stale) {
				staleDevices.add(deviceId);
				if (pinnedPeerKey) stalePinnedPeers.add(pinnedPeerKey);
			} else {
				freshDevices.add(deviceId);
				if (pinnedPeerKey) freshPinnedPeers.add(pinnedPeerKey);
			}
		}
		// Remove any device that has at least one fresh entry
		for (const deviceId of freshDevices) {
			staleDevices.delete(deviceId);
		}
		for (const pinnedPeerKey of freshPinnedPeers) {
			stalePinnedPeers.delete(pinnedPeerKey);
		}
		return new Set([...staleDevices, ...stalePinnedPeers]);
	} catch {
		// Best-effort: if coordinator lookup fails, skip the optimization.
		return new Set();
	}
}

export async function listCoordinatorReciprocalApprovals(
	store: MemoryStore,
	config: CoordinatorSyncConfig,
	options: { direction: "incoming" | "outgoing"; status?: string },
): Promise<CoordinatorReciprocalApproval[]> {
	if (!coordinatorEnabled(config)) return [];
	const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
	const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
	const baseUrl = buildBaseUrl(config.syncCoordinatorUrl);
	const merged = new Map<string, CoordinatorReciprocalApproval>();
	for (const groupId of config.syncCoordinatorGroups) {
		const params = new URLSearchParams({
			group_id: groupId,
			direction: options.direction,
			status: options.status?.trim() || "pending",
		});
		const url = `${baseUrl}/v1/reciprocal-approvals?${params.toString()}`;
		const headers = buildAuthHeaders({
			deviceId,
			dbPath: store.dbPath,
			method: "GET",
			url,
			bodyBytes: Buffer.alloc(0),
			keysDir,
		});
		const [status, response] = await requestJson("GET", url, {
			headers,
			timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
		});
		if (status !== 200 || !response) {
			const detail = typeof response?.error === "string" ? response.error : "unknown";
			throw new Error(`coordinator reciprocal approval lookup failed (${status}: ${detail})`);
		}
		const items = Array.isArray(response.items) ? response.items : [];
		for (const item of items) {
			if (!item || typeof item !== "object") continue;
			const record = item as CoordinatorReciprocalApproval;
			const requestId = clean(record.request_id);
			if (!requestId) continue;
			merged.set(requestId, record);
		}
	}
	return [...merged.values()];
}

export async function createCoordinatorReciprocalApproval(
	store: MemoryStore,
	config: CoordinatorSyncConfig,
	options: { groupId: string; requestedDeviceId: string },
): Promise<CoordinatorReciprocalApproval> {
	if (!coordinatorEnabled(config)) throw new Error("Coordinator not configured.");
	const groupId = options.groupId.trim();
	const requestedDeviceId = options.requestedDeviceId.trim();
	if (!groupId || !requestedDeviceId) {
		throw new Error("groupId and requestedDeviceId are required.");
	}
	const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
	const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
	const baseUrl = buildBaseUrl(config.syncCoordinatorUrl);
	const url = `${baseUrl}/v1/reciprocal-approvals`;
	const payload = { group_id: groupId, requested_device_id: requestedDeviceId };
	const bodyBytes = Buffer.from(JSON.stringify(payload), "utf8");
	const headers = buildAuthHeaders({
		deviceId,
		dbPath: store.dbPath,
		method: "POST",
		url,
		bodyBytes,
		keysDir,
	});
	const [status, response] = await requestJson("POST", url, {
		headers,
		body: payload,
		bodyBytes,
		timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
	});
	if (status !== 200 || !response || !response.request || typeof response.request !== "object") {
		const detail = typeof response?.error === "string" ? response.error : "unknown";
		throw new Error(`coordinator reciprocal approval create failed (${status}: ${detail})`);
	}
	return response.request as CoordinatorReciprocalApproval;
}

function indexReciprocalApprovalsByPeer(
	items: CoordinatorReciprocalApproval[],
	key: "requesting_device_id" | "requested_device_id",
): Map<string, CoordinatorReciprocalApproval> {
	const indexed = new Map<string, CoordinatorReciprocalApproval>();
	for (const item of items) {
		const deviceId = clean(item[key]);
		if (!deviceId) continue;
		indexed.set(deviceId, item);
	}
	return indexed;
}

export async function coordinatorStatusSnapshot(
	store: MemoryStore,
	config: CoordinatorSyncConfig,
): Promise<Record<string, unknown>> {
	const currentPairedPeerCount = pairedPeerCount(store);
	if (!coordinatorEnabled(config)) {
		return {
			enabled: false,
			configured: false,
			sync_enabled: config.syncEnabled,
			coordinator_url: config.syncCoordinatorUrl || null,
			groups: config.syncCoordinatorGroups,
			paired_peer_count: currentPairedPeerCount,
		};
	}
	const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
	const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir });
	const cacheKey = coordinatorStatusCacheKey(store, config);
	const now = Date.now();
	const cachedSnapshot = coordinatorStatusCache.get(cacheKey);
	if (cachedSnapshot && now < cachedSnapshot.nextRefreshAtMs) {
		trustCoordinatorPeersWithSharedManagedScopes(
			store.db,
			localDeviceId,
			cachedSnapshot.discoveredPeers,
		);
		return {
			...structuredClone(cachedSnapshot.snapshot),
			paired_peer_count: pairedPeerCount(store),
		};
	}
	const snapshot: Record<string, unknown> = {
		enabled: true,
		configured: true,
		sync_enabled: config.syncEnabled,
		coordinator_url: config.syncCoordinatorUrl,
		groups: config.syncCoordinatorGroups,
		paired_peer_count: currentPairedPeerCount,
		presence_status: "unknown",
		presence_error: null,
		advertised_addresses: [],
		fresh_peer_count: 0,
		stale_peer_count: 0,
		discovered_peer_count: 0,
		discovered_devices: [],
	};
	const presenceKey = presenceCacheKey(store, config);
	const cachedPresence = coordinatorPresenceCache.get(presenceKey);
	if (cachedPresence && now < cachedPresence.nextRefreshAtMs) {
		snapshot.presence_status = cachedPresence.status;
		snapshot.presence_error = cachedPresence.error;
		snapshot.advertised_addresses = cachedPresence.advertisedAddresses;
	} else {
		try {
			const registration = await registerCoordinatorPresence(store, config);
			const first = registration?.responses?.[0];
			const advertisedAddresses =
				first && typeof first === "object"
					? ((first as Record<string, unknown>).addresses ?? [])
					: [];
			snapshot.presence_status = "posted";
			snapshot.advertised_addresses = advertisedAddresses;
			coordinatorPresenceCache.set(presenceKey, {
				status: "posted",
				error: null,
				advertisedAddresses,
				nextRefreshAtMs: now + presenceRefreshIntervalMs(config),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status: PresenceStatus = message.includes("unknown_device") ? "not_enrolled" : "error";
			const nextRefreshAtMs = status === "not_enrolled" ? now : now + presenceRetryIntervalMs();
			snapshot.presence_status = status;
			snapshot.presence_error = message;
			coordinatorPresenceCache.set(presenceKey, {
				status,
				error: message,
				advertisedAddresses: [],
				nextRefreshAtMs,
			});
		}
	}
	let discoveredPeers: Record<string, unknown>[] = [];
	try {
		const { peers } = await refreshAuthorizedCoordinatorPeerTrust(store, config, { keysDir });
		discoveredPeers = structuredClone(peers);
		let incomingApprovals: CoordinatorReciprocalApproval[] = [];
		let outgoingApprovals: CoordinatorReciprocalApproval[] = [];
		try {
			incomingApprovals = await listCoordinatorReciprocalApprovals(store, config, {
				direction: "incoming",
			});
			outgoingApprovals = await listCoordinatorReciprocalApprovals(store, config, {
				direction: "outgoing",
			});
		} catch (error) {
			snapshot.reciprocal_approval_error = error instanceof Error ? error.message : String(error);
		}
		const incomingByPeer = indexReciprocalApprovalsByPeer(
			incomingApprovals,
			"requesting_device_id",
		);
		const outgoingByPeer = indexReciprocalApprovalsByPeer(outgoingApprovals, "requested_device_id");
		snapshot.discovered_peer_count = peers.length;
		snapshot.fresh_peer_count = peers.filter((peer) => !peer.stale).length;
		snapshot.stale_peer_count = peers.filter((peer) => Boolean(peer.stale)).length;
		snapshot.reciprocal_approvals = {
			incoming: incomingApprovals,
			outgoing: outgoingApprovals,
		};
		snapshot.discovered_devices = peers.map((peer) => ({
			device_id: peer.device_id,
			display_name: peer.display_name ?? null,
			fingerprint: peer.fingerprint ?? null,
			addresses: Array.isArray(peer.addresses) ? peer.addresses : [],
			groups: Array.isArray(peer.groups) ? peer.groups : [],
			last_seen_at: peer.last_seen_at ?? null,
			expires_at: peer.expires_at ?? null,
			stale: Boolean(peer.stale),
			needs_local_approval: incomingByPeer.has(clean(peer.device_id)),
			waiting_for_peer_approval: outgoingByPeer.has(clean(peer.device_id)),
			incoming_reciprocal_request_id: incomingByPeer.get(clean(peer.device_id))?.request_id ?? null,
			outgoing_reciprocal_request_id: outgoingByPeer.get(clean(peer.device_id))?.request_id ?? null,
		}));
	} catch (error) {
		snapshot.lookup_error = error instanceof Error ? error.message : String(error);
	}
	if (snapshot.presence_status !== "not_enrolled") {
		coordinatorStatusCache.set(cacheKey, {
			snapshot: structuredClone(snapshot),
			discoveredPeers,
			nextRefreshAtMs: Date.now() + COORDINATOR_STATUS_SNAPSHOT_CACHE_MS,
		});
	}
	return snapshot;
}

export async function listCoordinatorJoinRequests(
	config: CoordinatorSyncConfig,
): Promise<Record<string, unknown>[]> {
	const groupId = config.syncCoordinatorGroup || config.syncCoordinatorGroups[0] || "";
	if (!groupId || !config.syncCoordinatorUrl || !config.syncCoordinatorAdminSecret) return [];
	const url = `${buildBaseUrl(config.syncCoordinatorUrl)}/v1/admin/join-requests?group_id=${encodeURIComponent(groupId)}`;
	const [status, response] = await requestJson("GET", url, {
		headers: { "X-Codemem-Coordinator-Admin": config.syncCoordinatorAdminSecret },
		timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
	});
	if (status !== 200 || !response) return [];
	return Array.isArray(response.items)
		? response.items.filter(
				(item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
			)
		: [];
}
