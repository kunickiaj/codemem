/* Local-only preferences for coordinator groups.
 *
 * Membership in a coordinator group is coordinator-authoritative — the client
 * fetches it via `/api/coordinator/admin/groups`. What lives locally is per-
 * group UI + enrollment preferences: the default project-scope template
 * applied when a peer is enrolled through that group, default Space identity,
 * and toggles for whether to auto-seed project filters or default Space grants.
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
	default_space_scope_id: string | null;
	auto_grant_default_space_on_join: boolean;
	updated_at: string;
}

export interface UpsertCoordinatorGroupPreferenceInput {
	coordinator_id: string;
	group_id: string;
	projects_include?: string[] | null;
	projects_exclude?: string[] | null;
	auto_seed_scope?: boolean;
	default_space_scope_id?: string | null;
	auto_grant_default_space_on_join?: boolean;
}

export function defaultSpaceScopeIdForGroup(groupId: string): string {
	const normalized = groupId.trim();
	if (!normalized) throw new Error("group_id must be a non-empty string");
	return `team:${normalized}:default`;
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
	default_space_scope_id?: string | null;
	auto_grant_default_space_on_join?: number | null;
	updated_at: string;
}): CoordinatorGroupPreference {
	return {
		coordinator_id: row.coordinator_id,
		group_id: row.group_id,
		projects_include: parseList(row.projects_include_json),
		projects_exclude: parseList(row.projects_exclude_json),
		auto_seed_scope: Boolean(row.auto_seed_scope),
		default_space_scope_id: row.default_space_scope_id ?? null,
		auto_grant_default_space_on_join:
			row.auto_grant_default_space_on_join == null
				? false
				: Boolean(row.auto_grant_default_space_on_join),
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
	const nextDefaultSpaceScopeId =
		input.default_space_scope_id !== undefined
			? input.default_space_scope_id?.trim() || null
			: (existing?.default_space_scope_id ?? null);
	const nextAutoGrantDefaultSpace =
		input.auto_grant_default_space_on_join !== undefined
			? Boolean(input.auto_grant_default_space_on_join)
			: (existing?.auto_grant_default_space_on_join ?? false);

	db.prepare(
		`INSERT INTO coordinator_group_preferences
			(coordinator_id, group_id, projects_include_json, projects_exclude_json, auto_seed_scope,
			 default_space_scope_id, auto_grant_default_space_on_join, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(coordinator_id, group_id) DO UPDATE SET
			projects_include_json = excluded.projects_include_json,
			projects_exclude_json = excluded.projects_exclude_json,
			auto_seed_scope = excluded.auto_seed_scope,
			default_space_scope_id = excluded.default_space_scope_id,
			auto_grant_default_space_on_join = excluded.auto_grant_default_space_on_join,
			updated_at = excluded.updated_at`,
	).run(
		coordinatorId,
		groupId,
		serializeList(nextInclude ?? null),
		serializeList(nextExclude ?? null),
		nextAutoSeed ? 1 : 0,
		nextDefaultSpaceScopeId,
		nextAutoGrantDefaultSpace ? 1 : 0,
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
