import { describe, expect, it } from "vitest";
import {
	buildFeedCardViewModel,
	hiddenSearchMatch,
	preferredAvailableMode,
} from "./card-view-model";

describe("feed card view model", () => {
	it("builds the compact observation skim and all distinct modes", () => {
		const model = buildFeedCardViewModel({
			body_text: "Longer legacy detail.",
			facts: ["Retry storage is idempotent"],
			kind: "bugfix",
			narrative: "Longer narrative explaining the retry behavior.",
			subtitle: "Retries reuse the existing record",
			title: "Reject duplicate commands",
		});

		expect(model.skimSummary).toBe("Retries reuse the existing record");
		expect(model.modes.map(({ id }) => id)).toEqual(["summary", "facts", "narrative"]);
	});

	it("uses session outcomes before request and removes a duplicate request from facts", () => {
		const model = buildFeedCardViewModel({
			kind: "session_summary",
			narrative: "The session delivered retry-safe watering without duplicate commands.",
			summary: {
				request: "Add retry-safe watering",
				completed: "Completed idempotency storage and retry tests",
				learned: "Retries can arrive after the first response",
			},
			title: "Stored session title",
		});

		expect(model.displayTitle).toBe("Add retry-safe watering");
		expect(model.skimSummary).toBe("Completed idempotency storage and retry tests");
		expect(model.modes.map(({ id }) => id)).toEqual(["summary", "facts", "narrative"]);
		const facts = model.modes.find(({ id }) => id === "facts");
		expect(facts?.searchText).not.toContain("Add retry-safe watering");
		expect(facts?.searchText).toContain("Retries can arrive");
	});

	it("keeps legacy body text as summary detail without inventing unavailable modes", () => {
		const model = buildFeedCardViewModel({
			body_text: "Legacy detail remains readable",
			kind: "discovery",
			title: "Legacy record",
		});

		expect(model.skimSummary).toBe("Legacy detail remains readable");
		expect(model.modes.map(({ id }) => id)).toEqual(["summary", "facts"]);
	});

	it("falls back by Summary, Facts, Narrative without changing the preferred value", () => {
		const model = buildFeedCardViewModel({
			body_text: "Legacy detail remains readable",
			title: "Legacy",
		});
		expect(preferredAvailableMode(model.modes, "narrative")).toBe("summary");
	});

	it("explains a search match found only in hidden detail", () => {
		const model = buildFeedCardViewModel({
			facts: ["The hidden coordinator token matches here"],
			subtitle: "Visible skim",
			title: "Searchable memory",
		});

		expect(hiddenSearchMatch(model, "coordinator")).toMatchObject({ mode: "facts" });
		expect(hiddenSearchMatch(model, "Visible")).toBeNull();
	});
});
