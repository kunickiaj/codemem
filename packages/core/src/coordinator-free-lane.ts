import type { Database } from "better-sqlite3";
import {
	attestCoordinatorFree,
	readCoordinatorFreeStatus,
} from "./coordinator-free-attestation.js";
import { deviceHasCoordinatorHistory } from "./coordinator-history.js";
import {
	type CoordinatorSyncConfig,
	readCoordinatorSyncConfig,
} from "./coordinator-sync-config.js";
import type { SecretScanner } from "./secret-scanner.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import {
	type ApplyResult,
	applyReplicationOps,
	DEFAULT_SYNC_SCOPE_ID,
	replicationOpRequiresPersonalScopeAuthorization,
	syncProjectAllowed,
	syncVisibilityAllowed,
} from "./sync-replication.js";
import type { ReplicationOp } from "./types.js";

/*
 * Sync without a coordinator between devices paired with `sync pair`. It carries only memories
 * this device created that are shared and in the local-default scope, and only over a channel
 * that authenticated the peer's pinned key. Each side decides from its own state alone. The
 * other side's consent only saves sending what it would refuse.
 */

/** Names the lane in channel requests and status. */
export const COORDINATOR_FREE_LANE = "coordinator_free_v1";
/** The pull and push cursors' key in replication_cursors_v2, apart from the default stream. */
export const COORDINATOR_FREE_CURSOR_SCOPE = "coordinator-free-lane";
export const COORDINATOR_FREE_RECOVERY_UNAVAILABLE = "coordinator_free_recovery_unavailable";

export type CoordinatorFreeIneligibility =
	| "channel_not_authenticated"
	| "coordinator_configured"
	| "store_not_standalone"
	| "peer_not_explicitly_paired"
	| "peer_has_coordinator_history";

export type CoordinatorFreeEligibility =
	| { eligible: true }
	| { eligible: false; reason: CoordinatorFreeIneligibility };

interface PeerRow {
	pinned_fingerprint: string | null;
	public_key: string | null;
	explicit_pairing_fingerprint: string | null;
	discovered_via_coordinator_id: string | null;
	discovered_via_group_id: string | null;
	pending_bootstrap_grant_id: string | null;
	trust_provenance: string | null;
}

function explicitlyPaired(db: Database, peerDeviceId: string): boolean {
	const peer = db
		.prepare(`SELECT pinned_fingerprint, public_key, explicit_pairing_fingerprint,
			discovered_via_coordinator_id, discovered_via_group_id, pending_bootstrap_grant_id,
			trust_provenance FROM sync_peers WHERE peer_device_id = ?`)
		.get(peerDeviceId) as PeerRow | undefined;
	if (!peer?.pinned_fingerprint || !peer.public_key) return false;
	if (fingerprintPublicKey(peer.public_key) !== peer.pinned_fingerprint) return false;
	if (peer.explicit_pairing_fingerprint !== peer.pinned_fingerprint) return false;
	return (
		peer.discovered_via_coordinator_id === null &&
		peer.discovered_via_group_id === null &&
		peer.pending_bootstrap_grant_id === null &&
		peer.trust_provenance === null
	);
}

function coordinatorConfigured(config: CoordinatorSyncConfig): boolean {
	return (
		config.syncCoordinatorUrl.trim() !== "" ||
		config.syncCoordinatorGroup.trim() !== "" ||
		config.syncCoordinatorGroups.some((group) => group.trim() !== "")
	);
}

/**
 * Whether this device may exchange memories with the peer without a coordinator. A store that
 * was never attested is attested here when nothing rules it out.
 */
