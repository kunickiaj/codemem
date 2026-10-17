import { AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS } from "./coordinator-auth-lifecycle-admission-schema.js";
import { AUTH_LIFECYCLE_CURRENT_DEFINITIONS } from "./coordinator-auth-lifecycle-fresh-schema.js";
import { AUTH_LIFECYCLE_PREDECESSOR_TABLES } from "./coordinator-auth-lifecycle-predecessor-shapes.js";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const punctuation = ["(", ")", ",", "=", "<", ">", "+"];
const renamedTables = new Set([
	"coordinator_auth_link_attempts",
	"coordinator_auth_account_links",
	"coordinator_auth_link_audit_log",
	"coordinator_auth_browser_transactions",
	"coordinator_auth_link_profiles",
]);

/** Frozen input is used only to recognize reviewed upgrade forms, never to
 * create fresh storage. Other current definitions come from the fresh leaf.
 */
function variantsFor(definition: (typeof AUTH_LIFECYCLE_CURRENT_DEFINITIONS)[number]): string[] {
	const variants = [definition.sql];
	if (definition.name === "coordinator_auth_link_attempts") {
		const old = AUTH_LIFECYCLE_PREDECESSOR_TABLES.find(({ name }) => name === definition.name);
		if (!old) throw new Error("auth_lifecycle_current_upgrade_variant_missing");
		const columns = AUTH_LIFECYCLE_CONTINUATION_COLUMN_STATEMENTS.map((sql) =>
			sql
				.trim()
				.replace(/^ALTER TABLE \w+ ADD COLUMN /u, "")
				.replace(/;$/u, ""),
		).join(", ");
		variants.push(
			...old.variants.map((sql) => sql.replace(/PRIMARY KEY /u, `${columns}, PRIMARY KEY `)),
		);
	}
	if (definition.type === "table" && renamedTables.has(definition.name)) {
		variants.push(definition.sql.replace(`TABLE ${definition.name}`, `TABLE "${definition.name}"`));
	}
	return [...new Set(variants)];
}

function expectedDefinition(definition: (typeof AUTH_LIFECYCLE_CURRENT_DEFINITIONS)[number]) {
	const variants = variantsFor(definition);
	const literals = [...new Set(variants.join("\n").match(/'(?:[^']|'')*'/gu))];
	return {
		name: definition.name,
		type: definition.type,
		literals,
		variants: variants.map((value) => {
			let sql = value;
			for (const [i, literal] of literals.entries())
				sql = sql.replaceAll(literal, `@{literal:${i}}@`);
			sql = sql.replace(/[\t\r\n]/gu, " ");
			for (let i = 0; i < 8; i++) sql = sql.replaceAll("  ", " ");
			for (const p of punctuation) sql = sql.replaceAll(` ${p}`, p).replaceAll(`${p} `, p);
			return sql.trim();
		}),
	};
}

const definitions = AUTH_LIFECYCLE_CURRENT_DEFINITIONS.map(expectedDefinition);
// Fixed metadata only. The recursive stage applies each definition's finite
// literal list, avoiding duplicated expression trees and a >100-KB D1 query.
// It is the existing boundary-safe normalizer, not a parser for arbitrary SQL.
const expectedJson = quote(JSON.stringify(definitions));
let layoutSql = "replace(replace(replace(actual_sql, char(9), ' '), char(13), ' '), char(10), ' ')";
for (let i = 0; i < 8; i++) layoutSql = `replace(${layoutSql}, '  ', ' ')`;
let canonicalSql = "layout_sql";
for (const p of punctuation)
	canonicalSql = `replace(replace(${canonicalSql}, ${quote(` ${p}`)}, ${quote(p)}), ${quote(`${p} `)}, ${quote(p)})`;

const knownObject =
	"EXISTS (SELECT 1 FROM expected e WHERE e.type = m.type AND e.name = lower(m.name))";
const affectedTable =
	"EXISTS (SELECT 1 FROM expected e WHERE e.type = 'table' AND e.name = lower(m.tbl_name))";
const dependencies =
	"EXISTS (SELECT 1 FROM expected e WHERE e.type = 'table' AND instr(lower(m.sql), e.name) > 0)";
const reserved = `EXISTS (SELECT 1 FROM expected e WHERE e.type = 'table'
 AND instr(lower(m.name), e.name || '_') = 1)
 OR instr(lower(m.name), 'coordinator_auth_lifecycle_') = 1
 OR lower(m.name) = 'coordinator_lifecycle_upgrade_checks'`;

/** Exact expected definition matches plus three closed-inventory checks.
 * Consumers must compare equality; this is not a schema version or data guard.
 * TEMP protection belongs to the SQLite caller, not this portable D1 query.
 */
export const AUTH_LIFECYCLE_CURRENT_READY_COUNT = definitions.length + 3;
export const AUTH_LIFECYCLE_CURRENT_READINESS_SQL = `WITH RECURSIVE
 expected AS MATERIALIZED (
  SELECT json_extract(value,'$.name') AS name,json_extract(value,'$.type') AS type,
   json_extract(value,'$.variants') AS variants,json_extract(value,'$.literals') AS literals
  FROM json_each(${expectedJson})
 ), replaced(name,type,variants,literals,actual_sql,step) AS (
  SELECT e.name,e.type,e.variants,e.literals,m.sql,0 FROM expected e JOIN sqlite_master m
   ON m.type = e.type AND m.name = e.name COLLATE NOCASE
  UNION ALL
  SELECT name,type,variants,literals,
   replace(actual_sql,json_extract(literals,'$[' || step || ']'),'@{literal:' || step || '}@'),step+1
  FROM replaced WHERE step < json_array_length(literals)
 ), layout AS MATERIALIZED (
  SELECT name,type,variants,${layoutSql} AS layout_sql FROM replaced
   WHERE step = json_array_length(literals)
 ), matched AS MATERIALIZED (
  SELECT name,type FROM layout WHERE trim(${canonicalSql}) IN (SELECT value FROM json_each(variants))
 )
 SELECT (SELECT count(*) FROM expected e WHERE EXISTS (SELECT 1 FROM matched v WHERE v.name = e.name AND v.type = e.type))
 + (NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.sql IS NOT NULL AND ${affectedTable} AND NOT ${knownObject}))
 + (NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type IN ('table','view','trigger') AND NOT ${knownObject} AND ${dependencies}))
 + (NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE NOT ${knownObject} AND (${reserved}))) AS ready`;

if (new TextEncoder().encode(AUTH_LIFECYCLE_CURRENT_READINESS_SQL).byteLength >= 100000) {
	throw new Error("auth_lifecycle_current_readiness_too_large");
}
