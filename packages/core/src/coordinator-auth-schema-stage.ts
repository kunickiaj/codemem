import {
	ACCOUNT_CONNECTION_SCHEMA_READINESS_SQL,
	ACCOUNT_UNLINK_MIGRATION_STATEMENTS,
	AUTH_V2_SCHEMA_READINESS_SQL,
	CONNECTION_SCHEMA_PRESENCE_SQL,
	hasPriorAccountSchema,
	PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
	PRIOR_ACCOUNT_CONNECTION_SCHEMA_READINESS_SQL,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS,
	AUTH_LINK_LEGACY_AUTHORITY_SCHEMA_SQL,
} from "./coordinator-auth-link-authority-upgrade.js";
import {
	COORDINATOR_D1_BASE_INVENTORY,
	COORDINATOR_D1_MIGRATION_NAMES,
} from "./coordinator-d1-schema-inventory.js";

/**
 * Coordinator auth schema stages that numbered D1 migrations move between, in order:
 * 0045 cuts the legacy authority tables over to V2, 0046 adds the prior account
 * extension, and 0047 adds device unlink, which makes the extension current.
 */
export const COORDINATOR_AUTH_STAGE_MIGRATIONS = Object.freeze({
	authorityCutover: "0045_cut_over_auth_link_authority.sql",
	accountConnections: "0046_add_account_connections.sql",
	accountUnlink: "0047_add_account_unlink.sql",
});
export type CoordinatorAuthSchemaStage =
	| "legacy"
	| "v2"
	| "prior_extension"
	| "current"
	| "unknown";

/** Migrations whose changes a database at each recognized stage already contains. */
export const COORDINATOR_AUTH_STAGE_APPLIED: Readonly<
	Record<Exclude<CoordinatorAuthSchemaStage, "unknown">, readonly string[]>
> = Object.freeze({
	legacy: [],
	v2: [COORDINATOR_AUTH_STAGE_MIGRATIONS.authorityCutover],
	prior_extension: [
		COORDINATOR_AUTH_STAGE_MIGRATIONS.authorityCutover,
		COORDINATOR_AUTH_STAGE_MIGRATIONS.accountConnections,
	],
	current: Object.values(COORDINATOR_AUTH_STAGE_MIGRATIONS),
});

/**
 * Read-only diagnosis of the auth schema stage. Every query reads sqlite_master or
 * checks rows; nothing is written. Anything partial, extra or unrecognized is `unknown`.
 */
export async function readCoordinatorAuthSchemaStage(
	backend: Pick<AuthLinkBackend, "first">,
): Promise<CoordinatorAuthSchemaStage> {
	const state = await readConnectionSchemaState(backend);
	if (state === "ready") return "current";
	if (state === "v2") return "v2";
	if (await hasPriorAccountSchema(backend)) return "prior_extension";
	const present = await backend.first<{ present: number }>({
		sql: CONNECTION_SCHEMA_PRESENCE_SQL,
		values: [],
	});
	if (present?.present) return "unknown";
	const legacy = await backend.first<{ recognized: number }>({
		sql: AUTH_LINK_LEGACY_AUTHORITY_SCHEMA_SQL,
		values: [],
	});
	return legacy?.recognized === 1 ? "legacy" : "unknown";
}

const STAGE_GUARD_SQL: Readonly<Record<"v2" | "prior_extension" | "current", string>> = {
	v2: `((${AUTH_V2_SCHEMA_READINESS_SQL})=10) AND NOT (${CONNECTION_SCHEMA_PRESENCE_SQL})`,
	prior_extension: `(${PRIOR_ACCOUNT_CONNECTION_SCHEMA_READINESS_SQL})=1`,
	current: `(${ACCOUNT_CONNECTION_SCHEMA_READINESS_SQL})=1`,
};
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** The last numbered migration a database at each baseline stage contains. */
const STAGE_LAST_MIGRATION: Readonly<Record<"v2" | "prior_extension" | "current", string>> = {
	v2: COORDINATOR_AUTH_STAGE_MIGRATIONS.authorityCutover,
	prior_extension: COORDINATOR_AUTH_STAGE_MIGRATIONS.accountConnections,
	current: COORDINATOR_AUTH_STAGE_MIGRATIONS.accountUnlink,
};

