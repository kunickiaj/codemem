import {
	ACCOUNT_CHANGE_SCHEMA_STATEMENTS,
	BROWSER_ACCOUNT_ARCHIVE_GUARD,
} from "./coordinator-account-change-schema.js";
import { ACCOUNT_CONNECTION_STORAGE_STATEMENTS } from "./coordinator-account-connection-storage.js";
import {
	ACCOUNT_UNLINK_SCHEMA_STATEMENTS,
	accountArchiveReceiptGuard,
} from "./coordinator-account-unlink-schema.js";
import {
	authDeviceClaimDefinitionChecks,
	authSchemaDefinitionCheck,
} from "./coordinator-auth-device-claim-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	AUTH_LINK_CREATE_WINDOW_MS,
	AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
	AUTH_LINK_MAX_ACTIVE_PER_IDENTITY,
	AUTH_LINK_MAX_CREATES_PER_DEVICE_RETENTION,
	AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
	AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
	AUTH_LINK_RETENTION_WINDOW_MS,
} from "./coordinator-auth-link-contract.js";

export const AUTH_SCHEMA_UPGRADE_REQUIRED = "coordinator_auth_schema_upgrade_required";
export const AUTH_SCHEMA_UPGRADE_MESSAGE =
	"Coordinator authentication needs a schema upgrade. Pause auth writers and back up the coordinator database. For the legacy authority upgrade, run codemem coordinator upgrade-auth-schema --db-path <coordinator.sqlite>. D1 operators must review and apply outstanding auth migrations before deploying the upgraded Worker. A coordinator already using device-claim auth needs only outstanding additive migrations, including 0033; do not replay its authority-table cutover. Optional account management on an intact V2 database requires codemem coordinator upgrade-account-schema --db-path <coordinator.sqlite>; normal V2 linking does not require this extension. Device-signed sync remains available.";
export class CoordinatorAuthSchemaUpgradeRequiredError extends Error {
	constructor() {
		super(AUTH_SCHEMA_UPGRADE_MESSAGE);
		this.name = AUTH_SCHEMA_UPGRADE_REQUIRED;
	}
}