export function coordinatorFreeEligibility(
	db: Database,
	input: {
		peerDeviceId: string;
		channelAuthenticated: boolean;
		keysDir?: string;
		config?: CoordinatorSyncConfig;
	},
): CoordinatorFreeEligibility {
	if (!input.channelAuthenticated) return { eligible: false, reason: "channel_not_authenticated" };
	if (coordinatorConfigured(input.config ?? readCoordinatorSyncConfig()))
		return { eligible: false, reason: "coordinator_configured" };
	const options = { keysDir: input.keysDir };
	let status = readCoordinatorFreeStatus(db, options);
	if (status === "unattested") status = attestCoordinatorFree(db, options);
	if (status !== "standalone") return { eligible: false, reason: "store_not_standalone" };
	if (!explicitlyPaired(db, input.peerDeviceId))
		return { eligible: false, reason: "peer_not_explicitly_paired" };
	if (deviceHasCoordinatorHistory(db, input.peerDeviceId))
		return { eligible: false, reason: "peer_has_coordinator_history" };
	return { eligible: true };
}

function parsePayload(op: ReplicationOp): Record<string, unknown> | null {
	try {
		const value = JSON.parse(op.payload_json ?? "null") as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

interface StoredRow {
	id: number;
	active: number | null;
	scope_id: string | null;
	visibility: string | null;
	origin_device_id: string | null;
}

function storedRows(db: Database, importKey: string): StoredRow[] {
	return db
		.prepare(`SELECT id, active, scope_id, visibility, origin_device_id FROM memory_items
			WHERE import_key = ?`)
		.all(importKey) as StoredRow[];
}

/** A row the lane may carry or change: shared, in local-default, created by `origin`. */
function laneRow(row: StoredRow, origin: string): boolean {
	return (
		row.scope_id === DEFAULT_SYNC_SCOPE_ID &&
		row.visibility === "shared" &&
		row.origin_device_id === origin
	);
}

/** An op that carries a shared local-default memory created by `origin`, as it claims to. */
function laneOp(op: ReplicationOp, origin: string): boolean {
	if (op.entity_type !== "memory_item" || op.op_type !== "upsert") return false;
	if (op.device_id !== origin || op.clock_device_id !== origin) return false;
	if (op.scope_id !== DEFAULT_SYNC_SCOPE_ID) return false;
	const payload = parsePayload(op);
	if (!payload || payload.origin_device_id !== origin) return false;
	if (payload.scope_id != null && payload.scope_id !== DEFAULT_SYNC_SCOPE_ID) return false;
	return (
		syncVisibilityAllowed(payload) && !replicationOpRequiresPersonalScopeAuthorization(op, payload)
	);
}

function projectOf(op: ReplicationOp): string | null {
	const project = parsePayload(op)?.project;
	return typeof project === "string" && project.trim() ? project.trim() : null;
}

/**
 * The ops this device may send the peer, and the cursor after the window. An op goes only when
 * it is one of this device's shared local-default upserts and its memory is still exactly one
 * active row in that state now, so a memory made private or moved since is never resent.
 * Deletes wait for content-free tombstones.
 */
export function coordinatorFreeOutboundOps(
	db: Database,
	ops: ReplicationOp[],
	context: { localDeviceId: string; peerDeviceId: string },
): { allowed: ReplicationOp[]; nextCursor: string | null } {
	const allowed: ReplicationOp[] = [];
	let nextCursor: string | null = null;
	for (const op of ops) {
		nextCursor = `${op.created_at}|${op.op_id}`;
		if (!laneOp(op, context.localDeviceId)) continue;
		if (!syncProjectAllowed(db, projectOf(op), context.peerDeviceId)) continue;
		const rows = storedRows(db, op.entity_id);
		const [row] = rows;
		if (rows.length !== 1 || !row || row.active !== 1 || !laneRow(row, context.localDeviceId))
			continue;
		allowed.push(op);
	}
	return { allowed, nextCursor };
}

export type CoordinatorFreeRejectionReason =
	| "op_not_allowed"
	| "ambiguous_target"
	| "target_not_owned_by_sender";

export interface CoordinatorFreeRejection {
	op_id: string;
	reason: CoordinatorFreeRejectionReason;
}

/**
 * Why each op from the peer may not be applied. Only the peer's own shared local-default
 * memories may arrive, and an op may change only a stored row the peer created in that state.
 * An import key that matches more than one row here is refused rather than applied to all.
 */
export function coordinatorFreeInboundRejections(
	db: Database,
	ops: ReplicationOp[],
	sender: string,
): CoordinatorFreeRejection[] {
	const rejections: CoordinatorFreeRejection[] = [];
	for (const op of ops) {
		if (!laneOp(op, sender)) {
			rejections.push({ op_id: op.op_id, reason: "op_not_allowed" });
			continue;
		}
		const rows = storedRows(db, op.entity_id);
		if (rows.length > 1) rejections.push({ op_id: op.op_id, reason: "ambiguous_target" });
		else if (rows[0] && !laneRow(rows[0], sender))
			rejections.push({ op_id: op.op_id, reason: "target_not_owned_by_sender" });
	}
	return rejections;
}

export interface CoordinatorFreeApplyResult {
	applied: number;
	skipped: number;
	rejections: CoordinatorFreeRejection[];
	result: ApplyResult | null;
}

/**
 * Applies a batch from the peer, or nothing when any op is refused. Ops for Projects this
 * device holds back from the peer are skipped. The checks, the writes and each accepted row's
 * record of which peer and key it came from share one write transaction, so another process
 * can't add a row between the target check and the write, and the stale-row cleanup keeps
 * exactly the recorded rows.
 */
export function applyCoordinatorFreeOps(
	db: Database,
	ops: ReplicationOp[],
	context: {
		localDeviceId: string;
		peerDeviceId: string;
		peerFingerprint: string;
		scanner?: SecretScanner;
	},
): CoordinatorFreeApplyResult {
	return db
		.transaction((): CoordinatorFreeApplyResult => {
			const rejections = coordinatorFreeInboundRejections(db, ops, context.peerDeviceId);
			if (rejections.length > 0) return { applied: 0, skipped: 0, rejections, result: null };
			const wanted = ops.filter((op) =>
				syncProjectAllowed(db, projectOf(op), context.peerDeviceId),
			);
			const result = applyReplicationOps(db, wanted, context.localDeviceId, context.scanner, {
				activityPeerDeviceId: context.peerDeviceId,
			});
			if (result.rejected > 0 || result.errors.length > 0) throw new LaneApplyError(result);
			recordProvenance(db, wanted, context);
			return {
				applied: result.applied,
				skipped: result.skipped + ops.length - wanted.length,
				rejections: [],
				result,
			};
		})
		.immediate();
}

/** Rolls the batch back; the caller holds its cursor. */
export class LaneApplyError extends Error {
	constructor(readonly result: ApplyResult) {
		super("coordinator_free_apply_failed");
	}
}

/**
 * Rows that arrived from their origin device over sync without a coordinator. The trigger drops
 * a record with its row, so a later row that reuses the ID never inherits it.
 */
const REPLICAS_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_free_replicas (
	memory_id INTEGER PRIMARY KEY,
	import_key TEXT NOT NULL,
	peer_device_id TEXT NOT NULL,
	peer_fingerprint TEXT NOT NULL,
	accepted_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS coordinator_free_replicas_follow_row
AFTER DELETE ON memory_items
BEGIN DELETE FROM coordinator_free_replicas WHERE memory_id = OLD.id; END;
`;

function recordProvenance(
	db: Database,
	ops: ReplicationOp[],
	context: { peerDeviceId: string; peerFingerprint: string },
): void {
	db.exec(REPLICAS_SQL);
	const insert = db.prepare(`INSERT INTO coordinator_free_replicas(memory_id, import_key,
		peer_device_id, peer_fingerprint, accepted_at)
		SELECT id, import_key, ?, ?, ? FROM memory_items
		WHERE import_key = ? AND origin_device_id = ? AND scope_id = ?
		ON CONFLICT(memory_id) DO UPDATE SET peer_fingerprint = excluded.peer_fingerprint,
			accepted_at = excluded.accepted_at`);
	const now = new Date().toISOString();
	for (const op of ops) {
		insert.run(
			context.peerDeviceId,
			context.peerFingerprint,
			now,
			op.entity_id,
			context.peerDeviceId,
			DEFAULT_SYNC_SCOPE_ID,
		);
	}
}
