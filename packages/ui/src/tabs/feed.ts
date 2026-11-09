/* Feed tab — memory feed rendering, filtering, search. */

import { h } from "preact";
import * as api from "../lib/api";
import { FeedCursorUnavailableError } from "../lib/api/feed-request";
import type { ReadRequestOptions } from "../lib/read-request";
import { state } from "../lib/state";

/* ── Types ───────────────────────────────────────────────── */

export type { FeedItem, FeedItemMetadata } from "./feed/types";

import { feedItemMatchesQuery } from "./feed/data/card-view-model";
import { completeFirstRunStep } from "./feed/data/first-run-guide";
import {
	isLowSignalObservation,
	itemKey,
	mergeFeedItems,
	mergeRefreshFeedItems,
} from "./feed/data/helpers";
import {
	countNewItems,
	feedPagingOptions,
	initialFeedProgress,
	isNearFeedBottom,
	nextFeedProgress,
	OBSERVATION_PAGE_SIZE,
	SUMMARY_PAGE_SIZE,
} from "./feed/data/pagination";
import type { FeedItem } from "./feed/types";

/* ── Module state ─────────────────────────────────────────── */

let lastFeedProject = "";
let observationProgress = initialFeedProgress();
let summaryProgress = initialFeedProgress();
let loadMoreRequestSequence = 0;
let loadMoreInFlight: { generation: number; requestId: number } | null = null;
let primaryLoadRequestSequence = 0;
let primaryLoadInFlight: { generation: number; requestId: number } | null = null;
let feedScrollHandlerBound = false;
let feedInspectHandlerBound = false;
let feedProjectGeneration = 0;
let lastFeedScope = "all";
let lastFeedQuery = "";
let lastFeedActor = state.viewerActorId;
let feedQueryTimer: ReturnType<typeof setTimeout> | null = null;
let feedLoadError = "";

export const FEED_QUERY_DEBOUNCE_MS = 250;

import { ensureFeedRenderBoundary, renderIntoFeedMount } from "./feed/data/mount";

function resetPagination(project: string) {
	lastFeedProject = project;
	lastFeedScope = state.feedScopeFilter;
	lastFeedQuery = state.feedQuery.trim();
	lastFeedActor = state.viewerActorId;
	feedLoadError = "";
	feedProjectGeneration += 1;
	observationProgress = initialFeedProgress();
	summaryProgress = initialFeedProgress();
	state.lastFeedItems = [];
	state.pendingFeedItems = null;
	state.lastFeedFilteredCount = 0;
	state.lastFeedSignature = "";
	state.newItemKeys.clear();
}

function hasMorePages(): boolean {
	return observationProgress.hasMore || summaryProgress.hasMore;
}

function hasKnownFeedActorChanged(previous: string | null, current: string | null): boolean {
	return previous !== null && current !== null && previous !== current;
}

function adoptResolvedFeedActor(): void {
	if (lastFeedActor === null && state.viewerActorId !== null) {
		lastFeedActor = state.viewerActorId;
	}
}

export {
	packTraceContextKey,
	parseInspectorWorkingSet,
	syncInspectorQueryDraft,
} from "./feed/data/inspector-query";

function replaceFeedItem(updatedItem: FeedItem) {
	const key = itemKey(updatedItem);
	state.lastFeedItems = (state.lastFeedItems as FeedItem[]).map((item) =>
		itemKey(item) === key ? updatedItem : item,
	);
}

export function removeFeedItem(memoryId: number) {
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
		state.itemExpandState.delete(key);
		for (const expandKey of Array.from(state.itemExpandState.keys())) {
			if (expandKey.startsWith(`${key}:`)) state.itemExpandState.delete(expandKey);
		}
	}
}

import { FeedTabView } from "./feed/components/FeedTabView";
import type { FeedViewOps } from "./feed/types";

/* ── Filtering ───────────────────────────────────────────── */

import { computeSignature, filterByType } from "./feed/data/filter";

function prepareFeedResults(items: FeedItem[], query: string): FeedItem[] {
	if (filterByType(items).some((item) => feedItemMatchesQuery(item, query))) {
		completeFirstRunStep("find");
	}
	return items.sort((a, b) => {
		return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
	});
}

type FeedRequestContext = {
	generation: number;
	project: string;
	query: string;
	scope: string;
	actor: string | null;
};

