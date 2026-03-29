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
import * as schema from "./schema.js";
import { buildAuthHeaders } from "./sync-auth.js";
import { applyBootstrapSnapshot, fetchAllSnapshotPages } from "./sync-bootstrap.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import {
	applyReplicationOps,
	backfillReplicationOps,
	chunkOpsBySize,
	extractReplicationOps,
	filterReplicationOpsForSync,
	filterReplicationOpsForSyncWithStatus,
	getReplicationCursor,
	hasUnsyncedSharedMemoryChanges,
	migrateLegacyImportKeys,
	setReplicationCursor,
} from "./sync-replication.js";
import type { ReplicationOp, SyncResetRequired } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max body size for sync POST requests (1 MiB). */
const MAX_SYNC_BODY_BYTES = 1_048_576;

/** Default op fetch/push limit per round. */
const DEFAULT_LIMIT = 200;

/** Current sync protocol version expected from peers. */
const EXPECTED_SYNC_PROTOCOL_VERSION = "2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncResult {
	ok: boolean;
	error?: string;
	address?: string;
	opsIn: number;
	opsOut: number;
	addressErrors: Array<{ address: string; error: string }>;
	resetRequired?: SyncResetRequired;
}

export interface SyncPassOptions {
	limit?: number;
	keysDir?: string;
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
	if (!payload || payload.reset_required !== false) return false;
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

/**
 * Record a sync attempt in the sync_attempts table.
 */
function recordSyncAttempt(
	db: Database,
	peerDeviceId: string,
	options: { ok: boolean; opsIn?: number; opsOut?: number; error?: string },
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
}

/**
 * Update last_sync_at and clear last_error on successful sync.
 */
function recordPeerSuccess(db: Database, peerDeviceId: string): void {
	const d = drizzle(db, { schema });
	const now = new Date().toISOString();
	d.update(schema.syncPeers)
		.set({ last_sync_at: now, last_seen_at: now, last_error: null })
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
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

/**
 * Compute a cursor string from a timestamp and op_id.
 * Currently unused — will be needed when real apply logic advances the cursor.
 */
export function computeCursor(createdAt: string, opId: string): string {
	return `${createdAt}|${opId}`;
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

	const body = { ops };
	const bodyBytes = Buffer.from(JSON.stringify(body), "utf-8");
	const headers = buildAuthHeaders({
		deviceId,
		method: "POST",
		url: postUrl,
		bodyBytes,
		keysDir,
	});
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
// Preflight
// ---------------------------------------------------------------------------

/** Run migration + replication backfill preflight. */
export function syncPassPreflight(db: Database): void {
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
	const limit = options?.limit ?? DEFAULT_LIMIT;
	const keysDir = options?.keysDir;

	// Look up pinned fingerprint
	const d = drizzle(db, { schema });
	const pinRow = d
		.select({ pinned_fingerprint: schema.syncPeers.pinned_fingerprint })
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.get();
	const pinnedFingerprint = pinRow?.pinned_fingerprint ?? "";
	if (!pinnedFingerprint) {
		return { ok: false, error: "peer not pinned", opsIn: 0, opsOut: 0, addressErrors: [] };
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
		return { ok: false, error, opsIn: 0, opsOut: 0, addressErrors: [] };
	}

	const addressErrors: Array<{ address: string; error: string }> = [];
	let attemptedAny = false;

	for (const address of addresses) {
		const baseUrl = buildBaseUrl(address);
		if (!baseUrl) continue;
		attemptedAny = true;

		try {
			// -- 1. Verify peer identity via /v1/status --
			const statusUrl = `${baseUrl}/v1/status`;
			const statusHeaders = buildAuthHeaders({
				deviceId,
				method: "GET",
				url: statusUrl,
				bodyBytes: Buffer.alloc(0),
				keysDir,
			});
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
			if (String(statusPayload.protocol_version ?? "") !== EXPECTED_SYNC_PROTOCOL_VERSION) {
				throw new Error(
					`peer protocol mismatch (expected ${EXPECTED_SYNC_PROTOCOL_VERSION}, got ${String(statusPayload.protocol_version ?? "missing")})`,
				);
			}
			const peerResetBoundary = parsePeerResetBoundary(statusPayload);
			if (!peerResetBoundary) {
				throw new Error("peer status missing sync_reset boundary");
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
			const getHeaders = buildAuthHeaders({
				deviceId,
				method: "GET",
				url: getUrl,
				bodyBytes: Buffer.alloc(0),
				keysDir,
			});
			const [getStatus, getPayload] = await requestJson("GET", getUrl, {
				headers: getHeaders,
			});
			if (getStatus === 409 && getPayload?.reset_required === true) {
				const dirtyLocal = hasUnsyncedSharedMemoryChanges(db);
				const resetRequired: SyncResult["resetRequired"] = {
					reset_required: true,
					reason:
						getPayload.reason === "generation_mismatch" || getPayload.reason === "boundary_mismatch"
							? getPayload.reason
							: "stale_cursor",
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
					});
					return {
						ok: false,
						address: baseUrl,
						error: `needs attention: ${dirtyLocal.count} unsynced shared memory change(s) block automatic reset`,
						opsIn: 0,
						opsOut: 0,
						addressErrors: [],
						resetRequired,
					};
				}

				// No dirty local state — safe to auto-bootstrap from peer snapshot.
				try {
					const { items } = await fetchAllSnapshotPages(baseUrl, resetRequired, deviceId, {
						keysDir,
					});

					// Re-check dirty state after network fetch to close the TOCTOU window.
					// A user may have created shared memories while we were fetching pages.
					const dirtyAfterFetch = hasUnsyncedSharedMemoryChanges(db);
					if (dirtyAfterFetch.dirty) {
						recordSyncAttempt(db, peerDeviceId, {
							ok: false,
							error: `needs_attention:local_unsynced_shared_memory:${dirtyAfterFetch.count}`,
						});
						return {
							ok: false,
							address: baseUrl,
							error: `needs attention: ${dirtyAfterFetch.count} unsynced shared memory change(s) appeared during bootstrap fetch`,
							opsIn: 0,
							opsOut: 0,
							addressErrors: [],
							resetRequired,
						};
					}

					const bootstrapResult = applyBootstrapSnapshot(db, peerDeviceId, items, resetRequired);
					if (!bootstrapResult.ok) {
						throw new Error("bootstrap apply failed");
					}
					recordPeerSuccess(db, peerDeviceId);
					recordSyncAttempt(db, peerDeviceId, {
						ok: true,
						opsIn: bootstrapResult.applied,
						opsOut: 0,
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
					});
					return {
						ok: false,
						address: baseUrl,
						error: `bootstrap failed: ${msg}`,
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
			const [inboundOps, inboundCursor] = filterReplicationOpsForSyncWithStatus(
				db,
				ops,
				peerDeviceId,
			);

			// -- 3. Apply incoming ops to local entities --
			const applied = applyReplicationOps(db, inboundOps, deviceId);

			const inboundCursorCandidate = inboundCursor || asOptionalCursor(getPayload.next_cursor);
			if (cursorAdvances(lastApplied, inboundCursorCandidate)) {
				setReplicationCursor(db, peerDeviceId, { lastApplied: inboundCursorCandidate });
				lastApplied = inboundCursorCandidate;
			}

			// -- 5. Push local ops to peer --
			const [outboundWindow, outboundCursor] = loadLocalOpsSince(db, lastAcked, deviceId, limit);
			const [outboundOps, filteredOutboundCursor] = filterReplicationOpsForSync(
				db,
				outboundWindow,
				peerDeviceId,
			);
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

			// -- 6. Record success --
			recordPeerSuccess(db, peerDeviceId);
			recordSyncAttempt(db, peerDeviceId, {
				ok: true,
				opsIn: applied.applied,
				opsOut: outboundOps.length,
			});
			return {
				ok: true,
				address: baseUrl,
				opsIn: applied.applied,
				opsOut: outboundOps.length,
				addressErrors: [],
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
	recordSyncAttempt(db, peerDeviceId, { ok: false, error });
	return { ok: false, error, opsIn: 0, opsOut: 0, addressErrors };
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
