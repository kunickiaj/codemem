import {
	AUTH_DEVICE_CLAIM_DEFINITION_CHECKS,
	COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS,
} from "./coordinator-auth-device-claim-schema.js";
import {
	AUTH_LIFECYCLE_PREDECESSOR_DEFINITIONS,
	AUTH_LIFECYCLE_PREDECESSOR_TABLES,
} from "./coordinator-auth-lifecycle-predecessor-shapes.js";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const tableNames = [
	...AUTH_LIFECYCLE_PREDECESSOR_TABLES.map(({ name }) => name),
	"coordinator_auth_device_claims",
];
const proofDefinitions = COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS.map((statement) => {
	const sql = statement.replace(/^(?:\s|--[^\n]*\n)*/u, "").replace(/;\s*$/u, "");
	const header = /^CREATE (TABLE|TRIGGER) IF NOT EXISTS (\w+)/u.exec(sql);
	if (!header?.[2]) throw new Error("auth_lifecycle_predecessor_proof_definition_invalid");
	const type: "table" | "trigger" = header[1] === "TABLE" ? "table" : "trigger";
	return Object.freeze({
		name: header[2],
		type,
		variants: Object.freeze([sql.replace(/^CREATE (TABLE|TRIGGER) IF NOT EXISTS /u, "CREATE $1 ")]),
	});
});
// SQLite triggers may share a table or index name. A known name alone must
// never exempt an unknown object in another namespace from validation.
const expectedObjects = [...AUTH_LIFECYCLE_PREDECESSOR_DEFINITIONS, ...proofDefinitions];
const expectedObjectsSql = expectedObjects
	.map(({ type, name }) => `(${quote(type)}, ${quote(name.toLowerCase())})`)
	.join(",");
const unknownObjectSql = `(type, lower(name)) NOT IN (VALUES ${expectedObjectsSql})`;

const layoutPunctuation = ["(", ")", ",", "=", "<", ">", "+"] as const;
const spaceCollapsePasses = 8;

/** Protect each definition's own literals before normalizing layout. Markers
 * are invalid unquoted SQL tokens, not identifiers an unknown DDL could reuse.
 * Keep word separators: TEXT NOT NULL must never match a TEXTNOTNULL type.
 * Keep identifier quotes: only explicitly listed renamed headers are accepted.
 * Eight collapse passes support space runs up to 256; longer formatting may
 * fail closed. Per-definition literal sets limit native D1 expression depth.
 */
