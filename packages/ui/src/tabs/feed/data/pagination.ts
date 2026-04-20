/* Feed pagination — pure helpers + page-size constants. */

import type * as api from "../../../lib/api";
import type { FeedItem } from "../types";
import { itemKey } from "./helpers";

export const OBSERVATION_PAGE_SIZE = 20;
export const SUMMARY_PAGE_SIZE = 50;
export const FEED_SCROLL_THRESHOLD_PX = 560;

export function isNearFeedBottom(): boolean {
	const root = document.documentElement;
	const height = Math.max(root.scrollHeight, document.body.scrollHeight);
	return window.innerHeight + window.scrollY >= height - FEED_SCROLL_THRESHOLD_PX;
}

export function pageHasMore(payload: api.PaginatedResponse, count: number, limit: number): boolean {
	const value = payload.pagination?.has_more;
	if (typeof value === "boolean") return value;
	return count >= limit;
}

export function pageNextOffset(payload: api.PaginatedResponse, count: number): number {
	const value = payload.pagination?.next_offset;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	return count;
}

export function countNewItems(nextItems: FeedItem[], currentItems: FeedItem[]): number {
	const seen = new Set(currentItems.map(itemKey));
	return nextItems.filter((i) => !seen.has(itemKey(i))).length;
}
