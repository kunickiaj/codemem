import { INVITE_TOKEN_LOOKUP_VERSION } from "./coordinator-invite-token-seal.js";

/**
 * The invitation token lookup fence, kept in the database so that it covers
 * every Worker version that serves it. A serving build records its lookup
 * version, `INVITE_TOKEN_LOOKUP_VERSION`, when it starts. An operator records
 * the minimum lookup version of every build still serving the database, once
 * no older build serves it. A later build seals stored tokens only when that
 * recorded minimum is at least the digest-only version.
 */
export const COORDINATOR_METADATA_MIGRATION_NAME = "0054_add_coordinator_metadata.sql";

export const COORDINATOR_METADATA_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS coordinator_metadata (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** The exact text of migration 0054, which SQLite initialization also applies. */
export const COORDINATOR_METADATA_MIGRATION_SQL = `-- Named integer values of the coordinator database, such as the invitation token lookup fence.
-- Additive only: one new empty table. A Worker from before 0054 keeps working with it applied.
${COORDINATOR_METADATA_SCHEMA_SQL}`;

/** `present` is 1 when migration 0054, or SQLite initialization, has added the metadata table. */
export const COORDINATOR_METADATA_STORAGE_PRESENT_SQL = `SELECT (COUNT(*) = 3) AS present
FROM pragma_table_info('coordinator_metadata') WHERE name IN ('name', 'value', 'updated_at')`;

/** The highest invitation token lookup version a serving build has recorded. */
export const LOOKUP_VERSION_SEEN = "invite_token_lookup_version_seen";
/** The minimum lookup version of every build serving the database, as an operator confirmed it. */
export const MIN_SERVING_LOOKUP_VERSION = "invite_token_min_serving_lookup_version";

/** Raises a named value; it never lowers one, and writes nothing when the value is not higher. */
export const RAISE_METADATA_SQL = `INSERT INTO coordinator_metadata (name, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
WHERE excluded.value > coordinator_metadata.value`;

export const READ_FENCE_SQL = `SELECT
 (SELECT value FROM coordinator_metadata WHERE name = '${LOOKUP_VERSION_SEEN}') AS lookup_version_seen,
 (SELECT value FROM coordinator_metadata WHERE name = '${MIN_SERVING_LOOKUP_VERSION}') AS min_serving_lookup_version`;

/** What the database records about the lookups of the builds that serve it. */
export interface InviteTokenLookupFence {
	/** This build's lookup version. */
	build_lookup_version: number;
	lookup_version_seen: number | null;
	min_serving_lookup_version: number | null;
}

export function lookupFence(
	row: {
		lookup_version_seen: number | null;
		min_serving_lookup_version: number | null;
	} | null,
): InviteTokenLookupFence {
	return {
		build_lookup_version: INVITE_TOKEN_LOOKUP_VERSION,
		lookup_version_seen: row?.lookup_version_seen ?? null,
		min_serving_lookup_version: row?.min_serving_lookup_version ?? null,
	};
}
