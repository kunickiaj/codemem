/* Feed pagination — pure helpers + page-size constants. */

import type * as api from "../../../lib/api";
import { validateFeedPagination } from "../../../lib/api/feed-request";
import type { FeedItem } from "../types";
import { itemKey } from "./helpers";

export const OBSERVATION_PAGE_SIZE = 20;
export const SUMMARY_PAGE_SIZE = 50;
export const FEED_SCROLL_THRESHOLD_PX = 560;

export type FeedPageProgress = {
	mode: "unknown" | "cursor" | "offset";
	offset: number;
	hasMore: boolean;
	nextCursor: string | null;
	advanced: boolean;
};

export function initialFeedProgress(mode: FeedPageProgress["mode"] = "unknown"): FeedPageProgress {
	return { mode, offset: 0, hasMore: true, nextCursor: null, advanced: false };
}

export function feedPagingOptions(
	progress: FeedPageProgress,
	options: { head: boolean },
): {
	offset?: number;
	paging?: "cursor";
	cursor?: string;
} {
	if (progress.mode === "offset") return { offset: options.head ? 0 : progress.offset };
	if (options.head || progress.mode === "unknown") return { paging: "cursor" };
	if (!progress.hasMore || !progress.nextCursor) throw new Error("Feed unavailable.");
	return { paging: "cursor", cursor: progress.nextCursor };
}

export function nextFeedProgress(options: {
	previous: FeedPageProgress;
	payload: api.PaginatedResponse;
	limit: number;
	head: boolean;
}): FeedPageProgress {
	const { previous, payload, limit, head } = options;
	validateFeedPagination(payload);
	// A head refresh cannot rewind a continuation, even if an older page finished while it ran.
	if (head && previous.advanced) return previous;
	const count = payload.items?.length ?? 0;
	if (payload.pagination?.paging === "cursor") {
		return {
			mode: "cursor",
			offset: 0,
			hasMore: payload.pagination.has_more === true,
			nextCursor: payload.pagination.next_cursor ?? null,
			advanced: !head,
		};
	}
	return {
		mode: "offset",
		offset: pageNextOffset(payload, (head ? 0 : previous.offset) + count),
		hasMore: pageHasMore(payload, count, limit),
		nextCursor: null,
		advanced: !head,
	};
}

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
