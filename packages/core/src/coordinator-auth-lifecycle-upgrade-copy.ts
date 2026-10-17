import { AUTH_LIFECYCLE_PREDECESSOR_TABLES } from "./coordinator-auth-lifecycle-predecessor-shapes.js";

/** Inert SQL only. The operator transaction owns recognition, checks, swaps and
 * scratch cleanup. Drop owned snapshots only after every preservation check.
 * Never use these builders on a live store or before predecessor recognition.
 */
export const AUTH_LIFECYCLE_COPY_TABLE_NAMES = Object.freeze([
	"coordinator_auth_link_attempts",
	"coordinator_auth_account_links",
	"coordinator_auth_link_audit_log",
	"coordinator_auth_browser_transactions",
	"coordinator_auth_sessions",
	"coordinator_auth_session_receipts",
	"coordinator_auth_account_profiles",
	"coordinator_auth_link_profiles",
	"coordinator_auth_device_claims",
] as const);

export type AuthLifecycleCopyTable = (typeof AUTH_LIFECYCLE_COPY_TABLE_NAMES)[number];
export type AuthLifecycleCopyLocation = "original" | "upgrade" | "retained";
export interface AuthLifecycleSnapshotOptions {
	table: AuthLifecycleCopyTable;
	source?: "original" | "retained";
}
export interface AuthLifecycleCopyOptions extends AuthLifecycleSnapshotOptions {
	destination?: "original" | "upgrade";
	/** Browser sequence is an INTEGER PRIMARY KEY alias for the old rowid. */
	targetRowId?: "rowid" | "browser_sequence";
	/** New fields only; literals, never SQL expressions. Defaults belong to DDL. */
	extraColumns?: Readonly<Record<string, string | number | null>>;
}
export interface AuthLifecyclePreservationOptions {
	table: AuthLifecycleCopyTable;
	destination?: AuthLifecycleCopyLocation;
	targetRowId?: "rowid" | "browser_sequence";
}

// Frozen schema-10 WITHOUT ROWID proof columns, independent of future proof DDL.
const CLAIM_COLUMNS = Object.freeze([
	"claim_id",
	"coordinator_id",
	"identity_id",
	"group_id",
	"device_id",
	"public_key",
	"fingerprint",
	"key_id",
	"attempt_id",
	"issuer",
	"auth_config_revision",
	"created_at_ms",
]);
const LOCATION_SUFFIX = Object.freeze({
	original: "",
	upgrade: "_lifecycle_upgrade",
	retained: "_lifecycle_predecessor",
});

function quoteIdentifier(value: string): string {
	if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error("auth_lifecycle_invalid_identifier");
	return `"${value.replaceAll('"', '""')}"`;
}

// Qualification prevents SQLite DQS fallback from treating missing columns as strings.
function columnReference(name: string, alias: "s" | "before_snapshot" = "s"): string {
	return `${quoteIdentifier(alias)}.${quoteIdentifier(name)}`;
}

function oldColumns(table: AuthLifecycleCopyTable): readonly string[] {
	if (!AUTH_LIFECYCLE_COPY_TABLE_NAMES.includes(table)) {
		throw new Error("auth_lifecycle_unknown_copy_table");
	}
	if (table === "coordinator_auth_device_claims") return CLAIM_COLUMNS;
	const definition = AUTH_LIFECYCLE_PREDECESSOR_TABLES.find((entry) => entry.name === table);
	if (!definition) throw new Error("auth_lifecycle_missing_copy_inventory");
	return definition.columns.map(({ name }) => name);
}

function tableIdentifier(
	table: AuthLifecycleCopyTable,
	location: AuthLifecycleCopyLocation,
): string {
	if (!Object.hasOwn(LOCATION_SUFFIX, location)) throw new Error("auth_lifecycle_invalid_location");
	return quoteIdentifier(`${table}${LOCATION_SUFFIX[location]}`);
}

function snapshotIdentifier(table: AuthLifecycleCopyTable): string {
	return quoteIdentifier(
		`coordinator_auth_lifecycle_snapshot_${table.slice("coordinator_auth_".length)}`,
	);
}

function rowIdentity(table: AuthLifecycleCopyTable, targetRowId = "rowid"): string[] {
	if (targetRowId !== "rowid" && targetRowId !== "browser_sequence") {
		throw new Error("auth_lifecycle_invalid_row_identity");
	}
	if (targetRowId === "browser_sequence" && table !== "coordinator_auth_browser_transactions") {
		throw new Error("auth_lifecycle_browser_sequence_wrong_table");
	}
	if (table === "coordinator_auth_device_claims") return [];
	return [targetRowId];
}

