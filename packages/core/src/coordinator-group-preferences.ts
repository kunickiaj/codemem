/* Local-only preferences for coordinator groups.
 *
 * Membership in a coordinator group is coordinator-authoritative — the client
 * fetches it via `/api/coordinator/admin/groups`. What lives locally is per-
 * group UI + enrollment preferences: the default project-scope template
 * applied when a peer is enrolled through that group, and a toggle for
 * whether to auto-seed scope from the template at all.
 *
 * Design: docs/plans/2026-04-22-multi-team-coordinator-groups-design.md.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import * as schema from "./schema.js";

export interface CoordinatorGroupPreference {
	coordinator_id: string;
	group_id: string;
	projects_include: string[] | null;
	projects_exclude: string[] | null;
	auto_seed_scope: boolean;
	updated_at: string;
}

export interface UpsertCoordinatorGroupPreferenceInput {
	coordinator_id: string;
	group_id: string;
	projects_include?: string[] | null;
	projects_exclude?: string[] | null;
	auto_seed_scope?: boolean;
}

function parseList(value: string | null): string[] | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : null;
	} catch {
		return null;
	}
}

function serializeList(list: string[] | null | undefined): string | null {
	if (!list || list.length === 0) return null;
	return JSON.stringify(list.map(String).filter(Boolean));
}

function rowToPreference(row: {
	coordinator_id: string;
	group_id: string;
	projects_include_json: string | null;
	projects_exclude_json: string | null;
	auto_seed_scope: number;
	updated_at: string;
}): CoordinatorGroupPreference {
	return {
		coordinator_id: row.coordinator_id,
		group_id: row.group_id,
		projects_include: parseList(row.projects_include_json),
		projects_exclude: parseList(row.projects_exclude_json),
		auto_seed_scope: Boolean(row.auto_seed_scope),
		updated_at: row.updated_at,
	};
}

export function getCoordinatorGroupPreference(
	db: Database,
	coordinatorId: string,
	groupId: string,
): CoordinatorGroupPreference | null {
	const d = drizzle(db, { schema });
	const row = d
		.select()
		.from(schema.coordinatorGroupPreferences)
		.where(
			and(
				eq(schema.coordinatorGroupPreferences.coordinator_id, coordinatorId),
				eq(schema.coordinatorGroupPreferences.group_id, groupId),
			),
		)
		.get();
	return row ? rowToPreference(row) : null;
}

export function listCoordinatorGroupPreferences(
	db: Database,
	coordinatorId: string,
): CoordinatorGroupPreference[] {
	const d = drizzle(db, { schema });
	const rows = d
		.select()
		.from(schema.coordinatorGroupPreferences)
		.where(eq(schema.coordinatorGroupPreferences.coordinator_id, coordinatorId))
		.all();
	return rows.map(rowToPreference);
}

export function upsertCoordinatorGroupPreference(
	db: Database,
	input: UpsertCoordinatorGroupPreferenceInput,
): CoordinatorGroupPreference {
	const coordinatorId = input.coordinator_id.trim();
	const groupId = input.group_id.trim();
	if (!coordinatorId) throw new Error("coordinator_id must be a non-empty string");
	if (!groupId) throw new Error("group_id must be a non-empty string");

	const now = new Date().toISOString();
	const existing = getCoordinatorGroupPreference(db, coordinatorId, groupId);

	const nextInclude =
		input.projects_include !== undefined ? input.projects_include : existing?.projects_include;
	const nextExclude =
		input.projects_exclude !== undefined ? input.projects_exclude : existing?.projects_exclude;
	const nextAutoSeed =
		input.auto_seed_scope !== undefined
			? Boolean(input.auto_seed_scope)
			: (existing?.auto_seed_scope ?? true);

	db.prepare(
		`INSERT INTO coordinator_group_preferences
			(coordinator_id, group_id, projects_include_json, projects_exclude_json, auto_seed_scope, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(coordinator_id, group_id) DO UPDATE SET
			projects_include_json = excluded.projects_include_json,
			projects_exclude_json = excluded.projects_exclude_json,
			auto_seed_scope = excluded.auto_seed_scope,
			updated_at = excluded.updated_at`,
	).run(
		coordinatorId,
		groupId,
		serializeList(nextInclude ?? null),
		serializeList(nextExclude ?? null),
		nextAutoSeed ? 1 : 0,
		now,
	);

	const saved = getCoordinatorGroupPreference(db, coordinatorId, groupId);
	if (!saved) throw new Error("coordinator_group_preference upsert returned no row");
	return saved;
}

export function deleteCoordinatorGroupPreference(
	db: Database,
	coordinatorId: string,
	groupId: string,
): boolean {
	const result = db
		.prepare("DELETE FROM coordinator_group_preferences WHERE coordinator_id = ? AND group_id = ?")
		.run(coordinatorId, groupId);
	return result.changes > 0;
}
