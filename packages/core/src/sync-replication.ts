/**
 * Sync replication: cursor tracking, op chunking, and payload extraction.
 *
 * Uses Drizzle ORM for all SQL queries so that column mismatches are
 * compile-time errors instead of silent data-loss bugs at runtime.
 *
 * Keeps replication functions decoupled from MemoryStore by accepting
 * a raw Database handle. Ported from codemem/sync/replication.py.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import { fromJson, fromJsonStrict, toJson, toJsonNullable } from "./db.js";
import { claimLocalOrigin, keepImportMarker } from "./local-origin-claim.js";
import { opCopyId, recordOpCopy } from "./memory-copy-provenance.js";
import {
	hasMatchingLocalCreation,
	hasRecordedLocalCreation,
	recordForeignMemoryRevision,
	verifiedMemoryCreator,
} from "./memory-creation-provenance.js";
import { type LocalCreationContext, localCreationSourceIds } from "./memory-local-capture.js";
import { retirementAllowsSnapshot } from "./memory-retirement-snapshot-guard.js";
import {
	assertMemoryScopeNotRetired,
	hasMemoryScopeRetirement,
	isMemoryScopeRetired,
} from "./memory-scope-retirement.js";
import { memorySourceNamespace } from "./memory-source-identity.js";
import { readCodememConfigFile } from "./observer-config.js";
import { pairingStillExists } from "./pairing-instance.js";
import { readRetainedPeerProjectFilters } from "./peer-project-filter-retention.js";
import { projectBasename } from "./project.js";
import { isProjectScopeWithdrawn } from "./project-scope-withdrawal.js";
import { clearMemoryRefs, populateMemoryRefs } from "./ref-populate.js";
import { requestReplicationBackfillRecheck } from "./replication-backfill-state.js";
import * as schema from "./schema.js";
import { isScopeDeviceAdmissionRefused } from "./scope-device-admission.js";
import {
	getCachedScopeAuthorization,
	getEffectiveCachedScopeAuthorization,
	getPeerCachedScopeAuthorization,
	type PinnedKeyBinding,
	pinnedKeyBinding,
} from "./scope-membership-cache.js";
import { LEGACY_SHARED_REVIEW_SCOPE_ID } from "./scope-resolution.js";
import { ensureMemoryScopeId } from "./scope-stamping.js";
import { redactMemoryFields, SecretScanner } from "./secret-scanner.js";
import { snapshotSessionExportKeysForMemoryIds } from "./session-export-identity-mutation.js";
import { SyncEntryTooLargeError, syncEntryBytes } from "./sync-entry-size.js";
import { loadRuntimeSigningPublicKey } from "./sync-identity.js";
import {
	ensureSyncTransferActivitySchema,
	recordSyncTransferObservation,
	recordSyncTransferReceipts,
	type SyncTransferObservationSource,
} from "./sync-transfer-activity.js";
import { deriveTags } from "./tags.js";
import type {
	ReplicationOp,
	ReplicationOpsAgePrunePlan,
	ReplicationOpsPruneResult,
	SyncDirtyLocalState,
	SyncMemorySnapshotItem,
} from "./types.js";

export const DEFAULT_SYNC_SCOPE_ID = "local-default";
export const ACCESS_CLEANUP_OP_TYPE = "access_cleanup";
export const REASSIGN_SCOPE_OP_TYPE = "reassign_scope";
export const SCOPED_NULL_BASELINE_BOOTSTRAP_CURSOR_MARKER =
	"__codemem_scoped_null_baseline_bootstrap__";

export interface SyncResetBoundary {
	scope_id?: string | null;
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
	retained_floor_cursor: string | null;
}

export interface SyncResetRequired extends SyncResetBoundary {
	reset_required: true;
	reason:
		| "stale_cursor"
		| "generation_mismatch"
		| "boundary_mismatch"
		| "missing_scope"
		| "scope_inactive"
		| "stale_epoch"
		| "unsupported_scope";
}

/**
 * Serialized bytes of ops or snapshot items one pull page may carry. A relayed
 * exchange on the Durable Object host carries at most 2 MiB, and real memory
 * items average about 5 KB, so a 500-op or 2000-item page by count alone
 * would not fit. This matches the push batch limit. A page always carries at
 * least one entry, so a single larger entry still makes progress.
 */
export const SYNC_PAGE_MAX_BYTES = 1_048_576;

/** One item's page bytes. Throws when the caller's transport cannot carry it at all. */
function snapshotItemBytes(item: SyncMemorySnapshotItem, key: string, limit: number | undefined) {
	const bytes = syncEntryBytes(item);
	if (limit !== undefined && bytes > limit)
		throw new SyncEntryTooLargeError("snapshot_item", key, bytes, limit);
	return bytes;
}

/** Returns how many leading entries fit in `maxBytes` of JSON, at least one. */
function entriesWithinBytes(entries: readonly unknown[], maxBytes: number): number {
	let total = 0;
	for (const [index, entry] of entries.entries()) {
		total += Buffer.byteLength(JSON.stringify(entry)) + 1;
		if (index > 0 && total > maxBytes) return index;
	}
	return entries.length;
}

interface LoadReplicationOpsForPeerBaseOptions {
	since: string | null;
	limit?: number;
	/** Serialized size cap for the returned ops. Defaults to SYNC_PAGE_MAX_BYTES. */
	maxBytes?: number;
	generation?: number | null;
	snapshotId?: string | null;
	baselineCursor?: string | null;
}

export type LoadReplicationOpsForPeerOptions =
	| (LoadReplicationOpsForPeerBaseOptions & {
			deviceId?: string;
			scopeId?: null;
	  })
	| (LoadReplicationOpsForPeerBaseOptions & {
			deviceId: string;
			scopeId: string;
	  });

export type LoadReplicationOpsForPeerResult =
	| {
			reset_required: false;
			boundary: SyncResetBoundary;
			ops: ReplicationOp[];
			nextCursor: string | null;
	  }
	| {
			reset_required: true;
			reset: SyncResetRequired;
	  };

export interface LoadMemorySnapshotPageForPeerOptions {
	/** Direct-source reset lane; the HTTP caller must require its own local device ID. */
	sourceDeviceId?: string;
	limit?: number;
	/** Serialized size cap for the returned items. Defaults to SYNC_PAGE_MAX_BYTES. */
	maxBytes?: number;
	/** Largest single item the caller's transport can carry. Larger items throw SyncEntryTooLargeError. */
	maxEntryBytes?: number;
	pageToken?: string | null;
	peerDeviceId?: string | null;
	scopeId?: string | null;
	generation?: number | null;
	snapshotId?: string | null;
	baselineCursor?: string | null;
}

export interface LoadMemorySnapshotPageForPeerResult {
	boundary: SyncResetBoundary;
	items: SyncMemorySnapshotItem[];
	nextPageToken: string | null;
	hasMore: boolean;
}

type MemoryItemRow = typeof schema.memoryItems.$inferSelect;

interface MemoryPayload {
	session_id: number | null;
	kind: string | null;
	title: string | null;
	subtitle: string | null;
	body_text: string | null;
	confidence: number | null;
	tags_text: string | null;
	active: number | null;
	created_at: string | null;
	updated_at: string | null;
	metadata_json: Record<string, unknown>;
	actor_id: string | null;
	actor_display_name: string | null;
	visibility: string | null;
	workspace_id: string | null;
	workspace_kind: string | null;
	origin_device_id: string | null;
	origin_source: string | null;
	trust_state: string | null;
	narrative: string | null;
	facts: unknown;
	concepts: unknown;
	files_read: unknown;
	files_modified: unknown;
	user_prompt_id: number | null;
	prompt_number: number | null;
	deleted_at: string | null;
	scope_id: string | null;
	// Wire payloads use this as "sender explicitly included deleted_at" so we can
	// distinguish a tombstone clear (`deleted_at: null`) from an omitted field.
	// Row-derived payloads set it from current storage truth instead.
	has_deleted_at: boolean;
	rev: number;
	import_key: string | null;
	project?: string | null;
}

interface AccessCleanupPayload {
	cleanup_scope_id: string | null;
	reason: string | null;
	target_peer_device_id: string | null;
}

export interface ReassignScopePayload {
	operation_id: string;
	memory_id: string;
	old_scope_id: string;
	new_scope_id: string;
	revision: number;
	side: "old" | "new";
}

