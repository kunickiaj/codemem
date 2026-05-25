import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import * as schema from "./schema.js";
import {
	type CachedScopeAuthorization,
	getCachedScopeAuthorization,
} from "./scope-membership-cache.js";
import { isScopedSyncCapability, type SyncCapability } from "./sync-capability.js";
import {
	DEFAULT_SYNC_SCOPE_ID,
	getReplicationCursor,
	getSyncResetState,
} from "./sync-replication.js";

export const SYNC_SCOPE_QUERY_PARAM = "scope_id";

export type SyncScopeRequestMode = "legacy" | "scoped";
export type SyncScopeResetReason =
	| "missing_scope"
	| "unsupported_scope"
	| "stale_epoch"
	| "scope_inactive";

export interface SyncScopeRequestOk {
	ok: true;
	mode: SyncScopeRequestMode;
	scope_id: string | null;
}

export interface SyncScopeRequestError {
	ok: false;
	reason: SyncScopeResetReason;
}

export type SyncScopeRequest = SyncScopeRequestOk | SyncScopeRequestError;

export interface SyncResetBoundaryShape {
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
	retained_floor_cursor: string | null;
}

/**
 * Parse a sync scope request and validate it against caller authorization.
 *
 * Legacy callers (`negotiatedCapability !== "scoped"`) MUST NOT pass a
 * scope_id; doing so is rejected as `unsupported_scope` so the wire format
 * stays predictable when the lower-ranked side cannot interpret per-scope
 * responses anyway.
 *
 * Scoped callers (`negotiatedCapability === "scoped"`) may pass a scope_id.
 * The server verifies the calling peer is an active, current-epoch member of
 * the requested scope before accepting. Failed authorization maps to wire
 * reasons that the client can act on:
 * - `missing_scope`: scope unknown, inactive, or caller is not a member.
 * - `stale_epoch`: caller membership exists but epoch is behind authority.
 * - `scope_inactive`: scope membership was revoked or scope is closed.
 *
 * Callers that pass no scope_id continue to be served via the legacy default
 * scope path regardless of capability.
 */
export function parseSyncScopeRequest(
	value: unknown,
	provided: boolean,
	context?: {
		db?: Database;
		negotiatedCapability?: SyncCapability;
		peerDeviceId?: string | null;
	},
): SyncScopeRequest {
	if (!provided) {
		return { ok: true, mode: "legacy", scope_id: null };
	}

	const scopeId = typeof value === "string" ? value.trim() : "";
	if (!scopeId) {
		return { ok: false, reason: "missing_scope" };
	}

	const negotiated = context?.negotiatedCapability;
	if (!negotiated || !isScopedSyncCapability(negotiated)) {
		// Caller is on the legacy default-scope wire format. Refuse the
		// scope_id rather than silently downgrading: the response shape
		// will not carry the per-scope boundary the caller expects.
		return { ok: false, reason: "unsupported_scope" };
	}

	const db = context.db;
	const peerDeviceId = context.peerDeviceId?.trim();
	if (!db || !peerDeviceId) {
		// Caller advertised scoped capability but the route did not thread
		// the authentication context through. Fail closed.
		return { ok: false, reason: "missing_scope" };
	}

	const authorization = getCachedScopeAuthorization(db, {
		deviceId: peerDeviceId,
		scopeId,
	});
	const errorReason = scopeAuthorizationFailureReason(authorization);
	if (errorReason) {
		return { ok: false, reason: errorReason };
	}

	return { ok: true, mode: "scoped", scope_id: scopeId };
}

/**
 * Map a cached scope authorization result to a wire reset reason, or null
 * when the caller is fully authorized for the scope.
 */
export function scopeAuthorizationFailureReason(
	authorization: CachedScopeAuthorization,
): SyncScopeResetReason | null {
	if (authorization.authorized) return null;

	switch (authorization.state) {
		case "stale_epoch":
			return "stale_epoch";
		case "revoked":
		case "scope_inactive":
			return "scope_inactive";
		case "scope_unknown":
		case "not_authorized":
		default:
			return "missing_scope";
	}
}

export function addSyncScopeToBoundary<T extends SyncResetBoundaryShape>(
	boundary: T,
	scopeId: string | null,
): T & { scope_id: string | null } {
	return { ...boundary, scope_id: scopeId };
}

export function syncScopeResetRequiredPayload(
	boundary: SyncResetBoundaryShape,
	reason: SyncScopeResetReason,
	syncCapability: SyncCapability,
	scopeId?: string | null,
): SyncResetBoundaryShape & {
	error: "reset_required";
	reset_required: true;
	sync_capability: SyncCapability;
	reason: SyncScopeResetReason;
	scope_id: string | null;
} {
	return {
		error: "reset_required",
		reset_required: true,
		sync_capability: syncCapability,
		reason,
		...addSyncScopeToBoundary(boundary, scopeId ?? null),
	};
}

/**
 * Authorized-scope entry advertised on /v1/status when both peers negotiate
 * the `scoped` capability. Each entry carries the per-scope reset boundary
 * (`sync_reset_state_v2` row) so the client can immediately request that
 * scope's snapshot or incremental ops without an extra round trip.
 */
