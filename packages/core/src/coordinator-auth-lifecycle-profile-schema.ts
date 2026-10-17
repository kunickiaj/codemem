/** Inert V3 display-only storage. Migration preserves every old column and raw
 * payload, assigning legacy baselines without creating any profile rows.
 * V3 writers must explicitly use browser_sequence + 1, compare source orders,
 * and retain empty snapshots. Defaults exist only for the legacy baselines.
 */
export const AUTH_LIFECYCLE_ACCOUNT_PROFILE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_auth_account_profiles (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 display_name TEXT CHECK (display_name IS NULL OR (typeof(display_name) = 'text' AND length(display_name) BETWEEN 1 AND 256)),
 email TEXT CHECK (email IS NULL OR (typeof(email) = 'text' AND length(email) BETWEEN 1 AND 320)),
 email_verified INTEGER CHECK (email_verified IS NULL OR (typeof(email_verified) = 'integer' AND email_verified IN (0,1) AND email IS NOT NULL)),
 picture_url TEXT CHECK (picture_url IS NULL OR (typeof(picture_url) = 'text' AND length(picture_url) BETWEEN 1 AND 2048 AND substr(picture_url, 1, 8) = 'https://')),
 source_session_id TEXT NOT NULL,
 source_signed_in_at_ms INTEGER NOT NULL CHECK (typeof(source_signed_in_at_ms) = 'integer' AND source_signed_in_at_ms BETWEEN 0 AND 9007199225940991),
 source_order INTEGER NOT NULL DEFAULT 1 CHECK (typeof(source_order) = 'integer' AND source_order BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (coordinator_id, link_id)
);`;

export const AUTH_LIFECYCLE_LINK_PROFILE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_auth_link_profiles (
 coordinator_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL,
 browser_transaction_hash TEXT NOT NULL,
 link_id TEXT,
 display_name TEXT,
 email TEXT,
 email_verified INTEGER CHECK (email_verified IS NULL OR (email_verified IN (0,1) AND email IS NOT NULL)),
 picture_url TEXT,
 verified_at_ms INTEGER NOT NULL,
 source_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(source_order) = 'integer' AND (source_order = 0 OR source_order BETWEEN 2 AND 9007199254740991)),
 source_purpose TEXT NOT NULL DEFAULT 'link' CHECK (source_purpose IN ('link','link_change')),
 PRIMARY KEY (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, link_id),
 CHECK (source_purpose = 'link' OR link_id IS NULL),
 CHECK (source_purpose = 'link' OR source_order >= 2)
);`;

/** No session provenance: a refresh is sourced from its own completed attempt.
 * Receipt/proof validation and newer-order-only writes belong to finalization,
 * not these shape constraints. No provider tokens or completion payload live here.
 */
export const AUTH_LINK_PROFILE_REFRESH_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_auth_link_profile_refreshes (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 display_name TEXT CHECK (display_name IS NULL OR (typeof(display_name) = 'text' AND length(display_name) BETWEEN 1 AND 256)),
 email TEXT CHECK (email IS NULL OR (typeof(email) = 'text' AND length(email) BETWEEN 1 AND 320)),
 email_verified INTEGER CHECK (email_verified IS NULL OR (typeof(email_verified) = 'integer' AND email_verified IN (0,1) AND email IS NOT NULL)),
 picture_url TEXT CHECK (picture_url IS NULL OR (typeof(picture_url) = 'text' AND length(picture_url) BETWEEN 1 AND 2048 AND substr(picture_url, 1, 8) = 'https://')),
 source_attempt_id TEXT NOT NULL CHECK (typeof(source_attempt_id) = 'text' AND length(source_attempt_id) BETWEEN 1 AND 256 AND source_attempt_id = trim(source_attempt_id) AND instr(source_attempt_id, char(0)) = 0),
 verified_at_ms INTEGER NOT NULL CHECK (typeof(verified_at_ms) = 'integer' AND verified_at_ms BETWEEN 0 AND 9007199254740991),
 source_order INTEGER NOT NULL CHECK (typeof(source_order) = 'integer' AND source_order BETWEEN 2 AND 9007199254740991),
 PRIMARY KEY (coordinator_id, link_id)
);`;
