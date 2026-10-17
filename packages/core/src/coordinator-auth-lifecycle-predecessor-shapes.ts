/** Frozen schema-10 inputs. Do not derive these from fresh-store or V3 DDL.
 * Layout may differ; literal bytes, quoting and constraint order remain pins.
 */
const browserStart =
	"browser_start_hash TEXT CHECK (browser_start_hash IS NULL OR (length(browser_start_hash) = 64 AND browser_start_hash NOT GLOB '*[^0-9a-f]*'))";
const attempts = `CREATE TABLE coordinator_auth_link_attempts (
 coordinator_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 public_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 controller_attestation_id TEXT,
 controller_review_receipt_id TEXT,
 controller_revision INTEGER,
 issuer TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 runtime_verifier_hash TEXT NOT NULL CHECK (length(runtime_verifier_hash) = 64 AND runtime_verifier_hash NOT GLOB '*[^0-9a-f]*'),
 loopback_redirect TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending','browser_claimed','oidc_verified','confirmed','finalized','session_redeemed','expired','failed')),
 browser_transaction_hash TEXT CHECK (browser_transaction_hash IS NULL OR (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*')),
 account_subject TEXT CHECK (account_subject IS NULL OR length(account_subject) BETWEEN 1 AND 255),
 completion_secret_hash TEXT CHECK (completion_secret_hash IS NULL OR (length(completion_secret_hash) = 64 AND completion_secret_hash NOT GLOB '*[^0-9a-f]*')),
 link_id TEXT,
 failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('device_cancelled','browser_cancelled','provider_failure','config_failure')),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0 AND created_at_ms <= 9007199254140991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms = created_at_ms + 600000),
 claimed_at_ms INTEGER,
 oidc_verified_at_ms INTEGER,
 confirmed_at_ms INTEGER,
 finalized_at_ms INTEGER,
 failed_at_ms INTEGER,
 ${browserStart},
 authority_kind TEXT NOT NULL CHECK (authority_kind IN ('controller_attestation','device_claim')),
 PRIMARY KEY (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, runtime_verifier_hash),
 UNIQUE (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, completion_secret_hash),
 UNIQUE (coordinator_id, link_id),
 CHECK (state <> 'pending' OR (browser_transaction_hash IS NULL AND account_subject IS NULL AND completion_secret_hash IS NULL AND link_id IS NULL)),
 CHECK (state NOT IN ('browser_claimed','oidc_verified','confirmed','finalized','session_redeemed') OR browser_transaction_hash IS NOT NULL),
 CHECK (state NOT IN ('oidc_verified','confirmed','finalized','session_redeemed') OR account_subject IS NOT NULL),
 CHECK (state NOT IN ('confirmed','finalized','session_redeemed') OR completion_secret_hash IS NOT NULL),
 CHECK ((state IN ('finalized','session_redeemed') AND link_id IS NOT NULL AND finalized_at_ms IS NOT NULL) OR (state NOT IN ('finalized','session_redeemed') AND link_id IS NULL AND finalized_at_ms IS NULL)),
 CHECK ((state = 'failed' AND failure_reason IS NOT NULL AND failed_at_ms IS NOT NULL) OR (state <> 'failed' AND failure_reason IS NULL AND failed_at_ms IS NULL)),
 CHECK ((authority_kind = 'controller_attestation'
  AND (controller_attestation_id IS NOT NULL AND typeof(controller_attestation_id) = 'text' AND length(controller_attestation_id) BETWEEN 1 AND 256 AND controller_attestation_id = trim(controller_attestation_id) AND instr(controller_attestation_id, char(0)) = 0)
  AND (controller_review_receipt_id IS NOT NULL AND typeof(controller_review_receipt_id) = 'text' AND length(controller_review_receipt_id) BETWEEN 1 AND 256 AND controller_review_receipt_id = trim(controller_review_receipt_id) AND instr(controller_review_receipt_id, char(0)) = 0)
  AND controller_revision IS NOT NULL AND typeof(controller_revision) = 'integer' AND controller_revision = 1)
  OR (authority_kind = 'device_claim' AND controller_attestation_id IS NULL AND controller_review_receipt_id IS NULL AND controller_revision IS NULL))
)`;
const links = `CREATE TABLE coordinator_auth_account_links (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
 identity_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 controller_attestation_id TEXT,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL,
 revoked_at_ms INTEGER,
 authority_kind TEXT NOT NULL CHECK (authority_kind IN ('controller_attestation','device_claim')),
 device_claim_id TEXT,
 PRIMARY KEY (coordinator_id, link_id),
 UNIQUE (coordinator_id, issuer, subject),
 UNIQUE (coordinator_id, identity_id),
 UNIQUE (coordinator_id, attempt_id),
 UNIQUE (device_claim_id),
 CHECK ((authority_kind = 'controller_attestation'
  AND (controller_attestation_id IS NOT NULL AND typeof(controller_attestation_id) = 'text' AND length(controller_attestation_id) BETWEEN 1 AND 256 AND controller_attestation_id = trim(controller_attestation_id) AND instr(controller_attestation_id, char(0)) = 0) AND device_claim_id IS NULL)
  OR (authority_kind = 'device_claim' AND controller_attestation_id IS NULL
  AND (device_claim_id IS NOT NULL AND typeof(device_claim_id) = 'text' AND length(device_claim_id) BETWEEN 1 AND 256 AND device_claim_id = trim(device_claim_id) AND instr(device_claim_id, char(0)) = 0)))
)`;
const audit = `CREATE TABLE coordinator_auth_link_audit_log (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK (action IN ('link_created','link_revoked')),
 attempt_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 controller_attestation_id TEXT,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL,
 authority_kind TEXT NOT NULL CHECK (authority_kind IN ('controller_attestation','device_claim')),
 device_claim_id TEXT,
 PRIMARY KEY (coordinator_id, link_id, action),
 CHECK ((authority_kind = 'controller_attestation'
  AND (controller_attestation_id IS NOT NULL AND typeof(controller_attestation_id) = 'text' AND length(controller_attestation_id) BETWEEN 1 AND 256 AND controller_attestation_id = trim(controller_attestation_id) AND instr(controller_attestation_id, char(0)) = 0) AND device_claim_id IS NULL)
  OR (authority_kind = 'device_claim' AND controller_attestation_id IS NULL
  AND (device_claim_id IS NOT NULL AND typeof(device_claim_id) = 'text' AND length(device_claim_id) BETWEEN 1 AND 256 AND device_claim_id = trim(device_claim_id) AND instr(device_claim_id, char(0)) = 0)))
)`;
const browser = `CREATE TABLE coordinator_auth_browser_transactions (
 coordinator_id TEXT NOT NULL CHECK (length(coordinator_id) BETWEEN 1 AND 256),
 browser_transaction_hash TEXT NOT NULL CHECK (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*'),
 purpose TEXT NOT NULL CHECK (purpose IN ('signin','link','owner_enroll')),
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
 PRIMARY KEY (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, state_hash),
 UNIQUE (coordinator_id, binder_hash),
 UNIQUE (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, claim_token),
 CHECK ((purpose IN ('link','owner_enroll') AND attempt_id IS NOT NULL) OR (purpose = 'signin' AND attempt_id IS NULL)),
 CHECK ((state = 'pending' AND nonce IS NOT NULL AND pkce_verifier IS NOT NULL) OR (state <> 'pending' AND nonce IS NULL AND pkce_verifier IS NULL)),
 CHECK ((state = 'consumed' AND claim_token IS NOT NULL AND consumed_at_ms IS NOT NULL) OR (state <> 'consumed' AND claim_token IS NULL AND consumed_at_ms IS NULL))
)`;
const sessions = `CREATE TABLE coordinator_auth_sessions (
 coordinator_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64 AND credential_hash NOT GLOB '*[^0-9a-f]*'),
 browser_transaction_hash TEXT NOT NULL CHECK (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*'),
 link_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199225940991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991 AND expires_at_ms = created_at_ms + 28800000),
 revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR (typeof(revoked_at_ms) = 'integer' AND revoked_at_ms BETWEEN 0 AND 9007199254740991)),
 PRIMARY KEY (coordinator_id, session_id),
 UNIQUE (coordinator_id, credential_hash),
 UNIQUE (coordinator_id, browser_transaction_hash)
)`;
const receipts = `CREATE TABLE coordinator_auth_session_receipts (
 coordinator_id TEXT NOT NULL,
 browser_transaction_hash TEXT NOT NULL CHECK (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*'),
 source TEXT NOT NULL CHECK (source IN ('link_redeem','signin')),
 attempt_id TEXT,
 link_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199225940991),
 purge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (typeof(purge_eligible) = 'integer' AND purge_eligible IN (0,1) AND (purge_eligible = 0 OR (source = 'signin' AND attempt_id IS NULL))),
 PRIMARY KEY (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, session_id),
 UNIQUE (coordinator_id, attempt_id),
 CHECK ((source = 'link_redeem' AND attempt_id IS NOT NULL) OR (source = 'signin' AND attempt_id IS NULL))
)`;
const accountProfiles = `CREATE TABLE coordinator_auth_account_profiles (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 display_name TEXT CHECK (display_name IS NULL OR (typeof(display_name) = 'text' AND length(display_name) BETWEEN 1 AND 256)),
 email TEXT CHECK (email IS NULL OR (typeof(email) = 'text' AND length(email) BETWEEN 1 AND 320)),
 email_verified INTEGER CHECK (email_verified IS NULL OR (typeof(email_verified) = 'integer' AND email_verified IN (0,1) AND email IS NOT NULL)),
 picture_url TEXT CHECK (picture_url IS NULL OR (typeof(picture_url) = 'text' AND length(picture_url) BETWEEN 1 AND 2048 AND substr(picture_url, 1, 8) = 'https://')),
 source_session_id TEXT NOT NULL,
 source_signed_in_at_ms INTEGER NOT NULL CHECK (typeof(source_signed_in_at_ms) = 'integer' AND source_signed_in_at_ms BETWEEN 0 AND 9007199225940991),
 PRIMARY KEY (coordinator_id, link_id)
)`;
const linkProfiles = `CREATE TABLE coordinator_auth_link_profiles (
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
 PRIMARY KEY (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, link_id)
)`;