function requiredPayloadText(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseReassignScopePayload(op: ReplicationOp): ReassignScopePayload {
	if (op.op_type !== REASSIGN_SCOPE_OP_TYPE) throw new Error("reassign_payload_invalid");
	const payload = parsePayload(op.payload_json);
	const operationId = requiredPayloadText(payload?.operation_id);
	const memoryId = requiredPayloadText(payload?.memory_id);
	const oldScopeId = requiredPayloadText(payload?.old_scope_id);
	const newScopeId = requiredPayloadText(payload?.new_scope_id);
	const side = payload?.side;
	const revision = payload?.revision;
	if (
		!operationId ||
		!memoryId ||
		memoryId !== op.entity_id ||
		!oldScopeId ||
		!newScopeId ||
		oldScopeId === newScopeId ||
		(side !== "old" && side !== "new") ||
		!Number.isSafeInteger(revision) ||
		Number(revision) <= 0 ||
		Number(revision) !== op.clock_rev ||
		cleanText(op.scope_id) !== (side === "old" ? oldScopeId : newScopeId) ||
		(side === "new" && cleanText(payload?.scope_id) !== newScopeId)
	) {
		throw new Error("reassign_payload_invalid");
	}
	return {
		operation_id: operationId,
		memory_id: memoryId,
		old_scope_id: oldScopeId,
		new_scope_id: newScopeId,
		revision: Number(revision),
		side,
	};
}

function parseAccessCleanupPayload(op: ReplicationOp): AccessCleanupPayload {
	const payload = parsePayload(op.payload_json);
	return {
		cleanup_scope_id: cleanText(payload?.cleanup_scope_id ?? payload?.scope_id),
		reason: cleanText(payload?.reason),
		target_peer_device_id: cleanText(payload?.target_peer_device_id),
	};
}

/**
 * The op that tells this peer a memory left the local default scope. A peer in
 * the destination scope gets the move itself. Any other peer gets a cleanup
 * notice addressed to it, under its own op id, that removes its copy without
 * naming the destination. The sender of such a move always created the memory,
 * so the peer accepts the notice by the same rule. Other moves are unchanged.
 */
function outboundOldSideMove(
	db: Database,
	op: ReplicationOp,
	peerDeviceId: string | null,
	options: { applyScopeFilter: boolean },
): ReplicationOp {
	const peerId = cleanText(peerDeviceId);
	if (!options.applyScopeFilter || !peerId) return op;
	const move = parseReassignScopePayload(op);
	if (move.side !== "old" || move.old_scope_id !== DEFAULT_SYNC_SCOPE_ID) return op;
	const destination = getPeerCachedScopeAuthorization(db, {
		deviceId: peerId,
		scopeId: move.new_scope_id,
	});
	if (destination.authorized && destination.scope?.authority_type !== "local") return op;
	return {
		...op,
		op_id: `${op.op_id}:cleanup:${peerId}`,
		op_type: ACCESS_CLEANUP_OP_TYPE,
		payload_json: toJson({
			cleanup_scope_id: DEFAULT_SYNC_SCOPE_ID,
			reason: "scope_reassignment",
			target_peer_device_id: peerId,
		}),
	};
}

/**
 * Whether an untargeted cleanup may go to this peer. It names the memory and the
 * scope it left, so a cleanup for a Space goes only to a device with a membership
 * record in that Space, which every device that could have received it there has.
 * A cleanup for the local default scope still goes to every peer: nothing records
 * which devices received a local default memory, the peer's Project filters may
 * have changed since, and the default-scope delete never syncs, so this notice is
 * the only way an old copy is removed. It names no Space.
 * A cleanup addressed to one peer is that peer's own notice and is not limited.
 */
function untargetedCleanupReachesPriorRecipient(
	db: Database,
	op: ReplicationOp,
	peerDeviceId: string | null,
): boolean {
	const cleanup = parseAccessCleanupPayload(op);
	if (cleanup.target_peer_device_id !== null) return true;
	const peerId = cleanText(peerDeviceId);
	if (!peerId || !cleanup.cleanup_scope_id) return false;
	if (cleanup.cleanup_scope_id === DEFAULT_SYNC_SCOPE_ID) return true;
	return (
		db
			.prepare("SELECT 1 FROM scope_memberships WHERE scope_id = ? AND device_id = ? LIMIT 1")
			.get(cleanup.cleanup_scope_id, peerId) !== undefined
	);
}

function accessCleanupSendable(
	db: Database,
	op: ReplicationOp,
	peerDeviceId: string | null,
	options: { applyScopeFilter: boolean },
): boolean {
	if (!accessCleanupTargetsPeer(op, peerDeviceId)) return false;
	return !options.applyScopeFilter || untargetedCleanupReachesPriorRecipient(db, op, peerDeviceId);
}

function accessCleanupTargetsPeer(op: ReplicationOp, peerDeviceId: string | null): boolean {
	const cleanup = parseAccessCleanupPayload(op);
	if (!cleanup.cleanup_scope_id) return false;
	return (
		cleanup.target_peer_device_id === null ||
		cleanup.target_peer_device_id === cleanText(peerDeviceId)
	);
}

function resolveReplicatedTextUpdate(
	nextValue: string | null | undefined,
	currentValue: string | null,
): string {
	if (nextValue == null) return currentValue ?? "";
	return nextValue;
}

function asNumberOrNull(value: unknown): number | null {
	if (value == null) return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function asStringOrNull(value: unknown): string | null {
	if (value == null) return null;
	return String(value);
}

/** Coerce an unknown payload field to `string[] | null` for ref population. */
function asStringArrayOrNull(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const strings = value.filter((v): v is string => typeof v === "string");
	return strings.length > 0 ? strings : null;
}

function parseMemoryPayload(op: ReplicationOp, errors: string[]): MemoryPayload | null {
	if (!op.payload_json) return null;
	let raw: Record<string, unknown>;
	try {
		raw = fromJsonStrict(op.payload_json);
	} catch (err) {
		errors.push(
			`op ${op.op_id}: skipped — payload_json is not a valid object: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
	const metadataRaw = raw.metadata_json;
	const metadata_json =
		metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
			? { ...(metadataRaw as Record<string, unknown>) }
			: {};
	return {
		session_id: asNumberOrNull(raw.session_id),
		kind: asStringOrNull(raw.kind),
		title: asStringOrNull(raw.title),
		subtitle: asStringOrNull(raw.subtitle),
		body_text: asStringOrNull(raw.body_text),
		confidence: asNumberOrNull(raw.confidence),
		tags_text: asStringOrNull(raw.tags_text),
		active: asNumberOrNull(raw.active),
		created_at: asStringOrNull(raw.created_at),
		updated_at: asStringOrNull(raw.updated_at),
		metadata_json,
		actor_id: asStringOrNull(raw.actor_id),
		actor_display_name: asStringOrNull(raw.actor_display_name),
		visibility: asStringOrNull(raw.visibility),
		workspace_id: asStringOrNull(raw.workspace_id),
		workspace_kind: asStringOrNull(raw.workspace_kind),
		origin_device_id: asStringOrNull(raw.origin_device_id),
		origin_source: asStringOrNull(raw.origin_source),
		trust_state: asStringOrNull(raw.trust_state),
		narrative: asStringOrNull(raw.narrative),
		facts: raw.facts ?? null,
		concepts: raw.concepts ?? null,
		files_read: raw.files_read ?? null,
		files_modified: raw.files_modified ?? null,
		user_prompt_id: asNumberOrNull(raw.user_prompt_id),
		prompt_number: asNumberOrNull(raw.prompt_number),
		deleted_at: asStringOrNull(raw.deleted_at),
		scope_id: asStringOrNull(raw.scope_id),
		has_deleted_at: Object.hasOwn(raw, "deleted_at"),
		rev: asNumberOrNull(raw.rev) ?? 0,
		import_key: asStringOrNull(raw.import_key),
		project: asStringOrNull(raw.project),
	};
}

/**
 * Resolve tags_text for a replicated memory: use incoming tags if non-empty,
 * otherwise derive tags from available metadata (kind, title, concepts, files).
 */
function resolveReplicatedTags(payload: MemoryPayload): string {
	const incoming = (payload.tags_text ?? "").trim();
	if (incoming) return incoming;
	const concepts = Array.isArray(payload.concepts) ? payload.concepts.map(String) : [];
	const filesRead = Array.isArray(payload.files_read) ? payload.files_read.map(String) : [];
	const filesModified = Array.isArray(payload.files_modified)
		? payload.files_modified.map(String)
		: [];
	const tags = deriveTags({
		kind: payload.kind ?? "",
		title: payload.title ?? undefined,
		concepts,
		filesRead,
		filesModified,
	});
	return tags.join(" ");
}

function normalizeCursor(value: string | null | undefined): string | null {
	const trimmed = String(value ?? "").trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeSyncStateScopeId(scopeId: string | null | undefined): string {
	const trimmed = String(scopeId ?? "").trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_SYNC_SCOPE_ID;
}

function shouldReturnScopeId(scopeId: string | null | undefined): boolean {
	return scopeId !== undefined;
}

function resetBoundaryFromRow(
	row: {
		generation: number | null;
		snapshot_id: string | null;
		baseline_cursor: string | null;
		retained_floor_cursor: string | null;
	},
	scopeId: string,
	includeScopeId: boolean,
): SyncResetBoundary {
	const boundary: SyncResetBoundary = {
		generation: Number(row.generation ?? 1),
		snapshot_id: String(row.snapshot_id),
		baseline_cursor: normalizeCursor(row.baseline_cursor),
		retained_floor_cursor: normalizeCursor(row.retained_floor_cursor),
	};
	if (includeScopeId) boundary.scope_id = scopeId;
	return boundary;
}

function parseSnapshotPageToken(
	token: string | null | undefined,
): { importKey: string; id: number } | null {
	const raw = normalizeCursor(token);
	if (!raw) return null;
	const idx = raw.lastIndexOf("|");
	if (idx <= 0) return null;
	const importKey = raw.slice(0, idx);
	const id = Number(raw.slice(idx + 1));
	if (!importKey || !Number.isFinite(id)) return null;
	return { importKey, id };
}

function makeSnapshotPageToken(importKey: string, id: number): string {
	return `${importKey}|${id}`;
}

function ensureSyncResetStateTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_reset_state (
			id INTEGER PRIMARY KEY,
			generation INTEGER NOT NULL,
			snapshot_id TEXT NOT NULL,
			baseline_cursor TEXT,
			retained_floor_cursor TEXT,
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_reset_state_v2 (
			scope_id TEXT PRIMARY KEY NOT NULL,
			generation INTEGER NOT NULL,
			snapshot_id TEXT NOT NULL,
			baseline_cursor TEXT,
			retained_floor_cursor TEXT,
			updated_at TEXT NOT NULL
		)
	`);
}

function seedDefaultSyncResetStateFromLegacy(db: Database): void {
	db.exec(`
		INSERT OR IGNORE INTO sync_reset_state_v2
			(scope_id, generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at)
		SELECT '${DEFAULT_SYNC_SCOPE_ID}', generation, snapshot_id, baseline_cursor, retained_floor_cursor, updated_at
		FROM sync_reset_state
		WHERE id = 1
	`);
}

function mirrorDefaultSyncResetStateToLegacy(
	db: Database,
	boundary: SyncResetBoundary,
	updatedAt: string,
): void {
	const d = drizzle(db, { schema });
	d.insert(schema.syncResetState)
		.values({
			id: 1,
			generation: boundary.generation,
			snapshot_id: boundary.snapshot_id,
			baseline_cursor: boundary.baseline_cursor,
			retained_floor_cursor: boundary.retained_floor_cursor,
			updated_at: updatedAt,
		})
		.onConflictDoUpdate({
			target: schema.syncResetState.id,
			set: {
				generation: boundary.generation,
				snapshot_id: boundary.snapshot_id,
				baseline_cursor: boundary.baseline_cursor,
				retained_floor_cursor: boundary.retained_floor_cursor,
				updated_at: updatedAt,
			},
		})
		.run();
}

export function getSyncResetState(db: Database, scopeId?: string | null): SyncResetBoundary {
	ensureSyncResetStateTable(db);
	const effectiveScopeId = normalizeSyncStateScopeId(scopeId);
	const includeScopeId = shouldReturnScopeId(scopeId);
	const d = drizzle(db, { schema });
	const readExisting = () =>
		d
			.select()
			.from(schema.syncResetStateV2)
			.where(eq(schema.syncResetStateV2.scope_id, effectiveScopeId))
			.get();
	let existing = readExisting();
	// Seed only when the row is missing: an INSERT takes the write lock even when it
	// inserts nothing, and status reads call this on every request.
	if (!existing && effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		seedDefaultSyncResetStateFromLegacy(db);
		existing = readExisting();
	}
	if (existing) {
		return resetBoundaryFromRow(existing, effectiveScopeId, includeScopeId);
	}

	const now = new Date().toISOString();
	const created = {
		scope_id: effectiveScopeId,
		generation: 1,
		snapshot_id: randomUUID(),
		baseline_cursor: null,
		retained_floor_cursor: null,
		updated_at: now,
	};
	d.insert(schema.syncResetStateV2).values(created).run();
	const boundary = resetBoundaryFromRow(created, effectiveScopeId, includeScopeId);
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		mirrorDefaultSyncResetStateToLegacy(db, boundary, now);
	}
	return boundary;
}

export function setSyncResetState(
	db: Database,
	updates: Partial<SyncResetBoundary> & { generation?: number },
	scopeId?: string | null,
): SyncResetBoundary {
	const requestedScopeId = scopeId !== undefined ? scopeId : updates.scope_id;
	const effectiveScopeId = normalizeSyncStateScopeId(requestedScopeId);
	const includeScopeId = scopeId !== undefined || updates.scope_id !== undefined;
	const current = getSyncResetState(db, includeScopeId ? effectiveScopeId : undefined);
	const now = new Date().toISOString();
	const next: SyncResetBoundary = {
		generation: updates.generation ?? current.generation,
		snapshot_id: updates.snapshot_id ?? current.snapshot_id,
		baseline_cursor:
			updates.baseline_cursor === undefined
				? current.baseline_cursor
				: normalizeCursor(updates.baseline_cursor),
		retained_floor_cursor:
			updates.retained_floor_cursor === undefined
				? current.retained_floor_cursor
				: normalizeCursor(updates.retained_floor_cursor),
	};
	if (includeScopeId) next.scope_id = effectiveScopeId;
	const d = drizzle(db, { schema });
	d.insert(schema.syncResetStateV2)
		.values({
			scope_id: effectiveScopeId,
			generation: next.generation,
			snapshot_id: next.snapshot_id,
			baseline_cursor: next.baseline_cursor,
			retained_floor_cursor: next.retained_floor_cursor,
			updated_at: now,
		})
		.onConflictDoUpdate({
			target: schema.syncResetStateV2.scope_id,
			set: {
				generation: next.generation,
				snapshot_id: next.snapshot_id,
				baseline_cursor: next.baseline_cursor,
				retained_floor_cursor: next.retained_floor_cursor,
				updated_at: now,
			},
		})
		.run();
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		mirrorDefaultSyncResetStateToLegacy(db, next, now);
	}
	return next;
}

function resetRequired(
	boundary: SyncResetBoundary,
	reason: SyncResetRequired["reason"],
): LoadReplicationOpsForPeerResult {
	return {
		reset_required: true,
		reset: {
			reset_required: true,
			reason,
			...boundary,
		},
	};
}

/**
 * Metadata for an applied foreign revision. When it replaces an existing row's
 * metadata, pass that row so it keeps its import marker.
 */
function foreignRevisionMetadata(
	db: Database,
	op: ReplicationOp,
	metadata: Record<string, unknown> | string | null,
	replaced?: { metadata_json: string | null },
): Record<string, unknown> {
	recordForeignMemoryRevision(db, op.entity_id, "replication");
	const object = typeof metadata === "string" || metadata === null ? fromJson(metadata) : metadata;
	return keepImportMarker(
		{ ...object, clock_device_id: op.clock_device_id },
		replaced?.metadata_json,
	);
}

export function clockDeviceIdFromMetadataJson(raw: string | null): string {
	const metadata = fromJson(raw);
	return typeof metadata.clock_device_id === "string" ? metadata.clock_device_id : "";
}

// Op chunking

/**
 * Split replication ops into batches that fit within a byte-size limit.
 *
 * Each batch is serialized as `{"ops": [...]}` and must not exceed maxBytes
 * when UTF-8 encoded. Throws if a single op exceeds the limit.
 */
export function chunkOpsBySize(ops: ReplicationOp[], maxBytes: number): ReplicationOp[][] {
	const encoder = new TextEncoder();
	// Overhead: {"ops":[]} = 9 bytes, comma between elements = 1 byte
	const WRAPPER_OVERHEAD = 9;
	const COMMA_OVERHEAD = 1;

	const batches: ReplicationOp[][] = [];
	let current: ReplicationOp[] = [];
	let currentBytes = WRAPPER_OVERHEAD;

	for (const op of ops) {
		const opBytes = encoder.encode(JSON.stringify(op)).byteLength;
		const addedBytes = current.length === 0 ? opBytes : opBytes + COMMA_OVERHEAD;

		if (currentBytes + addedBytes <= maxBytes) {
			current.push(op);
			currentBytes += addedBytes;
			continue;
		}
		if (current.length === 0) {
			throw new Error("single op exceeds size limit");
		}
		batches.push(current);
		current = [op];
		currentBytes = WRAPPER_OVERHEAD + opBytes;
		if (currentBytes > maxBytes) {
			throw new Error("single op exceeds size limit");
		}
	}
	if (current.length > 0) {
		batches.push(current);
	}
	return batches;
}

// Cursor read/write

function ensureReplicationCursorTables(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS replication_cursors (
			peer_device_id TEXT PRIMARY KEY,
			last_applied_cursor TEXT,
			last_acked_cursor TEXT,
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS replication_cursors_v2 (
			peer_device_id TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			last_applied_cursor TEXT,
			last_acked_cursor TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (peer_device_id, scope_id)
		);
		CREATE INDEX IF NOT EXISTS idx_replication_cursors_v2_scope
			ON replication_cursors_v2(scope_id)
	`);
}

function seedDefaultReplicationCursorFromLegacy(db: Database): void {
	db.exec(`
		INSERT OR IGNORE INTO replication_cursors_v2
			(peer_device_id, scope_id, last_applied_cursor, last_acked_cursor, updated_at)
		SELECT peer_device_id, '${DEFAULT_SYNC_SCOPE_ID}', last_applied_cursor, last_acked_cursor, updated_at
		FROM replication_cursors
	`);
}

/*
 * A sync pass writes its position after network I/O, and the peer can be removed
 * meanwhile. Each write therefore requires the pairing in the same statement, so a
 * pass that outlives its pairing cannot put sync progress back.
 */
interface ReplicationCursorWrite {
	lastApplied?: string | null;
	lastAcked?: string | null;
	/**
	 * The pairing instance the pass started under. When set, the write also requires it, so a
	 * late write cannot reach a pairing that was deleted and created again.
	 */
	pairingInstanceId?: string | null;
}

function mirrorDefaultReplicationCursorToLegacy(
	db: Database,
	peerDeviceId: string,
	options: ReplicationCursorWrite,
	updatedAt: string,
): void {
	const pairing = pairingStillExists(peerDeviceId, options.pairingInstanceId);
	db.prepare(
		`INSERT INTO replication_cursors
			(peer_device_id, last_applied_cursor, last_acked_cursor, updated_at)
		 SELECT ?, ?, ?, ? WHERE ${pairing.sql}
		 ON CONFLICT(peer_device_id) DO UPDATE SET
			last_applied_cursor = COALESCE(excluded.last_applied_cursor, last_applied_cursor),
			last_acked_cursor = COALESCE(excluded.last_acked_cursor, last_acked_cursor),
			updated_at = excluded.updated_at`,
	).run(
		peerDeviceId,
		options.lastApplied ?? null,
		options.lastAcked ?? null,
		updatedAt,
		...pairing.params,
	);
}

/**
 * Read the replication cursor for a peer device.
 *
 * Returns `[lastApplied, lastAcked]` — both null when no cursor exists.
 */
export function getReplicationCursor(
	db: Database,
	peerDeviceId: string,
	scopeId?: string | null,
): [lastApplied: string | null, lastAcked: string | null] {
	ensureReplicationCursorTables(db);
	const effectiveScopeId = normalizeSyncStateScopeId(scopeId);
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		seedDefaultReplicationCursorFromLegacy(db);
	}
	const d = drizzle(db, { schema });
	const row = d
		.select({
			last_applied_cursor: schema.replicationCursorsV2.last_applied_cursor,
			last_acked_cursor: schema.replicationCursorsV2.last_acked_cursor,
		})
		.from(schema.replicationCursorsV2)
		.where(
			and(
				eq(schema.replicationCursorsV2.peer_device_id, peerDeviceId),
				eq(schema.replicationCursorsV2.scope_id, effectiveScopeId),
			),
		)
		.get();

	if (!row) return [null, null];
	return [row.last_applied_cursor, row.last_acked_cursor];
}

/**
 * Insert or update the replication cursor for a paired peer device. Writes
 * nothing when the peer has no pairing, which is not an error for the caller.
 *
 * Uses COALESCE on update so callers can set only one of the two cursors
 * without clobbering the other.
 */
export function setReplicationCursor(
	db: Database,
	peerDeviceId: string,
	options: ReplicationCursorWrite = {},
	scopeId?: string | null,
): void {
	ensureReplicationCursorTables(db);
	const now = new Date().toISOString();
	const effectiveScopeId = normalizeSyncStateScopeId(scopeId);
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		seedDefaultReplicationCursorFromLegacy(db);
	}
	const pairing = pairingStillExists(peerDeviceId, options.pairingInstanceId);
	// One statement: no gap between the pairing check and the write, and no race
	// between concurrent sync workers. COALESCE keeps the cursor a caller left unset.
	db.prepare(
		`INSERT INTO replication_cursors_v2
			(peer_device_id, scope_id, last_applied_cursor, last_acked_cursor, updated_at)
		 SELECT ?, ?, ?, ?, ? WHERE ${pairing.sql}
		 ON CONFLICT(peer_device_id, scope_id) DO UPDATE SET
			last_applied_cursor = COALESCE(excluded.last_applied_cursor, last_applied_cursor),
			last_acked_cursor = COALESCE(excluded.last_acked_cursor, last_acked_cursor),
			updated_at = excluded.updated_at`,
	).run(
		peerDeviceId,
		effectiveScopeId,
		options.lastApplied ?? null,
		options.lastAcked ?? null,
		now,
		...pairing.params,
	);
	if (effectiveScopeId === DEFAULT_SYNC_SCOPE_ID) {
		mirrorDefaultReplicationCursorToLegacy(db, peerDeviceId, options, now);
	}
}

/**
 * Clears the inbound and acknowledged positions for one scope. With `pairingInstanceId` it
 * clears them only in the pairing the caller started under, so a reset that arrives late,
 * after Unpair and a new pairing, cannot erase the new pairing's progress.
 */
export function clearReplicationCursorLastApplied(
	db: Database,
	peerDeviceId: string,
	scopeId?: string | null,
	pairingInstanceId?: string | null,
): void {
	ensureReplicationCursorTables(db);
	const now = new Date().toISOString();
	const effectiveScopeId = normalizeSyncStateScopeId(scopeId);
	if (pairingInstanceId) {
		const pairing = pairingStillExists(peerDeviceId, pairingInstanceId);
		db.prepare(
			`UPDATE replication_cursors_v2
			 SET last_applied_cursor = NULL, last_acked_cursor = NULL, updated_at = ?
			 WHERE peer_device_id = ? AND scope_id = ? AND ${pairing.sql}`,
		).run(now, peerDeviceId, effectiveScopeId, ...pairing.params);
		return;
	}
	drizzle(db, { schema })
		.update(schema.replicationCursorsV2)
		.set({
			last_applied_cursor: null,
			last_acked_cursor: null,
			updated_at: now,
		})
		.where(
			and(
				eq(schema.replicationCursorsV2.peer_device_id, peerDeviceId),
				eq(schema.replicationCursorsV2.scope_id, effectiveScopeId),
			),
		)
		.run();
}

// Payload extraction

/**
 * Extract replication ops from a parsed JSON payload.
 *
 * Returns an empty array if the payload is not an object or lacks an `ops` array.
 */
/** Required fields for a valid replication op. */
const REQUIRED_OP_FIELDS = [
	"op_id",
	"entity_type",
	"entity_id",
	"op_type",
	"clock_rev",
	"clock_updated_at",
	"clock_device_id",
	"device_id",
	"created_at",
] as const;

/**
 * Extract and validate replication ops from a parsed JSON payload.
 *
 * Returns an empty array if the payload is not an object or lacks an `ops` array.
 * Silently filters out ops missing required fields to prevent garbage data
 * from entering the replication pipeline.
 */
export function extractReplicationOps(payload: unknown): ReplicationOp[] {
	if (typeof payload !== "object" || payload === null) return [];
	const obj = payload as Record<string, unknown>;
	const ops = obj.ops;
	if (!Array.isArray(ops)) return [];

	return ops.filter((op): op is ReplicationOp => {
		if (typeof op !== "object" || op === null) return false;
		const record = op as Record<string, unknown>;
		return REQUIRED_OP_FIELDS.every(
			(field) => record[field] !== undefined && record[field] !== null,
		);
	});
}

// Clock comparison

/**
 * Build a clock tuple from individual fields.
 *
 * Clock tuples enable lexicographic comparison for last-writer-wins
 * conflict resolution: higher rev wins, tiebreak on updated_at, then device_id.
 */
export function clockTuple(
	rev: number,
	updatedAt: string,
	deviceId: string,
): [number, string, string] {
	return [rev, updatedAt, deviceId];
}

/**
 * Return true if `candidate` clock is strictly newer than `existing`.
 *
 * Comparison order: rev (higher wins) → updated_at → device_id.
 * Mirrors Python's `_is_newer_clock` which relies on tuple ordering.
 */
export function isNewerClock(
	candidate: [number, string, string],
	existing: [number, string, string],
): boolean {
	if (candidate[0] !== existing[0]) return candidate[0] > existing[0];
	if (candidate[1] !== existing[1]) return candidate[1] > existing[1];
	return candidate[2] > existing[2];
}

// Record a replication op

/**
 * The content an op carries for a memory row: the whole row as it is, with its
 * session's Project and the scope it is sent in. Recording an op and sending one
 * both build it here, so an op on the wire always shows the row as it is then.
 */
function opPayloadFromRow(
	row: MemoryItemRow,
	sessionProject: string | null,
	scopeId: string | null,
): Record<string, unknown> {
	// Parse JSON-string columns so they round-trip as objects, not double-encoded strings
	const parseSqliteJson = (val: string | null | undefined): unknown => {
		if (typeof val !== "string") return val ?? null;
		try {
			return JSON.parse(val);
		} catch {
			return val;
		}
	};
	return {
		project: sessionProject,
		session_id: row.session_id,
		kind: row.kind,
		title: row.title,
		subtitle: row.subtitle,
		body_text: row.body_text,
		confidence: row.confidence,
		tags_text: row.tags_text,
		active: row.active,
		created_at: row.created_at,
		updated_at: row.updated_at,
		metadata_json: parseSqliteJson(row.metadata_json),
		actor_id: row.actor_id,
		actor_display_name: row.actor_display_name,
		visibility: row.visibility,
		workspace_id: row.workspace_id,
		workspace_kind: row.workspace_kind,
		origin_device_id: row.origin_device_id,
		origin_source: row.origin_source,
		trust_state: row.trust_state,
		facts: parseSqliteJson(row.facts),
		narrative: row.narrative,
		concepts: parseSqliteJson(row.concepts),
		files_read: parseSqliteJson(row.files_read),
		files_modified: parseSqliteJson(row.files_modified),
		user_prompt_id: row.user_prompt_id,
		prompt_number: row.prompt_number,
		deleted_at: row.deleted_at,
		scope_id: scopeId,
	};
}

/**
 * Generate and INSERT a single replication op for a memory item.
 *
 * Reads the memory item's clock fields (rev, updated_at, metadata_json)
 * from the DB, builds the op row, and inserts into `replication_ops`.
 * Returns the generated op_id (UUID).
 *
 * Uses Drizzle's typed select so all memory_items columns are captured
 * automatically — no hand-maintained column list to go out of sync.
 */
export function recordReplicationOp(
	db: Database,
	opts: Parameters<typeof insertReplicationOp>[1],
): string {
	const opId = insertReplicationOp(db, opts);
	recordOpCopy(db, opId, opts.memoryId);
	return opId;
}

/** Inserts the op row; recordReplicationOp also records the copy it was built from. */
function insertReplicationOp(
	db: Database,
	opts: {
		memoryId: number;
		opType: "upsert" | "delete";
		deviceId: string;
		payload?: Record<string, unknown>;
		scopeId?: string | null;
		clockRev?: number;
		clockUpdatedAt?: string;
		clockDeviceId?: string;
		createdAt?: string;
		opId?: string;
	},
): string {
	const d = drizzle(db, { schema });
	const opId = opts.opId ?? randomUUID();
	const now = opts.createdAt ?? new Date().toISOString();

	// Read the full memory row — typed via Drizzle schema
	const row = d
		.select()
		.from(schema.memoryItems)
		.where(eq(schema.memoryItems.id, opts.memoryId))
		.get();

	const rev = opts.clockRev ?? Number(row?.rev ?? 0);
	const updatedAt = opts.clockUpdatedAt ?? row?.updated_at ?? now;
	const entityId = row?.import_key ?? String(opts.memoryId);
	const metadata = fromJson(row?.metadata_json);
	// Backfill missing memory scope before emitting an op so storage, op row,
	// and payload all carry the same authoritative local scope.
	const scopeId =
		opts.scopeId !== undefined ? opts.scopeId : row ? ensureMemoryScopeId(db, opts.memoryId) : null;
	const clockDeviceId =
		typeof opts.clockDeviceId === "string" && opts.clockDeviceId.trim().length > 0
			? opts.clockDeviceId.trim()
			: typeof metadata.clock_device_id === "string" && metadata.clock_device_id.trim().length > 0
				? metadata.clock_device_id
				: opts.deviceId;

	// Resolve session project so peers can reconstruct the project association.
	const sessionProject = row?.session_id
		? (d
				.select({ project: schema.sessions.project })
				.from(schema.sessions)
				.where(eq(schema.sessions.id, row.session_id))
				.get()?.project ?? null)
		: null;

	// Build payload from the memory row so peers can reconstruct the full item.
	// Explicit payload override wins except for authoritative scope_id on upserts.
	let payloadJson: string | null;
	if (opts.payload) {
		payloadJson = toJson(
			row && opts.opType === "upsert" ? { ...opts.payload, scope_id: scopeId } : opts.payload,
		);
	} else if (row && opts.opType === "upsert") {
		payloadJson = toJson(opPayloadFromRow(row, sessionProject, scopeId));
	} else {
		payloadJson = null;
	}

	d.insert(schema.replicationOps)
		.values({
			op_id: opId,
			entity_type: "memory_item",
			entity_id: entityId,
			op_type: opts.opType,
			payload_json: payloadJson,
			clock_rev: rev,
			clock_updated_at: updatedAt,
			clock_device_id: clockDeviceId,
			device_id: opts.deviceId,
			created_at: now,
			scope_id: scopeId,
		})
		.run();

	return opId;
}

function deterministicReassignOpId(
	operationId: string,
	memoryId: string,
	oldScopeId: string,
	newScopeId: string,
	side: "old" | "new",
): string {
	return `reassign_${createHash("sha256")
		.update(JSON.stringify([operationId, memoryId, oldScopeId, newScopeId, side]))
		.digest("hex")}`;
}

function reassignmentEntityId(existing: MemoryItemRow): string {
	return existing.import_key ?? String(existing.id);
}

function writeUnretiredReassignment(
	db: Database,
	entityId: string,
	scopeId: string,
	write: () => void,
): void {
	db.transaction(() => {
		assertMemoryScopeNotRetired(db, entityId, scopeId);
		write();
	}).immediate();
}

/** A reassigned memory's metadata: the new clock and scope, and the reassignment that moved it. */
function reassignedMetadata(
	metadataJson: string | null,
	input: {
		deviceId: string;
		operationId: string;
		oldScopeId: string;
		newScopeId: string;
		revision: number;
	},
): Record<string, unknown> {
	const metadata = fromJson(metadataJson);
	Object.assign(metadata, { clock_device_id: input.deviceId, scope_id: input.newScopeId });
	metadata.last_scope_reassignment = {
		operation_id: input.operationId,
		old_scope_id: input.oldScopeId,
		new_scope_id: input.newScopeId,
		revision: input.revision,
	};
	return metadata;
}

export interface RecordScopeReassignmentInput {
	operationId: string;
	memoryId: number;
	oldScopeId: string;
	newScopeId: string;
	deviceId: string;
	createdAt?: string;
	/**
	 * Record `deviceId` as the origin of a memory this device wrote before it had
	 * a sync identity, in the same write. See `claimLocalOrigin`.
	 */
	claimLocalOrigin?: boolean;
}

export function recordScopeReassignment(
	db: Database,
	opts: RecordScopeReassignmentInput,
): { revision: number; oldOpId: string; newOpId: string } {
	const operationId = requiredPayloadText(opts.operationId);
	const oldScopeId = requiredPayloadText(opts.oldScopeId);
	const newScopeId = requiredPayloadText(opts.newScopeId);
	const deviceId = requiredPayloadText(opts.deviceId);
	if (
		!operationId ||
		!oldScopeId ||
		!newScopeId ||
		oldScopeId === newScopeId ||
		!deviceId ||
		!Number.isSafeInteger(opts.memoryId) ||
		opts.memoryId <= 0
	) {
		throw new Error("reassign_input_invalid");
	}
	const d = drizzle(db, { schema });
	const existing = d
		.select()
		.from(schema.memoryItems)
		.where(eq(schema.memoryItems.id, opts.memoryId))
		.get();
	if (!existing) throw new Error("reassign_memory_not_found");
	const memoryId = reassignmentEntityId(existing);
	const oldOpId = deterministicReassignOpId(operationId, memoryId, oldScopeId, newScopeId, "old");
	const newOpId = deterministicReassignOpId(operationId, memoryId, oldScopeId, newScopeId, "new");
	const existingOps = db
		.prepare("SELECT op_id, clock_rev FROM replication_ops WHERE op_id IN (?, ?)")
		.all(oldOpId, newOpId) as Array<{ op_id: string; clock_rev: number }>;
	if (existingOps.length > 0) {
		if (
			existingOps.length !== 2 ||
			existingOps.some((op) => op.clock_rev !== existingOps[0]?.clock_rev)
		) {
			throw new Error("reassign_replay_conflict");
		}
		return { revision: Number(existingOps[0]?.clock_rev ?? 0), oldOpId, newOpId };
	}
	if ((cleanText(existing.scope_id) ?? DEFAULT_SYNC_SCOPE_ID) !== oldScopeId) {
		throw new Error("reassign_old_scope_mismatch");
	}
	const revision = Number(existing.rev ?? 0) + 1;
	const createdAt = opts.createdAt ?? new Date().toISOString();
	const metadata = reassignedMetadata(existing.metadata_json, {
		deviceId,
		operationId,
		oldScopeId,
		newScopeId,
		revision,
	});
	const common = {
		operation_id: operationId,
		memory_id: memoryId,
		old_scope_id: oldScopeId,
		new_scope_id: newScopeId,
		revision,
	};
	const write = db.transaction(() => {
		if (opts.claimLocalOrigin) claimLocalOrigin(db, opts.memoryId, deviceId);
		d.update(schema.memoryItems)
			.set({
				scope_id: newScopeId,
				rev: revision,
				updated_at: createdAt,
				metadata_json: toJson(metadata),
			})
			.where(eq(schema.memoryItems.id, opts.memoryId))
			.run();
		const updated = d
			.select()
			.from(schema.memoryItems)
			.where(eq(schema.memoryItems.id, opts.memoryId))
			.get();
		if (!updated) throw new Error("reassign_memory_not_found");
		const sessionProject = updated.session_id
			? cleanText(
					db.prepare("SELECT project FROM sessions WHERE id = ?").pluck().get(updated.session_id),
				)
			: null;
		const insert = db.prepare(`INSERT INTO replication_ops(
			op_id, entity_type, entity_id, op_type, payload_json, clock_rev,
			clock_updated_at, clock_device_id, device_id, created_at, scope_id
		) VALUES (?, 'memory_item', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const newSide = {
			...buildPayloadFromMemoryRow(updated),
			project: cleanText(updated.project) ?? sessionProject,
			...common,
			side: "new",
			scope_id: newScopeId,
		};
		for (const [opId, payload, scopeId] of [
			[oldOpId, { ...common, side: "old" }, oldScopeId],
			[newOpId, newSide, newScopeId],
		] as const) {
			insert.run(
				opId,
				memoryId,
				REASSIGN_SCOPE_OP_TYPE,
				toJson(payload),
				revision,
				createdAt,
				deviceId,
				deviceId,
				createdAt,
				scopeId,
			);
			recordOpCopy(db, opId, opts.memoryId);
		}
	});
	writeUnretiredReassignment(db, memoryId, newScopeId, write);
	return { revision, oldOpId, newOpId };
}

export function recordAccessCleanupOp(
	db: Database,
	opts: {
		importKey: string;
		deviceId: string;
		cleanupScopeId: string;
		clockRev: number;
		clockUpdatedAt: string;
		clockDeviceId?: string;
		createdAt?: string;
		targetPeerDeviceId?: string | null;
		reason?: string | null;
		opId?: string;
	},
): string {
	const d = drizzle(db, { schema });
	const opId = opts.opId ?? randomUUID();
	const now = opts.createdAt ?? new Date().toISOString();
	const payload = {
		cleanup_scope_id: opts.cleanupScopeId,
		reason: cleanText(opts.reason) ?? "scope_access_cleanup",
		...(cleanText(opts.targetPeerDeviceId)
			? { target_peer_device_id: cleanText(opts.targetPeerDeviceId) }
			: {}),
	};
	d.insert(schema.replicationOps)
		.values({
			op_id: opId,
			entity_type: "memory_item",
			entity_id: opts.importKey,
			op_type: ACCESS_CLEANUP_OP_TYPE,
			payload_json: toJson(payload),
			clock_rev: opts.clockRev,
			clock_updated_at: opts.clockUpdatedAt,
			clock_device_id: opts.clockDeviceId ?? opts.deviceId,
			device_id: opts.deviceId,
			created_at: now,
			scope_id: DEFAULT_SYNC_SCOPE_ID,
		})
		.run();
	return opId;
}

// Load replication ops with cursor pagination

/** Parse a `created_at|op_id` cursor into its two components. */
function parseCursor(cursor: string): [createdAt: string, opId: string] | null {
	const idx = cursor.indexOf("|");
	if (idx < 0) return null;
	return [cursor.slice(0, idx), cursor.slice(idx + 1)];
}

/** Build a `created_at|op_id` cursor string. */
function computeCursor(createdAt: string, opId: string): string {
	return `${createdAt}|${opId}`;
}

/**
 * Load replication ops created after `cursor`, ordered by (created_at, op_id).
 *
 * Returns `[ops, nextCursor]` where nextCursor is the cursor for the last
 * returned row (or null if no rows matched). The cursor format is
 * `created_at|op_id`.
 */
export function loadReplicationOpsSince(
	db: Database,
	cursor: string | null,
	limit = 100,
	deviceId?: string,
	scopeId?: string | null,
): [ReplicationOp[], string | null] {
	const d = drizzle(db, { schema });
	const t = schema.replicationOps;
	const conditions = [];
	const scopeFilterRequested = scopeId !== undefined;
	const effectiveScopeId = normalizeSyncStateScopeId(scopeId);

	if (cursor) {
		const parsed = parseCursor(cursor);
		if (parsed) {
			const [createdAt, opId] = parsed;
			conditions.push(
				or(gt(t.created_at, createdAt), and(eq(t.created_at, createdAt), gt(t.op_id, opId))),
			);
		}
	}

	if (deviceId) {
		conditions.push(
			or(and(eq(t.device_id, deviceId), eq(t.clock_device_id, deviceId)), eq(t.device_id, "local")),
		);
	}

	if (scopeFilterRequested) {
		conditions.push(
			effectiveScopeId === DEFAULT_SYNC_SCOPE_ID
				? or(isNull(t.scope_id), eq(t.scope_id, DEFAULT_SYNC_SCOPE_ID))
				: eq(t.scope_id, effectiveScopeId),
		);
	}

	const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

	const rows = d
		.select()
		.from(t)
		.where(whereClause)
		.orderBy(t.created_at, t.op_id)
		.limit(limit)
		.all();

	const ops: ReplicationOp[] = rows.map((r) => ({
		op_id: r.op_id,
		entity_type: r.entity_type,
		entity_id: r.entity_id,
		op_type: r.op_type,
		payload_json: r.payload_json,
		clock_rev: r.clock_rev,
		clock_updated_at: r.clock_updated_at,
		clock_device_id: r.clock_device_id,
		device_id: r.device_id,
		created_at: r.created_at,
		scope_id: r.scope_id,
	}));

	let nextCursor: string | null = null;
	if (rows.length > 0) {
		const last = rows.at(-1);
		if (last) {
			nextCursor = computeCursor(last.created_at, last.op_id);
		}
	}

	return [ops, nextCursor];
}

/**
 * Trims a pull page to the byte cap. The next page starts after the last op
 * returned, so ops filtered out after it are scanned and filtered again.
 */
function opsPageWithinBytes(
	ops: ReplicationOp[],
	nextCursor: string | null,
	maxBytes = SYNC_PAGE_MAX_BYTES,
): { ops: ReplicationOp[]; nextCursor: string | null } {
	const kept = entriesWithinBytes(ops, maxBytes);
	const last = ops[kept - 1];
	if (kept === ops.length || !last) return { ops, nextCursor };
	return { ops: ops.slice(0, kept), nextCursor: computeCursor(last.created_at, last.op_id) };
}

export function loadReplicationOpsForPeer(
	db: Database,
	options: LoadReplicationOpsForPeerOptions,
): LoadReplicationOpsForPeerResult {
	const scopeFilterRequested = options.scopeId !== undefined;
	const effectiveScopeId = normalizeSyncStateScopeId(options.scopeId);
	const boundary = getSyncResetState(db, scopeFilterRequested ? options.scopeId : undefined);
	const since = normalizeCursor(options.since);
	const requestedGeneration = options.generation ?? null;
	const requestedSnapshotId = normalizeCursor(options.snapshotId);
	const requestedBaselineCursor = normalizeCursor(options.baselineCursor);
	const hasAnyBoundaryField =
		requestedGeneration != null || requestedSnapshotId != null || requestedBaselineCursor != null;

	if (requestedGeneration != null && requestedGeneration !== boundary.generation) {
		return resetRequired(boundary, "generation_mismatch");
	}

	const hasCompleteBoundary =
		requestedGeneration != null &&
		requestedSnapshotId != null &&
		requestedBaselineCursor === boundary.baseline_cursor;

	if (!hasAnyBoundaryField || !hasCompleteBoundary) {
		return resetRequired(boundary, "boundary_mismatch");
	}

	if (
		requestedSnapshotId !== boundary.snapshot_id ||
		requestedBaselineCursor !== boundary.baseline_cursor
	) {
		return resetRequired(boundary, "boundary_mismatch");
	}

	if (
		since != null &&
		boundary.retained_floor_cursor != null &&
		since < boundary.retained_floor_cursor
	) {
		return resetRequired(boundary, "stale_cursor");
	}

	const [ops, nextCursor] = loadReplicationOpsSince(
		db,
		since,
		options.limit,
		// `/v1/ops` is an author stream, not a Space relay. Even when a
		// scoped request filters by `scope_id`, this keeps returned ops authored
		// by the serving device (plus legacy `local` rows) so receivers can keep
		// rejecting batches whose device_id / clock_device_id do not match the
		// authenticated peer.
		options.deviceId,
		effectiveScopeId,
	);
	const peerBoundaryOps = ops.filter((op) => {
		if (op.entity_type !== "memory_item") return true;
		if (retirementBlocksMemoryOp(db, op)) return false;
		if (op.op_type === ACCESS_CLEANUP_OP_TYPE || op.op_type === REASSIGN_SCOPE_OP_TYPE) {
			return true;
		}
		const scopeId = cleanText(op.scope_id);
		return Boolean(scopeId && scopeId !== DEFAULT_SYNC_SCOPE_ID);
	});
	const page = opsPageWithinBytes(peerBoundaryOps, nextCursor, options.maxBytes);
	return { reset_required: false, boundary, ...page };
}

function snapshotClockDeviceId(payload: MemoryPayload, row: MemoryItemRow): string {
	const metadata = payload.metadata_json;
	if (typeof metadata?.clock_device_id === "string" && metadata.clock_device_id.trim())
		return metadata.clock_device_id.trim();
	return String(row.origin_device_id ?? "local");
}

function unretiredSnapshotPayload(
	db: Database,
	row: MemoryItemRow,
	sourceDeviceId?: string,
): MemoryPayload | null {
	if (sourceDeviceId && memorySourceNamespace(row.import_key ?? "") !== sourceDeviceId) return null;
	const payload = buildPayloadFromMemoryRow(row);
	if (
		!retirementAllowsSnapshot(
			db,
			String(row.import_key ?? ""),
			payload as unknown as Record<string, unknown>,
			cleanText(row.scope_id),
		)
	)
		return null;
	return payload;
}

type SnapshotRow = { memory: MemoryItemRow; sessionProject: string | null };

/** A snapshot upsert names the session project, so receivers file it under the right Project. */
function snapshotUpsertPayload(payload: MemoryPayload, row: SnapshotRow): Record<string, unknown> {
	return { ...payload, project: row.sessionProject ?? null };
}

/**
 * A deleted memory's snapshot item names it, its scope, its origin and when it
 * was deleted, and none of its content. The item's clock fields carry its revision.
 */
function snapshotDeletionPayload(payload: MemoryPayload): Record<string, unknown> {
	return {
		scope_id: payload.scope_id,
		origin_device_id: payload.origin_device_id,
		active: 0,
		deleted_at: payload.deleted_at,
		has_deleted_at: payload.deleted_at != null,
	};
}

/** The snapshot item for one memory row, or null when the peer may not receive it. */
function snapshotItemForPeer(
	db: Database,
	row: SnapshotRow,
	importKey: string,
	options: LoadMemorySnapshotPageForPeerOptions,
): SyncMemorySnapshotItem | null {
	const payload = unretiredSnapshotPayload(db, row.memory, options.sourceDeviceId);
	if (!payload) return null;
	const copy = {
		payload: payload as unknown as Record<string, unknown>,
		project: row.sessionProject,
		scopeId: cleanText(row.memory.scope_id),
	};
	if (storedCopyRefusal(db, copy, options.peerDeviceId ?? null)) return null;
	const deleted = Boolean(row.memory.deleted_at) || row.memory.active === 0;
	return {
		entity_id: importKey,
		op_type: deleted ? "delete" : "upsert",
		payload_json: toJson(
			deleted ? snapshotDeletionPayload(payload) : snapshotUpsertPayload(payload, row),
		),
		clock_rev: Number(row.memory.rev ?? 0),
		clock_updated_at: String(
			row.memory.updated_at ?? row.memory.created_at ?? new Date().toISOString(),
		),
		clock_device_id: snapshotClockDeviceId(payload, row.memory),
	};
}

export function loadMemorySnapshotPageForPeer(
	db: Database,
	options: LoadMemorySnapshotPageForPeerOptions,
): LoadMemorySnapshotPageForPeerResult {
	const scopeFilterRequested = options.scopeId !== undefined;
	const effectiveScopeId = normalizeSyncStateScopeId(options.scopeId);
	const boundary = getSyncResetState(db, scopeFilterRequested ? options.scopeId : undefined);
	if (scopeFilterRequested) {
		const scope = db
			.prepare("SELECT authority_type FROM replication_scopes WHERE scope_id = ? LIMIT 1")
			.get(effectiveScopeId) as { authority_type?: string | null } | undefined;
		if (scope?.authority_type === "local") {
			return { boundary, items: [], nextPageToken: null, hasMore: false };
		}
	}
	if (options.generation !== boundary.generation) {
		throw new Error("generation_mismatch");
	}
	if (normalizeCursor(options.snapshotId) !== boundary.snapshot_id) {
		throw new Error("boundary_mismatch");
	}
	if (normalizeCursor(options.baselineCursor) !== boundary.baseline_cursor) {
		throw new Error("boundary_mismatch");
	}
	const peerDeviceId = cleanText(options.peerDeviceId);
	if (scopeFilterRequested && snapshotScopeBlocked(db, effectiveScopeId, peerDeviceId)) {
		return { boundary, items: [], nextPageToken: null, hasMore: false };
	}

	// Cap raised to 5000 to support elevated bootstrap page sizes (default 2000).
	const limit = Math.max(1, Math.min(options.limit ?? 200, 5000));
	const pageToken = parseSnapshotPageToken(options.pageToken);
	const d = drizzle(db, { schema });
	// Scan batch must be >= limit so high page sizes don't degrade into
	// multiple keyset-pagination round-trips per page.
	const scanBatchSize = Math.max(limit, Math.min(limit * 3, 10000));
	const rowsAfterToken = (token: { importKey: string; id: number } | null, batchLimit: number) =>
		d
			.select({
				memory: schema.memoryItems,
				sessionProject: schema.sessions.project,
			})
			.from(schema.memoryItems)
			.innerJoin(schema.sessions, eq(schema.sessions.id, schema.memoryItems.session_id))
			.where(
				and(
					isNotNull(schema.memoryItems.import_key),
					effectiveScopeId === DEFAULT_SYNC_SCOPE_ID
						? sql`0 = 1`
						: eq(schema.memoryItems.scope_id, effectiveScopeId),
					token
						? or(
								gt(schema.memoryItems.import_key, token.importKey),
								and(
									eq(schema.memoryItems.import_key, token.importKey),
									gt(schema.memoryItems.id, token.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(schema.memoryItems.import_key, schema.memoryItems.id)
			.limit(batchLimit)
			.all();

	const items: SyncMemorySnapshotItem[] = [];
	const maxBytes = options.maxBytes ?? SYNC_PAGE_MAX_BYTES;
	let pageBytes = 0;
	let nextScanToken = pageToken;
	let lastScannedToken: string | null = null;
	let hasMore = false;
	let full = false;

	while (items.length < limit && !full) {
		const rows = rowsAfterToken(nextScanToken, scanBatchSize);
		if (rows.length === 0) break;

		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index];
			if (!row) continue;
			const importKey = String(row.memory.import_key ?? "").trim();
			if (!importKey) continue;
			// An earlier row is always on the page when this is used, so it is never null then.
			const tokenBeforeRow: string | null = lastScannedToken;
			lastScannedToken = makeSnapshotPageToken(importKey, Number(row.memory.id));
			nextScanToken = { importKey, id: Number(row.memory.id) };
			const item = snapshotItemForPeer(db, row, importKey, options);
			if (!item) continue;
			const itemBytes = snapshotItemBytes(item, importKey, options.maxEntryBytes);
			if (items.length > 0 && pageBytes + itemBytes > maxBytes) {
				// This row goes on the next page, so the token stops before it.
				lastScannedToken = tokenBeforeRow;
				hasMore = true;
				full = true;
				break;
			}
			items.push(item);
			pageBytes += itemBytes;

			if (items.length >= limit) {
				hasMore = index < rows.length - 1 || rowsAfterToken(nextScanToken, 1).length > 0;
				break;
			}
		}

		if (full || items.length >= limit || rows.length < scanBatchSize) break;
	}
	return {
		boundary,
		items,
		nextPageToken: hasMore ? lastScannedToken : null,
		hasMore: hasMore && lastScannedToken != null,
	};
}

export function hasUnsyncedSharedMemoryChanges(db: Database, limit = 25): SyncDirtyLocalState {
	// Single SQL query replacing the old O(N×M) JS loop that loaded every
	// memory item then queried replication_ops per-row.  This uses NOT EXISTS
	// to find shared memories whose current rev lacks a matching replication op,
	// which is exactly the "dirty" condition the old loop was checking.
	//
	// Visibility matching follows syncVisibilityAllowed semantics:
	//  - explicit 'shared', 'shared:default', 'shared:legacy' → sync-eligible
	//  - NULL/empty visibility with non-private content → sync-eligible (legacy default)
	//  - explicit 'private' or 'personal:*' → not sync-eligible
	const stmt = db.prepare(`
		SELECT count(*) as n FROM (
			SELECT 1 FROM memory_items m
			WHERE m.import_key IS NOT NULL
			  AND COALESCE(m.visibility, '') NOT LIKE 'private%'
			  AND COALESCE(m.visibility, '') NOT LIKE 'personal%'
			  AND NOT EXISTS (
				SELECT 1 FROM replication_ops r
				WHERE r.entity_type = 'memory_item'
				  AND r.entity_id = m.import_key
				  AND r.op_type = CASE WHEN m.deleted_at IS NOT NULL OR m.active = 0 THEN 'delete' ELSE 'upsert' END
				  AND r.clock_rev = COALESCE(m.rev, 0)
			  )
			LIMIT ?
		)
	`);
	const row = stmt.get(limit) as { n: number } | undefined;
	const count = Number(row?.n ?? 0);
	return { dirty: count > 0, count };
}

/**
 * After ops were pruned: move the scope's retained floor, and have the backfill check every
 * memory again, because a memory whose current op was pruned needs a new one.
 */
function recordPrunedFloor(db: Database, floorCursor: string, scopeId: string): void {
	setSyncResetState(db, { retained_floor_cursor: floorCursor }, scopeId);
	requestReplicationBackfillRecheck(db);
}

export function pruneReplicationOps(
	db: Database,
	options?: {
		maxAgeDays?: number;
		maxSizeBytes?: number;
		maxDeleteOps?: number;
		maxRuntimeMs?: number;
		scopeId?: string | null;
	},
): ReplicationOpsPruneResult {
	const maxAgeDays = Math.max(1, Math.floor(options?.maxAgeDays ?? 30));
	const maxSizeBytes = Math.max(1, Math.floor(options?.maxSizeBytes ?? 512 * 1024 * 1024));
	const maxDeleteOps = Math.max(1, Math.floor(options?.maxDeleteOps ?? Number.MAX_SAFE_INTEGER));
	const maxRuntimeMs = Math.max(1, Math.floor(options?.maxRuntimeMs ?? Number.MAX_SAFE_INTEGER));
	const scopeId = normalizeSyncStateScopeId(options?.scopeId);
	const d = drizzle(db, { schema });
	const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
	const startedAt = Date.now();
	let deleted = 0;
	let lastDeletedCursor: string | null = null;
	const deleteThroughCursor = (createdAt: string, opId: string): number => {
		const floorCursor = computeCursor(createdAt, opId);
		return db
			.transaction(() => {
				const result =
					scopeId === DEFAULT_SYNC_SCOPE_ID
						? (db
								.prepare(
									`DELETE FROM replication_ops
									 WHERE (scope_id IS NULL OR scope_id = ?)
									   AND (created_at < ? OR (created_at = ? AND op_id <= ?))`,
								)
								.run(scopeId, createdAt, createdAt, opId) as { changes?: number })
						: (db
								.prepare(
									`DELETE FROM replication_ops
									 WHERE scope_id = ?
									   AND (created_at < ? OR (created_at = ? AND op_id <= ?))`,
								)
								.run(scopeId, createdAt, createdAt, opId) as { changes?: number });
				const changes = result.changes ?? 0;
				if (changes > 0) recordPrunedFloor(db, floorCursor, scopeId);
				return changes;
			})
			.immediate();
	};
	const estimatedBytesBefore = estimateReplicationOpsScopeBytes(db, scopeId);
	if (estimatedBytesBefore == null) {
		throw new Error("replication_ops_size_unavailable");
	}
	let stoppedByBudget = false;
	const budgetExceeded = () => deleted >= maxDeleteOps || Date.now() - startedAt >= maxRuntimeMs;

	while (true) {
		if (budgetExceeded()) {
			stoppedByBudget = true;
			break;
		}
		const remainingDeleteBudget = Math.max(1, maxDeleteOps - deleted);
		const ageBatchSize = Math.max(1, Math.min(remainingDeleteBudget, 10_000));
		const ageCandidates = d
			.select({
				op_id: schema.replicationOps.op_id,
				created_at: schema.replicationOps.created_at,
			})
			.from(schema.replicationOps)
			.where(
				and(
					sql`${schema.replicationOps.created_at} < ${cutoff}`,
					scopeId === DEFAULT_SYNC_SCOPE_ID
						? or(
								isNull(schema.replicationOps.scope_id),
								eq(schema.replicationOps.scope_id, scopeId),
							)
						: eq(schema.replicationOps.scope_id, scopeId),
				),
			)
			.orderBy(schema.replicationOps.created_at, schema.replicationOps.op_id)
			.limit(ageBatchSize)
			.all();
		if (ageCandidates.length === 0) break;
		const boundary = ageCandidates[ageCandidates.length - 1];
		if (!boundary) break;
		lastDeletedCursor = computeCursor(String(boundary.created_at), String(boundary.op_id));
		deleted += deleteThroughCursor(String(boundary.created_at), String(boundary.op_id));
		if (budgetExceeded()) {
			stoppedByBudget = true;
			break;
		}
		if (ageCandidates.length < ageBatchSize) break;
	}

	let estimatedSizeBytes = estimatedBytesBefore;
	while (estimatedSizeBytes > maxSizeBytes) {
		if (budgetExceeded()) {
			stoppedByBudget = true;
			break;
		}
		const remainingDeleteBudget = Math.max(1, maxDeleteOps - deleted);
		const sizeBatchSize = Math.max(1, Math.min(remainingDeleteBudget, 10_000));
		const oldestChunk = d
			.select({
				op_id: schema.replicationOps.op_id,
				created_at: schema.replicationOps.created_at,
			})
			.from(schema.replicationOps)
			.where(
				scopeId === DEFAULT_SYNC_SCOPE_ID
					? or(isNull(schema.replicationOps.scope_id), eq(schema.replicationOps.scope_id, scopeId))
					: eq(schema.replicationOps.scope_id, scopeId),
			)
			.orderBy(schema.replicationOps.created_at, schema.replicationOps.op_id)
			.limit(sizeBatchSize)
			.all();
		const boundary = oldestChunk[oldestChunk.length - 1];
		if (!boundary) break;
		lastDeletedCursor = computeCursor(String(boundary.created_at), String(boundary.op_id));
		deleted += deleteThroughCursor(String(boundary.created_at), String(boundary.op_id));
		const nextEstimatedSize = estimateReplicationOpsScopeBytes(db, scopeId);
		if (nextEstimatedSize == null) {
			throw new Error("replication_ops_size_unavailable");
		}
		estimatedSizeBytes = nextEstimatedSize;
	}

	const currentBoundary = getSyncResetState(db, scopeId);
	const retainedFloorCursor =
		deleted > 0 ? lastDeletedCursor : currentBoundary.retained_floor_cursor;
	return {
		deleted,
		retained_floor_cursor: retainedFloorCursor,
		estimated_bytes_before: estimatedBytesBefore,
		estimated_bytes_after: estimatedSizeBytes,
		stopped_by_budget: stoppedByBudget,
	};
}

export interface ReplicationOpsPruneLoopResult {
	totalDeleted: number;
	passes: number;
	lastFloor: string | null;
	afterBytes: number;
	stoppedByBudget: boolean;
}

export function pruneReplicationOpsUntilCaughtUp(
	db: Database,
	options: {
		maxAgeDays: number;
		maxSizeBytes: number;
		maxDeleteOps: number;
		maxRuntimeMs: number;
		scopeId?: string | null;
		maxPasses?: number;
		signal?: AbortSignal;
		onPass?: (pass: {
			passNumber: number;
			deleted: number;
			afterBytes: number;
			stoppedByBudget: boolean;
		}) => void;
	},
): ReplicationOpsPruneLoopResult {
	const maxPasses = Math.max(1, Math.floor(options.maxPasses ?? 25));
	let totalDeleted = 0;
	let passes = 0;
	let lastFloor: string | null = null;
	let afterBytes = estimateReplicationOpsStorageBytes(db) ?? 0;
	let stoppedByBudget = false;

	while (true) {
		if (options.signal?.aborted || passes >= maxPasses) {
			stoppedByBudget = true;
			break;
		}
		const result = pruneReplicationOps(db, options);
		passes += 1;
		totalDeleted += result.deleted;
		lastFloor = result.retained_floor_cursor;
		afterBytes = result.estimated_bytes_after ?? estimateReplicationOpsStorageBytes(db) ?? 0;
		stoppedByBudget = result.stopped_by_budget ?? false;
		options.onPass?.({
			passNumber: passes,
			deleted: result.deleted,
			afterBytes,
			stoppedByBudget,
		});
		if (result.deleted === 0 || !result.stopped_by_budget) break;
	}

	return {
		totalDeleted,
		passes,
		lastFloor,
		afterBytes,
		stoppedByBudget,
	};
}

export function bulkPruneReplicationOpsByAgeCutoff(
	db: Database,
	maxAgeDays: number,
	maxDeleteOps = Number.MAX_SAFE_INTEGER,
	scopeIdInput?: string | null,
): ReplicationOpsPruneResult {
	const d = drizzle(db, { schema });
	const scopeId = normalizeSyncStateScopeId(scopeIdInput);
	const cutoff = new Date(
		Date.now() - Math.max(1, Math.floor(maxAgeDays)) * 24 * 60 * 60 * 1000,
	).toISOString();
	const estimatedBytesBefore = estimateReplicationOpsScopeBytes(db, scopeId);
	if (estimatedBytesBefore == null) {
		throw new Error("replication_ops_size_unavailable");
	}
	const oldestEligible = d
		.select({ op_id: schema.replicationOps.op_id, created_at: schema.replicationOps.created_at })
		.from(schema.replicationOps)
		.where(
			and(
				sql`${schema.replicationOps.created_at} < ${cutoff}`,
				scopeId === DEFAULT_SYNC_SCOPE_ID
					? or(isNull(schema.replicationOps.scope_id), eq(schema.replicationOps.scope_id, scopeId))
					: eq(schema.replicationOps.scope_id, scopeId),
			),
		)
		.orderBy(schema.replicationOps.created_at, schema.replicationOps.op_id)
		.limit(Math.max(1, maxDeleteOps))
		.all();
	const boundary = oldestEligible[oldestEligible.length - 1];
	if (!boundary) {
		const currentBoundary = getSyncResetState(db, scopeId);
		return {
			deleted: 0,
			retained_floor_cursor: currentBoundary.retained_floor_cursor,
			estimated_bytes_before: estimatedBytesBefore,
			estimated_bytes_after: estimatedBytesBefore,
			stopped_by_budget: false,
		};
	}
	const retainedFloorCursor = computeCursor(String(boundary.created_at), String(boundary.op_id));
	const deleted = db
		.transaction(() => {
			const result =
				scopeId === DEFAULT_SYNC_SCOPE_ID
					? (db
							.prepare(
								`DELETE FROM replication_ops
								 WHERE (scope_id IS NULL OR scope_id = ?)
								   AND (created_at < ? OR (created_at = ? AND op_id <= ?))`,
							)
							.run(scopeId, boundary.created_at, boundary.created_at, boundary.op_id) as {
							changes?: number;
						})
					: (db
							.prepare(
								`DELETE FROM replication_ops
								 WHERE scope_id = ?
								   AND (created_at < ? OR (created_at = ? AND op_id <= ?))`,
							)
							.run(scopeId, boundary.created_at, boundary.created_at, boundary.op_id) as {
							changes?: number;
						});
			const changes = result.changes ?? 0;
			if (changes > 0) recordPrunedFloor(db, retainedFloorCursor, scopeId);
			return changes;
		})
		.immediate();
	const estimatedBytesAfter = estimateReplicationOpsScopeBytes(db, scopeId);
	if (estimatedBytesAfter == null) {
		throw new Error("replication_ops_size_unavailable");
	}
	return {
		deleted,
		retained_floor_cursor: retainedFloorCursor,
		estimated_bytes_before: estimatedBytesBefore,
		estimated_bytes_after: estimatedBytesAfter,
		stopped_by_budget: false,
	};
}

export function planReplicationOpsAgePrune(
	db: Database,
	maxAgeDays: number,
	batchOps: number,
): ReplicationOpsAgePrunePlan {
	const d = drizzle(db, { schema });
	const cutoff = new Date(
		Date.now() - Math.max(1, Math.floor(maxAgeDays)) * 24 * 60 * 60 * 1000,
	).toISOString();
	const countRow = d
		.select({ total: sql<number>`COUNT(*)` })
		.from(schema.replicationOps)
		.where(sql`${schema.replicationOps.created_at} < ${cutoff}`)
		.get();
	const totalCountRow = d
		.select({ total: sql<number>`COUNT(*)` })
		.from(schema.replicationOps)
		.get();
	const boundary = d
		.select({ op_id: schema.replicationOps.op_id, created_at: schema.replicationOps.created_at })
		.from(schema.replicationOps)
		.where(sql`${schema.replicationOps.created_at} < ${cutoff}`)
		.orderBy(desc(schema.replicationOps.created_at), desc(schema.replicationOps.op_id))
		.limit(1)
		.get();
	const candidateOps = Number(countRow?.total ?? 0);
	const totalOps = Number(totalCountRow?.total ?? 0);
	const estimatedTotalBytes = estimateReplicationOpsStorageBytes(db) ?? 0;
	const estimatedCandidateBytes =
		totalOps > 0 ? Math.round((estimatedTotalBytes * candidateOps) / totalOps) : 0;
	return {
		candidate_ops: candidateOps,
		estimated_candidate_bytes: Math.max(0, estimatedCandidateBytes),
		cutoff_cursor: boundary
			? computeCursor(String(boundary.created_at), String(boundary.op_id))
			: null,
		estimated_batches: candidateOps > 0 ? Math.ceil(candidateOps / Math.max(1, batchOps)) : 0,
	};
}

function estimateReplicationOpsStorageBytes(db: Database): number | null {
	try {
		const row = db
			.prepare(
				`SELECT COALESCE(SUM(pgsize), 0) AS total_bytes
				 FROM dbstat
				 WHERE name IN (SELECT name FROM sqlite_schema WHERE tbl_name =
				    COALESCE((SELECT tbl_name FROM sqlite_schema WHERE name='idx_replication_ops_created'),'replication_ops'))`,
			)
			.get() as { total_bytes?: number | string | null } | undefined;
		const total = Number(row?.total_bytes ?? 0);
		return Number.isFinite(total) && total >= 0 ? total : null;
	} catch {
		return null;
	}
}

export function estimateReplicationOpsScopeBytes(db: Database, scopeId: string): number | null {
	const estimateSql = `SELECT COALESCE(SUM(
		LENGTH(COALESCE(op_id, '')) +
		LENGTH(COALESCE(entity_type, '')) +
		LENGTH(COALESCE(entity_id, '')) +
		LENGTH(COALESCE(op_type, '')) +
		LENGTH(COALESCE(payload_json, '')) +
		LENGTH(COALESCE(clock_updated_at, '')) +
		LENGTH(COALESCE(clock_device_id, '')) +
		LENGTH(COALESCE(device_id, '')) +
		LENGTH(COALESCE(created_at, '')) +
		LENGTH(COALESCE(scope_id, '')) +
		96
	), 0) AS total_bytes
	FROM replication_ops
	WHERE ${scopeId === DEFAULT_SYNC_SCOPE_ID ? "scope_id IS NULL OR scope_id = ?" : "scope_id = ?"}`;
	try {
		const row = db.prepare(estimateSql).get(scopeId) as
			| { total_bytes?: number | string | null }
			| undefined;
		const total = Number(row?.total_bytes ?? 0);
		return Number.isFinite(total) && total >= 0 ? total : null;
	} catch {
		return null;
	}
}

function cleanList(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	const out: string[] = [];
	for (const raw of values) {
		const value = String(raw ?? "").trim();
		if (value) out.push(value);
	}
	return out;
}

function parseStringList(value: unknown): string[] {
	if (Array.isArray(value)) return cleanList(value);
	if (typeof value === "string") {
		return value
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean);
	}
	return [];
}

function parseJsonList(valuesJson: string | null | undefined): string[] {
	if (!valuesJson) return [];
	try {
		return cleanList(JSON.parse(valuesJson));
	} catch {
		return [];
	}
}

/**
 * The Project filters in effect for one pairing: its own lists, or its retained
 * lists while removed, otherwise the shared lists from configuration.
 * With no device ID, return the shared lists.
 */
export function effectiveSyncProjectFilters(
	db: Database,
	peerDeviceId: string | null,
	config = readCodememConfigFile(),
): { include: string[]; exclude: string[] } {
	const d = drizzle(db, { schema });
	const includeOverride = process.env.CODEMEM_SYNC_PROJECTS_INCLUDE;
	const excludeOverride = process.env.CODEMEM_SYNC_PROJECTS_EXCLUDE;
	const globalInclude =
		includeOverride !== undefined
			? parseStringList(includeOverride)
			: parseStringList(config.sync_projects_include);
	const globalExclude =
		excludeOverride !== undefined
			? parseStringList(excludeOverride)
			: parseStringList(config.sync_projects_exclude);
	if (!peerDeviceId) return { include: globalInclude, exclude: globalExclude };

	const paired = d
		.select({
			projects_include_json: schema.syncPeers.projects_include_json,
			projects_exclude_json: schema.syncPeers.projects_exclude_json,
		})
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
		.limit(1)
		.get();
	const row = paired ?? readRetainedPeerProjectFilters(db, peerDeviceId);
	if (!row) return { include: globalInclude, exclude: globalExclude };

	const hasOverride = row.projects_include_json != null || row.projects_exclude_json != null;
	if (!hasOverride) {
		return { include: globalInclude, exclude: globalExclude };
	}

	return {
		include: parseJsonList(row.projects_include_json),
		exclude: parseJsonList(row.projects_exclude_json),
	};
}

export function syncProjectAllowed(
	db: Database,
	project: string | null,
	peerDeviceId: string | null,
): boolean {
	const { include, exclude } = effectiveSyncProjectFilters(db, peerDeviceId);
	return syncProjectAllowedByFilters(project, { include, exclude });
}

export function syncProjectAllowedByFilters(
	projectValue: string | null,
	filters: { include: string[]; exclude: string[] },
): boolean {
	const value = String(projectValue ?? "").trim();
	const valueBase = projectBasename(value);
	for (const blocked of filters.exclude) {
		if (blocked === value || blocked === valueBase) return false;
	}
	if (filters.include.length === 0) return true;
	for (const allowed of filters.include) {
		if (allowed === value || allowed === valueBase) return true;
	}
	return false;
}

export function syncVisibilityAllowed(payload: Record<string, unknown> | null): boolean {
	if (!payload) return false;
	let visibility = String(payload.visibility ?? "")
		.trim()
		.toLowerCase();
	const metadata =
		payload.metadata_json &&
		typeof payload.metadata_json === "object" &&
		!Array.isArray(payload.metadata_json)
			? (payload.metadata_json as Record<string, unknown>)
			: {};
	const metadataVisibility = String(metadata.visibility ?? "")
		.trim()
		.toLowerCase();
	if (!visibility && metadataVisibility) {
		visibility = metadataVisibility;
	}

	if (!visibility) {
		let workspaceKind = String(payload.workspace_kind ?? "")
			.trim()
			.toLowerCase();
		let workspaceId = String(payload.workspace_id ?? "")
			.trim()
			.toLowerCase();
		if (!workspaceKind)
			workspaceKind = String(metadata.workspace_kind ?? "")
				.trim()
				.toLowerCase();
		if (!workspaceId)
			workspaceId = String(metadata.workspace_id ?? "")
				.trim()
				.toLowerCase();
		if (workspaceKind === "shared" || workspaceId.startsWith("shared:")) {
			visibility = "shared";
		} else {
			return true;
		}
	}

	return visibility === "shared";
}

function cleanText(value: unknown): string | null {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed.length > 0 ? trimmed : null;
}

export interface PersonalScopeGrantStatus {
	scope_id: string | null;
	authorized: boolean;
	state: string;
}

export function personalScopeGrantStatusForPeer(
	db: Database,
	input: { peerDeviceId: string | null; actorId: string | null },
): PersonalScopeGrantStatus {
	const peerDeviceId = cleanText(input.peerDeviceId);
	const actorId = cleanText(input.actorId);
	if (!peerDeviceId || !actorId) {
		return { scope_id: null, authorized: false, state: "missing_peer_or_actor" };
	}
	const scopeId = `personal:${actorId}`;
	const auth = getPeerCachedScopeAuthorization(db, { deviceId: peerDeviceId, scopeId });
	return { scope_id: scopeId, authorized: auth.authorized, state: auth.state };
}

function personalScopeAuthorizationRequirement(
	op: Pick<ReplicationOp, "scope_id">,
	payload: Record<string, unknown> | null,
): { required: boolean; scopeId: string | null } {
	const metadata =
		payload?.metadata_json &&
		typeof payload.metadata_json === "object" &&
		!Array.isArray(payload.metadata_json)
			? (payload.metadata_json as Record<string, unknown>)
			: {};
	const opScopeId = cleanText(op.scope_id);
	const payloadScopeId = cleanText(payload?.scope_id);
	const visibility = cleanText(payload?.visibility ?? metadata.visibility)?.toLowerCase() ?? null;
	const workspaceId = cleanText(payload?.workspace_id ?? metadata.workspace_id);
	const workspaceKind =
		cleanText(payload?.workspace_kind ?? metadata.workspace_kind)?.toLowerCase() ?? null;
	const actorId = cleanText(payload?.actor_id ?? metadata.actor_id);
	const personalWorkspaceId = workspaceId?.startsWith("personal:") ? workspaceId : null;
	const hasPersonalSignal =
		visibility === "private" ||
		visibility === "personal" ||
		workspaceKind === "personal" ||
		Boolean(personalWorkspaceId);
	const actorScopeId = actorId && hasPersonalSignal ? `personal:${actorId}` : null;
	const candidates = [opScopeId, payloadScopeId, personalWorkspaceId, actorScopeId].filter(
		(candidate): candidate is string => Boolean(candidate?.startsWith("personal:")),
	);
	const scopeId = candidates[0] ?? null;
	if (!scopeId) return { required: hasPersonalSignal, scopeId: null };
	if (candidates.some((candidate) => candidate !== scopeId)) {
		return { required: true, scopeId: null };
	}
	return { required: true, scopeId };
}

export function replicationOpRequiresPersonalScopeAuthorization(
	op: Pick<ReplicationOp, "scope_id">,
	payload: Record<string, unknown> | null,
): boolean {
	return personalScopeAuthorizationRequirement(op, payload).required;
}

export function peerCanSyncPrivateOpByPersonalScopeGrant(
	db: Database,
	op: Pick<ReplicationOp, "scope_id">,
	payload: Record<string, unknown> | null,
	peerDeviceId: string | null,
): boolean {
	const { scopeId } = personalScopeAuthorizationRequirement(op, payload);
	if (!scopeId) return false;
	const actorId = scopeId.slice("personal:".length);
	return personalScopeGrantStatusForPeer(db, { peerDeviceId, actorId }).authorized;
}

function parsePayload(payloadJson: string | null): Record<string, unknown> | null {
	if (!payloadJson?.trim()) return null;
	try {
		const parsed = JSON.parse(payloadJson) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

export interface FilterReplicationSkipped {
	reason: "scope_filter" | "visibility_filter" | "project_filter";
	op_id: string;
	created_at: string;
	entity_type: string;
	entity_id: string;
	skipped_count: number;
	project?: string | null;
	scope_id?: string | null;
	visibility?: string | null;
}

export interface FilterReplicationOpsForSyncOptions {
	localDeviceId?: string | null;
	applyScopeFilter?: boolean;
	supportsReassignScope?: boolean;
}

interface ExistingMemoryFilterContext {
	payload: Record<string, unknown>;
	project: string | null;
	scopeId: string | null;
}

function addSkipped(
	state: { count: number; first: FilterReplicationSkipped | null },
	op: ReplicationOp,
	skipped: Pick<FilterReplicationSkipped, "reason"> &
		Partial<Omit<FilterReplicationSkipped, "reason" | "skipped_count">>,
): void {
	state.count += 1;
	if (!state.first) {
		state.first = {
			...skipped,
			op_id: op.op_id,
			created_at: op.created_at,
			entity_type: op.entity_type,
			entity_id: op.entity_id,
			skipped_count: 0,
		};
	}
}

function metadataRecord(payload: Record<string, unknown> | null): Record<string, unknown> {
	const metadata = payload?.metadata_json;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
	return metadata as Record<string, unknown>;
}

function payloadScopeId(payload: Record<string, unknown> | null): string | null {
	const metadata = metadataRecord(payload);
	return cleanText(payload?.scope_id ?? metadata.scope_id);
}

function payloadContradictsOutboundScope(
	op: Pick<ReplicationOp, "scope_id">,
	payload: Record<string, unknown> | null,
): boolean {
	const opScopeId = cleanText(op.scope_id);
	const explicitPayloadScopeId = payloadScopeId(payload);
	if (explicitPayloadScopeId && explicitPayloadScopeId !== opScopeId) return true;
	if (!opScopeId) return explicitPayloadScopeId != null;

	const personalRequirement = personalScopeAuthorizationRequirement(op, payload);
	return Boolean(
		personalRequirement.required &&
			personalRequirement.scopeId &&
			personalRequirement.scopeId !== opScopeId,
	);
}

/** A copy of a memory this device stores, as sync judges who may read it. */
interface StoredMemoryCopy {
	payload: Record<string, unknown>;
	project: string | null;
	scopeId: string | null;
}

type OutboundRefusal = Pick<FilterReplicationSkipped, "reason"> &
	Partial<Omit<FilterReplicationSkipped, "reason" | "skipped_count">>;

/**
 * Why the peer may not read a stored copy now, by the copy's current visibility,
 * personal scope and Project, or null when it may. Snapshot pages and op content
 * use this one check.
 */
function storedCopyRefusal(
	db: Database,
	copy: StoredMemoryCopy,
	peerDeviceId: string | null,
): OutboundRefusal | null {
	const scope = { scope_id: copy.scopeId };
	if (storedCopyWithheld(db, copy)) return { reason: "scope_filter", scope_id: copy.scopeId };
	if (
		(replicationOpRequiresPersonalScopeAuthorization(scope, copy.payload) ||
			!syncVisibilityAllowed(copy.payload)) &&
		!peerCanSyncPrivateOpByPersonalScopeGrant(db, scope, copy.payload, peerDeviceId)
	) {
		const visibility = copy.payload.visibility;
		return {
			reason: "visibility_filter",
			visibility: typeof visibility === "string" ? visibility : null,
		};
	}
	if (!syncProjectAllowed(db, copy.project, peerDeviceId))
		return { reason: "project_filter", project: copy.project };
	return null;
}

/** The actor a store's memories carry before it adopts a device identity. */
const FALLBACK_LOCAL_ACTOR_ID = "local:local";

/**
 * Whether a stored copy is held back from every peer until it is repaired or
 * settled:
 *
 * - Another copy shares its import key in its scope. Which one a peer should
 *   hold is unclear, so none is served while more than one is stored.
 * - It still carries the fallback actor this store used before it adopted a
 *   device identity, whatever its origin says. It is served once adoption moves
 *   it to the canonical actor.
 */
function storedCopyWithheld(db: Database, copy: StoredMemoryCopy): boolean {
	if (copy.payload.actor_id === FALLBACK_LOCAL_ACTOR_ID) return true;
	const importKey = cleanText(copy.payload.import_key as string | null);
	if (importKey == null) return false;
	return (
		Number(
			db
				.prepare("SELECT COUNT(*) FROM memory_items WHERE import_key = ? AND scope_id IS ?")
				.pluck()
				.get(importKey, copy.scopeId),
		) > 1
	);
}

/** Whether the op carries a memory's content, as against a tombstone, cleanup or move retraction. */
function opCarriesMemoryContent(
	op: ReplicationOp,
	payload: Record<string, unknown> | null,
): boolean {
	if (op.entity_type !== "memory_item" || payload == null) return false;
	if (op.op_type === ACCESS_CLEANUP_OP_TYPE) return false;
	return op.op_type !== REASSIGN_SCOPE_OP_TYPE || payload.side !== "old";
}

/** The op as it may go to the peer now, or why it may not. */
type OutboundDecision = { op: ReplicationOp; refusal?: undefined } | { refusal: OutboundRefusal };

/** The stored copy an op was recorded for, with its session's Project. */
interface CurrentCopy {
	row: MemoryItemRow;
	sessionProject: string | null;
}

/**
 * The copy an op is for, when the op belongs to the copy's current revision.
 *
 * An op this device recorded names the stored copy it was built from
 * (memory-copy-provenance.ts), and only that copy can carry it: the row with
 * that copy identity, still in the op's scope and at the op's revision. An op
 * that names no copy, recorded before copies had identities, carries nothing.
 * The copy's current content still reaches peers through an op recorded for it
 * since, and through snapshot pages.
 */
function currentCopyForOp(db: Database, op: ReplicationOp): CurrentCopy | null {
	const importKey = cleanText(op.entity_id);
	const scopeId = cleanText(op.scope_id);
	const copyId = opCopyId(db, op.op_id);
	if (!importKey || !scopeId || !copyId) return null;
	const row = db
		.prepare(
			`SELECT memory.*, session.project AS session_project
			 FROM memory_items AS memory
			 JOIN memory_copy_identities AS copy ON copy.memory_id = memory.id
			 LEFT JOIN sessions AS session ON session.id = memory.session_id
			 WHERE copy.copy_id = ? AND memory.import_key = ? AND memory.scope_id = ?
			   AND COALESCE(memory.rev, 0) = ?`,
		)
		.get(copyId, importKey, scopeId, Number(op.clock_rev ?? 0)) as
		| (MemoryItemRow & { session_project: string | null })
		| undefined;
	if (!row) return null;
	return { row, sessionProject: cleanText(row.session_project) };
}

/**
 * The content to send for an op, built from its copy as stored now, the same way
 * it was built when the op was recorded. A move's new side also names the move.
 */
function currentOpPayload(
	op: ReplicationOp,
	stored: Record<string, unknown>,
	copy: CurrentCopy,
): Record<string, unknown> {
	const scopeId = cleanText(op.scope_id);
	if (op.op_type !== REASSIGN_SCOPE_OP_TYPE)
		return opPayloadFromRow(copy.row, copy.sessionProject, scopeId);
	return {
		...buildPayloadFromMemoryRow(copy.row),
		project: cleanText(copy.row.project) ?? copy.sessionProject,
		operation_id: stored.operation_id,
		memory_id: stored.memory_id,
		old_scope_id: stored.old_scope_id,
		new_scope_id: stored.new_scope_id,
		revision: stored.revision,
		side: "new",
		scope_id: scopeId,
	};
}

/**
 * Whether the peer may receive this op now, and the op as it goes out. Both
 * devices must be authorized in the op's scope.
 *
 * An op's stored payload is never sent. An op that carries content goes out only
 * when it belongs to its copy's current revision, the peer may read that copy by
 * its current visibility, personal scope and Project, and the copy is not
 * deleted. Its content is then built from the copy as stored at that moment.
 * Older content ops send nothing: the current revision's op carries the memory,
 * and receivers order it after the older ones by its clock. Every write of a
 * replicated field takes a new revision with its own op (memory-revision-writes.ts),
 * so the current op exists for every copy this device writes.
 */
function outboundDecision(
	db: Database,
	op: ReplicationOp,
	payload: Record<string, unknown> | null,
	peerDeviceId: string | null,
	localDeviceId: string | null,
): OutboundDecision {
	const scopeRefusal: OutboundRefusal = {
		reason: "scope_filter",
		scope_id: cleanText(op.scope_id),
	};
	if (!outboundScopeAllowed(db, op, payload, peerDeviceId, localDeviceId))
		return { refusal: scopeRefusal };
	if (!payload || !opCarriesMemoryContent(op, payload)) return { op };
	const copy = currentCopyForOp(db, op);
	if (!copy || copy.row.active === 0 || copy.row.deleted_at) return { refusal: scopeRefusal };
	const readable = {
		payload: buildPayloadFromMemoryRow(copy.row) as unknown as Record<string, unknown>,
		project: copy.sessionProject,
		scopeId: cleanText(copy.row.scope_id),
	};
	const refusal = storedCopyRefusal(db, readable, peerDeviceId);
	if (refusal) return { refusal };
	return { op: { ...op, payload_json: toJson(currentOpPayload(op, payload, copy)) } };
}

/**
 * The outbound decision, where the scope filter applies, with the op that goes
 * out rebuilt from its stored copy. Inbound validation runs without the filter.
 */
function scopedOutboundDecision(
	db: Database,
	op: ReplicationOp,
	payload: Record<string, unknown> | null,
	peerDeviceId: string | null,
	options: FilterReplicationOpsForSyncOptions,
): OutboundDecision {
	if (options.applyScopeFilter === false) return { op };
	return outboundDecision(db, op, payload, peerDeviceId, options.localDeviceId ?? null);
}

/**
 * The ops of an outbound batch as they may go to the peer now, decided and built
 * immediately before the batch is serialized. A push spans network waits and
 * split retries, and a memory can move, turn private or change meanwhile. Ops
 * that carry no content keep the checks they passed when the window was read.
 */
export function opsStillSendableToPeer(
	db: Database,
	ops: ReplicationOp[],
	peerDeviceId: string,
	localDeviceId: string | null,
): ReplicationOp[] {
	return ops.flatMap((op) => {
		const payload = op.entity_type === "memory_item" ? parsePayload(op.payload_json) : null;
		if (!opCarriesMemoryContent(op, payload)) return [op];
		const decision = outboundDecision(db, op, payload, peerDeviceId, localDeviceId);
		return decision.refusal ? [] : [decision.op];
	});
}

function existingMemoryFilterContext(
	db: Database,
	importKey: string,
): ExistingMemoryFilterContext | null {
	const key = cleanText(importKey);
	if (!key) return null;
	const row = db
		.prepare(
			`SELECT
				m.actor_id,
				m.metadata_json,
				m.scope_id,
				m.visibility,
				m.workspace_id,
				m.workspace_kind,
				s.project
			 FROM memory_items m
			 LEFT JOIN sessions s ON s.id = m.session_id
			 WHERE m.import_key = ?
			 LIMIT 1`,
		)
		.get(key) as
		| {
				actor_id: string | null;
				metadata_json: string | null;
				project: string | null;
				scope_id: string | null;
				visibility: string | null;
				workspace_id: string | null;
				workspace_kind: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		payload: {
			actor_id: row.actor_id,
			metadata_json: fromJson(row.metadata_json),
			visibility: row.visibility,
			workspace_id: row.workspace_id,
			workspace_kind: row.workspace_kind,
		},
		project: cleanText(row.project),
		scopeId: cleanText(row.scope_id),
	};
}

function outboundScopeAllowed(
	db: Database,
	op: ReplicationOp,
	payload: Record<string, unknown> | null,
	peerDeviceId: string | null,
	localDeviceId: string | null,
): boolean {
	if (payloadContradictsOutboundScope(op, payload)) return false;
	const scopeId = cleanText(op.scope_id);
	if (!scopeId) return true;
	if (scopeId === DEFAULT_SYNC_SCOPE_ID) return false;
	if (isProjectScopeWithdrawn(db, scopeId)) return false;
	const peerId = cleanText(peerDeviceId);
	if (!peerId) return false;
	const peerAuth = getPeerCachedScopeAuthorization(db, { deviceId: peerId, scopeId });
	if (!peerAuth.authorized || peerAuth.scope?.authority_type === "local") return false;
	const localId = cleanText(localDeviceId);
	if (!localId) return true;
	const localAuth = getPeerCachedScopeAuthorization(db, { deviceId: localId, scopeId });
	return localAuth.authorized && localAuth.scope?.authority_type !== "local";
}

/**
 * Whether this device recorded a local-default cleanup it can't show it may
 * send.
 *
 * A recipient accepts this device's cleanup of a memory only when its own copy
 * names this device as origin. This device sends one only when its current copy
 * of the memory names it too. Otherwise, for example a memory `memory import`
 * brought in without an author, one shared before shares recorded the owner as
 * origin, or one this device no longer has, the cleanup is skipped like any
 * other filtered operation, so cursors still move past it. Withholding never
 * changes a recipient's copy; those copies stay as they are. Operations other
 * than this device's own local-default cleanups are unchanged.
 */
function cannotVouchForDefaultCleanup(
	db: Database,
	op: ReplicationOp,
	reassignment: ReassignScopePayload,
	localDeviceId: string | null | undefined,
): boolean {
	const self = cleanText(localDeviceId);
	if (!self || reassignment.side !== "old") return false;
	if (reassignment.old_scope_id !== DEFAULT_SYNC_SCOPE_ID) return false;
	if (cleanText(op.device_id) !== self || cleanText(op.clock_device_id) !== self) return false;
	const row = db
		.prepare("SELECT origin_device_id FROM memory_items WHERE import_key = ?")
		.get(op.entity_id) as { origin_device_id: string | null } | undefined;
	return cleanText(row?.origin_device_id) !== self;
}

function legacyDefaultReassignAllowed(
	db: Database,
	op: ReplicationOp,
	peerDeviceId: string | null,
): boolean {
	const existing = existingMemoryFilterContext(db, op.entity_id);
	if (!existing) return false;
	if (
		(replicationOpRequiresPersonalScopeAuthorization(op, existing.payload) ||
			!syncVisibilityAllowed(existing.payload)) &&
		!peerCanSyncPrivateOpByPersonalScopeGrant(db, op, existing.payload, peerDeviceId)
	) {
		return false;
	}
	return syncProjectAllowed(db, existing.project, peerDeviceId);
}

/**
 * Filter replication ops for peer sync scopes.
 *
 * Returns ops that pass project/visibility rules, a cursor for the last
 * processed op (including skipped ops), and skipped metadata when filtering
 * removed one or more ops.
 */
function existingDeleteRejection(
	db: Database,
	op: ReplicationOp,
	peerDeviceId: string | null,
	options: { applyScopeFilter: boolean },
): Parameters<typeof addSkipped>[2] | null {
	const existing = existingMemoryFilterContext(db, op.entity_id);
	if (!existing) return null;
	if (options.applyScopeFilter && existing.scopeId && existing.scopeId !== cleanText(op.scope_id)) {
		return { reason: "scope_filter", scope_id: cleanText(op.scope_id) };
	}
	if (
		(replicationOpRequiresPersonalScopeAuthorization(op, existing.payload) ||
			!syncVisibilityAllowed(existing.payload)) &&
		!peerCanSyncPrivateOpByPersonalScopeGrant(db, op, existing.payload, peerDeviceId)
	) {
		return {
			reason: "visibility_filter",
			visibility:
				typeof existing.payload.visibility === "string"
					? String(existing.payload.visibility)
					: null,
		};
	}
	if (!syncProjectAllowed(db, existing.project, peerDeviceId))
		return { reason: "project_filter", project: existing.project };
	return null;
}

/**
 * How the outbound filter treats a reassign_scope op: skip it, send it as is
 * (old side), or check it like any other op (new side). An op that can't be
 * parsed or checked is skipped.
 */
function reassignOutboundDecision(
	db: Database,
	op: ReplicationOp,
	payload: Record<string, unknown> | null,
	peerDeviceId: string | null,
	options: { applyScopeFilter: boolean; localDeviceId: string | null | undefined },
): "skip" | "send" | "check" {
	try {
		const reassignment = parseReassignScopePayload(op);
		if (cannotVouchForDefaultCleanup(db, op, reassignment, options.localDeviceId)) return "skip";
		if (options.applyScopeFilter) {
			const allowed =
				reassignment.side === "old" && reassignment.old_scope_id === DEFAULT_SYNC_SCOPE_ID
					? legacyDefaultReassignAllowed(db, op, peerDeviceId)
					: outboundScopeAllowed(db, op, payload, peerDeviceId, options.localDeviceId ?? null);
			if (!allowed) return "skip";
		}
		return reassignment.side === "old" ? "send" : "check";
	} catch {
		return "skip";
	}
}

/**
 * A delete op as it goes to a peer: without a payload. Apply never reads a
 * deletion's payload, and replication backfill records deletions with the full
 * row, which a peer must not receive once the memory is deleted. Without its
 * payload, the op takes the same checks as every other deletion.
 */
function asOutboundTombstone(op: ReplicationOp): ReplicationOp {
	if (op.entity_type !== "memory_item" || op.op_type !== "delete" || op.payload_json == null)
		return op;
	return { ...op, payload_json: null };
}

export function filterReplicationOpsForSyncWithStatus(
	db: Database,
	ops: ReplicationOp[],
	peerDeviceId: string | null,
	options: FilterReplicationOpsForSyncOptions = {},
): [ReplicationOp[], string | null, FilterReplicationSkipped | null] {
	const allowed: ReplicationOp[] = [];
	let nextCursor: string | null = null;
	const skipped = { count: 0, first: null as FilterReplicationSkipped | null };
	const applyScopeFilter = options.applyScopeFilter !== false;
	for (const op of applyScopeFilter ? ops.map(asOutboundTombstone) : ops) {
		let outbound = op;
		if (retirementBlocksMemoryOp(db, op)) {
			addSkipped(skipped, op, { reason: "scope_filter", scope_id: cleanText(op.scope_id) });
			nextCursor = computeCursor(op.created_at, op.op_id);
			continue;
		}
		if (op.entity_type === "memory_item") {
			const payload = parsePayload(op.payload_json);
			if (op.op_type === REASSIGN_SCOPE_OP_TYPE && options.supportsReassignScope !== true) {
				addSkipped(skipped, op, {
					reason: "scope_filter",
					scope_id: cleanText(op.scope_id),
				});
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
			if (op.op_type === ACCESS_CLEANUP_OP_TYPE) {
				if (!accessCleanupSendable(db, op, peerDeviceId, { applyScopeFilter })) {
					addSkipped(skipped, op, {
						reason: "scope_filter",
						scope_id: cleanText(payload?.cleanup_scope_id ?? op.scope_id),
					});
					nextCursor = computeCursor(op.created_at, op.op_id);
					continue;
				}
				allowed.push(op);
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
			if (op.op_type === REASSIGN_SCOPE_OP_TYPE) {
				const decision = reassignOutboundDecision(db, op, payload, peerDeviceId, {
					applyScopeFilter,
					localDeviceId: options.localDeviceId,
				});
				if (decision === "skip") {
					addSkipped(skipped, op, { reason: "scope_filter", scope_id: cleanText(op.scope_id) });
				} else if (decision === "send") {
					allowed.push(outboundOldSideMove(db, op, peerDeviceId, { applyScopeFilter }));
				}
				if (decision !== "check") {
					nextCursor = computeCursor(op.created_at, op.op_id);
					continue;
				}
			}
			const regularScopeId = cleanText(op.scope_id);
			if (!regularScopeId || regularScopeId === DEFAULT_SYNC_SCOPE_ID) {
				addSkipped(skipped, op, { reason: "scope_filter", scope_id: regularScopeId });
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
			const decision = scopedOutboundDecision(db, op, payload, peerDeviceId, options);
			if (decision.refusal) {
				addSkipped(skipped, op, decision.refusal);
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
			outbound = decision.op;
			if (op.op_type === "delete" && payload == null) {
				const rejection = existingDeleteRejection(db, op, peerDeviceId, { applyScopeFilter });
				if (rejection) {
					addSkipped(skipped, op, rejection);
					nextCursor = computeCursor(op.created_at, op.op_id);
					continue;
				}
				if (
					replicationOpRequiresPersonalScopeAuthorization(op, payload) &&
					!peerCanSyncPrivateOpByPersonalScopeGrant(db, op, payload, peerDeviceId)
				) {
					addSkipped(skipped, op, { reason: "visibility_filter" });
					nextCursor = computeCursor(op.created_at, op.op_id);
					continue;
				}
				allowed.push(op);
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
			if (
				(replicationOpRequiresPersonalScopeAuthorization(op, payload) ||
					!syncVisibilityAllowed(payload)) &&
				!peerCanSyncPrivateOpByPersonalScopeGrant(db, op, payload, peerDeviceId)
			) {
				addSkipped(skipped, op, {
					reason: "visibility_filter",
					visibility: typeof payload?.visibility === "string" ? String(payload.visibility) : null,
				});
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}

			const project =
				typeof payload?.project === "string" && payload.project.trim()
					? payload.project.trim()
					: null;
			if (!syncProjectAllowed(db, project, peerDeviceId)) {
				addSkipped(skipped, op, { reason: "project_filter", project });
				nextCursor = computeCursor(op.created_at, op.op_id);
				continue;
			}
		}

		allowed.push(outbound);
		nextCursor = computeCursor(op.created_at, op.op_id);
	}

	if (skipped.first) {
		skipped.first.skipped_count = skipped.count;
	}

	return [allowed, nextCursor, skipped.first];
}

export function filterReplicationOpsForSync(
	db: Database,
	ops: ReplicationOp[],
	peerDeviceId: string | null,
	options: FilterReplicationOpsForSyncOptions = {},
): [ReplicationOp[], string | null] {
	const [allowed, nextCursor] = filterReplicationOpsForSyncWithStatus(
		db,
		ops,
		peerDeviceId,
		options,
	);
	return [allowed, nextCursor];
}

// Apply inbound replication ops

function skipOwnOrRetiredMemoryOp(db: Database, op: ReplicationOp, localDeviceId: string): boolean {
	if (op.device_id === localDeviceId) return true;
	return retirementBlocksMemoryOp(db, op);
}

function retirementPayloadContradictsScope(
	op: ReplicationOp,
	scopeId: string,
	payload: Record<string, unknown> | null,
): boolean {
	const scopes = [payload?.scope_id, metadataRecord(payload).scope_id];
	if (op.op_type === ACCESS_CLEANUP_OP_TYPE) {
		const cleanupScope = cleanText(payload?.cleanup_scope_id ?? payload?.scope_id);
		if (!cleanupScope) return true;
		if (scopeId !== DEFAULT_SYNC_SCOPE_ID && scopeId !== cleanupScope) return true;
		return scopes.some((value) => value != null && cleanText(value) !== cleanupScope);
	}
	return scopes.some((value) => value != null && cleanText(value) !== scopeId);
}

/** History makes missing/contradictory scope unsafe even without optional membership validation. */
function retirementBlocksMemoryOp(db: Database, op: ReplicationOp): boolean {
	if (op.entity_type !== "memory_item" || !hasMemoryScopeRetirement(db, op.entity_id)) return false;
	const scopeId = cleanText(op.scope_id);
	if (!scopeId || isMemoryScopeRetired(db, op.entity_id, scopeId)) return true;
	const payload = parsePayload(op.payload_json);
	if (op.payload_json != null && !payload) return true;
	if (retirementPayloadContradictsScope(op, scopeId, payload)) return true;
	if (op.op_type === ACCESS_CLEANUP_OP_TYPE) {
		return isMemoryScopeRetired(db, op.entity_id, parseAccessCleanupPayload(op).cleanup_scope_id);
	}
	if (op.op_type !== REASSIGN_SCOPE_OP_TYPE) return false;
	try {
		const reassignment = parseReassignScopePayload(op);
		return isMemoryScopeRetired(db, op.entity_id, reassignment.new_scope_id);
	} catch {
		return true;
	}
}

export interface ApplyResult {
	applied: number;
	skipped: number;
	rejected: number;
	conflicts: number;
	errors: string[];
	rejections: InboundScopeRejection[];
	vectorWork: ReplicationVectorWork;
}

export interface ReplicationVectorWork {
	upsertMemoryIds: number[];
	deleteMemoryIds: number[];
}

export type StalePeerReceivedRowReason =
	| "authorization_unknown"
	| "missing_import_key"
	| "missing_origin_device"
	| "missing_scope"
	| "unverified_local_creation";

export interface StalePeerReceivedRowDiagnostic {
	memory_id: number;
	import_key: string | null;
	origin_device_id: string | null;
	scope_id: string | null;
	reason: StalePeerReceivedRowReason;
}

export interface ReconcileStalePeerReceivedRowsResult {
	checked: number;
	deleted: number;
	deleted_memory_ids: number[];
	retained: number;
	ambiguous: StalePeerReceivedRowDiagnostic[];
}

export interface ReconcileStalePeerReceivedRowsOptions extends LocalCreationContext {
	localDeviceId: string;
	keysDir?: string;
	maxRows?: number | null;
	peerDeviceId?: string | null;
	/**
	 * With a peer: read only its rows in scopes cleanup can delete from. The deletions are
	 * the same; `checked`, `retained` and `ambiguous` then leave out its authorized scopes.
	 */
	onlyDeletableScopes?: boolean;
}

export type DiagnoseStalePeerReceivedRowsResult = Omit<
	ReconcileStalePeerReceivedRowsResult,
	"deleted" | "deleted_memory_ids"
> & {
	would_delete: number;
	would_delete_memory_ids: number[];
};

type StalePeerCandidateAuthState = ReturnType<typeof getCachedScopeAuthorization>["state"];

function stalePeerCandidateIsDeletable(state: StalePeerCandidateAuthState): boolean {
	return state === "revoked" || state === "scope_inactive" || state === "stale_epoch";
}

function stalePeerCandidateDiagnostic(input: {
	importKey: string | null;
	memoryId: number;
	originDeviceId: string | null;
	reason: StalePeerReceivedRowReason;
	scopeId: string | null;
}): StalePeerReceivedRowDiagnostic {
	return {
		memory_id: input.memoryId,
		import_key: input.importKey,
		origin_device_id: input.originDeviceId,
		scope_id: input.scopeId,
		reason: input.reason,
	};
}

export function reconcileStalePeerReceivedRows(
	db: Database,
	options: ReconcileStalePeerReceivedRowsOptions,
): ReconcileStalePeerReceivedRowsResult {
	return reconcileStalePeerReceivedRowsInternal(db, options, true);
}

export function diagnoseStalePeerReceivedRows(
	db: Database,
	options: ReconcileStalePeerReceivedRowsOptions,
): DiagnoseStalePeerReceivedRowsResult {
	const result = reconcileStalePeerReceivedRowsInternal(db, options, false);
	return {
		checked: result.checked,
		would_delete: result.deleted,
		would_delete_memory_ids: result.deleted_memory_ids,
		retained: result.retained,
		ambiguous: result.ambiguous,
	};
}

function clearRefsBeforeMemoryDeletion(db: Database, memoryId: number): void {
	snapshotSessionExportKeysForMemoryIds(db, [memoryId]);
	clearMemoryRefs(db, memoryId);
}

interface StalePeerReceivedRow {
	id: number;
	import_key: string | null;
	origin_device_id: string | null;
	scope_id: string | null;
}

const STALE_PEER_ROW_COLUMNS = "id, import_key, origin_device_id, scope_id";

function stalePeerReceivedRows(
	db: Database,
	peerDeviceId: string | null,
	maxRows: number,
): StalePeerReceivedRow[] {
	if (peerDeviceId === null) {
		return db
			.prepare(
				`SELECT ${STALE_PEER_ROW_COLUMNS} FROM memory_items WHERE active = 1 ORDER BY id LIMIT ?`,
			)
			.all(maxRows) as StalePeerReceivedRow[];
	}
	// A plain equality, so the (origin_device_id, active) index finds the peer's rows.
	return db
		.prepare(`SELECT ${STALE_PEER_ROW_COLUMNS} FROM memory_items
		WHERE origin_device_id = ? AND active = 1 ORDER BY id LIMIT ?`)
		.all(peerDeviceId, maxRows) as StalePeerReceivedRow[];
}

/** A scope whose received rows cleanup can delete: none, the default, or one not authorized. */
function scopeMayHoldStaleRows(db: Database, localDeviceId: string, scopeId: string | null) {
	const scope = cleanText(scopeId);
	if (!scope || scope === DEFAULT_SYNC_SCOPE_ID) return true;
	return !getCachedScopeAuthorization(db, { deviceId: localDeviceId, scopeId: scope }).authorized;
}

/**
 * One peer's rows outside the scopes this device is authorized for. Cleanup retains or
 * diagnoses every row in an authorized scope and deletes none of them, so a caller that
 * only acts on deletions can skip those rows. The scope list comes from the
 * (origin_device_id, active, scope_id) index alone, so a peer with nothing to clean up
 * costs one short index range however many rows it sent.
 */
function stalePeerRowsOutsideAuthorizedScopes(
	db: Database,
	context: { localDeviceId: string; peerDeviceId: string },
	maxRows: number,
): StalePeerReceivedRow[] {
	const scopes = db
		.prepare("SELECT DISTINCT scope_id FROM memory_items WHERE origin_device_id = ? AND active = 1")
		.pluck()
		.all(context.peerDeviceId) as Array<string | null>;
	const inScope = db.prepare(`SELECT ${STALE_PEER_ROW_COLUMNS} FROM memory_items
		WHERE origin_device_id = ? AND active = 1 AND scope_id IS ? ORDER BY id`);
	const rows = scopes
		.filter((scopeId) => scopeMayHoldStaleRows(db, context.localDeviceId, scopeId))
		.flatMap((scopeId) => inScope.all(context.peerDeviceId, scopeId) as StalePeerReceivedRow[])
		.sort((left, right) => left.id - right.id);
	return maxRows < 0 ? rows : rows.slice(0, maxRows);
}

function legacyLocalRetentionScope(db: Database, scopeId: string | null): boolean {
	const scope = cleanText(scopeId);
	if (!scope || scope === DEFAULT_SYNC_SCOPE_ID || scope === LEGACY_SHARED_REVIEW_SCOPE_ID)
		return true;
	return (
		db
			.prepare(`SELECT 1 FROM replication_scopes WHERE scope_id = ?
		AND authority_type IN ('local', 'manual', 'invite')`)
			.get(scope) !== undefined
	);
}

function retainOrDiagnoseLocalRow(
	db: Database,
	row: StalePeerReceivedRow,
	localDeviceId: string,
	creationSources: readonly string[],
	result: ReconcileStalePeerReceivedRowsResult,
): boolean {
	const importKey = cleanText(row.import_key);
	const origin = cleanText(row.origin_device_id);
	const recorded = importKey !== null && hasRecordedLocalCreation(db, importKey);
	if (importKey && hasMatchingLocalCreation(db, importKey, creationSources)) {
		result.retained += 1;
		return true;
	}
	// Legacy labels retain old rows, but cannot override an unmatched creation record.
	if (!recorded && origin === localDeviceId && legacyLocalRetentionScope(db, row.scope_id)) {
		result.retained += 1;
		return true;
	}
	if (!recorded && origin !== localDeviceId && origin !== "local") return false;
	// Preserve uncertain originals; this diagnostic grants no read or write permission.
	result.ambiguous.push(
		stalePeerCandidateDiagnostic({
			memoryId: Number(row.id),
			importKey,
			originDeviceId: origin,
			scopeId: cleanText(row.scope_id),
			reason: "unverified_local_creation",
		}),
	);
	return true;
}

function stalePeerCandidateRows(
	db: Database,
	options: ReconcileStalePeerReceivedRowsOptions,
	context: { localDeviceId: string; peerDeviceId: string | null; maxRows: number },
): StalePeerReceivedRow[] {
	const { localDeviceId, peerDeviceId, maxRows } = context;
	if (options.onlyDeletableScopes && peerDeviceId)
		return stalePeerRowsOutsideAuthorizedScopes(db, { localDeviceId, peerDeviceId }, maxRows);
	return stalePeerReceivedRows(db, peerDeviceId, maxRows);
}

function reconcileStalePeerReceivedRowsInternal(
	db: Database,
	options: ReconcileStalePeerReceivedRowsOptions,
	deleteRows: boolean,
): ReconcileStalePeerReceivedRowsResult {
	const localDeviceId = cleanText(options.localDeviceId);
	if (!localDeviceId) throw new Error("localDeviceId must be a non-empty string");
	const peerDeviceId = cleanText(options.peerDeviceId);
	const maxRows =
		typeof options.maxRows === "number" && Number.isFinite(options.maxRows)
			? Math.max(0, Math.trunc(options.maxRows))
			: -1;
	const rows = stalePeerCandidateRows(db, options, { localDeviceId, peerDeviceId, maxRows });
	const result: ReconcileStalePeerReceivedRowsResult = {
		checked: rows.length,
		deleted: 0,
		deleted_memory_ids: [],
		retained: 0,
		ambiguous: [],
	};
	const deleteMemory = deleteRows ? db.prepare("DELETE FROM memory_items WHERE id = ?") : null;
	const deleteCandidate = (
		memoryId: number,
		cursor?: { originDeviceId: string; scopeId: string },
	): void => {
		if (deleteRows) {
			clearRefsBeforeMemoryDeletion(db, memoryId);
			deleteMemory?.run(memoryId);
			if (cursor && cursor.scopeId !== DEFAULT_SYNC_SCOPE_ID) {
				clearReplicationCursorLastApplied(db, cursor.originDeviceId, cursor.scopeId);
			}
		}
		result.deleted += 1;
		result.deleted_memory_ids.push(memoryId);
	};
	const creationSources = cleanupCreationSourceIds(db, localDeviceId, options);
	db.transaction(() => {
		// Authorization decisions must not survive this synchronous cleanup transaction.
		const authorizationByScope = new Map<string, CachedScopeAuthorizationResult>();
		for (const row of rows) {
			const memoryId = Number(row.id);
			const importKey = cleanText(row.import_key);
			const originDeviceId = cleanText(row.origin_device_id);
			const scopeId = cleanText(row.scope_id);
			if (retainOrDiagnoseLocalRow(db, row, localDeviceId, creationSources, result)) continue;
			if (!originDeviceId) {
				result.ambiguous.push(
					stalePeerCandidateDiagnostic({
						importKey,
						memoryId,
						originDeviceId,
						reason: "missing_origin_device",
						scopeId,
					}),
				);
				continue;
			}
			if (!scopeId || scopeId === DEFAULT_SYNC_SCOPE_ID) {
				deleteCandidate(memoryId);
				continue;
			}
			if (!importKey) {
				result.ambiguous.push(
					stalePeerCandidateDiagnostic({
						importKey,
						memoryId,
						originDeviceId,
						reason: "missing_import_key",
						scopeId,
					}),
				);
				continue;
			}
			let auth = authorizationByScope.get(scopeId);
			if (!auth) {
				auth = getCachedScopeAuthorization(db, { deviceId: localDeviceId, scopeId });
				authorizationByScope.set(scopeId, auth);
			}
			if (auth.authorized) {
				result.retained += 1;
				continue;
			}
			if (!auth.scope) {
				result.ambiguous.push(
					stalePeerCandidateDiagnostic({
						importKey,
						memoryId,
						originDeviceId,
						reason: "authorization_unknown",
						scopeId,
					}),
				);
				continue;
			}
			if (!auth.membership) {
				deleteCandidate(memoryId, { originDeviceId, scopeId });
				continue;
			}
			if (!stalePeerCandidateIsDeletable(auth.state)) {
				result.ambiguous.push(
					stalePeerCandidateDiagnostic({
						importKey,
						memoryId,
						originDeviceId,
						reason: "authorization_unknown",
						scopeId,
					}),
				);
				continue;
			}
			deleteCandidate(memoryId, { originDeviceId, scopeId });
		}
	})();
	return result;
}

export type InboundScopeRejectionReason =
	| "missing_scope"
	| "sender_not_member"
	| "receiver_not_member"
	| "stale_epoch"
	| "scope_mismatch";

export interface InboundScopeRejection {
	op_id: string;
	entity_type: string;
	entity_id: string;
	scope_id: string | null;
	peer_device_id: string | null;
	reason: InboundScopeRejectionReason;
}

export interface InboundScopeValidationOptions {
	peerDeviceId?: string | null;
	enabled?: boolean;
	/**
	 * The peer's pinned fingerprint when the exchange was admitted. The batch
	 * writes nothing if the pairing has gone or pins another key since.
	 */
	pinnedFingerprint?: string;
}

export interface ApplyReplicationOpsOptions extends LocalCreationContext {
	/** Authenticated transport peer, for durable applied-mutation accounting. */
	activityPeerDeviceId?: string;
	/** Keep incoming requests from resolving failures owned by local cursor retries. */
	activitySource?: SyncTransferObservationSource;
	activityOptions?: { preserveError?: boolean };
	inboundScopeValidation?: InboundScopeValidationOptions | null;
	keysDir?: string;
}

function cleanupCreationSourceIds(
	db: Database,
	deviceId: string,
	options: LocalCreationContext & { keysDir?: string },
): string[] {
	return localCreationSourceIds(db, deviceId, {
		...options,
		loadExpectedPublicKey:
			options.loadExpectedPublicKey ??
			(() =>
				loadRuntimeSigningPublicKey(db, {
					deviceId,
					keysDir: options.keysDir ?? process.env.CODEMEM_KEYS_DIR?.trim(),
				}) ?? undefined),
	});
}

type CachedScopeAuthorizationResult = ReturnType<typeof getCachedScopeAuthorization>;

function inboundScopeRejection(
	op: ReplicationOp,
	reason: InboundScopeRejectionReason,
	peerDeviceId: string | null,
	scopeId: string | null,
): InboundScopeRejection {
	return {
		op_id: op.op_id,
		entity_type: op.entity_type,
		entity_id: op.entity_id,
		scope_id: scopeId,
		peer_device_id: peerDeviceId,
		reason,
	};
}

function normalizeInboundScopeId(value: unknown): string | null {
	return cleanText(value);
}

function metadataObject(payload: Record<string, unknown> | null): Record<string, unknown> {
	const metadata = payload?.metadata_json;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
	return metadata as Record<string, unknown>;
}

function payloadContradictsInboundScope(
	opScopeId: string,
	payload: Record<string, unknown> | null,
): boolean {
	const metadata = metadataObject(payload);
	const payloadScopeId = cleanText(payload?.scope_id ?? metadata.scope_id);
	if (payloadScopeId && payloadScopeId !== opScopeId) return true;

	const workspaceId = cleanText(payload?.workspace_id ?? metadata.workspace_id);
	if (workspaceId?.startsWith("personal:") && workspaceId !== opScopeId) return true;

	const workspaceKind = cleanText(
		payload?.workspace_kind ?? metadata.workspace_kind,
	)?.toLowerCase();
	const actorId = cleanText(payload?.actor_id ?? metadata.actor_id);
	if (workspaceKind === "personal" && actorId && `personal:${actorId}` !== opScopeId) {
		return true;
	}

	return false;
}

function authorizationFailureReason(
	auth: CachedScopeAuthorizationResult,
	notMemberReason: "sender_not_member" | "receiver_not_member",
): InboundScopeRejectionReason | null {
	if (auth.scope?.authority_type === "local") return "missing_scope";
	if (auth.authorized) return null;
	if (
		!auth.scope ||
		auth.state === "revoked" ||
		auth.state === "stale_epoch" ||
		auth.state === "scope_unknown" ||
		auth.state === "scope_inactive"
	) {
		return "stale_epoch";
	}
	return notMemberReason;
}

type LocalDefaultOldSideReassignmentValidation =
	| { ok: true; reassignment: ReassignScopePayload }
	| { ok: false; reason: "scope_mismatch" | "sender_not_member" };

function validateLocalDefaultOldSideReassignment(
	db: Database,
	op: ReplicationOp,
	senderDeviceId: string | null,
): LocalDefaultOldSideReassignmentValidation {
	let reassignment: ReassignScopePayload;
	try {
		reassignment = parseReassignScopePayload(op);
	} catch {
		return { ok: false, reason: "scope_mismatch" };
	}
	if (reassignment.side !== "old" || reassignment.old_scope_id !== DEFAULT_SYNC_SCOPE_ID) {
		return { ok: false, reason: "scope_mismatch" };
	}
	if (
		!senderDeviceId ||
		cleanText(op.device_id) !== senderDeviceId ||
		cleanText(op.clock_device_id) !== senderDeviceId
	) {
		return { ok: false, reason: "sender_not_member" };
	}
	const existing = db
		.prepare("SELECT origin_device_id FROM memory_items WHERE import_key = ?")
		.get(op.entity_id) as { origin_device_id: string | null } | undefined;
	if (existing && cleanText(existing.origin_device_id) !== senderDeviceId) {
		return { ok: false, reason: "sender_not_member" };
	}
	return { ok: true, reassignment };
}

function validateInboundScopeOp(
	db: Database,
	op: ReplicationOp,
	localDeviceId: string,
	options: InboundScopeValidationOptions,
): InboundScopeRejection | null {
	const peerDeviceId = cleanText(options.peerDeviceId) ?? cleanText(op.device_id);
	if (op.op_type === ACCESS_CLEANUP_OP_TYPE) {
		const senderDeviceId = peerDeviceId ?? cleanText(op.clock_device_id);
		if (
			!senderDeviceId ||
			cleanText(op.device_id) !== senderDeviceId ||
			cleanText(op.clock_device_id) !== senderDeviceId
		) {
			return inboundScopeRejection(op, "sender_not_member", peerDeviceId, null);
		}
		return null;
	}
	const senderDeviceId = peerDeviceId ?? cleanText(op.clock_device_id);
	const receiverDeviceId = cleanText(localDeviceId);
	const opScopeId = normalizeInboundScopeId(op.scope_id);

	if (!opScopeId) return inboundScopeRejection(op, "missing_scope", peerDeviceId, null);
	const payload = parsePayload(op.payload_json);
	if (payloadContradictsInboundScope(opScopeId, payload)) {
		return inboundScopeRejection(op, "scope_mismatch", peerDeviceId, opScopeId);
	}

	if (
		!senderDeviceId ||
		cleanText(op.device_id) !== senderDeviceId ||
		cleanText(op.clock_device_id) !== senderDeviceId
	) {
		return inboundScopeRejection(op, "sender_not_member", peerDeviceId, opScopeId);
	}
	let authorizationScopeId = opScopeId;
	let requireReceiverMembership = true;
	let allowLocalAuthorityRetraction = false;
	if (opScopeId === DEFAULT_SYNC_SCOPE_ID) {
		const validation = validateLocalDefaultOldSideReassignment(db, op, senderDeviceId);
		if (!validation.ok) {
			return inboundScopeRejection(op, validation.reason, peerDeviceId, opScopeId);
		}
		authorizationScopeId = validation.reassignment.new_scope_id;
		allowLocalAuthorityRetraction = true;
		// This side only retracts sender-origin data previously delivered through
		// local-default. Prior recipients intentionally are not members of the new
		// boundary, and the apply path cannot create a new-scope row for them.
		requireReceiverMembership = false;
	}

	const senderAuth = getPeerCachedScopeAuthorization(db, {
		deviceId: senderDeviceId,
		scopeId: authorizationScopeId,
	});
	// A validated old-side op only retracts a sender-owned local-default row;
	// it cannot create data in the destination scope. Permit that removal when
	// the receiver cannot know the sender's new device-local scope.
	const senderFailure =
		allowLocalAuthorityRetraction &&
		(senderAuth.authorized || (senderAuth.state === "not_authorized" && !senderAuth.scope))
			? null
			: authorizationFailureReason(senderAuth, "sender_not_member");
	if (senderFailure) return inboundScopeRejection(op, senderFailure, peerDeviceId, opScopeId);

	if (requireReceiverMembership) {
		if (!receiverDeviceId) {
			return inboundScopeRejection(op, "receiver_not_member", peerDeviceId, opScopeId);
		}
		const receiverAuth = getPeerCachedScopeAuthorization(db, {
			deviceId: receiverDeviceId,
			scopeId: authorizationScopeId,
		});
		const receiverFailure = authorizationFailureReason(receiverAuth, "receiver_not_member");
		if (receiverFailure) return inboundScopeRejection(op, receiverFailure, peerDeviceId, opScopeId);
	}

	return null;
}

function validateInboundScopeBatch(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
	options: InboundScopeValidationOptions,
): InboundScopeRejection[] {
	const rejections: InboundScopeRejection[] = [];
	const expectedPeerDeviceId = cleanText(options.peerDeviceId);
	for (const op of ops) {
		if (!expectedPeerDeviceId && op.device_id === localDeviceId) continue;
		const rejection = validateInboundScopeOp(db, op, localDeviceId, options);
		if (rejection) rejections.push(rejection);
	}
	return rejections;
}

function validateInboundLocalOnlyBatch(
	db: Database,
	ops: ReplicationOp[],
	options: InboundScopeValidationOptions,
): InboundScopeRejection[] {
	const peerDeviceId = cleanText(options.peerDeviceId);
	const rejections: InboundScopeRejection[] = [];
	for (const op of ops) {
		if (op.entity_type !== "memory_item" || op.op_type === ACCESS_CLEANUP_OP_TYPE) continue;
		const scopeId = normalizeInboundScopeId(op.scope_id);
		if (!scopeId) {
			rejections.push(inboundScopeRejection(op, "missing_scope", peerDeviceId, null));
			continue;
		}
		if (scopeId !== DEFAULT_SYNC_SCOPE_ID) {
			const scope = db
				.prepare("SELECT authority_type FROM replication_scopes WHERE scope_id = ? LIMIT 1")
				.get(scopeId) as { authority_type?: string | null } | undefined;
			if (scope?.authority_type === "local" || (!scope && options.enabled === false)) {
				rejections.push(inboundScopeRejection(op, "missing_scope", peerDeviceId, scopeId));
			}
			continue;
		}
		if (op.op_type === REASSIGN_SCOPE_OP_TYPE) {
			const validation = validateLocalDefaultOldSideReassignment(
				db,
				op,
				peerDeviceId ?? cleanText(op.clock_device_id),
			);
			if (validation.ok) continue;
			if (validation.reason === "sender_not_member") {
				rejections.push(inboundScopeRejection(op, validation.reason, peerDeviceId, scopeId));
				continue;
			}
		}
		rejections.push(inboundScopeRejection(op, "scope_mismatch", peerDeviceId, scopeId));
	}
	return rejections;
}

function ensureSyncScopeRejectionLogTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_scope_rejections (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			peer_device_id TEXT,
			op_id TEXT NOT NULL,
			entity_type TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			scope_id TEXT,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_sync_scope_rejections_peer_created
			ON sync_scope_rejections(peer_device_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_sync_scope_rejections_scope_created
			ON sync_scope_rejections(scope_id, created_at);
	`);
}

function recordInboundScopeRejections(db: Database, rejections: InboundScopeRejection[]): void {
	if (rejections.length === 0) return;
	ensureSyncScopeRejectionLogTable(db);
	const now = new Date().toISOString();
	const insert = db.prepare(
		`INSERT INTO sync_scope_rejections(
			peer_device_id, op_id, entity_type, entity_id, scope_id, reason, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	db.transaction(() => {
		for (const rejection of rejections) {
			insert.run(
				rejection.peer_device_id,
				rejection.op_id,
				rejection.entity_type,
				rejection.entity_id,
				rejection.scope_id,
				rejection.reason,
				now,
			);
		}
	})();
}

function emptyApplyResult(): ApplyResult {
	return {
		applied: 0,
		skipped: 0,
		rejected: 0,
		conflicts: 0,
		errors: [],
		rejections: [],
		vectorWork: { upsertMemoryIds: [], deleteMemoryIds: [] },
	};
}

export function rejectInboundScopeFailures(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
	options: InboundScopeValidationOptions,
): ApplyResult | null {
	const localOnlyRejections = validateInboundLocalOnlyBatch(db, ops, options);
	const rejections =
		localOnlyRejections.length > 0
			? localOnlyRejections
			: options.enabled === false
				? []
				: validateInboundScopeBatch(db, ops, localDeviceId, options);
	if (rejections.length === 0) return null;
	return inboundRejectionResult(db, rejections);
}

function inboundRejectionResult(db: Database, rejections: InboundScopeRejection[]): ApplyResult {
	const result = emptyApplyResult();
	result.rejected = rejections.length;
	result.rejections = rejections;
	result.errors.push(
		...rejections.map((rejection) => `op ${rejection.op_id}: rejected — ${rejection.reason}`),
	);
	try {
		recordInboundScopeRejections(db, rejections);
	} catch (err) {
		result.errors.push(
			`scope rejection log failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return result;
}

/** Aggregate counts of recorded inbound-scope rejections per peer device. */
export interface InboundScopeRejectionPeerSummary {
	peer_device_id: string | null;
	total: number;
	by_reason: Partial<Record<InboundScopeRejectionReason, number>>;
	last_at: string | null;
}

export interface InboundScopeRejectionSummaryOptions {
	/** ISO timestamp; rejections older than this are ignored. */
	sinceIso?: string;
	/** Optional: only summarize rejections recorded for this peer. */
	peerDeviceId?: string | null;
}

/**
 * Read-only summary of recorded inbound-scope rejections grouped by peer.
 * Pure aggregate over the rejection log — never reads payloads (the log
 * does not store any). Used by the sync API to render reason-code
 * breakdowns without exposing op contents.
 */
export function summarizeInboundScopeRejections(
	db: Database,
	options: InboundScopeRejectionSummaryOptions = {},
): InboundScopeRejectionPeerSummary[] {
	if (!syncScopeRejectionsTableExists(db)) return [];
	const params: unknown[] = [];
	const filters: string[] = [];
	if (options.sinceIso) {
		filters.push(`created_at >= ?`);
		params.push(options.sinceIso);
	}
	if (options.peerDeviceId !== undefined) {
		const id = cleanText(options.peerDeviceId);
		if (id === null) {
			filters.push(`peer_device_id IS NULL`);
		} else {
			filters.push(`peer_device_id = ?`);
			params.push(id);
		}
	}
	const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
	const rows = db
		.prepare(
			`SELECT peer_device_id, reason, COUNT(*) AS count, MAX(created_at) AS last_at
			   FROM sync_scope_rejections
			   ${where}
			  GROUP BY peer_device_id, reason`,
		)
		.all(...params) as Array<{
		peer_device_id: string | null;
		reason: string;
		count: number;
		last_at: string | null;
	}>;

	const summaries = new Map<string, InboundScopeRejectionPeerSummary>();
	for (const row of rows) {
		const key = row.peer_device_id ?? "";
		let entry = summaries.get(key);
		if (!entry) {
			entry = {
				peer_device_id: row.peer_device_id ?? null,
				total: 0,
				by_reason: {},
				last_at: null,
			};
			summaries.set(key, entry);
		}
		const reason = row.reason as InboundScopeRejectionReason;
		const count = Number(row.count ?? 0);
		entry.by_reason[reason] = (entry.by_reason[reason] ?? 0) + count;
		entry.total += count;
		if (row.last_at && (!entry.last_at || row.last_at > entry.last_at)) {
			entry.last_at = row.last_at;
		}
	}
	return Array.from(summaries.values());
}

export interface InboundScopeRejectionRecord extends InboundScopeRejection {
	id: number;
	created_at: string;
}

export interface ListInboundScopeRejectionsOptions {
	peerDeviceId?: string | null;
	sinceIso?: string;
	limit?: number;
}

/**
 * List recently recorded inbound-scope rejections (newest first). Each row
 * is metadata only — op id, entity ref, scope id, reason, timestamp — and
 * never includes op payloads (the log does not store them).
 */
export function listInboundScopeRejections(
	db: Database,
	options: ListInboundScopeRejectionsOptions = {},
): InboundScopeRejectionRecord[] {
	if (!syncScopeRejectionsTableExists(db)) return [];
	const params: unknown[] = [];
	const filters: string[] = [];
	if (options.sinceIso) {
		filters.push(`created_at >= ?`);
		params.push(options.sinceIso);
	}
	if (options.peerDeviceId !== undefined) {
		const id = cleanText(options.peerDeviceId);
		if (id === null) {
			filters.push(`peer_device_id IS NULL`);
		} else {
			filters.push(`peer_device_id = ?`);
			params.push(id);
		}
	}
	const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
	const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
	const rows = db
		.prepare(
			`SELECT id, peer_device_id, op_id, entity_type, entity_id, scope_id, reason, created_at
			   FROM sync_scope_rejections
			   ${where}
			  ORDER BY created_at DESC, id DESC
			  LIMIT ?`,
		)
		.all(...params, limit) as Array<{
		id: number;
		peer_device_id: string | null;
		op_id: string;
		entity_type: string;
		entity_id: string;
		scope_id: string | null;
		reason: string;
		created_at: string;
	}>;
	return rows.map((row) => ({
		id: Number(row.id),
		peer_device_id: row.peer_device_id ?? null,
		op_id: row.op_id,
		entity_type: row.entity_type,
		entity_id: row.entity_id,
		scope_id: row.scope_id ?? null,
		reason: row.reason as InboundScopeRejectionReason,
		created_at: row.created_at,
	}));
}

function syncScopeRejectionsTableExists(db: Database): boolean {
	const row = db
		.prepare(
			`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_scope_rejections' LIMIT 1`,
		)
		.get();
	return Boolean(row);
}

const LEGACY_IMPORT_KEY_OLD_RE = /^legacy:memory_item:(.+)$/;

/** The columns the legacy import key migration reads from one memory row. */
export interface LegacyImportKeyRow {
	id: number;
	import_key: string | null;
	metadata_json: string | null;
}

/**
 * What the migration did with one row. `blocked` means the device-scoped key the row
 * would get already belongs to another memory, so the row keeps its legacy key.
 */
export type LegacyImportKeyOutcome = "unchanged" | "migrated" | "blocked";

/** The local device ID that legacy rows without a recorded origin are attributed to. */
export function localReplicationDeviceId(db: Database): string {
	const deviceRow = drizzle(db, { schema })
		.select({ device_id: schema.syncDevice.device_id })
		.from(schema.syncDevice)
		.limit(1)
		.get();
	return String(deviceRow?.device_id ?? "").trim();
}

function canonicalLegacyImportKey(row: LegacyImportKeyRow, localDeviceId: string): string {
	const memoryId = Number(row.id);
	const current = String(row.import_key ?? "").trim();
	if (!current) return `legacy:${localDeviceId}:memory_item:${memoryId}`;
	const match = current.match(LEGACY_IMPORT_KEY_OLD_RE);
	if (!match) return "";
	const metadata = fromJson(row.metadata_json);
	const clockDeviceId =
		typeof metadata.clock_device_id === "string" ? metadata.clock_device_id.trim() : "";
	const origin = clockDeviceId && clockDeviceId !== "local" ? clockDeviceId : localDeviceId;
	return origin ? `legacy:${origin}:memory_item:${match[1] ?? ""}` : "";
}

/** Rewrite one row's legacy import key into its device-scoped form. */
export function migrateLegacyImportKeyForRow(
	db: Database,
	row: LegacyImportKeyRow,
	localDeviceId: string,
): LegacyImportKeyOutcome {
	const memoryId = Number(row.id);
	const current = String(row.import_key ?? "").trim();
	const canonical = canonicalLegacyImportKey(row, localDeviceId);
	if (!canonical || canonical === current) return "unchanged";

	const existing = drizzle(db, { schema })
		.select({ id: schema.memoryItems.id })
		.from(schema.memoryItems)
		.where(eq(schema.memoryItems.import_key, canonical))
		.limit(1)
		.get();
	if (existing && Number(existing.id) !== memoryId) return "blocked";

	assignMemoryImportKey(db, memoryId, canonical);
	return "migrated";
}

/**
 * Rewrite legacy import keys into globally unique, device-scoped keys.
 *
 * Older databases may contain keys like `legacy:memory_item:<id>`, which can
 * collide across peers. This rewrites them to
 * `legacy:<device_id>:memory_item:<id>`.
 */
export function migrateLegacyImportKeys(db: Database, limit = 2000): number {
	const d = drizzle(db, { schema });
	const localDeviceId = localReplicationDeviceId(db);
	if (!localDeviceId) return 0;

	const rows = d
		.select({
			id: schema.memoryItems.id,
			import_key: schema.memoryItems.import_key,
			metadata_json: schema.memoryItems.metadata_json,
		})
		.from(schema.memoryItems)
		.where(
			or(
				isNull(schema.memoryItems.import_key),
				sql`TRIM(${schema.memoryItems.import_key}) = ''`,
				like(schema.memoryItems.import_key, "legacy:memory_item:%"),
			),
		)
		.orderBy(schema.memoryItems.id)
		.limit(limit)
		.all();

	let updated = 0;
	for (const row of rows) {
		if (migrateLegacyImportKeyForRow(db, row, localDeviceId) === "migrated") updated++;
	}
	return updated;
}

function assignMemoryImportKey(db: Database, memoryId: number, importKey: string): void {
	db.transaction(() => {
		snapshotSessionExportKeysForMemoryIds(db, [memoryId]);
		db.prepare("UPDATE memory_items SET import_key = ? WHERE id = ?").run(importKey, memoryId);
	}).immediate();
}

/** The device a backfilled op is attributed to: the row's recorded clock device, else this one. */
function backfillOriginDeviceId(row: MemoryItemRow, localDeviceId: string): string {
	const metadata =
		typeof row.metadata_json === "string"
			? fromJson(row.metadata_json)
			: fromJsonNullableLike(row.metadata_json);
	const clockDeviceId =
		typeof metadata.clock_device_id === "string" ? metadata.clock_device_id.trim() : "";
	return clockDeviceId && clockDeviceId !== "local" ? clockDeviceId : localDeviceId;
}

/** The row's import key, assigning a device-scoped one when it has none. */
function backfillImportKey(db: Database, row: MemoryItemRow, originDeviceId: string): string {
	const importKey = String(row.import_key ?? "").trim();
	if (importKey || !originDeviceId) return importKey;
	const assigned = `legacy:${originDeviceId}:memory_item:${Number(row.id)}`;
	assignMemoryImportKey(db, Number(row.id), assigned);
	return assigned;
}

/**
 * Write the replication op one memory row lacks for its current revision. Returns false when
 * the row cannot get one: it has no ID or origin device, or the op already exists.
 */
export function insertBackfillReplicationOp(
	db: Database,
	row: MemoryItemRow,
	localDeviceId: string,
	now: string,
): boolean {
	const d = drizzle(db, { schema });
	const rowId = Number(row.id ?? 0);
	if (!rowId) return false;

	const originDeviceId = backfillOriginDeviceId(row, localDeviceId);
	const importKey = backfillImportKey(db, row, originDeviceId);
	if (!importKey) return false;

	const rev = Number(row.rev ?? 0);
	const deletedAt = String(row.deleted_at ?? "").trim();
	const opType = deletedAt || Number(row.active ?? 1) === 0 ? "delete" : "upsert";
	const opId = `backfill:memory_item:${importKey}:${rev}:${opType}`;

	const exists = d
		.select({ one: sql<number>`1` })
		.from(schema.replicationOps)
		.where(eq(schema.replicationOps.op_id, opId))
		.limit(1)
		.get();
	if (exists || !originDeviceId) return false;
	const scopeId = ensureMemoryScopeId(db, rowId);
	const payload = buildPayloadFromMemoryRow({ ...row, scope_id: scopeId });

	d.insert(schema.replicationOps)
		.values({
			op_id: opId,
			entity_type: "memory_item",
			entity_id: importKey,
			op_type: opType,
			payload_json: toJson(payload),
			clock_rev: rev,
			clock_updated_at: String(row.updated_at ?? now),
			clock_device_id: originDeviceId,
			device_id: originDeviceId,
			created_at: now,
			scope_id: scopeId,
		})
		.onConflictDoNothing()
		.run();
	recordOpCopy(db, opId, rowId);
	return true;
}

/**
 * Generate replication ops for rows that predate replication.
 *
 * Prioritizes delete/tombstone ops first, then active upserts, and only
 * generates ops when a matching op for the same entity/rev/op_type is missing.
 *
 * This scans every memory on each call. The sync pass and the maintenance worker use
 * the incremental pass in `replication-backfill.ts` instead.
 */
export function backfillReplicationOps(db: Database, limit = 200): number {
	if (limit <= 0) return 0;

	migrateLegacyImportKeys(db, 2000);

	const d = drizzle(db, { schema });
	const localDeviceId = localReplicationDeviceId(db);

	const deletedRows = d
		.select()
		.from(schema.memoryItems)
		.where(
			and(
				or(isNotNull(schema.memoryItems.deleted_at), eq(schema.memoryItems.active, 0)),
				sql`NOT EXISTS (
					SELECT 1
					FROM replication_ops ro
					WHERE ro.entity_type = 'memory_item'
					  AND ro.entity_id = ${schema.memoryItems.import_key}
					  AND ro.op_type = 'delete'
					  AND ro.clock_rev = COALESCE(${schema.memoryItems.rev}, 0)
				)`,
			),
		)
		.orderBy(schema.memoryItems.updated_at)
		.limit(limit)
		.all();

	const remaining = Math.max(0, limit - deletedRows.length);
	let rows = deletedRows;
	if (remaining > 0) {
		const upsertRows = d
			.select()
			.from(schema.memoryItems)
			.where(
				and(
					isNull(schema.memoryItems.deleted_at),
					eq(schema.memoryItems.active, 1),
					sql`NOT EXISTS (
						SELECT 1
						FROM replication_ops ro
						WHERE ro.entity_type = 'memory_item'
						  AND ro.entity_id = ${schema.memoryItems.import_key}
						  AND ro.op_type = 'upsert'
						  AND ro.clock_rev = COALESCE(${schema.memoryItems.rev}, 0)
					)`,
				),
			)
			.orderBy(schema.memoryItems.updated_at)
			.limit(remaining)
			.all();
		rows = [...rows, ...upsertRows];
	}

	const now = new Date().toISOString();
	let inserted = 0;
	for (const row of rows) {
		if (insertBackfillReplicationOp(db, row, localDeviceId, now)) inserted++;
	}
	return inserted;
}

function fromJsonNullableLike(value: unknown): Record<string, unknown> {
	if (typeof value === "string") return fromJson(value);
	if (value && typeof value === "object") return value as Record<string, unknown>;
	return {};
}

function buildPayloadFromMemoryRow(row: MemoryItemRow): MemoryPayload {
	const parseSqliteJson = (val: unknown): unknown => {
		if (typeof val !== "string") return val ?? null;
		try {
			return JSON.parse(val);
		} catch {
			return val;
		}
	};
	const metadataParsed = parseSqliteJson(row.metadata_json);
	const metadataJson =
		metadataParsed && typeof metadataParsed === "object" && !Array.isArray(metadataParsed)
			? (metadataParsed as Record<string, unknown>)
			: {};

	return {
		session_id: row.session_id ?? null,
		kind: row.kind ?? null,
		title: row.title ?? null,
		subtitle: row.subtitle ?? null,
		body_text: row.body_text ?? null,
		confidence: row.confidence ?? null,
		tags_text: row.tags_text ?? null,
		active: row.active ?? null,
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
		metadata_json: metadataJson,
		actor_id: row.actor_id ?? null,
		actor_display_name: row.actor_display_name ?? null,
		visibility: row.visibility ?? null,
		workspace_id: row.workspace_id ?? null,
		workspace_kind: row.workspace_kind ?? null,
		origin_device_id: row.origin_device_id ?? null,
		origin_source: row.origin_source ?? null,
		trust_state: row.trust_state ?? null,
		narrative: row.narrative ?? null,
		facts: parseSqliteJson(row.facts),
		concepts: parseSqliteJson(row.concepts),
		files_read: parseSqliteJson(row.files_read),
		files_modified: parseSqliteJson(row.files_modified),
		user_prompt_id: row.user_prompt_id ?? null,
		prompt_number: row.prompt_number ?? null,
		deleted_at: row.deleted_at ?? null,
		scope_id: row.scope_id ?? null,
		has_deleted_at: row.deleted_at != null,
		rev: row.rev ?? 0,
		import_key: row.import_key ?? null,
		// Denormalized project from memory_items so the outbound payload
		// carries it without a session join. Callers may still override with
		// sessions.project for legacy rows whose memory_items.project is null.
		project: row.project ?? null,
	};
}

/**
 * Apply inbound replication ops from a remote peer.
 *
 * Runs all ops in a single transaction. For each op:
 * - Skips if device_id matches localDeviceId (don't re-apply own ops)
 * - Skips if op_id already exists (idempotent)
 * - For upsert: finds existing memory by import_key; if existing has a newer
 *   clock, counts as conflict and skips; otherwise INSERT or UPDATE
 * - For delete: soft-deletes (active=0, deleted_at) by import_key
 * - Records the applied op in replication_ops
 */
/**
 * A scope's snapshot is not served to a peer with a pending deny, or at all when
 * this device withdrew from that Project, its own memories included.
 */
function snapshotScopeBlocked(db: Database, scopeId: string, peerDeviceId: string | null): boolean {
	if (isProjectScopeWithdrawn(db, scopeId)) return true;
	return Boolean(
		peerDeviceId && isScopeDeviceAdmissionRefused(db, { scopeId, deviceId: peerDeviceId }),
	);
}

function opInWithdrawnScope(db: Database, op: ReplicationOp): boolean {
	const scopeId = cleanText(op.scope_id);
	return Boolean(scopeId) && isProjectScopeWithdrawn(db, scopeId as string);
}

/** Drops ops for Projects this device has withdrawn from, for a send that started before the withdrawal. */
export function withoutWithdrawnScopeOps(db: Database, ops: ReplicationOp[]): ReplicationOp[] {
	return ops.filter((op) => !opInWithdrawnScope(db, op));
}

function rejectUnretiredScopeFailures(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
	options: InboundScopeValidationOptions,
): ApplyResult | null {
	// Withdrawn and retired ops are skipped later rather than rejected, so the peer
	// keeps syncing everything else.
	const eligible = ops.filter(
		(op) => !retirementBlocksMemoryOp(db, op) && !opInWithdrawnScope(db, op),
	);
	const rejected = rejectInboundScopeFailures(db, eligible, localDeviceId, options);
	if (rejected) rejected.skipped += ops.length - eligible.length;
	return rejected;
}

/**
 * Whether an op would change a memory this device stores more than one copy of.
 * Its clock would be compared against one copy and the others left to diverge,
 * so it applies to none of them until all but one are removed. A cleanup notice
 * still applies, since it only removes copies.
 */
function opTargetsAmbiguousCopies(db: Database, op: ReplicationOp): boolean {
	if (op.entity_type !== "memory_item" || op.op_type === ACCESS_CLEANUP_OP_TYPE) return false;
	return (
		Number(
			db
				.prepare("SELECT COUNT(*) FROM memory_items WHERE import_key = ?")
				.pluck()
				.get(op.entity_id),
		) > 1
	);
}

function skipOwnRetiredOrAppliedOp(
	db: Database,
	d: ReturnType<typeof drizzle>,
	op: ReplicationOp,
	localDeviceId: string,
): boolean {
	if (skipOwnOrRetiredMemoryOp(db, op, localDeviceId)) return true;
	// Not recorded as applied, so a re-pull after the withdrawal ends applies it.
	if (opInWithdrawnScope(db, op)) return true;
	// Not recorded either: which copy the op would change is unclear until repaired.
	if (opTargetsAmbiguousCopies(db, op)) return true;
	return (
		d
			.select({ one: sql<number>`1` })
			.from(schema.replicationOps)
			.where(eq(schema.replicationOps.op_id, op.op_id))
			.get() !== undefined
	);
}

function rollbackReplicationOp(
	db: Database,
	result: ApplyResult,
	vectorWork: Map<number, "upsert" | "delete">,
): void {
	db.exec("ROLLBACK TO codemem_replication_op");
	result.applied = 0;
	result.skipped = 0;
	result.conflicts = 0;
	vectorWork.clear();
}

function finishReplicationOp(
	db: Database,
	result: ApplyResult,
	effects: {
		batchResult: ApplyResult;
		opVectorWork: Map<number, "upsert" | "delete">;
		upsertMemoryIds: Set<number>;
		deleteMemoryIds: Set<number>;
		activityPeer?: string;
	},
	opId: string,
): void {
	recordAppliedReceipt(db, effects.activityPeer, result.applied, opId);
	db.exec("RELEASE codemem_replication_op");
	effects.batchResult.applied += result.applied;
	effects.batchResult.skipped += result.skipped;
	effects.batchResult.conflicts += result.conflicts;
	effects.batchResult.errors.push(...result.errors);
	for (const [memoryId, operation] of effects.opVectorWork) {
		if (operation === "upsert") {
			effects.deleteMemoryIds.delete(memoryId);
			effects.upsertMemoryIds.add(memoryId);
		} else {
			effects.upsertMemoryIds.delete(memoryId);
			effects.deleteMemoryIds.add(memoryId);
		}
	}
}

function recordAppliedReceipt(
	db: Database,
	peer: string | undefined,
	applied: number,
	opId: string,
): void {
	if (peer && applied > 0) recordSyncTransferReceipts(db, peer, "receive", [opId]);
}

function applyAccessCleanupForLocalDevice(
	db: Database,
	d: ReturnType<typeof drizzle>,
	op: ReplicationOp,
	context: {
		localDeviceId: string;
		queueVectorDelete: (memoryId: number) => void;
	},
): boolean {
	const cleanup = parseAccessCleanupPayload(op);
	if (!cleanup.cleanup_scope_id) return false;
	const existing = d
		.select({
			id: schema.memoryItems.id,
			origin_device_id: schema.memoryItems.origin_device_id,
			scope_id: schema.memoryItems.scope_id,
		})
		.from(schema.memoryItems)
		.where(eq(schema.memoryItems.import_key, op.entity_id))
		.limit(1)
		.get();
	if (!existing) return true;
	if (hasRecordedLocalCreation(db, op.entity_id)) return false;
	const sourceDeviceId = cleanText(op.clock_device_id) ?? cleanText(op.device_id);
	// The creator by immutable evidence; the stored origin only for historical ids that name none.
	const creatorDeviceId =
		verifiedMemoryCreator(db, op.entity_id) ?? cleanText(existing.origin_device_id);
	if (!sourceDeviceId || !creatorDeviceId || creatorDeviceId !== sourceDeviceId) return false;
	// Local-looking labels preserve ambiguous data, never prove authorship.
	if (creatorDeviceId === context.localDeviceId || creatorDeviceId === "local") return false;
	if (cleanText(existing.scope_id) !== cleanup.cleanup_scope_id) return false;
	clearRefsBeforeMemoryDeletion(db, Number(existing.id));
	d.delete(schema.memoryItems).where(eq(schema.memoryItems.id, existing.id)).run();
	context.queueVectorDelete(Number(existing.id));
	return true;
}

export function applyReplicationOps(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
	scanner?: SecretScanner,
	options: ApplyReplicationOpsOptions = {},
): ApplyResult {
	const peer = options.activityPeerDeviceId;
	if (!peer) return applyReplicationOpsInternal(db, ops, localDeviceId, scanner, options);
	ensureSyncTransferActivitySchema(db);
	try {
		return db.transaction(() => {
			const result = applyReplicationOpsInternal(db, ops, localDeviceId, scanner, {
				...options,
				activityPeerDeviceId: peer,
			});
			let errorCode: "scope_rejected" | "apply_failed" | undefined;
			if (result.rejected > 0) errorCode = "scope_rejected";
			else if (result.errors.length > 0) errorCode = "apply_failed";
			recordSyncTransferObservation(db, peer, "receive", {
				...options.activityOptions,
				errorCode,
				source: options.activitySource,
			});
			return result;
		})();
	} catch (error) {
		recordSyncTransferObservation(db, peer, "receive", {
			errorCode: "apply_failed",
			source: options.activitySource,
		});
		throw error;
	}
}

function applyReplicationOpsInternal(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
	scanner: SecretScanner | undefined,
	options: ApplyReplicationOpsOptions,
): ApplyResult {
	const d = drizzle(db, { schema });
	// Peer-shipped content goes through the same redaction policy as
	// locally-authored writes. Callers that maintain their own scanner
	// (typically a MemoryStore instance) should pass it so workspace-level
	// rule overrides apply uniformly. Otherwise fall back to defaults.
	const activeScanner = scanner ?? new SecretScanner();
	const result: ApplyResult = emptyApplyResult();
	const rejected = rejectedInboundBatch(db, ops, localDeviceId, options);
	if (rejected) return rejected;
	const upsertMemoryIds = new Set<number>();
	const deleteMemoryIds = new Set<number>();
	const opVectorWork = new Map<number, "upsert" | "delete">();
	const queueVectorUpsert = (memoryId: number): void => {
		if (!Number.isInteger(memoryId) || memoryId <= 0) return;
		opVectorWork.set(memoryId, "upsert");
	};
	const queueVectorDelete = (memoryId: number): void => {
		if (!Number.isInteger(memoryId) || memoryId <= 0) return;
		opVectorWork.set(memoryId, "delete");
	};
	const applyAccessCleanupOp = (op: ReplicationOp): boolean =>
		applyAccessCleanupForLocalDevice(db, d, op, { localDeviceId, queueVectorDelete });

	const effects = {
		batchResult: result,
		opVectorWork,
		upsertMemoryIds,
		deleteMemoryIds,
		activityPeer: options.activityPeerDeviceId,
	};
	const applyAll = db.transaction(() => {
		for (const op of ops) {
			const result = emptyApplyResult();
			opVectorWork.clear();
			// Per-op failures must roll back content, provenance, refs, and op acknowledgement together.
			db.exec("SAVEPOINT codemem_replication_op");
			try {
				// Skip own, retired, and already-applied ops.
				if (skipOwnRetiredOrAppliedOp(db, d, op, localDeviceId)) {
					result.skipped++;
					continue;
				}

				const reassignment =
					op.op_type === REASSIGN_SCOPE_OP_TYPE ? parseReassignScopePayload(op) : null;
				if (reassignment?.side === "old") {
					const current = d
						.select({
							id: schema.memoryItems.id,
							origin_device_id: schema.memoryItems.origin_device_id,
							rev: schema.memoryItems.rev,
							updated_at: schema.memoryItems.updated_at,
							metadata_json: schema.memoryItems.metadata_json,
							scope_id: schema.memoryItems.scope_id,
						})
						.from(schema.memoryItems)
						.where(eq(schema.memoryItems.import_key, op.entity_id))
						.get();
					if (
						!current ||
						(cleanText(current.scope_id) ?? DEFAULT_SYNC_SCOPE_ID) !== reassignment.old_scope_id
					) {
						insertReplicationOpRow(d, op);
						result.skipped++;
						continue;
					}
					if (reassignment.old_scope_id === DEFAULT_SYNC_SCOPE_ID) {
						const senderDeviceId = cleanText(op.clock_device_id);
						const originDeviceId = cleanText(current.origin_device_id);
						if (
							!senderDeviceId ||
							cleanText(op.device_id) !== senderDeviceId ||
							!originDeviceId ||
							originDeviceId !== senderDeviceId ||
							originDeviceId === localDeviceId
						) {
							throw new Error("reassign_origin_mismatch");
						}
					}
					const currentClock = clockTuple(
						current.rev ?? 0,
						current.updated_at ?? "",
						clockDeviceIdFromMetadataJson(current.metadata_json),
					);
					const incomingClock = clockTuple(op.clock_rev, op.clock_updated_at, op.clock_device_id);
					if (!isNewerClock(incomingClock, currentClock)) {
						insertReplicationOpRow(d, op);
						result.conflicts++;
						continue;
					}
					const metadata = foreignRevisionMetadata(db, op, current.metadata_json);
					metadata.last_scope_reassignment = reassignment;
					d.update(schema.memoryItems)
						.set({
							active: 0,
							deleted_at: op.clock_updated_at,
							rev: op.clock_rev,
							updated_at: op.clock_updated_at,
							metadata_json: toJson(metadata),
						})
						.where(eq(schema.memoryItems.id, current.id))
						.run();
					queueVectorDelete(Number(current.id));
					insertReplicationOpRow(d, op);
					result.applied++;
					continue;
				}

				if (op.op_type === ACCESS_CLEANUP_OP_TYPE) {
					const cleaned = applyAccessCleanupOp(op);
					insertReplicationOpRow(d, op);
					if (cleaned) result.applied++;
					else result.skipped++;
					continue;
				}

				if (op.op_type === "upsert" || reassignment?.side === "new") {
					const importKey = op.entity_id;
					const opScopeId =
						typeof op.scope_id === "string" && op.scope_id.trim().length > 0
							? op.scope_id.trim()
							: null;
					const memRow = d
						.select({
							id: schema.memoryItems.id,
							rev: schema.memoryItems.rev,
							updated_at: schema.memoryItems.updated_at,
							title: schema.memoryItems.title,
							body_text: schema.memoryItems.body_text,
							active: schema.memoryItems.active,
							deleted_at: schema.memoryItems.deleted_at,
							metadata_json: schema.memoryItems.metadata_json,
							scope_id: schema.memoryItems.scope_id,
						})
						.from(schema.memoryItems)
						.where(eq(schema.memoryItems.import_key, importKey))
						.get();

					if (memRow) {
						const existingClockDeviceId = clockDeviceIdFromMetadataJson(memRow.metadata_json);
						const existingClock = clockTuple(
							memRow.rev ?? 0,
							memRow.updated_at ?? "",
							existingClockDeviceId,
						);
						const opClock = clockTuple(op.clock_rev, op.clock_updated_at, op.clock_device_id);

						const sameReassignmentClock =
							reassignment?.side === "new" &&
							opClock[0] === existingClock[0] &&
							opClock[1] === existingClock[1] &&
							opClock[2] === existingClock[2] &&
							(cleanText(memRow.scope_id) ?? DEFAULT_SYNC_SCOPE_ID) === reassignment.old_scope_id;
						if (
							reassignment &&
							![reassignment.old_scope_id, reassignment.new_scope_id].includes(
								cleanText(memRow.scope_id) ?? DEFAULT_SYNC_SCOPE_ID,
							)
						) {
							throw new Error("reassign_existing_scope_mismatch");
						}
						if (!isNewerClock(opClock, existingClock) && !sameReassignmentClock) {
							result.conflicts++;
							// Still record the op so we don't re-process it
							insertReplicationOpRow(d, op);
							continue;
						}

						// Update existing row from payload — skip if malformed
						const payload = parseMemoryPayload(op, result.errors);
						if (!payload) {
							// A malformed payload can never be applied. Record the op so
							// it is acknowledged exactly once (not re-parsed and re-errored
							// every pass) and the inbound cursor can eventually advance
							// past it instead of stalling forever.
							insertReplicationOpRow(d, op);
							result.skipped++;
							continue;
						}
						redactMemoryFields(payload, activeScanner);
						const metaObj = foreignRevisionMetadata(db, op, payload.metadata_json, memRow);
						const nextTitle = resolveReplicatedTextUpdate(payload.title, memRow.title);
						const nextBodyText = resolveReplicatedTextUpdate(payload.body_text, memRow.body_text);
						const contentChanged =
							nextTitle !== (memRow.title ?? "") || nextBodyText !== (memRow.body_text ?? "");
						const wasInactive = Number(memRow.active ?? 1) === 0 || memRow.deleted_at != null;
						const nextActive =
							payload.active != null ? Number(payload.active) : Number(memRow.active ?? 1);
						const nextDeletedAt = payload.has_deleted_at
							? payload.deleted_at
							: (memRow.deleted_at ?? null);
						const becomesActive = nextActive !== 0 && nextDeletedAt == null;
						// Keep `active` consistent with the tombstone: when the row stays
						// (or becomes) tombstoned, force active=0 so a field-omitting
						// upsert that carries active=1 cannot resurrect a deleted memory
						// (read paths filter on active=1).
						const writtenActive = nextDeletedAt != null ? 0 : nextActive;
						// Base the vector decision on the FINAL persisted state, not the
						// raw payload: a row that stays (or becomes) tombstoned — active=0
						// or deleted_at set — must have its embeddings removed, not
						// re-upserted (the vector queue lets an upsert cancel a pending
						// delete, which would leave a deleted memory searchable).
						const shouldDeleteVectors = nextDeletedAt != null || writtenActive === 0;
						const shouldQueueVectorUpsert =
							!shouldDeleteVectors && (contentChanged || (wasInactive && becomesActive));

						d.update(schema.memoryItems)
							.set({
								kind: sql`COALESCE(${payload.kind}, ${schema.memoryItems.kind})`,
								title: sql`COALESCE(${payload.title}, ${schema.memoryItems.title})`,
								subtitle: payload.subtitle,
								body_text: sql`COALESCE(${payload.body_text}, ${schema.memoryItems.body_text})`,
								confidence: sql`COALESCE(${payload.confidence != null ? Number(payload.confidence) : null}, ${schema.memoryItems.confidence})`,
								tags_text: sql`COALESCE(NULLIF(TRIM(${payload.tags_text}), ''), ${schema.memoryItems.tags_text})`,
								active: writtenActive,
								updated_at: op.clock_updated_at,
								metadata_json: toJson(metaObj),
								rev: op.clock_rev,
								// Honor the wire intent flag: only clear/set the tombstone
								// when the payload actually carried `deleted_at`; otherwise
								// preserve the existing value (nextDeletedAt). Guards against
								// a field-omitting upsert resurrecting a tombstoned row.
								deleted_at: nextDeletedAt,
								actor_id: sql`COALESCE(${payload.actor_id}, ${schema.memoryItems.actor_id})`,
								actor_display_name: sql`COALESCE(${payload.actor_display_name}, ${schema.memoryItems.actor_display_name})`,
								visibility: sql`COALESCE(${payload.visibility}, ${schema.memoryItems.visibility})`,
								workspace_id: sql`COALESCE(${payload.workspace_id}, ${schema.memoryItems.workspace_id})`,
								workspace_kind: sql`COALESCE(${payload.workspace_kind}, ${schema.memoryItems.workspace_kind})`,
								// A stored creator stays: an update can fill in a missing or "local"
								// origin, as a claimed origin arrives, but never relabel a creator.
								origin_device_id: sql`CASE
									WHEN COALESCE(TRIM(${schema.memoryItems.origin_device_id}), '') IN ('', 'local')
									THEN COALESCE(${payload.origin_device_id}, ${schema.memoryItems.origin_device_id})
									ELSE ${schema.memoryItems.origin_device_id} END`,
								origin_source: sql`COALESCE(${payload.origin_source}, ${schema.memoryItems.origin_source})`,
								trust_state: sql`COALESCE(${payload.trust_state}, ${schema.memoryItems.trust_state})`,
								narrative: payload.narrative,
								facts: toJsonNullable(payload.facts),
								concepts: toJsonNullable(payload.concepts),
								files_read: toJsonNullable(payload.files_read),
								files_modified: toJsonNullable(payload.files_modified),
								user_prompt_id: payload.user_prompt_id,
								prompt_number: payload.prompt_number,
								scope_id: sql`COALESCE(${opScopeId}, ${schema.memoryItems.scope_id})`,
								// Backfill project on existing rows when the inbound
								// payload carries it; preserve the existing value when
								// the sender (older code) omitted the field.
								project: sql`COALESCE(${typeof payload.project === "string" && payload.project.trim() ? payload.project.trim() : null}, ${schema.memoryItems.project})`,
							})
							// Only the row whose clock was compared: another copy under the same
							// import key may hold a newer revision.
							.where(eq(schema.memoryItems.id, memRow.id))
							.run();
						// Re-populate junction tables with updated file/concept refs
						clearMemoryRefs(db, Number(memRow.id));
						populateMemoryRefs(
							db,
							Number(memRow.id),
							asStringArrayOrNull(payload.files_read),
							asStringArrayOrNull(payload.files_modified),
							asStringArrayOrNull(payload.concepts),
						);
						if (shouldDeleteVectors) queueVectorDelete(Number(memRow.id));
						else if (shouldQueueVectorUpsert) queueVectorUpsert(Number(memRow.id));
					} else {
						// Insert new memory item — skip if malformed
						const payload = parseMemoryPayload(op, result.errors);
						if (!payload) {
							// See the update branch: record malformed ops so they are
							// acknowledged once and never block inbound cursor progress.
							insertReplicationOpRow(d, op);
							result.skipped++;
							continue;
						}
						redactMemoryFields(payload, activeScanner);
						const replicatedProject =
							typeof payload.project === "string" && payload.project.trim()
								? payload.project.trim()
								: null;
						const sessionId = ensureSessionForReplication(
							d,
							null,
							op.clock_updated_at,
							replicatedProject,
						);
						const metaObj = foreignRevisionMetadata(db, op, payload.metadata_json);
						const insertedRows = d
							.insert(schema.memoryItems)
							.values({
								session_id: sessionId,
								kind: payload.kind ?? "discovery",
								title: payload.title ?? "",
								subtitle: payload.subtitle,
								body_text: payload.body_text ?? "",
								confidence: payload.confidence != null ? Number(payload.confidence) : 0.5,
								tags_text: resolveReplicatedTags(payload),
								active: payload.active != null ? Number(payload.active) : 1,
								created_at: payload.created_at ?? op.clock_updated_at,
								updated_at: op.clock_updated_at,
								metadata_json: toJson(metaObj),
								import_key: importKey,
								deleted_at: payload.deleted_at,
								rev: op.clock_rev,
								actor_id: payload.actor_id,
								actor_display_name: payload.actor_display_name,
								visibility: payload.visibility,
								workspace_id: payload.workspace_id,
								workspace_kind: payload.workspace_kind,
								origin_device_id: payload.origin_device_id,
								origin_source: payload.origin_source,
								trust_state: payload.trust_state,
								narrative: payload.narrative,
								facts: toJsonNullable(payload.facts),
								concepts: toJsonNullable(payload.concepts),
								files_read: toJsonNullable(payload.files_read),
								files_modified: toJsonNullable(payload.files_modified),
								user_prompt_id: payload.user_prompt_id,
								prompt_number: payload.prompt_number,
								scope_id: opScopeId,
								// Persist replicated project name so the Projects read
								// model can surface this memory under its originating
								// project identity without joining through sessions.
								project: replicatedProject,
							})
							.returning({ id: schema.memoryItems.id })
							.all();
						const insertedId = Number(insertedRows[0]?.id ?? 0);
						// Populate junction tables for the new memory
						populateMemoryRefs(
							db,
							insertedId,
							asStringArrayOrNull(payload.files_read),
							asStringArrayOrNull(payload.files_modified),
							asStringArrayOrNull(payload.concepts),
						);
						if (payload.deleted_at != null || Number(payload.active ?? 1) === 0) {
							queueVectorDelete(insertedId);
						} else {
							queueVectorUpsert(insertedId);
						}
					}
				} else if (op.op_type === "delete") {
					const importKey = op.entity_id;
					const opScopeId =
						typeof op.scope_id === "string" && op.scope_id.trim().length > 0
							? op.scope_id.trim()
							: null;
					const existingForDelete = d
						.select({
							id: schema.memoryItems.id,
							rev: schema.memoryItems.rev,
							updated_at: schema.memoryItems.updated_at,
							metadata_json: schema.memoryItems.metadata_json,
						})
						.from(schema.memoryItems)
						.where(eq(schema.memoryItems.import_key, importKey))
						.limit(1)
						.get();

					if (existingForDelete) {
						// Clock-compare: only delete if the incoming op is newer
						const existingClock = clockTuple(
							// Match the upsert path's `rev ?? 0` so Lamport tie-breaks are
							// symmetric when an existing row has a NULL rev.
							existingForDelete.rev ?? 0,
							existingForDelete.updated_at ?? "",
							clockDeviceIdFromMetadataJson(existingForDelete.metadata_json),
						);
						const incomingClock = clockTuple(op.clock_rev, op.clock_updated_at, op.clock_device_id);
						if (!isNewerClock(incomingClock, existingClock)) {
							result.conflicts++;
							insertReplicationOpRow(d, op);
							continue;
						}
						const now = new Date().toISOString();
						const deleteMetadata = foreignRevisionMetadata(db, op, existingForDelete.metadata_json);
						d.update(schema.memoryItems)
							.set({
								active: 0,
								deleted_at: sql`COALESCE(${schema.memoryItems.deleted_at}, ${now})`,
								rev: op.clock_rev,
								updated_at: op.clock_updated_at,
								metadata_json: toJson(deleteMetadata),
								scope_id: sql`COALESCE(${opScopeId}, ${schema.memoryItems.scope_id})`,
							})
							.where(eq(schema.memoryItems.id, existingForDelete.id))
							.run();
						queueVectorDelete(Number(existingForDelete.id));
					} else {
						// import_key not found: record the delete as a tombstone for
						// future resolution, but it mutated nothing — count it as
						// skipped rather than applied.
						insertReplicationOpRow(d, op);
						result.skipped++;
						continue;
					}
				} else {
					// An op type this version cannot apply. Recording its id would mark the id
					// applied, so a peer that knew a future op's id could suppress that op here.
					result.skipped++;
					continue;
				}

				// Record the applied op
				insertReplicationOpRow(d, op);
				result.applied++;
			} catch (err) {
				rollbackReplicationOp(db, result, opVectorWork);
				result.errors.push(`op ${op.op_id}: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				finishReplicationOp(db, result, effects, op.op_id);
			}
		}
	});

	return completeAppliedReplicationOps(applyAll, result, upsertMemoryIds, deleteMemoryIds);
}

function completeAppliedReplicationOps(
	applyAll: () => void,
	result: ApplyResult,
	upsertMemoryIds: Set<number>,
	deleteMemoryIds: Set<number>,
): ApplyResult {
	applyAll();
	result.vectorWork = {
		upsertMemoryIds: [...upsertMemoryIds],
		deleteMemoryIds: [...deleteMemoryIds],
	};
	return result;
}

function rejectedInboundBatch(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
	options: ApplyReplicationOpsOptions,
): ApplyResult | null {
	const validation = options.inboundScopeValidation;
	// These hold for every apply, whatever capability or validation mode was negotiated.
	const sender = cleanText(validation?.peerDeviceId ?? options.activityPeerDeviceId);
	const structural = [
		...unsupportedEntityRejections(ops, sender),
		...(sender ? localOnlyRowRejections(db, ops, localDeviceId, sender) : []),
	];
	if (structural.length > 0) return inboundRejectionResult(db, structural);
	if (!validation) return null;
	const rejected = rejectUnretiredScopeFailures(db, ops, localDeviceId, validation);
	if (rejected) return rejected;
	const senderRejections = inboundSenderRejections(db, ops, localDeviceId, validation);
	return senderRejections.length > 0 ? inboundRejectionResult(db, senderRejections) : null;
}

/** Op types the apply dispatches on, all of which write memory rows. */
const MEMORY_WRITE_OP_TYPES = new Set([
	"upsert",
	"delete",
	REASSIGN_SCOPE_OP_TYPE,
	ACCESS_CLEANUP_OP_TYPE,
]);

/**
 * The apply handles these op types only for memory rows, and would treat any
 * other entity as one. Such an op is refused before dispatch. Other op types
 * are skipped without a write.
 */
function unsupportedEntityRejections(
	ops: ReplicationOp[],
	sender: string | null,
): InboundScopeRejection[] {
	return ops
		.filter((op) => MEMORY_WRITE_OP_TYPES.has(op.op_type) && op.entity_type !== "memory_item")
		.map((op) => inboundScopeRejection(op, "scope_mismatch", sender, null));
}

function isLocalOnlyScope(db: Database, scopeId: string | null): boolean {
	const scope = cleanText(scopeId);
	if (!scope || scope === DEFAULT_SYNC_SCOPE_ID) return true;
	const row = db
		.prepare("SELECT authority_type FROM replication_scopes WHERE scope_id = ?")
		.get(scope) as { authority_type: string | null } | undefined;
	return row?.authority_type === "local";
}

/**
 * A local-only row is a replica the sender originated: this device recorded no
 * creation of it, and its stored origin names the sender, not this device or
 * the literal local label. Cleanup notices apply the same test.
 */
function senderOriginatedReplica(
	db: Database,
	importKey: string,
	origin: string | null,
	sender: { deviceId: string; localDeviceId: string },
): boolean {
	const stored = cleanText(origin);
	if (!stored || stored !== sender.deviceId) return false;
	if (stored === sender.localDeviceId || stored === "local") return false;
	return !hasRecordedLocalCreation(db, importKey);
}

/**
 * Rows in the local default scope or a local scope never sync, and an update,
 * delete or move matches rows by import key alone. A peer may change such a
 * row only when it is the peer's own replica, as in moving a memory it shared
 * before scopes existed. A row this device created is never changed.
 */
function localOnlyRowRejections(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
	sender: string,
): InboundScopeRejection[] {
	const stored = db.prepare(
		"SELECT scope_id, origin_device_id FROM memory_items WHERE import_key = ?",
	);
	const applied = db.prepare("SELECT 1 FROM replication_ops WHERE op_id = ?");
	const rejections: InboundScopeRejection[] = [];
	for (const op of ops) {
		if (!MEMORY_WRITE_OP_TYPES.has(op.op_type) || op.op_type === ACCESS_CLEANUP_OP_TYPE) continue;
		// The apply skips these without a write.
		if (op.device_id === localDeviceId || applied.get(op.op_id)) continue;
		if (retirementBlocksMemoryOp(db, op) || opInWithdrawnScope(db, op)) continue;
		const deviceId = sender;
		const rows = stored.all(op.entity_id) as Array<{
			scope_id: string | null;
			origin_device_id: string | null;
		}>;
		const blocked = rows.find(
			(row) =>
				isLocalOnlyScope(db, row.scope_id) &&
				!senderOriginatedReplica(db, op.entity_id, row.origin_device_id, {
					deviceId,
					localDeviceId,
				}),
		);
		// The rejection names only the op's own scope, so it never reveals where the row is stored.
		if (blocked)
			rejections.push(
				inboundScopeRejection(op, "sender_not_member", deviceId, cleanText(op.scope_id)),
			);
	}
	return rejections;
}

/**
 * Every scope whose rows an inbound op changes: its own, and the scope of every
 * row here with the same import key, since an update
 * or delete matches rows by import key alone. A scope the sender, as the
 * memory's verified source, retired the memory from is left out: its copy may
 * still be moved to where the source now writes it. A cleanup notice follows
 * its own origin rule instead.
 */
/**
 * The scopes whose rows an inbound op from `senderId` would change, which the sender must be
 * proven in: the op's own scope and every scope holding a stored copy of its memory that the
 * sender has not already retired. The pull path and the push route both use this.
 */
export function scopesWrittenByInboundOp(
	db: Database,
	op: ReplicationOp,
	senderId: string,
): string[] {
	if (op.op_type === ACCESS_CLEANUP_OP_TYPE) return [];
	// A move's op scope is its new scope on the new side and its old scope on the old side.
	// The other scope counts only through a copy stored there, below: a device in the
	// destination may not know the older scope, and the old side writes nothing new.
	const scopes = new Set([cleanText(op.scope_id) ?? ""]);
	const existing = db
		.prepare("SELECT DISTINCT scope_id FROM memory_items WHERE import_key = ?")
		.pluck()
		.all(op.entity_id) as Array<string | null>;
	for (const scopeId of existing) {
		const stored = cleanText(scopeId) ?? DEFAULT_SYNC_SCOPE_ID;
		if (!scopeRetiredBySender(db, op.entity_id, stored, senderId)) scopes.add(stored);
	}
	return [...scopes];
}

function scopeRetiredBySender(
	db: Database,
	entityId: string,
	scopeId: string,
	senderId: string,
): boolean {
	if (!hasMemoryScopeRetirement(db, entityId)) return false;
	return Boolean(
		db
			.prepare(`SELECT 1 FROM memory_scope_retirements
			 WHERE entity_id = ? AND retired_scope_id = ? AND source_device_id = ?`)
			.get(entityId, scopeId, senderId),
	);
}

/**
 * Why the sender may not change rows in this scope, or null. The sender needs
 * effective authorization with a retained proof for its pinned key, as the
 * serving routes require of a pushing peer. The local default and local
 * scopes have their own checks above, and this device's checks are unchanged.
 */
function inboundSenderScopeFailure(
	db: Database,
	scopeId: string,
	sender: { deviceId: string; binding: PinnedKeyBinding },
): InboundScopeRejectionReason | null {
	if (scopeId === DEFAULT_SYNC_SCOPE_ID) return null;
	if (!scopeId) return "missing_scope";
	const authorization = getEffectiveCachedScopeAuthorization(db, {
		deviceId: sender.deviceId,
		scopeId,
		...sender.binding,
	});
	const authority = authorization.scope?.authority_type;
	if (authority === "local") return null;
	// Unknown authorities fail closed, as the serving routes treat them.
	if (authority && !["coordinator", "manual", "invite"].includes(authority)) return "missing_scope";
	return authorizationFailureReason(authorization, "sender_not_member");
}

/**
 * What binds the sender's proofs to its pin, or null when the pairing has gone,
 * changed since admission, or holds neither a key nor a fingerprint.
 */
function admittedSenderKey(
	db: Database,
	deviceId: string,
	pinnedFingerprint: string | undefined,
): PinnedKeyBinding | null {
	const pin = db
		.prepare("SELECT pinned_fingerprint, public_key FROM sync_peers WHERE peer_device_id = ?")
		.get(deviceId) as { pinned_fingerprint: string | null; public_key: string | null } | undefined;
	if (!pin) return null;
	if (pinnedFingerprint !== undefined && pin.pinned_fingerprint !== pinnedFingerprint) return null;
	return pinnedKeyBinding(pin);
}

/**
 * Applies to every inbound batch from a peer, whatever capability or
 * validation mode the exchange negotiated: the sender must still be paired
 * as admitted and be authorized for every scope each op would change.
 */
function inboundSenderRejections(
	db: Database,
	ops: ReplicationOp[],
	localDeviceId: string,
	options: InboundScopeValidationOptions,
): InboundScopeRejection[] {
	const expectedPeer = cleanText(options.peerDeviceId);
	const rejections: InboundScopeRejection[] = [];
	for (const op of ops) {
		if (!expectedPeer && op.device_id === localDeviceId) continue;
		if (retirementBlocksMemoryOp(db, op) || opInWithdrawnScope(db, op)) continue;
		const senderId = expectedPeer ?? cleanText(op.device_id) ?? "";
		const key = admittedSenderKey(db, senderId, options.pinnedFingerprint);
		const failure = key
			? scopesWrittenByInboundOp(db, op, senderId)
					.map((scopeId) => ({
						scopeId,
						reason: inboundSenderScopeFailure(db, scopeId, { deviceId: senderId, binding: key }),
					}))
					.find((check) => check.reason !== null)
			: { scopeId: null, reason: "sender_not_member" as const };
		if (failure?.reason)
			rejections.push(inboundScopeRejection(op, failure.reason, senderId, failure.scopeId));
	}
	return rejections;
}

/** Apply authenticated inbound operations using the caller's scanner and scope policy. */
export function applyPeerReplicationOps(
	store: { db: Database; scanner: SecretScanner },
	ops: ReplicationOp[],
	localDeviceId: string,
	options: ApplyReplicationOpsOptions & { peerDeviceId: string },
): ApplyResult {
	return applyReplicationOps(store.db, ops, localDeviceId, store.scanner, {
		...options,
		activityPeerDeviceId: options.peerDeviceId,
		activitySource: "inbound",
	});
}

/** Insert a replication op row into the replication_ops table (ignore on conflict). */
function insertReplicationOpRow(d: ReturnType<typeof drizzle>, op: ReplicationOp): void {
	d.insert(schema.replicationOps)
		.values({
			op_id: op.op_id,
			entity_type: op.entity_type,
			entity_id: op.entity_id,
			op_type: op.op_type,
			payload_json: op.payload_json,
			clock_rev: op.clock_rev,
			clock_updated_at: op.clock_updated_at,
			clock_device_id: op.clock_device_id,
			device_id: op.device_id,
			created_at: op.created_at,
			scope_id: op.scope_id ?? null,
		})
		.onConflictDoNothing()
		.run();
}

/**
 * Ensure a session row exists for replication inserts.
 * Creates a minimal session if one doesn't exist yet.
 */
function ensureSessionForReplication(
	d: ReturnType<typeof drizzle>,
	sessionId: number | null,
	createdAt: string,
	project?: string | null,
): number {
	if (sessionId != null) {
		const row = d
			.select({ id: schema.sessions.id })
			.from(schema.sessions)
			.where(eq(schema.sessions.id, sessionId))
			.get();
		if (row) return sessionId;
	}
	// Create a new session for replicated data, preserving the source project.
	const now = createdAt || new Date().toISOString();
	const rows = d
		.insert(schema.sessions)
		.values({
			started_at: now,
			project: project ?? null,
			user: "sync",
			tool_version: "sync_replication",
			metadata_json: toJson({ source: "sync" }),
		})
		.returning({ id: schema.sessions.id })
		.all();
	const id = rows[0]?.id;
	if (id == null) throw new Error("session insert returned no id");
	return id;
}
