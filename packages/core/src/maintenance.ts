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
import { getInjectionEvalScenarioByPrompt } from "./eval-scenarios.js";
import { isLowSignalObservation } from "./ingest-filters.js";
import {
	completeMaintenanceJob,
	ensureMaintenanceJobsSchema,
	failMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { buildMemoryDedupKey } from "./memory-dedup.js";
import { loadObserverConfig, ObserverClient } from "./observer-client.js";
import { buildMemoryPack } from "./pack.js";
import { projectClause } from "./project.js";
import * as schema from "./schema.js";
import { bootstrapSchema, ensureSchemaBootstrapped } from "./schema-bootstrap.js";
import { MemoryStore } from "./store.js";
import { canonicalMemoryKind, getSummaryMetadata, isSummaryLikeMemory } from "./summary-memory.js";

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
	stable_key: string;
	kind: string;
	title: string;
	role: MemoryRole;
	role_reason: string;
	mapping: "mapped" | "unmapped";
	session_class: string;
	summary_disposition: string;
}

export interface MemoryRoleProbeResult {
	query: string;
	scenario_id?: string;
	scenario_title?: string;
	scenario_category?: string;
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
	scenario_score?: {
		mode_match: boolean;
		primary_in_top1: boolean;
		primary_in_top3_count: number;
		anti_signal_in_top1: boolean;
		primary_match_count: number;
		anti_signal_count: number;
		recap_count: number;
		unmapped_recap_count: number;
		administrative_chatter_count: number;
		score: number;
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
	session_class_buckets: Record<string, number>;
	summary_disposition_buckets: Record<string, number>;
	role_examples: Partial<
		Record<MemoryRole, Array<{ id: number; kind: string; title: string; role_reason: string }>>
	>;
	probe_results: MemoryRoleProbeResult[];
}

export interface MemoryRoleReportComparisonOptions extends MemoryRoleReportOptions {}

export interface MemoryRoleProbeComparison {
	query: string;
	baseline_scenario_id?: string;
	candidate_scenario_id?: string;
	baseline_scenario_title?: string;
	candidate_scenario_title?: string;
	baseline_scenario_category?: string;
	candidate_scenario_category?: string;
	baseline_mode: string | null;
	candidate_mode: string | null;
	baseline_item_ids: number[];
	candidate_item_ids: number[];
	shared_item_keys: string[];
	baseline_top_burden: MemoryRoleProbeResult["top_burden"] | null;
	candidate_top_burden: MemoryRoleProbeResult["top_burden"] | null;
	delta_top_burden: MemoryRoleProbeResult["top_burden"] | null;
	baseline_top_mapping_counts: Record<"mapped" | "unmapped", number> | null;
	candidate_top_mapping_counts: Record<"mapped" | "unmapped", number> | null;
	delta_top_mapping_counts: Record<"mapped" | "unmapped", number> | null;
	baseline_scenario_score?: MemoryRoleProbeResult["scenario_score"];
	candidate_scenario_score?: MemoryRoleProbeResult["scenario_score"];
	delta_scenario_score?: Partial<
		Record<keyof NonNullable<MemoryRoleProbeResult["scenario_score"]>, number>
	>;
}

export interface MemoryRoleReportComparison {
	baseline: MemoryRoleReport;
	candidate: MemoryRoleReport;
	delta: {
		totals: MemoryRoleReport["totals"];
		counts_by_role: Record<MemoryRole, number>;
		counts_by_mapping: Record<"mapped" | "unmapped", number>;
		summary_mapping: Record<"mapped" | "unmapped", number>;
		session_duration_buckets: Record<string, number>;
		session_class_buckets: Record<string, number>;
		summary_disposition_buckets: Record<string, number>;
	};
	probe_comparisons: MemoryRoleProbeComparison[];
}

export interface RawEventRelinkGroup {
	source: string;
	stable_id: string;
	local_sessions: number;
	mapped_sessions: number;
	unmapped_sessions: number;
	eligible: boolean;
	blockers: string[];
	canonical_session_id: number;
	canonical_reason: string;
	would_create_bridge: boolean;
	sessions_to_compact: number;
	all_session_ids: number[];
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
		eligible_groups: number;
		ineligible_groups: number;
		active_memories: number;
		repointable_active_memories: number;
	};
	groups: RawEventRelinkGroup[];
}

export interface RawEventRelinkAction {
	action: "create_bridge" | "repoint_memories" | "compact_sessions";
	stable_id: string;
	canonical_session_id: number;
	session_ids: number[];
	memory_count: number;
	reason: string;
}

export interface RawEventRelinkPlanOptions extends RawEventRelinkReportOptions {}

export interface RawEventRelinkPlan {
	totals: {
		groups: number;
		eligible_groups: number;
		skipped_groups: number;
		actions: number;
		bridge_creations: number;
		memory_repoints: number;
		session_compactions: number;
	};
	actions: RawEventRelinkAction[];
	skipped_groups: Array<{ stable_id: string; blockers: string[] }>;
}

export interface RawEventRelinkApplyOptions extends RawEventRelinkReportOptions {}

export interface RawEventRelinkApplyResult {
	totals: {
		groups: number;
		eligible_groups: number;
		skipped_groups: number;
		bridge_creations: number;
		memory_repoints: number;
		session_compactions: number;
	};
	skipped_groups: Array<{ stable_id: string; blockers: string[] }>;
}

