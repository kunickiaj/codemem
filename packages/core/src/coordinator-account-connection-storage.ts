/**
 * Storage constraints, not an unlink/relink authorization API.
 * The explicit account-schema migration installs this DDL. Management writers
 * compose the winning proof, archive move and successor CAS in one backend.batch;
 * an Identity identifier alone never authorizes these effects.
 */
export const CONNECTION_BIRTH_COLUMNS = [
	"coordinator_id",
	"link_id",
	"issuer",
	"subject",
	"identity_id",
	"attempt_id",
	"controller_attestation_id",
	"auth_config_revision",
	"created_at_ms",
	"revoked_at_ms",
	"authority_kind",
	"device_claim_id",
] as const;

const current = "coordinator_auth_account_links";
const history = "coordinator_auth_account_connection_history";
const orders = "coordinator_auth_account_connection_orders";
const birthEqual = CONNECTION_BIRTH_COLUMNS.map((c) => `c.${c} IS NEW.${c}`).join(" AND ");
const immutableBirth = CONNECTION_BIRTH_COLUMNS.filter((c) => c !== "revoked_at_ms")
	.map((c) => `NEW.${c} IS NOT OLD.${c}`)
	.join(" OR ");

/** Aliases h/c: only delete the exact row whose raw birth was just archived. */
export const CONNECTION_ARCHIVED_CURRENT_MATCH_SQL = `h.original_rowid = c.rowid AND ${CONNECTION_BIRTH_COLUMNS.map((column) => `h.${column} IS c.${column}`).join(" AND ")}`;

/** Current + ended rows retain reservations without a separate association table. */
export const CONNECTION_RESERVATIONS_SQL = `SELECT coordinator_id, issuer, subject, identity_id, link_id, created_at_ms FROM ${current}
UNION ALL SELECT coordinator_id, issuer, subject, identity_id, link_id, created_at_ms FROM ${history}`;

/** Alias l must be the pinned current target, never a caller-selected Identity. */
export const CONNECTION_NOT_REVOKED_SQL = `l.revoked_at_ms IS NULL AND NOT EXISTS (
 SELECT 1 FROM ${history} h WHERE h.coordinator_id = l.coordinator_id
 AND h.identity_id = l.identity_id AND h.revoked_at_ms IS NOT NULL)`;

/** The disconnected head is the one ended row without a successor, not a timestamp maximum. */
export const CONNECTION_DISCONNECTED_HEAD_SQL = `SELECT h.* FROM ${history} h
WHERE h.coordinator_id = ? AND h.link_id = ? AND h.successor_link_id IS NULL
 AND NOT EXISTS (SELECT 1 FROM ${current} c WHERE c.coordinator_id = h.coordinator_id AND c.identity_id = h.identity_id)
 AND NOT EXISTS (SELECT 1 FROM ${history} r WHERE r.coordinator_id = h.coordinator_id AND r.identity_id = h.identity_id AND r.revoked_at_ms IS NOT NULL)`;

/** Immediately follow each required single-row write inside the same batch. */
export const CONNECTION_ASSERT_ONE_WRITE_SQL = `INSERT INTO ${orders} (coordinator_id, last_order)
SELECT NULL, 0 WHERE changes() <> 1`;

/** Allocate inside the browser-start batch; overflow raises CHECK, never wraps or resets. */
export const CONNECTION_ALLOCATE_ORDER_SQL = `UPDATE ${orders} SET last_order = last_order + 1 WHERE coordinator_id = ?`;

/** Aliases b/l require migration-owned start_order/signin_floor columns.
 * This predicate alone does not verify, consume or authorize a browser proof. */
export const CONNECTION_SIGNIN_ORDER_SQL = `b.coordinator_id = l.coordinator_id
 AND b.issuer = l.issuer
 AND b.start_order IS NOT NULL AND ((b.purpose = 'signin' AND b.start_order > l.signin_floor)
 OR (b.purpose = 'link' AND b.attempt_id = l.attempt_id AND EXISTS (
 SELECT 1 FROM coordinator_auth_link_attempts a WHERE a.coordinator_id = l.coordinator_id
 AND a.attempt_id = l.attempt_id AND a.link_id = l.link_id
 AND a.browser_transaction_hash = b.browser_transaction_hash AND a.state IN ('finalized','session_redeemed'))))`;

/**
 * Explicit DDL only. The account-schema migration also installs browser order,
 * current floor and prior-attempt columns before management becomes available.
 * original_rowid retains raw old-row evidence; it is not a global generation ID.
 */
