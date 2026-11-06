/**
 * Primary keys of the WITHOUT ROWID tables from coordinator migrations 0041
 * and 0042 (relay admission) and 0043 (headless account linking).
 * Whole-database snapshots order these tables by key,
 * because they have no rowid. Core owns this map so core tests never import the
 * worker package; the worker test helper re-exports it.
 *
 * Keep this file free of imports: the worker's native Node tests load it directly
 * with type stripping.
 */
export const RELAY_ADMISSION_TABLE_KEYS: Readonly<Record<string, readonly string[]>> = {
	relay_admission_authority_policy: ["authority_id"],
	relay_admission_audiences: ["authority_id", "audience_id"],
	relay_admission_realms: ["authority_id", "group_id"],
	relay_admission_readiness: ["authority_id", "scope", "group_id"],
	admission_budget_allocations: ["authority_id", "pool", "audience_id", "group_id"],
	admission_budget_buckets: ["authority_id", "pool", "audience_id", "group_id", "device_id"],
	coordinator_headless_link_code_limits: ["coordinator_id", "scope", "key_hash"],
	coordinator_headless_link_provenance: ["coordinator_id", "link_id"],
};
