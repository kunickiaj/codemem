/**
 * The repair `codemem sync duplicates repair` runs: it confirms a memory is the
 * only copy left in its scope, sends it to peers again when this device created
 * it, applies the changes peers sent for it while it was stored more than once,
 * and queues their vector updates.
 */

import type { Database } from "./db.js";
import { type AmbiguousCopyRepair, repairAmbiguousMemoryCopy } from "./memory-copy-ambiguity.js";
import { memoryWrittenHere } from "./memory-copy-provenance.js";
import type { SecretScanner } from "./secret-scanner.js";
import { recordReplicationOp, replayReleasedHeldOps } from "./sync-replication.js";
import { queueVectorBackfillForIncrementalSync } from "./vector-migration.js";

export function repairAmbiguousMemory(
	db: Database,
	memoryId: number,
	context: { localDeviceId: string; scanner?: SecretScanner },
): AmbiguousCopyRepair {
	const outcome = db.transaction((): AmbiguousCopyRepair => {
		const repaired = repairAmbiguousMemoryCopy(db, memoryId);
		if (repaired.status === "repaired") resendCopyWrittenHere(db, memoryId, context.localDeviceId);
		return repaired;
	})();
	if (outcome.status !== "repaired") return outcome;
	const work = replayReleasedHeldOps(db, context.localDeviceId, context.scanner);
	queueVectorBackfillForIncrementalSync(db, work);
	return outcome;
}

/**
 * Records a fresh op, under a new op ID, at the copy's current revision. While the
 * copy was withheld, peers moved past its ops without receiving them. A peer that
 * missed this revision applies the op; one that has it finds the clocks equal and
 * keeps its row. Only the device that created a copy sends ops for it.
 */
function resendCopyWrittenHere(db: Database, memoryId: number, localDeviceId: string): void {
	if (!memoryWrittenHere(db, memoryId, localDeviceId)) return;
	const row = db
		.prepare("SELECT active, deleted_at FROM memory_items WHERE id = ?")
		.get(memoryId) as { active: number | null; deleted_at: string | null };
	const deleted = row.active === 0 || Boolean(row.deleted_at);
	recordReplicationOp(db, {
		memoryId,
		opType: deleted ? "delete" : "upsert",
		deviceId: localDeviceId,
	});
}
