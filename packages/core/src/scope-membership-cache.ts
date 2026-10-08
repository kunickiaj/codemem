import { BetterSqliteCoordinatorStore, DEFAULT_COORDINATOR_DB_PATH } from "./coordinator-store.js";
import type { CoordinatorScope, CoordinatorScopeMembership } from "./coordinator-store-contract.js";
import {
	type CoordinatorSyncConfig,
	coordinatorEnabled,
	readCoordinatorSyncConfig,
} from "./coordinator-sync-config.js";
import type { Database } from "./db.js";
import { getAnyRecipientPolicyDenyOverlayForScopeDevice } from "./recipient-policy-deny-overlay.js";
import {
	getRetainedScopeAuthorizationKey,
	reconcileScopeAuthorizationEvidence,
} from "./scope-membership-evidence.js";
import {
	explainScopeMembershipRevocation,
	type ScopeMembershipEpochStatus,
	type ScopeMembershipRevocationNotice,
	scopeMembershipEpochStatus,
} from "./scope-membership-semantics.js";
import {
	normalizeScopeCatalog,
	normalizeScopeSnapshot,
	type ScopeMembershipCatalog,
	type ScopeMembershipSnapshot,
} from "./scope-membership-snapshot.js";
import { buildAuthHeaders } from "./sync-auth.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";
import { ensureDeviceIdentity } from "./sync-identity.js";

export const DEFAULT_SCOPE_MEMBERSHIP_CACHE_MAX_AGE_MS = 60_000;

export type ScopeMembershipCacheFreshness = "fresh" | "stale" | "unknown";

export type ScopeMembershipAuthorizationState =
	| "authorized"
	| "not_authorized"
	| "revoked"
	| "stale_epoch"
	| "policy_denied"
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
	epoch: ScopeMembershipEpochStatus;
	revocation: ScopeMembershipRevocationNotice | null;
	membership: CoordinatorScopeMembership | null;
	scope: CoordinatorScope | null;
	cacheStates: ScopeMembershipCacheState[];
}

export interface EffectiveCachedScopeAuthorization extends CachedScopeAuthorization {
	keyId: string | null;
}

export interface ScopeMembershipCacheFetchers {
	listScopes(groupId: string): Promise<ScopeMembershipCatalog>;
	getScopeSnapshot(groupId: string, scopeId: string): Promise<ScopeMembershipSnapshot>;
}

export interface RefreshScopeMembershipCacheOptions {
	groupIds: string[];
	coordinatorId?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
	/** @deprecated The refresh database is taken from refreshScopeMembershipCache(db, opts). */
	db?: Database;
	keysDir?: string | null;
	dbPath?: string;
	/** Separate local coordinator storage; dbPath remains the memory/signing database. */
	coordinatorDbPath?: string;
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
	if (hasRefreshRevision(db)) return;
	// Recheck under the write lock: another process may have upgraded the cache.
	db.transaction(() => {
		if (hasRefreshRevision(db)) return;
		db.exec(`
		CREATE TABLE IF NOT EXISTS scope_membership_cache_state (
			coordinator_id TEXT NOT NULL,
			group_id TEXT NOT NULL,
			last_refresh_at TEXT NOT NULL,
			last_success_at TEXT,
			last_error TEXT,
			updated_at TEXT NOT NULL,
			refresh_revision INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (coordinator_id, group_id)
		)
	`);
		if (!hasRefreshRevision(db))
			db.exec(
				"ALTER TABLE scope_membership_cache_state ADD COLUMN refresh_revision INTEGER NOT NULL DEFAULT 0",
			);
	}).immediate();
}

function hasRefreshRevision(db: Database): boolean {
	return !!db
		.prepare("SELECT 1 FROM pragma_table_info('scope_membership_cache_state') WHERE name = ?")
		.get("refresh_revision");
}

