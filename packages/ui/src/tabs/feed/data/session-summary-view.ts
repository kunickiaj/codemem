import { normalize } from "../../../lib/format";
import type { FeedItem, FeedSummary } from "../types";
import { firstContentLine } from "./observation-view";
import { getSummaryObject } from "./summary-extract";

const OUTCOME_KEYS = ["completed", "learned", "investigated", "next_steps", "next", "notes"];
const FACT_KEYS = [
	"request",
	"outcome",
	"plan",
	"completed",
	"learned",
	"investigated",
	"next",
	"next_steps",
	"notes",
];

function sectionText(summary: FeedSummary | null, key: string): string {
	return String(summary?.[key] || "").trim();
}

export function sessionSummaryViewData(item: FeedItem, displayedTitle: string) {
	const summary = getSummaryObject(item);
	const normalizedTitle = normalize(displayedTitle);
	const outcomeCandidates = OUTCOME_KEYS.map((key) => sectionText(summary, key));
	const request = sectionText(summary, "request");
	const bodyText = String(item.body_text || "").trim();
	const skimCandidates = [...outcomeCandidates, request, bodyText];
	const skimSummary =
		skimCandidates
			.map(firstContentLine)
			.find((candidate) => Boolean(candidate) && normalize(candidate) !== normalizedTitle) || "";

	const facts: FeedSummary = {};
	for (const key of FACT_KEYS) {
		const content = sectionText(summary, key);
		if (!content) continue;
		if (key === "request" && normalize(content) === normalizedTitle) continue;
		facts[key] = content;
	}

	const metadata = item.metadata_json || {};
	const explicitNarrative = String(item.narrative || metadata.narrative || "").trim();
	const narrative = explicitNarrative || bodyText;
	const summaryDetail = skimSummary;

	return {
		facts,
		hasFacts: Object.keys(facts).length > 0,
		hasNarrative: Boolean(narrative) && normalize(narrative) !== normalize(summaryDetail),
		hasSummary: Boolean(summaryDetail),
		narrative,
		skimSummary,
		summaryDetail,
	};
}
