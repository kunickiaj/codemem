import type { SyncCapability } from "./sync-capability.js";

export const SYNC_SCOPE_QUERY_PARAM = "scope_id";

export type SyncScopeRequestMode = "legacy" | "scoped";
export type SyncScopeResetReason = "missing_scope" | "unsupported_scope";

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

export function parseSyncScopeRequest(value: unknown, provided: boolean): SyncScopeRequest {
	if (!provided) {
		return { ok: true, mode: "legacy", scope_id: null };
	}

	const scopeId = typeof value === "string" ? value.trim() : "";
	if (!scopeId) {
		return { ok: false, reason: "missing_scope" };
	}

	// ov4g.4.1 reserves the parameter and fails closed for explicit scoped
	// requests. Per-scope cursors/snapshots land in later ov4g.4 slices; until
	// then, silently ignoring a requested scope would be worse than refusing it.
	return { ok: false, reason: "unsupported_scope" };
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
		...addSyncScopeToBoundary(boundary, null),
	};
}