function captureFeedContext(): FeedRequestContext {
	return {
		generation: feedProjectGeneration,
		project: state.currentProject || "",
		query: state.feedQuery.trim(),
		scope: state.feedScopeFilter,
		actor: state.viewerActorId,
	};
}

function isCurrentFeedContext(context: FeedRequestContext): boolean {
	return (
		context.generation === feedProjectGeneration &&
		context.project === (state.currentProject || "") &&
		context.query === state.feedQuery.trim() &&
		context.scope === state.feedScopeFilter &&
		!hasKnownFeedActorChanged(context.actor ?? lastFeedActor, state.viewerActorId)
	);
}

async function requestFeedPages(
	context: FeedRequestContext,
	options: { head: boolean; signal?: AbortSignal },
) {
	const common = {
		view: "feed" as const,
		scope: context.scope,
		q: context.query || undefined,
		signal: options.signal,
	};
	const observationsRequested = options.head || observationProgress.hasMore;
	const summariesRequested = options.head || summaryProgress.hasMore;
	const [observations, summaries] = await Promise.all([
		observationsRequested
			? api.loadMemoriesPage(context.project, {
					...common,
					limit: OBSERVATION_PAGE_SIZE,
					...feedPagingOptions(observationProgress, options),
				})
			: Promise.resolve({ items: [] }),
		summariesRequested
			? api.loadSummariesPage(context.project, {
					...common,
					limit: SUMMARY_PAGE_SIZE,
					...feedPagingOptions(summaryProgress, options),
				})
			: Promise.resolve({ items: [] }),
	]);
	return { observations, summaries, observationsRequested, summariesRequested };
}

function applyFeedProgress(
	pages: Awaited<ReturnType<typeof requestFeedPages>>,
	options: { head: boolean },
) {
	const observations = pages.observationsRequested
		? nextFeedProgress({
				previous: observationProgress,
				payload: pages.observations,
				limit: OBSERVATION_PAGE_SIZE,
				...options,
			})
		: observationProgress;
	const summaries = pages.summariesRequested
		? nextFeedProgress({
				previous: summaryProgress,
				payload: pages.summaries,
				limit: SUMMARY_PAGE_SIZE,
				...options,
			})
		: summaryProgress;
	// Validate both pages before changing either continuation or any visible rows.
	adoptResolvedFeedActor();
	observationProgress = observations;
	summaryProgress = summaries;
}

async function restartFeedInOffsetMode(
	context: FeedRequestContext,
	options: ReadRequestOptions = {},
) {
	if (!isCurrentFeedContext(context) || options.signal?.aborted) return;
	resetPagination(context.project);
	observationProgress = initialFeedProgress("offset");
	summaryProgress = initialFeedProgress("offset");
	renderFeedLoadingState();
	// Do not carry an explicit restart flag into the offset retry and renegotiate cursors.
	await loadFeedData({ signal: options.signal });
}

function canRestartInOffsetMode(error: unknown): boolean {
	return (
		error instanceof FeedCursorUnavailableError &&
		(observationProgress.mode !== "offset" || summaryProgress.mode !== "offset")
	);
}

function showFeedLoadError() {
	feedLoadError = "Feed unavailable. Refresh and try again.";
	updateFeedView(true);
}

function appendFeedPages(pages: Awaited<ReturnType<typeof requestFeedPages>>, query: string) {
	applyFeedProgress(pages, { head: false });
	const summaryItems = (pages.summaries.items || []) as FeedItem[];
	const observationItems = (pages.observations.items || []) as FeedItem[];
	const filtered = query
		? observationItems
		: observationItems.filter((i) => !isLowSignalObservation(i));
	state.lastFeedFilteredCount += observationItems.length - filtered.length;
	const incoming = prepareFeedResults([...summaryItems, ...filtered], query);
	state.lastFeedItems = mergeFeedItems(state.lastFeedItems as FeedItem[], incoming);
	updateFeedView();
}

async function loadMoreFeedPage() {
	if (!hasMorePages() || feedLoadError) return;
	const context = captureFeedContext();
	if (shouldRestartFeedPagination(context.project, context.query, {})) return;
	if (loadMoreInFlight?.generation === context.generation) return;
	const requestId = ++loadMoreRequestSequence;
	loadMoreInFlight = { generation: context.generation, requestId };
	try {
		const pages = await requestFeedPages(context, { head: false });
		if (!isCurrentFeedContext(context) || loadMoreInFlight?.requestId !== requestId) return;
		appendFeedPages(pages, context.query);
	} catch (error) {
		if (!isCurrentFeedContext(context) || loadMoreInFlight?.requestId !== requestId) return;
		if (canRestartInOffsetMode(error)) {
			await restartFeedInOffsetMode(context).catch(() => undefined);
			return;
		}
		showFeedLoadError();
	} finally {
		if (loadMoreInFlight?.requestId === requestId) loadMoreInFlight = null;
	}
}

