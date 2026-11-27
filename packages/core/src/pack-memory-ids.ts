/**
 * Every memory a pack names.
 *
 * A pack may only be delivered when its reader can see each memory it names, so the list
 * must be complete. Each type that makes up a pack has a table here with one entry per
 * field: how to read the memory IDs the field holds, or `"none"`. The tables are checked
 * against the types, so a field added to a pack without an entry does not compile. An
 * artifact that carries a field its table does not know, such as one built by other code,
 * has no inventory at all.
 */
import type { PackArtifacts } from "./pack.js";
import type {
	PackItem,
	PackResponse,
	PackTrace,
	PackTraceCandidate,
	RenderedPackItem,
} from "./types.js";

/** How one field holds memory IDs: not at all, or as read by the function. */
type IdsOf<Value> = "none" | ((value: NonNullable<Value>) => readonly unknown[]);

/** A decision for every field of `Shape`, optional fields included. */
type MemoryIdFields<Shape> = { [Field in keyof Shape]-?: IdsOf<Shape[Field]> };

class UnknownPackField extends Error {}

/** The IDs `value` holds according to `fields`. Throws when it has a field `fields` lacks. */
function idsIn<Shape extends object>(fields: MemoryIdFields<Shape>, value: Shape): unknown[] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new UnknownPackField();
	}
	const ids: unknown[] = [];
	for (const field of Object.keys(value) as Array<keyof Shape & string>) {
		if (!Object.hasOwn(fields, field)) throw new UnknownPackField();
		const read = fields[field];
		const held = value[field];
		if (read === "none" || held == null) continue;
		ids.push(...read(held as NonNullable<Shape[keyof Shape & string]>));
	}
	return ids;
}

function idsInEach<Shape extends object>(
	fields: MemoryIdFields<Shape>,
): (values: readonly Shape[]) => unknown[] {
	return (values) => {
		if (!Array.isArray(values)) throw new UnknownPackField();
		return values.flatMap((value) => idsIn(fields, value));
	};
}

const one = (id: unknown): unknown[] => [id];
const list = (ids: readonly unknown[]): readonly unknown[] => {
	if (!Array.isArray(ids)) throw new UnknownPackField();
	return ids;
};

const ITEM: MemoryIdFields<PackItem> = {
	id: one,
	kind: "none",
	title: "none",
	body: "none",
	confidence: "none",
	tags: "none",
	// The memory's own metadata. It describes the item and names no other memory.
	metadata: "none",
	support_count: "none",
	duplicate_ids: list,
	compressed_ids: list,
};

const RENDERED_ITEM: MemoryIdFields<RenderedPackItem> = {
	id: one,
	fingerprint: "none",
	spans: "none",
};

const METRICS: MemoryIdFields<PackResponse["metrics"]> = {
	total_items: "none",
	pack_tokens: "none",
	fallback_used: "none",
	fallback: "none",
	limit: "none",
	token_budget: "none",
	project: "none",
	pack_item_ids: list,
	mode: "none",
	added_ids: list,
	// Memories of the previous pack that this one leaves out.
	removed_ids: list,
	retained_ids: list,
	pack_token_delta: "none",
	pack_delta_available: "none",
	work_tokens: "none",
	work_tokens_unique: "none",
	tokens_saved: "none",
	compression_ratio: "none",
	overhead_tokens: "none",
	avoided_work_tokens: "none",
	avoided_work_saved: "none",
	avoided_work_ratio: "none",
	avoided_work_known_items: "none",
	avoided_work_unknown_items: "none",
	avoided_work_sources: "none",
	work_source: "none",
	work_usage_items: "none",
	work_estimate_items: "none",
	savings_reliable: "none",
	sources: "none",
};

const RESPONSE: MemoryIdFields<PackResponse> = {
	context: "none",
	items: idsInEach(ITEM),
	item_ids: list,
	pack_text: "none",
	rendered_items: idsInEach(RENDERED_ITEM),
	metrics: (metrics) => idsIn(METRICS, metrics),
};

const CANDIDATE: MemoryIdFields<PackTraceCandidate> = {
	id: one,
	rank: "none",
	kind: "none",
	title: "none",
	preview: "none",
	scores: "none",
	reasons: "none",
	disposition: "none",
	section: "none",
	artifact_class: "none",
	inferred_role: "none",
	role_reason: "none",
};

const RETRIEVAL: MemoryIdFields<PackTrace["retrieval"]> = {
	candidate_count: "none",
	candidates: idsInEach(CANDIDATE),
};

const COLLAPSED_GROUP: MemoryIdFields<PackTrace["assembly"]["collapsed_groups"][number]> = {
	kept: one,
	dropped: list,
	support_count: "none",
};

const COMPRESSED_CLUSTER: MemoryIdFields<PackTrace["assembly"]["compressed_clusters"][number]> = {
	representative_id: one,
	compressed_ids: list,
	overlap_words: "none",
	pattern: "none",
};

const SECTIONS: MemoryIdFields<PackTrace["assembly"]["sections"]> = {
	summary: list,
	timeline: list,
	observations: list,
};

const ASSEMBLY: MemoryIdFields<PackTrace["assembly"]> = {
	deduped_ids: list,
	collapsed_groups: idsInEach(COLLAPSED_GROUP),
	compressed_clusters: idsInEach(COMPRESSED_CLUSTER),
	trimmed_ids: list,
	trim_reasons: "none",
	sections: (sections) => idsIn(SECTIONS, sections),
};

const INPUTS: MemoryIdFields<PackTrace["inputs"]> = {
	query: "none",
	sanitized_query: "none",
	project: "none",
	working_set_files: "none",
	token_budget: "none",
	limit: "none",
};

const MODE: MemoryIdFields<PackTrace["mode"]> = {
	selected: "none",
	reasons: "none",
};

const OUTPUT: MemoryIdFields<PackTrace["output"]> = {
	estimated_tokens: "none",
	truncated: "none",
	section_counts: "none",
	// The rendered text of the items the response names.
	pack_text: "none",
};

const TRACE: MemoryIdFields<PackTrace> = {
	version: "none",
	inputs: (inputs) => idsIn(INPUTS, inputs),
	mode: (mode) => idsIn(MODE, mode),
	retrieval: (retrieval) => idsIn(RETRIEVAL, retrieval),
	assembly: (assembly) => idsIn(ASSEMBLY, assembly),
	output: (output) => idsIn(OUTPUT, output),
};

const ARTIFACTS: MemoryIdFields<PackArtifacts> = {
	response: (response) => idsIn(RESPONSE, response),
	trace: (trace) => idsIn(TRACE, trace),
};

/**
 * The ID of every memory the pack and its trace name, each once. Null when no complete list
 * can be given: the artifact has a field these tables do not know, or something that is not
 * a memory ID where one belongs. Such a pack must not be delivered on the strength of a
 * visibility check.
 */
export function packArtifactMemoryIds(artifacts: PackArtifacts): number[] | null {
	let ids: unknown[];
	try {
		ids = idsIn(ARTIFACTS, artifacts);
	} catch (error) {
		if (error instanceof UnknownPackField) return null;
		throw error;
	}
	const unique = new Set<number>();
	for (const id of ids) {
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
		unique.add(id);
	}
	return [...unique];
}
