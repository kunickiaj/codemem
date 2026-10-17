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
	AUTH_SCHEMA_V2_READINESS_SQL,
	AUTH_SCHEMA_V2_READY_COUNT,
} from "./coordinator-auth-lifecycle-predecessor.js";
import {
	AUTH_LIFECYCLE_PREDECESSOR_DEFINITIONS,
	AUTH_LIFECYCLE_PREDECESSOR_TABLES,
} from "./coordinator-auth-lifecycle-predecessor-shapes.js";
import {
	AUTH_LIFECYCLE_ACCOUNT_PROFILE_TABLE_SQL,
	AUTH_LIFECYCLE_LINK_PROFILE_TABLE_SQL,
	AUTH_LINK_PROFILE_REFRESH_TABLE_SQL,
} from "./coordinator-auth-lifecycle-profile-schema.js";
import { AUTH_LIFECYCLE_PREDECESSOR_CHECKS } from "./coordinator-auth-lifecycle-recognition.js";
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
	AUTH_LIFECYCLE_COPY_TABLE_NAMES,
	type AuthLifecycleCopyTable,
	authLifecycleCopyStatement,
	authLifecyclePreservationCheck,
	authLifecycleSnapshotStatements,
} from "./coordinator-auth-lifecycle-upgrade-copy.js";
import {
	AUTH_LINK_CHANGE_ATTEMPT_GUARD_STATEMENTS,
	AUTH_LINK_CHANGE_ATTEMPT_INDEX_STATEMENTS,
	AUTH_LINK_CHANGE_ATTEMPT_TABLE_SQL,
	AUTH_LINK_CHANGE_END_RECEIPT_GUARD_SQL,
} from "./coordinator-auth-link-change-schema.js";

/** Explicit, unused migration source, not store initialization or public readiness.
 * Apply only in one approved transaction (D1 batch or the SQLite-only wrapper).
 * No BEGIN/COMMIT, TEMP objects, provider calls, restoration or automatic repair.
 */
// Outside the auth reserved prefixes so recognition does not reject its own
// assertion table. Plain CREATE rejects any pre-existing object at this name.
const CHECKS = "coordinator_lifecycle_upgrade_checks";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const assertion = (condition: string) =>
	`INSERT INTO ${CHECKS} (passed) SELECT CASE WHEN (${condition}) THEN 1 END`;
const clean = (sql: string) => sql.replace(/^(?:\s|--[^\n]*\n)*/u, "").replace(/;\s*$/u, "");
const columnDefinition = (sql: string) => clean(sql).replace(/^ALTER TABLE \w+ ADD COLUMN /u, "");

const rebuilds = [
	{
		table: "coordinator_auth_account_links",
		sql: AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
		extraColumns: { generation: 1, signin_sequence_floor: 0 },
	},
	{
		table: "coordinator_auth_browser_transactions",
		sql: AUTH_LIFECYCLE_BROWSER_TRANSACTION_TABLE_SQL,
		extraColumns: {},
	},
	{
		table: "coordinator_auth_link_profiles",
		sql: AUTH_LIFECYCLE_LINK_PROFILE_TABLE_SQL,
		extraColumns: { source_order: 0, source_purpose: "link" },
	},
] as const;
const accountProfileColumn =
	"source_order INTEGER NOT NULL DEFAULT 1 CHECK (typeof(source_order) = 'integer' AND source_order BETWEEN 1 AND 9007199254740991)";
const newTables = [
	AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL,
	AUTH_LINK_CHANGE_ATTEMPT_TABLE_SQL,
	AUTH_LINK_PROFILE_REFRESH_TABLE_SQL,
];
const newIndexes = [
	...AUTH_ACCOUNT_LINK_GENERATION_INDEX_STATEMENTS,
	...AUTH_LINK_CHANGE_ATTEMPT_INDEX_STATEMENTS,
];
const guards = [
	...AUTH_ACCOUNT_ASSOCIATION_GUARD_STATEMENTS,
	...AUTH_ACCOUNT_LINK_GENERATION_GUARD_STATEMENTS,
	...AUTH_LINK_AUDIT_RECEIPT_GUARD_STATEMENTS,
	AUTH_DEVICE_CLAIM_FIRST_GENERATION_GUARD_SQL,
	...AUTH_LIFECYCLE_BROWSER_SEQUENCE_GUARD_STATEMENTS,
	...AUTH_LIFECYCLE_CONTINUATION_GUARD_STATEMENTS,
	...AUTH_LIFECYCLE_SESSION_ADMISSION_GUARD_STATEMENTS,
	...AUTH_LINK_CHANGE_ATTEMPT_GUARD_STATEMENTS,
	AUTH_LINK_CHANGE_END_RECEIPT_GUARD_SQL,
];

function preservation(table: AuthLifecycleCopyTable, destination: "original" | "upgrade"): string {
	return assertion(
		authLifecyclePreservationCheck({
			table,
			destination,
			targetRowId: table === "coordinator_auth_browser_transactions" ? "browser_sequence" : "rowid",
		}),
	);
}

