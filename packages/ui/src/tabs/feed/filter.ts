/* Feed filtering — by-type / by-query / signature helpers.
 * Reads the feed-tab globals from lib/state directly so callers can stay
 * declarative. */

import { normalize, parseJsonArray } from "../../lib/format";
import { state } from "../../lib/state";
import { itemSignature, mergeMetadata } from "./helpers";
import { isSummaryLikeItem } from "./summary-extract";
import type { FeedItem } from "./types";

export function filterByType(items: FeedItem[]): FeedItem[] {
	if (state.feedTypeFilter === "observations")
		return items.filter((i) => !isSummaryLikeItem(i, mergeMetadata(i?.metadata_json)));
	if (state.feedTypeFilter === "summaries")
		return items.filter((i) => isSummaryLikeItem(i, mergeMetadata(i?.metadata_json)));
	return items;
}

export function filterByQuery(items: FeedItem[]): FeedItem[] {
	const query = normalize(state.feedQuery);
	if (!query) return items;
	return items.filter((item) => {
		const hay = [
			normalize(item?.title),
			normalize(item?.body_text),
			normalize(item?.kind),
			parseJsonArray(item?.tags || [])
				.map((t) => normalize(t))
				.join(" "),
			normalize(item?.project),
		]
			.join(" ")
			.trim();
		return hay.includes(query);
	});
}

export function computeSignature(items: FeedItem[]): string {
	const parts = items.map(
		(i) => `${itemSignature(i)}:${i.kind || ""}:${i.created_at_utc || i.created_at || ""}`,
	);
	return `${state.feedTypeFilter}|${state.feedScopeFilter}|${state.currentProject}|${normalize(state.feedQuery)}|${parts.join("|")}`;
}
