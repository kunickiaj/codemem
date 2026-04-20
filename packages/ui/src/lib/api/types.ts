/* Shared shapes for the viewer API wrappers. The pack-trace types in
 * particular are long and shared between the pack-trace fetch and the
 * renderers in the Inspector, so keeping them colocated in a dedicated
 * module avoids cluttering the per-domain request files. */

export interface PaginatedResponse<T = unknown> {
	items: T[];
	pagination?: {
		has_more?: boolean;
		next_offset?: number;
	};
}

export interface CoordinatorInviteResult {
	encoded?: string;
	warnings?: string[];
	[key: string]: unknown;
}

export interface ImportInviteResult {
	status?: string;
	[key: string]: unknown;
}

export interface AcceptDiscoveredPeerResult {
	name?: string;
	[key: string]: unknown;
}

export interface SyncRunItem {
	peer_device_id: string;
	ok: boolean;
	error?: string;
	address?: string;
	opsIn: number;
	opsOut: number;
	addressErrors: Array<{ address: string; error: string }>;
}

export interface SyncRunResponse {
	items: SyncRunItem[];
}

export interface RuntimeInfo {
	version: string;
}

export interface PackTraceCandidate {
	id: number;
	rank: number;
	kind: string;
	title: string;
	preview: string;
	reasons: string[];
	disposition: "selected" | "dropped" | "deduped" | "trimmed";
	section: "summary" | "timeline" | "observations" | null;
	scores: {
		base_score: number | null;
		combined_score: number | null;
		recency: number;
		kind_bonus: number;
		quality_boost: number;
		working_set_overlap: number;
		query_path_overlap: number;
		personal_bias: number;
		shared_trust_penalty: number;
		recap_penalty: number;
		tasklike_penalty: number;
		text_overlap: number;
		tag_overlap: number;
	};
}

export interface PackTrace {
	version: 1;
	inputs: {
		query: string;
		sanitized_query?: string;
		project: string | null;
		working_set_files: string[];
		token_budget: number | null;
		limit: number;
	};
	mode: {
		selected: "default" | "task" | "recall";
		reasons: string[];
	};
	retrieval: {
		candidate_count: number;
		candidates: PackTraceCandidate[];
	};
	assembly: {
		deduped_ids: number[];
		collapsed_groups: Array<{
			kept: number;
			dropped: number[];
			support_count: number;
		}>;
		trimmed_ids: number[];
		trim_reasons: string[];
		sections: Record<"summary" | "timeline" | "observations", number[]>;
	};
	output: {
		estimated_tokens: number;
		truncated: boolean;
		section_counts: Record<"summary" | "timeline" | "observations", number>;
		pack_text: string;
	};
}