/** Shared insertion budgets; this pure leaf has no runtime-store import cycle. */
export function connectionAdmissionSql(subject: "p" | "NEW"): string {
	const now = subject === "p" ? "p.now_ms" : "NEW.created_at_ms";
	const live = `b.state NOT IN ('completed','finalized','session_redeemed','failed','expired','cancelled') AND b.expires_at_ms > ${now}`;
	return `EXISTS (WITH connection_budget AS MATERIALIZED (
 SELECT group_id,device_id,identity_id,state,created_at_ms,expires_at_ms FROM coordinator_account_change_attempts WHERE coordinator_id = ${subject}.coordinator_id
 UNION ALL SELECT group_id,device_id,identity_id,state,created_at_ms,expires_at_ms FROM coordinator_auth_link_attempts WHERE coordinator_id = ${subject}.coordinator_id)
 SELECT 1 WHERE
 (SELECT count(*) FROM connection_budget b WHERE b.group_id = ${subject}.group_id AND b.device_id = ${subject}.device_id AND ${live}) < ${AUTH_LINK_MAX_ACTIVE_PER_DEVICE}
 AND (SELECT count(*) FROM connection_budget b WHERE b.identity_id = ${subject}.identity_id AND ${live}) < ${AUTH_LINK_MAX_ACTIVE_PER_IDENTITY}
 AND (SELECT count(*) FROM connection_budget b WHERE b.group_id = ${subject}.group_id AND b.device_id = ${subject}.device_id AND b.created_at_ms > ${now} - ${AUTH_LINK_CREATE_WINDOW_MS}) < ${AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW}
 AND (SELECT count(*) FROM connection_budget b WHERE b.group_id = ${subject}.group_id AND b.device_id = ${subject}.device_id AND b.created_at_ms > ${now} - ${AUTH_LINK_RETENTION_WINDOW_MS}) < ${AUTH_LINK_MAX_CREATES_PER_DEVICE_RETENTION}
 AND (SELECT count(*) FROM connection_budget b WHERE b.state NOT IN ('completed','finalized','session_redeemed')) < ${AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR})`;
}
export const CONNECTION_SESSION_SCHEMA_STATEMENTS = [
	"ALTER TABLE coordinator_auth_browser_transactions ADD COLUMN start_order INTEGER",
	"ALTER TABLE coordinator_auth_account_links ADD COLUMN signin_floor INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE coordinator_auth_session_receipts ADD COLUMN source_order INTEGER",
	"ALTER TABLE coordinator_auth_account_connection_history ADD COLUMN signin_floor INTEGER",
	`CREATE TRIGGER connection_history_floor_insert BEFORE INSERT ON coordinator_auth_account_connection_history
 WHEN NEW.signin_floor IS NOT (SELECT c.signin_floor FROM coordinator_auth_account_links c WHERE c.coordinator_id=NEW.coordinator_id AND c.link_id=NEW.link_id AND c.rowid=NEW.original_rowid)
 BEGIN SELECT RAISE(ABORT,'connection_archive_floor_invalid'); END`,
	`CREATE TRIGGER connection_history_floor_update BEFORE UPDATE ON coordinator_auth_account_connection_history WHEN NEW.signin_floor IS NOT OLD.signin_floor BEGIN SELECT RAISE(ABORT,'connection_history_immutable'); END`,
	`CREATE TRIGGER connection_link_shared_admission BEFORE INSERT ON coordinator_auth_link_attempts WHEN NOT ${connectionAdmissionSql("NEW")} BEGIN SELECT RAISE(ABORT,'connection_attempt_limited'); END`,
] as const;
export const CONNECTION_LINK_SCHEMA_STATEMENTS = [
	"ALTER TABLE coordinator_auth_link_attempts ADD COLUMN prior_link_id TEXT",
	`CREATE TRIGGER connection_link_prior_immutable BEFORE UPDATE ON coordinator_auth_link_attempts WHEN NEW.prior_link_id IS NOT OLD.prior_link_id AND (OLD.state <> 'pending' OR OLD.prior_link_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'connection_prior_immutable'); END`,
	`CREATE UNIQUE INDEX connection_history_head ON coordinator_auth_account_connection_history(coordinator_id,identity_id) WHERE successor_link_id IS NULL`,
] as const;
const extensions = [
	...ACCOUNT_CONNECTION_STORAGE_STATEMENTS,
	...ACCOUNT_CHANGE_SCHEMA_STATEMENTS,
	...CONNECTION_SESSION_SCHEMA_STATEMENTS,
	...CONNECTION_LINK_SCHEMA_STATEMENTS,
];
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const additions = extensions.flatMap((s) => {
	const m = /^ALTER TABLE (\w+) ADD COLUMN (\w+) (.+)$/u.exec(s);
	return m ? [{ table: m[1] as string, name: m[2] as string, declaration: m[3] as string }] : [];
});
const baseCounts: Record<string, number> = {
	coordinator_auth_link_attempts: 29,
	coordinator_auth_account_links: 12,
	coordinator_auth_link_audit_log: 13,
	coordinator_auth_browser_transactions: 16,
	coordinator_auth_sessions: 12,
	coordinator_auth_session_receipts: 9,
	coordinator_auth_link_profiles: 12,
	coordinator_auth_account_profiles: 8,
};
function columnCounts(extended: boolean): string {
	return Object.entries(baseCounts)
		.map(
			([table, n]) =>
				`(SELECT count(*) FROM pragma_table_info(${quote(table)})) = ${n + (extended ? additions.filter((a) => a.table === table).length : 0)}`,
		)
		.join(" AND ");
}
function v2Readiness(auxiliaryObjects: number): string {
	return `SELECT
 (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_attempts') WHERE lower(name) = 'authority_kind')
 + (SELECT count(*) FROM pragma_table_info('coordinator_auth_account_links') WHERE lower(name) IN ('authority_kind','device_claim_id'))
 + (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_audit_log') WHERE lower(name) IN ('authority_kind','device_claim_id'))
 + (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_auth_link_profiles')
 + ${authDeviceClaimDefinitionChecks(auxiliaryObjects)
		.map(({ matches }) => `(${matches})`)
		.join(" + ")} AS ready`;
}
/** The old 10-count contract stays unchanged; its exact 3-auxiliary fence remains. */
export const AUTH_V2_SCHEMA_READINESS_SQL = v2Readiness(3);
const creates = extensions.filter((s) => s.startsWith("CREATE"));
const definitions = creates.map((s) => {
	const table = /^CREATE TABLE (\w+)/u.exec(s)?.[1];
	if (!table) return authSchemaDefinitionCheck(s);
	const final =
		table === "coordinator_auth_account_connection_history"
			? s.replace(
					" PRIMARY KEY(coordinator_id",
					" signin_floor INTEGER,\n PRIMARY KEY(coordinator_id",
				)
			: s;
	const auxiliaryObjects = creates.filter((ddl) => /\bON (\w+)/u.exec(ddl)?.[1] === table).length;
	return authSchemaDefinitionCheck(final, { auxiliaryObjects });
});
const reservedObjects = `(name GLOB 'account_connection_*' OR name GLOB 'account_change_*' OR name GLOB 'connection_*' OR name GLOB 'coordinator_auth_account_connection_*' OR name = 'coordinator_account_change_attempts' OR name = 'coordinator_auth_account_associations' OR name = 'coordinator_auth_link_change_attempts')`;
export const CONNECTION_SCHEMA_PRESENCE_SQL = `SELECT (EXISTS (SELECT 1 FROM sqlite_master WHERE ${reservedObjects}) OR ${additions.map((a) => `EXISTS (SELECT 1 FROM pragma_table_info(${quote(a.table)}) WHERE lower(name)=${quote(a.name)})`).join(" OR ")}) AS present`;
const inventory = additions.map(
	(a) =>
		`EXISTS (SELECT 1 FROM pragma_table_info(${quote(a.table)}) WHERE lower(name)=${quote(a.name)} AND upper(type)=${quote(a.declaration.split(" ")[0] as string)} AND "notnull"=${a.declaration.includes("NOT NULL") ? 1 : 0} AND dflt_value IS ${a.declaration.includes("DEFAULT 0") ? "'0'" : "NULL"} AND pk=0)`,
);
const knownCoordinators = `SELECT coordinator_id FROM coordinator_auth_account_links UNION SELECT coordinator_id FROM coordinator_auth_browser_transactions UNION SELECT coordinator_id FROM coordinator_auth_link_attempts UNION SELECT coordinator_id FROM coordinator_auth_sessions`;
const rowsValid = `NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links WHERE typeof(signin_floor)<>'integer' OR signin_floor<0 OR signin_floor>9007199254740991)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions WHERE start_order IS NOT NULL AND (typeof(start_order)<>'integer' OR start_order<1 OR start_order>9007199254740991))
 AND NOT EXISTS (SELECT 1 FROM (SELECT coordinator_id FROM coordinator_auth_account_links UNION SELECT coordinator_id FROM coordinator_auth_browser_transactions UNION SELECT coordinator_id FROM coordinator_auth_sessions) c LEFT JOIN coordinator_auth_account_connection_orders o ON o.coordinator_id=c.coordinator_id WHERE o.last_order IS NULL OR o.last_order<1)`;
