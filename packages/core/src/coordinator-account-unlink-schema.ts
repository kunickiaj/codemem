/** Device authorization receipts contain no browser or provider proof claims. */
export const ACCOUNT_UNLINK_TABLE = "coordinator_auth_account_connection_unlinks";
const table = ACCOUNT_UNLINK_TABLE;
const birth = [
	"coordinator_id",
	"attempt_id",
	"target_link_id",
	"identity_id",
	"issuer",
	"target_subject",
	"group_id",
	"device_id",
	"public_key",
	"fingerprint",
	"enrollment_identity_id",
	"auth_config_revision",
	"request_hash",
	"created_at_ms",
];
export const ACCOUNT_UNLINK_SCHEMA_STATEMENTS = [
	`CREATE TABLE ${table} (
 coordinator_id TEXT NOT NULL, attempt_id TEXT NOT NULL, target_link_id TEXT NOT NULL,
 identity_id TEXT NOT NULL, issuer TEXT NOT NULL, target_subject TEXT NOT NULL,
 group_id TEXT NOT NULL, device_id TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 enrollment_identity_id TEXT, auth_config_revision TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('committing','completed')),
 created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms)='integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),
 completed_at_ms INTEGER,
 PRIMARY KEY(coordinator_id,attempt_id), UNIQUE(coordinator_id,target_link_id),
 CHECK((state='completed')=(completed_at_ms IS NOT NULL)),
 CHECK(completed_at_ms IS NULL OR (typeof(completed_at_ms)='integer' AND completed_at_ms>=created_at_ms AND completed_at_ms<=9007199254740991))
 )`,
	`CREATE TRIGGER account_connection_unlink_insert BEFORE INSERT ON ${table}
 WHEN NEW.state<>'committing' OR EXISTS (SELECT 1 FROM ${table} WHERE rowid=NEW.rowid OR (coordinator_id=NEW.coordinator_id AND (attempt_id=NEW.attempt_id OR target_link_id=NEW.target_link_id)))
 BEGIN SELECT RAISE(ABORT,'account_unlink_collision'); END`,
	`CREATE TRIGGER account_connection_unlink_rowid AFTER INSERT ON ${table} WHEN NEW.rowid<1
 BEGIN SELECT RAISE(ABORT,'account_unlink_rowid'); END`,
	`CREATE TRIGGER account_connection_unlink_update BEFORE UPDATE ON ${table}
 WHEN ${birth.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ")} OR NEW.rowid IS NOT OLD.rowid OR OLD.state<>'committing' OR NEW.state<>'completed'
 BEGIN SELECT RAISE(ABORT,'account_unlink_immutable'); END`,
	`CREATE TRIGGER account_connection_unlink_delete BEFORE DELETE ON ${table}
 BEGIN SELECT RAISE(ABORT,'account_unlink_immutable'); END`,
] as const;

export function accountArchiveReceiptGuard(browserGuard: string): string {
	return browserGuard.replace(
		"BEGIN SELECT",
		` AND NOT EXISTS (SELECT 1 FROM ${table} a WHERE a.coordinator_id=NEW.coordinator_id
 AND a.attempt_id=NEW.end_attempt_id AND a.state='committing' AND a.target_link_id=NEW.link_id
 AND a.identity_id=NEW.identity_id AND a.issuer=NEW.issuer AND a.target_subject=NEW.subject)
BEGIN SELECT`,
	);
}