function table(
	name: string,
	sql: string,
	options: { renamed?: boolean; alterBrowserStart?: boolean } = {},
) {
	const variants = [sql];
	if (options.alterBrowserStart) {
		// SQLite ALTER ADD COLUMN can retain this column after table constraints.
		variants.push(
			sql.replace(` ${browserStart},\n`, "").replace(/\n\)$/u, `,\n ${browserStart}\n)`),
		);
	}
	if (options.renamed)
		variants.push(...variants.map((value) => value.replace(`TABLE ${name}`, `TABLE "${name}"`)));
	// These are the frozen one-column-per-line definitions above, not arbitrary SQL.
	const columns = [...sql.matchAll(/^ (\w+) (TEXT|INTEGER)\b/gmu)].map((match) =>
		Object.freeze({ name: match[1] as string, type: match[2] as "TEXT" | "INTEGER" }),
	);
	return Object.freeze({
		name,
		type: "table" as const,
		variants: Object.freeze(variants),
		columns: Object.freeze(columns),
	});
}

/** Named columns make future copies independent of predecessor physical order. */
export const AUTH_LIFECYCLE_PREDECESSOR_TABLES = Object.freeze([
	table("coordinator_auth_link_attempts", attempts, { renamed: true, alterBrowserStart: true }),
	table("coordinator_auth_account_links", links, { renamed: true }),
	table("coordinator_auth_link_audit_log", audit, { renamed: true }),
	table("coordinator_auth_browser_transactions", browser, { renamed: true }),
	table("coordinator_auth_sessions", sessions),
	table("coordinator_auth_session_receipts", receipts),
	table("coordinator_auth_account_profiles", accountProfiles),
	table("coordinator_auth_link_profiles", linkProfiles),
]);