const priorObjectCheck = `NOT EXISTS (SELECT 1 FROM sqlite_master WHERE ${reservedObjects} AND name NOT IN (${definitions.map((d) => quote(d.name)).join(",")}))`;
const checks = [
	...definitions.map((d) => d.matches),
	...inventory,
	columnCounts(true),
	`(${v2Readiness(4)})=10`,
	priorObjectCheck,
	rowsValid,
];
// VALUES avoids D1's compound-SELECT term limit without omitting any check.
const readiness = (checks: string[]) =>
	`SELECT min(column1) AS ready FROM (VALUES ${checks.map((s) => `(CASE WHEN ${s} THEN 1 ELSE 0 END)`).join(",")})`;
const legacyReadySql = readiness(checks);
const unlinkGuard = accountArchiveReceiptGuard(BROWSER_ACCOUNT_ARCHIVE_GUARD);
const newDefinitions = [...ACCOUNT_UNLINK_SCHEMA_STATEMENTS, unlinkGuard].map((s) =>
	authSchemaDefinitionCheck(s, s.startsWith("CREATE TABLE") ? { auxiliaryObjects: 4 } : undefined),
);
const oldGuardCheck = authSchemaDefinitionCheck(BROWSER_ACCOUNT_ARCHIVE_GUARD).matches;
const currentChecks = checks.filter((s) => s !== oldGuardCheck && s !== priorObjectCheck);
currentChecks.push(
	...newDefinitions.map((d) => d.matches),
	`NOT EXISTS (SELECT 1 FROM sqlite_master WHERE ${reservedObjects} AND name NOT IN (${[...definitions, ...newDefinitions].map((d) => quote(d.name)).join(",")}))`,
);
const readySql = readiness(currentChecks);
export const ACCOUNT_CONNECTION_SCHEMA_CHECKS = currentChecks;
export type ConnectionSchemaState = "v2" | "ready" | "upgrade_required";
export async function readConnectionSchemaState(
	backend: Pick<AuthLinkBackend, "first">,
): Promise<ConnectionSchemaState> {
	const p = await backend.first<{ present: number; v2: number }>({
		sql: `SELECT (${CONNECTION_SCHEMA_PRESENCE_SQL}) AS present, ((${AUTH_V2_SCHEMA_READINESS_SQL})=10) AS v2`,
		values: [],
	});
	if (!p?.present) return p?.v2 === 1 ? "v2" : "upgrade_required";
	try {
		return (await backend.first<{ ready: number }>({ sql: readySql, values: [] }))?.ready === 1
			? "ready"
			: "upgrade_required";
	} catch (error) {
		if (
			!/no such (?:table|column)|has no column named|malformed (?:database )?schema/i.test(
				String(error),
			)
		)
			throw error;
		return "upgrade_required";
	} // Missing tables/columns are an incomplete extension, not V2.
}

