// Semantic worker reads must stay independent of coordinator backends and refresh code.
// runtime-import-boundaries.test.ts enforces this dependency boundary.
import type { CoordinatorScope, CoordinatorScopeMembership } from "./coordinator-store-contract.js";
import type { Database } from "./db.js";
import { getAnyRecipientPolicyDenyOverlayForScopeDevice } from "./recipient-policy-deny-overlay.js";
import { getRetainedScopeAuthorizationKey } from "./scope-membership-evidence.js";
import {
	explainScopeMembershipRevocation,
	type ScopeMembershipEpochStatus,
	type ScopeMembershipRevocationNotice,
	scopeMembershipEpochStatus,
} from "./scope-membership-semantics.js";

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

export function loadCachedScope(
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
		: loadCachedScope(db, input.scopeId, input.authority ?? null);
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
