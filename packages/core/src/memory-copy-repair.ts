/**
 * The repair `codemem sync duplicates repair` runs: it confirms a memory is the
 * only copy left in its scope, then applies the changes peers sent for it while it
 * was stored more than once, and queues their vector updates.
 */

import type { Database } from "./db.js";
import { type AmbiguousCopyRepair, repairAmbiguousMemoryCopy } from "./memory-copy-ambiguity.js";
import type { SecretScanner } from "./secret-scanner.js";
import { replayReleasedHeldOps } from "./sync-replication.js";
import { queueVectorBackfillForIncrementalSync } from "./vector-migration.js";

export function repairAmbiguousMemory(
	db: Database,
	memoryId: number,
	context: { localDeviceId: string; scanner?: SecretScanner },
): AmbiguousCopyRepair {
	const outcome = repairAmbiguousMemoryCopy(db, memoryId);
	if (outcome.status !== "repaired") return outcome;
	const work = replayReleasedHeldOps(db, context.localDeviceId, context.scanner);
	queueVectorBackfillForIncrementalSync(db, work);
	return outcome;
}
