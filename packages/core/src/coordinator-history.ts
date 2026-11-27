import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

/*
 * Coordinator history: whether this store, or a device it knows, has ever been
 * part of a coordinator. Sync without a coordinator is allowed only for a
 * store and peer with no such history, so the record must survive the
 * coordinator settings being cleared and the evidence rows being deleted.
 * Entry points record history before coordinator trust takes effect, and the
 * triggers below record it in the same transaction as each coordinator write.
 * Nothing here deletes a history row.
 */

export type CoordinatorHistorySource =
	| "backfill"
	| "bootstrap_grant"
	| "config"
	| "coordinator_peer_list"
	| "enrollment"
	| "filter_management"
	| "invitation"
	| "membership_cache"
	| "peer_trust"
	| "presence"
	| "scope"
	| "scope_membership";

/*
 * Rows are added with NOT EXISTS rather than OR IGNORE: inside a trigger, the outer
 * statement's conflict policy replaces OR IGNORE, so an upsert would abort on a duplicate.
 */
const historyRow = (
	kind: string,
	source: CoordinatorHistorySource,
	deviceId: string,
	fingerprint: string,
) =>
	`INSERT INTO coordinator_history(subject_kind, device_id, fingerprint, source, recorded_at)
	 SELECT '${kind}', ${deviceId}, ${fingerprint}, '${source}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	 WHERE NOT EXISTS (SELECT 1 FROM coordinator_history
	   WHERE subject_kind = '${kind}' AND device_id = ${deviceId} AND fingerprint = ${fingerprint});`;

const STORE_ROW = (source: CoordinatorHistorySource) => historyRow("store", source, "''", "''");

const DEVICE_ROW = (source: CoordinatorHistorySource, deviceId: string, fingerprint: string) =>
	historyRow("device", source, deviceId, fingerprint);

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS store_identity (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	store_id TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordinator_history (
	subject_kind TEXT NOT NULL CHECK (subject_kind IN ('store', 'device')),
	device_id TEXT NOT NULL DEFAULT '',
	fingerprint TEXT NOT NULL DEFAULT '',
	source TEXT NOT NULL,
	recorded_at TEXT NOT NULL,
	PRIMARY KEY (subject_kind, device_id, fingerprint)
);
`;

const PEER_COORDINATOR_FIELDS = `(NEW.discovered_via_coordinator_id IS NOT NULL
	OR NEW.discovered_via_group_id IS NOT NULL
	OR NEW.pending_bootstrap_grant_id IS NOT NULL
	OR NEW.trust_provenance = 'coordinator_policy')`;

interface HistoryTrigger {
	name: string;
	table: string;
	sql: string;
}

function trigger(name: string, table: string, event: string, when: string, body: string) {
	return {
		name,
		table,
		sql: `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table} WHEN ${when}
