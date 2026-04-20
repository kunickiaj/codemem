/* Feed tab — memory feed rendering, filtering, search. */

import { Fragment, h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "../lib/api";
import { setFeedScopeFilter, setFeedTypeFilter, state } from "../lib/state";

/* ── Types ───────────────────────────────────────────────── */

export type { FeedItem, FeedItemMetadata } from "./feed/types";

import {
	isLowSignalObservation,
	itemKey,
	mergeFeedItems,
	mergeRefreshFeedItems,
} from "./feed/helpers";
import {
	countNewItems,
	isNearFeedBottom,
	OBSERVATION_PAGE_SIZE,
	pageHasMore,
	pageNextOffset,
	SUMMARY_PAGE_SIZE,
} from "./feed/pagination";
import { FeedSkeletonItem } from "./feed/skeleton";
import type { FeedItem } from "./feed/types";

/* ── Module state ─────────────────────────────────────────── */

let lastFeedProject = "";
let observationOffset = 0;
let summaryOffset = 0;
let observationHasMore = true;
let summaryHasMore = true;
let loadMoreInFlight = false;
let feedScrollHandlerBound = false;
let feedProjectGeneration = 0;
let lastFeedScope = "all";

import { ensureFeedRenderBoundary, renderIntoFeedMount } from "./feed/mount";

function resetPagination(project: string) {
	lastFeedProject = project;
	lastFeedScope = state.feedScopeFilter;
	feedProjectGeneration += 1;
	observationOffset = 0;
	summaryOffset = 0;
	observationHasMore = true;
	summaryHasMore = true;
	state.lastFeedItems = [];
	state.pendingFeedItems = null;
	state.lastFeedFilteredCount = 0;
	state.lastFeedSignature = "";
	state.newItemKeys.clear();
	state.itemViewState.clear();
	state.itemExpandState.clear();
}

function hasMorePages(): boolean {
	return observationHasMore || summaryHasMore;
}

export function syncInspectorQueryDraft(options: {
	feedQuery: string;
	inspectorQuery: string;
	hasInspectorOverride: boolean;
}): string {
	return options.hasInspectorOverride ? options.inspectorQuery : options.feedQuery;
}

export function parseInspectorWorkingSet(value: string): string[] {
	return value
		.split(/\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);
}

export function packTraceContextKey(options: {
	project: string | null;
	query: string;
	workingSetFiles: string[];
}): string {
	return JSON.stringify([options.project, options.query.trim(), options.workingSetFiles]);
}

function replaceFeedItem(updatedItem: FeedItem) {
	const key = itemKey(updatedItem);
	state.lastFeedItems = (state.lastFeedItems as FeedItem[]).map((item) =>
		itemKey(item) === key ? updatedItem : item,
	);
}

function removeFeedItem(memoryId: number) {
	const removedKeys = new Set<string>();
	const keepItem = (item: FeedItem) => {
		const itemMemoryId = Number(item.id || item.memory_id || 0);
		const keep = itemMemoryId !== memoryId;
		if (!keep) removedKeys.add(itemKey(item));
		return keep;
	};
	state.lastFeedItems = (state.lastFeedItems as FeedItem[]).filter(keepItem);
	if (Array.isArray(state.pendingFeedItems)) {
		state.pendingFeedItems = (state.pendingFeedItems as FeedItem[]).filter(keepItem);
	}
	for (const key of removedKeys) {
		state.newItemKeys.delete(key);
		state.itemViewState.delete(key);
		for (const expandKey of Array.from(state.itemExpandState.keys())) {
			if (expandKey.startsWith(`${key}:`)) state.itemExpandState.delete(expandKey);
		}
	}
}

export { observationViewData } from "./feed/observation-view";

import { FeedItemCard } from "./feed/card";
import { FeedToggle } from "./feed/toggles";

function FeedList({ items, loadingText }: { items: FeedItem[]; loadingText?: string }) {
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
				onReplace: replaceFeedItem,
				onRemove: removeFeedItem,
				onViewRefresh: () => updateFeedView(true),
				onReload: loadFeedData,
			}),
		),
	);
}

/* ── Filtering ───────────────────────────────────────────── */

import { computeSignature, filterByQuery, filterByType } from "./feed/filter";

