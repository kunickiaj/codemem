/* Maintenance module shared types.
 */

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
