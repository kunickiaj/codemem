import { buildBoundaryReadinessInventory } from "./boundary-readiness-inventory.js";
import { readBoundaryMigrationMode, readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { type Database, tableExists } from "./db.js";
import { columnExists } from "./schema-lookups.js";
import { effectiveSyncProjectFilters } from "./sync-replication.js";

/** These are observations on one store, never permission to migrate a Project. */
type LocalInventory = {
	candidate_projects: number;
	multiple_sources: number;
	own_source_rows: number;
};

type FilterEvidence = "none" | "present" | "unknown";

function listEvidence(raw: string | null): FilterEvidence {
	if (raw === null) return "none";
	try {
		const list: unknown = JSON.parse(raw);
		if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) return "unknown";
		return list.some((item) => item.trim()) ? "present" : "none";
	} catch {
		return "unknown";
	}
}

function storedFilters(db: Database, table: string, predicate: string): FilterEvidence {
	if (!tableExists(db, table)) return "none";
	const rows = db
		.prepare(`SELECT projects_include_json, projects_exclude_json
		FROM ${table} WHERE ${predicate}`)
		.all() as Record<string, string | null>[];
	let evidence: FilterEvidence = "none";
	for (const row of rows) {
		for (const raw of Object.values(row)) {
			const state = listEvidence(raw);
			if (state === "present") return state;
			if (state === "unknown") evidence = state;
		}
	}
	return evidence;
}

function localFilters(db: Database, config: Record<string, unknown>): FilterEvidence {
	const global = effectiveSyncProjectFilters(db, null, config);
	if (global.include.length || global.exclude.length) return "present";
	const evidence = [
		storedFilters(db, "sync_peers", "1"),
		storedFilters(db, "peer_project_filter_retention", "1"),
		storedFilters(db, "coordinator_group_preferences", "auto_seed_scope = 1"),
	];
	if (evidence.includes("present")) return "present";
	if (evidence.includes("unknown")) return "unknown";
	return "none";
}

function hasHistory(db: Database, table: string, predicate = "1"): boolean {
	return (
		tableExists(db, table) &&
		Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get())
	);
}

function groupsInStore(db: Database) {
	if (!tableExists(db, "replication_scopes")) return [];
	return db
		.prepare(`SELECT DISTINCT coordinator_id, group_id FROM replication_scopes
		WHERE authority_type = 'coordinator'`)
		.all() as {
		coordinator_id: string | null;
		group_id: string | null;
	}[];
}

function inventory(db: Database, groups: ReturnType<typeof groupsInStore>): LocalInventory | null {
	const device = db.prepare("SELECT device_id FROM sync_device LIMIT 1").pluck().get();
	if (typeof device !== "string" || !device.trim() || !groups.length) return null;
	const counts: LocalInventory = { candidate_projects: 0, multiple_sources: 0, own_source_rows: 0 };
	for (const group of groups) {
		if (!group.coordinator_id || !group.group_id) return null;
		const result = buildBoundaryReadinessInventory(db, {
			deviceId: device,
			coordinatorId: group.coordinator_id,
			groupId: group.group_id,
		});
		// Reporting the returned subset as the full inventory can hide split sources.
		if (result.omittedProjects) return null;
		const sources = new Map<string, number>();
		for (const entry of result.projects) {
			sources.set(entry.boundary_scope_id, (sources.get(entry.boundary_scope_id) ?? 0) + 1);
			counts.own_source_rows += entry.own_rows_in_source;
		}
		counts.candidate_projects += sources.size;
		counts.multiple_sources += [...sources.values()].filter((n) => n > 1).length;
	}
	return counts;
}

export function readLocalProjectMigrationReport(db: Database, config: Record<string, unknown>) {
	const mode = readBoundaryMigrationMode(config);
	if (mode === "off") return { mode, state: "off" } as const;
	const settings = readCoordinatorSyncConfig(config);
	return db
		.transaction(() => {
			const groups = groupsInStore(db);
			if (!settings.syncCoordinatorUrl) {
				const managed =
					settings.syncCoordinatorGroups.length > 0 ||
					groups.length > 0 ||
					hasHistory(db, "peer_project_filter_management") ||
					hasHistory(db, "scope_membership_cache_state") ||
					hasHistory(db, "coordinator_group_preferences") ||
					hasHistory(db, "project_boundary_migrations") ||
					hasHistory(db, "policy_team_coordinator_links") ||
					(columnExists(db, "sync_peers", "discovered_via_coordinator_id") &&
						hasHistory(db, "sync_peers", "discovered_via_coordinator_id IS NOT NULL"));
				if (!managed) return { mode, state: "not_applicable" } as const;
				return { mode, state: "waiting_for_coordinator" } as const;
			}
			let filters: FilterEvidence = "unknown";
			let projects: LocalInventory | null = null;
			try {
				filters = localFilters(db, config);
			} catch {
				// A historical table can predate the columns read by current code.
			}
			try {
				projects = inventory(db, groups);
			} catch {
				// An unidentified Project or an older schema is not an empty inventory.
			}
			return { mode, state: "local_report", local_filters: filters, projects } as const;
		})
		.deferred();
}