/** Local write ordering only; neither a membership epoch nor a permission lease. */
function readRefreshRevision(db: Database, authority: ScopeMembershipCacheAuthority): number {
	const row = db
		.prepare(`SELECT refresh_revision FROM scope_membership_cache_state
		WHERE coordinator_id = ? AND group_id = ?`)
		.get(authority.coordinatorId, authority.groupId) as { refresh_revision: number } | undefined;
	const revision = row ? row.refresh_revision : 0;
	if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
		throw new Error("Scope membership cache revision unavailable.");
	return revision;
}

function coordinatorUrl(opts: RefreshScopeMembershipCacheOptions): string {
	const remote = clean(opts.remoteUrl);
	if (!remote) throw new Error("Coordinator URL required.");
	return buildBaseUrl(remote);
}

function signedCoordinatorGet(
	db: Database,
	url: string,
	keysDir?: string | null,
	dbPath?: string,
): Promise<Record<string, unknown> | null> {
	const [deviceId] = ensureDeviceIdentity(db, { keysDir: keysDir ?? undefined });
	const bodyBytes = Buffer.alloc(0);
	const headers = buildAuthHeaders({
		deviceId,
		method: "GET",
		url,
		bodyBytes,
		keysDir: keysDir ?? undefined,
		dbPath,
	});
	return requestJson("GET", url, {
		headers,
	}).then(([status, payload]) => {
		if (status < 200 || status >= 300) {
			throw new Error(`Coordinator membership snapshot failed (${status})`);
		}
		return payload;
	});
}

function authenticatedFetchers(
	db: Database,
	opts: RefreshScopeMembershipCacheOptions,
): ScopeMembershipCacheFetchers {
	const baseUrl = coordinatorUrl(opts);
	return {
		listScopes: async (groupId) => {
			const url = `${baseUrl}/v1/scopes?group_id=${encodeURIComponent(groupId)}`;
			return (await signedCoordinatorGet(
				db,
				url,
				opts.keysDir,
				opts.dbPath,
			)) as unknown as ScopeMembershipCatalog;
		},
		getScopeSnapshot: async (groupId, scopeId) => {
			const url = `${baseUrl}/v1/scopes/${encodeURIComponent(scopeId)}/members?group_id=${encodeURIComponent(groupId)}`;
			return (await signedCoordinatorGet(
				db,
				url,
				opts.keysDir,
				opts.dbPath,
			)) as unknown as ScopeMembershipSnapshot;
		},
	};
}

function defaultFetchers(
	db: Database,
	opts: RefreshScopeMembershipCacheOptions,
): ScopeMembershipCacheFetchers {
	if (clean(opts.remoteUrl)) return authenticatedFetchers(db, opts);
	return {
		listScopes: (groupId) =>
			withLocalCoordinator(opts, async (store) => ({
				version: 1,
				items: await store.listScopes({ groupId }),
			})),
		getScopeSnapshot: (groupId, scopeId) =>
			withLocalCoordinator(opts, async (store) => {
				const decision = await store.getScopeAuthorization({ groupId, scopeId });
				if (decision.kind !== "authorized") throw new Error(decision.error);
				return {
					authorization_version: decision.authorizationVersion,
					scope: decision.scope,
					items: decision.members.map(({ membership, enrollment, keyId }) => ({
						membership,
						enrollment,
						key_id: keyId,
					})),
				};
			}),
	};
}

