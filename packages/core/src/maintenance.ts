import { statSync } from "node:fs";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
	assertSchemaReady,
	connect,
	type Database,
	getSchemaVersion,
	resolveDbPath,
} from "./db.js";
import { withDb } from "./maintenance/with-db.js";
import { ensureMaintenanceJobsSchema } from "./maintenance-jobs.js";
import * as schema from "./schema.js";
import { bootstrapSchema } from "./schema-bootstrap.js";

export { getRawEventStatus, retryRawEventFailures } from "./maintenance/status.js";

export type {
	MemoryRole,
	MemoryRoleProbeComparison,
	MemoryRoleProbeItem,
	MemoryRoleProbeResult,
	MemoryRoleReport,
	MemoryRoleReportComparison,
	MemoryRoleReportComparisonOptions,
	MemoryRoleReportOptions,
	RawEventRelinkAction,
	RawEventRelinkApplyOptions,
	RawEventRelinkApplyResult,
	RawEventRelinkGroup,
	RawEventRelinkPlan,
	RawEventRelinkPlanOptions,
	RawEventRelinkReport,
	RawEventRelinkReportOptions,
	RawEventStatusItem,
	RawEventStatusResult,
} from "./maintenance/types.js";

import type {
	RawEventRelinkAction,
	RawEventRelinkApplyOptions,
	RawEventRelinkApplyResult,
	RawEventRelinkGroup,
	RawEventRelinkPlan,
	RawEventRelinkPlanOptions,
	RawEventRelinkReport,
	RawEventRelinkReportOptions,
} from "./maintenance/types.js";

