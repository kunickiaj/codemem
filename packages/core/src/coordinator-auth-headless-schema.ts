import type { AuthLinkBackend } from "./coordinator-auth-link.js";

export const HEADLESS_CODE_LIMITS_TABLE = "coordinator_headless_link_code_limits";
export const HEADLESS_LINK_PROVENANCE_TABLE = "coordinator_headless_link_provenance";

/**
 * Additive storage for headless account linking. The definitions name only
 * their own tables: the auth readiness checks reject any unknown table, view or
 * trigger whose SQL mentions an auth table, and any object named with an auth
 * table's prefix. That is why provenance has no foreign keys.
 *
 * Mirror: packages/cloudflare-coordinator-worker/migrations/0043_add_headless_account_linking.sql
 * (generated from these statements; coordinator-auth-headless-schema.test.ts checks parity).
 */
export const HEADLESS_LINK_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
	`CREATE TABLE IF NOT EXISTS ${HEADLESS_CODE_LIMITS_TABLE} (
 coordinator_id TEXT NOT NULL CHECK (typeof(coordinator_id) = 'text' AND length(coordinator_id) BETWEEN 1 AND 256),
 scope TEXT NOT NULL CHECK (scope IN ('client','coordinator')),
 key_hash TEXT NOT NULL CHECK ((scope = 'coordinator' AND key_hash = '')
  OR (scope = 'client' AND length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*')),
 window_start_ms INTEGER NOT NULL CHECK (typeof(window_start_ms) = 'integer'
  AND window_start_ms BETWEEN 0 AND 9007199254740991),
 failures INTEGER NOT NULL CHECK (typeof(failures) = 'integer' AND failures BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (coordinator_id, scope, key_hash)
 ) WITHOUT ROWID;`,
	`CREATE TABLE IF NOT EXISTS ${HEADLESS_LINK_PROVENANCE_TABLE} (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0),
 PRIMARY KEY (coordinator_id, link_id),
 UNIQUE (coordinator_id, attempt_id)
 ) WITHOUT ROWID;`,
	`CREATE INDEX IF NOT EXISTS idx_headless_link_provenance_account
 ON ${HEADLESS_LINK_PROVENANCE_TABLE} (coordinator_id, issuer, subject, identity_id, created_at_ms);`,
	`CREATE TRIGGER IF NOT EXISTS headless_link_provenance_immutable
 BEFORE UPDATE ON ${HEADLESS_LINK_PROVENANCE_TABLE}
 BEGIN SELECT RAISE(ABORT,'headless_link_provenance_immutable'); END;`,
	// Rebind refuses headless-linked accounts by finding this row, so losing it would lift the block.
	`CREATE TRIGGER IF NOT EXISTS headless_link_provenance_retained
 BEFORE DELETE ON ${HEADLESS_LINK_PROVENANCE_TABLE}
 BEGIN SELECT RAISE(ABORT,'headless_link_provenance_retained'); END;`,
	// REPLACE conflict resolution deletes without firing delete triggers unless recursive triggers are on.
	`CREATE TRIGGER IF NOT EXISTS headless_link_provenance_no_replace
 BEFORE INSERT ON ${HEADLESS_LINK_PROVENANCE_TABLE}
 WHEN EXISTS (SELECT 1 FROM ${HEADLESS_LINK_PROVENANCE_TABLE} p WHERE p.coordinator_id = NEW.coordinator_id
  AND (p.link_id = NEW.link_id OR p.attempt_id = NEW.attempt_id))
 BEGIN SELECT RAISE(ABORT,'headless_link_provenance_retained'); END;`,
]);

export const HEADLESS_LINK_SCHEMA_SQL = HEADLESS_LINK_SCHEMA_STATEMENTS.join("\n");

const PRESENT_SQL = `SELECT
 EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${HEADLESS_CODE_LIMITS_TABLE}') AS limits,
 EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${HEADLESS_LINK_PROVENANCE_TABLE}') AS provenance`;

async function readPresence(backend: Pick<AuthLinkBackend, "first">) {
	const row = await backend.first<{ limits: number; provenance: number }>({
		sql: PRESENT_SQL,
		values: [],
	});
	return { limits: row?.limits === 1, provenance: row?.provenance === 1 };
}

/**
 * The backend, only when both headless tables exist. A D1 database before
 * migration 0043 returns null: headless linking is off there, and every other
 * auth capability and readiness check is unaffected.
 */
export async function readHeadlessLinkBackend(
	backend: AuthLinkBackend,
): Promise<AuthLinkBackend | null> {
	const present = await readPresence(backend);
	return present.limits && present.provenance ? backend : null;
}

/** Headless finalize refuses to link when it cannot record provenance in the same batch. */
export async function hasHeadlessLinkProvenance(
	backend: Pick<AuthLinkBackend, "first">,
): Promise<boolean> {
	return (await readPresence(backend)).provenance;
}
