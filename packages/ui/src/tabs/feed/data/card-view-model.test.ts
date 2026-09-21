import { describe, expect, it } from "vitest";
import { buildFeedCardViewModel, hiddenSearchMatch } from "./card-view-model";

describe("feed card view model", () => {
	it("composes structured content in pack order without rendering legacy body text", () => {
		const model = buildFeedCardViewModel({
			body_text: "Longer legacy detail.",
			facts: ["Retry storage is idempotent"],
			kind: "bugfix",
			narrative: "Longer narrative explaining the retry behavior.",
			subtitle: "Retries reuse the existing record",
			title: "Reject duplicate commands",
		});

		expect(model.content).toEqual({
			body: "",
			facts: ["Retry storage is idempotent"],
			narrative: "Longer narrative explaining the retry behavior.",
			searchText: "Longer narrative explaining the retry behavior.\nRetry storage is idempotent",
		});
		expect(model.searchOnlyText).toContain("Longer legacy detail.");
		expect(model.searchOnlyText).toContain("Retries reuse the existing record");
	});

	it("uses the stored title and structured fields for session summaries", () => {
		const model = buildFeedCardViewModel({
			facts: ["Retries can arrive after the first response"],
			kind: "session_summary",
			narrative: "The session delivered retry-safe watering without duplicate commands.",
			summary: {
				request: "Add retry-safe watering",
				completed: "Completed idempotency storage and retry tests",
				learned: "Retries can arrive after the first response",
			},
			title: "Stored session title",
		});

		expect(model.displayTitle).toBe("Stored session title");
		expect(model.content.narrative).toContain("retry-safe watering");
		expect(model.content.facts).toEqual(["Retries can arrive after the first response"]);
		expect(model.searchOnlyText).toContain("Add retry-safe watering");
		expect(model.searchOnlyText).toContain("Completed idempotency storage and retry tests");
	});

	it("falls back to body text only when structured fields are absent", () => {
		const model = buildFeedCardViewModel({
			body_text: "Legacy detail remains readable",
			kind: "discovery",
			title: "Legacy record",
		});

		expect(model.content).toEqual({
			body: "Legacy detail remains readable",
			facts: [],
			narrative: "",
			searchText: "Legacy detail remains readable",
		});
	});

	it("keeps only string facts, matching pack serialization", () => {
		const model = buildFeedCardViewModel({
			facts: ["Stored fact", 42, null],
			title: "Mixed facts",
		});
		expect(model.content.facts).toEqual(["Stored fact"]);
	});

	it("explains a search match found only in hidden detail", () => {
		const model = buildFeedCardViewModel({
			facts: ["The hidden coordinator token matches here"],
			subtitle: "Visible skim",
			title: "Searchable memory",
		});

		expect(hiddenSearchMatch(model, "coordinator")).toMatchObject({
			label: "Content",
		});
		expect(hiddenSearchMatch(model, "Visible")).toMatchObject({ label: "Body" });
	});

	it("explains a match found only in indexed legacy body text", () => {
		const model = buildFeedCardViewModel({
			body_text: "Legacy body contains the searchable orchard token",
			facts: ["Structured fact"],
			narrative: "Current narrative omits the legacy body",
			subtitle: "Visible skim",
			title: "Searchable memory",
		});

		expect(hiddenSearchMatch(model, "orchard")).toMatchObject({
			label: "Body",
		});
	});

	it("explains a match found only in a metadata narrative", () => {
		const model = buildFeedCardViewModel({
			metadata_json: { narrative: "Metadata-only orchard detail" },
			title: "Imported memory",
		});

		expect(hiddenSearchMatch(model, "orchard")).toMatchObject({ label: "Body" });
	});
});

describe("session card generated body fallbacks", () => {
	it("keeps generated body text when that is what the pack falls back to", () => {
		const model = buildFeedCardViewModel({
			body_text: "## Request\nRepair the watering controller",
			kind: "session_summary",
			summary: { request: "Repair the watering controller" },
			title: "Stored title",
		});

		expect(model.displayTitle).toBe("Stored title");
		expect(model.content.body).toBe("## Request\nRepair the watering controller");
	});

	it("keeps unmatched imported body text available to search", () => {
		const model = buildFeedCardViewModel({
			body_text: "Imported orchard detail",
			kind: "session_summary",
			narrative: "Explicit session narrative",
			summary: { outcome: "Completed migration" },
			title: "Migration work",
		});

		expect(hiddenSearchMatch(model, "orchard")).toMatchObject({ label: "Body" });
	});

	it("keeps indexed session subtitle and facts available to search", () => {
		const model = buildFeedCardViewModel({
			facts: ["Imported orchard fact"],
			kind: "session_summary",
			metadata_json: { facts: { source_note: "Coordinator handoff" } },
			subtitle: "Indexed session subtitle",
			title: "Session record",
		});

		expect(hiddenSearchMatch(model, "subtitle")).toMatchObject({ label: "Body" });
		expect(hiddenSearchMatch(model, "orchard")).toMatchObject({ label: "Content" });
		expect(hiddenSearchMatch(model, "handoff")).toMatchObject({ label: "Body" });
	});
});

describe("feed card visible search matches", () => {
	it("does not duplicate a match in the fully wrapped title", () => {
		const model = buildFeedCardViewModel({ title: "A memory about the orchard" });
		expect(hiddenSearchMatch(model, "orchard")).toBeNull();
	});
});