export const __feedSearchTestHooks = {
	loadMoreFeedPage,
	resetPagination,
	maybeLoadMoreFeedPage,
	pagination: () => ({
		observationOffset: observationProgress.offset,
		summaryOffset: summaryProgress.offset,
		observationHasMore: observationProgress.hasMore,
		summaryHasMore: summaryProgress.hasMore,
		observationMode: observationProgress.mode,
		summaryMode: summaryProgress.mode,
		observationNextCursor: observationProgress.nextCursor,
		summaryNextCursor: summaryProgress.nextCursor,
		loadMoreInFlightGeneration: loadMoreInFlight?.generation ?? null,
		primaryLoadInFlightGeneration: primaryLoadInFlight?.generation ?? null,
		generation: feedProjectGeneration,
	}),
};

function maybeLoadMoreFeedPage() {
	if (state.activeTab !== "feed") return;
	if (feedQueryTimer) return;
	if (feedLoadError) return;
	if (primaryLoadInFlight) return;
	if (!hasMorePages()) return;
	if (!isNearFeedBottom()) return;
	void loadMoreFeedPage();
}

const feedOps: FeedViewOps = {
	replaceFeedItem,
	removeFeedItem,
	updateFeedView: (force?: boolean) => updateFeedView(force),
	loadFeedData: (options) => loadFeedData(options),
	updateFeedQuery: (query: string) => updateFeedQuery(query),
	hasMorePages,
};

function renderFeedTab(items: FeedItem[], options?: { errorText?: string; loadingText?: string }) {
	const feedTab = document.getElementById("tab-feed");
	if (!feedTab) return false;
	renderIntoFeedMount(
		feedTab,
		h(FeedTabView, {
			errorText: options?.errorText,
			items,
			loadingText: options?.loadingText,
			ops: feedOps,
		}),
	);
	const globalLucide = (globalThis as { lucide?: { createIcons: () => void } }).lucide;
	if (globalLucide && !options?.loadingText) {
		globalLucide.createIcons();
	}
	return true;
}

function renderFeedLoadingState(message = "Loading selected project...") {
	renderFeedTab([], { loadingText: message });
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
	if (!feedInspectHandlerBound) {
		document.getElementById("tab-feed")?.addEventListener("click", (event) => {
			if ((event.target as Element | null)?.closest(".feed-item button.feed-title")) {
				completeFirstRunStep("inspect");
			}
		});
		feedInspectHandlerBound = true;
	}
}

export function updateFeedTypeToggle() {
	updateFeedView(true);
}

export function updateFeedScopeToggle() {
	updateFeedView(true);
}

export function updateFeedQuery(query: string) {
	if (query === state.feedQuery) return;
	const previousQuery = state.feedQuery.trim();
	state.feedQuery = query;
	if (query.trim() === previousQuery) return;
	resetPagination(state.currentProject || "");
	renderFeedLoadingState("Searching memories…");
	if (feedQueryTimer) clearTimeout(feedQueryTimer);
	feedQueryTimer = setTimeout(() => {
		feedQueryTimer = null;
		void loadFeedData().catch(() => undefined);
	}, FEED_QUERY_DEBOUNCE_MS);
}

export function updateFeedView(force = false) {
	// Status and Feed start concurrently. Resolve startup identity once without rewinding pages.
	adoptResolvedFeedActor();
	const feedTab = document.getElementById("tab-feed");
	if (!feedTab) return;

	const scrollY = window.scrollY;
	const visible = filterByType(state.lastFeedItems as FeedItem[]);

	const sig = computeSignature(visible);
	const changed = force || sig !== state.lastFeedSignature;
	state.lastFeedSignature = sig;

	if (changed) {
		renderFeedTab(visible, { errorText: feedLoadError || undefined });
	}

	window.scrollTo({ top: scrollY });
	if (!state.viewerReconnectOpen) maybeLoadMoreFeedPage();
}