/** Explicit operator operation only: never called by store initialization. One
 * atomic batch preserves existing rowids, credentials and proof bytes. */
export const PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS = [
	`INSERT INTO coordinator_auth_device_claims (claim_id) SELECT NULL WHERE NOT (((${AUTH_V2_SCHEMA_READINESS_SQL})=10) AND NOT (${CONNECTION_SCHEMA_PRESENCE_SQL}) AND (${columnCounts(false)}))`,
	...extensions,
	`INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT coordinator_id,0 FROM (${knownCoordinators})`,
	"UPDATE coordinator_auth_account_connection_orders SET last_order=last_order+1",
	"UPDATE coordinator_auth_link_profiles SET source_order=0",
	"UPDATE coordinator_auth_account_profiles SET source_order=1",
	`UPDATE coordinator_auth_session_receipts AS r SET source_order=1
 WHERE r.source='signin' AND r.attempt_id IS NULL AND EXISTS (
 SELECT 1 FROM coordinator_auth_account_profiles p WHERE p.coordinator_id=r.coordinator_id
 AND p.link_id=r.link_id AND p.source_session_id=r.session_id
 AND p.source_signed_in_at_ms=r.created_at_ms AND p.source_order=1)`,
	`INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT NULL,0 WHERE NOT (${legacyReadySql})`,
] as const;
export const ACCOUNT_CONNECTION_MIGRATION_STATEMENTS = [
	...PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.slice(0, -1),
	...ACCOUNT_UNLINK_SCHEMA_STATEMENTS,
	"DROP TRIGGER account_change_archive_receipt",
	unlinkGuard,
	`INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT NULL,0 WHERE NOT (${readySql})`,
] as const;
/** Only the exact prior account extension can take this atomic, no-rebuild delta. */
export const ACCOUNT_UNLINK_MIGRATION_STATEMENTS = [
	`INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT NULL,0 WHERE NOT (${legacyReadySql})`,
	...ACCOUNT_UNLINK_SCHEMA_STATEMENTS,
	"DROP TRIGGER account_change_archive_receipt",
	unlinkGuard,
	`INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT NULL,0 WHERE NOT (${readySql})`,
] as const;
export async function applyAccountConnectionSchema(backend: AuthLinkBackend): Promise<void> {
	const state = await readConnectionSchemaState(backend);
	if (state === "ready") throw new Error("account_connection_schema_already_installed");
	const legacy = state === "upgrade_required" && (await hasPriorAccountSchema(backend));
	if (state !== "v2" && !legacy) throw new CoordinatorAuthSchemaUpgradeRequiredError();
	await backend.batch(
		(legacy ? ACCOUNT_UNLINK_MIGRATION_STATEMENTS : ACCOUNT_CONNECTION_MIGRATION_STATEMENTS).map(
			(sql): AuthLinkStatement => ({ sql, values: [] }),
		),
	);
	if ((await readConnectionSchemaState(backend)) !== "ready")
		throw new CoordinatorAuthSchemaUpgradeRequiredError();
}
async function hasPriorAccountSchema(backend: AuthLinkBackend): Promise<boolean> {
	try {
		return (
			(await backend.first<{ ready: number }>({ sql: legacyReadySql, values: [] }))?.ready === 1
		);
	} catch {
		return false;
	}
}