BEGIN ${body} END;`,
	};
}

/** Every coordinator write records history in its own transaction, whichever code path makes it. */
const HISTORY_TRIGGERS: HistoryTrigger[] = [
	...["INSERT", "UPDATE OF authority_type, coordinator_id"].map((event, index) =>
		trigger(
			`coordinator_history_scope_${index ? "update" : "insert"}`,
			"replication_scopes",
			event,
			"NEW.authority_type <> 'local' OR NEW.coordinator_id IS NOT NULL",
			STORE_ROW("scope"),
		),
	),
	...["INSERT", "UPDATE OF coordinator_id, group_id"].map((event, index) =>
		trigger(
			`coordinator_history_membership_${index ? "update" : "insert"}`,
			"scope_memberships",
			event,
			"NEW.coordinator_id IS NOT NULL OR NEW.group_id IS NOT NULL",
			STORE_ROW("scope_membership") + DEVICE_ROW("scope_membership", "NEW.device_id", "''"),
		),
	),
	trigger(
		"coordinator_history_membership_cache_insert",
		"scope_membership_cache_state",
		"INSERT",
		"1",
		STORE_ROW("membership_cache"),
	),
	...[
		"INSERT",
		"UPDATE OF discovered_via_coordinator_id, discovered_via_group_id, pending_bootstrap_grant_id, trust_provenance",
	].map((event, index) =>
		trigger(
			`coordinator_history_peer_${index ? "update" : "insert"}`,
			"sync_peers",
			event,
			PEER_COORDINATOR_FIELDS,
			STORE_ROW("peer_trust") +
				DEVICE_ROW("peer_trust", "NEW.peer_device_id", "COALESCE(NEW.pinned_fingerprint, '')"),
		),
	),
	trigger(
		"coordinator_history_project_projection_insert",
		"recipient_managed_project_projections",
		"INSERT",
		"1",
		STORE_ROW("invitation"),
	),
	trigger(
		"coordinator_history_filter_management_insert",
		"peer_project_filter_management",
		"INSERT",
		"1",
		STORE_ROW("filter_management"),
	),
];

/** Evidence written before history existed, by table, as (kind, device_id, fingerprint) rows. */
const STORE_EVIDENCE = "SELECT 'store' AS kind, '' AS device_id, '' AS fingerprint";
const BACKFILL: Array<{ table: string; sql: string }> = [
	{
		table: "replication_scopes",
		sql: `${STORE_EVIDENCE} FROM replication_scopes
		 WHERE authority_type <> 'local' OR coordinator_id IS NOT NULL LIMIT 1`,
	},
	{
		table: "scope_membership_cache_state",
		sql: `${STORE_EVIDENCE} FROM scope_membership_cache_state LIMIT 1`,
	},
	{
		table: "peer_project_filter_management",
		sql: `${STORE_EVIDENCE} FROM peer_project_filter_management LIMIT 1`,
	},
	{
		table: "recipient_managed_project_projections",
		sql: `${STORE_EVIDENCE} FROM recipient_managed_project_projections LIMIT 1`,
	},
	{
		table: "scope_memberships",
		sql: `SELECT DISTINCT 'device' AS kind, device_id, '' AS fingerprint FROM scope_memberships
		 WHERE coordinator_id IS NOT NULL OR group_id IS NOT NULL`,
	},
	{
		table: "sync_peers",
		sql: `SELECT 'device' AS kind, peer_device_id AS device_id,
		 COALESCE(pinned_fingerprint, '') AS fingerprint FROM sync_peers
		 WHERE ${PEER_COORDINATOR_FIELDS.replaceAll("NEW.", "")}`,
	},
];

/** The columns each watched table needs. Older schemas without them hold no such evidence. */
const REQUIRED_COLUMNS: Record<string, string[]> = {
	replication_scopes: ["authority_type", "coordinator_id"],
	scope_memberships: ["device_id", "coordinator_id", "group_id"],
	sync_peers: [
		"peer_device_id",
		"pinned_fingerprint",
		"discovered_via_coordinator_id",
		"discovered_via_group_id",
		"pending_bootstrap_grant_id",
		"trust_provenance",
	],
};

/** The named tables that exist with the columns history reads. Not cached: tables change. */
function existingTables(db: Database, names: string[]): Set<string> {
	const rows = db
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => "?").join(", ")})`,
		)
		.pluck()
		.all(...names) as string[];
	const columns = db.prepare("SELECT name FROM pragma_table_info(?)").pluck();
	return new Set(
		rows.filter((table) => {
			const required = REQUIRED_COLUMNS[table] ?? [];
			if (required.length === 0) return true;
			const present = new Set(columns.all(table) as string[]);
			return required.every((column) => present.has(column));
		}),
	);
}

function missingTriggers(db: Database, tables: Set<string>): HistoryTrigger[] {
	const present = new Set(
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'coordinator_history_%'",
			)
			.pluck()
			.all() as string[],
	);
	return HISTORY_TRIGGERS.filter((item) => tables.has(item.table) && !present.has(item.name));
}

function backfill(db: Database, tables: Set<string>): void {
	for (const evidence of BACKFILL) {
		if (!tables.has(evidence.table)) continue;
		db.prepare(
			`INSERT OR IGNORE INTO coordinator_history(subject_kind, device_id, fingerprint, source, recorded_at)
			 SELECT kind, device_id, fingerprint, 'backfill', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 FROM (${evidence.sql})`,
		).run();
	}
	// A known coordinator device means this store took part in a coordinator.
	db.prepare(
		`INSERT OR IGNORE INTO coordinator_history(subject_kind, device_id, fingerprint, source, recorded_at)
		 SELECT 'store', '', '', 'backfill', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		 WHERE EXISTS (SELECT 1 FROM coordinator_history WHERE subject_kind = 'device')`,
	).run();
}

/**
 * Normal initialization, and again after a table a trigger needs is created. Creating the
 * history tables also records the evidence that older runtimes left behind.
 */
