import { statSync } from "node:fs";
import { and, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
	assertSchemaReady,
	connect,
	type Database,
	getSchemaVersion,
	resolveDbPath,
} from "./db.js";
import { isLowSignalObservation } from "./ingest-filters.js";
import { buildMemoryPack } from "./pack.js";
import { projectClause } from "./project.js";
import * as schema from "./schema.js";
import { bootstrapSchema } from "./schema-bootstrap.js";
import { MemoryStore } from "./store.js";

export interface RawEventStatusItem {
	source: string;
	stream_id: string;
	opencode_session_id: string | null;
	cwd: string | null;
	project: string | null;
	started_at: string | null;
	last_seen_ts_wall_ms: number | null;
	last_received_event_seq: number;
	last_flushed_event_seq: number;
	updated_at: string;
	session_stream_id: string;
	session_id: string;
}

export interface RawEventStatusResult {
	items: RawEventStatusItem[];
	totals: { pending: number; sessions: number };
	ingest: { available: true; mode: "stream_queue"; max_body_bytes: number };
}

export type MemoryRole = "recap" | "durable" | "ephemeral" | "general";

export interface MemoryRoleReportOptions {
	project?: string | null;
	allProjects?: boolean;
	includeInactive?: boolean;
	probes?: string[];
}

export interface MemoryRoleProbeItem {
	id: number;
	kind: string;
	title: string;
	role: MemoryRole;
	role_reason: string;
	mapping: "mapped" | "unmapped";
	relinkable: boolean;
}

export interface MemoryRoleProbeResult {
	query: string;
	mode: string;
	item_ids: number[];
	items: MemoryRoleProbeItem[];
	top_role_counts: Record<MemoryRole, number>;
	top_mapping_counts: Record<"mapped" | "unmapped", number>;
	top_burden: {
		recap_share: number;
		unmapped_share: number;
		recap_unmapped_share: number;
	};
	simulated_demoted_unmapped_recap?: {
		item_ids: number[];
		top_role_counts: Record<MemoryRole, number>;
		top_mapping_counts: Record<"mapped" | "unmapped", number>;
		top_burden: {
			recap_share: number;
			unmapped_share: number;
			recap_unmapped_share: number;
		};
	};
	simulated_demoted_unmapped_recap_and_ephemeral?: {
		item_ids: number[];
		top_role_counts: Record<MemoryRole, number>;
		top_mapping_counts: Record<"mapped" | "unmapped", number>;
		top_burden: {
			recap_share: number;
			unmapped_share: number;
			recap_unmapped_share: number;
		};
	};
	simulated_relinked_mapping?: {
		item_ids: number[];
		top_mapping_counts: Record<"mapped" | "unmapped", number>;
		top_burden: {
			recap_share: number;
			unmapped_share: number;
			recap_unmapped_share: number;
		};
	};
}

export interface MemoryRoleReport {
	totals: {
		memories: number;
		active: number;
		sessions: number;
	};
	counts_by_kind: Record<string, number>;
	counts_by_role: Record<MemoryRole, number>;
	counts_by_mapping: Record<"mapped" | "unmapped", number>;
	summary_lineages: {
		session_summary: number;
		legacy_metadata_summary: number;
	};
	summary_mapping: {
		mapped: number;
		unmapped: number;
	};
	project_quality: {
		normal: number;
		empty: number;
		garbage_like: number;
	};
	session_duration_buckets: Record<string, number>;
	role_examples: Partial<
		Record<MemoryRole, Array<{ id: number; kind: string; title: string; role_reason: string }>>
	>;
	probe_results: MemoryRoleProbeResult[];
}

export interface RawEventRelinkGroup {
	stable_id: string;
	local_sessions: number;
	mapped_sessions: number;
	unmapped_sessions: number;
	canonical_session_id: number;
	canonical_reason: string;
	would_create_bridge: boolean;
	sessions_to_compact: number;
	sample_session_ids: number[];
	active_memories: number;
	repointable_active_memories: number;
	oldest_started_at: string | null;
	latest_started_at: string | null;
	project: string | null;
}

export interface RawEventRelinkReportOptions {
	project?: string | null;
	allProjects?: boolean;
	limit?: number;
}

export interface RawEventRelinkReport {
	totals: {
		recoverable_sessions: number;
		distinct_stable_ids: number;
		groups_with_multiple_sessions: number;
		groups_with_mapped_session: number;
		groups_without_mapped_session: number;
		active_memories: number;
		repointable_active_memories: number;
	};
	groups: RawEventRelinkGroup[];
}

interface InferredMemoryRole {
	role: MemoryRole;
	reason: string;
}

function withDb<T>(dbPath: string | undefined, fn: (db: Database, resolvedPath: string) => T): T {
	const resolvedPath = resolveDbPath(dbPath);
	const db = connect(resolvedPath);
	try {
		assertSchemaReady(db);
		return fn(db, resolvedPath);
	} finally {
		db.close();
	}
}

function classifyProjectQuality(project: unknown): "normal" | "empty" | "garbage_like" {
	const value = typeof project === "string" ? project.trim() : "";
	if (!value) return "empty";
	if (value === "T" || value === "adam" || value === "opencode" || value.startsWith("fatal:")) {
		return "garbage_like";
	}
	return "normal";
}