/** Every numbered migration, from 0001, that a database at `stage` already contains. */
export function coordinatorD1BaselineMigrations(
	stage: "v2" | "prior_extension" | "current",
): readonly string[] {
	const last = COORDINATOR_D1_MIGRATION_NAMES.indexOf(STAGE_LAST_MIGRATION[stage]);
	return COORDINATOR_D1_MIGRATION_NAMES.slice(0, last + 1);
}

// Check every V2 table for every stage, without relying on the narrower V2 readiness query.
// Group column names per table to avoid repeating long names near D1's statement-size limit.
const BASE_INVENTORY_SQL = `NOT EXISTS (SELECT 1 FROM (VALUES ${Object.entries(
	COORDINATOR_D1_BASE_INVENTORY,
)
	.map(([table, columns]) => `(${quote(table)},${quote(JSON.stringify(columns))})`)
	.join(
		",",
	)}) e, json_each(e.column2) c WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info(e.column1) p WHERE p.name = c.value))`;

/**
 * One explicit statement that records, in Wrangler's existing `d1_migrations` ledger, every
 * numbered migration from 0001 through `stage`. It re-checks auth-stage readiness and the
 * remaining table and column names in the same statement. Failed checks write nothing
 * (or fail to compile), and names already recorded are skipped. A missing ledger
 * fails with `no such table: d1_migrations`. Nothing runs it automatically.
 */
export function coordinatorAuthStageBaselineSql(
	stage: "v2" | "prior_extension" | "current",
	ledger = "d1_migrations",
): string {
	const names = coordinatorD1BaselineMigrations(stage);
	return `INSERT INTO ${ledger} (name) SELECT column1 FROM (VALUES ${names.map((n) => `(${quote(n)})`).join(",")}) WHERE (${STAGE_GUARD_SQL[stage]}) AND ${BASE_INVENTORY_SQL} AND column1 NOT IN (SELECT name FROM ${ledger})`;
}

const statementFile = (header: string[], statements: readonly string[]) =>
	`${header.map((line) => `-- ${line}`).join("\n")}\n${statements.map((sql) => `${sql.trim().replace(/;$/u, "")};`).join("\n")}\n`;

/**
 * Exact text of the numbered D1 migrations, generated from the same statements the
 * SQLite coordinator runs. Each one first checks its starting schema and aborts before
 * any change on anything else; Wrangler records it only when the whole file succeeds.
 */
export const COORDINATOR_AUTH_STAGE_MIGRATION_SQL: Readonly<Record<string, string>> = Object.freeze(
	{
		[COORDINATOR_AUTH_STAGE_MIGRATIONS.authorityCutover]: statementFile(
			[
				"Legacy controller-attested link authority -> V2 authority kinds and device-claim proof.",
				"Starts only from the exact legacy schema with no pending attempts; preserves rowids and rows.",
			],
			AUTH_LINK_AUTHORITY_CUTOVER_STATEMENTS,
		),
		[COORDINATOR_AUTH_STAGE_MIGRATIONS.accountConnections]: statementFile(
			[
				"V2 -> account connections: refresh, connection history and browser ordering.",
				"Starts only from intact V2 without account management; retains every link, proof and session.",
			],
			PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
		),
		[COORDINATOR_AUTH_STAGE_MIGRATIONS.accountUnlink]: statementFile(
			[
				"Account connections -> current account management: device unlink receipts and archive guard.",
				"Starts only from the exact 0046 schema; adds storage and guards without rebuilding tables.",
			],
			ACCOUNT_UNLINK_MIGRATION_STATEMENTS,
		),
	},
);