function definitionCheck(definition: {
	name: string;
	type: "table" | "index" | "trigger";
	variants: readonly string[];
}): string {
	const literals = [...new Set(definition.variants.join("\n").match(/'(?:[^']|'')*'/gu))];
	const normalize = (value: string) => {
		let sql = value;
		for (const [index, literal] of literals.entries())
			sql = sql.replaceAll(literal, `@{literal:${index}}@`);
		sql = sql.replace(/[\t\r\n]/gu, " ");
		for (let pass = 0; pass < spaceCollapsePasses; pass++) sql = sql.replaceAll("  ", " ");
		for (const punctuation of layoutPunctuation)
			sql = sql
				.replaceAll(` ${punctuation}`, punctuation)
				.replaceAll(`${punctuation} `, punctuation);
		return sql.trim();
	};
	let expression = "sql";
	for (const [index, literal] of literals.entries())
		expression = `replace(${expression}, ${quote(literal)}, '@{literal:${index}}@')`;
	const protectedExpression = expression;
	expression = "protected_sql";
	expression = `replace(replace(replace(${expression}, char(9), ' '), char(13), ' '), char(10), ' ')`;
	for (let pass = 0; pass < spaceCollapsePasses; pass++)
		expression = `replace(${expression}, '  ', ' ')`;
	const layoutExpression = expression;
	expression = "layout_sql";
	for (const punctuation of layoutPunctuation)
		expression = `replace(replace(${expression}, ${quote(` ${punctuation}`)}, ${quote(punctuation)}), ${quote(`${punctuation} `)}, ${quote(punctuation)})`;
	expression = `trim(${expression})`;
	// Materialized stages keep normalizer expressions separate under native D1's
	// depth limit; ordinary CTEs may be flattened back into one expression.
	return `EXISTS (WITH protected_values AS MATERIALIZED (
 SELECT ${protectedExpression} AS protected_sql FROM sqlite_master WHERE type = ${quote(definition.type)}
 AND name = ${quote(definition.name)} COLLATE NOCASE
 ), layout_values AS MATERIALIZED (SELECT ${layoutExpression} AS layout_sql FROM protected_values)
 SELECT 1 FROM layout_values WHERE ${expression} IN (${definition.variants.map((sql) => quote(normalize(sql))).join(",")}))`;
}

// Retain the old exact-three fence, but do not inherit its whitespace-erasing
// comparison as the only migration check. Apply the same boundary-safe check
// to the contractually frozen proof statements without changing their source.
const proofBoundaryChecks = proofDefinitions.map((definition) =>
	Object.freeze({
		name: `${definition.name}_token_boundaries`,
		matches: definitionCheck(definition),
	}),
);

// Reject objects in migration-owned namespaces, including objects that do not
// yet reference a predecessor table. Unrelated app data remains out of scope.
const reservedPrefixes = [
	...tableNames.map((name) => `${name}_`),
	"coordinator_auth_account_associations",
	"coordinator_auth_link_change_attempts",
	"coordinator_auth_link_profile_refreshes",
	"coordinator_auth_lifecycle_",
	"coordinator_auth_link_authority_upgrade",
	"auth_account_associations_",
	"auth_account_links_",
	"auth_link_audit_",
	"auth_link_change_",
	"auth_link_profile_",
	"auth_browser_transaction_sequence_",
	"idx_auth_account_links_",
	"idx_auth_link_change_",
	"idx_auth_link_profile_refreshes",
	"idx_auth_link_attempts_",
	"idx_auth_browser_txn_",
	"idx_auth_sessions_",
	"idx_auth_session_receipts_",
];

/** Pure SQL predicates for future transactional assertion statements. No I/O or
 * migration execution. Missing tables may fail SQL preparation, which also
 * rejects the predecessor; callers must never interpret lookup errors as ready.
 * Copies must still compare all raw values and recheck target constraints.
 */
export const AUTH_LIFECYCLE_PREDECESSOR_CHECKS = Object.freeze([
	...AUTH_LIFECYCLE_PREDECESSOR_DEFINITIONS.map((definition) =>
		Object.freeze({ name: definition.name, matches: definitionCheck(definition) }),
	),
	...AUTH_DEVICE_CLAIM_DEFINITION_CHECKS.map((check) => Object.freeze({ ...check })),
	...proofBoundaryChecks,
	Object.freeze({
		name: "attached_objects",
		matches: `NOT EXISTS (SELECT 1 FROM sqlite_master
 WHERE lower(tbl_name) IN (${tableNames.map(quote).join(",")}) AND type IN ('index','trigger')
 AND sql IS NOT NULL AND ${unknownObjectSql})`,
	}),
	Object.freeze({
		name: "external_dependencies",
		// D1 does not support table-valued foreign_key_list. Conservatively reject
		// any external table/view/trigger mentioning a target, including comments.
		matches: `NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type IN ('table','view','trigger')
 AND ${unknownObjectSql}
 AND (${tableNames.map((name) => `instr(lower(sql), ${quote(name)}) > 0`).join(" OR ")}))`,
	}),
	Object.freeze({
		name: "reserved_names",
		matches: `NOT EXISTS (SELECT 1 FROM sqlite_master WHERE ${unknownObjectSql}
 AND (${reservedPrefixes.map((prefix) => `instr(lower(name), ${quote(prefix)}) = 1`).join(" OR ")}))`,
	}),
	Object.freeze({
		name: "row_storage_types",
		matches: AUTH_LIFECYCLE_PREDECESSOR_TABLES.map(
			(table) =>
				`NOT EXISTS (SELECT 1 FROM ${table.name} WHERE ${table.columns.map((column) => `(typeof(${column.name}) NOT IN (${quote(column.type.toLowerCase())},'null'))`).join(" OR ")})`,
		).join(" AND "),
	}),
	Object.freeze({
		name: "preservable_rowids",
		matches: `NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links WHERE rowid <= 0)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_audit_log WHERE rowid <= 0)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions
  WHERE rowid NOT BETWEEN 1 AND 9007199254740990)`,
	}),
]);

/** Use individual checks to locate a failed pin without exposing account data. */
export const AUTH_LIFECYCLE_PREDECESSOR_PREDICATE_SQL = AUTH_LIFECYCLE_PREDECESSOR_CHECKS.map(
	({ matches }) => `(${matches})`,
).join("\n AND ");

export const AUTH_LIFECYCLE_PREDECESSOR_RECOGNITION_SQL = `SELECT (${AUTH_LIFECYCLE_PREDECESSOR_PREDICATE_SQL}) AS recognized`;