/** CASE expressions have no declared affinity. In particular, CTAS must not
 * convert an original REAL to INTEGER or numerically interpret a TEXT value.
 * Numeric equality catches REAL changes hidden by SQLite's text rendering;
 * typeof distinguishes INTEGER/REAL and NULL, while hex retains TEXT/BLOB bytes.
 */
function encodedTuple(table: AuthLifecycleCopyTable, targetRowId = "rowid"): string[] {
	const identity = rowIdentity(table, targetRowId).map(
		(column) => `${columnReference(column)} AS "source_rowid"`,
	);
	return identity.concat(
		oldColumns(table).flatMap((name) => {
			const column = columnReference(name);
			return [
				`typeof(${column}) AS "${name}_storage_type"`,
				`hex(CAST(${column} AS BLOB)) AS "${name}_bytes"`,
				`CASE WHEN typeof(${column}) IN ('integer', 'real') THEN ${column} ELSE NULL END AS "${name}_numeric"`,
			];
		}),
	);
}

function snapshotColumns(table: AuthLifecycleCopyTable): string[] {
	const identity = rowIdentity(table).map(() => columnReference("source_rowid", "before_snapshot"));
	return identity.concat(
		oldColumns(table).flatMap((name) => [
			columnReference(`${name}_storage_type`, "before_snapshot"),
			columnReference(`${name}_bytes`, "before_snapshot"),
			columnReference(`${name}_numeric`, "before_snapshot"),
		]),
	);
}

/** No IF NOT EXISTS: stale or foreign scratch must fail, never be reused. */
export function authLifecycleSnapshotStatements(
	options: AuthLifecycleSnapshotOptions,
): readonly string[] {
	const tuple = encodedTuple(options.table);
	return Object.freeze([
		`CREATE TABLE ${snapshotIdentifier(options.table)} AS SELECT ${tuple.join(", ")} FROM ${tableIdentifier(options.table, options.source ?? "original")} AS "s"`,
	]);
}

function literal(value: string | number | null): string {
	if (value === null) return "NULL";
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new Error("auth_lifecycle_invalid_numeric_literal");
		return String(value);
	}
	if (typeof value !== "string" || value.includes("\0")) {
		throw new Error("auth_lifecycle_invalid_text_literal");
	}
	return `'${value.replaceAll("'", "''")}'`;
}

/** Copies originals directly, not their encoded snapshot. Appended fields are
 * deliberately absent unless supplied as explicit new-column literals.
 */
export function authLifecycleCopyStatement(options: AuthLifecycleCopyOptions): string {
	const columns = oldColumns(options.table);
	const extras = Object.entries(options.extraColumns ?? {});
	for (const [name] of extras) {
		if (columns.includes(name) || ["rowid", "_rowid_", "oid", "browser_sequence"].includes(name)) {
			throw new Error("auth_lifecycle_extra_column_overwrites_original");
		}
		quoteIdentifier(name);
	}
	const targets = rowIdentity(options.table, options.targetRowId)
		.map(quoteIdentifier)
		.concat(
			columns.map(quoteIdentifier),
			extras.map(([name]) => quoteIdentifier(name)),
		);
	const values = rowIdentity(options.table)
		.map((name) => columnReference(name))
		.concat(
			columns.map((name) => columnReference(name)),
			extras.map(([, value]) => literal(value)),
		);
	const source = tableIdentifier(options.table, options.source ?? "original");
	const destination = tableIdentifier(options.table, options.destination ?? "upgrade");
	if (source === destination) throw new Error("auth_lifecycle_copy_same_table");
	return `INSERT INTO ${destination} (${targets.join(", ")}) SELECT ${values.join(", ")} FROM ${source} AS "s"`;
}

/** Returns a scalar SQL predicate, not a SELECT statement or an assertion side
 * effect. The assembler must make a false result abort its whole transaction.
 * Counts plus both EXCEPT directions retain multiplicity and exact row identity.
 * This checks old fields only; new lifecycle invariants need separate checks.
 */
export function authLifecyclePreservationCheck(options: AuthLifecyclePreservationOptions): string {
	const snapshot = snapshotIdentifier(options.table);
	const before = `SELECT ${snapshotColumns(options.table).join(", ")} FROM ${snapshot} AS "before_snapshot"`;
	const destination = tableIdentifier(options.table, options.destination ?? "upgrade");
	const after = `SELECT ${encodedTuple(options.table, options.targetRowId).join(", ")} FROM ${destination} AS "s"`;
	return `((SELECT count(*) FROM ${snapshot}) = (SELECT count(*) FROM ${destination}) AND NOT EXISTS (${before} EXCEPT ${after}) AND NOT EXISTS (${after} EXCEPT ${before}))`;
}
