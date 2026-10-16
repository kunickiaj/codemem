import type { Database } from "better-sqlite3";
import {
	AUTH_DEVICE_CLAIM_DEFINITION_CHECKS,
	COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS,
} from "./coordinator-auth-device-claim-schema.js";

/**
 * Planned, explicit upgrade source only. Nothing imports this from store-open or
 * Worker migrations. Current writers must be converted before deployment.
 * These legacy definitions are frozen: do not derive them from fresh-store DDL.
 */
const ATTEMPTS = "coordinator_auth_link_attempts";
const LINKS = "coordinator_auth_account_links";
const AUDIT = "coordinator_auth_link_audit_log";
const CHECKS = "coordinator_auth_link_authority_upgrade_checks";
const hash = (column: string) =>
	`${column} TEXT NOT NULL CHECK (length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*')`;
const optionalHash = (column: string) =>
	`${column} TEXT CHECK (${column} IS NULL OR (length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'))`;
const browserStart = optionalHash("browser_start_hash");

const attemptColumns = [
	"coordinator_id TEXT NOT NULL",
	"attempt_id TEXT NOT NULL",
	"identity_id TEXT NOT NULL",
	"group_id TEXT NOT NULL",
	"device_id TEXT NOT NULL",
	"public_key TEXT NOT NULL",
	hash("fingerprint"),
	"controller_attestation_id TEXT NOT NULL",
	"controller_review_receipt_id TEXT NOT NULL",
	"controller_revision INTEGER NOT NULL CHECK (controller_revision = 1)",
	"issuer TEXT NOT NULL",
	hash("auth_config_revision"),
	hash("runtime_verifier_hash"),
	"loopback_redirect TEXT NOT NULL",
	"state TEXT NOT NULL CHECK (state IN ('pending','browser_claimed','oidc_verified','confirmed','finalized','session_redeemed','expired','failed'))",
	optionalHash("browser_transaction_hash"),
	"account_subject TEXT CHECK (account_subject IS NULL OR length(account_subject) BETWEEN 1 AND 255)",
	optionalHash("completion_secret_hash"),
	"link_id TEXT",
	"failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('device_cancelled','browser_cancelled','provider_failure','config_failure'))",
	"created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0 AND created_at_ms <= 9007199254140991)",
	"expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms = created_at_ms + 600000)",
	"claimed_at_ms INTEGER",
	"oidc_verified_at_ms INTEGER",
	"confirmed_at_ms INTEGER",
	"finalized_at_ms INTEGER",
	"failed_at_ms INTEGER",
	browserStart,
];
const attemptConstraints = [
	"PRIMARY KEY (coordinator_id, attempt_id)",
	"UNIQUE (coordinator_id, runtime_verifier_hash)",
	"UNIQUE (coordinator_id, browser_transaction_hash)",
	"UNIQUE (coordinator_id, completion_secret_hash)",
	"UNIQUE (coordinator_id, link_id)",
	"CHECK (state <> 'pending' OR (browser_transaction_hash IS NULL AND account_subject IS NULL AND completion_secret_hash IS NULL AND link_id IS NULL))",
	"CHECK (state NOT IN ('browser_claimed','oidc_verified','confirmed','finalized','session_redeemed') OR browser_transaction_hash IS NOT NULL)",
	"CHECK (state NOT IN ('oidc_verified','confirmed','finalized','session_redeemed') OR account_subject IS NOT NULL)",
	"CHECK (state NOT IN ('confirmed','finalized','session_redeemed') OR completion_secret_hash IS NOT NULL)",
	"CHECK ((state IN ('finalized','session_redeemed') AND link_id IS NOT NULL AND finalized_at_ms IS NOT NULL) OR (state NOT IN ('finalized','session_redeemed') AND link_id IS NULL AND finalized_at_ms IS NULL))",
	"CHECK ((state = 'failed' AND failure_reason IS NOT NULL AND failed_at_ms IS NOT NULL) OR (state <> 'failed' AND failure_reason IS NULL AND failed_at_ms IS NULL))",
];
const tables = [
	{ name: ATTEMPTS, columns: attemptColumns, constraints: attemptConstraints },
	{
		name: LINKS,
		columns: [
			"coordinator_id TEXT NOT NULL",
			"link_id TEXT NOT NULL",
			"issuer TEXT NOT NULL",
			"subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255)",
			"identity_id TEXT NOT NULL",
			"attempt_id TEXT NOT NULL",
			"controller_attestation_id TEXT NOT NULL",
			hash("auth_config_revision"),
			"created_at_ms INTEGER NOT NULL",
			"revoked_at_ms INTEGER",
		],
		constraints: [
			"PRIMARY KEY (coordinator_id, link_id)",
			"UNIQUE (coordinator_id, issuer, subject)",
			"UNIQUE (coordinator_id, identity_id)",
			"UNIQUE (coordinator_id, attempt_id)",
		],
	},
	{
		name: AUDIT,
		columns: [
			"coordinator_id TEXT NOT NULL",
			"link_id TEXT NOT NULL",
			"action TEXT NOT NULL CHECK (action IN ('link_created','link_revoked'))",
			"attempt_id TEXT NOT NULL",
			"identity_id TEXT NOT NULL",
			"group_id TEXT NOT NULL",
			"device_id TEXT NOT NULL",
			hash("fingerprint"),
			"controller_attestation_id TEXT NOT NULL",
			hash("auth_config_revision"),
			"created_at_ms INTEGER NOT NULL",
		],
		constraints: ["PRIMARY KEY (coordinator_id, link_id, action)"],
	},
] as const;
const indexes = [
	`CREATE INDEX idx_auth_link_attempts_device_created ON ${ATTEMPTS}(coordinator_id, group_id, device_id, created_at_ms)`,
	`CREATE INDEX idx_auth_link_attempts_identity_expiry ON ${ATTEMPTS}(coordinator_id, identity_id, expires_at_ms)`,
	`CREATE INDEX idx_auth_link_attempts_state_expiry ON ${ATTEMPTS}(coordinator_id, state, expires_at_ms)`,
	`CREATE UNIQUE INDEX idx_auth_link_attempts_browser_start ON ${ATTEMPTS}(coordinator_id, browser_start_hash)`,
];
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
// Preserve literal bytes while ignoring DDL layout. A changed CHECK literal is
// not a recognized schema, even when only whitespace inside that literal differs.
const literals = [
	...new Set(
		tables
			.flatMap((table) => [...table.columns, ...table.constraints])
			.join(" ")
			.match(/'[^']*'/gu),
	),
];
const canonical = (sql: string) => {
	let protectedSql = sql;
	for (const [index, literal] of literals.entries())
		protectedSql = protectedSql.replaceAll(literal, `literal_${index}`);
	return protectedSql.replaceAll("IF NOT EXISTS", "").replace(/[\s"]/gu, "");
};
const canonicalSql = (expression: string) => {
	let protectedSql = expression;
	for (const [index, literal] of literals.entries())
		protectedSql = `replace(${protectedSql}, ${quote(literal)}, 'literal_${index}')`;
	return `replace(replace(replace(replace(replace(replace(${protectedSql}, 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), '"', '')`;
};
const createTable = (name: string, definitions: readonly string[]) =>
	`CREATE TABLE ${name} (${definitions.join(",\n")})`;
const assertion = (condition: string) => `INSERT INTO ${CHECKS} VALUES ((${condition}));`;
const validReference = (column: string) =>
	`(${column} IS NOT NULL AND typeof(${column}) = 'text' AND length(${column}) BETWEEN 1 AND 256 AND ${column} = trim(${column}) AND instr(${column}, char(0)) = 0)`;

function authorityDefinition(table: (typeof tables)[number]): string {
	const columns = table.columns.map((column) => {
		if (column.startsWith("controller_revision ")) return "controller_revision INTEGER";
		if (column.startsWith("controller_")) return column.replace(" NOT NULL", "");
		return column;
	});
	columns.push(
		"authority_kind TEXT NOT NULL CHECK (authority_kind IN ('controller_attestation','device_claim'))",
	);
	let attested = validReference("controller_attestation_id");
	let device = "controller_attestation_id IS NULL";
	if (table.name === ATTEMPTS) {
		attested += ` AND ${validReference("controller_review_receipt_id")} AND controller_revision IS NOT NULL AND typeof(controller_revision) = 'integer' AND controller_revision = 1`;
		device += " AND controller_review_receipt_id IS NULL AND controller_revision IS NULL";
	} else {
		columns.push("device_claim_id TEXT");
		attested += " AND device_claim_id IS NULL";
		device += ` AND ${validReference("device_claim_id")}`;
	}
	return createTable(`${table.name}_authority_upgrade`, [
		...columns,
		...table.constraints,
		...(table.name === LINKS ? ["UNIQUE (device_claim_id)"] : []),
		`CHECK ((authority_kind = 'controller_attestation' AND ${attested}) OR (authority_kind = 'device_claim' AND ${device}))`,
	]);
}

function recognizedSchema(): string {
	return tables
		.map((table) => {
			const definitions = [...table.columns, ...table.constraints];
			const accepted = [canonical(createTable(table.name, definitions))];
			if (table.name === ATTEMPTS) {
				// ALTER ADD COLUMN in migration 0025 puts this column after table CHECKs.
				accepted.push(
					canonical(
						createTable(table.name, [
							...table.columns.filter((column) => column !== browserStart),
							...table.constraints,
							browserStart,
						]),
					),
				);
			}
			return assertion(
				`EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${quote(table.name)} AND ${canonicalSql("sql")} IN (${accepted.map(quote).join(",")}))`,
			);
		})
		.join("\n");
}

const sameLinkPins = `a.coordinator_id = l.coordinator_id AND a.attempt_id = l.attempt_id
 AND a.link_id = l.link_id AND a.identity_id = l.identity_id AND a.issuer = l.issuer
 AND a.account_subject = l.subject AND a.controller_attestation_id = l.controller_attestation_id
 AND a.auth_config_revision = l.auth_config_revision AND a.finalized_at_ms = l.created_at_ms
 AND a.state IN ('finalized','session_redeemed')`;
const auditPins = `e.coordinator_id = a.coordinator_id AND e.link_id = a.link_id
 AND e.attempt_id = a.attempt_id AND e.identity_id = a.identity_id
 AND e.group_id = a.group_id AND e.device_id = a.device_id AND e.fingerprint = a.fingerprint
 AND e.controller_attestation_id = a.controller_attestation_id AND e.auth_config_revision = a.auth_config_revision`;
// The legacy API's isAuthControllerId rejects Unicode Cc/Cf/Cs and edge
// whitespace, and counts UTF-16 units. SQLite length/trim alone do not match it.
const forbiddenCodepoints = [
	[0, 31],
	[127, 159],
	[173, 173],
	[1536, 1541],
	[1564, 1564],
	[1757, 1757],
	[1807, 1807],
	[2192, 2193],
	[2274, 2274],
	[6158, 6158],
	[8203, 8207],
	[8234, 8238],
	[8288, 8292],
	[8294, 8303],
	[55296, 57343],
	[65279, 65279],
	[65529, 65531],
	[69821, 69821],
	[69837, 69837],
	[78896, 78911],
	[113824, 113827],
	[119155, 119162],
	[917505, 917505],
	[917536, 917631],
];
const idColumns = (table: (typeof tables)[number]) =>
	table.columns
		.map((column) => column.slice(0, column.indexOf(" ")))
		.filter((column) => column.endsWith("_id"));
const referenceTypes = tables.map((table) =>
	assertion(
		`NOT EXISTS (SELECT 1 FROM ${table.name} WHERE ${idColumns(table)
			.map((column) => `typeof(${column}) NOT IN ('text','null')`)
			.join(" OR ")})`,
	),
);
const legacyReferenceValidation = assertion(`NOT EXISTS (
 WITH RECURSIVE retained_refs(value) AS (
  ${tables
		.map((table) => {
			const columns = idColumns(table).map((column) => `legacy.${column}`);
			return `SELECT ids.value FROM ${table.name} legacy, json_each(json_array(${columns.join(", ")})) ids`;
		})
		.join(" UNION ")}),
 refs(value) AS (SELECT value FROM retained_refs WHERE value IS NOT NULL),
 characters(value, position, cp) AS (
 SELECT value, 1, unicode(substr(value, 1, 1)) FROM refs
 UNION ALL SELECT value, position + 1, unicode(substr(value, position + 1, 1)) FROM characters
 WHERE position < length(value) AND position < 256)
 SELECT value FROM characters GROUP BY value HAVING NOT ${validReference("value")}
 OR sum(CASE WHEN cp > 65535 THEN 2 ELSE 1 END) > 256
 OR max(${forbiddenCodepoints.map(([start, end]) => `(cp BETWEEN ${start} AND ${end})`).join(" OR ")}
 OR (position IN (1, length(value)) AND cp IN (32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))) = 1)`);
const provenance = [
	...referenceTypes,
	legacyReferenceValidation,
	assertion(
		`NOT EXISTS (SELECT 1 FROM ${ATTEMPTS} WHERE state IN ('pending','browser_claimed','oidc_verified','confirmed'))`,
	),
	assertion(`NOT EXISTS (SELECT 1 FROM ${ATTEMPTS} a
 JOIN coordinator_auth_controller_attestations c ON c.coordinator_id = a.coordinator_id
 AND (c.attestation_id = a.controller_attestation_id OR c.review_receipt_id = a.controller_review_receipt_id)
 WHERE NOT (c.attestation_id IS a.controller_attestation_id AND c.review_receipt_id IS a.controller_review_receipt_id
 AND c.revision IS a.controller_revision AND c.identity_id IS a.identity_id AND c.group_id IS a.group_id
 AND c.device_id IS a.device_id AND c.public_key IS a.public_key AND c.fingerprint IS a.fingerprint))`),
	assertion(
		`NOT EXISTS (SELECT 1 FROM ${LINKS} l WHERE NOT EXISTS (SELECT 1 FROM ${ATTEMPTS} a WHERE ${sameLinkPins}))`,
	),
	assertion(
		`NOT EXISTS (SELECT 1 FROM ${ATTEMPTS} a WHERE a.link_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${LINKS} l WHERE ${sameLinkPins}))`,
	),
	assertion(`NOT EXISTS (SELECT 1 FROM ${LINKS} l JOIN ${ATTEMPTS} a ON ${sameLinkPins}
 WHERE NOT EXISTS (SELECT 1 FROM ${AUDIT} e WHERE ${auditPins} AND e.action = 'link_created' AND e.created_at_ms = l.created_at_ms)
 OR (l.revoked_at_ms IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${AUDIT} e WHERE ${auditPins} AND e.action = 'link_revoked' AND e.created_at_ms = l.revoked_at_ms)))`),
	assertion(`NOT EXISTS (SELECT 1 FROM ${AUDIT} e WHERE NOT EXISTS (
 SELECT 1 FROM ${LINKS} l JOIN ${ATTEMPTS} a ON ${sameLinkPins} WHERE ${auditPins}
 AND ((e.action = 'link_created' AND e.created_at_ms = l.created_at_ms)
 OR (e.action = 'link_revoked' AND e.created_at_ms = l.revoked_at_ms))))`),
].join("\n");

function copyAndCompare(): string {
	return tables
		.map((table) => {
			const columns = table.columns.map((column) => column.split(" ")[0]).join(", ");
			const rebuilt = `${table.name}_authority_upgrade`;
			const select = `rowid, ${columns}`;
			return `${authorityDefinition(table)};
INSERT INTO ${rebuilt} (${select}, authority_kind) SELECT ${select}, 'controller_attestation' FROM ${table.name};
${assertion(`(SELECT count(*) FROM ${table.name}) = (SELECT count(*) FROM ${rebuilt})`)}
${assertion(`NOT EXISTS (SELECT ${select} FROM ${table.name} EXCEPT SELECT ${select} FROM ${rebuilt})`)}
${assertion(`NOT EXISTS (SELECT ${select} FROM ${rebuilt} EXCEPT SELECT ${select} FROM ${table.name})`)}`;
		})
		.join("\n");
}

/**
 * Exact D1 batch statements, deliberately outside the auto-discovered migration
 * directory. No BEGIN/COMMIT or FK toggle. All assertions and comparisons precede
 * every swap. An existing assertion/rebuild object aborts; it is never reused.
 * Missing historical controllers/enrollments do not erase completed provenance.
 * Unknown schema, custom indexes/triggers, or external DDL mentioning these
 * tables requires review (including inbound FKs/views). D1 disallows the table-valued
 * foreign-key PRAGMA, so this conservative text check can also reject benign DDL.
 */
export const AUTH_LINK_AUTHORITY_UPGRADE_SQL = `
CREATE TABLE ${CHECKS} (passed INTEGER NOT NULL CHECK (passed = 1));
${AUTH_DEVICE_CLAIM_DEFINITION_CHECKS.map(({ name, matches }) => assertion(`NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name = ${quote(name)}) OR ${matches}`)).join("\n")}
${recognizedSchema()}
${assertion(`(SELECT count(*) FROM sqlite_master WHERE tbl_name IN (${tables.map((t) => quote(t.name)).join(",")}) AND type IN ('index','trigger') AND sql IS NOT NULL) = ${indexes.length}`)}
${indexes.map((sql) => assertion(`EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND ${canonicalSql("sql")} = ${quote(canonical(sql))})`)).join("\n")}
${assertion(`NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type IN ('table','view','trigger') AND tbl_name NOT IN (${tables.map((t) => quote(t.name)).join(",")}) AND (${tables.map((t) => `instr(lower(sql), ${quote(t.name)}) > 0`).join(" OR ")}))`)}
${provenance}
${copyAndCompare()}
${tables.map((table) => `DROP TABLE ${table.name};\nALTER TABLE ${table.name}_authority_upgrade RENAME TO ${table.name};`).join("\n")}
${indexes.join(";\n")};
DROP TABLE ${CHECKS};
`;

/** Only the link-table source above has no triggers; each proof trigger stays one statement. */
export const AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS = Object.freeze([
	...AUTH_LINK_AUTHORITY_UPGRADE_SQL.split(";")
		.map((sql) => sql.trim())
		.filter(Boolean),
	...COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS,
]);
export const AUTH_LINK_AUTHORITY_CUTOVER_SQL = AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS.join(";\n");

/** Explicit invocation only; never call on open. Failure rolls back all DDL/data, including proofs. */
export function upgradeAuthLinkAuthoritySchema(db: Database): void {
	db.transaction(() => db.exec(AUTH_LINK_AUTHORITY_CUTOVER_SQL)).immediate();
}