export interface AuthorizedScopeEntry {
	scope_id: string;
	label: string;
	authority_type: string;
	membership_epoch: number;
	sync_reset: SyncResetBoundaryShape & { scope_id: string | null };
}

/**
 * Enumerate scopes the calling peer is authorized to sync with the local
 * device, suitable for advertising on /v1/status under scoped capability.
 *
 * Inclusion rule: a scope is returned when
 * - it exists in `replication_scopes` with status `active`, and
 * - both the local device and the peer device have active membership rows
 *   in `scope_memberships`, and
 * - the scope's `authority_type` is either non-`local`, OR the local
 *   membership exists (which is how personal scope grants are modeled — the
 *   grant row is the membership).
 *
 * The legacy `local-default` scope is intentionally excluded. Scoped peers
 * still run the legacy default-scope path alongside per-scope sync to handle
 * pre-Spaces data, so listing it here would duplicate work and require new
 * code paths in the loaders to emit "explicit" default-scope rows.
 *
 * The returned `sync_reset` value is the per-scope boundary; calling
 * `getSyncResetState(db, scope_id)` lazily creates a row if one does not
 * exist yet so first-time scopes get a stable generation/snapshot_id.
 */
export function listAuthorizedScopesForPeer(
	db: Database,
	options: { localDeviceId: string; peerDeviceId: string },
): AuthorizedScopeEntry[] {
	const localDeviceId = options.localDeviceId.trim();
	const peerDeviceId = options.peerDeviceId.trim();
	if (!localDeviceId || !peerDeviceId || localDeviceId === peerDeviceId) {
		return [];
	}

	const d = drizzle(db, { schema });
	const localMemberships = d
		.select({
			scope_id: schema.scopeMemberships.scope_id,
			membership_epoch: schema.scopeMemberships.membership_epoch,
		})
		.from(schema.scopeMemberships)
		.where(
			and(
				eq(schema.scopeMemberships.device_id, localDeviceId),
				eq(schema.scopeMemberships.status, "active"),
			),
		)
		.all();

	if (localMemberships.length === 0) return [];

	const entries: AuthorizedScopeEntry[] = [];
	for (const local of localMemberships) {
		if (!local.scope_id || local.scope_id === DEFAULT_SYNC_SCOPE_ID) continue;

		// Peer must also be an active member of the same scope, at the same
		// or higher membership_epoch as the local row, before we advertise.
		const peerAuth = getCachedScopeAuthorization(db, {
			deviceId: peerDeviceId,
			scopeId: local.scope_id,
		});
		if (!peerAuth.authorized || !peerAuth.scope) continue;
		if (peerAuth.scope.status !== "active") continue;

		const reset = getSyncResetState(db, local.scope_id);
		entries.push({
			scope_id: local.scope_id,
			label: peerAuth.scope.label,
			authority_type: peerAuth.scope.authority_type,
			membership_epoch: Number(peerAuth.scope.membership_epoch ?? local.membership_epoch ?? 0),
			sync_reset: {
				scope_id: local.scope_id,
				generation: reset.generation,
				snapshot_id: reset.snapshot_id,
				baseline_cursor: reset.baseline_cursor,
				retained_floor_cursor: reset.retained_floor_cursor,
			},
		});
	}

	entries.sort((a, b) => a.scope_id.localeCompare(b.scope_id));
	return entries;
}

/**
 * Per-Space sync state for a given peer, suitable for both the CLI status
 * display and the `/api/sync/status` / `/api/sync/peers` viewer payload.
 *
 * Renders the intersection of local + peer scope memberships against the
 * per-scope cursor state stored in `replication_cursors_v2`. Consumers use
 * this surface to show "synced / pending" per Space instead of the legacy
 * peer-level `last_sync=ok`, which is the diagnostic gap that hid the
 * codemem-ruu6 regression while ~18k scoped rows silently failed to
 * replicate.
 *
 * Returns an empty array when local device identity has not yet been
 * initialized or when there is no membership overlap.
 */
export interface PerPeerScopeSyncEntry {
	scope_id: string;
	label: string;
	authority_type: string;
	membership_epoch: number;
	last_applied_cursor: string | null;
	last_acked_cursor: string | null;
	bootstrapped: boolean;
}

export function listPerPeerScopeSyncState(
	db: Database,
	options: { localDeviceId: string | null; peerDeviceId: string },
): PerPeerScopeSyncEntry[] {
	const localDeviceId = options.localDeviceId?.trim() ?? "";
	const peerDeviceId = options.peerDeviceId.trim();
	if (!localDeviceId || !peerDeviceId) return [];
	const scopes = listAuthorizedScopesForPeer(db, { localDeviceId, peerDeviceId });
	return scopes.map((scope) => {
		const [lastApplied, lastAcked] = getReplicationCursor(db, peerDeviceId, scope.scope_id);
		return {
			scope_id: scope.scope_id,
			label: scope.label,
			authority_type: scope.authority_type,
			membership_epoch: scope.membership_epoch,
			last_applied_cursor: lastApplied,
			last_acked_cursor: lastAcked,
			bootstrapped: lastApplied != null,
		};
	});
}
