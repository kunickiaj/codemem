import { AUTH_BROWSER_TXN_SCHEMA_SQL } from "./coordinator-auth-browser-transaction-contract.js";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS } from "./coordinator-auth-device-claim-schema.js";
import {
	AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS,
	AUTH_LIFECYCLE_CONTINUATION_GUARD_STATEMENTS,
	AUTH_LIFECYCLE_SESSION_ADMISSION_GUARD_STATEMENTS,
} from "./coordinator-auth-lifecycle-admission-schema.js";
import {
	AUTH_LIFECYCLE_BROWSER_SEQUENCE_GUARD_STATEMENTS,
	AUTH_LIFECYCLE_BROWSER_TRANSACTION_INDEX_STATEMENTS,
	AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL,
} from "./coordinator-auth-lifecycle-browser-schema.js";
import {
	AUTH_LIFECYCLE_ACCOUNT_PROFILE_TABLE_SQL,
	AUTH_LIFECYCLE_LINK_PROFILE_TABLE_SQL,
	AUTH_LINK_PROFILE_REFRESH_TABLE_SQL,
} from "./coordinator-auth-lifecycle-profile-schema.js";
import {
	AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
	AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL,
	AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
	AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
	AUTH_DEVICE_CLAIM_FIRST_GENERATION_GUARD_SQL,
	AUTH_LINK_AUDIT_RECEIPT_GUARD_STATEMENTS,
} from "./coordinator-auth-lifecycle-schema.js";
import {
	AUTH_LINK_CHANGE_ATTEMPT_GUARD_STATEMENTS,
	AUTH_LINK_CHANGE_ATTEMPT_INDEX_STATEMENTS,
	AUTH_LINK_CHANGE_ATTEMPT_TABLE_SQL,
	AUTH_LINK_CHANGE_END_RECEIPT_GUARD_SQL,
} from "./coordinator-auth-link-change-schema.js";
import { AUTH_LINK_SCHEMA_SQL } from "./coordinator-auth-link-contract.js";
import { AUTH_SESSION_SCHEMA_SQL } from "./coordinator-auth-session-contract.js";

/** Only the current, trigger-free table/index source strings enter this helper.
 * Reject an unrecognized remainder rather than splitting future trigger bodies.
 * Current literals in these sources contain no statement delimiters.
 */
function currentStorageStatements(source: string): string[] {
	const pattern = /CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS \w+[\s\S]*?;/gu;
	const statements = source.match(pattern);
	if (!statements || source.replace(pattern, "").trim())
		throw new Error("auth_lifecycle_current_storage_invalid");
	return statements;
}

const currentLinkStorage = currentStorageStatements(AUTH_LINK_SCHEMA_SQL);
const continuationColumns = AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS.map((sql) =>
	sql
		.trim()
		.replace(/^ALTER TABLE \w+ ADD COLUMN /u, "")
		.replace(/;$/u, ""),
).join(", ");
const attemptTable = currentLinkStorage.find((sql) =>
	sql.startsWith("CREATE TABLE IF NOT EXISTS coordinator_auth_link_attempts "),
);
if (!attemptTable) throw new Error("auth_lifecycle_current_attempts_missing");

/** Fresh-only auth storage. Caller must first prove there is no existing auth
 * schema; IF NOT EXISTS is not a preserving upgrade strategy. Controller,
 * Identity, group, owner-enrollment and device ledgers remain caller-owned.
 * No historical migration, frozen predecessor inventory, or TEMP inspection.
 */
export const AUTH_LIFECYCLE_FRESH_SCHEMA_STATEMENTS = Object.freeze(
	[
		attemptTable.replace(/PRIMARY KEY /u, `${continuationColumns}, PRIMARY KEY `),
		...currentLinkStorage.filter(
			(sql) =>
				!sql.startsWith("CREATE TABLE IF NOT EXISTS coordinator_auth_link_attempts ") &&
				!sql.startsWith("CREATE TABLE IF NOT EXISTS coordinator_auth_account_links "),
		),
		AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL,
		AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
		AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL,
		...currentStorageStatements(AUTH_BROWSER_TXN_SCHEMA_SQL).filter((sql) =>
			sql.startsWith("CREATE TABLE IF NOT EXISTS coordinator_auth_signin_purge_floors "),
		),
		...currentStorageStatements(AUTH_SESSION_SCHEMA_SQL),
		AUTH_LIFECYCLE_ACCOUNT_PROFILE_TABLE_SQL,
		AUTH_LIFECYCLE_LINK_PROFILE_TABLE_SQL,
		AUTH_LINK_PROFILE_REFRESH_TABLE_SQL,
		AUTH_LINK_CHANGE_ATTEMPT_TABLE_SQL,
		...COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS,
		...AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
		...AUTH_LIFECYCLE_BROWSER_TRANSACTION_INDEX_STATEMENTS,
		...AUTH_LINK_CHANGE_ATTEMPT_INDEX_STATEMENTS,
		...AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
		...AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS,
		...AUTH_LINK_AUDIT_RECEIPT_GUARD_STATEMENTS,
		AUTH_DEVICE_CLAIM_FIRST_GENERATION_GUARD_SQL,
		...AUTH_LIFECYCLE_BROWSER_SEQUENCE_GUARD_STATEMENTS,
		...AUTH_LIFECYCLE_CONTINUATION_GUARD_STATEMENTS,
		...AUTH_LIFECYCLE_SESSION_ADMISSION_GUARD_STATEMENTS,
		...AUTH_LINK_CHANGE_ATTEMPT_GUARD_STATEMENTS,
		AUTH_LINK_CHANGE_END_RECEIPT_GUARD_SQL,
	].map((sql) => sql.trim().replace(/;\s*$/u, "")),
);

export const AUTH_LIFECYCLE_FRESH_SCHEMA_SQL = `${AUTH_LIFECYCLE_FRESH_SCHEMA_STATEMENTS.join(";\n")};\n`;

/** Current definitions shared with readiness, not a schema-version marker. */
export const AUTH_LIFECYCLE_CURRENT_DEFINITIONS = Object.freeze(
	AUTH_LIFECYCLE_FRESH_SCHEMA_STATEMENTS.map((statement) => {
		const sql = statement
			.replace(/^(?:\s|--[^\n]*\n)*/u, "")
			.replace(/^CREATE (TABLE|TRIGGER|(?:UNIQUE )?INDEX) IF NOT EXISTS /u, "CREATE $1 ");
		const header = /^CREATE (TABLE|TRIGGER|(?:UNIQUE )?INDEX) (\w+)/u.exec(sql);
		if (!header?.[1] || !header[2]) throw new Error("auth_lifecycle_current_definition_invalid");
		const type = header[1].includes("INDEX") ? "index" : header[1].toLowerCase();
		return Object.freeze({ name: header[2], type, sql });
	}),
);
