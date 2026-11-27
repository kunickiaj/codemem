import { describe, expect, it } from "vitest";
import type { PackArtifacts } from "./pack.js";
import { packArtifactMemoryIds } from "./pack-memory-ids.js";

/** A pack with a different memory ID in every place a pack can name a memory. */
function packNamingMemoriesEverywhere(): PackArtifacts {
	return {
		response: {
			context: "query",
			items: [{ id: 1, title: "Item", duplicate_ids: [2], compressed_ids: [3] }],
			item_ids: [4],
			pack_text: "text",
			rendered_items: [{ id: 5, fingerprint: "f", spans: [] }],
			metrics: {
				pack_item_ids: [6],
				added_ids: [7],
				removed_ids: [8],
				retained_ids: [9],
				pack_tokens: 10,
			},
		},
		trace: {
			version: 1,
			inputs: { query: "query", limit: 10 },
			retrieval: { candidate_count: 1, candidates: [{ id: 10, rank: 1, title: "Candidate" }] },
			assembly: {
				deduped_ids: [11],
				collapsed_groups: [{ kept: 12, dropped: [13], support_count: 2 }],
				compressed_clusters: [
					{
						representative_id: 14,
						compressed_ids: [15],
						overlap_words: [],
						pattern: "related_work",
					},
				],
				trimmed_ids: [16],
				trim_reasons: [],
				sections: { summary: [17], timeline: [18], observations: [19] },
			},
			output: { estimated_tokens: 10, truncated: false, pack_text: "text" },
		},
	} as unknown as PackArtifacts;
}

describe("packArtifactMemoryIds", () => {
	it("lists the memory in every field that can name one", () => {
		const ids = packArtifactMemoryIds(packNamingMemoriesEverywhere());

		expect(ids?.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
	});

	it("lists a memory once however often the pack names it", () => {
		const pack = packNamingMemoriesEverywhere();
		pack.response.item_ids = [1, 1, 2];
		pack.response.metrics.removed_ids = [2];

		expect(packArtifactMemoryIds(pack)?.filter((id) => id === 1 || id === 2)).toEqual([1, 2]);
	});

	it.each([
		["the response", (pack: PackArtifacts) => Object.assign(pack.response, { related_ids: [99] })],
		[
			"the metrics",
			(pack: PackArtifacts) => Object.assign(pack.response.metrics, { pinned_ids: [99] }),
		],
		[
			"an item",
			(pack: PackArtifacts) => Object.assign(pack.response.items[0] ?? {}, { parent_id: 99 }),
		],
		["the trace", (pack: PackArtifacts) => Object.assign(pack.trace, { followups: [99] })],
		[
			"the assembly",
			(pack: PackArtifacts) => Object.assign(pack.trace.assembly, { demoted_ids: [99] }),
		],
		["the artifact", (pack: PackArtifacts) => Object.assign(pack, { extra: { ids: [99] } })],
	])("has no inventory for a pack with a field it does not know in %s", (_where, addField) => {
		const pack = packNamingMemoriesEverywhere();
		addField(pack);

		expect(packArtifactMemoryIds(pack)).toBeNull();
	});

	it.each([
		["a string", "7"],
		["zero", 0],
		["a fraction", 1.5],
		["null", null],
	])("has no inventory when %s stands where a memory ID belongs", (_what, value) => {
		const pack = packNamingMemoriesEverywhere();
		(pack.response.metrics.removed_ids as unknown[]).push(value);

		expect(packArtifactMemoryIds(pack)).toBeNull();
	});

	it("has no inventory when a list of IDs is not a list", () => {
		const pack = packNamingMemoriesEverywhere();
		Object.assign(pack.response.metrics, { removed_ids: { 0: 8 } });

		expect(packArtifactMemoryIds(pack)).toBeNull();
	});
});