export function ensureCoordinatorHistorySchema(db: Database): void {
	const watched = [...new Set(HISTORY_TRIGGERS.map((item) => item.table))];
	const tables = existingTables(db, ["store_identity", "coordinator_history", ...watched]);
	const created = !tables.has("coordinator_history") || !tables.has("store_identity");
	const triggers = missingTriggers(db, tables);
	if (!created && triggers.length === 0) return;
	db.transaction(() => {
		db.exec(TABLES_SQL);
		db.prepare(
			"INSERT OR IGNORE INTO store_identity(id, store_id, created_at) VALUES (1, ?, ?)",
		).run(randomUUID(), new Date().toISOString());
		for (const item of triggers) db.exec(item.sql);
		// Triggers added later still cover evidence written while they were missing.
		backfill(db, tables);
	})();
}

/** This store's identity. A copy or a restored backup of the database keeps it. */
export function readStoreId(db: Database): string {
	ensureCoordinatorHistorySchema(db);
	const storeId = db.prepare("SELECT store_id FROM store_identity WHERE id = 1").pluck().get();
	if (typeof storeId !== "string" || !storeId) throw new Error("store_id_unavailable");
	return storeId;
}

export function recordStoreCoordinatorHistory(
	db: Database,
	source: CoordinatorHistorySource,
): void {
	ensureCoordinatorHistorySchema(db);
	db.exec(STORE_ROW(source));
}

/** A device the coordinator vouched for, and therefore this store too. */
export function recordDeviceCoordinatorHistory(
	db: Database,
	input: { deviceId: string; fingerprint?: string | null; source: CoordinatorHistorySource },
): void {
	const deviceId = input.deviceId.trim();
	if (!deviceId) return;
	ensureCoordinatorHistorySchema(db);
	db.transaction(() => {
		db.exec(STORE_ROW(input.source));
		db.prepare(
			`INSERT OR IGNORE INTO coordinator_history(subject_kind, device_id, fingerprint, source, recorded_at)
			 VALUES ('device', ?, ?, ?, ?)`,
		).run(deviceId, input.fingerprint?.trim() ?? "", input.source, new Date().toISOString());
	})();
}

/** Every device in a coordinator peer listing, whether or not this store pins it. */
export function recordListedCoordinatorPeers(db: Database, peers: Record<string, unknown>[]): void {
	db.transaction(() => {
		recordStoreCoordinatorHistory(db, "coordinator_peer_list");
		for (const peer of peers) {
			const deviceId = typeof peer.device_id === "string" ? peer.device_id : "";
			const fingerprint = typeof peer.fingerprint === "string" ? peer.fingerprint : "";
			recordDeviceCoordinatorHistory(db, {
				deviceId,
				fingerprint,
				source: "coordinator_peer_list",
			});
		}
	})();
}

export interface ConfiguredCoordinator {
	syncCoordinatorUrl: string;
	syncCoordinatorGroup: string;
	syncCoordinatorGroups: string[];
}

const configText = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Any coordinator URL or group, from the config file or the environment. */
export function recordConfiguredCoordinatorHistory(
	db: Database,
	config: Partial<ConfiguredCoordinator> | null | undefined,
): boolean {
	const groups = Array.isArray(config?.syncCoordinatorGroups) ? config.syncCoordinatorGroups : [];
	const configured =
		configText(config?.syncCoordinatorUrl) !== "" ||
		configText(config?.syncCoordinatorGroup) !== "" ||
		groups.some((group) => configText(group) !== "");
	if (configured) recordStoreCoordinatorHistory(db, "config");
	return configured;
}

/**
 * Read-only. The live evidence is checked as well as the record, in case a trigger was
 * missing when it was written. Without the history table, history can't be ruled out.
 */
export function storeHasCoordinatorHistory(db: Database): boolean {
	const tables = existingTables(db, ["coordinator_history", ...BACKFILL.map((item) => item.table)]);
	if (!tables.has("coordinator_history")) return true;
	if (db.prepare("SELECT 1 FROM coordinator_history LIMIT 1").get()) return true;
	return BACKFILL.some(
		(evidence) => tables.has(evidence.table) && db.prepare(evidence.sql).get() !== undefined,
	);
}

/** Read-only, like storeHasCoordinatorHistory. */
export function deviceHasCoordinatorHistory(db: Database, deviceId: string): boolean {
	const tables = existingTables(db, ["coordinator_history", ...BACKFILL.map((item) => item.table)]);
	if (!tables.has("coordinator_history")) return true;
	const recorded = db
		.prepare("SELECT 1 FROM coordinator_history WHERE subject_kind = 'device' AND device_id = ?")
		.get(deviceId);
	if (recorded) return true;
	return BACKFILL.some(
		(evidence) =>
			tables.has(evidence.table) &&
			db
				.prepare(`SELECT 1 FROM (${evidence.sql}) WHERE kind = 'device' AND device_id = ? LIMIT 1`)
				.get(deviceId) !== undefined,
	);
}