function isCurrentFeedLoad(context: FeedRequestContext, requestId: number): boolean {
	return ownsPrimaryFeedLoad(context.generation, requestId) && isCurrentFeedContext(context);
}

function ownsPrimaryFeedLoad(requestGeneration: number, requestId: number): boolean {
	return (
		primaryLoadInFlight?.generation === requestGeneration &&
		primaryLoadInFlight.requestId === requestId
	);
}

function shouldRestartFeedPagination(
	project: string,
	query: string,
	options: { restart?: boolean },
): boolean {
	return Boolean(
		options.restart ||
			project !== lastFeedProject ||
			state.feedScopeFilter !== lastFeedScope ||
			hasKnownFeedActorChanged(lastFeedActor, state.viewerActorId) ||
			query !== lastFeedQuery,
	);
}

function refreshFeedPages(pages: Awaited<ReturnType<typeof requestFeedPages>>, query: string) {
	applyFeedProgress(pages, { head: true });
	const summaryItems = (pages.summaries.items || []) as FeedItem[];
	const observationItems = (pages.observations.items || []) as FeedItem[];
	const filtered = query
		? observationItems
		: observationItems.filter((i) => !isLowSignalObservation(i));
	const filteredCount = observationItems.length - filtered.length;
	const firstPageFeedItems = prepareFeedResults([...summaryItems, ...filtered], query);
	const previousItems = state.lastFeedItems as FeedItem[];
	const feedItems = mergeRefreshFeedItems(previousItems, firstPageFeedItems);
	const newCount = countNewItems(feedItems, previousItems);
	if (newCount && previousItems.length > 0) {
		const seen = new Set(previousItems.map(itemKey));
		feedItems.forEach((item) => {
			if (!seen.has(itemKey(item))) state.newItemKeys.add(itemKey(item));
		});
	}
	state.pendingFeedItems = null;
	state.lastFeedItems = feedItems;
	feedLoadError = "";
	state.lastFeedFilteredCount = Math.max(state.lastFeedFilteredCount, filteredCount);
}

function preparePrimaryFeedLoad(options: { restart?: boolean }) {
	const project = state.currentProject || "";
	const query = state.feedQuery.trim();
	const queryChanged = query !== lastFeedQuery;
	if (shouldRestartFeedPagination(project, query, options)) {
		resetPagination(project);
		renderFeedLoadingState(queryChanged ? "Searching memories…" : undefined);
	}
	adoptResolvedFeedActor();
	return captureFeedContext();
}

function clearFeedLoadError(): boolean {
	const recoveringFromLoadError = Boolean(feedLoadError);
	if (!recoveringFromLoadError) return false;
	feedLoadError = "";
	if (state.lastFeedItems.length > 0) {
		updateFeedView(true);
	} else {
		renderFeedLoadingState(state.feedQuery.trim() ? "Searching memories…" : undefined);
	}
	return true;
}

async function handlePrimaryFeedError(options: {
	error: unknown;
	context: FeedRequestContext;
	requestId: number;
	requestOptions: ReadRequestOptions;
}) {
	const { error, context, requestId, requestOptions } = options;
	if (requestOptions.signal?.aborted) return;
	if (!isCurrentFeedLoad(context, requestId)) throw error;
	if (canRestartInOffsetMode(error)) {
		await restartFeedInOffsetMode(context, requestOptions);
		return;
	}
	showFeedLoadError();
	throw error;
}

export async function loadFeedData(options: ReadRequestOptions & { restart?: boolean } = {}) {
	const context = preparePrimaryFeedLoad(options);
	const requestId = ++primaryLoadRequestSequence;
	primaryLoadInFlight = { generation: context.generation, requestId };
	const recoveringFromLoadError = clearFeedLoadError();
	try {
		const pages = await requestFeedPages(context, { head: true, signal: options.signal });
		if (options.signal?.aborted || !isCurrentFeedLoad(context, requestId)) return;
		refreshFeedPages(pages, context.query);
		if (ownsPrimaryFeedLoad(context.generation, requestId)) {
			primaryLoadInFlight = null;
		}
		updateFeedView(recoveringFromLoadError);
	} catch (error) {
		await handlePrimaryFeedError({ error, context, requestId, requestOptions: options });
	} finally {
		if (ownsPrimaryFeedLoad(context.generation, requestId)) {
			primaryLoadInFlight = null;
		}
	}
}
