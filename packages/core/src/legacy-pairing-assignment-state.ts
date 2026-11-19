import { type Database, tableExists } from "./db.js";

/** Maintenance job whose completion marks the one-time conversion as done. */
export const LEGACY_PAIRING_ASSIGNMENT_JOB = "legacy_pairing_assignment_conversion";

/**
 * Whether the person assigned on pairings (`sync_peers.actor_id` and
 * `claimed_local_actor`) has been converted into Identity bindings. Before that
 * the older columns still decide which devices are this person's own. Afterward
 * only bindings do. Read-only, so it is safe on every query path.
 */
export function legacyPairingAssignmentsConverted(db: Database): boolean {
	if (!tableExists(db, "maintenance_jobs")) return false;
	return (
		db
			.prepare("SELECT 1 FROM maintenance_jobs WHERE kind = ? AND status = 'completed'")
			.get(LEGACY_PAIRING_ASSIGNMENT_JOB) !== undefined
	);
}