function safeParseMetadata(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function hasAnyMarker(text: string, markers: string[]): boolean {
	return markers.some((marker) => text.includes(marker));
}

function inferMemoryRole(row: {
	kind: string;
	title: string;
	body_text: string;
	project: string | null;
	metadata_json: string | null;
	session_minutes: number | null;
	has_opencode_mapping: number;
}): InferredMemoryRole {
	const metadata = safeParseMetadata(row.metadata_json);
	const isSummary = row.kind === "session_summary" || metadata?.is_summary === true;
	if (isSummary) {
		return {
			role: "recap",
			reason: row.kind === "session_summary" ? "session_summary_kind" : "legacy_summary_metadata",
		};
	}

	const text = `${row.title} ${row.body_text}`.toLowerCase();
	const projectQuality = classifyProjectQuality(row.project);
	const microSession = (row.session_minutes ?? 0) < 1;
	const hasTaskMarkers = hasAnyMarker(text, [
		"task:",
		"todo",
		"need to",
		"next step",
		"follow up",
		"continue ",
	]);
	const hasRecapMarkers = hasAnyMarker(text, [
		"## request",
		"## completed",
		"## learned",
		"user asked",
		"the session",
		"the goal was",
	]);
	const hasInvestigativeMarkers = hasAnyMarker(text, [
		"identified",
		"discovered",
		"confirm",
		"confirmed",
		"verified",
		"investigate",
		"investigated",
		"determine whether",
		"clarified",
		"resolved",
	]);

	if (["decision", "bugfix", "discovery", "exploration"].includes(row.kind)) {
		if (projectQuality !== "normal")
			return { role: "general", reason: "durable_kind_with_non_normal_project" };
		if (hasTaskMarkers && !hasInvestigativeMarkers) {
			return { role: "ephemeral", reason: "durable_kind_task_markers_without_resolution" };
		}
		return { role: "durable", reason: "durable_kind" };
	}

	if (["feature", "refactor"].includes(row.kind)) {
		if (hasRecapMarkers) return { role: "recap", reason: "implementation_kind_with_recap_markers" };
		if (microSession && hasTaskMarkers) {
			return { role: "ephemeral", reason: "micro_session_implementation_task" };
		}
		return { role: "durable", reason: "implementation_kind" };
	}

	if (row.kind === "change") {
		if (hasRecapMarkers) {
			return { role: "recap", reason: "change_with_recap_markers" };
		}
		if (microSession) return { role: "ephemeral", reason: "micro_session_change" };
		if (projectQuality !== "normal")
			return { role: "general", reason: "change_with_non_normal_project" };
		if (hasInvestigativeMarkers && !hasTaskMarkers) {
			return { role: "durable", reason: "change_with_investigative_markers" };
		}
		return { role: "ephemeral", reason: "default_change_ephemeral" };
	}

	return projectQuality !== "normal"
		? { role: "general", reason: "fallback_non_normal_project" }
		: { role: "ephemeral", reason: "fallback_ephemeral" };
}

export function getMemoryRoleReport(
	dbPath?: string,
	opts: MemoryRoleReportOptions = {},
): MemoryRoleReport {
	return withDb(dbPath, (db, resolvedPath) => {
		const projectFilter = opts.allProjects ? null : opts.project?.trim() || null;
		const activeClause = opts.includeInactive ? "" : "AND m.active = 1";
		const projectClause = projectFilter ? "AND s.project = ?" : "";
		const params = projectFilter ? [projectFilter] : [];

		const rows = db
			.prepare(
				`SELECT
					m.id,
					m.session_id,
					m.kind,
					m.title,
					m.body_text,
					m.active,
					m.metadata_json,
					s.project,
					CASE
						WHEN s.ended_at IS NOT NULL THEN (julianday(s.ended_at) - julianday(s.started_at)) * 24 * 60
						ELSE NULL
					END AS session_minutes,
					CASE WHEN os.session_id IS NULL THEN 0 ELSE 1 END AS has_opencode_mapping
					,
					CASE
						WHEN json_extract(s.metadata_json, '$.session_context.flusher') = 'raw_events'
						THEN COALESCE(
							json_extract(s.metadata_json, '$.session_context.opencodeSessionId'),
							json_extract(s.metadata_json, '$.session_context.streamId')
						)
						ELSE NULL
					END AS stable_id
				FROM memory_items m
				JOIN sessions s ON s.id = m.session_id
				LEFT JOIN (
					SELECT DISTINCT session_id
					FROM opencode_sessions
					WHERE session_id IS NOT NULL
				) os ON os.session_id = m.session_id
				WHERE 1 = 1 ${activeClause} ${projectClause}`,
			)
			.all(...params) as Array<{
			id: number;
			session_id: number;
			kind: string;
			title: string;
			body_text: string;
			active: number;
			metadata_json: string | null;
			project: string | null;
			session_minutes: number | null;
			has_opencode_mapping: number;
			stable_id: string | null;
		}>;

		const roleCounts: Record<MemoryRole, number> = {
			recap: 0,
			durable: 0,
			ephemeral: 0,
			general: 0,
		};
		const mappingCounts = { mapped: 0, unmapped: 0 };
		const kindCounts: Record<string, number> = {};
		const projectQuality = { normal: 0, empty: 0, garbage_like: 0 };
		const sessionDurationBuckets: Record<string, number> = {
			"<1m": 0,
			"1-5m": 0,
			"5-30m": 0,
			"30-120m": 0,
			"120m+": 0,
			open: 0,
		};
		const roleExamples: MemoryRoleReport["role_examples"] = {};
		let sessionSummaryCount = 0;
		let legacySummaryCount = 0;
		let mappedSummaryCount = 0;
		let unmappedSummaryCount = 0;
		const seenSessionBuckets = new Set<number>();

		for (const row of rows) {
			kindCounts[row.kind] = (kindCounts[row.kind] ?? 0) + 1;
			const mapping: "mapped" | "unmapped" = row.has_opencode_mapping ? "mapped" : "unmapped";
			mappingCounts[mapping] += 1;
			const quality = classifyProjectQuality(row.project);
			projectQuality[quality] += 1;

			const metadata = safeParseMetadata(row.metadata_json);
			if (row.kind === "session_summary") sessionSummaryCount += 1;
			if (row.kind === "change" && metadata?.is_summary === true) legacySummaryCount += 1;
			if (row.kind === "session_summary" || metadata?.is_summary === true) {
				if (mapping === "mapped") mappedSummaryCount += 1;
				else unmappedSummaryCount += 1;
			}

			const inferred = inferMemoryRole(row);
			roleCounts[inferred.role] += 1;
			if (!roleExamples[inferred.role]) {
				roleExamples[inferred.role] = [];
			}
			const examples = roleExamples[inferred.role] as Array<{
				id: number;
				kind: string;
				title: string;
				role_reason: string;
			}>;
			if (examples.length < 3) {
				examples.push({
					id: row.id,
					kind: row.kind,
					title: row.title,
					role_reason: inferred.reason,
				});
			}

			if (!seenSessionBuckets.has(row.session_id)) {
				seenSessionBuckets.add(row.session_id);
				const minutes = row.session_minutes;
				const bucket: keyof typeof sessionDurationBuckets =
					minutes == null
						? "open"
						: minutes < 1
							? "<1m"
							: minutes < 5
								? "1-5m"
								: minutes < 30
									? "5-30m"
									: minutes < 120
										? "30-120m"
										: "120m+";
				sessionDurationBuckets[bucket] = (sessionDurationBuckets[bucket] ?? 0) + 1;
			}
		}

		const totalsRow = db
			.prepare(
				`SELECT
					COUNT(*) AS memories,
					SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
					COUNT(DISTINCT session_id) AS sessions
				 FROM memory_items m
				 JOIN sessions s ON s.id = m.session_id
				 WHERE 1 = 1 ${projectClause}`,
			)
			.get(...params) as { memories: number; active: number; sessions: number };

		const probeResults: MemoryRoleProbeResult[] = [];
		if ((opts.probes?.length ?? 0) > 0) {
			const store = new MemoryStore(resolvedPath);
			try {
				for (const query of opts.probes ?? []) {
					const pack = buildMemoryPack(
						store,
						query,
						10,
						null,
						projectFilter ? { project: projectFilter } : undefined,
					);
					const probeItems = pack.items.map((item) => {
						const source = rows.find((row) => row.id === item.id);
						const inferred = source
							? inferMemoryRole(source)
							: item.kind === "session_summary"
								? { role: "recap" as const, reason: "session_summary_kind" }
								: { role: "ephemeral" as const, reason: "missing_source_row" };
						const mapping: "mapped" | "unmapped" = source?.has_opencode_mapping
							? "mapped"
							: "unmapped";
						const relinkable = Boolean(source?.stable_id);
						return {
							id: item.id,
							kind: item.kind,
							title: item.title,
							role: inferred.role,
							role_reason: inferred.reason,
							mapping,
							relinkable,
						};
					});
					const topRoleCounts: Record<MemoryRole, number> = {
						recap: 0,
						durable: 0,
						ephemeral: 0,
						general: 0,
					};
					const topMappingCounts = { mapped: 0, unmapped: 0 };
					let recapUnmappedCount = 0;
					for (const item of probeItems.slice(0, 5)) {
						topRoleCounts[item.role] += 1;
						topMappingCounts[item.mapping] += 1;
						if (item.role === "recap" && item.mapping === "unmapped") {
							recapUnmappedCount += 1;
						}
					}
					const topCount = Math.max(1, Math.min(5, probeItems.length));
					const simulatedItems = [...probeItems].sort((a, b) => {
						const score = (item: MemoryRoleProbeItem): number => {
							if (item.mapping === "unmapped" && item.role === "recap") return 2;
							if (item.mapping === "unmapped") return 1;
							return 0;
						};
						return score(a) - score(b);
					});
					const simulatedTopRoleCounts: Record<MemoryRole, number> = {
						recap: 0,
						durable: 0,
						ephemeral: 0,
						general: 0,
					};
					const simulatedTopMappingCounts = { mapped: 0, unmapped: 0 };
					let simulatedRecapUnmappedCount = 0;
					for (const item of simulatedItems.slice(0, 5)) {
						simulatedTopRoleCounts[item.role] += 1;
						simulatedTopMappingCounts[item.mapping] += 1;
						if (item.role === "recap" && item.mapping === "unmapped") {
							simulatedRecapUnmappedCount += 1;
						}
					}
					const simulatedItems2 = [...probeItems].sort((a, b) => {
						const score = (item: MemoryRoleProbeItem): number => {
							if (item.mapping === "unmapped" && item.role === "recap") return 3;
							if (item.mapping === "unmapped" && item.role === "ephemeral") return 2;
							if (item.mapping === "unmapped") return 1;
							return 0;
						};
						return score(a) - score(b);
					});
					const simulated2TopRoleCounts: Record<MemoryRole, number> = {
						recap: 0,
						durable: 0,
						ephemeral: 0,
						general: 0,
					};
					const simulated2TopMappingCounts = { mapped: 0, unmapped: 0 };
					let simulated2RecapUnmappedCount = 0;
					for (const item of simulatedItems2.slice(0, 5)) {
						simulated2TopRoleCounts[item.role] += 1;
						simulated2TopMappingCounts[item.mapping] += 1;
						if (item.role === "recap" && item.mapping === "unmapped") {
							simulated2RecapUnmappedCount += 1;
						}
					}
					const simulatedRelinkedItems = probeItems.map((item) =>
						item.mapping === "unmapped" && item.relinkable
							? { ...item, mapping: "mapped" as const }
							: item,
					);
					const simulatedRelinkedTopMappingCounts = { mapped: 0, unmapped: 0 };
					let simulatedRelinkedRecapUnmappedCount = 0;
					for (const item of simulatedRelinkedItems.slice(0, 5)) {
						simulatedRelinkedTopMappingCounts[item.mapping] += 1;
						if (item.role === "recap" && item.mapping === "unmapped") {
							simulatedRelinkedRecapUnmappedCount += 1;
						}
					}
					probeResults.push({
						query,
						mode: String(pack.metrics.mode ?? "default"),
						item_ids: pack.item_ids,
						items: probeItems,
						top_role_counts: topRoleCounts,
						top_mapping_counts: topMappingCounts,
						top_burden: {
							recap_share: topRoleCounts.recap / topCount,
							unmapped_share: topMappingCounts.unmapped / topCount,
							recap_unmapped_share: recapUnmappedCount / topCount,
						},
						simulated_demoted_unmapped_recap: {
							item_ids: simulatedItems.map((item) => item.id),
							top_role_counts: simulatedTopRoleCounts,
							top_mapping_counts: simulatedTopMappingCounts,
							top_burden: {
								recap_share: simulatedTopRoleCounts.recap / topCount,
								unmapped_share: simulatedTopMappingCounts.unmapped / topCount,
								recap_unmapped_share: simulatedRecapUnmappedCount / topCount,
							},
						},
						simulated_demoted_unmapped_recap_and_ephemeral: {
							item_ids: simulatedItems2.map((item) => item.id),
							top_role_counts: simulated2TopRoleCounts,
							top_mapping_counts: simulated2TopMappingCounts,
							top_burden: {
								recap_share: simulated2TopRoleCounts.recap / topCount,
								unmapped_share: simulated2TopMappingCounts.unmapped / topCount,
								recap_unmapped_share: simulated2RecapUnmappedCount / topCount,
							},
						},
						simulated_relinked_mapping: {
							item_ids: simulatedRelinkedItems.map((item) => item.id),
							top_mapping_counts: simulatedRelinkedTopMappingCounts,
							top_burden: {
								recap_share: topRoleCounts.recap / topCount,
								unmapped_share: simulatedRelinkedTopMappingCounts.unmapped / topCount,
								recap_unmapped_share: simulatedRelinkedRecapUnmappedCount / topCount,
							},
						},
					});
				}
			} finally {
				store.close();
			}
		}

		return {
			totals: {
				memories: Number(totalsRow.memories ?? 0),
				active: Number(totalsRow.active ?? 0),
				sessions: Number(totalsRow.sessions ?? 0),
			},
			counts_by_kind: kindCounts,
			counts_by_role: roleCounts,
			counts_by_mapping: mappingCounts,
			summary_lineages: {
				session_summary: sessionSummaryCount,
				legacy_metadata_summary: legacySummaryCount,
			},
			summary_mapping: {
				mapped: mappedSummaryCount,
				unmapped: unmappedSummaryCount,
			},
			project_quality: projectQuality,
			session_duration_buckets: sessionDurationBuckets,
			role_examples: roleExamples,
			probe_results: probeResults,
		};
	});
}

export function getRawEventRelinkReport(
	dbPath?: string,
	opts: RawEventRelinkReportOptions = {},
): RawEventRelinkReport {
	return withDb(dbPath, (db) => {
		const projectFilter = opts.allProjects ? null : opts.project?.trim() || null;
		const projectClause = projectFilter ? "AND s.project = ?" : "";
		const params = projectFilter ? [projectFilter] : [];
		const limit = Math.max(1, opts.limit ?? 25);

		const rows = db
			.prepare(
				`SELECT
					s.id,
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
				LEFT JOIN (
					SELECT DISTINCT session_id
					FROM opencode_sessions
					WHERE session_id IS NOT NULL
				) os ON os.session_id = s.id
				WHERE json_extract(s.metadata_json, '$.session_context.flusher') = 'raw_events'
				  AND COALESCE(
						json_extract(s.metadata_json, '$.session_context.opencodeSessionId'),
						json_extract(s.metadata_json, '$.session_context.streamId')
					  ) IS NOT NULL
				  ${projectClause}
				ORDER BY s.started_at DESC, s.id DESC`,
			)
			.all(...params) as Array<{
			id: number;
			project: string | null;
			started_at: string | null;
			ended_at: string | null;
			stable_id: string;
			has_mapping: number;
			active_memories: number;
		}>;

		const groups = new Map<string, typeof rows>();
		for (const row of rows) {
			const key = String(row.stable_id || "").trim();
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

		for (const [stableId, groupRows] of groups.entries()) {
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
			activeMemories += totalActiveMemories;
			repointableActiveMemories += repointable;
			if (mappedSessions > 0) groupsWithMappedSession += 1;
			else groupsWithoutMappedSession += 1;

			reportGroups.push({
				stable_id: stableId,
				local_sessions: groupRows.length,
				mapped_sessions: mappedSessions,
				unmapped_sessions: unmappedSessions,
				canonical_session_id: canonical.id,
				canonical_reason: canonicalReason,
				would_create_bridge: canonical.has_mapping === 0,
				sessions_to_compact: Math.max(0, groupRows.length - 1),
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
				active_memories: activeMemories,
				repointable_active_memories: repointableActiveMemories,
			},
			groups: reportGroups.slice(0, limit),
		};
	});
}

export function initDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	const resolvedPath = resolveDbPath(dbPath);
	const db = connect(resolvedPath);
	try {
		if (getSchemaVersion(db) === 0) {
			bootstrapSchema(db);
		}
		assertSchemaReady(db);
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

export function getRawEventStatus(dbPath?: string, limit = 25): RawEventStatusResult {
	return withDb(dbPath, (db) => {
		const d = drizzle(db, { schema });
		const maxEvents = d
			.select({
				source: schema.rawEvents.source,
				stream_id: schema.rawEvents.stream_id,
				max_seq: sql<number>`MAX(${schema.rawEvents.event_seq})`.as("max_seq"),
			})
			.from(schema.rawEvents)
			.groupBy(schema.rawEvents.source, schema.rawEvents.stream_id)
			.as("max_events");

		const rows = d
			.select({
				source: schema.rawEventSessions.source,
				stream_id: schema.rawEventSessions.stream_id,
				opencode_session_id: schema.rawEventSessions.opencode_session_id,
				cwd: schema.rawEventSessions.cwd,
				project: schema.rawEventSessions.project,
				started_at: schema.rawEventSessions.started_at,
				last_seen_ts_wall_ms: schema.rawEventSessions.last_seen_ts_wall_ms,
				last_received_event_seq: schema.rawEventSessions.last_received_event_seq,
				last_flushed_event_seq: schema.rawEventSessions.last_flushed_event_seq,
				updated_at: schema.rawEventSessions.updated_at,
			})
			.from(schema.rawEventSessions)
			.innerJoin(
				maxEvents,
				and(
					eq(maxEvents.source, schema.rawEventSessions.source),
					eq(maxEvents.stream_id, schema.rawEventSessions.stream_id),
				),
			)
			.where(gt(maxEvents.max_seq, schema.rawEventSessions.last_flushed_event_seq))
			.orderBy(sql`${schema.rawEventSessions.updated_at} DESC`)
			.limit(limit)
			.all();

		const items = rows.map((row) => {
			const streamId = String(row.stream_id ?? row.opencode_session_id ?? "");
			return {
				source: String(row.source ?? "opencode"),
				stream_id: streamId,
				opencode_session_id:
					row.opencode_session_id == null ? null : String(row.opencode_session_id),
				cwd: row.cwd == null ? null : String(row.cwd),
				project: row.project == null ? null : String(row.project),
				started_at: row.started_at == null ? null : String(row.started_at),
				last_seen_ts_wall_ms:
					row.last_seen_ts_wall_ms == null ? null : Number(row.last_seen_ts_wall_ms),
				last_received_event_seq: Number(row.last_received_event_seq ?? -1),
				last_flushed_event_seq: Number(row.last_flushed_event_seq ?? -1),
				updated_at: String(row.updated_at ?? ""),
				session_stream_id: streamId,
				session_id: streamId,
			};
		});

		const totalsRow = d
			.select({
				sessions: sql<number>`COUNT(1)`,
				pending: sql<
					number | null
				>`SUM(${maxEvents.max_seq} - ${schema.rawEventSessions.last_flushed_event_seq})`,
			})
			.from(schema.rawEventSessions)
			.innerJoin(
				maxEvents,
				and(
					eq(maxEvents.source, schema.rawEventSessions.source),
					eq(maxEvents.stream_id, schema.rawEventSessions.stream_id),
				),
			)
			.where(gt(maxEvents.max_seq, schema.rawEventSessions.last_flushed_event_seq))
			.get();

		return {
			items,
			totals: {
				pending: Number(totalsRow?.pending ?? 0),
				sessions: Number(totalsRow?.sessions ?? 0),
			},
			ingest: {
				available: true,
				mode: "stream_queue",
				max_body_bytes: 2_000_000,
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Reliability metrics
// ---------------------------------------------------------------------------

export interface ReliabilityMetrics {
	counts: {
		inserted_events: number;
		dropped_events: number;
		started_batches: number;
		running_batches: number;
		completed_batches: number;
		errored_batches: number;
		terminal_batches: number;
		sessions_with_events: number;
		sessions_with_started_at: number;
		retry_depth_max: number;
	};
	rates: {
		flush_success_rate: number;
		dropped_event_rate: number;
		session_boundary_accuracy: number;
	};
	window_hours: number | null;
}

export function getReliabilityMetrics(
	dbPath?: string,
	windowHours?: number | null,
): ReliabilityMetrics {
	return withDb(dbPath, (db) => {
		const d = drizzle(db, { schema });
		const cutoffIso =
			windowHours != null ? new Date(Date.now() - windowHours * 3600 * 1000).toISOString() : null;

		// Batch counts
		const batchRow = (
			cutoffIso
				? d
						.select({
							started: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('started', 'pending') THEN 1 ELSE 0 END), 0)`,
							running: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('running', 'claimed') THEN 1 ELSE 0 END), 0)`,
							completed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} = 'completed' THEN 1 ELSE 0 END), 0)`,
							errored: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('error', 'failed') THEN 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(gte(schema.rawEventFlushBatches.updated_at, cutoffIso))
						.get()
				: d
						.select({
							started: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('started', 'pending') THEN 1 ELSE 0 END), 0)`,
							running: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('running', 'claimed') THEN 1 ELSE 0 END), 0)`,
							completed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} = 'completed' THEN 1 ELSE 0 END), 0)`,
							errored: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventFlushBatches.status} IN ('error', 'failed') THEN 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.get()
		) as Record<string, number> | undefined;

		const startedBatches = Number(batchRow?.started ?? 0);
		const runningBatches = Number(batchRow?.running ?? 0);
		const completedBatches = Number(batchRow?.completed ?? 0);
		const erroredBatches = Number(batchRow?.errored ?? 0);
		const terminalBatches = completedBatches + erroredBatches;
		const flushSuccessRate = terminalBatches > 0 ? completedBatches / terminalBatches : 1.0;

		// Event counts from raw_event_sessions
		// Sequences are 0-based indexes, so +1 converts to counts.
		const eventRow = (
			cutoffIso
				? d
						.select({
							total_received: sql<number>`COALESCE(SUM(${schema.rawEventSessions.last_received_event_seq} + 1), 0)`,
							total_flushed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventSessions.last_flushed_event_seq} >= 0 THEN ${schema.rawEventSessions.last_flushed_event_seq} + 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventSessions)
						.where(gte(schema.rawEventSessions.updated_at, cutoffIso))
						.get()
				: d
						.select({
							total_received: sql<number>`COALESCE(SUM(${schema.rawEventSessions.last_received_event_seq} + 1), 0)`,
							total_flushed: sql<number>`COALESCE(SUM(CASE WHEN ${schema.rawEventSessions.last_flushed_event_seq} >= 0 THEN ${schema.rawEventSessions.last_flushed_event_seq} + 1 ELSE 0 END), 0)`,
						})
						.from(schema.rawEventSessions)
						.get()
		) as Record<string, number> | undefined;

		// In-flight events: sum of (end_event_seq - start_event_seq + 1) for active batches
		const inFlightRow = (
			cutoffIso
				? d
						.select({
							in_flight: sql<number>`COALESCE(SUM(${schema.rawEventFlushBatches.end_event_seq} - ${schema.rawEventFlushBatches.start_event_seq} + 1), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(
							and(
								inArray(schema.rawEventFlushBatches.status, [
									"started",
									"pending",
									"running",
									"claimed",
								]),
								gte(schema.rawEventFlushBatches.updated_at, cutoffIso),
							),
						)
						.get()
				: d
						.select({
							in_flight: sql<number>`COALESCE(SUM(${schema.rawEventFlushBatches.end_event_seq} - ${schema.rawEventFlushBatches.start_event_seq} + 1), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(
							inArray(schema.rawEventFlushBatches.status, [
								"started",
								"pending",
								"running",
								"claimed",
							]),
						)
						.get()
		) as Record<string, number> | undefined;
		const inFlightEvents = Number(inFlightRow?.in_flight ?? 0);

		const insertedEvents = Number(eventRow?.total_flushed ?? 0);
		const droppedEvents = Math.max(
			0,
			Number(eventRow?.total_received ?? 0) - Number(eventRow?.total_flushed ?? 0) - inFlightEvents,
		);
		const droppedDenom = insertedEvents + droppedEvents;
		const droppedEventRate = droppedDenom > 0 ? droppedEvents / droppedDenom : 0.0;

		// Session boundary accuracy
		const hasEvents = (
			cutoffIso
				? d
						.selectDistinct({
							source: schema.rawEvents.source,
							stream_id: schema.rawEvents.stream_id,
						})
						.from(schema.rawEvents)
						.where(gte(schema.rawEvents.created_at, cutoffIso))
				: d
						.selectDistinct({
							source: schema.rawEvents.source,
							stream_id: schema.rawEvents.stream_id,
						})
						.from(schema.rawEvents)
		).as("has_events");

		const boundaryRow = d
			.select({
				sessions_with_events: sql<number>`COUNT(1)`,
				sessions_with_started_at: sql<number>`COALESCE(SUM(CASE WHEN COALESCE(${schema.rawEventSessions.started_at}, '') != '' THEN 1 ELSE 0 END), 0)`,
			})
			.from(hasEvents)
			.leftJoin(
				schema.rawEventSessions,
				and(
					eq(schema.rawEventSessions.source, hasEvents.source),
					eq(schema.rawEventSessions.stream_id, hasEvents.stream_id),
				),
			)
			.get() as Record<string, number> | undefined;

		const sessionsWithEvents = Number(boundaryRow?.sessions_with_events ?? 0);
		const sessionsWithStartedAt = Number(boundaryRow?.sessions_with_started_at ?? 0);
		const sessionBoundaryAccuracy =
			sessionsWithEvents > 0 ? sessionsWithStartedAt / sessionsWithEvents : 1.0;

		const retryDepthRow = (
			cutoffIso
				? d
						.select({
							retry_depth_max: sql<number>`COALESCE(MAX(${schema.rawEventFlushBatches.attempt_count}), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.where(gte(schema.rawEventFlushBatches.updated_at, cutoffIso))
						.get()
				: d
						.select({
							retry_depth_max: sql<number>`COALESCE(MAX(${schema.rawEventFlushBatches.attempt_count}), 0)`,
						})
						.from(schema.rawEventFlushBatches)
						.get()
		) as Record<string, number> | undefined;
		const retryDepthMax = Math.max(0, Number(retryDepthRow?.retry_depth_max ?? 0) - 1);

		return {
			counts: {
				inserted_events: insertedEvents,
				dropped_events: droppedEvents,
				started_batches: startedBatches,
				running_batches: runningBatches,
				completed_batches: completedBatches,
				errored_batches: erroredBatches,
				terminal_batches: terminalBatches,
				sessions_with_events: sessionsWithEvents,
				sessions_with_started_at: sessionsWithStartedAt,
				retry_depth_max: retryDepthMax,
			},
			rates: {
				flush_success_rate: flushSuccessRate,
				dropped_event_rate: droppedEventRate,
				session_boundary_accuracy: sessionBoundaryAccuracy,
			},
			window_hours: windowHours ?? null,
		};
	});
}

export interface GateResult {
	passed: boolean;
	failures: string[];
	metrics: ReliabilityMetrics;
}

export function rawEventsGate(
	dbPath?: string,
	opts?: {
		minFlushSuccessRate?: number;
		maxDroppedEventRate?: number;
		minSessionBoundaryAccuracy?: number;
		windowHours?: number;
	},
): GateResult {
	const minFlushSuccessRate = opts?.minFlushSuccessRate ?? 0.95;
	const maxDroppedEventRate = opts?.maxDroppedEventRate ?? 0.05;
	const minSessionBoundaryAccuracy = opts?.minSessionBoundaryAccuracy ?? 0.9;
	const windowHours = opts?.windowHours ?? 24;

	const metrics = getReliabilityMetrics(dbPath, windowHours);
	const failures: string[] = [];

	if (metrics.rates.flush_success_rate < minFlushSuccessRate) {
		failures.push(
			`flush_success_rate=${metrics.rates.flush_success_rate.toFixed(4)} < min ${minFlushSuccessRate.toFixed(4)}`,
		);
	}
	if (metrics.rates.dropped_event_rate > maxDroppedEventRate) {
		failures.push(
			`dropped_event_rate=${metrics.rates.dropped_event_rate.toFixed(4)} > max ${maxDroppedEventRate.toFixed(4)}`,
		);
	}
	if (metrics.rates.session_boundary_accuracy < minSessionBoundaryAccuracy) {
		failures.push(
			`session_boundary_accuracy=${metrics.rates.session_boundary_accuracy.toFixed(4)} < min ${minSessionBoundaryAccuracy.toFixed(4)}`,
		);
	}

	return { passed: failures.length === 0, failures, metrics };
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export function retryRawEventFailures(dbPath?: string, limit = 25): { retried: number } {
	return withDb(dbPath, (db) => {
		const d = drizzle(db, { schema });
		const now = new Date().toISOString();
		return db.transaction(() => {
			const candidateIds = d
				.select({ id: schema.rawEventFlushBatches.id })
				.from(schema.rawEventFlushBatches)
				.where(inArray(schema.rawEventFlushBatches.status, ["failed", "error"]))
				.orderBy(schema.rawEventFlushBatches.updated_at)
				.limit(limit)
				.all()
				.map((row) => Number(row.id));

			if (candidateIds.length === 0) return { retried: 0 };

			const result = d
				.update(schema.rawEventFlushBatches)
				.set({
					status: "pending",
					updated_at: now,
					error_message: null,
					error_type: null,
					observer_provider: null,
					observer_model: null,
					observer_runtime: null,
					observer_auth_source: null,
					observer_auth_type: null,
					observer_error_code: null,
					observer_error_message: null,
				})
				.where(
					and(
						inArray(schema.rawEventFlushBatches.id, candidateIds),
						inArray(schema.rawEventFlushBatches.status, ["failed", "error"]),
					),
				)
				.run();

			return { retried: Number(result.changes ?? 0) };
		})();
	});
}

export interface BackfillTagsTextOptions {
	limit?: number | null;
	since?: string | null;
	project?: string | null;
	activeOnly?: boolean;
	dryRun?: boolean;
	memoryIds?: number[] | null;
}

export interface BackfillTagsTextResult {
	checked: number;
	updated: number;
	skipped: number;
}

function normalizeTag(value: string): string {
	let normalized = value.trim().toLowerCase();
	if (!normalized) return "";
	normalized = normalized.replace(/[^a-z0-9_]+/g, "-");
	normalized = normalized.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	if (!normalized) return "";
	if (normalized.length > 40) normalized = normalized.slice(0, 40).replace(/-+$/g, "");
	return normalized;
}

function fileTags(pathValue: string): string[] {
	const raw = pathValue.trim();
	if (!raw) return [];
	const parts = raw.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..");
	if (parts.length === 0) return [];
	const tags: string[] = [];
	const basename = normalizeTag(parts[parts.length - 1] ?? "");
	if (basename) tags.push(basename);
	if (parts.length >= 2) {
		const parent = normalizeTag(parts[parts.length - 2] ?? "");
		if (parent) tags.push(parent);
	}
	if (parts.length >= 3) {
		const top = normalizeTag(parts[0] ?? "");
		if (top) tags.push(top);
	}
	return tags;
}

function parseJsonStringList(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((item) => (typeof item === "string" ? item.trim() : ""))
			.filter((item) => item.length > 0);
	} catch {
		return [];
	}
}

function deriveTags(input: {
	kind: string;
	title: string;
	concepts: string[];
	filesRead: string[];
	filesModified: string[];
}): string[] {
	const tags: string[] = [];
	const kindTag = normalizeTag(input.kind);
	if (kindTag) tags.push(kindTag);

	for (const concept of input.concepts) {
		const tag = normalizeTag(concept);
		if (tag) tags.push(tag);
	}

	for (const filePath of [...input.filesRead, ...input.filesModified]) {
		tags.push(...fileTags(filePath));
	}

	if (tags.length === 0 && input.title.trim()) {
		const tokens = input.title.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
		for (const token of tokens) {
			const tag = normalizeTag(token);
			if (tag) tags.push(tag);
		}
	}

	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const tag of tags) {
		if (seen.has(tag)) continue;
		seen.add(tag);
		deduped.push(tag);
		if (deduped.length >= 20) break;
	}
	return deduped;
}

/**
 * Populate memory_items.tags_text for rows where it is empty.
 * Port of Python's backfill_tags_text() maintenance helper.
 */
export function backfillTagsText(
	db: Database,
	opts: BackfillTagsTextOptions = {},
): BackfillTagsTextResult {
	const { limit, since, project, activeOnly = true, dryRun = false, memoryIds } = opts;

	const params: unknown[] = [];
	const whereClauses = ["(memory_items.tags_text IS NULL OR TRIM(memory_items.tags_text) = '')"];

	if (activeOnly) whereClauses.push("memory_items.active = 1");
	if (since) {
		whereClauses.push("memory_items.created_at >= ?");
		params.push(since);
	}

	let joinSessions = false;
	if (project) {
		const pc = projectClause(project);
		if (pc.clause) {
			whereClauses.push(pc.clause);
			params.push(...pc.params);
			joinSessions = true;
		}
	}

	if (memoryIds && memoryIds.length > 0) {
		const placeholders = memoryIds.map(() => "?").join(",");
		whereClauses.push(`memory_items.id IN (${placeholders})`);
		params.push(...memoryIds.map((id) => Number(id)));
	}

	const where = whereClauses.join(" AND ");
	const joinClause = joinSessions ? "JOIN sessions ON sessions.id = memory_items.session_id" : "";
	const limitClause = limit != null && limit > 0 ? "LIMIT ?" : "";
	if (limit != null && limit > 0) params.push(limit);

	const rows = db
		.prepare(
			`SELECT memory_items.id, memory_items.kind, memory_items.title,
			        memory_items.concepts, memory_items.files_read, memory_items.files_modified
			 FROM memory_items
			 ${joinClause}
			 WHERE ${where}
			 ORDER BY memory_items.created_at ASC
			 ${limitClause}`,
		)
		.all(...params) as Array<{
		id: number;
		kind: string | null;
		title: string | null;
		concepts: string | null;
		files_read: string | null;
		files_modified: string | null;
	}>;

	let checked = 0;
	let updated = 0;
	let skipped = 0;
	const now = new Date().toISOString();
	const updateStmt = db.prepare(
		"UPDATE memory_items SET tags_text = ?, updated_at = ? WHERE id = ?",
	);
	const updates: Array<{ id: number; tagsText: string }> = [];

	for (const row of rows) {
		checked += 1;
		const tags = deriveTags({
			kind: String(row.kind ?? ""),
			title: String(row.title ?? ""),
			concepts: parseJsonStringList(row.concepts),
			filesRead: parseJsonStringList(row.files_read),
			filesModified: parseJsonStringList(row.files_modified),
		});
		const tagsText = tags.join(" ");
		if (!tagsText) {
			skipped += 1;
			continue;
		}
		updates.push({ id: row.id, tagsText });
		updated += 1;
	}

	if (!dryRun && updates.length > 0) {
		db.transaction(() => {
			for (const update of updates) {
				updateStmt.run(update.tagsText, now, update.id);
			}
		})();
	}

	return { checked, updated, skipped };
}

export interface DeactivateLowSignalResult {
	checked: number;
	deactivated: number;
}

export interface DeactivateLowSignalMemoriesOptions {
	kinds?: string[] | null;
	limit?: number | null;
	dryRun?: boolean;
}

const DEFAULT_LOW_SIGNAL_KINDS = [
	"observation",
	"discovery",
	"change",
	"feature",
	"bugfix",
	"refactor",
	"decision",
	"note",
	"entities",
	"session_summary",
];

const OBSERVATION_EQUIVALENT_KINDS = [
	"observation",
	"bugfix",
	"feature",
	"refactor",
	"change",
	"discovery",
	"decision",
	"exploration",
];

/**
 * Deactivate low-signal observations only.
 */
export function deactivateLowSignalObservations(
	db: Database,
	limit?: number | null,
	dryRun = false,
): DeactivateLowSignalResult {
	return deactivateLowSignalMemories(db, {
		kinds: OBSERVATION_EQUIVALENT_KINDS,
		limit,
		dryRun,
	});
}

/**
 * Deactivate low-signal memories across selected kinds (does not delete rows).
 */
export function deactivateLowSignalMemories(
	db: Database,
	opts: DeactivateLowSignalMemoriesOptions = {},
): DeactivateLowSignalResult {
	const selectedKinds =
		opts.kinds?.map((kind) => kind.trim()).filter((kind) => kind.length > 0) ?? [];
	const kinds = selectedKinds.length > 0 ? selectedKinds : DEFAULT_LOW_SIGNAL_KINDS;
	const placeholders = kinds.map(() => "?").join(",");
	const params: unknown[] = [...kinds];
	let limitClause = "";
	if (opts.limit != null && opts.limit > 0) {
		limitClause = "LIMIT ?";
		params.push(opts.limit);
	}

	const rows = db
		.prepare(
			`SELECT id, title, body_text
			 FROM memory_items
			 WHERE kind IN (${placeholders}) AND active = 1
			 ORDER BY id DESC
			 ${limitClause}`,
		)
		.all(...params) as Array<{ id: number; title: string | null; body_text: string | null }>;

	const checked = rows.length;
	const ids = rows
		.filter((row) => isLowSignalObservation(row.body_text || row.title || ""))
		.map((row) => Number(row.id));

	if (ids.length === 0 || opts.dryRun === true) {
		return { checked, deactivated: ids.length };
	}

	const now = new Date().toISOString();
	const chunkSize = 200;
	for (let start = 0; start < ids.length; start += chunkSize) {
		const chunk = ids.slice(start, start + chunkSize);
		const chunkPlaceholders = chunk.map(() => "?").join(",");
		db.prepare(
			`UPDATE memory_items SET active = 0, updated_at = ? WHERE id IN (${chunkPlaceholders})`,
		).run(now, ...chunk);
	}

	return { checked, deactivated: ids.length };
}
