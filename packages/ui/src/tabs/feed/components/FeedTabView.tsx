import { Fragment, h } from "preact";
import { useState } from "preact/hooks";
import { setFeedScopeFilter, setFeedTypeFilter, state } from "../../../lib/state";
import { feedMetaText } from "../data/meta";
import type { FeedItem, FeedViewOps } from "../types";
import { ContextInspectorPanel } from "./ContextInspectorPanel";
import { FeedList } from "./FeedList";
import { FeedToggle } from "./FeedToggle";

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
