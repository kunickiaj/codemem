import {
	coordinatorListScopeMembershipsAction,
	coordinatorListScopesAction,
} from "./coordinator-actions.js";
import {
	type CoordinatorSyncConfig,
	coordinatorEnabled,
	readCoordinatorSyncConfig,
} from "./coordinator-runtime.js";
import type { CoordinatorScope, CoordinatorScopeMembership } from "./coordinator-store-contract.js";
import type { Database } from "./db.js";
import { buildBaseUrl } from "./sync-http-client.js";

export const DEFAULT_SCOPE_MEMBERSHIP_CACHE_MAX_AGE_MS = 60_000;

export type ScopeMembershipCacheFreshness = "fresh" | "stale" | "unknown";

export type ScopeMembershipAuthorizationState =
	| "authorized"
	| "not_authorized"
	| "revoked"
	| "scope_unknown"
	| "scope_inactive";

export interface ScopeMembershipCacheAuthority {
	coordinatorId: string;
	groupId: string;
}

export interface ScopeMembershipCacheState extends ScopeMembershipCacheAuthority {
	last_refresh_at: string;
	last_success_at: string | null;
	last_error: string | null;
	updated_at: string;
}

export interface CachedScopeMembership extends CoordinatorScopeMembership {
	scope: CoordinatorScope | null;
}

export interface CachedDeviceScopeMemberships {
	deviceId: string;
	freshness: ScopeMembershipCacheFreshness;
	memberships: CachedScopeMembership[];
	cacheStates: ScopeMembershipCacheState[];
}

export interface CachedScopeAuthorization {
	deviceId: string;
	scopeId: string;
	authorized: boolean;
	state: ScopeMembershipAuthorizationState;
	freshness: ScopeMembershipCacheFreshness;
	membership: CoordinatorScopeMembership | null;
	scope: CoordinatorScope | null;
	cacheStates: ScopeMembershipCacheState[];
}

export interface ScopeMembershipCacheFetchers {
	listScopes(groupId: string): Promise<CoordinatorScope[]>;
	listMemberships(groupId: string, scopeId: string): Promise<CoordinatorScopeMembership[]>;
}

export interface RefreshScopeMembershipCacheOptions {
	groupIds: string[];
	coordinatorId?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
	now?: Date;
	fetchers?: ScopeMembershipCacheFetchers;
}

export interface RefreshScopeMembershipCacheGroupResult {
	groupId: string;
	status: "refreshed" | "stale";
	scopeCount: number;
	membershipCount: number;
	error: string | null;
}

export interface RefreshScopeMembershipCacheResult {
	status: "refreshed" | "partial" | "stale" | "skipped";
	coordinatorId: string | null;
	groups: RefreshScopeMembershipCacheGroupResult[];
}

interface ScopeMembershipCacheLookupOptions {
	now?: Date;
	maxAgeMs?: number;
	authority?: ScopeMembershipCacheAuthority | null;
}

interface JoinedMembershipRow extends CoordinatorScopeMembership {
	scope_label: string | null;
	scope_kind: string | null;
	scope_authority_type: string | null;
	scope_coordinator_id: string | null;
	scope_group_id: string | null;
	scope_manifest_issuer_device_id: string | null;
	scope_membership_epoch: number | null;
	scope_manifest_hash: string | null;
	scope_status: string | null;
	scope_created_at: string | null;
	scope_updated_at: string | null;
}

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function nowIso(now?: Date): string {
	return (now ?? new Date()).toISOString();
}

function groupIds(input: string[]): string[] {
	return [...new Set(input.map((item) => item.trim()).filter(Boolean))].toSorted();
}

function authorityId(remoteUrl: string | null | undefined): string {
	const remote = clean(remoteUrl);
	if (!remote) return "local";
	try {
		return buildBaseUrl(remote);
	} catch {
		return remote;
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error ?? "unknown");
}

export function ensureScopeMembershipCacheStateTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS scope_membership_cache_state (
			coordinator_id TEXT NOT NULL,
			group_id TEXT NOT NULL,
			last_refresh_at TEXT NOT NULL,
			last_success_at TEXT,
			last_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (coordinator_id, group_id)
		)
	`);
}

function defaultFetchers(opts: RefreshScopeMembershipCacheOptions): ScopeMembershipCacheFetchers {
	return {
		listScopes: (groupId) =>
			coordinatorListScopesAction({
				groupId,
				includeInactive: true,
				remoteUrl: opts.remoteUrl ?? null,
				adminSecret: opts.adminSecret ?? null,
			}),
		listMemberships: (groupId, scopeId) =>
			coordinatorListScopeMembershipsAction({
				groupId,
				scopeId,
				includeRevoked: true,
				remoteUrl: opts.remoteUrl ?? null,
				adminSecret: opts.adminSecret ?? null,
			}),
	};
}

function upsertScope(db: Database, scope: CoordinatorScope): void {
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(scope_id) DO UPDATE SET
			label = excluded.label,
			kind = excluded.kind,
			authority_type = excluded.authority_type,
			coordinator_id = excluded.coordinator_id,
			group_id = excluded.group_id,
			manifest_issuer_device_id = excluded.manifest_issuer_device_id,
			membership_epoch = excluded.membership_epoch,
			manifest_hash = excluded.manifest_hash,
			status = excluded.status,
			updated_at = excluded.updated_at
		WHERE excluded.membership_epoch >= replication_scopes.membership_epoch`,
	).run(
		scope.scope_id,
		scope.label,
		scope.kind,
		scope.authority_type,
		scope.coordinator_id,
		scope.group_id,
		scope.manifest_issuer_device_id,
		scope.membership_epoch,
		scope.manifest_hash,
		scope.status,
		scope.created_at,
		scope.updated_at,
	);
}

function scopeWithAuthority(
	scope: CoordinatorScope,
	authority: ScopeMembershipCacheAuthority,
): CoordinatorScope {
	return {
		...scope,
		coordinator_id: clean(scope.coordinator_id) ?? authority.coordinatorId,
		group_id: clean(scope.group_id) ?? authority.groupId,
	};
}