export const ACCOUNT_CONNECTION_STORAGE_STATEMENTS = [
	`CREATE TABLE ${history} (
 coordinator_id TEXT NOT NULL, link_id TEXT NOT NULL, issuer TEXT NOT NULL,
 subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 255), identity_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL, controller_attestation_id TEXT,
 auth_config_revision TEXT NOT NULL CHECK(length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER,
 authority_kind TEXT NOT NULL CHECK(authority_kind IN ('controller_attestation','device_claim')),
 device_claim_id TEXT, original_rowid INTEGER NOT NULL CHECK(typeof(original_rowid) = 'integer'),
 ended_at_ms INTEGER NOT NULL CHECK(typeof(ended_at_ms) = 'integer' AND ended_at_ms BETWEEN 0 AND 9007199254740991 AND ended_at_ms >= created_at_ms),
 end_attempt_id TEXT NOT NULL CHECK(length(end_attempt_id) BETWEEN 1 AND 256),
 successor_link_id TEXT CHECK(successor_link_id IS NULL OR (length(successor_link_id) BETWEEN 1 AND 256 AND successor_link_id <> link_id)),
 PRIMARY KEY(coordinator_id, link_id), UNIQUE(coordinator_id, end_attempt_id),
 UNIQUE(coordinator_id, successor_link_id),
 CHECK((authority_kind = 'controller_attestation' AND controller_attestation_id IS NOT NULL AND device_claim_id IS NULL)
 OR (authority_kind = 'device_claim' AND controller_attestation_id IS NULL AND device_claim_id IS NOT NULL))
)`,
	`CREATE TRIGGER account_connection_history_insert BEFORE INSERT ON ${history}
WHEN NEW.successor_link_id IS NOT NULL
 OR EXISTS (SELECT 1 FROM ${history} WHERE rowid = NEW.rowid)
 OR EXISTS (SELECT 1 FROM ${history} WHERE coordinator_id = NEW.coordinator_id AND (link_id = NEW.link_id OR end_attempt_id = NEW.end_attempt_id))
 OR EXISTS (SELECT 1 FROM ${history} WHERE coordinator_id = NEW.coordinator_id AND identity_id = NEW.identity_id AND successor_link_id IS NULL)
 OR NOT EXISTS (SELECT 1 FROM ${current} c WHERE c.rowid = NEW.original_rowid AND ${birthEqual})
BEGIN SELECT RAISE(ABORT, 'connection_archive_source_invalid'); END`,
	// BEFORE INSERT uses -1 for an unallocated rowid. Keep stored rowids positive
	// so automatic allocation never reaches that sentinel from a negative rowid.
	`CREATE TRIGGER account_connection_history_rowid AFTER INSERT ON ${history}
 WHEN NEW.rowid < 1
 BEGIN SELECT RAISE(ABORT, 'connection_archive_source_invalid'); END`,
	`CREATE TRIGGER account_connection_history_update BEFORE UPDATE ON ${history}
WHEN ${immutableBirth}
 OR NEW.rowid IS NOT OLD.rowid
 OR NEW.original_rowid IS NOT OLD.original_rowid OR NEW.ended_at_ms IS NOT OLD.ended_at_ms
 OR NEW.end_attempt_id IS NOT OLD.end_attempt_id
 OR (NEW.revoked_at_ms IS NOT OLD.revoked_at_ms AND (OLD.revoked_at_ms IS NOT NULL OR typeof(NEW.revoked_at_ms) <> 'integer' OR NEW.revoked_at_ms < 0 OR NEW.revoked_at_ms > 9007199254740991))
 OR (NEW.successor_link_id IS NOT OLD.successor_link_id AND (
 OLD.successor_link_id IS NOT NULL OR NEW.successor_link_id IS NULL OR NEW.revoked_at_ms IS NOT NULL
 OR EXISTS (SELECT 1 FROM ${history} h WHERE h.coordinator_id = NEW.coordinator_id AND h.successor_link_id = NEW.successor_link_id AND h.link_id <> OLD.link_id)
 OR NOT EXISTS (SELECT 1 FROM ${current} c WHERE c.coordinator_id = OLD.coordinator_id AND c.link_id = NEW.successor_link_id AND c.identity_id = OLD.identity_id AND c.revoked_at_ms IS NULL)
 OR EXISTS (SELECT 1 FROM ${history} h WHERE h.coordinator_id = OLD.coordinator_id AND h.identity_id = OLD.identity_id AND h.revoked_at_ms IS NOT NULL)))
BEGIN SELECT RAISE(ABORT, 'connection_history_immutable'); END`,
	`CREATE TRIGGER account_connection_history_delete BEFORE DELETE ON ${history}
BEGIN SELECT RAISE(ABORT, 'connection_history_immutable'); END`,
	`CREATE TRIGGER account_connection_current_insert BEFORE INSERT ON ${current}
WHEN EXISTS (SELECT 1 FROM ${history} h WHERE h.coordinator_id = NEW.coordinator_id AND (
 h.link_id = NEW.link_id OR (h.issuer = NEW.issuer AND h.subject = NEW.subject AND h.identity_id <> NEW.identity_id)
 OR (h.identity_id = NEW.identity_id AND h.revoked_at_ms IS NOT NULL)))
BEGIN SELECT RAISE(ABORT, 'connection_reserved_or_revoked'); END`,
	// This additional proof trigger has a real invariant and also makes V2's
	// exact three-trigger proof readiness check fail, including after old init replay.
	`CREATE TRIGGER account_connection_claim_history BEFORE INSERT ON coordinator_auth_device_claims
WHEN EXISTS (SELECT 1 FROM ${history} h WHERE h.coordinator_id = NEW.coordinator_id AND h.identity_id = NEW.identity_id)
BEGIN SELECT RAISE(ABORT, 'connection_claim_history_reserved'); END`,
	`CREATE TABLE ${orders} (
 coordinator_id TEXT PRIMARY KEY NOT NULL,
 last_order INTEGER NOT NULL CHECK(typeof(last_order) = 'integer' AND last_order BETWEEN 0 AND 9007199254740991)
) WITHOUT ROWID`,
	`CREATE TRIGGER account_connection_order_insert BEFORE INSERT ON ${orders}
WHEN NEW.last_order <> 0 OR EXISTS (SELECT 1 FROM ${orders} WHERE coordinator_id = NEW.coordinator_id)
BEGIN SELECT RAISE(ABORT, 'connection_order_reset'); END`,
	`CREATE TRIGGER account_connection_order_update BEFORE UPDATE ON ${orders}
WHEN NEW.coordinator_id IS NOT OLD.coordinator_id OR NEW.last_order <> OLD.last_order + 1
BEGIN SELECT RAISE(ABORT, 'connection_order_reset'); END`,
	`CREATE TRIGGER account_connection_order_delete BEFORE DELETE ON ${orders}
BEGIN SELECT RAISE(ABORT, 'connection_order_reset'); END`,
] as const;
