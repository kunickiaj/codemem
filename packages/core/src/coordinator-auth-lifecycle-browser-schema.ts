/** Inert V3 browser definitions. Explicit migration copies each old rowid into
 * browser_sequence before installing guards; no store-open path imports this.
 * Later copies must preserve sqlite_sequence's high-water mark, including when
 * cleanup has removed the highest surviving transaction.
 */
export const AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_auth_browser_transactions (
 browser_sequence INTEGER PRIMARY KEY AUTOINCREMENT
  CHECK (typeof(browser_sequence) = 'integer' AND browser_sequence BETWEEN 1 AND 9007199254740990),
 coordinator_id TEXT NOT NULL CHECK (length(coordinator_id) BETWEEN 1 AND 256),
 browser_transaction_hash TEXT NOT NULL CHECK (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*'),
 purpose TEXT NOT NULL CHECK (purpose IN ('signin','link','owner_enroll','link_change')),
 attempt_id TEXT CHECK (attempt_id IS NULL OR length(attempt_id) BETWEEN 1 AND 256),
 state_hash TEXT NOT NULL CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
 binder_hash TEXT NOT NULL CHECK (length(binder_hash) = 64 AND binder_hash NOT GLOB '*[^0-9a-f]*'),
 issuer TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 redirect_uri TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending','consumed','expired')),
 nonce TEXT CHECK (nonce IS NULL OR (length(nonce) BETWEEN 43 AND 128 AND nonce NOT GLOB '*[^A-Za-z0-9._~-]*')),
 pkce_verifier TEXT CHECK (pkce_verifier IS NULL OR (length(pkce_verifier) BETWEEN 43 AND 128 AND pkce_verifier NOT GLOB '*[^A-Za-z0-9._~-]*')),
 claim_token TEXT,
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254140991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms > created_at_ms AND expires_at_ms <= created_at_ms + 600000),
 consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR (typeof(consumed_at_ms) = 'integer' AND consumed_at_ms >= created_at_ms AND consumed_at_ms < expires_at_ms AND consumed_at_ms <= 9007199254740991)),
 UNIQUE (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, state_hash),
 UNIQUE (coordinator_id, binder_hash),
 UNIQUE (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, claim_token),
 CHECK ((purpose IN ('link','owner_enroll','link_change') AND attempt_id IS NOT NULL) OR (purpose = 'signin' AND attempt_id IS NULL)),
 CHECK ((state = 'pending' AND nonce IS NOT NULL AND pkce_verifier IS NOT NULL) OR (state <> 'pending' AND nonce IS NULL AND pkce_verifier IS NULL)),
 CHECK ((state = 'consumed' AND claim_token IS NOT NULL AND consumed_at_ms IS NOT NULL) OR (state <> 'consumed' AND claim_token IS NULL AND consumed_at_ms IS NULL))
);`;

export const AUTH_LIFECYCLE_BROWSER_TRANSACTION_INDEX_STATEMENTS = Object.freeze([
	`CREATE INDEX IF NOT EXISTS idx_auth_browser_txn_purpose_created
 ON coordinator_auth_browser_transactions(coordinator_id, purpose, created_at_ms);`,
	`CREATE INDEX IF NOT EXISTS idx_auth_browser_txn_state_expiry
 ON coordinator_auth_browser_transactions(coordinator_id, state, expires_at_ms);`,
] as const);

/** Keep a transaction's order fixed across state transitions and secret erasure.
 * The INTEGER PRIMARY KEY aliases rowid, so rowid updates are checked too.
 * AUTOINCREMENT prevents automatic sequence reuse after transaction cleanup.
 * Reject insert collisions before REPLACE can delete and resequence a retained
 * transaction, even when recursive delete triggers are disabled.
 */
export const AUTH_LIFECYCLE_BROWSER_SEQUENCE_GUARD_STATEMENTS = Object.freeze([
	`CREATE TRIGGER IF NOT EXISTS auth_browser_transaction_insert_collision
 BEFORE INSERT ON coordinator_auth_browser_transactions
 WHEN EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b
  WHERE b.browser_sequence = NEW.browser_sequence OR (b.coordinator_id = NEW.coordinator_id AND (
   b.browser_transaction_hash = NEW.browser_transaction_hash OR b.state_hash = NEW.state_hash
   OR b.binder_hash = NEW.binder_hash OR b.attempt_id = NEW.attempt_id
   OR b.claim_token = NEW.claim_token)))
 BEGIN SELECT RAISE(ABORT, 'auth_browser_transaction_collision'); END;`,
	`CREATE TRIGGER IF NOT EXISTS auth_browser_transaction_sequence_immutable
 BEFORE UPDATE ON coordinator_auth_browser_transactions
 WHEN OLD.browser_sequence IS NOT NEW.browser_sequence
 BEGIN SELECT RAISE(ABORT, 'auth_browser_transaction_sequence_immutable'); END;`,
] as const);
