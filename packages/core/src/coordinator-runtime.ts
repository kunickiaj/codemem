import { networkInterfaces } from "node:os";
import { mergeAddresses } from "./address-utils.js";
import type { CoordinatorReciprocalApproval } from "./coordinator-store-contract.js";
import { getCodememEnvOverrides, readCodememConfigFile } from "./observer-config.js";
import type { MemoryStore } from "./store.js";
import { buildAuthHeaders } from "./sync-auth.js";
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

export interface CoordinatorSyncConfig {
	syncEnabled: boolean;
	syncHost: string;
	syncPort: number;
	syncIntervalS: number;
	syncAdvertise: string;
	syncRetentionEnabled: boolean;
	syncRetentionMaxAgeDays: number;
	syncRetentionMaxSizeMb: number;
	syncRetentionIntervalS: number;
	syncRetentionMaxRuntimeMs: number;
	syncRetentionMaxOpsPerPass: number;
	syncProjectsInclude: string[];
	syncProjectsExclude: string[];
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

const coordinatorPresenceCache = new Map<string, PresenceSnapshot>();

function presenceCacheKey(store: PresenceStoreLike, config: CoordinatorSyncConfig): string {
	const groups = [...config.syncCoordinatorGroups].sort().join(",");
	return `${store.dbPath}|${config.syncCoordinatorUrl}|${groups}`;
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
		syncRetentionEnabled: parseBoolOr(raw.sync_retention_enabled, false),
		syncRetentionMaxAgeDays: Math.max(1, parseIntOr(raw.sync_retention_max_age_days, 30)),
		syncRetentionMaxSizeMb: Math.max(1, parseIntOr(raw.sync_retention_max_size_mb, 512)),
		syncRetentionIntervalS: Math.max(5, parseIntOr(raw.sync_retention_interval_s, 300)),
		syncRetentionMaxRuntimeMs: Math.max(100, parseIntOr(raw.sync_retention_max_runtime_ms, 2000)),
		syncRetentionMaxOpsPerPass: Math.max(1, parseIntOr(raw.sync_retention_max_ops_per_pass, 5000)),
		syncProjectsInclude: parseStringList(raw.sync_projects_include),
		syncProjectsExclude: parseStringList(raw.sync_projects_exclude),
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

function advertisedSyncAddresses(config: CoordinatorSyncConfig): string[] {
	const advertise = config.syncAdvertise.toLowerCase();
	if (advertise && advertise !== "auto" && advertise !== "default") {
		return mergeAddresses(
			[],
			advertise
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		);
	}
	if (config.syncHost && config.syncHost !== "0.0.0.0") {
		return [`${config.syncHost}:${config.syncPort}`];
	}
	const addresses = Object.values(networkInterfaces())
		.flatMap((entries) => entries ?? [])
		.filter((entry) => !entry.internal)
		.map((entry) => entry.address)
		.filter((address) => address && address !== "127.0.0.1" && address !== "::1")
		.map((address) => `${address}:${config.syncPort}`);
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
	};
	const responses: Record<string, unknown>[] = [];
	for (const groupId of config.syncCoordinatorGroups) {
		const groupPayload = { ...payload, group_id: groupId };
		const bodyBytes = Buffer.from(JSON.stringify(groupPayload), "utf8");
		const url = `${baseUrl}/v1/presence`;
		const headers = buildAuthHeaders({ deviceId, method: "POST", url, bodyBytes, keysDir });
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
	store: MemoryStore,
	config: CoordinatorSyncConfig,
): Promise<Record<string, unknown>[]> {
	if (!coordinatorEnabled(config)) return [];
	const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
	const [deviceId] = ensureDeviceIdentity(store.db, { keysDir });
	const baseUrl = buildBaseUrl(config.syncCoordinatorUrl);
	const merged = new Map<string, Record<string, unknown>>();
	for (const groupId of config.syncCoordinatorGroups) {
		const url = `${baseUrl}/v1/peers?group_id=${encodeURIComponent(groupId)}`;
		const headers = buildAuthHeaders({
			deviceId,
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
			const key = `${device}:${fingerprint}`;
			const existing = merged.get(key);
			if (!existing) {
				merged.set(key, {
					...record,
					addresses: mergeAddresses(
						[],
						Array.isArray(record.addresses)
							? record.addresses.filter((x): x is string => typeof x === "string")
							: [],
					),
					groups: [groupId],
				});
				continue;
			}
			existing.addresses = mergeAddresses(
				(Array.isArray(existing.addresses) ? existing.addresses : []) as string[],
				Array.isArray(record.addresses)
					? record.addresses.filter((x): x is string => typeof x === "string")
					: [],
			);
			existing.groups = mergeAddresses(
				(Array.isArray(existing.groups) ? existing.groups : []) as string[],
				[groupId],
			);
			existing.stale = Boolean(existing.stale) && Boolean(record.stale);
			if (clean(record.last_seen_at) > clean(existing.last_seen_at)) {
				existing.last_seen_at = record.last_seen_at;
				existing.expires_at = record.expires_at;
			}
		}
	}
	return [...merged.values()];
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
	const headers = buildAuthHeaders({ deviceId, method: "POST", url, bodyBytes, keysDir });
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
	const pairedPeerCount = Number(
		(
			store.db.prepare("SELECT COUNT(1) AS total FROM sync_peers").get() as
				| { total?: number }
				| undefined
		)?.total ?? 0,
	);
	if (!coordinatorEnabled(config)) {
		return {
			enabled: false,
			configured: false,
			groups: config.syncCoordinatorGroups,
			paired_peer_count: pairedPeerCount,
		};
	}
	const snapshot: Record<string, unknown> = {
		enabled: true,
		configured: true,
		coordinator_url: config.syncCoordinatorUrl,
		groups: config.syncCoordinatorGroups,
		paired_peer_count: pairedPeerCount,
		presence_status: "unknown",
		presence_error: null,
		advertised_addresses: [],
		fresh_peer_count: 0,
		stale_peer_count: 0,
		discovered_peer_count: 0,
		discovered_devices: [],
	};
	const cacheKey = presenceCacheKey(store, config);
	const now = Date.now();
	const cachedPresence = coordinatorPresenceCache.get(cacheKey);
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
			coordinatorPresenceCache.set(cacheKey, {
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
			coordinatorPresenceCache.set(cacheKey, {
				status,
				error: message,
				advertisedAddresses: [],
				nextRefreshAtMs,
			});
		}
	}
	try {
		const peers = await lookupCoordinatorPeers(store, config);
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