/** Boundary-safe, literal-preserving comparison of migration-generated DDL.
 * Materialized stages keep native D1 expression trees below its depth limit.
 * This is a migration postcondition, not an auth readiness API or SQL parser.
 */
function ddlMatches(variants: readonly string[]): string {
	const literals = [...new Set(variants.join("\n").match(/'(?:[^']|'')*'/gu))];
	const punctuation = ["(", ")", ",", "=", "<", ">", "+"];
	const normalize = (value: string) => {
		let sql = value;
		for (const [i, literal] of literals.entries())
			sql = sql.replaceAll(literal, `@{literal:${i}}@`);
		sql = sql.replace(/[\t\r\n]/gu, " ");
		for (let i = 0; i < 8; i++) sql = sql.replaceAll("  ", " ");
		for (const p of punctuation) sql = sql.replaceAll(` ${p}`, p).replaceAll(`${p} `, p);
		return sql.trim();
	};
	let protectedSql = "sql";
	for (const [i, literal] of literals.entries())
		protectedSql = `replace(${protectedSql}, ${quote(literal)}, '@{literal:${i}}@')`;
	let layoutSql =
		"replace(replace(replace(protected_sql, char(9), ' '), char(13), ' '), char(10), ' ')";
	for (let i = 0; i < 8; i++) layoutSql = `replace(${layoutSql}, '  ', ' ')`;
	let resultSql = "layout_sql";
	for (const p of punctuation)
		resultSql = `replace(replace(${resultSql}, ${quote(` ${p}`)}, ${quote(p)}), ${quote(`${p} `)}, ${quote(p)})`;
	return `EXISTS (WITH protected AS MATERIALIZED (SELECT ${protectedSql} AS protected_sql),
 layout AS MATERIALIZED (SELECT ${layoutSql} AS layout_sql FROM protected)
 SELECT 1 FROM layout WHERE trim(${resultSql}) IN (${variants.map((sql) => quote(normalize(sql))).join(",")}))`;
}

function createdDefinition(statement: string) {
	const sql = clean(statement).replace(
		/^CREATE (TABLE|TRIGGER|(?:UNIQUE )?INDEX) IF NOT EXISTS /u,
		"CREATE $1 ",
	);
	const header = /^CREATE (TABLE|TRIGGER|(?:UNIQUE )?INDEX) (\w+)/u.exec(sql);
	if (!header?.[2]) throw new Error("auth_lifecycle_upgrade_definition_invalid");
	const type = header[1]?.includes("INDEX") ? "index" : header[1]?.toLowerCase();
	return { name: header[2], type, variants: [sql] };
}

function finalDefinitions() {
	const alteredAttempts = AUTH_LIFECYCLE_PREDECESSOR_TABLES.find(
		({ name }) => name === "coordinator_auth_link_attempts",
	);
	if (!alteredAttempts) throw new Error("auth_lifecycle_upgrade_inventory_invalid");
	const continuationColumns =
		AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS.map(columnDefinition).join(", ");
	return [
		...AUTH_LIFECYCLE_PREDECESSOR_DEFINITIONS.filter(
			({ name }) =>
				!rebuilds.some(({ table }) => table === name) &&
				name !== "coordinator_auth_link_attempts" &&
				name !== "coordinator_auth_account_profiles",
		),
		{
			name: "coordinator_auth_link_attempts",
			type: "table",
			variants: alteredAttempts.variants.map((sql) =>
				sql.replace(/PRIMARY KEY /u, `${continuationColumns}, PRIMARY KEY `),
			),
		},
		createdDefinition(AUTH_LIFECYCLE_ACCOUNT_PROFILE_TABLE_SQL),
		...rebuilds.map(({ table, sql }) => ({
			...createdDefinition(sql),
			variants: [
				clean(sql).replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE "${table}"`),
			],
		})),
		...[
			...newTables,
			...newIndexes,
			...guards,
			...COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS,
		].map(createdDefinition),
	];
}

const finalObjects = finalDefinitions();
const finalTableNames = finalObjects
	.filter(({ type }) => type === "table")
	.map(({ name }) => quote(name));
const finalObjectKeys = finalObjects
	.map(({ type, name }) => `(${quote(type ?? "")}, ${quote(name)})`)
	.join(",");
const associationProjection = "coordinator_id,issuer,subject,identity_id,link_id,created_at_ms";
const associationCheck = `(SELECT count(*) FROM coordinator_auth_account_associations) = (SELECT count(*) FROM coordinator_auth_account_links)
 AND NOT EXISTS (SELECT ${associationProjection} FROM coordinator_auth_account_links
 EXCEPT SELECT coordinator_id,issuer,subject,identity_id,first_link_id,created_at_ms FROM coordinator_auth_account_associations)
 AND NOT EXISTS (SELECT coordinator_id,issuer,subject,identity_id,first_link_id,created_at_ms FROM coordinator_auth_account_associations
 EXCEPT SELECT ${associationProjection} FROM coordinator_auth_account_links)`;

/** Each array entry is one D1 statement. Never split this SQL on semicolons:
 * trigger bodies contain statement delimiters. No entry may exceed 100 KB.
 */
export const AUTH_LIFECYCLE_UPGRADE_STATEMENTS = Object.freeze(
	[
		`CREATE TABLE ${CHECKS} (passed INTEGER NOT NULL CHECK (passed = 1))`,
		...AUTH_LIFECYCLE_PREDECESSOR_CHECKS.map(({ matches }) => assertion(matches)),
		assertion(`(${AUTH_SCHEMA_V2_READINESS_SQL}) = ${AUTH_SCHEMA_V2_READY_COUNT}`),
		...AUTH_LIFECYCLE_COPY_TABLE_NAMES.flatMap((table) =>
			authLifecycleSnapshotStatements({ table }),
		),
		...AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS,
		`ALTER TABLE coordinator_auth_account_profiles ADD COLUMN ${accountProfileColumn}`,
		...rebuilds.flatMap(({ table, sql, extraColumns }) => [
			clean(sql).replace(
				`CREATE TABLE IF NOT EXISTS ${table}`,
				`CREATE TABLE ${table}_lifecycle_upgrade`,
			),
			authLifecycleCopyStatement({
				table,
				extraColumns,
				targetRowId:
					table === "coordinator_auth_browser_transactions" ? "browser_sequence" : "rowid",
			}),
			preservation(table, "upgrade"),
		]),
		...newTables.map(clean),
		`INSERT INTO coordinator_auth_account_associations (coordinator_id,issuer,subject,identity_id,first_link_id,created_at_ms)
 SELECT coordinator_id,issuer,subject,identity_id,link_id,created_at_ms FROM coordinator_auth_account_links`,
		assertion(associationCheck),
		...AUTH_LIFECYCLE_COPY_TABLE_NAMES.filter(
			(table) => !rebuilds.some((entry) => entry.table === table),
		).map((table) => preservation(table, "original")),
		...rebuilds.flatMap(({ table }) => [
			`DROP TABLE ${table}`,
			`ALTER TABLE ${table}_lifecycle_upgrade RENAME TO ${table}`,
		]),
		...AUTH_LIFECYCLE_BROWSER_TRANSACTION_INDEX_STATEMENTS,
		...newIndexes,
		...guards,
		...AUTH_LIFECYCLE_COPY_TABLE_NAMES.map((table) => preservation(table, "original")),
		assertion(associationCheck),
		assertion(
			"NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links WHERE generation <> 1 OR signin_sequence_floor <> 0 OR ended_at_ms IS NOT NULL OR end_reason IS NOT NULL OR end_attempt_id IS NOT NULL)",
		),
		assertion(
			"NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts WHERE prior_link_id IS NOT NULL OR prior_generation IS NOT NULL)",
		),
		assertion(
			"NOT EXISTS (SELECT 1 FROM coordinator_auth_account_profiles WHERE source_order <> 1)",
		),
		assertion(
			"NOT EXISTS (SELECT 1 FROM coordinator_auth_link_profiles WHERE source_order <> 0 OR source_purpose <> 'link')",
		),
		assertion(
			"(SELECT count(*) FROM coordinator_auth_link_change_attempts) = 0 AND (SELECT count(*) FROM coordinator_auth_link_profile_refreshes) = 0",
		),
		assertion(
			"coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'coordinator_auth_browser_transactions'),0) = coalesce((SELECT max(browser_sequence) FROM coordinator_auth_browser_transactions),0)",
		),
		...finalObjects.map(({ name, type, variants }) =>
			assertion(
				`EXISTS (SELECT 1 FROM sqlite_master WHERE type = ${quote(type ?? "")} AND name = ${quote(name)} COLLATE NOCASE AND ${ddlMatches(variants)})`,
			),
		),
		assertion(
			`NOT EXISTS (SELECT 1 FROM sqlite_master WHERE lower(tbl_name) IN (${finalTableNames.join(",")}) AND sql IS NOT NULL AND (type,lower(name)) NOT IN (VALUES ${finalObjectKeys}))`,
		),
		assertion(`(${AUTH_SCHEMA_V2_READINESS_SQL}) = ${AUTH_SCHEMA_V2_READY_COUNT - 1}`),
		...AUTH_LIFECYCLE_COPY_TABLE_NAMES.map(
			(table) =>
				`DROP TABLE coordinator_auth_lifecycle_snapshot_${table.slice("coordinator_auth_".length)}`,
		),
		`DROP TABLE ${CHECKS}`,
	].map(clean),
);

for (const statement of AUTH_LIFECYCLE_UPGRADE_STATEMENTS) {
	if (new TextEncoder().encode(statement).byteLength >= 100000)
		throw new Error("auth_lifecycle_upgrade_statement_too_large");
}
export const AUTH_LIFECYCLE_UPGRADE_SQL = `${AUTH_LIFECYCLE_UPGRADE_STATEMENTS.join(";\n")};\n`;
