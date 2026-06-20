/**
 * Sync pass orchestrator: coordinates a single sync exchange with a peer device.
 *
 * Handles the pull→apply→push cycle for replication ops, with address
 * fallback, fingerprint verification, and cursor tracking.
 * Ported from codemem/sync/sync_pass.py.
 */

import { and, desc, eq, gt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import * as schema from "./schema.js";
import type { SecretScanner } from "./secret-scanner.js";
import { buildAuthHeaders } from "./sync-auth.js";
import {
	applyBootstrapSnapshot,
	fetchAllSnapshotPages,
	mergeBootstrapSnapshot,
} from "./sync-bootstrap.js";
import {
	LOCAL_SYNC_CAPABILITY,
	negotiateSyncCapability,
	normalizeSyncCapability,
	SYNC_CAPABILITY_HEADER,
	type SyncCapability,
} from "./sync-capability.js";
import { recordPeerSuccess } from "./sync-discovery.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import {
	applyReplicationOps,
	backfillReplicationOps,
	chunkOpsBySize,
	clearReplicationCursorLastApplied,
	extractReplicationOps,
	type FilterReplicationSkipped,
	filterReplicationOpsForSyncWithStatus,
	getReplicationCursor,
	hasUnsyncedSharedMemoryChanges,
	migrateLegacyImportKeys,
	reconcileStalePeerReceivedRows,
	SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER,
	setReplicationCursor,
} from "./sync-replication.js";
import type { ReplicationOp, SyncResetRequired } from "./types.js";
import { queueVectorBackfillForIncrementalSync } from "./vector-migration.js";
import { bestEffortMaintainVectorsForSyncFallback } from "./vectors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max body size for sync POST requests (1 MiB). */
const MAX_SYNC_BODY_BYTES = 1_048_576;

/**
 * One-shot warning latch so sync-apply paths log a single line per process if
 * a caller forgot to thread the scanner through. Workspace-level rule overrides
 * silently fail to apply to peer-shipped content otherwise.
 */
let syncOnceScannerWarned = false;

/**
 * Default op fetch/push limit per round.
 *
 * The server caps this at 1000 per request (see viewer-server /v1/ops).
 * Callers can override via SyncPassOptions.limit; the sync daemon resolves
 * it from the sync_ops_limit config key / CODEMEM_SYNC_OPS_LIMIT env var.
 */
const DEFAULT_LIMIT = 500;

/** Elevated page size for initial bootstrap of never-synced peers. */
const BOOTSTRAP_PAGE_SIZE = 2000;

/**
 * Per-page snapshot fetch timeout for bootstrap / scoped merge recovery.
 * Larger than the default incremental timeout because snapshot pages can be
 * substantially bigger and slower to assemble on the serving peer.
 */
const BOOTSTRAP_REQUEST_TIMEOUT_S = 60;

/** Current sync protocol version expected from peers. */
const EXPECTED_SYNC_PROTOCOL_VERSION = "2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncFailureCategory = "trust" | "scope" | "connectivity" | "other";

export interface SyncResult {
	ok: boolean;
	error?: string;
	failureCategory?: SyncFailureCategory;
	address?: string;
	opsIn: number;
	opsOut: number;
	opsSkipped?: number;
	skippedOut?: FilterReplicationSkipped | null;
	addressErrors: Array<{ address: string; error: string }>;
	resetRequired?: SyncResetRequired;
	/**
	 * Per-Space sync outcomes when both peers negotiate the `scoped` sync
	 * capability. Each entry covers a non-default scope returned by the peer's
	 * `authorized_scopes` advertisement. Unset for legacy / `aware` peers; in
	 * that case the top-level `opsIn` / `opsOut` describe the only sync pass
	 * that ran (default scope).
	 *
	 * Top-level `opsIn` / `opsOut` aggregate the default-scope pass plus every
	 * scoped pass, so existing callers stay correct without per-scope
	 * awareness. A failure in a single scope sets the entry's `ok=false` but
	 * does not block other scopes, and does not affect the default-scope
	 * outcome. The top-level `ok` is true only when every per-scope result is
	 * `ok`, matching the design's "all-or-nothing" report.
	 */
	perScopeResults?: SyncScopeResult[];
}

/**
 * Outcome of a single per-Space sync pass within a larger `syncOnce` exchange.
 *
 * Lives alongside `SyncResult` rather than nested into it because each scope
 * has its own cursor / reset state and can fail independently. Aggregating the
 * per-scope counts into `SyncResult.opsIn` / `opsOut` preserves backward
 * compatibility for callers that only need totals.
 */
export interface SyncScopeResult {
	scope_id: string;
	label?: string;
	ok: boolean;
	failureCategory?: SyncFailureCategory;
	opsIn: number;
	opsOut: number;
	error?: string;
	resetRequired?: SyncResetRequired;
	/**
	 * True when the pass began with an empty cursor and no local rows in the
	 * scope, triggering a `/v1/snapshot` bootstrap. False for incremental
	 * `/v1/ops` passes. Useful for diagnostics and UI progress reporting.
	 */
	bootstrapped: boolean;
}

