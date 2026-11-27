import type { Database } from "./db.js";
import { effectiveSyncProjectFilters } from "./sync-replication.js";

export type BoundaryFilterEvidence = "none" | "present" | "unknown";

function listEvidence(raw: unknown): BoundaryFilterEvidence {
	if (raw == null) return "none";
	if (typeof raw !== "string") return "unknown";
	try {
		const list: unknown = JSON.parse(raw);
		if (!Array.isArray(list)) return "unknown";
		// Provisioning passes the stored strings to syncProjectAllowedByFilters
		// unchanged. Even an include list containing only whitespace restricts it.
		return list.length ? "present" : "none";
	} catch {
		return "unknown";
	}
}

function storedEvidence(db: Database, from: string): BoundaryFilterEvidence {
	try {
		const rows = db
			.prepare(`SELECT projects_include_json, projects_exclude_json FROM ${from}`)
			.iterate();
		let result: BoundaryFilterEvidence = "none";
		for (const row of rows as Iterable<Record<string, unknown>>) {
			for (const raw of Object.values(row)) {
				const evidence = listEvidence(raw);
				if (evidence === "present") return evidence;
				if (evidence === "unknown") result = evidence;
			}
		}
		return result;
	} catch {
		// An older store may not have the table or both columns. Its absence
		// cannot serve as evidence that the device inspected every setting.
		return "unknown";
	}
}

/** Pairings and retained overrides need not name a group. Count restrictions
 * device-wide until their irrelevance to a Project can be proved. */
export function readBoundaryFilterEvidence(
	db: Database,
	config: Record<string, unknown>,
): BoundaryFilterEvidence {
	const global = effectiveSyncProjectFilters(db, null, config);
	if (global.include.length || global.exclude.length) return "present";
	const sources = [
		storedEvidence(db, "sync_peers"),
		storedEvidence(db, "peer_project_filter_retention"),
		storedEvidence(db, "coordinator_group_preferences WHERE auto_seed_scope <> 0"),
	];
	if (sources.includes("present")) return "present";
	if (sources.includes("unknown")) return "unknown";
	for (const key of ["sync_projects_include", "sync_projects_exclude"]) {
		const value = process.env[`CODEMEM_${key.toUpperCase()}`] ?? config[key];
		if (value == null || typeof value === "string") continue;
		if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return "unknown";
	}
	return "none";
}