function hasOutOfGroupBridgeRows(
	db: Database,
	sessionIds: number[],
	source: string,
	stableId: string,
): boolean {
	if (sessionIds.length === 0) return false;
	const placeholders = sessionIds.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT 1
			 FROM opencode_sessions
			 WHERE session_id IN (${placeholders})
			   AND NOT (source = ? AND stream_id = ?)
			 LIMIT 1`,
		)
		.get(...sessionIds, source, stableId);
	return row != null;
}

function getRawEventRelinkReportFromDb(
	db: Database,
	opts: RawEventRelinkReportOptions = {},
): RawEventRelinkReport {
	const projectFilter = opts.allProjects ? null : opts.project?.trim() || null;
	const projectClauseSql = projectFilter ? "AND s.project = ?" : "";
	const params = projectFilter ? [projectFilter] : [];
	const limit = Math.max(1, opts.limit ?? 25);

	const rows = db
		.prepare(
			`SELECT
				s.id,
				COALESCE(
					json_extract(s.metadata_json, '$.session_context.source'),
					json_extract(s.metadata_json, '$.source'),
					'opencode'
				) AS source,
				s.project,
				s.started_at,
				s.ended_at,
				COALESCE(
					json_extract(s.metadata_json, '$.session_context.opencodeSessionId'),
					json_extract(s.metadata_json, '$.session_context.streamId')
				) AS stable_id,
				CASE WHEN os.session_id IS NULL THEN 0 ELSE 1 END AS has_mapping,
				(
					SELECT COUNT(*)
					FROM memory_items m
					WHERE m.session_id = s.id AND m.active = 1
				) AS active_memories
			FROM sessions s
			LEFT JOIN opencode_sessions os
				ON os.session_id = s.id
				AND os.source = COALESCE(
					json_extract(s.metadata_json, '$.session_context.source'),
					json_extract(s.metadata_json, '$.source'),
					'opencode'
				)
				AND os.stream_id = COALESCE(
					json_extract(s.metadata_json, '$.session_context.opencodeSessionId'),
					json_extract(s.metadata_json, '$.session_context.streamId')
				)
			WHERE json_extract(s.metadata_json, '$.session_context.flusher') = 'raw_events'
			  AND COALESCE(
					json_extract(s.metadata_json, '$.session_context.opencodeSessionId'),
					json_extract(s.metadata_json, '$.session_context.streamId')
				  ) IS NOT NULL
			  ${projectClauseSql}
			ORDER BY s.started_at DESC, s.id DESC`,
		)
		.all(...params) as Array<{
		id: number;
		source: string;
		project: string | null;
		started_at: string | null;
		ended_at: string | null;
		stable_id: string;
		has_mapping: number;
		active_memories: number;
	}>;

	const groups = new Map<string, typeof rows>();
	for (const row of rows) {
		const stableId = String(row.stable_id || "").trim();
		const source = String(row.source || "opencode").trim() || "opencode";
		const key = `${source}:${stableId}`;
		if (!key) continue;
		const list = groups.get(key) ?? [];
		list.push(row);
		groups.set(key, list);
	}

	const reportGroups: RawEventRelinkGroup[] = [];
	let activeMemories = 0;
	let repointableActiveMemories = 0;
	let groupsWithMappedSession = 0;
	let groupsWithoutMappedSession = 0;
	let eligibleGroups = 0;
	let ineligibleGroups = 0;

	for (const [groupKey, groupRows] of groups.entries()) {
		const stableId = groupRows[0]?.stable_id ?? groupKey;
		const groupSource = groupRows[0]?.source ?? "opencode";
		const sorted = [...groupRows].sort((a, b) => {
			if (b.has_mapping !== a.has_mapping) return b.has_mapping - a.has_mapping;
			const aStarted = a.started_at ?? "";
			const bStarted = b.started_at ?? "";
			if (aStarted !== bStarted) return aStarted.localeCompare(bStarted);
			return a.id - b.id;
		});
		const canonical = sorted[0];
		if (!canonical) continue;
		const mappedSessions = groupRows.filter((row) => row.has_mapping === 1).length;
		const unmappedSessions = groupRows.length - mappedSessions;
		const totalActiveMemories = groupRows.reduce(
			(sum, row) => sum + Number(row.active_memories ?? 0),
			0,
		);
		const canonicalActiveMemories = Number(canonical.active_memories ?? 0);
		const repointable = Math.max(0, totalActiveMemories - canonicalActiveMemories);
		const canonicalReason =
			canonical.has_mapping === 1 ? "existing_mapped_session" : "oldest_unmapped_session";
		const projectValues = new Set(groupRows.map((row) => row.project ?? null));
		const blockers: string[] = [];
		if (mappedSessions > 1) blockers.push("multiple_mapped_sessions");
		if (projectValues.size > 1) blockers.push("mixed_projects");
		if (
			hasOutOfGroupBridgeRows(
				db,
				groupRows.map((row) => row.id),
				groupSource,
				stableId,
			)
		) {
			blockers.push("out_of_group_bridge_rows");
		}
		const eligible = blockers.length === 0;
		activeMemories += totalActiveMemories;
		repointableActiveMemories += repointable;
		if (mappedSessions > 0) groupsWithMappedSession += 1;
		else groupsWithoutMappedSession += 1;
		if (eligible) eligibleGroups += 1;
		else ineligibleGroups += 1;

		reportGroups.push({
			source: groupSource,
			stable_id: stableId,
			local_sessions: groupRows.length,
			mapped_sessions: mappedSessions,
			unmapped_sessions: unmappedSessions,
			eligible,
			blockers,
			canonical_session_id: canonical.id,
			canonical_reason: canonicalReason,
			would_create_bridge: canonical.has_mapping === 0,
			sessions_to_compact: Math.max(0, groupRows.length - 1),
			all_session_ids: groupRows.map((row) => row.id),
			sample_session_ids: groupRows.slice(0, 5).map((row) => row.id),
			active_memories: totalActiveMemories,
			repointable_active_memories: repointable,
			oldest_started_at:
				[...groupRows]
					.map((row) => row.started_at)
					.filter(Boolean)
					.sort()[0] ?? null,
			latest_started_at:
				[...groupRows]
					.map((row) => row.started_at)
					.filter(Boolean)
					.sort()
					.at(-1) ?? null,
			project: canonical.project,
		});
	}

	reportGroups.sort((a, b) => {
		if (b.repointable_active_memories !== a.repointable_active_memories) {
			return b.repointable_active_memories - a.repointable_active_memories;
		}
		if (b.local_sessions !== a.local_sessions) return b.local_sessions - a.local_sessions;
		return a.stable_id.localeCompare(b.stable_id);
	});

	return {
		totals: {
			recoverable_sessions: rows.length,
			distinct_stable_ids: groups.size,
			groups_with_multiple_sessions: reportGroups.filter((group) => group.local_sessions > 1)
				.length,
			groups_with_mapped_session: groupsWithMappedSession,
			groups_without_mapped_session: groupsWithoutMappedSession,
			eligible_groups: eligibleGroups,
			ineligible_groups: ineligibleGroups,
			active_memories: activeMemories,
			repointable_active_memories: repointableActiveMemories,
		},
		groups: reportGroups.slice(0, limit),
	};
}

function applyRawEventRelinkPlanWithDb(
	db: Database,
	opts: RawEventRelinkApplyOptions = {},
): RawEventRelinkApplyResult {
	const d = drizzle(db, { schema });
	const report = getRawEventRelinkReportFromDb(db, {
		...opts,
		limit: opts.limit ?? Number.MAX_SAFE_INTEGER,
	});
	const skippedGroups: Array<{ stable_id: string; blockers: string[] }> = [];
	let eligibleGroups = 0;
	let bridgeCreations = 0;
	let memoryRepoints = 0;
	let sessionCompactions = 0;
	const now = new Date().toISOString();

	const reconcile = db.transaction(() => {
		for (const group of report.groups) {
			if (!group.eligible) {
				skippedGroups.push({ stable_id: group.stable_id, blockers: group.blockers });
				continue;
			}
			eligibleGroups += 1;
			if (group.would_create_bridge) {
				d.insert(schema.opencodeSessions)
					.values({
						source: group.source,
						stream_id: group.stable_id,
						opencode_session_id: group.stable_id,
						session_id: group.canonical_session_id,
						created_at: now,
					})
					.onConflictDoUpdate({
						target: [schema.opencodeSessions.source, schema.opencodeSessions.stream_id],
						set: {
							opencode_session_id: sql`excluded.opencode_session_id`,
							session_id: sql`excluded.session_id`,
						},
					})
					.run();
				bridgeCreations += 1;
			}

			const redundantSessionIds = group.all_session_ids.filter(
				(id) => id !== group.canonical_session_id,
			);
			if (redundantSessionIds.length === 0) continue;

			memoryRepoints += Number(
				d
					.update(schema.memoryItems)
					.set({ session_id: group.canonical_session_id })
					.where(inArray(schema.memoryItems.session_id, redundantSessionIds))
					.run().changes ?? 0,
			);
			d.update(schema.artifacts)
				.set({ session_id: group.canonical_session_id })
				.where(inArray(schema.artifacts.session_id, redundantSessionIds))
				.run();
			d.update(schema.usageEvents)
				.set({ session_id: group.canonical_session_id })
				.where(inArray(schema.usageEvents.session_id, redundantSessionIds))
				.run();
			d.update(schema.userPrompts)
				.set({ session_id: group.canonical_session_id })
				.where(inArray(schema.userPrompts.session_id, redundantSessionIds))
				.run();
			d.update(schema.sessionSummaries)
				.set({ session_id: group.canonical_session_id })
				.where(inArray(schema.sessionSummaries.session_id, redundantSessionIds))
				.run();
			sessionCompactions += Number(
				d.delete(schema.sessions).where(inArray(schema.sessions.id, redundantSessionIds)).run()
					.changes ?? 0,
			);
		}
	});

	reconcile();
	return {
		totals: {
			groups: report.groups.length,
			eligible_groups: eligibleGroups,
			skipped_groups: skippedGroups.length,
			bridge_creations: bridgeCreations,
			memory_repoints: memoryRepoints,
			session_compactions: sessionCompactions,
		},
		skipped_groups: skippedGroups,
	};
}

export {
	compareMemoryRoleReports,
	getMemoryRoleReport,
} from "./maintenance/memory-role-report.js";

export function getRawEventRelinkReport(
	dbPath?: string,
	opts: RawEventRelinkReportOptions = {},
): RawEventRelinkReport {
	return withDb(dbPath, (db) => getRawEventRelinkReportFromDb(db, opts));
}

export function getRawEventRelinkPlan(
	dbPath?: string,
	opts: RawEventRelinkPlanOptions = {},
): RawEventRelinkPlan {
	const report = getRawEventRelinkReport(dbPath, opts);
	const actions: RawEventRelinkAction[] = [];
	let bridgeCreations = 0;
	let memoryRepoints = 0;
	let sessionCompactions = 0;
	const skippedGroups: Array<{ stable_id: string; blockers: string[] }> = [];
	let eligibleGroups = 0;

	for (const group of report.groups) {
		if (!group.eligible) {
			skippedGroups.push({ stable_id: group.stable_id, blockers: group.blockers });
			continue;
		}
		eligibleGroups += 1;
		if (group.would_create_bridge) {
			bridgeCreations += 1;
			actions.push({
				action: "create_bridge",
				stable_id: group.stable_id,
				canonical_session_id: group.canonical_session_id,
				session_ids: [group.canonical_session_id],
				memory_count: 0,
				reason: group.canonical_reason,
			});
		}

		if (group.repointable_active_memories > 0) {
			memoryRepoints += group.repointable_active_memories;
			actions.push({
				action: "repoint_memories",
				stable_id: group.stable_id,
				canonical_session_id: group.canonical_session_id,
				session_ids: group.all_session_ids.filter((id) => id !== group.canonical_session_id),
				memory_count: group.repointable_active_memories,
				reason: group.canonical_reason,
			});
		}

		if (group.sessions_to_compact > 0) {
			sessionCompactions += group.sessions_to_compact;
			actions.push({
				action: "compact_sessions",
				stable_id: group.stable_id,
				canonical_session_id: group.canonical_session_id,
				session_ids: group.all_session_ids.filter((id) => id !== group.canonical_session_id),
				memory_count: group.repointable_active_memories,
				reason: group.canonical_reason,
			});
		}
	}

	return {
		totals: {
			groups: report.groups.length,
			eligible_groups: eligibleGroups,
			skipped_groups: skippedGroups.length,
			actions: actions.length,
			bridge_creations: bridgeCreations,
			memory_repoints: memoryRepoints,
			session_compactions: sessionCompactions,
		},
		actions,
		skipped_groups: skippedGroups,
	};
}

export function applyRawEventRelinkPlan(
	dbPath?: string,
	opts: RawEventRelinkApplyOptions = {},
): RawEventRelinkApplyResult {
	return withDb(dbPath, (db) => applyRawEventRelinkPlanWithDb(db, opts));
}

export function initDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	const resolvedPath = resolveDbPath(dbPath);
	const db = connect(resolvedPath);
	try {
		if (getSchemaVersion(db) === 0) {
			bootstrapSchema(db);
		}
		assertSchemaReady(db);
		ensureMaintenanceJobsSchema(db);
		applyRawEventRelinkPlanWithDb(db);
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	} finally {
		db.close();
	}
}

export function vacuumDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	return withDb(dbPath, (db, resolvedPath) => {
		db.exec("VACUUM");
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	});
}

// ---------------------------------------------------------------------------
// Reliability metrics
// ---------------------------------------------------------------------------

export type { GateResult, ReliabilityMetrics } from "./maintenance/reliability.js";
export { getReliabilityMetrics, rawEventsGate } from "./maintenance/reliability.js";

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export type {
	BackfillTagsTextOptions,
	BackfillTagsTextResult,
} from "./maintenance/backfill-tags.js";
export { backfillTagsText } from "./maintenance/backfill-tags.js";

export type {
	DeactivateLowSignalMemoriesOptions,
	DeactivateLowSignalResult,
} from "./maintenance/low-signal.js";
export {
	deactivateLowSignalMemories,
	deactivateLowSignalObservations,
} from "./maintenance/low-signal.js";

// ---------------------------------------------------------------------------
// Retroactive near-duplicate deactivation
// ---------------------------------------------------------------------------

export type {
	DedupNearDuplicatesOptions,
	DedupNearDuplicatesResult,
} from "./maintenance/dedup.js";
export { dedupNearDuplicateMemories } from "./maintenance/dedup.js";

// ---------------------------------------------------------------------------
// Heuristic narrative extraction from session_summary body_text
// ---------------------------------------------------------------------------

export type {
	BackfillNarrativeOptions,
	BackfillNarrativeResult,
} from "./maintenance/backfill-narrative.js";
export { backfillNarrativeFromBody } from "./maintenance/backfill-narrative.js";
export type {
	BackfillDedupKeysOptions,
	BackfillDedupKeysPlan,
	BackfillDedupKeysResult,
} from "./maintenance/dedup-keys.js";
export {
	applyMemoryDedupKeyUpdates,
	backfillMemoryDedupKeys,
	planMemoryDedupKeys,
} from "./maintenance/dedup-keys.js";
export { extractNarrativeFromBody } from "./maintenance/narrative-extract.js";

// ---------------------------------------------------------------------------
// AI structured-content backfill
// ---------------------------------------------------------------------------

export type {
	AIBackfillStructuredContentOptions,
	AIBackfillStructuredContentResult,
} from "./maintenance/ai-structured.js";
export { aiBackfillStructuredContent } from "./maintenance/ai-structured.js";
