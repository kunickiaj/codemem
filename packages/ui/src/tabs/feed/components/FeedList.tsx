import { Fragment, h } from "preact";
import { setFeedScopeFilter, setFeedTypeFilter, state } from "../../../lib/state";
import { itemKey } from "../data/helpers";
import type { FeedItem, FeedViewOps } from "../types";
import { FeedItemCard } from "./FeedItemCard";
import { FeedSkeletonItem } from "./FeedSkeletonItem";

function clickElement(id: string): void {
	document.getElementById(id)?.click();
}

function openHealth(): void {
	clickElement("tabBtn-health");
	queueMicrotask(() => document.getElementById("healthSystemCard")?.focus());
}

function clearFeedFilters(ops: FeedViewOps): void {
	setFeedTypeFilter("all");
	setFeedScopeFilter("all");
	const projectFilter = document.getElementById("projectFilter") as HTMLSelectElement | null;
	if (projectFilter) {
		projectFilter.value = "";
		projectFilter.dispatchEvent(new Event("change", { bubbles: true }));
		queueMicrotask(() => projectFilter.focus());
		return;
	}
	state.currentProject = "";
	ops.updateFeedView(true);
	void ops.loadFeedData().catch(() => undefined);
}

type EmptyStateModel = {
	actions: Array<{ label: string; run: () => void }>;
	detail: string;
	status?: boolean;
	title: string;
};

function deriveProcessingEmptyState(): EmptyStateModel {
	const status = state.feedProcessingStatus;
	if (status.kind === "pending") {
		const noun = status.count === 1 ? "event" : "events";
		return {
			actions: [{ label: "Open Health", run: openHealth }],
			detail: "Captured work is queued. Memories will appear after processing finishes.",
			status: true,
			title: `Processing ${status.count} ${noun}.`,
		};
	}
	if (status.kind === "paused") {
		return {
			actions: [{ label: "Open Health", run: openHealth }],
			detail: "New activity will not be captured until raw-event capture is enabled.",
			status: true,
			title: "Capture is paused.",
		};
	}
	if (status.kind === "unavailable") {
		return {
			actions: [{ label: "Open Health", run: openHealth }],
			detail: "The Feed is connected, but processing status could not be checked.",
			status: true,
			title: "Processing status is unavailable.",
		};
	}
	return {
		actions: [
			{ label: "Open Settings", run: () => clickElement("settingsButton") },
			{ label: "Open Health", run: openHealth },
		],
		detail: "Use codemem while you work. Captured memories and session summaries will appear here.",
		title: "No memories yet.",
	};
}

function deriveEmptyState(ops: FeedViewOps): EmptyStateModel {
	const query = state.feedQuery.trim();
	if (query) {
		return {
			actions: [
				{
					label: "Clear search",
					run: () => {
						ops.updateFeedQuery("");
						queueMicrotask(() => document.getElementById("feedSearch")?.focus());
					},
				},
			],
			detail: "Try a broader search or clear the search to see all memories.",
			title: `No memories match “${query}”.`,
		};
	}
	const hasFilters =
		state.feedTypeFilter !== "all" ||
		state.feedScopeFilter !== "all" ||
		Boolean(state.currentProject);
	if (!hasFilters) return deriveProcessingEmptyState();
	return {
		actions: [{ label: "Clear filters", run: () => clearFeedFilters(ops) }],
		detail: "Clear the Feed and project filters to see memories from every scope.",
		title: "No memories match the current filters.",
	};
}

export function FeedEmptyState({ ops }: { ops: FeedViewOps }) {
	const model = deriveEmptyState(ops);
	return h(
		"div",
		{ className: "small feed-empty-state", role: model.status ? "status" : undefined },
		h("strong", null, model.title),
		h("div", null, model.detail),
		h(
			"div",
			{ className: "feed-empty-actions" },
			model.actions.map((action) =>
				h(
					"button",
					{ className: "settings-button", key: action.label, onClick: action.run, type: "button" },
					action.label,
				),
			),
		),
	);
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
		return h(FeedEmptyState, { ops });
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
