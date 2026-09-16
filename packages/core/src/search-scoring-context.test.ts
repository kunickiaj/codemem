import { describe, expect, it } from "vitest";
import { rerankResults } from "./search.js";
import type { MemoryFilters, MemoryResult } from "./types.js";

const isOwned = (item: MemoryResult | Record<string, unknown>) => {
	const metadata = (item as MemoryResult).metadata as Record<string, unknown> | undefined;
	return metadata?.actor_id === "local:test-device";
};

const store = {
	db: {} as never,
	actorId: "local:test-device",
	deviceId: "test-device",
	get: () => null,
	recent: () => [],
	recentByKinds: () => [],
	memoryOwnedBySelf: isOwned,
	buildOwnershipPredicate: () => isOwned,
};

function result(id: number): MemoryResult {
	return {
		id,
		kind: "discovery",
		title: `Result ${id}`,
		body_text: "Body",
		confidence: 0.5,
		created_at: "2026-09-16T12:00:00.000Z",
		updated_at: "2026-09-16T12:00:00.000Z",
		tags_text: "",
		score: 1,
		session_id: id,
		metadata: { files_modified: ["packages/core/src/search.ts"] },
		narrative: null,
		facts: null,
	};
}

describe("search scoring preparation", () => {
	it("prepares query-derived inputs once for 200 candidates", () => {
		let workingSetReads = 0;
		const filters = {
			get working_set_paths() {
				workingSetReads += 1;
				return ["packages/core/src/search.ts"];
			},
		} as MemoryFilters;
		const candidates = Array.from({ length: 200 }, (_, index) => result(index + 1));

		rerankResults(store, candidates, candidates.length, filters, "fix packages/core/src/search.ts");

		expect(workingSetReads).toBe(1);
	});
});
