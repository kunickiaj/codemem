/** NULL means the group has no active preparation. No serving path sets a generation. */
export const READINESS_PREPARATION_MIGRATION = "0056_add_readiness_preparations.sql";
export const READINESS_GENERATION_PRESENT = `SELECT EXISTS (SELECT 1 FROM pragma_table_info('groups')
 WHERE name = 'readiness_generation' AND type = 'TEXT' AND "notnull" = 0 AND dflt_value IS NULL) AS present`;
export const READINESS_PREPARATIONS_SCHEMA =
	"ALTER TABLE groups ADD COLUMN readiness_generation TEXT";

/** Use only after the enrollment write and any SELECT that checks its changes(). */
export const CLEAR_CHANGED_GROUP = `UPDATE groups SET readiness_generation = NULL
WHERE group_id = ? AND changes() = 1`;
export const INVALIDATE_CHANGED_GROUP = `${CLEAR_CHANGED_GROUP} AND readiness_generation IS NOT NULL`;

/** The immediately preceding audit insert identifies a winning membership write.
 * Legacy membership rows may not store a group; authorization uses the scope's group. */
export const INVALIDATE_CHANGED_SCOPE_GROUP = `UPDATE groups SET readiness_generation = NULL
WHERE changes() = 1 AND readiness_generation IS NOT NULL
AND group_id = (SELECT group_id FROM coordinator_scopes WHERE scope_id = ?)`;

export const INVALIDATE_FILLED_KEYS = `UPDATE groups SET readiness_generation = NULL
WHERE readiness_generation IS NOT NULL AND changes() > 0 AND group_id IN (
 SELECT e.group_id FROM json_each(?) j JOIN enrolled_devices e ON e.rowid=json_extract(j.value,'$.row_id')
 WHERE e.public_key=json_extract(j.value,'$.public_key') AND e.key_id=json_extract(j.value,'$.key_id'))`;
