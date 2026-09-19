import { normalize, parseJsonArray } from "../../../lib/format";
import type { FeedItem, FeedSummary, ItemViewMode } from "../types";
import { itemKey, itemTags, mergeMetadata } from "./helpers";
import { observationViewData } from "./observation-view";
import { sessionSummaryViewData } from "./session-summary-view";
import { canonicalKind, getSummaryObject, isSummaryLikeItem } from "./summary-extract";

export type FeedModeContent =
	| { type: "markdown"; text: string }
	| { type: "facts"; facts: unknown[] }
	| { type: "sections"; sections: FeedSummary };

export interface FeedCardMode {
	content: FeedModeContent;
	id: ItemViewMode;
	label: string;
	searchText: string;
}

export interface FeedCardViewModel {
	displayKind: string;
	displayTitle: string;
	files: unknown[];
	isSessionSummary: boolean;
	modes: FeedCardMode[];
	rowKey: string;
	skimSummary: string;
	tags: unknown[];
}

function modeLabel(mode: ItemViewMode): string {
	return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function markdownMode(id: ItemViewMode, text: string): FeedCardMode {
	return { content: { type: "markdown", text }, id, label: modeLabel(id), searchText: text };
}

interface ContentView {
	modes: FeedCardMode[];
	skimSummary: string;
}

function factsMode(facts: unknown[]): FeedCardMode {
	return {
		content: { type: "facts", facts },
		id: "facts",
		label: "Facts",
		searchText: facts.map(String).join("\n"),
	};
}

function sessionFactsMode(sections: FeedSummary): FeedCardMode {
	return {
		content: { type: "sections", sections },
		id: "facts",
		label: "Facts",
		searchText: Object.values(sections).join("\n"),
	};
}

function buildObservationContent(item: FeedItem, displayTitle: string): ContentView {
	const data = observationViewData(item);
	const modes: FeedCardMode[] = [];
	if (data.hasSummary) modes.push(markdownMode("summary", data.summaryDetail));
	if (data.hasFacts) modes.push(factsMode(data.facts));
	if (data.hasNarrative) modes.push(markdownMode("narrative", data.narrative));
	const skimSummary = normalize(data.summary) === normalize(displayTitle) ? "" : data.summary;
	return { modes, skimSummary };
}

function buildSessionContent(item: FeedItem, displayTitle: string): ContentView {
	const data = sessionSummaryViewData(item, displayTitle);
	const modes: FeedCardMode[] = [];
	if (data.hasSummary) modes.push(markdownMode("summary", data.summaryDetail));
	if (data.hasFacts) modes.push(sessionFactsMode(data.facts));
	if (data.hasNarrative) modes.push(markdownMode("narrative", data.narrative));
	return { modes, skimSummary: data.skimSummary };
}

export function buildFeedCardViewModel(item: FeedItem): FeedCardViewModel {
	const metadata = mergeMetadata(item.metadata_json);
	const normalizedItem = { ...item, metadata_json: metadata };
	const isSessionSummary = isSummaryLikeItem(item, metadata);
	const summaryRequest = isSessionSummary
		? String(getSummaryObject(normalizedItem)?.request || "").trim()
		: "";
	const displayTitle = String(summaryRequest || item.title || "(untitled)").trim();
	const content = isSessionSummary
		? buildSessionContent(normalizedItem, displayTitle)
		: buildObservationContent(normalizedItem, displayTitle);

	return {
		displayKind: canonicalKind(item, metadata),
		displayTitle: displayTitle || "(untitled)",
		files: parseJsonArray(item.files || []),
		isSessionSummary,
		modes: content.modes,
		rowKey: itemKey(item),
		skimSummary: content.skimSummary,
		tags: itemTags(item),
	};
}

export function preferredAvailableMode(
	modes: FeedCardMode[],
	preferred: ItemViewMode,
): ItemViewMode {
	if (modes.some((mode) => mode.id === preferred)) return preferred;
	for (const fallback of ["summary", "facts", "narrative"] as const) {
		if (modes.some((mode) => mode.id === fallback)) return fallback;
	}
	return "summary";
}

function includesQuery(value: string, query: string): boolean {
	return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function excerptAroundMatch(text: string, query: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	const index = collapsed.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
	if (index < 0) return "";
	const start = Math.max(0, index - 70);
	const end = Math.min(collapsed.length, index + query.length + 90);
	return `${start > 0 ? "…" : ""}${collapsed.slice(start, end)}${end < collapsed.length ? "…" : ""}`;
}

export function hiddenSearchMatch(
	model: FeedCardViewModel,
	query: string,
): { excerpt: string; mode: ItemViewMode } | null {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) return null;
	if (
		includesQuery(model.displayTitle, trimmedQuery) ||
		includesQuery(model.skimSummary, trimmedQuery)
	) {
		return null;
	}
	for (const mode of model.modes) {
		if (!includesQuery(mode.searchText, trimmedQuery)) continue;
		return { excerpt: excerptAroundMatch(mode.searchText, trimmedQuery), mode: mode.id };
	}
	return null;
}
