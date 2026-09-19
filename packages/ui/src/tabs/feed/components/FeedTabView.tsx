import { Fragment, h } from "preact";
import { useState } from "preact/hooks";
import { setFeedScopeFilter, setFeedTypeFilter, state } from "../../../lib/state";
import { completeFirstRunStep } from "../data/first-run-guide";
import { feedMetaText } from "../data/meta";
import type { FeedItem, FeedViewOps } from "../types";
import { ContextInspectorPanel } from "./ContextInspectorPanel";
import { FeedList } from "./FeedList";
import { FeedToggle } from "./FeedToggle";
import { FirstRunGuide } from "./FirstRunGuide";

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
			const value = String((event.currentTarget as HTMLInputElement).value || "");
			if (value.trim()) completeFirstRunStep("find");
			onQuery(value);
		},
		placeholder: "Search title, body, tags…",
		type: "search",
		value: query,
	});
}

export function shouldRenderFirstRunGuide(loadingText: string | undefined, reconnectOpen: boolean) {
	return !loadingText && !reconnectOpen;
}

function FeedControls({
	inspectorOpen,
	items,
	loadingText,
	onInspectorToggle,
	ops,
}: {
	inspectorOpen: boolean;
	items: FeedItem[];
	loadingText?: string;
	onInspectorToggle: () => void;
	ops: FeedViewOps;
}) {
	return h(
		"div",
		{ className: "feed-controls" },
		h(FeedStatus, { text: loadingText || feedMetaText(items.length, ops.hasMorePages()) }),
		h(
			"div",
			{ className: "feed-controls-right" },
			h(FeedSearchInput, { query: state.feedQuery, onQuery: ops.updateFeedQuery }),
			h(FeedToggle, {
				active: state.feedScopeFilter,
				id: "feedScopeToggle",
				onSelect: (value) => {
					if (value === state.feedScopeFilter) return;
					completeFirstRunStep("scope");
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
					onClick: onInspectorToggle,
					type: "button",
				},
				inspectorOpen ? "Hide Context Inspector" : "Context Inspector",
			),
		),
	);
}

function FeedContent({
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
	const errorNotice = errorText
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
		: null;
	if (items.length === 0 && errorNotice) return errorNotice;
	return h(Fragment, null, errorNotice, h(FeedList, { items, loadingText, ops }));
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
	const onInspectorToggle = () => {
		setInspectorOpen((current) => !current);
	};
	return h(
		Fragment,
		null,
		h(FeedControls, { inspectorOpen, items, loadingText, onInspectorToggle, ops }),
		h(ContextInspectorPanel, { open: inspectorOpen }),
		shouldRenderFirstRunGuide(loadingText, state.viewerReconnectOpen)
			? h(FirstRunGuide, {
					hasMemories: items.length > 0,
					hasQueuedEvents: state.feedProcessingStatus.kind === "pending",
				})
			: null,
		h(
			"div",
			{ className: "feed-list", id: "feedList" },
			h(FeedContent, { errorText, items, loadingText, ops }),
		),
	);
}