async function loadMoreFeedPage() {
	if (loadMoreInFlight || !hasMorePages()) return;
	const requestProject = state.currentProject || "";
	const requestGeneration = feedProjectGeneration;
	const startObservationOffset = observationOffset;
	const startSummaryOffset = summaryOffset;
	loadMoreInFlight = true;
	try {
		const [observations, summaries] = await Promise.all([
			observationHasMore
				? api.loadMemoriesPage(requestProject, {
						limit: OBSERVATION_PAGE_SIZE,
						offset: startObservationOffset,
						scope: state.feedScopeFilter,
					})
				: Promise.resolve({
						items: [],
						pagination: { has_more: false, next_offset: startObservationOffset },
					}),
			summaryHasMore
				? api.loadSummariesPage(requestProject, {
						limit: SUMMARY_PAGE_SIZE,
						offset: startSummaryOffset,
						scope: state.feedScopeFilter,
					})
				: Promise.resolve({
						items: [],
						pagination: { has_more: false, next_offset: startSummaryOffset },
					}),
		]);

		if (
			requestGeneration !== feedProjectGeneration ||
			requestProject !== (state.currentProject || "")
		) {
			return;
		}

		const summaryItems = (summaries.items || []) as FeedItem[];
		const observationItems = (observations.items || []) as FeedItem[];
		const filtered = observationItems.filter((i) => !isLowSignalObservation(i));
		state.lastFeedFilteredCount += observationItems.length - filtered.length;

		summaryHasMore = pageHasMore(summaries, summaryItems.length, SUMMARY_PAGE_SIZE);
		observationHasMore = pageHasMore(observations, observationItems.length, OBSERVATION_PAGE_SIZE);
		summaryOffset = pageNextOffset(summaries, startSummaryOffset + summaryItems.length);
		observationOffset = pageNextOffset(
			observations,
			startObservationOffset + observationItems.length,
		);

		const incoming = [...summaryItems, ...filtered];
		const feedItems = mergeFeedItems(state.lastFeedItems as FeedItem[], incoming);
		// Pagination loads OLDER items, not fresh arrivals — skip the newPulse
		// bookkeeping so scrolling doesn't flash historical cards.

		state.lastFeedItems = feedItems;
		updateFeedView();
	} finally {
		loadMoreInFlight = false;
	}
}

function maybeLoadMoreFeedPage() {
	if (state.activeTab !== "feed") return;
	if (!hasMorePages()) return;
	if (!isNearFeedBottom()) return;
	void loadMoreFeedPage();
}

import { feedMetaText } from "./feed/meta";
import { TraceCandidateGroup } from "./feed/trace";

