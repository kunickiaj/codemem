import { escapeHtml } from "../../../lib/dom";
import { normalize, parseJsonArray } from "../../../lib/format";
import type { FeedItem } from "../types";
import { itemKey, itemTags, mergeMetadata } from "./helpers";
import { canonicalKind, isSummaryLikeItem } from "./summary-extract";

export interface FeedCardContent {
	body: string;
	facts: string[];
	narrative: string;
	searchText: string;
}

export interface FeedCardViewModel {
	content: FeedCardContent;
	displayKind: string;
	displayTitle: string;
	files: unknown[];
	isSessionSummary: boolean;
	rowKey: string;
	searchOnlyText: string;
	tags: unknown[];
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
		item.metadata_json?.narrative,
		searchableValue(item.facts),
		searchableValue(item.summary),
		searchableValue(item.metadata_json?.facts),
		searchableValue(item.metadata_json?.summary),
		searchableValue(item.metadata_json?.request),
	];
	return candidates
		.map((candidate) => String(candidate || "").trim())
		.filter((candidate) => candidate && !renderedSearchText.includes(normalize(candidate)))
		.join("\n");
}

function buildPackContent(item: FeedItem): { content: FeedCardContent; searchOnlyText: string } {
	const narrative = String(item.narrative || "").trim();
	const facts = parseJsonArray(item.facts).filter(
		(fact): fact is string => typeof fact === "string",
	);
	const legacyBody = String(item.body_text || "").trim();
	const hasStructuredContent = Boolean(narrative || facts.length);
	const body = hasStructuredContent ? "" : legacyBody;
	const searchText = [narrative, ...facts, body].filter(Boolean).join("\n");
	const indexedSearchText = indexedMetadataSearchText(item, normalize(searchText));
	return {
		content: { body, facts, narrative, searchText },
		searchOnlyText: [hasStructuredContent ? legacyBody : "", indexedSearchText]
			.filter(Boolean)
			.join("\n"),
	};
}

export function buildFeedCardViewModel(item: FeedItem): FeedCardViewModel {
	const metadata = mergeMetadata(item.metadata_json);
	const normalizedItem = { ...item, metadata_json: metadata };
	const isSessionSummary = isSummaryLikeItem(item, metadata);
	const displayTitle = String(item.title || "(untitled)").trim();
	const content = buildPackContent(normalizedItem);

	return {
		content: content.content,
		displayKind: canonicalKind(item, metadata),
		displayTitle: displayTitle || "(untitled)",
		files: parseJsonArray(item.files || []),
		isSessionSummary,
		rowKey: itemKey(item),
		searchOnlyText: content.searchOnlyText,
		tags: itemTags(item),
	};
}

export function normalizeFeedQuery(query: string): string {
	return query.trim().toLowerCase().slice(0, 256);
}

export function feedItemMatchesQuery(item: FeedItem, query: string): boolean {
	const normalizedQuery = normalizeFeedQuery(query);
	if (!normalizedQuery) return false;
	const memoryId = Number(item.id || item.memory_id || 0);
	// The API accepts only canonical positive integer queries for ID matching.
	if (Number.isSafeInteger(memoryId) && memoryId > 0 && normalizedQuery === String(memoryId)) {
		return true;
	}
	const model = buildFeedCardViewModel(item);
	return [
		model.displayTitle,
		model.displayKind,
		String(item.project || ""),
		model.searchOnlyText,
		model.content.searchText,
		...model.tags.map(String),
	].some((text) => text.toLowerCase().includes(normalizedQuery));
}

function includesQuery(value: string, query: string): boolean {
	return value.toLowerCase().includes(query.toLowerCase());
}

function feedMatchRanges(text: string, query: string): { start: number; end: number }[] {
	if (!query) return [];
	const offsets: { start: number; end: number }[] = [];
	let sourceOffset = 0;
	for (const character of text) {
		const span = { start: sourceOffset, end: sourceOffset + character.length };
		for (let unit = 0; unit < character.toLowerCase().length; unit++) offsets.push(span);
		sourceOffset = span.end;
	}
	// Lowercase the whole string to retain contextual casing (for example Greek sigma).
	const folded = text.toLowerCase();
	const ranges: { start: number; end: number }[] = [];
	let index = folded.indexOf(query);
	while (index !== -1) {
		const start = offsets[index]?.start;
		const end = offsets[index + query.length - 1]?.end;
		if (start !== undefined && end !== undefined) ranges.push({ start, end });
		index = folded.indexOf(query, index + query.length);
	}
	return ranges;
}

export function highlightFeedText(text: string, query: string): string {
	let cursor = 0;
	let result = "";
	for (const { start, end } of feedMatchRanges(text, normalizeFeedQuery(query))) {
		if (start < cursor) continue;
		result += `${escapeHtml(text.slice(cursor, start))}<mark class="match">${escapeHtml(text.slice(start, end))}</mark>`;
		cursor = end;
	}
	return result + escapeHtml(text.slice(cursor));
}

function excerptAroundMatch(text: string, query: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	const match = feedMatchRanges(collapsed, query.toLowerCase())[0];
	if (!match) return "";
	const start = Math.max(0, match.start - 70);
	const end = Math.min(collapsed.length, match.end + 90);
	return `${start > 0 ? "…" : ""}${collapsed.slice(start, end)}${end < collapsed.length ? "…" : ""}`;
}

export function hiddenSearchMatch(
	model: FeedCardViewModel,
	query: string,
): { excerpt: string; label: string } | null {
	const trimmedQuery = normalizeFeedQuery(query);
	if (!trimmedQuery) return null;
	if (includesQuery(model.displayTitle, trimmedQuery)) return null;
	if (includesQuery(model.content.searchText, trimmedQuery)) {
		return {
			excerpt: excerptAroundMatch(model.content.searchText, trimmedQuery),
			label: "Content",
		};
	}
	if (includesQuery(model.searchOnlyText, trimmedQuery)) {
		return {
			excerpt: excerptAroundMatch(model.searchOnlyText, trimmedQuery),
			label: "Body",
		};
	}
	return null;
}
