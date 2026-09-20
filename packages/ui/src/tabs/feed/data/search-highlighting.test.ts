import { describe, expect, it } from "vitest";
import { buildFeedCardViewModel, hiddenSearchMatch, highlightFeedText } from "./card-view-model";

describe("Feed Unicode highlighting", () => {
	it.each([
		["K", "k", "K"],
		["İ", "i\u0307", "İ"],
		["İ", "i", "İ"],
		["ΟΣ", "ος", "ΟΣ"],
	])("maps %s back from normalized query %s", (source, query, expected) => {
		expect(highlightFeedText(source, query)).toBe(`<mark class="match">${expected}</mark>`);
	});
	it("truncates after lowercasing even when the boundary splits an expanded character", () => {
		const prefix = "A".repeat(255);
		expect(highlightFeedText(`${prefix}İtail`, ` ${prefix}İignored `)).toBe(
			`<mark class="match">${prefix}İ</mark>tail`,
		);
	});
	it("escapes source text before wrapping matches", () => {
		expect(highlightFeedText("<K>&", "K")).toBe('&lt;<mark class="match">K</mark>&gt;&amp;');
	});
	it("keeps excerpts aligned after earlier lowercase expansions", () => {
		const model = buildFeedCardViewModel({
			kind: "discovery",
			title: "Memory",
			subtitle: "Summary",
			narrative: `${"İ".repeat(100)} target ${"z".repeat(150)}`,
		});
		const match = hiddenSearchMatch(model, "target");
		expect(match?.excerpt).toContain("target");
		expect(highlightFeedText(match?.excerpt ?? "", "target")).toContain(
			'<mark class="match">target</mark>',
		);
	});
});
