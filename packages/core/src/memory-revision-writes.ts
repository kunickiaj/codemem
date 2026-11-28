/**
 * The one write path for the fields of a memory that sync replicates.
 *
 * Sync sends a memory's content only through the op for the copy's current
 * revision, built from the row at the moment it is sent. A change to a
 * replicated field therefore takes a new revision and records its op in the same
 * transaction, or peers that already hold the old revision never learn of it.
 *
 * Only a memory this device created takes revisions here, by the immutable
 * creation evidence in memory-copy-provenance.ts. Any other row, including an
 * imported or legacy row whose origin is blank or `local`, is changed on this
 * device only: no revision, no op and no new clock, so what it serves of that
 * memory keeps the clock of the device that wrote it.
 *
 * `memory-revision-writes.test.ts` checks the source for writers that change
 * these fields without a revision.
 */

import type { Database } from "./db.js";
import { fromJson, toJson } from "./db.js";
import { memoryWrittenHere } from "./memory-copy-provenance.js";
import { localReplicationDeviceId, recordReplicationOp } from "./sync-replication.js";

/** The columns of `memory_items` that an op carries or that decide who may read it. */
export const REPLICATED_MEMORY_COLUMNS = [
	"session_id",
	"project",
	"kind",
	"title",
	"subtitle",
	"body_text",
	"confidence",
	"tags_text",
	"active",
	"deleted_at",
	"metadata_json",
	"actor_id",
	"actor_display_name",
	"visibility",
	"workspace_id",
	"workspace_kind",
	"origin_device_id",
	"origin_source",
	"trust_state",
	"facts",
	"narrative",
	"concepts",
	"files_read",
	"files_modified",
	"user_prompt_id",
	"prompt_number",
	"scope_id",
] as const;

export type ReplicatedMemoryColumn = (typeof REPLICATED_MEMORY_COLUMNS)[number];

type ColumnValues = Partial<Record<ReplicatedMemoryColumn, string | number | null>>;

export interface MemoryRevisionWrite {
	memoryId: number;
	changes: ColumnValues;
	/** Write only while the row still has this revision. */
	expectedRev?: number | null;
	/**
	 * Write only while the row still holds these values. A change worked out from
	 * fields read earlier names them here, so a concurrent edit or redaction of
	 * those fields, which may not take a revision on this device, stops it.
	 */
	expectedValues?: ColumnValues;
	now?: string;
}

interface RevisionRow {
	rev: number | null;
	import_key: string | null;
	metadata_json: string | null;
}

function assertReplicatedColumns(values: ColumnValues): void {
	for (const column of Object.keys(values)) {
		if (!(REPLICATED_MEMORY_COLUMNS as readonly string[]).includes(column))
			throw new Error(`not a replicated memory column: ${column}`);
	}
}

/** Whether the row still holds every expected value. */
function holdsExpectedValues(db: Database, memoryId: number, expected: ColumnValues): boolean {
	const columns = Object.keys(expected);
	if (columns.length === 0) return true;
	const conditions = columns.map((column) => `${column} IS ?`).join(" AND ");
	return (
		db
			.prepare(`SELECT 1 FROM memory_items WHERE id = ? AND ${conditions}`)
			.get(memoryId, ...Object.values(expected)) !== undefined
	);
}

/** The changes as written, with this device as the clock of a revision it takes. */
function changesWithClock(
	write: MemoryRevisionWrite,
	row: RevisionRow,
	clockDeviceId: string,
): Record<string, string | number | null> {
	const changes: Record<string, string | number | null> = { ...write.changes };
	const metadata = fromJson(
		typeof changes.metadata_json === "string" ? changes.metadata_json : row.metadata_json,
	);
	metadata.clock_device_id = clockDeviceId;
	changes.metadata_json = toJson(metadata);
	return changes;
}

/** Records the op for the revision just written: a delete once the memory is inactive. */
function recordRevisionOp(db: Database, memoryId: number, deviceId: string, now: string): void {
	const after = db
		.prepare("SELECT active, deleted_at FROM memory_items WHERE id = ?")
		.get(memoryId) as { active: number | null; deleted_at: string | null };
	recordReplicationOp(db, {
		memoryId,
		opType: after.active === 0 || after.deleted_at ? "delete" : "upsert",
		deviceId,
		clockDeviceId: deviceId,
		createdAt: now,
	});
}

function update(db: Database, memoryId: number, assignments: string[], values: unknown[]): void {
	db.prepare(`UPDATE memory_items SET ${assignments.join(", ")} WHERE id = ?`).run(
		...values,
		memoryId,
	);
}

/** Whether the row still has the revision and values the change was worked out from. */
function stillAsRead(db: Database, row: RevisionRow, write: MemoryRevisionWrite): boolean {
	if (write.expectedRev !== undefined && (row.rev ?? null) !== write.expectedRev) return false;
	return holdsExpectedValues(db, write.memoryId, write.expectedValues ?? {});
}

/** Changes this device's copy only: no revision, no op and the writer's clock left as it was. */
function writeLocalCopy(db: Database, write: MemoryRevisionWrite): void {
	const columns = Object.keys(write.changes);
	if (columns.length === 0) return;
	update(
		db,
		write.memoryId,
		columns.map((column) => `${column} = ?`),
		Object.values(write.changes),
	);
}

/**
 * Change replicated fields of one memory. Returns false when the memory is gone,
 * its revision is no longer `expectedRev`, or it no longer holds `expectedValues`.
 *
 * On a memory this device created, the change takes the next revision with this
 * device as its clock, and its op is recorded in the same transaction. Before
 * this device has a sync identity, the revision is still taken, and the
 * replication backfill records the op once there is one.
 */
export function writeMemoryRevision(db: Database, write: MemoryRevisionWrite): boolean {
	assertReplicatedColumns(write.changes);
	assertReplicatedColumns(write.expectedValues ?? {});
	return db.transaction(() => {
		const row = db
			.prepare("SELECT rev, import_key, metadata_json FROM memory_items WHERE id = ?")
			.get(write.memoryId) as RevisionRow | undefined;
		if (!row || !stillAsRead(db, row, write)) return false;
		const deviceId = localReplicationDeviceId(db);
		if (!memoryWrittenHere(db, write.memoryId, deviceId)) {
			writeLocalCopy(db, write);
			return true;
		}
		const now = write.now ?? new Date().toISOString();
		const changes = deviceId ? changesWithClock(write, row, deviceId) : { ...write.changes };
		update(
			db,
			write.memoryId,
			[
				...Object.keys(changes).map((column) => `${column} = ?`),
				"updated_at = ?",
				"rev = COALESCE(rev, 0) + 1",
			],
			[...Object.values(changes), now],
		);
		if (deviceId) recordRevisionOp(db, write.memoryId, deviceId, now);
		return true;
	})();
}