async function withLocalCoordinator<T>(
	opts: RefreshScopeMembershipCacheOptions,
	read: (store: BetterSqliteCoordinatorStore) => Promise<T>,
): Promise<T> {
	const store = new BetterSqliteCoordinatorStore(
		opts.coordinatorDbPath ?? DEFAULT_COORDINATOR_DB_PATH,
	);
	try {
		return await read(store);
	} finally {
		await store.close();
	}
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

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

function reconcileScopeMembershipSnapshot(
	db: Database,
	batch: CurrentScopeBatch,
	authority: ScopeMembershipCacheAuthority,
	timestamp: string,
): void {
	const { scope, memberships, sourceCoordinatorId } = batch;
	// The authorized scope-members endpoint returns the complete membership list
	// that is active at the current epoch, so absence is fail-closed here.
	const deviceIds = memberships.map((membership) => membership.device_id);
	const deviceFilter =
		deviceIds.length > 0 ? `AND device_id NOT IN (${placeholders(deviceIds.length)})` : "";
	db.prepare(
		`UPDATE scope_memberships
		 SET status = 'revoked',
			 membership_epoch = CASE WHEN membership_epoch > ? THEN membership_epoch ELSE ? END,
			 coordinator_id = ?,
			 group_id = ?,
			 updated_at = ?
		 WHERE scope_id = ?
			 AND COALESCE(coordinator_id, ?) IN (?, ?)
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
		sourceCoordinatorId,
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
	// Enrolled-device scope listings are filtered by the requester's current access.
	// Archiving the omitted scope fails closed without poisoning unchanged peer rows
	// as revoked; a later visible snapshot can reconcile its full membership list.
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
	readRefreshRevision(db, input);
	const result = db
		.prepare(
			`INSERT INTO scope_membership_cache_state(
			coordinator_id, group_id, last_refresh_at, last_success_at, last_error, updated_at, refresh_revision
		) VALUES (?, ?, ?, ?, ?, ?, 1)
		ON CONFLICT(coordinator_id, group_id) DO UPDATE SET
			last_refresh_at = excluded.last_refresh_at,
			last_success_at = COALESCE(excluded.last_success_at, scope_membership_cache_state.last_success_at),
			last_error = excluded.last_error,
			updated_at = excluded.updated_at,
			refresh_revision = scope_membership_cache_state.refresh_revision + 1
		WHERE scope_membership_cache_state.refresh_revision < 9007199254740991`,
		)
		.run(
			input.coordinatorId,
			input.groupId,
			input.now,
			input.ok ? input.now : null,
			input.ok ? null : (input.error ?? "unknown"),
			input.now,
		);
	if (result.changes !== 1) throw new Error("Scope membership cache revision unavailable.");
}

function loadCacheStates(
	db: Database,
	authority?: ScopeMembershipCacheAuthority | null,
): ScopeMembershipCacheState[] {
	if (
		!db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get("scope_membership_cache_state")
	)
		return [];
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

function recordRefreshFailure(
	db: Database,
	input: ScopeMembershipCacheAuthority & { error: string; now: string },
	expectedRevision: number | undefined,
): string {
	if (expectedRevision === undefined) return "Scope membership cache revision unavailable.";
	try {
		db.transaction(() => {
			// A delayed failure must not overwrite a newer refresh or advance its revision.
			if (readRefreshRevision(db, input) !== expectedRevision) return;
			recordRefreshState(db, { ...input, ok: false });
		}).immediate();
		return input.error;
	} catch {
		return "Scope membership cache refresh state unavailable.";
	}
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
	const fetchers = opts.fetchers ?? defaultFetchers(db, opts);
	const timestamp = nowIso(opts.now);
	const results: RefreshScopeMembershipCacheGroupResult[] = [];

	for (const groupId of groups) {
		let expectedRevision: number | undefined;
		try {
			const authority = authorityForGroup(groupId);
			ensureScopeMembershipCacheStateTable(db);
			expectedRevision = readRefreshRevision(db, authority);
			const membershipBatches = await gatherCurrentSnapshots(fetchers, authority);
			const scopes = membershipBatches.map((batch) => batch.scope);
			const error = persistCurrentSnapshots(
				db,
				membershipBatches,
				authority,
				timestamp,
				expectedRevision,
			);
			const membershipCount = membershipBatches.reduce(
				(count, batch) => count + batch.memberships.length,
				0,
			);
			results.push({
				groupId,
				status: error ? "stale" : "refreshed",
				scopeCount: error ? 0 : scopes.length,
				membershipCount: error ? 0 : membershipCount,
				error,
			});
		} catch (error) {
			const message = recordRefreshFailure(
				db,
				{ coordinatorId, groupId, error: errorMessage(error), now: timestamp },
				expectedRevision,
			);
			results.push({ groupId, status: "stale", scopeCount: 0, membershipCount: 0, error: message });
		}
	}

	const refreshed = results.filter((result) => result.status === "refreshed").length;
	let status: RefreshScopeMembershipCacheResult["status"] = "partial";
	if (refreshed === results.length) status = "refreshed";
	else if (refreshed === 0) status = "stale";
	return { status, coordinatorId, groups: results };
}

type CurrentScopeBatch = ReturnType<typeof normalizeScopeSnapshot>;

async function gatherCurrentSnapshots(
	fetchers: ScopeMembershipCacheFetchers,
	authority: ScopeMembershipCacheAuthority,
): Promise<CurrentScopeBatch[]> {
	const catalog = normalizeScopeCatalog(
		await fetchers.listScopes(authority.groupId),
		authority.groupId,
	);
	const batches: CurrentScopeBatch[] = [];
	for (const scope of catalog) {
		const snapshot = await fetchers.getScopeSnapshot(authority.groupId, scope.scope_id);
		batches.push(
			normalizeScopeSnapshot(snapshot, scope, authority.groupId, authority.coordinatorId),
		);
	}
	return batches;
}

function matchesSnapshotSource(
	row: { coordinator_id: string | null; group_id: string | null },
	batch: CurrentScopeBatch,
): boolean {
	return (
		(row.group_id === null || row.group_id === batch.scope.group_id) &&
		(row.coordinator_id === null ||
			row.coordinator_id === batch.scope.coordinator_id ||
			row.coordinator_id === batch.sourceCoordinatorId)
	);
}

function requireUnsupersededSnapshot(db: Database, batch: CurrentScopeBatch): boolean {
	const { scope, memberships } = batch;
	const stored = loadScope(db, scope.scope_id);
	if (
		stored &&
		(stored.membership_epoch > scope.membership_epoch || !matchesSnapshotSource(stored, batch))
	)
		throw new Error("Current scope snapshot conflicts with cached authority or epoch.");
	const rows = db
		.prepare(
			"SELECT device_id, status, membership_epoch, coordinator_id, group_id FROM scope_memberships WHERE scope_id = ?",
		)
		.all(scope.scope_id) as CoordinatorScopeMembership[];
	const incoming = new Map(memberships.map((member) => [member.device_id, member]));
	let revivalConflict = false;
	for (const row of rows) {
		const member = incoming.get(row.device_id);
		// Current omissions remove access even when the member advanced beyond the scope epoch.
		if (
			(member && row.membership_epoch > member.membership_epoch) ||
			!matchesSnapshotSource(row, batch)
		)
			throw new Error("Current scope snapshot superseded by cached membership.");
		if (member && row.status === "revoked" && row.membership_epoch === member.membership_epoch)
			revivalConflict = true;
	}
	return revivalConflict;
}

function migrateSnapshotMembershipAuthority(db: Database, batch: CurrentScopeBatch): void {
	db.prepare(
		`UPDATE scope_memberships SET coordinator_id = ?, group_id = ?
		 WHERE scope_id = ? AND COALESCE(group_id, ?) = ?
		 AND COALESCE(coordinator_id, ?) IN (?, ?)`,
	).run(
		batch.scope.coordinator_id,
		batch.scope.group_id,
		batch.scope.scope_id,
		batch.scope.group_id,
		batch.scope.group_id,
		batch.scope.coordinator_id,
		batch.scope.coordinator_id,
		batch.sourceCoordinatorId,
	);
}

function persistCurrentSnapshots(
	db: Database,
	batches: CurrentScopeBatch[],
	authority: ScopeMembershipCacheAuthority,
	timestamp: string,
	expectedRevision: number,
): string | null {
	return db
		.transaction(() => {
			if (readRefreshRevision(db, authority) !== expectedRevision)
				return "Current scope snapshot superseded by a newer cache refresh.";
			// Validate every batch before writes, even when an earlier batch cannot revive a row.
			const conflicts = batches.map((batch) => requireUnsupersededSnapshot(db, batch));
			const error = conflicts.some(Boolean)
				? "Current scope snapshot cannot revive cached revoked membership at the same epoch."
				: null;
			for (const batch of batches) {
				if (!error) {
					upsertScope(db, batch.scope);
					migrateSnapshotMembershipAuthority(db, batch);
					upsertCachedScopeMemberships(db, batch.memberships);
				}
				reconcileScopeMembershipSnapshot(db, batch, authority, timestamp);
			}
			reconcileGroupScopeSnapshot(
				db,
				authority,
				batches.map((batch) => batch.scope),
				timestamp,
			);
			try {
				reconcileScopeAuthorizationEvidence(db, batches, authority, {
					removalOnly: error !== null,
				});
			} catch {
				throw new Error("Scope authorization evidence unavailable.");
			}
			recordRefreshState(db, { ...authority, ok: error === null, error, now: timestamp });
			return error;
		})
		.immediate();
}

export async function refreshConfiguredScopeMembershipCache(
	db: Database,
	config?: CoordinatorSyncConfig,
	options?: { keysDir?: string | null; dbPath?: string },
): Promise<RefreshScopeMembershipCacheResult> {
	const syncConfig = config ?? readCoordinatorSyncConfig();
	if (!coordinatorEnabled(syncConfig)) {
		return { status: "skipped", coordinatorId: null, groups: [] };
	}
	return refreshScopeMembershipCache(db, {
		groupIds: syncConfig.syncCoordinatorGroups,
		coordinatorId: authorityId(syncConfig.syncCoordinatorUrl),
		remoteUrl: syncConfig.syncCoordinatorUrl,
		adminSecret: syncConfig.syncCoordinatorAdminSecret,
		keysDir: options?.keysDir ?? null,
		dbPath: options?.dbPath,
	});
}

export function listCachedScopesForDevice(
	db: Database,
	deviceId: string,
	opts: ScopeMembershipCacheLookupOptions = {},
): CachedDeviceScopeMemberships {
	const cleanDeviceId = clean(deviceId);
	if (!cleanDeviceId) throw new Error("device_id is required.");
	const params: string[] = [cleanDeviceId];
	const authorityFilter = opts.authority
		? " AND COALESCE(sm.coordinator_id, rs.coordinator_id) = ? AND COALESCE(sm.group_id, rs.group_id) = ?"
		: "";
	if (opts.authority) params.push(opts.authority.coordinatorId, opts.authority.groupId);
	const rows = db
		.prepare(
			`${joinedMembershipSelect(
				`WHERE sm.device_id = ? AND sm.status = 'active' AND rs.scope_id IS NOT NULL AND rs.status = 'active' AND sm.membership_epoch >= rs.membership_epoch${authorityFilter}`,
			)} ORDER BY sm.scope_id ASC`,
		)
		.all(...params) as JoinedMembershipRow[];
	const cacheStates = loadCacheStates(db, opts.authority ?? null);
	const memberships = rows.filter(
		(row) =>
			getAnyRecipientPolicyDenyOverlayForScopeDevice(db, {
				scopeId: row.scope_id,
				deviceId: cleanDeviceId,
			}) == null,
	);
	return {
		deviceId: cleanDeviceId,
		freshness: freshness(cacheStates, opts),
		memberships: memberships.map((row) => ({
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
	if (!clean(input.deviceId) || !clean(input.scopeId))
		throw new Error("device_id and scope_id are required.");
	return readCachedScopeAuthorization(db, input);
}

/** Managed access needs a current-refresh proof, not merely historical cache rows.
 * This read neither creates evidence nor refreshes permissions or adds an expiry. */
export function getEffectiveCachedScopeAuthorization(
	db: Database,
	input: {
		deviceId: string;
		scopeId: string;
		expectedPublicKey?: string;
	} & ScopeMembershipCacheLookupOptions,
): EffectiveCachedScopeAuthorization {
	const cached = readCachedScopeAuthorization(db, input);
	if (!cached.authorized || cached.scope?.authority_type !== "coordinator")
		return { ...cached, keyId: null };
	const keyId =
		cached.membership &&
		getRetainedScopeAuthorizationKey(db, cached.scope, cached.membership, input.expectedPublicKey);
	if (!keyId) return { ...cached, authorized: false, state: "not_authorized", keyId: null };
	return { ...cached, keyId };
}

function readCachedScopeAuthorization(
	db: Database,
	input: { deviceId: string; scopeId: string } & ScopeMembershipCacheLookupOptions,
): CachedScopeAuthorization {
	const deviceId = clean(input.deviceId);
	const scopeId = clean(input.scopeId);
	if (!deviceId || !scopeId) throw new Error("device_id and scope_id are required.");
	const { membership, scope } = readCachedScopeRows(db, { ...input, deviceId, scopeId });
	const authority = authorityFromMembership(
		membership,
		input.authority ?? authorityFromScope(scope),
	);
	const cacheStates = loadCacheStates(db, authority);
	const epoch = scopeMembershipEpochStatus({
		membershipEpoch: membership?.membership_epoch ?? null,
		requiredEpoch: scope?.membership_epoch ?? null,
	});
	const state = cachedScopeDecisionState({
		membership,
		scope,
		epoch,
		policyDenied: !!getAnyRecipientPolicyDenyOverlayForScopeDevice(db, { deviceId, scopeId }),
	});
	let revocation: ScopeMembershipRevocationNotice | null = null;
	if (state === "revoked" && membership)
		revocation = explainScopeMembershipRevocation({
			scopeId,
			deviceId,
			membershipEpoch: membership.membership_epoch,
		});
	return {
		deviceId,
		scopeId,
		authorized: state === "authorized",
		state,
		freshness: freshness(cacheStates, input),
		epoch,
		revocation,
		membership,
		scope,
		cacheStates,
	};
}

function readCachedScopeRows(
	db: Database,
	input: { deviceId: string; scopeId: string } & ScopeMembershipCacheLookupOptions,
): { membership: CoordinatorScopeMembership | null; scope: CoordinatorScope | null } {
	const authorityFilter = input.authority
		? " AND COALESCE(sm.coordinator_id, rs.coordinator_id) = ? AND COALESCE(sm.group_id, rs.group_id) = ?"
		: "";
	const params = input.authority
		? [input.deviceId, input.scopeId, input.authority.coordinatorId, input.authority.groupId]
		: [input.deviceId, input.scopeId];
	const row = db
		.prepare(
			`${joinedMembershipSelect(`WHERE sm.device_id = ? AND sm.scope_id = ?${authorityFilter} LIMIT 1`)}`,
		)
		.get(...params) as JoinedMembershipRow | undefined;
	const membership = row ? membershipFromJoinedRow(row) : null;
	const scope = row
		? scopeFromJoinedRow(row)
		: loadScope(db, input.scopeId, input.authority ?? null);
	return { membership, scope };
}

function cachedScopeDecisionState(input: {
	membership: CoordinatorScopeMembership | null;
	scope: CoordinatorScope | null;
	epoch: ScopeMembershipEpochStatus;
	policyDenied: boolean;
}): ScopeMembershipAuthorizationState {
	const { membership, scope, epoch, policyDenied } = input;
	if (policyDenied) return "policy_denied";
	if (!membership) return "not_authorized";
	if (membership.status === "revoked") return "revoked";
	if (scope?.status && scope.status !== "active") return "scope_inactive";
	if (!scope) return "scope_unknown";
	if (epoch.stale) return "stale_epoch";
	return membership.status === "active" ? "authorized" : "not_authorized";
}