export interface SyncPassOptions {
	limit?: number;
	keysDir?: string;
	/**
	 * Secret scanner used to redact peer-shipped content on apply. Callers that
	 * own a `MemoryStore` should pass `store.scanner` so workspace-level rule
	 * overrides apply uniformly to local writes and sync-receive. Omitting it
	 * falls back to default rules only and prints a one-time warning.
	 */
	scanner?: SecretScanner;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a cursor candidate advances beyond the current position.
 *
 * Cursors are `timestamp|op_id` strings that sort lexicographically.
 */
export function cursorAdvances(current: string | null, candidate: string | null): boolean {
	if (!candidate) return false;
	if (!candidate.includes("|")) return false;
	if (!current) return true;
	return candidate > current;
}

/**
 * Extract an error detail string from a JSON response payload.
 */
function errorDetail(payload: Record<string, unknown> | null): string | null {
	if (!payload) return null;
	const error = payload.error;
	const reason = payload.reason;
	if (typeof error === "string" && typeof reason === "string") {
		return `${error}:${reason}`;
	}
	if (typeof error === "string") return error;
	return null;
}

/**
 * Summarize address errors into a single error string.
 */
function summarizeAddressErrors(
	addressErrors: Array<{ address: string; error: string }>,
): string | null {
	if (addressErrors.length === 0) return null;
	const parts = addressErrors.map((item) => `${item.address}: ${item.error}`);
	return `all addresses failed | ${parts.join(" || ")}`;
}

function asOptionalCursor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parsePeerResetBoundary(payload: Record<string, unknown> | null): {
	scope_id: string | null;
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
	retained_floor_cursor: string | null;
} | null {
	const raw = payload?.sync_reset;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const boundary = raw as Record<string, unknown>;
	if (!Number.isFinite(boundary.generation)) return null;
	if (typeof boundary.snapshot_id !== "string" || boundary.snapshot_id.trim().length === 0) {
		return null;
	}
	const baseline = asOptionalCursor(boundary.baseline_cursor);
	return {
		scope_id: asOptionalCursor(boundary.scope_id),
		generation: Number(boundary.generation),
		snapshot_id: boundary.snapshot_id.trim(),
		baseline_cursor: baseline,
		retained_floor_cursor: asOptionalCursor(boundary.retained_floor_cursor),
	};
}

function isValidIncrementalOpsResponse(payload: Record<string, unknown> | null): payload is {
	reset_required: false;
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
	retained_floor_cursor: string | null;
	ops: unknown[];
	next_cursor: string | null;
	skipped: number;
} {
	if (payload?.reset_required !== false) return false;
	if (!Number.isFinite(payload.generation)) return false;
	if (typeof payload.snapshot_id !== "string" || payload.snapshot_id.trim().length === 0)
		return false;
	if (!(payload.baseline_cursor == null || typeof payload.baseline_cursor === "string"))
		return false;
	if (
		!(payload.retained_floor_cursor == null || typeof payload.retained_floor_cursor === "string")
	) {
		return false;
	}
	if (!Array.isArray(payload.ops)) return false;
	if (!(payload.next_cursor == null || typeof payload.next_cursor === "string")) return false;
	if (!Number.isFinite(payload.skipped)) return false;
	return true;
}

interface SyncCapabilityDiagnostics {
	local: SyncCapability;
	peer: SyncCapability;
	negotiated: SyncCapability;
}

function capabilityDiagnostics(peerCapability: unknown): SyncCapabilityDiagnostics {
	const peer = normalizeSyncCapability(peerCapability);
	return {
		local: LOCAL_SYNC_CAPABILITY,
		peer,
		negotiated: negotiateSyncCapability(LOCAL_SYNC_CAPABILITY, peer),
	};
}

function capabilityHeader(): Record<string, string> {
	// Diagnostic advertisement only. This unsigned GET header can opt an
	// authenticated paired peer into scoped metadata enumeration, but never into
	// scoped data access; receivers must still authorize every scoped request.
	return { [SYNC_CAPABILITY_HEADER]: LOCAL_SYNC_CAPABILITY };
}

function defaultCapabilityDiagnostics(): SyncCapabilityDiagnostics {
	return capabilityDiagnostics("unsupported");
}

/**
 * Record a sync attempt in the sync_attempts table.
 */
function recordSyncAttempt(
	db: Database,
	peerDeviceId: string,
	options: {
		ok: boolean;
		opsIn?: number;
		opsOut?: number;
		error?: string;
		capabilities?: SyncCapabilityDiagnostics;
	},
): void {
	const d = drizzle(db, { schema });
	const now = new Date().toISOString();
	const capabilities = options.capabilities ?? defaultCapabilityDiagnostics();
	d.insert(schema.syncAttempts)
		.values({
			peer_device_id: peerDeviceId,
			started_at: now,
			finished_at: now,
			ok: options.ok ? 1 : 0,
			ops_in: options.opsIn ?? 0,
			ops_out: options.opsOut ?? 0,
			error: options.error ?? null,
			local_sync_capability: capabilities.local,
			peer_sync_capability: capabilities.peer,
			negotiated_sync_capability: capabilities.negotiated,
		})
		.run();
}

/**
 * Load outbound replication ops for the local device since a cursor.
 *
 * Returns `[ops, nextCursor]`. The cursor is `created_at|op_id`.
 */
function loadLocalOpsSince(
	db: Database,
	cursor: string | null,
	deviceId: string,
	limit: number,
): [ReplicationOp[], string | null] {
	const d = drizzle(db, { schema });
	const { replicationOps: ops } = schema;
	let rows: ReplicationOp[];
	if (cursor) {
		const sepIdx = cursor.indexOf("|");
		const cursorTs = sepIdx >= 0 ? cursor.slice(0, sepIdx) : cursor;
		const cursorOpId = sepIdx >= 0 ? cursor.slice(sepIdx + 1) : "";
		rows = d
			.select()
			.from(ops)
			.where(
				and(
					eq(ops.device_id, deviceId),
					or(
						gt(ops.created_at, cursorTs),
						and(eq(ops.created_at, cursorTs), gt(ops.op_id, cursorOpId)),
					),
				),
			)
			.orderBy(ops.created_at, ops.op_id)
			.limit(limit)
			.all() as ReplicationOp[];
	} else {
		rows = d
			.select()
			.from(ops)
			.where(eq(ops.device_id, deviceId))
			.orderBy(ops.created_at, ops.op_id)
			.limit(limit)
			.all() as ReplicationOp[];
	}

	if (rows.length === 0) return [[], null];
	const last = rows.at(-1);
	if (!last) return [[], null];
	const nextCursor = `${last.created_at}|${last.op_id}`;
	return [rows, nextCursor];
}

// ---------------------------------------------------------------------------
// Push ops
// ---------------------------------------------------------------------------

/**
 * Push ops to a peer endpoint with auth headers.
 *
 * On 413 (too large), splits the batch in half and retries recursively.
 */
const MAX_PUSH_SPLIT_DEPTH = 8;

async function pushOps(
	postUrl: string,
	deviceId: string,
	ops: ReplicationOp[],
	keysDir?: string,
	depth = 0,
): Promise<void> {
	if (ops.length === 0) return;

	const body = { ops, sync_capability: LOCAL_SYNC_CAPABILITY };
	const bodyBytes = Buffer.from(JSON.stringify(body), "utf-8");
	const headers = {
		...buildAuthHeaders({
			deviceId,
			method: "POST",
			url: postUrl,
			bodyBytes,
			keysDir,
		}),
		...capabilityHeader(),
	};
	const [status, payload] = await requestJson("POST", postUrl, {
		headers,
		body,
		bodyBytes,
	});

	if (status === 200 && payload != null) return;

	const detail = errorDetail(payload);
	if (
		status === 413 &&
		ops.length > 1 &&
		depth < MAX_PUSH_SPLIT_DEPTH &&
		(detail === "payload_too_large" || detail === "too_many_ops")
	) {
		const mid = Math.floor(ops.length / 2);
		await pushOps(postUrl, deviceId, ops.slice(0, mid), keysDir, depth + 1);
		await pushOps(postUrl, deviceId, ops.slice(mid), keysDir, depth + 1);
		return;
	}

	const suffix = detail ? ` (${status}: ${detail})` : ` (${status})`;
	throw new Error(`peer ops push failed${suffix}`);
}

// ---------------------------------------------------------------------------
// Per-scope sync helpers (scoped capability path)
// ---------------------------------------------------------------------------

/**
 * Wire shape of a single entry in the `authorized_scopes` array returned by
 * `/v1/status` when both peers negotiate the `scoped` capability.
 */
interface PeerAuthorizedScope {
	scope_id: string;
	label?: string;
	authority_type?: string;
	membership_epoch?: number;
	sync_reset: {
		scope_id: string | null;
		generation: number;
		snapshot_id: string;
		baseline_cursor: string | null;
		retained_floor_cursor: string | null;
	};
}

/**
 * Parse and validate a peer's `authorized_scopes` advertisement.
 *
 * Returns an empty array (not null) for any malformed value so the per-scope
 * loop is a safe no-op for legacy peers that don't emit the field. Each
 * accepted entry must carry a non-empty `scope_id` and a complete
 * `sync_reset` boundary; partially-formed entries are dropped silently rather
 * than failing the whole pass.
 */
function parseAuthorizedScopes(value: unknown): PeerAuthorizedScope[] {
	if (!Array.isArray(value)) return [];
	const entries: PeerAuthorizedScope[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const record = raw as Record<string, unknown>;
		const scopeId = typeof record.scope_id === "string" ? record.scope_id.trim() : "";
		if (!scopeId) continue;
		const reset = record.sync_reset;
		if (!reset || typeof reset !== "object") continue;
		const resetRecord = reset as Record<string, unknown>;
		const generation = Number(resetRecord.generation);
		if (!Number.isFinite(generation)) continue;
		const snapshotId =
			typeof resetRecord.snapshot_id === "string" ? resetRecord.snapshot_id.trim() : "";
		if (!snapshotId) continue;
		entries.push({
			scope_id: scopeId,
			label: typeof record.label === "string" ? record.label : undefined,
			authority_type: typeof record.authority_type === "string" ? record.authority_type : undefined,
			membership_epoch:
				typeof record.membership_epoch === "number" ? record.membership_epoch : undefined,
			sync_reset: {
				scope_id: typeof resetRecord.scope_id === "string" ? resetRecord.scope_id : null,
				generation,
				snapshot_id: snapshotId,
				baseline_cursor: asOptionalCursor(resetRecord.baseline_cursor),
				retained_floor_cursor: asOptionalCursor(resetRecord.retained_floor_cursor),
			},
		});
	}
	return entries;
}

/**
 * True when the local DB has any memory_items belonging to the given scope.
 * Used to decide between bootstrap (no local rows) and incremental (some local
 * rows) on first pull for a scope. Matches the predicate
 * `loadMemorySnapshotPageForPeer` uses for snapshot eligibility.
 */
function hasLocalRowsInScope(db: Database, scopeId: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM memory_items WHERE import_key IS NOT NULL AND scope_id = ? LIMIT 1")
		.get(scopeId) as { 1: number } | undefined;
	return row !== undefined;
}

function scopedSnapshotAccessFailure(
	db: Database,
	options: { scopeId: string; peerDeviceId: string; localDeviceId: string },
): SyncResetRequired["reason"] | null {
	const scope = db
		.prepare(
			`SELECT authority_type, status, membership_epoch
			   FROM replication_scopes
			  WHERE scope_id = ?`,
		)
		.get(options.scopeId) as
		| { authority_type: string | null; status: string | null; membership_epoch: number | null }
		| undefined;
	if (!scope) return "missing_scope";
	if (scope.status !== "active") return "scope_inactive";
	if (scope.authority_type === "local") return "missing_scope";

	const requiredEpoch = Number(scope.membership_epoch ?? 0);
	for (const deviceId of [options.localDeviceId, options.peerDeviceId]) {
		const membership = db
			.prepare(
				`SELECT status, membership_epoch
				   FROM scope_memberships
				  WHERE scope_id = ? AND device_id = ?`,
			)
			.get(options.scopeId, deviceId) as
			| { status: string | null; membership_epoch: number | null }
			| undefined;
		if (!membership) return "missing_scope";
		if (membership.status !== "active") return "scope_inactive";
		if (Number(membership.membership_epoch ?? 0) < requiredEpoch) return "stale_epoch";
	}

	return null;
}

function scopedSnapshotAccessDeniedResult(
	baseUrl: string,
	resetInfo: SyncResetRequired,
	reason: SyncResetRequired["reason"],
): SyncResult {
	return {
		ok: false,
		address: baseUrl,
		error: `reset_required:${reason}`,
		failureCategory: scopeResetFailureCategory(reason),
		opsIn: 0,
		opsOut: 0,
		addressErrors: [],
		resetRequired: { ...resetInfo, reason },
	};
}

function categorizeSyncFailure(error: string | undefined): SyncFailureCategory {
	const lower = String(error ?? "").toLowerCase();
	if (!lower) return "other";
	if (lower.includes("401") && lower.includes("unauthorized")) return "trust";
	if (lower.includes("fingerprint mismatch")) return "trust";
	if (lower.includes("peer not pinned")) return "trust";
	if (lower.includes("scope_rejected") || lower.includes("scope rejected")) return "scope";
	if (lower.includes("missing_scope")) return "scope";
	if (lower.includes("stale_epoch")) return "scope";
	if (lower.includes("scope_inactive")) return "scope";
	if (lower.includes("no dialable peer addresses")) return "connectivity";
	if (lower.includes("fetch failed")) return "connectivity";
	if (lower.includes("connection refused")) return "connectivity";
	if (lower.includes("network")) return "connectivity";
	if (lower.includes("timeout")) return "connectivity";
	if (lower.includes("503") || lower.includes("502") || lower.includes("504"))
		return "connectivity";
	if (lower.includes("peer status failed")) return "connectivity";
	if (lower.includes("peer ops fetch failed")) return "connectivity";
	if (lower.includes("snapshot fetch failed")) return "connectivity";
	return "other";
}

function scopeFailureCategory(error: string | undefined): SyncFailureCategory {
	return categorizeSyncFailure(error);
}

function scopeResetFailureCategory(reason: SyncResetRequired["reason"]): SyncFailureCategory {
	switch (reason) {
		case "missing_scope":
		case "scope_inactive":
		case "stale_epoch":
			return "scope";
		case "boundary_mismatch":
		case "generation_mismatch":
		case "initial_bootstrap":
		case "stale_cursor":
		case "unsupported_scope":
			return "other";
	}
	return "other";
}

function aggregateScopeFailureCategory(
	results: SyncScopeResult[],
): SyncFailureCategory | undefined {
	const failed = results.filter((result) => !result.ok);
	if (failed.length === 0) return undefined;
	const categories = new Set(
		failed.map((result) => result.failureCategory ?? scopeFailureCategory(result.error)),
	);
	return categories.size === 1 ? Array.from(categories)[0] : "other";
}

/**
 * Run the per-Space iteration after a successful default-scope sync.
 *
 * Returns the per-scope outcomes plus the aggregate inbound op count so the
 * caller can update its top-level `SyncResult`. Failures inside individual
 * scopes are reported in the returned array; the function itself never
 * throws.
 */
async function runScopedSync(
	db: Database,
	options: {
		peerDeviceId: string;
		baseUrl: string;
		deviceId: string;
		statusPayload: Record<string, unknown>;
		keysDir?: string;
		scanner?: SecretScanner;
		limit: number;
	},
): Promise<{ results: SyncScopeResult[]; totalOpsIn: number }> {
	const authorizedScopes = parseAuthorizedScopes(options.statusPayload.authorized_scopes);
	if (authorizedScopes.length === 0) {
		return { results: [], totalOpsIn: 0 };
	}
	const results: SyncScopeResult[] = [];
	let totalOpsIn = 0;
	for (const scope of authorizedScopes) {
		const scopeResult = await syncOneScope(db, {
			peerDeviceId: options.peerDeviceId,
			baseUrl: options.baseUrl,
			deviceId: options.deviceId,
			scope,
			keysDir: options.keysDir,
			scanner: options.scanner,
			limit: options.limit,
		});
		results.push(scopeResult);
		if (scopeResult.ok) totalOpsIn += scopeResult.opsIn;
	}
	return { results, totalOpsIn };
}

/**
 * Sync a single Sharing-domain scope with a peer. Caller is responsible for
 * having already authenticated against the peer (via legacy default-scope
 * sync) and having an `authorized_scopes` entry from `/v1/status`.
 *
 * Branches on per-scope cursor state:
 * - `bootstrapped=true`: no cursor and no local rows in this scope → fetch
 *   the full snapshot page-by-page via `/v1/snapshot?scope_id=X` and apply
 *   atomically via `applyBootstrapSnapshot`.
 * - `bootstrapped=false`: pull `/v1/ops?scope_id=X&since=<cursor>` and apply
 *   through the normal `applyReplicationOps` path.
 *
 * Outbound ops are NOT pushed per-scope here. The default-scope outbound push
 * that ran in `syncOnce` already streams ops with their per-op `scope_id`
 * metadata intact, and the peer's outbound filter (`outboundScopeAllowed`)
 * applies the same membership gate per row. Re-pushing per scope would be a
 * waste; the receiver's per-scope pull on the next pass picks up anything it
 * missed.
 */
async function syncOneScope(
	db: Database,
	options: {
		peerDeviceId: string;
		baseUrl: string;
		deviceId: string;
		scope: PeerAuthorizedScope;
		keysDir?: string;
		scanner?: SecretScanner;
		limit: number;
	},
): Promise<SyncScopeResult> {
	const { peerDeviceId, baseUrl, deviceId, scope, keysDir, scanner, limit } = options;
	const scopeId = scope.scope_id;
	const [lastApplied, lastAcked] = getReplicationCursor(db, peerDeviceId, scopeId);
	const hasNullBaselineBootstrapMarker = lastAcked === SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER;
	const nullBaselineBootstrapStillCurrent =
		hasNullBaselineBootstrapMarker && scope.sync_reset.baseline_cursor == null;
	const localRowsPresent = hasLocalRowsInScope(db, scopeId);
	const shouldMergeRecoverScope =
		lastApplied == null && localRowsPresent && !nullBaselineBootstrapStillCurrent;
	const shouldBootstrapEmptyScope =
		lastApplied == null && !localRowsPresent && !nullBaselineBootstrapStillCurrent;
	if (shouldMergeRecoverScope || shouldBootstrapEmptyScope) {
		const accessFailure = scopedSnapshotAccessFailure(db, {
			scopeId,
			peerDeviceId,
			localDeviceId: deviceId,
		});
		if (accessFailure) {
			return {
				scope_id: scopeId,
				label: scope.label,
				ok: false,
				failureCategory: scopeResetFailureCategory(accessFailure),
				opsIn: 0,
				opsOut: 0,
				error: `reset_required:${accessFailure}`,
				resetRequired: {
					reset_required: true,
					reason: accessFailure,
					scope_id: scopeId,
					generation: scope.sync_reset.generation,
					snapshot_id: scope.sync_reset.snapshot_id,
					baseline_cursor: scope.sync_reset.baseline_cursor,
					retained_floor_cursor: scope.sync_reset.retained_floor_cursor,
				},
				bootstrapped: false,
			};
		}
	}

	// If this peer/scope has no cursor but the receiver already has rows in the
	// scope, a destructive bootstrap is unsafe and incremental from an empty
	// cursor can be a permanent no-op on peers that only retain snapshot state.
	// Recover additively by merging the advertised scoped snapshot: missing or
	// stale copies of the same snapshot entity are applied, but rows absent from
	// the peer snapshot are preserved.
	if (shouldMergeRecoverScope) {
		try {
			const resetInfo: SyncResetRequired = {
				scope_id: scopeId,
				generation: scope.sync_reset.generation,
				snapshot_id: scope.sync_reset.snapshot_id,
				baseline_cursor: scope.sync_reset.baseline_cursor,
				retained_floor_cursor: scope.sync_reset.retained_floor_cursor,
				reset_required: true,
				reason: "initial_bootstrap" as SyncResetRequired["reason"],
			};
			const { items } = await fetchAllSnapshotPages(baseUrl, resetInfo, deviceId, {
				keysDir,
				pageSize: BOOTSTRAP_PAGE_SIZE,
				timeoutS: BOOTSTRAP_REQUEST_TIMEOUT_S,
			});
			const mergeResult = mergeBootstrapSnapshot(db, peerDeviceId, items, resetInfo, scanner);
			if (!mergeResult.ok) {
				const error = "scoped merge bootstrap apply failed";
				return {
					scope_id: scopeId,
					label: scope.label,
					ok: false,
					failureCategory: "other",
					opsIn: 0,
					opsOut: 0,
					error,
					bootstrapped: true,
				};
			}
			return {
				scope_id: scopeId,
				label: scope.label,
				ok: true,
				opsIn: mergeResult.applied,
				opsOut: 0,
				bootstrapped: true,
			};
		} catch (err) {
			const detail = err instanceof Error ? err.message.trim() || err.constructor.name : "unknown";
			const error = `scoped merge bootstrap failed: ${detail}`;
			return {
				scope_id: scopeId,
				label: scope.label,
				ok: false,
				failureCategory: scopeFailureCategory(error),
				opsIn: 0,
				opsOut: 0,
				error,
				bootstrapped: true,
			};
		}
	}

	// Bootstrap when this device has never pulled the scope and has no local
	// rows. Populated scopes without a peer cursor are handled by the additive
	// merge-recovery branch above so this destructive bootstrap path stays safe.
	if (shouldBootstrapEmptyScope) {
		try {
			const resetInfo: SyncResetRequired = {
				scope_id: scopeId,
				generation: scope.sync_reset.generation,
				snapshot_id: scope.sync_reset.snapshot_id,
				baseline_cursor: scope.sync_reset.baseline_cursor,
				retained_floor_cursor: scope.sync_reset.retained_floor_cursor,
				reset_required: true,
				reason: "initial_bootstrap" as SyncResetRequired["reason"],
			};
			const { items } = await fetchAllSnapshotPages(baseUrl, resetInfo, deviceId, {
				keysDir,
				pageSize: BOOTSTRAP_PAGE_SIZE,
				timeoutS: BOOTSTRAP_REQUEST_TIMEOUT_S,
			});
			// TOCTOU re-check: another process (CLI write, plugin, concurrent
			// sync pass) could have created shared memories in this scope while
			// the snapshot was downloading. applyBootstrapSnapshot wipes all
			// shared rows for the scope before inserting the snapshot, so
			// proceeding would clobber those writes. Mirror the same guard the
			// default-scope auto-bootstrap path already enforces in syncOnce
			// (see "needs_attention:shared_memories_appeared_during_bootstrap").
			if (hasLocalRowsInScope(db, scopeId)) {
				const error = "needs_attention:shared_memories_appeared_during_bootstrap";
				return {
					scope_id: scopeId,
					label: scope.label,
					ok: false,
					failureCategory: "other",
					opsIn: 0,
					opsOut: 0,
					error,
					bootstrapped: true,
				};
			}
			const bootstrapResult = applyBootstrapSnapshot(db, peerDeviceId, items, resetInfo, scanner);
			if (!bootstrapResult.ok) {
				const error = "bootstrap apply failed";
				return {
					scope_id: scopeId,
					label: scope.label,
					ok: false,
					failureCategory: "other",
					opsIn: 0,
					opsOut: 0,
					error,
					bootstrapped: true,
				};
			}
			return {
				scope_id: scopeId,
				label: scope.label,
				ok: true,
				opsIn: bootstrapResult.applied,
				opsOut: 0,
				bootstrapped: true,
			};
		} catch (err) {
			const detail = err instanceof Error ? err.message.trim() || err.constructor.name : "unknown";
			const error = `scoped bootstrap failed: ${detail}`;
			return {
				scope_id: scopeId,
				label: scope.label,
				ok: false,
				failureCategory: scopeFailureCategory(error),
				opsIn: 0,
				opsOut: 0,
				error,
				bootstrapped: true,
			};
		}
	}

	// Incremental: pull /v1/ops?scope_id=X&since=<lastApplied>.
	try {
		const queryParams = new URLSearchParams({
			scope_id: scopeId,
			since: lastApplied ?? "",
			limit: String(limit),
			generation: String(scope.sync_reset.generation),
			snapshot_id: scope.sync_reset.snapshot_id,
		});
		if (scope.sync_reset.baseline_cursor) {
			queryParams.set("baseline_cursor", scope.sync_reset.baseline_cursor);
		}
		const url = `${baseUrl}/v1/ops?${queryParams.toString()}`;
		const headers = {
			...buildAuthHeaders({
				deviceId,
				method: "GET",
				url,
				bodyBytes: Buffer.alloc(0),
				keysDir,
			}),
			...capabilityHeader(),
		};
		const [status, payload] = await requestJson("GET", url, { headers });

		if (status === 409 && payload?.reset_required === true) {
			// Per-scope reset requested. Clear the stale scoped cursor so the
			// next pass picks a fresh bootstrap path instead of replaying the
			// same invalid boundary forever. We deliberately do not auto-bootstrap from here
			// to avoid surprising state changes mid-loop; the default-scope
			// auto-bootstrap path remains the canonical recovery mechanism.
			clearReplicationCursorLastApplied(db, peerDeviceId, scopeId);
			const reason = ((): SyncResetRequired["reason"] => {
				switch (payload.reason) {
					case "generation_mismatch":
					case "boundary_mismatch":
					case "missing_scope":
					case "scope_inactive":
					case "stale_epoch":
					case "unsupported_scope":
						return payload.reason;
					default:
						return "stale_cursor";
				}
			})();
			const error = `reset_required:${reason}`;
			return {
				scope_id: scopeId,
				label: scope.label,
				ok: false,
				failureCategory: scopeResetFailureCategory(reason),
				opsIn: 0,
				opsOut: 0,
				error,
				resetRequired: {
					reset_required: true,
					reason,
					scope_id: typeof payload.scope_id === "string" ? payload.scope_id : scopeId,
					generation: Number(payload.generation ?? scope.sync_reset.generation),
					snapshot_id: String(payload.snapshot_id ?? scope.sync_reset.snapshot_id),
					baseline_cursor:
						typeof payload.baseline_cursor === "string" ? payload.baseline_cursor.trim() : null,
					retained_floor_cursor:
						typeof payload.retained_floor_cursor === "string"
							? payload.retained_floor_cursor.trim()
							: null,
				},
				bootstrapped: false,
			};
		}

		if (status !== 200 || payload == null) {
			const detail = errorDetail(payload);
			const suffix = detail ? ` (${status}: ${detail})` : ` (${status})`;
			const error = `peer scoped ops fetch failed${suffix}`;
			return {
				scope_id: scopeId,
				label: scope.label,
				ok: false,
				failureCategory: scopeFailureCategory(error),
				opsIn: 0,
				opsOut: 0,
				error,
				bootstrapped: false,
			};
		}

		if (!isValidIncrementalOpsResponse(payload)) {
			const error = "invalid scoped ops response";
			return {
				scope_id: scopeId,
				label: scope.label,
				ok: false,
				failureCategory: "other",
				opsIn: 0,
				opsOut: 0,
				error,
				bootstrapped: false,
			};
		}

		const ops = extractReplicationOps(payload);
		const mismatched = ops.find(
			(op) => op.device_id !== peerDeviceId || op.clock_device_id !== peerDeviceId,
		);
		if (mismatched) {
			const error = `inbound op device mismatch:${mismatched.op_id}`;
			return {
				scope_id: scopeId,
				label: scope.label,
				ok: false,
				failureCategory: "other",
				opsIn: 0,
				opsOut: 0,
				error,
				bootstrapped: false,
			};
		}

		const applied = applyReplicationOps(db, ops, deviceId, scanner, {
			inboundScopeValidation: { peerDeviceId },
		});
		if (applied.rejected > 0) {
			const reason = applied.rejections[0]?.reason ?? "scope_rejected";
			const error = `inbound scope rejected:${reason}`;
			return {
				scope_id: scopeId,
				label: scope.label,
				ok: false,
				failureCategory: "scope",
				opsIn: 0,
				opsOut: 0,
				error,
				bootstrapped: false,
			};
		}

		const reconciliation = reconcileStalePeerReceivedRows(db, {
			localDeviceId: deviceId,
			peerDeviceId,
		});
		const vectorWork = {
			upsertMemoryIds: applied.vectorWork.upsertMemoryIds,
			deleteMemoryIds: [
				...applied.vectorWork.deleteMemoryIds,
				...reconciliation.deleted_memory_ids,
			],
		};
		try {
			queueVectorBackfillForIncrementalSync(db, vectorWork);
		} catch (queueErr) {
			const fallback = await bestEffortMaintainVectorsForSyncFallback(db, vectorWork);
			if (fallback.errors.length > 0) {
				const error = `vector catch-up failed: ${queueErr instanceof Error ? queueErr.message : String(queueErr)}; fallback failed: ${fallback.errors.join("; ")}`;
				return {
					scope_id: scopeId,
					label: scope.label,
					ok: false,
					failureCategory: "other",
					opsIn: 0,
					opsOut: 0,
					error,
					bootstrapped: false,
				};
			}
		}

		const inboundCursorCandidate = asOptionalCursor(payload.next_cursor);
		if (cursorAdvances(lastApplied, inboundCursorCandidate)) {
			setReplicationCursor(db, peerDeviceId, { lastApplied: inboundCursorCandidate }, scopeId);
		}

		return {
			scope_id: scopeId,
			label: scope.label,
			ok: true,
			opsIn: applied.applied,
			opsOut: 0,
			bootstrapped: hasNullBaselineBootstrapMarker,
		};
	} catch (err) {
		const detail = err instanceof Error ? err.message.trim() || err.constructor.name : "unknown";
		const error = `scoped incremental failed: ${detail}`;
		return {
			scope_id: scopeId,
			label: scope.label,
			ok: false,
			failureCategory: scopeFailureCategory(error),
			opsIn: 0,
			opsOut: 0,
			error,
			bootstrapped: false,
		};
	}
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Run migration + replication backfill preflight. */
export function syncPassPreflight(db: Database): void {
	ensureAdditiveSchemaCompatibility(db);
	migrateLegacyImportKeys(db, 2000);
	backfillReplicationOps(db, 200);
}

// ---------------------------------------------------------------------------
// Main sync loop
// ---------------------------------------------------------------------------

/**
 * Execute a single sync exchange with a peer across the given addresses.
 *
 * Tries each address in order. On first success, returns immediately.
 * On all failures, collects address-level errors and returns them.
 */
export async function syncOnce(
	db: Database,
	peerDeviceId: string,
	addresses: string[],
	options?: SyncPassOptions,
): Promise<SyncResult> {
	ensureAdditiveSchemaCompatibility(db);
	const limit = options?.limit ?? DEFAULT_LIMIT;
	const keysDir = options?.keysDir;
	const scanner = options?.scanner;
	if (!scanner && !syncOnceScannerWarned) {
		syncOnceScannerWarned = true;
		process.stderr.write(
			"[codemem] sync apply running without explicit scanner — workspace-level secret rules will not apply to inbound peer content\n",
		);
	}

	// Look up pinned fingerprint
	const d = drizzle(db, { schema });
	const pinRow = d
		.select({ pinned_fingerprint: schema.syncPeers.pinned_fingerprint })
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.get();
	const pinnedFingerprint = pinRow?.pinned_fingerprint ?? "";
	if (!pinnedFingerprint) {
		return {
			ok: false,
			error: "peer not pinned",
			failureCategory: "trust",
			opsIn: 0,
			opsOut: 0,
			addressErrors: [],
		};
	}

	// Read cursors
	let [lastApplied, lastAcked] = getReplicationCursor(db, peerDeviceId);

	// Ensure local device identity
	let deviceId: string;
	try {
		[deviceId] = ensureDeviceIdentity(db, { keysDir });
	} catch (err: unknown) {
		const detail = err instanceof Error ? err.message.trim() || err.constructor.name : "unknown";
		const error = `device identity unavailable: ${detail}`;
		recordSyncAttempt(db, peerDeviceId, { ok: false, error });
		return { ok: false, error, failureCategory: "other", opsIn: 0, opsOut: 0, addressErrors: [] };
	}

	const addressErrors: Array<{ address: string; error: string }> = [];
	let attemptedAny = false;
	let lastCapabilityDiagnostics: SyncCapabilityDiagnostics | undefined;

	for (const address of addresses) {
		const baseUrl = buildBaseUrl(address);
		if (!baseUrl) continue;
		attemptedAny = true;

		try {
			// -- 1. Verify peer identity via /v1/status --
			const statusUrl = `${baseUrl}/v1/status`;
			const statusHeaders = {
				...buildAuthHeaders({
					deviceId,
					method: "GET",
					url: statusUrl,
					bodyBytes: Buffer.alloc(0),
					keysDir,
				}),
				...capabilityHeader(),
			};
			const [statusCode, statusPayload] = await requestJson("GET", statusUrl, {
				headers: statusHeaders,
			});
			if (statusCode !== 200 || !statusPayload) {
				const detail = errorDetail(statusPayload);
				const suffix = detail ? ` (${statusCode}: ${detail})` : ` (${statusCode})`;
				throw new Error(`peer status failed${suffix}`);
			}
			if (statusPayload.fingerprint !== pinnedFingerprint) {
				throw new Error("peer fingerprint mismatch");
			}
			lastCapabilityDiagnostics = capabilityDiagnostics(statusPayload.sync_capability);
			if (String(statusPayload.protocol_version ?? "") !== EXPECTED_SYNC_PROTOCOL_VERSION) {
				throw new Error(
					`peer protocol mismatch (expected ${EXPECTED_SYNC_PROTOCOL_VERSION}, got ${String(statusPayload.protocol_version ?? "missing")})`,
				);
			}
			const peerResetBoundary = parsePeerResetBoundary(statusPayload);
			if (!peerResetBoundary) {
				throw new Error("peer status missing sync_reset boundary");
			}

			// -- 1b. Auto-bootstrap if local node is empty and has never synced --
			// Only triggers when: (a) no cursor for this peer, AND (b) no shared
			// memories exist locally.  If the node already has shared data from
			// another peer, fall through to normal incremental sync so the server
			// can decide whether a reset is needed without clobbering local state.
			if (lastApplied === null && lastAcked === null) {
				const localSharedCount = Number(
					(
						db
							.prepare("SELECT count(*) as n FROM memory_items WHERE import_key IS NOT NULL")
							.get() as { n: number }
					)?.n ?? 0,
				);
				if (localSharedCount === 0) {
					try {
						const resetInfo = {
							scope_id: peerResetBoundary.scope_id,
							generation: peerResetBoundary.generation,
							snapshot_id: peerResetBoundary.snapshot_id,
							baseline_cursor: peerResetBoundary.baseline_cursor ?? null,
							retained_floor_cursor: peerResetBoundary.retained_floor_cursor ?? null,
							reset_required: true as const,
							reason: "initial_bootstrap" as const,
						};
						if (resetInfo.scope_id) {
							const accessFailure = scopedSnapshotAccessFailure(db, {
								scopeId: resetInfo.scope_id,
								peerDeviceId,
								localDeviceId: deviceId,
							});
							if (accessFailure) {
								recordSyncAttempt(db, peerDeviceId, {
									ok: false,
									error: `reset_required:${accessFailure}`,
									capabilities: lastCapabilityDiagnostics,
								});
								return scopedSnapshotAccessDeniedResult(baseUrl, resetInfo, accessFailure);
							}
						}
						const { items } = await fetchAllSnapshotPages(baseUrl, resetInfo, deviceId, {
							keysDir,
							pageSize: BOOTSTRAP_PAGE_SIZE,
							timeoutS: BOOTSTRAP_REQUEST_TIMEOUT_S,
						});

						// Re-check after network fetch: another process (plugin, CLI, another
						// sync pass) could have created shared memories while we were fetching
						// pages.  Same TOCTOU guard as the re-bootstrap path.
						const postFetchSharedCount = Number(
							(
								db
									.prepare("SELECT count(*) as n FROM memory_items WHERE import_key IS NOT NULL")
									.get() as { n: number }
							)?.n ?? 0,
						);
						if (postFetchSharedCount > 0) {
							recordSyncAttempt(db, peerDeviceId, {
								ok: false,
								error: "needs_attention:shared_memories_appeared_during_bootstrap",
								capabilities: lastCapabilityDiagnostics,
							});
							return {
								ok: false,
								address: baseUrl,
								error: `needs attention: ${postFetchSharedCount} shared memory change(s) appeared during initial bootstrap fetch`,
								failureCategory: "other",
								opsIn: 0,
								opsOut: 0,
								addressErrors: [],
							};
						}
						const bootstrapResult = applyBootstrapSnapshot(
							db,
							peerDeviceId,
							items,
							resetInfo,
							scanner,
						);
						if (!bootstrapResult.ok) {
							throw new Error("initial bootstrap apply failed");
						}
						// Run scoped sync alongside the default-scope bootstrap so
						// fresh peers receive every authorized Space on the FIRST
						// sync pass, not on the second. Per-scope failures are
						// reported per scope and downgrade the overall ok only
						// when at least one scope fails.
						const scopedAfterBootstrap =
							lastCapabilityDiagnostics?.negotiated === "scoped"
								? await runScopedSync(db, {
										peerDeviceId,
										baseUrl,
										deviceId,
										statusPayload,
										keysDir,
										scanner,
										limit,
									})
								: { results: [], totalOpsIn: 0 };
						const bootstrapAllOk = scopedAfterBootstrap.results.every((r) => r.ok);
						recordPeerSuccess(db, peerDeviceId, baseUrl);
						recordSyncAttempt(db, peerDeviceId, {
							ok: bootstrapAllOk,
							opsIn: bootstrapResult.applied + scopedAfterBootstrap.totalOpsIn,
							opsOut: 0,
							capabilities: lastCapabilityDiagnostics,
							error: bootstrapAllOk
								? undefined
								: `scoped sync incomplete: ${scopedAfterBootstrap.results
										.filter((r) => !r.ok)
										.map((r) => `${r.scope_id}=${r.error ?? "unknown"}`)
										.join("; ")}`,
						});
						return {
							ok: bootstrapAllOk,
							address: baseUrl,
							failureCategory: aggregateScopeFailureCategory(scopedAfterBootstrap.results),
							opsIn: bootstrapResult.applied + scopedAfterBootstrap.totalOpsIn,
							opsOut: 0,
							addressErrors: [],
							perScopeResults:
								scopedAfterBootstrap.results.length > 0 ? scopedAfterBootstrap.results : undefined,
						};
					} catch (bootstrapErr) {
						const msg = bootstrapErr instanceof Error ? bootstrapErr.message : String(bootstrapErr);
						// Don't record attempt here — let address fallback loop handle it
						// to avoid inflating consecutive failure counts.
						throw new Error(`initial bootstrap failed: ${msg}`);
					}
				}
				// else: local node has shared data — fall through to incremental sync
			}

			// -- 2. Pull ops from peer --
			const queryParams = new URLSearchParams({
				since: lastApplied ?? "",
				limit: String(limit),
				generation: String(peerResetBoundary.generation),
				snapshot_id: peerResetBoundary.snapshot_id,
			});
			if (peerResetBoundary.baseline_cursor) {
				queryParams.set("baseline_cursor", peerResetBoundary.baseline_cursor);
			}
			const query = queryParams.toString();
			const getUrl = `${baseUrl}/v1/ops?${query}`;
			const getHeaders = {
				...buildAuthHeaders({
					deviceId,
					method: "GET",
					url: getUrl,
					bodyBytes: Buffer.alloc(0),
					keysDir,
				}),
				...capabilityHeader(),
			};
			const [getStatus, getPayload] = await requestJson("GET", getUrl, {
				headers: getHeaders,
			});
			if (getStatus === 409 && getPayload?.reset_required === true) {
				const dirtyLocal = hasUnsyncedSharedMemoryChanges(db);
				const resetReason =
					getPayload.reason === "generation_mismatch" ||
					getPayload.reason === "boundary_mismatch" ||
					getPayload.reason === "missing_scope" ||
					getPayload.reason === "unsupported_scope"
						? getPayload.reason
						: "stale_cursor";
				const resetRequired: SyncResult["resetRequired"] = {
					reset_required: true,
					reason: resetReason,
					scope_id: typeof getPayload.scope_id === "string" ? getPayload.scope_id : null,
					generation: Number(getPayload.generation ?? 1),
					snapshot_id: String(getPayload.snapshot_id ?? ""),
					baseline_cursor:
						typeof getPayload.baseline_cursor === "string" && getPayload.baseline_cursor.trim()
							? getPayload.baseline_cursor.trim()
							: null,
					retained_floor_cursor:
						typeof getPayload.retained_floor_cursor === "string" &&
						getPayload.retained_floor_cursor.trim()
							? getPayload.retained_floor_cursor.trim()
							: null,
				};

				if (dirtyLocal.dirty) {
					recordSyncAttempt(db, peerDeviceId, {
						ok: false,
						error: `needs_attention:local_unsynced_shared_memory:${dirtyLocal.count}`,
						capabilities: lastCapabilityDiagnostics,
					});
					return {
						ok: false,
						address: baseUrl,
						error: `needs attention: ${dirtyLocal.count} unsynced shared memory change(s) block automatic reset`,
						failureCategory: "other",
						opsIn: 0,
						opsOut: 0,
						addressErrors: [],
						resetRequired,
					};
				}

				// No dirty local state — safe to auto-bootstrap from peer snapshot.
				try {
					if (resetRequired.scope_id) {
						const accessFailure = scopedSnapshotAccessFailure(db, {
							scopeId: resetRequired.scope_id,
							peerDeviceId,
							localDeviceId: deviceId,
						});
						if (accessFailure) {
							recordSyncAttempt(db, peerDeviceId, {
								ok: false,
								error: `reset_required:${accessFailure}`,
								capabilities: lastCapabilityDiagnostics,
							});
							return scopedSnapshotAccessDeniedResult(baseUrl, resetRequired, accessFailure);
						}
					}
					const { items } = await fetchAllSnapshotPages(baseUrl, resetRequired, deviceId, {
						keysDir,
						timeoutS: BOOTSTRAP_REQUEST_TIMEOUT_S,
					});

					// Re-check dirty state after network fetch to close the TOCTOU window.
					// A user may have created shared memories while we were fetching pages.
					const dirtyAfterFetch = hasUnsyncedSharedMemoryChanges(db);
					if (dirtyAfterFetch.dirty) {
						recordSyncAttempt(db, peerDeviceId, {
							ok: false,
							error: `needs_attention:local_unsynced_shared_memory:${dirtyAfterFetch.count}`,
							capabilities: lastCapabilityDiagnostics,
						});
						return {
							ok: false,
							address: baseUrl,
							error: `needs attention: ${dirtyAfterFetch.count} unsynced shared memory change(s) appeared during bootstrap fetch`,
							failureCategory: "other",
							opsIn: 0,
							opsOut: 0,
							addressErrors: [],
							resetRequired,
						};
					}

					const bootstrapResult = applyBootstrapSnapshot(
						db,
						peerDeviceId,
						items,
						resetRequired,
						scanner,
					);
					if (!bootstrapResult.ok) {
						throw new Error("bootstrap apply failed");
					}
					recordPeerSuccess(db, peerDeviceId, baseUrl);
					recordSyncAttempt(db, peerDeviceId, {
						ok: true,
						opsIn: bootstrapResult.applied,
						opsOut: 0,
						capabilities: lastCapabilityDiagnostics,
					});
					return {
						ok: true,
						address: baseUrl,
						opsIn: bootstrapResult.applied,
						opsOut: 0,
						addressErrors: [],
					};
				} catch (bootstrapErr) {
					const msg = bootstrapErr instanceof Error ? bootstrapErr.message : String(bootstrapErr);
					recordSyncAttempt(db, peerDeviceId, {
						ok: false,
						error: `bootstrap_failed:${msg}`,
						capabilities: lastCapabilityDiagnostics,
					});
					return {
						ok: false,
						address: baseUrl,
						error: `bootstrap failed: ${msg}`,
						failureCategory: "other",
						opsIn: 0,
						opsOut: 0,
						addressErrors: [],
						resetRequired,
					};
				}
			}
			if (getStatus !== 200 || getPayload == null) {
				const detail = errorDetail(getPayload);
				const suffix = detail ? ` (${getStatus}: ${detail})` : ` (${getStatus})`;
				throw new Error(`peer ops fetch failed${suffix}`);
			}
			if (!isValidIncrementalOpsResponse(getPayload)) {
				throw new Error("invalid ops response");
			}
			const ops = extractReplicationOps(getPayload);
			const mismatchedOp = ops.find(
				(op) => op.device_id !== peerDeviceId || op.clock_device_id !== peerDeviceId,
			);
			if (mismatchedOp) {
				throw new Error(`inbound op device mismatch:${mismatchedOp.op_id}`);
			}
			const inboundScopeValidation =
				lastCapabilityDiagnostics?.negotiated === "unsupported"
					? { peerDeviceId, enabled: false }
					: { peerDeviceId };

			// -- 3. Apply incoming ops to local entities --
			const applied = applyReplicationOps(db, ops, deviceId, scanner, { inboundScopeValidation });
			if (applied.rejected > 0) {
				const firstReason = applied.rejections[0]?.reason ?? "scope_rejected";
				throw new Error(`inbound scope rejected:${firstReason}`);
			}
			const reconciliation = reconcileStalePeerReceivedRows(db, {
				localDeviceId: deviceId,
				peerDeviceId,
			});
			const vectorWork = {
				upsertMemoryIds: applied.vectorWork.upsertMemoryIds,
				deleteMemoryIds: [
					...applied.vectorWork.deleteMemoryIds,
					...reconciliation.deleted_memory_ids,
				],
			};
			try {
				queueVectorBackfillForIncrementalSync(db, vectorWork);
			} catch (queueError) {
				const fallback = await bestEffortMaintainVectorsForSyncFallback(db, vectorWork);
				if (fallback.errors.length > 0) {
					const details = fallback.errors.join("; ");
					throw new Error(
						`vector catch-up queue failed: ${queueError instanceof Error ? queueError.message : String(queueError)}; fallback failed: ${details}`,
					);
				}
			}

			const inboundCursorCandidate = asOptionalCursor(getPayload.next_cursor);
			if (cursorAdvances(lastApplied, inboundCursorCandidate)) {
				setReplicationCursor(db, peerDeviceId, { lastApplied: inboundCursorCandidate });
				lastApplied = inboundCursorCandidate;
			}

			// -- 5. Push local ops to peer --
			const [outboundWindow, outboundCursor] = loadLocalOpsSince(db, lastAcked, deviceId, limit);
			const [outboundOps, filteredOutboundCursor, skippedOutbound] =
				filterReplicationOpsForSyncWithStatus(db, outboundWindow, peerDeviceId, {
					localDeviceId: deviceId,
				});
			const opsSkipped = skippedOutbound?.skipped_count ?? 0;
			const postUrl = `${baseUrl}/v1/ops`;
			if (outboundOps.length > 0) {
				const batches = chunkOpsBySize(outboundOps, MAX_SYNC_BODY_BYTES);
				for (const batch of batches) {
					await pushOps(postUrl, deviceId, batch, keysDir);
				}
			}
			const ackCursor = filteredOutboundCursor ?? outboundCursor;
			if (ackCursor && cursorAdvances(lastAcked, ackCursor)) {
				setReplicationCursor(db, peerDeviceId, { lastAcked: ackCursor });
				lastAcked = ackCursor;
			}

			// -- 6. Per-Space scoped sync (additive; runs after legacy default
			//       scope succeeded so the peer is already authenticated).
			//
			// Only iterates when both peers advertised the `scoped` capability
			// AND the peer's /v1/status response carried an `authorized_scopes`
			// array. Each scope is best-effort: a failure in one Space does not
			// abort the others or roll back the default-scope pull/push that
			// just succeeded. Top-level `ok` is downgraded to false only if
			// at least one scope failed.
			const scopedAfterIncremental =
				lastCapabilityDiagnostics?.negotiated === "scoped"
					? await runScopedSync(db, {
							peerDeviceId,
							baseUrl,
							deviceId,
							statusPayload,
							keysDir,
							scanner,
							limit,
						})
					: { results: [], totalOpsIn: 0 };

			const allScopesOk = scopedAfterIncremental.results.every((r) => r.ok);

			// -- 7. Record success --
			recordPeerSuccess(db, peerDeviceId, baseUrl);
			recordSyncAttempt(db, peerDeviceId, {
				ok: allScopesOk,
				opsIn: applied.applied + scopedAfterIncremental.totalOpsIn,
				opsOut: outboundOps.length,
				capabilities: lastCapabilityDiagnostics,
				error: allScopesOk
					? undefined
					: `scoped sync incomplete: ${scopedAfterIncremental.results
							.filter((r) => !r.ok)
							.map((r) => `${r.scope_id}=${r.error ?? "unknown"}`)
							.join("; ")}`,
			});
			return {
				ok: allScopesOk,
				address: baseUrl,
				failureCategory: aggregateScopeFailureCategory(scopedAfterIncremental.results),
				opsIn: applied.applied + scopedAfterIncremental.totalOpsIn,
				opsOut: outboundOps.length,
				opsSkipped,
				skippedOut: skippedOutbound ?? null,
				addressErrors: [],
				perScopeResults:
					scopedAfterIncremental.results.length > 0 ? scopedAfterIncremental.results : undefined,
			};
		} catch (err: unknown) {
			const detail = err instanceof Error ? err.message.trim() || err.constructor.name : "unknown";
			addressErrors.push({ address: baseUrl, error: detail });
		}
	}

	// All addresses failed
	let error = summarizeAddressErrors(addressErrors);
	if (!attemptedAny) {
		error = "no dialable peer addresses";
	}
	if (!error) {
		error = "sync failed without diagnostic detail";
	}
	recordSyncAttempt(db, peerDeviceId, {
		ok: false,
		error,
		capabilities: lastCapabilityDiagnostics,
	});
	return {
		ok: false,
		error,
		failureCategory: categorizeSyncFailure(error),
		opsIn: 0,
		opsOut: 0,
		addressErrors,
	};
}

// ---------------------------------------------------------------------------
// High-level entry point
// ---------------------------------------------------------------------------

/**
 * Run a sync pass with a peer, resolving addresses from the database.
 *
 * Loads peer addresses from the sync_peers table and delegates to syncOnce.
 */
export async function runSyncPass(
	db: Database,
	peerDeviceId: string,
	options?: SyncPassOptions,
): Promise<SyncResult> {
	// Load stored addresses for this peer
	const d = drizzle(db, { schema });
	const row = d
		.select({ addresses_json: schema.syncPeers.addresses_json })
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.get();

	let addresses: string[] = [];
	if (row?.addresses_json) {
		try {
			const parsed = JSON.parse(row.addresses_json);
			if (Array.isArray(parsed)) {
				addresses = parsed.filter((a): a is string => typeof a === "string");
			}
		} catch {
			// Malformed JSON — proceed with empty addresses
		}
	}

	return syncOnce(db, peerDeviceId, addresses, options);
}

// ---------------------------------------------------------------------------
// Connectivity backoff (for daemon use)
// ---------------------------------------------------------------------------

/** Connectivity error patterns indicating peer is offline. */
const CONNECTIVITY_ERROR_PATTERNS = [
	"no route to host",
	"connection refused",
	"network is unreachable",
	"timed out",
	"name or service not known",
	"nodename nor servname provided",
	"errno 65",
	"errno 61",
	"errno 60",
	"errno 111",
] as const;

const PEER_BACKOFF_BASE_S = 120;
const PEER_BACKOFF_MAX_S = 1800;

/** Check if an error string indicates a network connectivity failure. */
export function isConnectivityError(error: string | null): boolean {
	if (!error) return false;
	const lower = error.toLowerCase();
	return CONNECTIVITY_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Count consecutive recent failures that are connectivity errors. */
export function consecutiveConnectivityFailures(
	db: Database,
	peerDeviceId: string,
	limit = 10,
): number {
	const d = drizzle(db, { schema });
	const rows = d
		.select({ ok: schema.syncAttempts.ok, error: schema.syncAttempts.error })
		.from(schema.syncAttempts)
		.where(eq(schema.syncAttempts.peer_device_id, peerDeviceId))
		.orderBy(desc(schema.syncAttempts.started_at))
		.limit(limit)
		.all();

	let count = 0;
	for (const row of rows) {
		if (row.ok) break;
		if (isConnectivityError(row.error)) {
			count++;
		} else {
			break;
		}
	}
	return count;
}

/** Calculate backoff duration with jitter to avoid thundering herd. */
export function peerBackoffSeconds(consecutiveFailures: number): number {
	if (consecutiveFailures <= 1) return 0;
	const exponent = Math.min(consecutiveFailures - 1, 8);
	const base = Math.min(PEER_BACKOFF_BASE_S * 2 ** (exponent - 1), PEER_BACKOFF_MAX_S);
	// Add 50% jitter: base * [0.5, 1.0)
	return base * (0.5 + Math.random() * 0.5);
}

/** Check if a peer should be skipped due to repeated connectivity failures. */
export function shouldSkipOfflinePeer(db: Database, peerDeviceId: string): boolean {
	const failures = consecutiveConnectivityFailures(db, peerDeviceId);
	if (failures < 2) return false;
	const backoffS = peerBackoffSeconds(failures);
	if (backoffS <= 0) return false;

	const d = drizzle(db, { schema });
	const row = d
		.select({ started_at: schema.syncAttempts.started_at })
		.from(schema.syncAttempts)
		.where(eq(schema.syncAttempts.peer_device_id, peerDeviceId))
		.orderBy(desc(schema.syncAttempts.started_at))
		.limit(1)
		.get();

	if (!row?.started_at) return false;
	try {
		const lastAttempt = new Date(row.started_at).getTime();
		const now = Date.now();
		const elapsedS = (now - lastAttempt) / 1000;
		return elapsedS < backoffS;
	} catch {
		return false;
	}
}
