import { Fragment, h } from "preact";
import { state } from "../../../lib/state";
import { itemKey } from "../data/helpers";
import type { FeedItem, FeedViewOps } from "../types";
import { FeedItemCard } from "./FeedItemCard";
import { FeedSkeletonItem } from "./FeedSkeletonItem";

export function FeedList({
	items,
	loadingText,
	ops,
}: {
	items: FeedItem[];
	loadingText?: string;
	ops: FeedViewOps;
}) {
	if (loadingText) {
		return h(
			"div",
			{
				className: "feed-skeleton",
				role: "status",
				"aria-label": loadingText,
			},
			[0, 1, 2, 3].map((i) => h(FeedSkeletonItem, { index: i, key: `skeleton-${i}` })),
		);
	}
	if (!items.length) {
		const hasFilters =
			Boolean(state.feedQuery.trim()) ||
			state.feedTypeFilter !== "all" ||
			state.feedScopeFilter !== "all";
		return h(
			"div",
			{ className: "small feed-empty-state" },
			h("strong", null, hasFilters ? "No memories match the current filters." : "No memories yet."),
			h(
				"div",
				null,
				hasFilters
					? "Try clearing filters, changing the scope, or using a broader search."
					: "Memories and session summaries will appear here once codemem has something worth keeping.",
			),
		);
	}
	return h(
		Fragment,
		null,
		items.map((item) =>
			h(FeedItemCard, {
				item,
				key: itemKey(item),
				onReplace: ops.replaceFeedItem,
				onRemove: ops.removeFeedItem,
				onViewRefresh: () => ops.updateFeedView(true),
				onReload: ops.loadFeedData,
			}),
		),
	);
}
