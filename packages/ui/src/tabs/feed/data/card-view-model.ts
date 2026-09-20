import { normalize, parseJsonArray, toTitleLabel } from "../../../lib/format";
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
	searchOnlyText: string;
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
	searchOnlyText: string;
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
		searchText: Object.entries(sections)
			.map(([key, value]) => `${toTitleLabel(key)}\n${String(value)}`)
			.join("\n"),
	};
}

function searchableValue(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) return value.map(searchableValue).filter(Boolean).join("\n");
	if (value && typeof value === "object") {
		return Object.entries(value)
			.map(([key, entry]) => `${key}\n${searchableValue(entry)}`)
			.filter((entry) => entry.trim())
			.join("\n");
	}
	return value == null ? "" : String(value).trim();
}

function indexedMetadataSearchText(item: FeedItem, renderedSearchText: string): string {
	const candidates = [
		item.subtitle,
		item.metadata_json?.subtitle,
		searchableValue(item.facts),
		searchableValue(item.metadata_json?.facts),
		searchableValue(item.metadata_json?.summary),
		searchableValue(item.metadata_json?.request),
	];
	return candidates
		.map((candidate) => String(candidate || "").trim())
		.filter((candidate) => candidate && !renderedSearchText.includes(normalize(candidate)))
		.join("\n");
}

function buildObservationContent(item: FeedItem, displayTitle: string): ContentView {
	const data = observationViewData(item);
	const modes: FeedCardMode[] = [];
	if (data.hasSummary) modes.push(markdownMode("summary", data.summaryDetail));
	if (data.hasFacts) modes.push(factsMode(data.facts));
	if (data.hasNarrative) modes.push(markdownMode("narrative", data.narrative));
	const skimSummary = normalize(data.summary) === normalize(displayTitle) ? "" : data.summary;
	const normalizedLegacyBody = normalize(data.legacyBody);
	const searchOnlyText =
		normalizedLegacyBody &&
		!modes.some((mode) => normalize(mode.searchText) === normalizedLegacyBody)
			? data.legacyBody
			: "";
	const indexedSearchText = indexedMetadataSearchText(
		item,
		normalize(modes.map((mode) => mode.searchText).join("\n")),
	);
	return {
		modes,
		searchOnlyText: [searchOnlyText, indexedSearchText].filter(Boolean).join("\n"),
		skimSummary,
	};
}

function buildSessionContent(item: FeedItem, displayTitle: string): ContentView {
	const data = sessionSummaryViewData(item, displayTitle);
	const modes: FeedCardMode[] = [];
	if (data.hasSummary) modes.push(markdownMode("summary", data.summaryDetail));
	if (data.hasFacts) modes.push(sessionFactsMode(data.facts));
	if (data.hasNarrative) modes.push(markdownMode("narrative", data.narrative));
	const bodyText = String(item.body_text || "").trim();
	const renderedSearchText = normalize(modes.map((mode) => mode.searchText).join("\n"));
	const indexedSearchText = indexedMetadataSearchText(item, renderedSearchText);
	const hasUnrenderedBodyLine = bodyText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !/^#{1,6}\s+/.test(line))
		.some((line) => !renderedSearchText.includes(normalize(line)));
	return {
		modes,
		searchOnlyText: [hasUnrenderedBodyLine ? bodyText : "", indexedSearchText]
			.filter(Boolean)
			.join("\n"),
		skimSummary: data.skimSummary,
	};
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
		searchOnlyText: content.searchOnlyText,
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

export function visibleSkimPrefixLength(viewportWidth: number): number {
	if (viewportWidth <= 520) return 24;
	if (viewportWidth <= 755) return 40;
	return 80;
}

function clippedSkimMatch(text: string, query: string, label: string, visiblePrefixLength: number) {
	const collapsed = text.replace(/\s+/g, " ").trim();
	const index = collapsed.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
	if (index < visiblePrefixLength) return null;
	return { excerpt: excerptAroundMatch(collapsed, query), label, mode: null };
}

export function hiddenSearchMatch(
	model: FeedCardViewModel,
	query: string,
	visiblePrefixLength = 80,
): { excerpt: string; label: string; mode: ItemViewMode | null } | null {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) return null;
	if (includesQuery(model.displayTitle, trimmedQuery)) {
		return clippedSkimMatch(model.displayTitle, trimmedQuery, "Title", visiblePrefixLength);
	}
	if (includesQuery(model.skimSummary, trimmedQuery)) {
		return clippedSkimMatch(model.skimSummary, trimmedQuery, "Summary", visiblePrefixLength);
	}
	for (const mode of model.modes) {
		if (!includesQuery(mode.searchText, trimmedQuery)) continue;
		return {
			excerpt: excerptAroundMatch(mode.searchText, trimmedQuery),
			label: mode.label,
			mode: mode.id,
		};
	}
	if (includesQuery(model.searchOnlyText, trimmedQuery)) {
		return {
			excerpt: excerptAroundMatch(model.searchOnlyText, trimmedQuery),
			label: "Body",
			mode: null,
		};
	}
	return null;
}
