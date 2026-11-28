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
	type CoordinatorFreeOutboundRules,
	DEFAULT_SYNC_SCOPE_ID,
	filterReplicationOpsForSyncWithStatus,
	opsStillSendableToPeer,
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
	deleted_at: string | null;
	scope_id: string | null;
	visibility: string | null;
	origin_device_id: string | null;
}

function storedRows(db: Database, importKey: string): StoredRow[] {
	return db
		.prepare(`SELECT id, active, deleted_at, scope_id, visibility, origin_device_id FROM memory_items
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

/** An op that names its origin device as its sender and sits in local-default. */
function fromOriginInLocalDefault(op: ReplicationOp, origin: string): boolean {
	return (
		op.entity_type === "memory_item" &&
		op.device_id === origin &&
		op.clock_device_id === origin &&
		op.scope_id === DEFAULT_SYNC_SCOPE_ID
	);
}

/**
 * A delete from `origin` in local-default, without a payload, as the shared outbound decision
 * sends every deletion. The row it targets must be one `origin` created, which the caller checks.
 */
function laneTombstone(op: ReplicationOp, origin: string): boolean {
	return op.op_type === "delete" && fromOriginInLocalDefault(op, origin) && op.payload_json == null;
}

/** An op the lane may carry from `origin`: a shared upsert or a content-free tombstone. */
function laneOp(op: ReplicationOp, origin: string): boolean {
	return laneUpsert(op, origin) || laneTombstone(op, origin);
}

/** An op that carries a shared local-default memory created by `origin`, as it claims to. */
function laneUpsert(op: ReplicationOp, origin: string): boolean {
	if (op.op_type !== "upsert" || !fromOriginInLocalDefault(op, origin)) return false;
	const payload = parsePayload(op);
	if (!payload || payload.origin_device_id !== origin) return false;
	if (payload.scope_id != null && payload.scope_id !== DEFAULT_SYNC_SCOPE_ID) return false;
	if (!canonicalSharedUpsert(payload) || !fullReplacement(payload)) return false;
	return (
		syncVisibilityAllowed(payload) && !replicationOpRequiresPersonalScopeAuthorization(op, payload)
	);
}

/**
 * A payload that says it is shared in the canonical field, with no fallback to metadata or
 * workspace, and that carries no tombstone. Deletes travel only as content-free tombstones,
 * so an upsert may not hide or delete a memory.
 */
function canonicalSharedUpsert(payload: Record<string, unknown>): boolean {
	if (payload.visibility !== "shared") return false;
	const metadata = payload.metadata_json;
	const metadataVisibility =
		metadata && typeof metadata === "object"
			? (metadata as { visibility?: unknown }).visibility
			: null;
	if (metadataVisibility != null && metadataVisibility !== "shared") return false;
	if (payload.deleted_at != null) return false;
	return payload.active == null || payload.active === 1;
}

/**
 * Every field a memory's body is built from, as the shared outbound decision sends it. Apply
 * keeps a stored field the payload leaves out or sends as null, so an update without them would
 * keep content this device already held and still count as written.
 */
const FULL_UPSERT_FIELDS = [
	"kind",
	"title",
	"subtitle",
	"body_text",
	"narrative",
	"facts",
	"concepts",
	"files_read",
	"files_modified",
	"tags_text",
	"active",
	"deleted_at",
	"visibility",
	"workspace_id",
	"workspace_kind",
	"actor_id",
	"metadata_json",
	"created_at",
	"updated_at",
] as const;

/** An upsert that replaces the whole memory: every body field named, and the text present. */
function fullReplacement(payload: Record<string, unknown>): boolean {
	if (!FULL_UPSERT_FIELDS.every((field) => Object.hasOwn(payload, field))) return false;
	return ["kind", "title", "body_text"].every((field) => typeof payload[field] === "string");
}

function projectOf(op: ReplicationOp): string | null {
	const project = parsePayload(op)?.project;
	return typeof project === "string" && project.trim() ? project.trim() : null;
}

export interface CoordinatorFreeOutboundContext {
	localDeviceId: string;
	peerDeviceId: string;
	keysDir?: string;
}

/** The lane's rules as inputs to the shared outbound decision, for one peer. */
export function coordinatorFreeOutboundRules(
	db: Database,
	context: CoordinatorFreeOutboundContext,
): CoordinatorFreeOutboundRules {
	return {
		peerEligible: () =>
			coordinatorFreeEligibility(db, {
				peerDeviceId: context.peerDeviceId,
				channelAuthenticated: true,
				keysDir: context.keysDir,
			}).eligible,
	};
}

/**
 * The ops this device may send the peer, as the shared outbound decision builds them, and the
 * cursor after the window. Content comes from the stored copy each op names, as it is now.
 * Deletes wait for content-free tombstones.
 */
export function coordinatorFreeOutboundOps(
	db: Database,
	ops: ReplicationOp[],
	context: CoordinatorFreeOutboundContext,
): { allowed: ReplicationOp[]; nextCursor: string | null } {
	const [allowed, nextCursor] = filterReplicationOpsForSyncWithStatus(
		db,
		ops,
		context.peerDeviceId,
		{
			localDeviceId: context.localDeviceId,
			coordinatorFree: coordinatorFreeOutboundRules(db, context),
		},
	);
	return { allowed, nextCursor };
}

/** The ops of a lane batch that may still go, decided and built right before a request. */
export function coordinatorFreeSendableNow(
	db: Database,
	ops: ReplicationOp[],
	context: CoordinatorFreeOutboundContext,
): ReplicationOp[] {
	return opsStillSendableToPeer(db, ops, context.peerDeviceId, context.localDeviceId, {
		coordinatorFree: coordinatorFreeOutboundRules(db, context),
	});
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
 * memories and content-free tombstones for them may arrive, and an op may change only a stored
 * row the peer created in that state.
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
			const { result, written } = applyEach(db, ops, context);
			recordProvenance(db, written, context);
			return { applied: result.applied, skipped: result.skipped, rejections: [], result };
		})
		.immediate();
}

/** A memory this device forgot stays forgotten until deletes are carried both ways. */
function forgottenHere(db: Database, importKey: string): boolean {
	return storedRows(db, importKey).some((row) => row.active === 0 || row.deleted_at != null);
}

/** The Project of the copy stored here under this key, which a tombstone doesn't name. */
function storedProject(db: Database, importKey: string): string | null {
	const project = db
		.prepare(`SELECT COALESCE(NULLIF(TRIM(memory.project), ''), session.project)
			FROM memory_items AS memory LEFT JOIN sessions AS session ON session.id = memory.session_id
			WHERE memory.import_key = ? LIMIT 1`)
		.pluck()
		.get(importKey);
	return typeof project === "string" && project.trim() ? project.trim() : null;
}

/**
 * Whether to apply this op, read right before it is applied, after the batch's earlier ops: ops
 * for Projects this device holds back from the peer are skipped, and so is an upsert for a memory
 * forgotten here, including by an earlier op in the same batch. An upsert names its Project. A
 * tombstone carries nothing, so it is judged by the Project of the copy it would delete.
 */
function wantedNow(db: Database, op: ReplicationOp, peerDeviceId: string): boolean {
	const project = op.op_type === "delete" ? storedProject(db, op.entity_id) : projectOf(op);
	if (!syncProjectAllowed(db, project, peerDeviceId)) return false;
	return op.op_type !== "upsert" || !forgottenHere(db, op.entity_id);
}

/**
 * Applies the ops one at a time, so each op's own result shows whether it wrote its row. An op
 * that loses on clock, repeats an applied op or can't be parsed writes nothing and names no row.
 */
function applyEach(
	db: Database,
	ops: ReplicationOp[],
	context: { localDeviceId: string; peerDeviceId: string; scanner?: SecretScanner },
): { result: ApplyResult; written: number[] } {
	const total: ApplyResult = {
		applied: 0,
		skipped: 0,
		rejected: 0,
		conflicts: 0,
		errors: [],
		rejections: [],
		vectorWork: { upsertMemoryIds: [], deleteMemoryIds: [] },
	};
	const written: number[] = [];
	const rowOf = db.prepare(
		"SELECT id FROM memory_items WHERE import_key = ? AND origin_device_id = ? AND scope_id = ?",
	);
	for (const op of ops) {
		if (!wantedNow(db, op, context.peerDeviceId)) {
			total.skipped += 1;
			continue;
		}
		const result = applyReplicationOps(db, [op], context.localDeviceId, context.scanner, {
			activityPeerDeviceId: context.peerDeviceId,
		});
		if (result.rejected > 0 || result.errors.length > 0) throw new LaneApplyError(result);
		total.applied += result.applied;
		total.skipped += result.skipped;
		total.conflicts += result.conflicts;
		total.vectorWork.upsertMemoryIds.push(...result.vectorWork.upsertMemoryIds);
		total.vectorWork.deleteMemoryIds.push(...result.vectorWork.deleteMemoryIds);
		if (result.applied === 0) continue;
		const id = rowOf.pluck().get(op.entity_id, context.peerDeviceId, DEFAULT_SYNC_SCOPE_ID);
		if (typeof id === "number") written.push(id);
	}
	return { result: total, written };
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

/** Records the rows this batch wrote, by row ID, and no others. */
function recordProvenance(
	db: Database,
	memoryIds: number[],
	context: { peerDeviceId: string; peerFingerprint: string },
): void {
	db.exec(REPLICAS_SQL);
	const insert = db.prepare(`INSERT INTO coordinator_free_replicas(memory_id, import_key,
		peer_device_id, peer_fingerprint, accepted_at)
		SELECT id, import_key, ?, ?, ? FROM memory_items WHERE id = ?
		ON CONFLICT(memory_id) DO UPDATE SET peer_fingerprint = excluded.peer_fingerprint,
			accepted_at = excluded.accepted_at`);
	const now = new Date().toISOString();
	for (const id of memoryIds) insert.run(context.peerDeviceId, context.peerFingerprint, now, id);
}