function ContextInspectorPanel({ open }: { open: boolean }) {
	const [inspectorQuery, setInspectorQuery] = useState(() => String(state.feedQuery || ""));
	const [hasSeededInspectorQuery, setHasSeededInspectorQuery] = useState(false);
	const [hasInspectorOverride, setHasInspectorOverride] = useState(false);
	const [workingSetText, setWorkingSetText] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [errorContextKey, setErrorContextKey] = useState("");
	const [trace, setTrace] = useState<api.PackTrace | null>(null);
	const latestTraceRequestId = useRef(0);
	const feedQuery = String(state.feedQuery || "");
	const currentQuery = String(inspectorQuery || "").trim();
	const currentProject = state.currentProject || null;
	const currentWorkingSetFiles = parseInspectorWorkingSet(workingSetText);
	const currentContextKey = packTraceContextKey({
		project: currentProject,
		query: currentQuery,
		workingSetFiles: currentWorkingSetFiles,
	});
	const visibleTrace =
		trace &&
		packTraceContextKey({
			project: trace.inputs.project,
			query: trace.inputs.query,
			workingSetFiles: trace.inputs.working_set_files,
		}) === currentContextKey
			? trace
			: null;
	const visibleError = error && errorContextKey === currentContextKey ? error : "";

	useEffect(() => {
		latestTraceRequestId.current += 1;
		setLoading(false);
		setError("");
		setErrorContextKey("");
		setTrace((currentTrace) => {
			if (!currentTrace) return null;
			if (
				currentTrace.inputs.query !== currentQuery ||
				currentTrace.inputs.project !== currentProject
			) {
				return null;
			}
			return currentTrace;
		});
	}, [currentContextKey]);

	useEffect(() => {
		if (open && !hasSeededInspectorQuery) {
			setInspectorQuery(
				syncInspectorQueryDraft({
					feedQuery,
					hasInspectorOverride,
					inspectorQuery,
				}),
			);
			setHasSeededInspectorQuery(true);
		}
	}, [feedQuery, hasInspectorOverride, hasSeededInspectorQuery, inspectorQuery, open]);

	const runTrace = async () => {
		const context = currentQuery;
		const project = currentProject;
		const workingSetFiles = currentWorkingSetFiles;
		const contextKey = packTraceContextKey({ project, query: context, workingSetFiles });
		const requestId = latestTraceRequestId.current + 1;
		latestTraceRequestId.current = requestId;
		if (!context) {
			setError("Enter a query to inspect.");
			setErrorContextKey(contextKey);
			setTrace(null);
			return;
		}
		setLoading(true);
		setError("");
		setErrorContextKey("");
		try {
			const nextTrace = await api.tracePack({
				context,
				project,
				working_set_files: workingSetFiles,
			});
			if (requestId !== latestTraceRequestId.current) {
				return;
			}
			setTrace(nextTrace);
		} catch (err) {
			if (requestId !== latestTraceRequestId.current) {
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
			setErrorContextKey(contextKey);
			setTrace(null);
		} finally {
			if (requestId === latestTraceRequestId.current) {
				setLoading(false);
			}
		}
	};

	const selected =
		visibleTrace?.retrieval.candidates.filter(
			(candidate) => candidate.disposition === "selected",
		) || [];
	const dropped =
		visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "dropped") ||
		[];
	const deduped =
		visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "deduped") ||
		[];
	const trimmed =
		visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "trimmed") ||
		[];

	return open
		? h(
				"div",
				{ className: "feed-inspector" },
				h(
					"div",
					{ className: "feed-card", id: "contextInspectorPanel", style: "margin-top:12px;" },
					[
						h("div", { className: "feed-card-header" }, [
							h("div", { className: "feed-card-title" }, "Context Inspector"),
							h(
								"div",
								{ className: "feed-card-meta" },
								hasInspectorOverride
									? "Tracing an inspector-specific query"
									: "Seeded from the feed search on first open",
							),
						]),
						h("div", { className: "feed-card-body" }, [
							h("input", {
								className: "feed-search",
								onInput: (event) => {
									setInspectorQuery(String((event.currentTarget as HTMLInputElement).value || ""));
									setHasInspectorOverride(true);
									setTrace(null);
									setError("");
									setErrorContextKey("");
								},
								placeholder: "Trace a pack query…",
								value: inspectorQuery,
							}),
							h(
								"div",
								{ className: "section-meta", style: "margin-top:8px;" },
								hasInspectorOverride
									? "Inspector query is independent from the live feed search."
									: "Inspector query was seeded from the feed search and will stay independent until you change it.",
							),
							h("textarea", {
								className: "feed-inspector-files",
								onInput: (event) =>
									setWorkingSetText(
										String((event.currentTarget as HTMLTextAreaElement).value || ""),
									),
								placeholder: "Optional working-set files, one per line",
								rows: 3,
								value: workingSetText,
							}),
							h(
								"div",
								{ style: "display:flex; gap:8px; margin-top:8px; align-items:center;" },
								h(
									"button",
									{
										className: "toggle-button active",
										disabled: loading,
										onClick: () => void runTrace(),
										type: "button",
									},
									loading ? "Tracing…" : "Run trace",
								),
								visibleTrace
									? h(
											"span",
											{ className: "section-meta" },
											`mode=${visibleTrace.mode.selected} · candidates=${visibleTrace.retrieval.candidate_count} · tokens=${visibleTrace.output.estimated_tokens}`,
										)
									: null,
							),
							trace && !visibleTrace
								? h(
										"div",
										{ className: "section-meta", style: "margin-top:8px;" },
										"Trace inputs changed. Run trace again for the current query, project, and working set.",
									)
								: null,
							visibleError
								? h(
										"div",
										{ className: "section-meta", style: "margin-top:8px; color:#d96c6c;" },
										visibleError,
									)
								: null,
						]),
						visibleTrace
							? h(Fragment, null, [
									h(TraceCandidateGroup, { label: "Selected", candidates: selected }),
									h(TraceCandidateGroup, { label: "Dropped", candidates: dropped }),
									h(TraceCandidateGroup, { label: "Deduped", candidates: deduped }),
									h(TraceCandidateGroup, { label: "Trimmed", candidates: trimmed }),
									h("div", { className: "feed-card-body" }, [
										visibleTrace.assembly.collapsed_groups.length
											? h(
													"div",
													{ className: "section-meta" },
													`Collapsed duplicates: ${visibleTrace.assembly.collapsed_groups
														.map(
															(group) => `kept #${group.kept} from [${group.dropped.join(", ")}]`,
														)
														.join(" · ")}`,
												)
											: null,
										visibleTrace.assembly.trim_reasons.length
											? h(
													"div",
													{ className: "section-meta" },
													`Trim reasons: ${visibleTrace.assembly.trim_reasons.join(", ")}`,
												)
											: null,
										h("div", { className: "section-meta" }, "Final pack"),
										h(
											"pre",
											{ style: "white-space:pre-wrap; overflow:auto;" },
											visibleTrace.output.pack_text,
										),
									]),
								])
							: null,
					],
				),
			)
		: null;
}

function FeedTabView({ items, loadingText }: { items: FeedItem[]; loadingText?: string }) {
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
				loadingText || feedMetaText(items.length, hasMorePages()),
			),
			h(
				"div",
				{ className: "feed-controls-right" },
				h("input", {
					className: "feed-search",
					id: "feedSearch",
					onInput: (event) => {
						state.feedQuery = String((event.currentTarget as HTMLInputElement).value || "");
						updateFeedView();
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
						void loadFeedData();
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
						updateFeedView();
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
		h("div", { className: "feed-list", id: "feedList" }, h(FeedList, { items, loadingText })),
	);
}

function renderFeedTab(items: FeedItem[], options?: { loadingText?: string }) {
	const feedTab = document.getElementById("tab-feed");
	if (!feedTab) return false;
	renderIntoFeedMount(feedTab, h(FeedTabView, { items, loadingText: options?.loadingText }));
	const globalLucide = (globalThis as { lucide?: { createIcons: () => void } }).lucide;
	if (globalLucide && !options?.loadingText) {
		globalLucide.createIcons();
	}
	return true;
}

function renderProjectSwitchLoadingState() {
	renderFeedTab([], { loadingText: "Loading selected project..." });
}

/* ── Public API ──────────────────────────────────────────── */

export function initFeedTab() {
	ensureFeedRenderBoundary();
	renderFeedTab(
		state.lastFeedItems,
		state.lastFeedItems.length || state.lastFeedSignature
			? undefined
			: { loadingText: "Loading memories…" },
	);

	if (!feedScrollHandlerBound) {
		window.addEventListener(
			"scroll",
			() => {
				maybeLoadMoreFeedPage();
			},
			{ passive: true },
		);
		feedScrollHandlerBound = true;
	}
}

export function updateFeedTypeToggle() {
	updateFeedView(true);
}

export function updateFeedScopeToggle() {
	updateFeedView(true);
}

export function updateFeedView(force = false) {
	const feedTab = document.getElementById("tab-feed");
	if (!feedTab) return;

	const scrollY = window.scrollY;
	const byType = filterByType(state.lastFeedItems as FeedItem[]);
	const visible = filterByQuery(byType);

	const sig = computeSignature(visible);
	const changed = force || sig !== state.lastFeedSignature;
	state.lastFeedSignature = sig;

	if (changed) {
		renderFeedTab(visible);
	}

	window.scrollTo({ top: scrollY });
	maybeLoadMoreFeedPage();
}

export async function loadFeedData() {
	const project = state.currentProject || "";
	const scopeChanged = state.feedScopeFilter !== lastFeedScope;
	if (project !== lastFeedProject || scopeChanged) {
		resetPagination(project);
		renderProjectSwitchLoadingState();
	}
	const requestGeneration = feedProjectGeneration;

	const observationsLimit = OBSERVATION_PAGE_SIZE;
	const summariesLimit = SUMMARY_PAGE_SIZE;

	const [observations, summaries] = await Promise.all([
		api.loadMemoriesPage(project, {
			limit: observationsLimit,
			offset: 0,
			scope: state.feedScopeFilter,
		}),
		api.loadSummariesPage(project, {
			limit: summariesLimit,
			offset: 0,
			scope: state.feedScopeFilter,
		}),
	]);

	if (requestGeneration !== feedProjectGeneration || project !== (state.currentProject || "")) {
		return;
	}

	const summaryItems = (summaries.items || []) as FeedItem[];
	const observationItems = (observations.items || []) as FeedItem[];
	const filtered = observationItems.filter((i) => !isLowSignalObservation(i));
	const filteredCount = observationItems.length - filtered.length;
	const firstPageFeedItems = [...summaryItems, ...filtered].sort((a, b) => {
		return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
	});
	const feedItems = mergeRefreshFeedItems(state.lastFeedItems as FeedItem[], firstPageFeedItems);

	// Only flag newPulse on genuine incremental arrivals. First-time load has
	// an empty lastFeedItems and every row "looks new" — skip that case so we
	// don't bulk-pulse the whole feed on open/tab-switch/project-switch.
	const previousItems = state.lastFeedItems as FeedItem[];
	const newCount = countNewItems(feedItems, previousItems);
	if (newCount && previousItems.length > 0) {
		const seen = new Set(previousItems.map(itemKey));
		feedItems.forEach((item) => {
			if (!seen.has(itemKey(item))) state.newItemKeys.add(itemKey(item));
		});
	}

	state.pendingFeedItems = null;
	state.lastFeedItems = feedItems;
	state.lastFeedFilteredCount = Math.max(state.lastFeedFilteredCount, filteredCount);
	summaryHasMore = pageHasMore(summaries, summaryItems.length, summariesLimit);
	observationHasMore = pageHasMore(observations, observationItems.length, observationsLimit);
	summaryOffset = Math.max(summaryOffset, pageNextOffset(summaries, summaryItems.length));
	observationOffset = Math.max(
		observationOffset,
		pageNextOffset(observations, observationItems.length),
	);
	lastFeedScope = state.feedScopeFilter;
	updateFeedView();
}
