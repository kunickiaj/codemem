import type { Database } from "better-sqlite3";
import { AUTH_BROWSER_TXN_SCHEMA_SQL } from "./coordinator-auth-browser-transaction-contract.js";

const TABLE = "coordinator_auth_browser_transactions";
const REBUILT_TABLE = "coordinator_auth_browser_transactions_owner_upgrade";
const [tableSql, remainder = ""] = AUTH_BROWSER_TXN_SCHEMA_SQL.split(
	"CREATE INDEX IF NOT EXISTS idx_auth_browser_txn_purpose_created",
);
const indexSql =
	`CREATE INDEX IF NOT EXISTS idx_auth_browser_txn_purpose_created${remainder}`.split(
		"CREATE TABLE IF NOT EXISTS coordinator_auth_signin_purge_floors",
	)[0];

/** Run only in a transaction: preserves every old column and all uniqueness constraints. */
export const AUTH_BROWSER_OWNER_PURPOSE_UPGRADE_SQL = `
${tableSql?.replace(TABLE, REBUILT_TABLE)}
INSERT INTO ${REBUILT_TABLE} SELECT * FROM ${TABLE};
DROP TABLE ${TABLE};
ALTER TABLE ${REBUILT_TABLE} RENAME TO ${TABLE};
${indexSql}
`;

/** Atomic upgrade preserves same-table indexes/triggers; foreign dependents can abort it. */
export function upgradeAuthBrowserOwnerPurposeSchema(db: Database): void {
	const present = db
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(TABLE) as { sql: string } | undefined;
	if (!present || present.sql.includes("'owner_enroll'")) return;
	// Recheck after reserving the write lock in case another connection upgraded first.
	db.transaction(() => {
		const table = db
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(TABLE) as { sql: string } | undefined;
		if (!table || table.sql.includes("'owner_enroll'")) return;
		const objects = db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL",
			)
			.all(TABLE) as { name: string; sql: string }[];
		db.exec(AUTH_BROWSER_OWNER_PURPOSE_UPGRADE_SQL);
		for (const object of objects) {
			const recreated = db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(object.name);
			if (!recreated) db.exec(object.sql);
		}
	}).immediate();
}
