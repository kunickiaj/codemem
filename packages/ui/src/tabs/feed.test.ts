import { describe, expect, it } from "vitest";
import { observationViewData } from "./feed";

describe("observationViewData", () => {
	it("uses subtitle as summary and narrative as full text when both exist", () => {
		const data = observationViewData({
			subtitle: "Short skim line",
			narrative: "Longer narrative explaining the change in detail.",
			body_text: "Legacy body text fallback",
			facts: ["One fact"],
			metadata_json: {},
		});

		expect(data.summary).toBe("Short skim line");
		expect(data.narrative).toBe("Longer narrative explaining the change in detail.");
		expect(data.hasSummary).toBe(true);
		expect(data.hasNarrative).toBe(true);
	});

	it("falls back to body_text as legacy narrative when structured narrative is missing", () => {
		const data = observationViewData({
			subtitle: null,
			narrative: null,
			body_text: "Legacy body text still available as the full observation detail.",
			facts: [],
			metadata_json: {},
		});

		expect(data.summary).toBe("");
		expect(data.narrative).toBe("Legacy body text still available as the full observation detail.");
		expect(data.hasSummary).toBe(false);
		expect(data.hasNarrative).toBe(true);
	});

	it("does not treat identical subtitle and narrative as distinct narrative mode", () => {
		const data = observationViewData({
			subtitle: "Same text",
			narrative: "Same text",
			body_text: "Same text",
			facts: [],
			metadata_json: {},
		});

		expect(data.hasSummary).toBe(true);
		expect(data.hasNarrative).toBe(false);
	});

	it("derives sentence facts from full narrative before skim summary", () => {
		const data = observationViewData({
			subtitle: "Short skim line",
			narrative: "First full detail sentence. Second full detail sentence.",
			body_text: "Legacy body text fallback",
			facts: [],
			metadata_json: {},
		});

		expect(data.facts).toEqual(["First full detail sentence.", "Second full detail sentence."]);
	});
});
