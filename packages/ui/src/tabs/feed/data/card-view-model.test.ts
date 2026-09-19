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

	it("uses a supported outcome when the request duplicates the title", () => {
		const model = buildFeedCardViewModel({
			kind: "session_summary",
			summary: {
				request: "Repair the watering controller",
				outcome: "The controller now rejects duplicate commands",
			},
			title: "Stored title",
		});

		expect(model.displayTitle).toBe("Repair the watering controller");
		expect(model.skimSummary).toBe("The controller now rejects duplicate commands");
		expect(model.modes.map(({ id }) => id)).toContain("summary");
	});

	it("uses a later outcome line when its first line duplicates the title", () => {
		const model = buildFeedCardViewModel({
			kind: "session_summary",
			summary: {
				request: "Deploy release",
				completed: "Deploy release\nFixed the migration",
			},
			title: "Stored title",
		});

		expect(model.displayTitle).toBe("Deploy release");
		expect(model.skimSummary).toBe("Fixed the migration");
	});

	it("uses a supported plan when no completed outcome is available", () => {
		const model = buildFeedCardViewModel({
			kind: "session_summary",
			summary: {
				request: "Repair the watering controller",
				plan: "Add a bounded retry before the next release",
			},
			title: "Stored title",
		});

		expect(model.displayTitle).toBe("Repair the watering controller");
		expect(model.skimSummary).toBe("Add a bounded retry before the next release");
	});

	it("keeps the full legacy session body in expanded Summary", () => {
		const model = buildFeedCardViewModel({
			body_text: "First result line\nSecond result line",
			kind: "session_summary",
			title: "Legacy session",
		});

		expect(model.skimSummary).toBe("First result line");
		expect(model.modes.find(({ id }) => id === "summary")?.searchText).toContain(
			"Second result line",
		);
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

		expect(hiddenSearchMatch(model, "coordinator")).toMatchObject({
			label: "Facts",
			mode: "facts",
		});
		expect(hiddenSearchMatch(model, "Visible")).toBeNull();
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
			mode: null,
		});
	});
});

describe("feed card clipped search matches", () => {
	it("explains a title or skim match beyond the visible compact prefix", () => {
		const prefix =
			"A compact result with enough leading context to be clipped before the matching text ";
		const titleModel = buildFeedCardViewModel({ title: `${prefix}orchard` });
		const summaryModel = buildFeedCardViewModel({
			subtitle: `${prefix}coordinator`,
			title: "Memory",
		});

		expect(hiddenSearchMatch(titleModel, "orchard")).toMatchObject({ label: "Title" });
		expect(hiddenSearchMatch(summaryModel, "coordinator")).toMatchObject({ label: "Summary" });
	});
});
