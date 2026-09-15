import { beforeEach, describe, expect, it } from "vitest";
import { state } from "../../../lib/state";
import type { FeedItem } from "../types";
import { computeSignature } from "./filter";

const feedItem: FeedItem = {
	id: 1,
	kind: "discovery",
	title: "Ownership changed",
	created_at: "2026-09-15T00:00:00Z",
	actor_id: "actor-old",
};

beforeEach(() => {
	state.currentProject = "";
	state.feedQuery = "";
	state.feedScopeFilter = "all";
	state.feedTypeFilter = "all";
	state.viewerActorId = "actor-new";
});

describe("computeSignature", () => {
	it("changes when refreshed ownership fields replace stale values", () => {
		const staleSignature = computeSignature([{ ...feedItem, owned_by_self: true }]);
		const refreshedSignature = computeSignature([{ ...feedItem, owned_by_self: false }]);

		expect(refreshedSignature).not.toBe(staleSignature);
	});

	it("changes when viewer identity affects ownership fallback", () => {
		const previousIdentitySignature = computeSignature([feedItem]);
		state.viewerActorId = "actor-old";

		expect(computeSignature([feedItem])).not.toBe(previousIdentitySignature);
	});
});
