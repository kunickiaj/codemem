/* Feed tab view — top-level layout for controls row, inspector panel,
 * and the list of feed items. Receives state mutators + view-refresh
 * callbacks as props to avoid circular imports with feed.ts. */

import { Fragment, h } from "preact";
import { useState } from "preact/hooks";
import { setFeedScopeFilter, setFeedTypeFilter, state } from "../../lib/state";
import { FeedItemCard } from "./card";
import { itemKey } from "./helpers";
import { ContextInspectorPanel } from "./inspector";
import { feedMetaText } from "./meta";
import { FeedSkeletonItem } from "./skeleton";
import { FeedToggle } from "./toggles";
import type { FeedItem } from "./types";

export interface FeedViewOps {
	replaceFeedItem: (item: FeedItem) => void;
	removeFeedItem: (memoryId: number) => void;
	updateFeedView: (force?: boolean) => void;
	loadFeedData: () => Promise<void>;
	hasMorePages: () => boolean;
}

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

export function FeedTabView({
	items,
	loadingText,
	ops,
}: {
	items: FeedItem[];
	loadingText?: string;
	ops: FeedViewOps;
}) {
	const [inspectorOpen, setInspectorOpen] = useState(false);
	return h(
		Fragment,
		null,
		h(
			"div",
			{ className: "feed-controls" },
			h(
				"div",
				{ className: "section-meta", id: "feedMeta" },
				loadingText || feedMetaText(items.length, ops.hasMorePages()),
			),
			h(
				"div",
				{ className: "feed-controls-right" },
				h("input", {
					className: "feed-search",
					id: "feedSearch",
					onInput: (event) => {
						state.feedQuery = String((event.currentTarget as HTMLInputElement).value || "");
						ops.updateFeedView();
					},
					placeholder: "Search title, body, tags…",
					value: state.feedQuery,
				}),
				h(FeedToggle, {
					active: state.feedScopeFilter,
					id: "feedScopeToggle",
					onSelect: (value) => {
						if (value === state.feedScopeFilter) return;
						setFeedScopeFilter(value);
						void ops.loadFeedData();
					},
					options: [
						{ value: "all", label: "All" },
						{ value: "mine", label: "My memories" },
						{ value: "theirs", label: "Other people" },
					],
				}),
				h(FeedToggle, {
					active: state.feedTypeFilter,
					id: "feedTypeToggle",
					onSelect: (value) => {
						if (value === state.feedTypeFilter) return;
						setFeedTypeFilter(value);
						ops.updateFeedView();
					},
					options: [
						{ value: "all", label: "All" },
						{ value: "observations", label: "Observations" },
						{ value: "summaries", label: "Summaries" },
					],
				}),
				h(
					"button",
					{
						"aria-controls": "contextInspectorPanel",
						"aria-expanded": inspectorOpen,
						className: "settings-button feed-inspector-button",
						onClick: () => setInspectorOpen((current) => !current),
						type: "button",
					},
					inspectorOpen ? "Hide Context Inspector" : "Context Inspector",
				),
			),
		),
		h(ContextInspectorPanel, { open: inspectorOpen }),
		h("div", { className: "feed-list", id: "feedList" }, h(FeedList, { items, loadingText, ops })),
	);
}
