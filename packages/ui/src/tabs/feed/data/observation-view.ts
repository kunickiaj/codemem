/* Observation view-mode helpers — pure selection logic for toggling
 * between "summary", "facts", and "narrative" presentations of a feed item. */

import { normalize, parseJsonArray } from "../../../lib/format";
import type { FeedItem, ItemViewMode } from "../types";
import { extractFactsFromBody, mergeMetadata, sentenceFacts } from "./helpers";

export function observationViewData(item: FeedItem) {
	const metadata = mergeMetadata(item?.metadata_json);
	const summary = String(item?.subtitle || metadata?.subtitle || "").trim();
	const narrative = String(item?.narrative || metadata?.narrative || item?.body_text || "").trim();
	const normSummary = normalize(summary);
	const normNarrative = normalize(narrative);
	const narrativeDistinct = Boolean(narrative) && normNarrative !== normSummary;
	const explicitFacts = parseJsonArray(item?.facts || metadata?.facts || []);
	const fallbackFacts = explicitFacts.length
		? explicitFacts
		: extractFactsFromBody(narrative || summary);
	const derivedFacts = fallbackFacts.length ? fallbackFacts : sentenceFacts(narrative || summary);
	return {
		summary,
		narrative,
		facts: derivedFacts,
		hasSummary: Boolean(summary),
		hasFacts: derivedFacts.length > 0,
		hasNarrative: narrativeDistinct,
	};
}

export function observationViewModes(data: {
	hasSummary: boolean;
	hasFacts: boolean;
	hasNarrative: boolean;
}): Array<{ id: ItemViewMode; label: string }> {
	const modes: Array<{ id: ItemViewMode; label: string }> = [];
	if (data.hasSummary) modes.push({ id: "summary", label: "Summary" });
	if (data.hasFacts) modes.push({ id: "facts", label: "Facts" });
	if (data.hasNarrative) modes.push({ id: "narrative", label: "Narrative" });
	return modes;
}

export function defaultObservationView(data: {
	hasSummary: boolean;
	hasFacts: boolean;
	hasNarrative: boolean;
}): ItemViewMode {
	if (data.hasSummary) return "summary";
	if (data.hasFacts) return "facts";
	return "narrative";
}

export function shouldClampBody(
	mode: ItemViewMode,
	data: { summary: string; narrative: string },
): boolean {
	if (mode === "facts") return false;
	if (mode === "summary") return data.summary.length > 260;
	return data.narrative.length > 320;
}

export function clampClass(mode: ItemViewMode): string[] {
	return mode === "summary" ? ["clamp", "clamp-3"] : ["clamp", "clamp-5"];
}