const indexSql = [
	"CREATE INDEX idx_auth_link_attempts_device_created ON coordinator_auth_link_attempts(coordinator_id, group_id, device_id, created_at_ms)",
	"CREATE INDEX idx_auth_link_attempts_identity_expiry ON coordinator_auth_link_attempts(coordinator_id, identity_id, expires_at_ms)",
	"CREATE INDEX idx_auth_link_attempts_state_expiry ON coordinator_auth_link_attempts(coordinator_id, state, expires_at_ms)",
	"CREATE UNIQUE INDEX idx_auth_link_attempts_browser_start ON coordinator_auth_link_attempts(coordinator_id, browser_start_hash)",
	"CREATE INDEX idx_auth_browser_txn_purpose_created ON coordinator_auth_browser_transactions(coordinator_id, purpose, created_at_ms)",
	"CREATE INDEX idx_auth_browser_txn_state_expiry ON coordinator_auth_browser_transactions(coordinator_id, state, expires_at_ms)",
	"CREATE INDEX idx_auth_sessions_link_config_expiry ON coordinator_auth_sessions(coordinator_id, link_id, auth_config_revision, expires_at_ms)",
	"CREATE INDEX idx_auth_sessions_expiry ON coordinator_auth_sessions(coordinator_id, expires_at_ms, session_id)",
	"CREATE INDEX idx_auth_session_receipts_purge ON coordinator_auth_session_receipts(coordinator_id, purge_eligible, created_at_ms, browser_transaction_hash)",
];
export const AUTH_LIFECYCLE_PREDECESSOR_DEFINITIONS = Object.freeze([
	...AUTH_LIFECYCLE_PREDECESSOR_TABLES,
	...indexSql.map((sql) =>
		Object.freeze({
			name: sql.split(" ON ")[0]?.split(" ").at(-1) as string,
			type: "index" as const,
			variants: Object.freeze([sql]),
		}),
	),
]);