function membershipWithAuthority(
	membership: CoordinatorScopeMembership,
	scope: CoordinatorScope,
	authority: ScopeMembershipCacheAuthority,
): CoordinatorScopeMembership {
	return {
		...membership,
		coordinator_id:
			clean(membership.coordinator_id) ?? clean(scope.coordinator_id) ?? authority.coordinatorId,
		group_id: clean(membership.group_id) ?? clean(scope.group_id) ?? authority.groupId,
	};
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

function reconcileScopeMembershipSnapshot(
	db: Database,
	scope: CoordinatorScope,
	memberships: CoordinatorScopeMembership[],
	authority: ScopeMembershipCacheAuthority,
	timestamp: string,
): void {
	const deviceIds = memberships.map((membership) => membership.device_id);
	const deviceFilter =
		deviceIds.length > 0 ? `AND device_id NOT IN (${placeholders(deviceIds.length)})` : "";
	db.prepare(
		`UPDATE scope_memberships
		 SET status = 'revoked',
			 membership_epoch = CASE WHEN membership_epoch > ? THEN membership_epoch ELSE ? END,
			 coordinator_id = COALESCE(coordinator_id, ?),
			 group_id = COALESCE(group_id, ?),
			 updated_at = ?
		 WHERE scope_id = ?
			 AND COALESCE(coordinator_id, ?) = ?
			 AND COALESCE(group_id, ?) = ?
			 AND status != 'revoked'
			 ${deviceFilter}`,
	).run(
		scope.membership_epoch,
		scope.membership_epoch,
		authority.coordinatorId,
		authority.groupId,
		timestamp,
		scope.scope_id,
		authority.coordinatorId,
		authority.coordinatorId,
		authority.groupId,
		authority.groupId,
		...deviceIds,
	);
}

function reconcileGroupScopeSnapshot(
	db: Database,
	authority: ScopeMembershipCacheAuthority,
	scopes: CoordinatorScope[],
	timestamp: string,
): void {
	const scopeIds = scopes.map((scope) => scope.scope_id);
	const scopeFilter =
		scopeIds.length > 0 ? `AND scope_id NOT IN (${placeholders(scopeIds.length)})` : "";
	const missing = db
		.prepare(
			`SELECT scope_id
			 FROM replication_scopes
			 WHERE coordinator_id = ?
				 AND group_id = ?
				 ${scopeFilter}`,
		)
		.all(authority.coordinatorId, authority.groupId, ...scopeIds) as Array<{ scope_id: string }>;
	if (missing.length === 0) return;
	const missingScopeIds = missing.map((row) => row.scope_id);
	db.prepare(
		`UPDATE replication_scopes
		 SET status = 'archived', updated_at = ?
		 WHERE coordinator_id = ?
			 AND group_id = ?
			 AND scope_id IN (${placeholders(missingScopeIds.length)})`,
	).run(timestamp, authority.coordinatorId, authority.groupId, ...missingScopeIds);
	db.prepare(
		`UPDATE scope_memberships
		 SET status = 'revoked', updated_at = ?
		 WHERE COALESCE(coordinator_id, ?) = ?
			 AND COALESCE(group_id, ?) = ?
			 AND scope_id IN (${placeholders(missingScopeIds.length)})
			 AND status != 'revoked'`,
	).run(
		timestamp,
		authority.coordinatorId,
		authority.coordinatorId,
		authority.groupId,
		authority.groupId,
		...missingScopeIds,
	);
}

export function upsertCachedScopeMemberships(
	db: Database,
	memberships: CoordinatorScopeMembership[],
): number {
	const insert = db.prepare(
		`INSERT INTO scope_memberships(
			scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id,
			manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(scope_id, device_id) DO UPDATE SET
			role = excluded.role,
			status = excluded.status,
			membership_epoch = excluded.membership_epoch,
			coordinator_id = excluded.coordinator_id,
			group_id = excluded.group_id,
			manifest_issuer_device_id = excluded.manifest_issuer_device_id,
			manifest_hash = excluded.manifest_hash,
			signed_manifest_json = excluded.signed_manifest_json,
			updated_at = excluded.updated_at
		WHERE excluded.membership_epoch > scope_memberships.membership_epoch
			OR (
				excluded.membership_epoch = scope_memberships.membership_epoch
				AND scope_memberships.status != 'revoked'
			)`,
	);
	let count = 0;
	db.transaction(() => {
		for (const membership of memberships) {
			insert.run(
				membership.scope_id,
				membership.device_id,
				membership.role,
				membership.status,
				membership.membership_epoch,
				membership.coordinator_id,
				membership.group_id,
				membership.manifest_issuer_device_id,
				membership.manifest_hash,
				membership.signed_manifest_json,
				membership.updated_at,
			);
			count += 1;
		}
	})();
	return count;
}

function recordRefreshState(
	db: Database,
	input: ScopeMembershipCacheAuthority & { ok: boolean; error?: string | null; now: string },
): void {
	ensureScopeMembershipCacheStateTable(db);
	db.prepare(
		`INSERT INTO scope_membership_cache_state(
			coordinator_id, group_id, last_refresh_at, last_success_at, last_error, updated_at
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(coordinator_id, group_id) DO UPDATE SET
			last_refresh_at = excluded.last_refresh_at,
			last_success_at = COALESCE(excluded.last_success_at, scope_membership_cache_state.last_success_at),
			last_error = excluded.last_error,
			updated_at = excluded.updated_at`,
	).run(
		input.coordinatorId,
		input.groupId,
		input.now,
		input.ok ? input.now : null,
		input.ok ? null : (input.error ?? "unknown"),
		input.now,
	);
}

function loadCacheStates(
	db: Database,
	authority?: ScopeMembershipCacheAuthority | null,
): ScopeMembershipCacheState[] {
	ensureScopeMembershipCacheStateTable(db);
	if (authority) {
		return db
			.prepare(
				`SELECT coordinator_id, group_id, last_refresh_at, last_success_at, last_error, updated_at
				 FROM scope_membership_cache_state
				 WHERE coordinator_id = ? AND group_id = ?`,
			)
			.all(authority.coordinatorId, authority.groupId) as ScopeMembershipCacheState[];
	}
	return db
		.prepare(
			`SELECT coordinator_id, group_id, last_refresh_at, last_success_at, last_error, updated_at
			 FROM scope_membership_cache_state
			 ORDER BY coordinator_id ASC, group_id ASC`,
		)
		.all() as ScopeMembershipCacheState[];
}

function freshness(
	states: ScopeMembershipCacheState[],
	options: { now?: Date; maxAgeMs?: number },
): ScopeMembershipCacheFreshness {
	if (states.length === 0) return "unknown";
	if (states.some((state) => clean(state.last_error) != null)) return "stale";
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_SCOPE_MEMBERSHIP_CACHE_MAX_AGE_MS;
	const nowMs = (options.now ?? new Date()).getTime();
	return states.some((state) => {
		const refreshedAt = Date.parse(state.last_success_at ?? "");
		return !Number.isFinite(refreshedAt) || nowMs - refreshedAt > maxAgeMs;
	})
		? "stale"
		: "fresh";
}

function scopeFromJoinedRow(row: JoinedMembershipRow): CoordinatorScope | null {
	if (!row.scope_label || !row.scope_kind || !row.scope_authority_type) return null;
	return {
		scope_id: row.scope_id,
		label: row.scope_label,
		kind: row.scope_kind,
		authority_type: row.scope_authority_type,
		coordinator_id: row.scope_coordinator_id,
		group_id: row.scope_group_id,
		manifest_issuer_device_id: row.scope_manifest_issuer_device_id,
		membership_epoch: row.scope_membership_epoch ?? row.membership_epoch,
		manifest_hash: row.scope_manifest_hash,
		status: row.scope_status ?? "active",
		created_at: row.scope_created_at ?? row.updated_at,
		updated_at: row.scope_updated_at ?? row.updated_at,
	};
}

function loadScope(
	db: Database,
	scopeId: string,
	authority?: ScopeMembershipCacheAuthority | null,
): CoordinatorScope | null {
	const authorityFilter = authority ? " AND coordinator_id = ? AND group_id = ?" : "";
	const params = authority ? [scopeId, authority.coordinatorId, authority.groupId] : [scopeId];
	const row = db
		.prepare(
			`SELECT scope_id, label, kind, authority_type, coordinator_id, group_id,
				manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at
			 FROM replication_scopes
			 WHERE scope_id = ?${authorityFilter}
			 LIMIT 1`,
		)
		.get(...params) as CoordinatorScope | undefined;
	return row ?? null;
}

function membershipFromJoinedRow(row: JoinedMembershipRow): CoordinatorScopeMembership {
	return {
		scope_id: row.scope_id,
		device_id: row.device_id,
		role: row.role,
		status: row.status,
		membership_epoch: row.membership_epoch,
		coordinator_id: row.coordinator_id,
		group_id: row.group_id,
		manifest_issuer_device_id: row.manifest_issuer_device_id,
		manifest_hash: row.manifest_hash,
		signed_manifest_json: row.signed_manifest_json,
		updated_at: row.updated_at,
	};
}

function joinedMembershipSelect(whereSql: string): string {
	return `SELECT
		sm.scope_id,
		sm.device_id,
		sm.role,
		sm.status,
		sm.membership_epoch,
		sm.coordinator_id,
		sm.group_id,
		sm.manifest_issuer_device_id,
		sm.manifest_hash,
		sm.signed_manifest_json,
		sm.updated_at,
		rs.label AS scope_label,
		rs.kind AS scope_kind,
		rs.authority_type AS scope_authority_type,
		rs.coordinator_id AS scope_coordinator_id,
		rs.group_id AS scope_group_id,
		rs.manifest_issuer_device_id AS scope_manifest_issuer_device_id,
		rs.membership_epoch AS scope_membership_epoch,
		rs.manifest_hash AS scope_manifest_hash,
		rs.status AS scope_status,
		rs.created_at AS scope_created_at,
		rs.updated_at AS scope_updated_at
	FROM scope_memberships sm
	LEFT JOIN replication_scopes rs ON rs.scope_id = sm.scope_id
	${whereSql}`;
}

function authorityFromMembership(
	membership: CoordinatorScopeMembership | null,
	fallback?: ScopeMembershipCacheAuthority | null,
): ScopeMembershipCacheAuthority | null {
	const coordinatorId = clean(membership?.coordinator_id) ?? fallback?.coordinatorId;
	const groupId = clean(membership?.group_id) ?? fallback?.groupId;
	return coordinatorId && groupId ? { coordinatorId, groupId } : null;
}

function authorityFromScope(scope: CoordinatorScope | null): ScopeMembershipCacheAuthority | null {
	const coordinatorId = clean(scope?.coordinator_id);
	const groupId = clean(scope?.group_id);
	return coordinatorId && groupId ? { coordinatorId, groupId } : null;
}

export async function refreshScopeMembershipCache(
	db: Database,
	opts: RefreshScopeMembershipCacheOptions,
): Promise<RefreshScopeMembershipCacheResult> {
	const groups = groupIds(opts.groupIds);
	if (groups.length === 0) return { status: "skipped", coordinatorId: null, groups: [] };
	const coordinatorId = clean(opts.coordinatorId) ?? authorityId(opts.remoteUrl);
	const authorityForGroup = (groupId: string): ScopeMembershipCacheAuthority => ({
		coordinatorId,
		groupId,
	});
	const fetchers = opts.fetchers ?? defaultFetchers(opts);
	const timestamp = nowIso(opts.now);
	const results: RefreshScopeMembershipCacheGroupResult[] = [];

	for (const groupId of groups) {
		try {
			const authority = authorityForGroup(groupId);
			const scopes = (await fetchers.listScopes(groupId)).map((scope) =>
				scopeWithAuthority(scope, authority),
			);
			const membershipBatches: Array<{
				scope: CoordinatorScope;
				memberships: CoordinatorScopeMembership[];
			}> = [];
			for (const scope of scopes) {
				const memberships = (await fetchers.listMemberships(groupId, scope.scope_id)).map(
					(membership) => membershipWithAuthority(membership, scope, authority),
				);
				membershipBatches.push({ scope, memberships });
			}
			db.transaction(() => {
				for (const scope of scopes) upsertScope(db, scope);
				for (const batch of membershipBatches) {
					upsertCachedScopeMemberships(db, batch.memberships);
					reconcileScopeMembershipSnapshot(
						db,
						batch.scope,
						batch.memberships,
						authority,
						timestamp,
					);
				}
				reconcileGroupScopeSnapshot(db, authority, scopes, timestamp);
				recordRefreshState(db, { coordinatorId, groupId, ok: true, now: timestamp });
			})();
			const membershipCount = membershipBatches.reduce(
				(count, batch) => count + batch.memberships.length,
				0,
			);
			results.push({
				groupId,
				status: "refreshed",
				scopeCount: scopes.length,
				membershipCount,
				error: null,
			});
		} catch (error) {
			const message = errorMessage(error);
			recordRefreshState(db, { coordinatorId, groupId, ok: false, error: message, now: timestamp });
			results.push({ groupId, status: "stale", scopeCount: 0, membershipCount: 0, error: message });
		}
	}

	const refreshed = results.filter((result) => result.status === "refreshed").length;
	const status = refreshed === results.length ? "refreshed" : refreshed === 0 ? "stale" : "partial";
	return { status, coordinatorId, groups: results };
}

export async function refreshConfiguredScopeMembershipCache(
	db: Database,
	config?: CoordinatorSyncConfig,
): Promise<RefreshScopeMembershipCacheResult> {
	const syncConfig = config ?? readCoordinatorSyncConfig();
	if (!coordinatorEnabled(syncConfig) || !syncConfig.syncCoordinatorAdminSecret) {
		return { status: "skipped", coordinatorId: null, groups: [] };
	}
	return refreshScopeMembershipCache(db, {
		groupIds: syncConfig.syncCoordinatorGroups,
		coordinatorId: authorityId(syncConfig.syncCoordinatorUrl),
		remoteUrl: syncConfig.syncCoordinatorUrl,
		adminSecret: syncConfig.syncCoordinatorAdminSecret,
	});
}

export function listCachedScopesForDevice(
	db: Database,
	deviceId: string,
	opts: ScopeMembershipCacheLookupOptions = {},
): CachedDeviceScopeMemberships {
	const cleanDeviceId = clean(deviceId);
	if (!cleanDeviceId) throw new Error("device_id is required.");
	ensureScopeMembershipCacheStateTable(db);
	const params: string[] = [cleanDeviceId];
	const authorityFilter = opts.authority
		? " AND COALESCE(sm.coordinator_id, rs.coordinator_id) = ? AND COALESCE(sm.group_id, rs.group_id) = ?"
		: "";
	if (opts.authority) params.push(opts.authority.coordinatorId, opts.authority.groupId);
	const rows = db
		.prepare(
			`${joinedMembershipSelect(
				`WHERE sm.device_id = ? AND sm.status = 'active' AND rs.scope_id IS NOT NULL AND rs.status = 'active'${authorityFilter}`,
			)} ORDER BY sm.scope_id ASC`,
		)
		.all(...params) as JoinedMembershipRow[];
	const cacheStates = loadCacheStates(db, opts.authority ?? null);
	return {
		deviceId: cleanDeviceId,
		freshness: freshness(cacheStates, opts),
		memberships: rows.map((row) => ({
			...membershipFromJoinedRow(row),
			scope: scopeFromJoinedRow(row),
		})),
		cacheStates,
	};
}

export function getCachedScopeAuthorization(
	db: Database,
	input: { deviceId: string; scopeId: string } & ScopeMembershipCacheLookupOptions,
): CachedScopeAuthorization {
	const deviceId = clean(input.deviceId);
	const scopeId = clean(input.scopeId);
	if (!deviceId || !scopeId) throw new Error("device_id and scope_id are required.");
	ensureScopeMembershipCacheStateTable(db);
	const authorityFilter = input.authority
		? " AND COALESCE(sm.coordinator_id, rs.coordinator_id) = ? AND COALESCE(sm.group_id, rs.group_id) = ?"
		: "";
	const params = input.authority
		? [deviceId, scopeId, input.authority.coordinatorId, input.authority.groupId]
		: [deviceId, scopeId];
	const row = db
		.prepare(
			`${joinedMembershipSelect(`WHERE sm.device_id = ? AND sm.scope_id = ?${authorityFilter} LIMIT 1`)}`,
		)
		.get(...params) as JoinedMembershipRow | undefined;
	const membership = row ? membershipFromJoinedRow(row) : null;
	const scope = row ? scopeFromJoinedRow(row) : loadScope(db, scopeId, input.authority ?? null);
	const authority = authorityFromMembership(
		membership,
		input.authority ?? authorityFromScope(scope),
	);
	const cacheStates = loadCacheStates(db, authority);
	const currentFreshness = freshness(cacheStates, input);
	if (!membership) {
		return {
			deviceId,
			scopeId,
			authorized: false,
			state: "not_authorized",
			freshness: currentFreshness,
			membership: null,
			scope,
			cacheStates,
		};
	}
	if (membership.status === "revoked") {
		return {
			deviceId,
			scopeId,
			authorized: false,
			state: "revoked",
			freshness: currentFreshness,
			membership,
			scope,
			cacheStates,
		};
	}
	if (scope?.status && scope.status !== "active") {
		return {
			deviceId,
			scopeId,
			authorized: false,
			state: "scope_inactive",
			freshness: currentFreshness,
			membership,
			scope,
			cacheStates,
		};
	}
	if (!scope) {
		return {
			deviceId,
			scopeId,
			authorized: false,
			state: "scope_unknown",
			freshness: currentFreshness,
			membership,
			scope: null,
			cacheStates,
		};
	}
	return {
		deviceId,
		scopeId,
		authorized: membership.status === "active",
		state: membership.status === "active" ? "authorized" : "not_authorized",
		freshness: currentFreshness,
		membership,
		scope,
		cacheStates,
	};
}
