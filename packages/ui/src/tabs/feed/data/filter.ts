/* Feed filtering — by-type and signature helpers.
 * Reads the feed-tab globals from lib/state directly so callers can stay
 * declarative. */

import { normalize } from "../../../lib/format";
import { state } from "../../../lib/state";
import type { FeedItem } from "../types";
import { itemSignature, mergeMetadata } from "./helpers";
import { isSummaryLikeItem } from "./summary-extract";

export function filterByType(items: FeedItem[]): FeedItem[] {
	if (state.feedTypeFilter === "observations")
		return items.filter((i) => !isSummaryLikeItem(i, mergeMetadata(i?.metadata_json)));
	if (state.feedTypeFilter === "summaries")
		return items.filter((i) => isSummaryLikeItem(i, mergeMetadata(i?.metadata_json)));
	return items;
}

export function computeSignature(items: FeedItem[]): string {
	const parts = items.map(
		(i) => `${itemSignature(i)}:${i.kind || ""}:${i.created_at_utc || i.created_at || ""}`,
	);
	return `${state.feedTypeFilter}|${state.feedScopeFilter}|${state.currentProject}|${normalize(state.feedQuery)}|${parts.join("|")}`;
}