interface InferredMemoryRole {
	role: MemoryRole;
	reason: string;
}

function withDb<T>(dbPath: string | undefined, fn: (db: Database, resolvedPath: string) => T): T {
	const resolvedPath = resolveDbPath(dbPath);
	const db = connect(resolvedPath);
	try {
		// Auto-bootstrap fresh databases before asserting readiness. This
		// helper backs several exported maintenance functions that are hit
		// from CLI commands (`db vacuum`, `db raw-events-status`,
		// `db raw-events-retry`, `db raw-events-gate`, `memory roles`,
		// `memory relink-report`), any of which a user can run before
		// `codemem db init`.
		ensureSchemaBootstrapped(db);
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
	return getSummaryMetadata(raw);
}

function hasAnyMarker(text: string, markers: string[]): boolean {
	return markers.some((marker) => text.includes(marker));
}

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

function subtractKeyedCounts<T extends string>(
	baseline: Partial<Record<T, number>>,
	candidate: Partial<Record<T, number>>,
): Record<T, number> {
	const keys = new Set<T>([...(Object.keys(baseline) as T[]), ...(Object.keys(candidate) as T[])]);
	const result = {} as Record<T, number>;
	for (const key of keys) {
		result[key] = Number(candidate[key] ?? 0) - Number(baseline[key] ?? 0);
	}
	return result;
}

function subtractBurden(
	baseline: MemoryRoleProbeResult["top_burden"] | null,
	candidate: MemoryRoleProbeResult["top_burden"] | null,
): MemoryRoleProbeResult["top_burden"] | null {
	if (!baseline || !candidate) return null;
	return {
		recap_share: candidate.recap_share - baseline.recap_share,
		unmapped_share: candidate.unmapped_share - baseline.unmapped_share,
		recap_unmapped_share: candidate.recap_unmapped_share - baseline.recap_unmapped_share,
	};
}

function compareProbeResults(
	baseline: MemoryRoleProbeResult[],
	candidate: MemoryRoleProbeResult[],
): MemoryRoleProbeComparison[] {
	const byQuery = new Map<
		string,
		{ baseline?: MemoryRoleProbeResult; candidate?: MemoryRoleProbeResult }
	>();
	for (const probe of baseline) {
		byQuery.set(probe.query, { ...(byQuery.get(probe.query) ?? {}), baseline: probe });
	}
	for (const probe of candidate) {
		byQuery.set(probe.query, { ...(byQuery.get(probe.query) ?? {}), candidate: probe });
	}
	return [...byQuery.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([query, value]) => {
			const baselineProbe = value.baseline;
			const candidateProbe = value.candidate;
			const baselineIds = baselineProbe?.item_ids ?? [];
			const candidateIds = candidateProbe?.item_ids ?? [];
			const baselineKeys = baselineProbe?.items.map((item) => item.stable_key) ?? [];
			const candidateKeySet = new Set(candidateProbe?.items.map((item) => item.stable_key) ?? []);
			const sharedItemKeys = baselineKeys.filter((key) => candidateKeySet.has(key));
			return {
				query,
				baseline_scenario_id: baselineProbe?.scenario_id,
				candidate_scenario_id: candidateProbe?.scenario_id,
				baseline_scenario_title: baselineProbe?.scenario_title,
				candidate_scenario_title: candidateProbe?.scenario_title,
				baseline_scenario_category: baselineProbe?.scenario_category,
				candidate_scenario_category: candidateProbe?.scenario_category,
				baseline_mode: baselineProbe?.mode ?? null,
				candidate_mode: candidateProbe?.mode ?? null,
				baseline_item_ids: baselineIds,
				candidate_item_ids: candidateIds,
				shared_item_keys: sharedItemKeys,
				baseline_top_burden: baselineProbe?.top_burden ?? null,
				candidate_top_burden: candidateProbe?.top_burden ?? null,
				delta_top_burden: subtractBurden(
					baselineProbe?.top_burden ?? null,
					candidateProbe?.top_burden ?? null,
				),
				baseline_top_mapping_counts: baselineProbe?.top_mapping_counts ?? null,
				candidate_top_mapping_counts: candidateProbe?.top_mapping_counts ?? null,
				delta_top_mapping_counts:
					baselineProbe && candidateProbe
						? subtractKeyedCounts(
								baselineProbe.top_mapping_counts,
								candidateProbe.top_mapping_counts,
							)
						: null,
				baseline_scenario_score: baselineProbe?.scenario_score,
				candidate_scenario_score: candidateProbe?.scenario_score,
				delta_scenario_score:
					baselineProbe?.scenario_score && candidateProbe?.scenario_score
						? {
								mode_match:
									Number(candidateProbe.scenario_score.mode_match) -
									Number(baselineProbe.scenario_score.mode_match),
								primary_in_top1:
									Number(candidateProbe.scenario_score.primary_in_top1) -
									Number(baselineProbe.scenario_score.primary_in_top1),
								primary_in_top3_count:
									candidateProbe.scenario_score.primary_in_top3_count -
									baselineProbe.scenario_score.primary_in_top3_count,
								anti_signal_in_top1:
									Number(candidateProbe.scenario_score.anti_signal_in_top1) -
									Number(baselineProbe.scenario_score.anti_signal_in_top1),
								primary_match_count:
									candidateProbe.scenario_score.primary_match_count -
									baselineProbe.scenario_score.primary_match_count,
								anti_signal_count:
									candidateProbe.scenario_score.anti_signal_count -
									baselineProbe.scenario_score.anti_signal_count,
								recap_count:
									candidateProbe.scenario_score.recap_count -
									baselineProbe.scenario_score.recap_count,
								unmapped_recap_count:
									candidateProbe.scenario_score.unmapped_recap_count -
									baselineProbe.scenario_score.unmapped_recap_count,
								administrative_chatter_count:
									candidateProbe.scenario_score.administrative_chatter_count -
									baselineProbe.scenario_score.administrative_chatter_count,
								score: candidateProbe.scenario_score.score - baselineProbe.scenario_score.score,
							}
						: undefined,
			};
		});
}

function scoreProbeScenario(
	items: MemoryRoleProbeItem[],
	query: string,
	mode: string,
): MemoryRoleProbeResult["scenario_score"] | undefined {
	const scenario = getInjectionEvalScenarioByPrompt(query);
	if (!scenario) return undefined;
	const topItems = items.slice(0, 5);
	const topThree = items.slice(0, 3);
	const matchToken = (text: string, token: string): boolean => text.includes(token.toLowerCase());
	const itemMatchesPrimary = (item: MemoryRoleProbeItem): boolean => {
		const haystack = [
			item.kind,
			item.role,
			item.title,
			item.role_reason,
			item.session_class,
			item.summary_disposition,
		]
			.join(" ")
			.toLowerCase();
		return scenario.expectedPrimary.some((token) => matchToken(haystack, token));
	};
	const itemMatchesAntiSignal = (item: MemoryRoleProbeItem): boolean => {
		const genericRecap = item.role === "recap" && item.session_class === "micro_low_value";
		const unmappedRecap = item.role === "recap" && item.mapping === "unmapped";
		const wrongThreadSummary = item.role === "recap" && item.summary_disposition === "unknown";
		const administrativeChatter =
			item.role === "ephemeral" &&
			item.kind !== "decision" &&
			item.kind !== "bugfix" &&
			item.kind !== "discovery";
		const explicitRecapBias = item.role === "recap" && topItems[0]?.id === item.id;
		const summaryFirstSludge = item.role === "recap" && item.kind === "session_summary";
		const missingSummaryIntent =
			scenario.expectedPrimary.includes("session_summary") && item.role !== "recap";
		const topicOnlyRefusal = scenario.expectedPrimary.includes("recap") && item.role !== "recap";
		const totallySummaryFreeOutput =
			scenario.expectedPrimary.includes("session_summary") &&
			!topItems.some((candidate) => candidate.role === "recap");
		if (scenario.expectedAntiSignals.includes("generic recap sludge") && genericRecap) return true;
		if (scenario.expectedAntiSignals.includes("recap takeover") && item.role === "recap")
			return true;
		if (scenario.expectedAntiSignals.includes("unmapped recap") && unmappedRecap) return true;
		if (scenario.expectedAntiSignals.includes("wrong-thread summary") && wrongThreadSummary)
			return true;
		if (scenario.expectedAntiSignals.includes("wrong-thread latest summary") && wrongThreadSummary)
			return true;
		if (scenario.expectedAntiSignals.includes("recap-only output") && item.role === "recap")
			return true;
		if (scenario.expectedAntiSignals.includes("generic summary") && item.role === "recap")
			return true;
		if (scenario.expectedAntiSignals.includes("explicit recap bias") && explicitRecapBias)
			return true;
		if (scenario.expectedAntiSignals.includes("summary-first sludge") && summaryFirstSludge)
			return true;
		if (scenario.expectedAntiSignals.includes("missing summary intent") && missingSummaryIntent)
			return true;
		if (scenario.expectedAntiSignals.includes("topic-only refusal") && topicOnlyRefusal)
			return true;
		if (
			scenario.expectedAntiSignals.includes("totally summary-free output") &&
			totallySummaryFreeOutput
		)
			return true;
		if (scenario.expectedAntiSignals.includes("administrative chatter") && administrativeChatter)
			return true;
		return false;
	};
	const primaryMatchCount = topItems.filter((item) => {
		return itemMatchesPrimary(item);
	}).length;
	const antiSignalCount = topItems.filter((item) => itemMatchesAntiSignal(item)).length;
	const expectedModes = scenario.expectedModes ?? [];
	const modeMatch = expectedModes.length === 0 || expectedModes.includes(mode);
	const primaryInTop1 =
		topItems.length > 0 ? itemMatchesPrimary(topItems[0] as MemoryRoleProbeItem) : false;
	const primaryInTop3Count = topThree.filter((item) => itemMatchesPrimary(item)).length;
	const antiSignalInTop1 =
		topItems.length > 0 ? itemMatchesAntiSignal(topItems[0] as MemoryRoleProbeItem) : false;
	const recapCount = topItems.filter((item) => item.role === "recap").length;
	const unmappedRecapCount = topItems.filter(
		(item) => item.role === "recap" && item.mapping === "unmapped",
	).length;
	const administrativeChatterCount = topItems.filter(
		(item) =>
			item.role === "ephemeral" &&
			item.kind !== "decision" &&
			item.kind !== "bugfix" &&
			item.kind !== "discovery",
	).length;
	return {
		mode_match: modeMatch,
		primary_in_top1: primaryInTop1,
		primary_in_top3_count: primaryInTop3Count,
		anti_signal_in_top1: antiSignalInTop1,
		primary_match_count: primaryMatchCount,
		anti_signal_count: antiSignalCount,
		recap_count: recapCount,
		unmapped_recap_count: unmappedRecapCount,
		administrative_chatter_count: administrativeChatterCount,
		score:
			primaryMatchCount -
			antiSignalCount +
			(modeMatch ? 1 : 0) +
			(primaryInTop1 ? 1 : 0) -
			(antiSignalInTop1 ? 1 : 0),
	};
}

function stableProbeItemKey(input: {
	import_key?: string | null;
	kind: string;
	title: string;
	body_text: string;
}): string {
	const importKey = input.import_key?.trim();
	if (importKey) return `import:${importKey}`;
	return `fallback:${input.kind}\u241f${input.title}\u241f${input.body_text}`;
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
	const isSummary = isSummaryLikeMemory({ kind: row.kind, metadata });
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
							? inferMemoryRole(source)
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

// ---------------------------------------------------------------------------
// Retroactive near-duplicate deactivation
// ---------------------------------------------------------------------------

export interface DedupNearDuplicatesResult {
	checked: number;
	deactivated: number;
	pairs: Array<{ kept_id: number; deactivated_id: number; title: string }>;
}

export interface DedupNearDuplicatesOptions {
	/** Max time gap in milliseconds between duplicate candidates (default: 1 hour). */
	windowMs?: number;
	limit?: number | null;
	dryRun?: boolean;
}

/**
 * Find and deactivate near-duplicate memories: cross-session pairs with
 * identical normalized titles created within a configurable time window.
 *
 * Keeps the higher-confidence member (ties: most recent). Does not delete
 * rows — only sets `active = 0`.
 */
export function dedupNearDuplicateMemories(
	db: Database,
	opts: DedupNearDuplicatesOptions = {},
): DedupNearDuplicatesResult {
	const windowMs = opts.windowMs ?? 3_600_000; // 1 hour
	const windowSeconds = windowMs / 1000;
	const limitClause = opts.limit != null && opts.limit > 0 ? `LIMIT ${Number(opts.limit)}` : "";

	// Find cross-session pairs with identical normalized titles within the time window.
	// Self-join ordered so a.id < b.id to avoid duplicate pair reporting.
	const pairRows = db
		.prepare(
			`SELECT
				a.id AS id_a, a.session_id AS session_a, a.confidence AS conf_a, a.created_at AS created_a,
				b.id AS id_b, b.session_id AS session_b, b.confidence AS conf_b, b.created_at AS created_b,
				a.title AS title
			 FROM memory_items a
			 JOIN memory_items b
			   ON LOWER(TRIM(a.title)) = LOWER(TRIM(b.title))
			   AND a.id < b.id
			   AND a.session_id != b.session_id
			   AND a.active = 1
			   AND b.active = 1
			   AND ABS(JULIANDAY(a.created_at) - JULIANDAY(b.created_at)) * 86400 <= ?
			 ORDER BY a.created_at DESC
			 ${limitClause}`,
		)
		.all(windowSeconds) as Array<{
		id_a: number;
		session_a: number;
		conf_a: number;
		created_a: string;
		id_b: number;
		session_b: number;
		conf_b: number;
		created_b: string;
		title: string;
	}>;

	const checked = pairRows.length;
	const toDeactivate: number[] = [];
	const pairs: DedupNearDuplicatesResult["pairs"] = [];

	for (const row of pairRows) {
		// Keep higher confidence; on tie, keep the more recent one.
		let keepId: number;
		let dropId: number;
		if (row.conf_a > row.conf_b) {
			keepId = row.id_a;
			dropId = row.id_b;
		} else if (row.conf_b > row.conf_a) {
			keepId = row.id_b;
			dropId = row.id_a;
		} else {
			// Equal confidence — keep the more recent one
			keepId = row.created_a > row.created_b ? row.id_a : row.id_b;
			dropId = keepId === row.id_a ? row.id_b : row.id_a;
		}
		if (!toDeactivate.includes(dropId)) {
			toDeactivate.push(dropId);
			pairs.push({ kept_id: keepId, deactivated_id: dropId, title: row.title });
		}
	}

	if (toDeactivate.length === 0 || opts.dryRun === true) {
		return { checked, deactivated: toDeactivate.length, pairs };
	}

	const now = new Date().toISOString();
	const chunkSize = 200;
	for (let start = 0; start < toDeactivate.length; start += chunkSize) {
		const chunk = toDeactivate.slice(start, start + chunkSize);
		const placeholders = chunk.map(() => "?").join(",");
		db.prepare(
			`UPDATE memory_items SET active = 0, updated_at = ? WHERE id IN (${placeholders})`,
		).run(now, ...chunk);
	}

	return { checked, deactivated: toDeactivate.length, pairs };
}

// ---------------------------------------------------------------------------
// Heuristic narrative extraction from session_summary body_text
// ---------------------------------------------------------------------------

export interface BackfillNarrativeResult {
	checked: number;
	updated: number;
	skipped: number;
}

export interface BackfillNarrativeOptions {
	limit?: number | null;
	dryRun?: boolean;
}

export interface BackfillDedupKeysResult {
	checked: number;
	updated: number;
	skipped: number;
}

export interface BackfillDedupKeysPlan extends BackfillDedupKeysResult {
	backfillable: number;
	updates: Array<{ id: number; dedupKey: string }>;
	lastScannedId: number;
	exhausted: boolean;
}

export interface BackfillDedupKeysOptions {
	limit?: number | null;
	dryRun?: boolean;
}

interface BackfillDedupKeysPlanOptions {
	rowLimit?: number | null;
	updateLimit?: number | null;
	afterId?: number | null;
}

type DedupKeyCandidateRow = {
	id: number;
	title: string;
	session_id: number;
	kind: string;
	visibility: string | null;
	workspace_id: string | null;
	active: number;
};

/**
 * Extract a narrative from the structured `## Completed` / `## Learned`
 * sections found in session_summary body_text. Returns null if the body
 * doesn't match the expected structure.
 */
export function extractNarrativeFromBody(bodyText: string): string | null {
	// Match sections like "## Completed\n...\n\n## Learned\n..."
	const sections: string[] = [];

	const completedMatch = bodyText.match(/##\s*Completed\s*\n([\s\S]*?)(?=\n##\s|\n*$)/);
	if (completedMatch?.[1]?.trim()) {
		sections.push(completedMatch[1].trim());
	}

	const learnedMatch = bodyText.match(/##\s*Learned\s*\n([\s\S]*?)(?=\n##\s|\n*$)/);
	if (learnedMatch?.[1]?.trim()) {
		sections.push(learnedMatch[1].trim());
	}

	if (sections.length === 0) return null;
	return sections.join("\n\n");
}

/**
 * Backfill narrative for session_summary memories that have structured
 * body_text with `## Completed` / `## Learned` sections but no narrative.
 *
 * Only touches session_summary kind. Does not overwrite existing narratives.
 */
export function backfillNarrativeFromBody(
	db: Database,
	opts: BackfillNarrativeOptions = {},
): BackfillNarrativeResult {
	const limitClause = opts.limit != null && opts.limit > 0 ? `LIMIT ${Number(opts.limit)}` : "";

	const rows = db
		.prepare(
			`SELECT id, body_text
			 FROM memory_items
			 WHERE kind = 'session_summary'
			   AND active = 1
			   AND (narrative IS NULL OR LENGTH(narrative) = 0)
			   AND body_text IS NOT NULL
			   AND LENGTH(body_text) > 0
			 ORDER BY created_at ASC
			 ${limitClause}`,
		)
		.all() as Array<{ id: number; body_text: string }>;

	let checked = 0;
	let updated = 0;
	let skipped = 0;
	const updates: Array<{ id: number; narrative: string }> = [];

	for (const row of rows) {
		checked++;
		const narrative = extractNarrativeFromBody(row.body_text);
		if (!narrative) {
			skipped++;
			continue;
		}
		updates.push({ id: row.id, narrative });
		updated++;
	}

	if (updates.length > 0 && opts.dryRun !== true) {
		const now = new Date().toISOString();
		const updateStmt = db.prepare(
			"UPDATE memory_items SET narrative = ?, updated_at = ? WHERE id = ?",
		);
		db.transaction(() => {
			for (const update of updates) {
				updateStmt.run(update.narrative, now, update.id);
			}
		})();
	}

	return { checked, updated, skipped };
}

function selectDedupKeyCandidateRows(
	db: Database,
	options: { rowLimit: number | null | undefined; afterId: number | null | undefined },
): DedupKeyCandidateRow[] {
	const limitClause =
		options.rowLimit != null && options.rowLimit > 0 ? `LIMIT ${Number(options.rowLimit)}` : "";
	const afterId = options.afterId != null && options.afterId > 0 ? options.afterId : 0;
	return db
		.prepare(
			`SELECT id, title, session_id, kind, visibility, workspace_id, active
			 FROM memory_items
			 WHERE dedup_key IS NULL
			   AND id > ?
			 ORDER BY created_at ASC, id ASC
			 ${limitClause}`,
		)
		.all(afterId) as DedupKeyCandidateRow[];
}

function buildDedupActiveScopeKey(row: DedupKeyCandidateRow, dedupKey: string): string {
	return [row.session_id, row.kind, row.visibility ?? "", row.workspace_id ?? "", dedupKey].join(
		"\u001f",
	);
}

export function planMemoryDedupKeys(
	db: Database,
	options: BackfillDedupKeysPlanOptions = {},
): BackfillDedupKeysPlan {
	const rowLimit = options.rowLimit ?? null;
	const rows = selectDedupKeyCandidateRows(db, {
		rowLimit,
		afterId: options.afterId ?? null,
	});
	const updateLimit =
		options.updateLimit != null && options.updateLimit > 0 ? options.updateLimit : null;

	let checked = 0;
	let updated = 0;
	let skipped = 0;
	let backfillable = 0;
	const updates: Array<{ id: number; dedupKey: string }> = [];
	const seenActiveScopes = new Set<string>();
	const hasActiveConflict = db.prepare(
		`SELECT 1 AS ok
		 FROM memory_items
		 WHERE id != ?
		   AND active = 1
		   AND session_id = ?
		   AND kind = ?
		   AND visibility IS ?
		   AND workspace_id IS ?
		   AND dedup_key = ?
		 LIMIT 1`,
	);

	for (const row of rows) {
		checked++;
		const dedupKey = buildMemoryDedupKey(row.title);
		if (!dedupKey) {
			skipped++;
			continue;
		}

		const activeScopeKey = buildDedupActiveScopeKey(row, dedupKey);
		if (
			row.active === 1 &&
			(seenActiveScopes.has(activeScopeKey) ||
				hasActiveConflict.get(
					row.id,
					row.session_id,
					row.kind,
					row.visibility,
					row.workspace_id,
					dedupKey,
				))
		) {
			skipped++;
			continue;
		}

		backfillable++;
		if (updateLimit == null || updates.length < updateLimit) {
			updates.push({ id: row.id, dedupKey });
		}
		if (row.active === 1) seenActiveScopes.add(activeScopeKey);
		updated++;
	}

	return {
		checked,
		updated,
		skipped,
		backfillable,
		updates,
		lastScannedId: rows.at(-1)?.id ?? options.afterId ?? 0,
		exhausted: rowLimit == null || rows.length < rowLimit,
	};
}

export function applyMemoryDedupKeyUpdates(
	db: Database,
	updates: Array<{ id: number; dedupKey: string }>,
): void {
	if (updates.length <= 0) return;
	const now = new Date().toISOString();
	const updateStmt = db.prepare(
		"UPDATE memory_items SET dedup_key = ?, updated_at = ? WHERE id = ?",
	);
	db.transaction(() => {
		for (const update of updates) {
			updateStmt.run(update.dedupKey, now, update.id);
		}
	})();
}

export function backfillMemoryDedupKeys(
	db: Database,
	opts: BackfillDedupKeysOptions = {},
): BackfillDedupKeysResult {
	const plan = planMemoryDedupKeys(db, { rowLimit: opts.limit ?? null });
	if (opts.dryRun !== true) {
		applyMemoryDedupKeyUpdates(db, plan.updates);
	}
	return { checked: plan.checked, updated: plan.updated, skipped: plan.skipped };
}

// ---------------------------------------------------------------------------
// AI structured-content backfill
// ---------------------------------------------------------------------------

const AI_BACKFILL_KINDS = [
	"change",
	"discovery",
	"bugfix",
	"feature",
	"decision",
	"exploration",
	"refactor",
] as const;

const AI_BACKFILL_CONCEPTS = [
	"how-it-works",
	"why-it-exists",
	"what-changed",
	"problem-solution",
	"gotcha",
	"pattern",
	"trade-off",
] as const;
const AI_BACKFILL_CONCEPT_SET = new Set<string>(AI_BACKFILL_CONCEPTS);

const AI_BACKFILL_JOB_KIND = "ai_structured_backfill";
const AI_BACKFILL_SCHEMA_NAME = "codemem_structured_memory_backfill";
const AI_BACKFILL_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	properties: {
		narrative: { type: ["string", "null"] },
		facts: { type: "array", items: { type: "string" } },
		concepts: { type: "array", items: { type: "string", enum: [...AI_BACKFILL_CONCEPTS] } },
	},
	required: ["narrative", "facts", "concepts"],
};

type StructuredBackfillObserver = Pick<
	ObserverClient,
	"observe" | "observeStructuredJson" | "getStatus"
>;

export interface AIBackfillStructuredContentResult {
	checked: number;
	updated: number;
	skipped: number;
	failed: number;
	samples?: Array<{
		id: number;
		kind: string;
		title: string;
		narrative: string | null;
		facts: string[];
		concepts: string[];
	}>;
}

export interface AIBackfillStructuredContentOptions {
	limit?: number | null;
	kinds?: string[] | null;
	dryRun?: boolean;
	overwrite?: boolean;
	observer?: StructuredBackfillObserver;
}

interface ParsedStructuredBackfill {
	narrative: string | null;
	facts: string[];
	concepts: string[];
}

type StructuredBackfillRow = {
	id: number;
	kind: string;
	title: string;
	body_text: string;
	metadata_json: string | null;
	narrative: string | null;
	facts: string | null;
	concepts: string | null;
};

function createStructuredBackfillObserver(): StructuredBackfillObserver {
	const base = loadObserverConfig();
	return new ObserverClient({
		...base,
		observerProvider: "openai",
		observerModel: "gpt-5.4",
		observerTemperature: 0.2,
		observerOpenAIUseResponses: true,
		observerReasoningEffort: null,
		observerReasoningSummary: null,
		observerMaxOutputTokens: 4000,
	});
}

function parseJsonArrayOfStrings(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.filter((item): item is string => typeof item === "string");
		}
	} catch {
		return [];
	}
	return [];
}

function hasCompleteStructuredContent(row: {
	narrative: string | null;
	facts: string | null;
	concepts: string | null;
}): boolean {
	return (
		!!row.narrative?.trim() &&
		parseJsonArrayOfStrings(row.facts).length > 0 &&
		parseJsonArrayOfStrings(row.concepts).length > 0
	);
}

function buildStructuredBackfillPrompt(row: {
	id: number;
	kind: string;
	title: string;
	body_text: string;
}): { system: string; user: string } {
	const system = `You are converting older codemem memories into structured fields.

<output_contract>
- Output only valid JSON with exactly this shape:
  {"narrative": string|null, "facts": string[], "concepts": string[]}
- Do not add markdown fences or prose.
- Use null / [] when evidence is missing.
</output_contract>

<field_rules>
- narrative: 2-6 complete sentences, or 1-2 short paragraphs made of complete sentences.
- narrative must end cleanly on a full sentence. Do not output a truncated clause.
- facts: 2-8 source-grounded, self-contained statements. Prefer concrete details over generic purpose statements.
- concepts: 2-5 values from this exact list only:
  ["how-it-works", "why-it-exists", "what-changed", "problem-solution", "gotcha", "pattern", "trade-off"]
</field_rules>

<grounding_rules>
- Use ONLY the evidence in the provided title, kind, and body_text.
- Do not invent files, APIs, behavior, users, dates, or outcomes.
- If the source is vague, be specific only where the text is specific.
- If evidence is insufficient for a field, return null or [].
</grounding_rules>

<concept_rules>
- Use "gotcha" only when the source clearly describes a pitfall, surprise, failure mode, or caveat.
- Use "trade-off" only when the source clearly describes a comparison, compromise, or explicit design tension.
- Prefer fewer concepts over weak concepts.
</concept_rules>

<verbosity_controls>
- Keep the narrative concise and information-dense.
- Avoid repetition between narrative and facts.
</verbosity_controls>

<verification_loop>
- Before finalizing, verify: valid JSON, complete sentences in narrative, concepts only from the allowed list, and every claim grounded in the source.
</verification_loop>`;

	const user = `Memory ID: ${row.id}
Kind: ${row.kind}
Title: ${row.title}

Body text:
${row.body_text}`;

	return { system, user };
}

function sanitizeNarrative(value: string | null): string | null {
	if (!value) return null;
	let text = value.trim();
	text = text.replace(/^\[+/, "").replace(/\]+$/, "").trim();
	if (!text) return null;

	// If the model trails off without sentence punctuation, trim to the last
	// complete sentence if possible. Otherwise reject it as likely truncated.
	if (!/[.!?]["')\]]?\s*$/.test(text)) {
		const lastSentenceEnd = Math.max(
			text.lastIndexOf("."),
			text.lastIndexOf("!"),
			text.lastIndexOf("?"),
		);
		if (lastSentenceEnd >= 20) {
			const before = text;
			text = text.slice(0, lastSentenceEnd + 1).trim();
			console.warn(
				`[codemem] sanitizeNarrative trimmed: "${before.slice(-30)}" → "${text.slice(-30)}"`,
			);
		} else {
			console.warn(`[codemem] sanitizeNarrative rejected: "${text.slice(0, 50)}"`);
			return null;
		}
	}

	return text.length > 0 ? text : null;
}

function parseStructuredBackfillResponse(raw: string | null): ParsedStructuredBackfill {
	if (!raw) throw new Error("observer returned empty response");
	const trimmed = raw.trim();
	const cleaned = trimmed.startsWith("```")
		? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
		: trimmed;
	const parsed = JSON.parse(cleaned) as Record<string, unknown>;
	if (
		!Object.hasOwn(parsed, "narrative") ||
		!Object.hasOwn(parsed, "facts") ||
		!Object.hasOwn(parsed, "concepts")
	) {
		throw new Error("observer returned schema-invalid object");
	}
	if (
		!(typeof parsed.narrative === "string" || parsed.narrative === null) ||
		!Array.isArray(parsed.facts) ||
		!Array.isArray(parsed.concepts)
	) {
		throw new Error("observer returned schema-invalid field types");
	}
	const narrative =
		typeof parsed.narrative === "string" && parsed.narrative.trim()
			? sanitizeNarrative(parsed.narrative)
			: null;
	const facts = Array.isArray(parsed.facts)
		? parsed.facts.filter(
				(item): item is string => typeof item === "string" && item.trim().length > 0,
			)
		: [];
	const concepts = Array.isArray(parsed.concepts)
		? parsed.concepts
				.filter(
					(item): item is string =>
						typeof item === "string" &&
						item.trim().length > 0 &&
						AI_BACKFILL_CONCEPT_SET.has(item.trim().toLowerCase()),
				)
				.map((item) => item.trim().toLowerCase())
		: [];
	return { narrative, facts, concepts };
}

/**
 * AI-powered backfill for older non-session-summary memories that still lack
 * structured content (`narrative`, `facts`, `concepts`). Uses GPT-5.4 via the
 * existing ObserverClient/OpenAI integration.
 */
export async function aiBackfillStructuredContent(
	db: Database,
	opts: AIBackfillStructuredContentOptions = {},
): Promise<AIBackfillStructuredContentResult> {
	const kinds = opts.kinds?.length ? opts.kinds : [...AI_BACKFILL_KINDS];
	const placeholders = kinds.map(() => "?").join(",");
	const limitClause = opts.limit != null && opts.limit > 0 ? `LIMIT ${Number(opts.limit)}` : "";
	const structuredFilter = opts.overwrite
		? "1=1"
		: `(narrative IS NULL OR LENGTH(narrative) = 0 OR facts IS NULL OR LENGTH(facts) <= 2 OR concepts IS NULL OR LENGTH(concepts) <= 2)`;
	const rows = db
		.prepare(
			`SELECT id, kind, title, body_text, metadata_json, narrative, facts, concepts
			 FROM memory_items
			 WHERE active = 1
			   AND kind IN (${placeholders})
			   AND body_text IS NOT NULL
			   AND LENGTH(body_text) > 0
			   AND ${structuredFilter}
			 ORDER BY created_at ASC
			 ${limitClause}`,
		)
		.all(...kinds) as StructuredBackfillRow[];
	const eligibleRows = rows.filter(
		(row) => !isSummaryLikeMemory({ kind: row.kind, metadata: row.metadata_json }),
	);

	const observer = opts.observer ?? createStructuredBackfillObserver();
	const total = eligibleRows.length;
	startMaintenanceJob(db, {
		kind: AI_BACKFILL_JOB_KIND,
		title: "Backfilling structured content",
		message: `Preparing GPT-5.4 extraction for ${total} memories`,
		progressTotal: total,
		metadata: {
			model: observer.getStatus().model,
			provider: observer.getStatus().provider,
			kinds,
			overwrite: opts.overwrite === true,
		},
	});

	let checked = 0;
	let updated = 0;
	let skipped = 0;
	let failed = 0;
	const samples: NonNullable<AIBackfillStructuredContentResult["samples"]> = [];
	const updateStmt = db.prepare(
		"UPDATE memory_items SET narrative = ?, facts = ?, concepts = ?, updated_at = ? WHERE id = ?",
	);

	try {
		for (const row of eligibleRows) {
			checked++;
			if (!opts.overwrite && hasCompleteStructuredContent(row)) {
				skipped++;
				updateMaintenanceJob(db, AI_BACKFILL_JOB_KIND, {
					message: `Skipped ${skipped} already-structured memories`,
					progressCurrent: checked,
					progressTotal: total,
				});
				continue;
			}

			try {
				const prompt = buildStructuredBackfillPrompt(row);
				const response = await observer.observeStructuredJson(
					prompt.system,
					prompt.user,
					AI_BACKFILL_SCHEMA_NAME,
					AI_BACKFILL_SCHEMA,
				);
				const parsed =
					response.usedStructuredOutputs && response.parsed
						? parseStructuredBackfillResponse(JSON.stringify(response.parsed))
						: parseStructuredBackfillResponse(response.raw);

				const nextNarrative =
					row.narrative?.trim() && !opts.overwrite ? row.narrative : parsed.narrative;
				const existingFacts = parseJsonArrayOfStrings(row.facts);
				const nextFacts =
					existingFacts.length > 0 && !opts.overwrite ? existingFacts : parsed.facts;
				const existingConcepts = parseJsonArrayOfStrings(row.concepts);
				const nextConcepts =
					existingConcepts.length > 0 && !opts.overwrite ? existingConcepts : parsed.concepts;

				const changed =
					(nextNarrative ?? null) !== (row.narrative ?? null) ||
					JSON.stringify(nextFacts) !== JSON.stringify(existingFacts) ||
					JSON.stringify(nextConcepts) !== JSON.stringify(existingConcepts);

				if (!changed) {
					skipped++;
				} else {
					if (opts.dryRun && samples.length < 10) {
						samples.push({
							id: row.id,
							kind: row.kind,
							title: row.title,
							narrative: nextNarrative,
							facts: nextFacts,
							concepts: nextConcepts,
						});
					}
					if (!opts.dryRun) {
						updateStmt.run(
							nextNarrative,
							JSON.stringify(nextFacts),
							JSON.stringify(nextConcepts),
							new Date().toISOString(),
							row.id,
						);
					}
					updated++;
				}
			} catch {
				failed++;
			}

			updateMaintenanceJob(db, AI_BACKFILL_JOB_KIND, {
				message: `Processed ${checked} of ${total} memories`,
				progressCurrent: checked,
				progressTotal: total,
				metadata: {
					model: observer.getStatus().model,
					provider: observer.getStatus().provider,
					kinds,
					overwrite: opts.overwrite === true,
					updated,
					skipped,
					failed,
				},
			});
		}

		completeMaintenanceJob(db, AI_BACKFILL_JOB_KIND, {
			message: `Processed ${checked} memories: ${updated} updated, ${skipped} skipped, ${failed} failed`,
			progressCurrent: checked,
			progressTotal: total,
			metadata: {
				model: observer.getStatus().model,
				provider: observer.getStatus().provider,
				kinds,
				overwrite: opts.overwrite === true,
				updated,
				skipped,
				failed,
			},
		});
	} catch (error) {
		failMaintenanceJob(
			db,
			AI_BACKFILL_JOB_KIND,
			error instanceof Error ? error.message : String(error),
			{
				message: `Failed after ${checked} memories`,
				progressCurrent: checked,
				progressTotal: total,
			},
		);
		throw error;
	}

	return { checked, updated, skipped, failed, ...(opts.dryRun ? { samples } : {}) };
}
