/* Memory-role reporting — builds the role/mapping/probe report used by
 * the CLI's `bd memory role-report` and related tooling.
 *
 * Extracted verbatim from packages/core/src/maintenance.ts as part of
 * the maintenance/ split (tracked under codemem-ug38).
 */

import { getInjectionEvalScenarioByPrompt } from "../eval-scenarios.js";
import { inferMemoryRole } from "../memory-quality.js";
import { buildMemoryPack } from "../pack.js";
import { MemoryStore } from "../store.js";
import { canonicalMemoryKind, isSummaryLikeMemory } from "../summary-memory.js";
import {
	classifyProjectQuality,
	compareProbeResults,
	type InferredMemoryRole,
	safeParseMetadata,
	scoreProbeScenario,
	stableProbeItemKey,
	subtractKeyedCounts,
} from "./memory-role-helpers.js";
import type {
	MemoryRole,
	MemoryRoleProbeItem,
	MemoryRoleProbeResult,
	MemoryRoleReport,
	MemoryRoleReportComparison,
	MemoryRoleReportComparisonOptions,
	MemoryRoleReportOptions,
} from "./types.js";
import { withDb } from "./with-db.js";

function inferMemoryRoleForReport(row: {
	kind: string;
	title: string;
	body_text: string;
	project: string | null;
	metadata_json: string | null;
	session_minutes: number | null;
	has_opencode_mapping: number;
}): InferredMemoryRole {
	return inferMemoryRole({
		kind: row.kind,
		title: row.title,
		body_text: row.body_text,
		metadata: safeParseMetadata(row.metadata_json),
		project: row.project,
		session_minutes: row.session_minutes,
	});
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
					m.import_key,
					m.kind,
					m.title,
					m.body_text,
					m.active,
					m.metadata_json,
					s.project,
					s.metadata_json AS session_metadata_json,
					CASE
						WHEN s.ended_at IS NOT NULL THEN (julianday(s.ended_at) - julianday(s.started_at)) * 24 * 60
						ELSE NULL
					END AS session_minutes,
					CASE WHEN os.session_id IS NULL THEN 0 ELSE 1 END AS has_opencode_mapping
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
			import_key: string | null;
			kind: string;
			title: string;
			body_text: string;
			active: number;
			metadata_json: string | null;
			project: string | null;
			session_metadata_json: string | null;
			session_minutes: number | null;
			has_opencode_mapping: number;
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
		const sessionClassBuckets: Record<string, number> = {};
		const summaryDispositionBuckets: Record<string, number> = {};
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
			if (isSummaryLikeMemory({ kind: row.kind, metadata })) {
				if (mapping === "mapped") mappedSummaryCount += 1;
				else unmappedSummaryCount += 1;
			}

			const inferred = inferMemoryRoleForReport(row);
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
				const sessionMeta = safeParseMetadata(row.session_metadata_json);
				const post =
					sessionMeta.post &&
					typeof sessionMeta.post === "object" &&
					!Array.isArray(sessionMeta.post)
						? (sessionMeta.post as Record<string, unknown>)
						: {};
				const sessionClass = String(post.session_class ?? "unknown").trim() || "unknown";
				const summaryDisposition =
					String(post.summary_disposition ?? "unknown").trim() || "unknown";
				sessionClassBuckets[sessionClass] = (sessionClassBuckets[sessionClass] ?? 0) + 1;
				summaryDispositionBuckets[summaryDisposition] =
					(summaryDispositionBuckets[summaryDisposition] ?? 0) + 1;
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
					const scenario = getInjectionEvalScenarioByPrompt(query);
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
							? inferMemoryRoleForReport(source)
							: canonicalMemoryKind(item.kind, item.metadata) === "session_summary"
								? { role: "recap" as const, reason: "session_summary_kind" }
								: { role: "ephemeral" as const, reason: "missing_source_row" };
						const mapping: "mapped" | "unmapped" = source?.has_opencode_mapping
							? "mapped"
							: "unmapped";
						const sessionMeta = safeParseMetadata(source?.session_metadata_json ?? null);
						const post =
							sessionMeta.post &&
							typeof sessionMeta.post === "object" &&
							!Array.isArray(sessionMeta.post)
								? (sessionMeta.post as Record<string, unknown>)
								: {};
						return {
							id: item.id,
							stable_key: stableProbeItemKey({
								import_key: source?.import_key ?? null,
								kind: source?.kind ?? item.kind,
								title: source?.title ?? item.title,
								body_text: source?.body_text ?? "",
							}),
							kind: canonicalMemoryKind(item.kind, item.metadata),
							title: item.title,
							role: inferred.role,
							role_reason: inferred.reason,
							mapping,
							session_class: String(post.session_class ?? "unknown"),
							summary_disposition: String(post.summary_disposition ?? "unknown"),
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
					probeResults.push({
						query,
						scenario_id: scenario?.id,
						scenario_title: scenario?.title,
						scenario_category: scenario?.category,
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
						scenario_score: scoreProbeScenario(
							probeItems,
							query,
							String(pack.metrics.mode ?? "default"),
						),
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
			session_class_buckets: sessionClassBuckets,
			summary_disposition_buckets: summaryDispositionBuckets,
			role_examples: roleExamples,
			probe_results: probeResults,
		};
	});
}

export function compareMemoryRoleReports(
	baselineDbPath: string,
	candidateDbPath: string,
	opts: MemoryRoleReportComparisonOptions = {},
): MemoryRoleReportComparison {
	const baseline = getMemoryRoleReport(baselineDbPath, opts);
	const candidate = getMemoryRoleReport(candidateDbPath, opts);
	return {
		baseline,
		candidate,
		delta: {
			totals: {
				memories: candidate.totals.memories - baseline.totals.memories,
				active: candidate.totals.active - baseline.totals.active,
				sessions: candidate.totals.sessions - baseline.totals.sessions,
			},
			counts_by_role: subtractKeyedCounts(baseline.counts_by_role, candidate.counts_by_role),
			counts_by_mapping: subtractKeyedCounts(
				baseline.counts_by_mapping,
				candidate.counts_by_mapping,
			),
			summary_mapping: subtractKeyedCounts(baseline.summary_mapping, candidate.summary_mapping),
			session_duration_buckets: subtractKeyedCounts(
				baseline.session_duration_buckets,
				candidate.session_duration_buckets,
			),
			session_class_buckets: subtractKeyedCounts(
				baseline.session_class_buckets,
				candidate.session_class_buckets,
			),
			summary_disposition_buckets: subtractKeyedCounts(
				baseline.summary_disposition_buckets,
				candidate.summary_disposition_buckets,
			),
		},
		probe_comparisons: compareProbeResults(baseline.probe_results, candidate.probe_results),
	};
}
