import { Fragment, h } from "preact";
import { useState } from "preact/hooks";
import { setFeedScopeFilter, setFeedTypeFilter, state } from "../../../lib/state";
import { feedMetaText } from "../data/meta";
import type { FeedItem, FeedViewOps } from "../types";
import { ContextInspectorPanel } from "./ContextInspectorPanel";
import { FeedList } from "./FeedList";
import { FeedToggle } from "./FeedToggle";

export function FeedStatus({ text }: { text: string }) {
	return h(
		"div",
		{ "aria-live": "polite", className: "section-meta", id: "feedMeta", role: "status" },
		text,
	);
}

export function FeedSearchInput({
	query,
	onQuery,
}: {
	query: string;
	onQuery: (query: string) => void;
}) {
	return h("input", {
		"aria-label": "Search memories",
		className: "feed-search",
		id: "feedSearch",
		onInput: (event) => {
			onQuery(String((event.currentTarget as HTMLInputElement).value || ""));
		},
		placeholder: "Search title, body, tags…",
		type: "search",
		value: query,
	});
}

export function FeedTabView({
	errorText,
	items,
	loadingText,
	ops,
}: {
	errorText?: string;
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
			h(FeedStatus, {
				text: loadingText || feedMetaText(items.length, ops.hasMorePages()),
			}),
			h(
				"div",
				{ className: "feed-controls-right" },
				h(FeedSearchInput, { query: state.feedQuery, onQuery: ops.updateFeedQuery }),
				h(FeedToggle, {
					active: state.feedScopeFilter,
					id: "feedScopeToggle",
					onSelect: (value) => {
						if (value === state.feedScopeFilter) return;
						setFeedScopeFilter(value);
						void ops.loadFeedData().catch(() => undefined);
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
		h(
			"div",
			{ className: "feed-list", id: "feedList" },
			h(
				Fragment,
				null,
				errorText
					? h(
							"div",
							{ className: "small feed-empty-state", role: "alert" },
							h("strong", null, errorText),
							h("div", null, "Check the viewer connection, then retry the Feed."),
							h(
								"button",
								{
									className: "settings-button",
									onClick: () => void ops.loadFeedData().catch(() => undefined),
									type: "button",
								},
								"Retry",
							),
						)
					: null,
				!errorText || items.length > 0 ? h(FeedList, { items, loadingText, ops }) : null,
			),
		),
	);
}
