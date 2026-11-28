/** NULL means the group has no active preparation. No serving path sets a generation. */
export const READINESS_PREPARATION_MIGRATION = "0056_add_readiness_preparations.sql";
export const READINESS_GENERATION_PRESENT = `SELECT EXISTS (SELECT 1 FROM pragma_table_info('groups')
 WHERE name = 'readiness_generation' AND type = 'TEXT' AND "notnull" = 0 AND dflt_value IS NULL) AS present`;
export const READINESS_PREPARATIONS_SCHEMA =
	"ALTER TABLE groups ADD COLUMN readiness_generation TEXT";

type PresenceReader = {
	first<T>(statement: { sql: string; values: unknown[] }): Promise<T | null | undefined>;
};

// Columns are never dropped, so a database seen with the column keeps it.
const generationSeen = new WeakSet<object>();
// Backends that wrap one database share its answer.
const databaseOf = new WeakMap<object, object>();
const root = (key: object): object => databaseOf.get(key) ?? key;

/** Let a backend that wraps `database` use the answer already read for it. */
export function shareReadinessGenerationCheck(backend: object, database: object): void {
	databaseOf.set(backend, database);
}

/**
 * True once the column has been seen for this database. Writers check this
 * first, so that a known schema adds no await, and no new turn, before their
 * batch starts.
 */
export function knownReadinessGeneration(key: object): boolean {
	return generationSeen.has(root(key));
}

/**
 * Whether migration 0056, or SQLite initialization, has added
 * `groups.readiness_generation`. A Worker can run before its D1 migration: until
 * then no group holds a generation, so writers run without the invalidation,
 * which would otherwise fail to compile. Read at most once per database after
 * the column is first seen. `key` names the database a wrapper reads.
 */
export async function hasReadinessGeneration(
	reader: PresenceReader,
	key: object = reader,
): Promise<boolean> {
	if (knownReadinessGeneration(key)) return true;
	const row = await reader.first<{ present: number }>({
		sql: READINESS_GENERATION_PRESENT,
		values: [],
	});
	if (row?.present !== 1) return false;
	generationSeen.add(root(key));
	return true;
}

/** The same check for a backend that only runs `all`, which returns `{ results }`. */
export function hasReadinessGenerationByAll(backend: {
	all(statement: { sql: string; values: []; read: true }): Promise<unknown>;
}): Promise<boolean> {
	return hasReadinessGeneration(
		{
			first: async <T>(statement: { sql: string }) => {
				const result = await backend.all({ sql: statement.sql, values: [], read: true });
				return (result as { results?: T[] } | null)?.results?.[0];
			},
		},
		backend,
	);
}

/** The same check for a synchronous better-sqlite3 database. */
export function hasReadinessGenerationSync(db: {
	prepare(sql: string): { get(): unknown };
}): boolean {
	if (knownReadinessGeneration(db)) return true;
	const row = db.prepare(READINESS_GENERATION_PRESENT).get() as { present?: number } | undefined;
	if (row?.present !== 1) return false;
	generationSeen.add(root(db));
	return true;
}

/** `statements` where the column exists, nothing before migration 0056. */
export function readinessInvalidation<T>(present: boolean, ...statements: T[]): T[] {
	return present ? statements : [];
}

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
