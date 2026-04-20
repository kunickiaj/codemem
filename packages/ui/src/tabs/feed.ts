/* Feed tab — memory feed rendering, filtering, search. */

import { h } from "preact";
import * as api from "../lib/api";
import { state } from "../lib/state";

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

export {
	packTraceContextKey,
	parseInspectorWorkingSet,
	syncInspectorQueryDraft,
} from "./feed/inspector";

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

import { FeedTabView, type FeedViewOps } from "./feed/view";

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

const feedOps: FeedViewOps = {
	replaceFeedItem,
	removeFeedItem,
	updateFeedView: (force?: boolean) => updateFeedView(force),
	loadFeedData: () => loadFeedData(),
	hasMorePages,
};

function renderFeedTab(items: FeedItem[], options?: { loadingText?: string }) {
	const feedTab = document.getElementById("tab-feed");
	if (!feedTab) return false;
	renderIntoFeedMount(
		feedTab,
		h(FeedTabView, { items, loadingText: options?.loadingText, ops: feedOps }),
	);
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
