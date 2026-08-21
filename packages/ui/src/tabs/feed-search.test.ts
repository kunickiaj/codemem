import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../lib/state";

const apiMocks = vi.hoisted(() => ({
	loadMemoriesPage: vi.fn(),
	loadSummariesPage: vi.fn(),
}));
const mountMocks = vi.hoisted(() => ({
	renderIntoFeedMount: vi.fn(),
}));

vi.mock("../lib/api", () => apiMocks);
vi.mock("./feed/data/mount", () => ({
	ensureFeedRenderBoundary: vi.fn(),
	renderIntoFeedMount: mountMocks.renderIntoFeedMount,
}));

import {
	__feedSearchTestHooks,
	FEED_QUERY_DEBOUNCE_MS,
	loadFeedData,
	updateFeedQuery,
} from "./feed";

interface TestPage {
	items: Array<{ id: number; kind: string; title: string; body_text: string }>;
	pagination: { has_more: boolean; next_offset: number | null };
}

function page(id: number): TestPage {
	return {
		items: [
			{
				id,
				kind: "change",
				title: `Item ${id}`,
				body_text: `Long enough body for item ${id}`,
			},
		],
		pagination: { has_more: false, next_offset: null },
	};
}

function shortPage(
	id: number,
	hasMore = false,
	nextOffset: number | null = null,
	text = "x",
): TestPage {
	return {
		items: [{ id, kind: "change", title: text, body_text: text }],
		pagination: { has_more: hasMore, next_offset: nextOffset },
	};
}

type FeedPageOptions = { limit?: number; offset?: number; scope?: string; q?: string };

describe("Feed global search controller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		document.body.innerHTML = "";
		window.scrollTo = vi.fn();
		state.activeTab = "feed";
		state.currentProject = "codemem";
		state.feedScopeFilter = "all";
		state.feedTypeFilter = "all";
		state.feedQuery = "";
		state.lastFeedItems = [];
		state.lastFeedFilteredCount = 0;
		apiMocks.loadMemoriesPage.mockReset();
		apiMocks.loadSummariesPage.mockReset();
		mountMocks.renderIntoFeedMount.mockReset();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("debounces resets with q, ignores older responses, and omits q when cleared", async () => {
		let resolveOldObservations: (value: ReturnType<typeof page>) => void = () => undefined;
		let resolveOldSummaries: (value: ReturnType<typeof page>) => void = () => undefined;
		const oldObservations = new Promise<ReturnType<typeof page>>((resolve) => {
			resolveOldObservations = resolve;
		});
		const oldSummaries = new Promise<ReturnType<typeof page>>((resolve) => {
			resolveOldSummaries = resolve;
		});
		apiMocks.loadMemoriesPage.mockImplementation((_project: string, options?: FeedPageOptions) =>
			options?.q === "old query" ? oldObservations : Promise.resolve(page(2)),
		);
		apiMocks.loadSummariesPage.mockImplementation((_project: string, options?: FeedPageOptions) =>
			options?.q === "old query" ? oldSummaries : Promise.resolve({ ...page(3), items: [] }),
		);

		state.feedQuery = "old query";
		const staleLoad = loadFeedData();
		updateFeedQuery("new");
		updateFeedQuery("new query");

		expect(apiMocks.loadMemoriesPage).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(FEED_QUERY_DEBOUNCE_MS - 1);
		expect(apiMocks.loadMemoriesPage).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		expect(apiMocks.loadMemoriesPage).toHaveBeenLastCalledWith("codemem", {
			limit: 20,
			offset: 0,
			scope: "all",
			q: "new query",
		});
		expect(apiMocks.loadSummariesPage).toHaveBeenLastCalledWith("codemem", {
			limit: 50,
			offset: 0,
			scope: "all",
			q: "new query",
		});
		expect(state.lastFeedItems).toMatchObject([{ id: 2 }]);

		resolveOldObservations(page(1));
		resolveOldSummaries({ ...page(4), items: [] });
		await staleLoad;
		expect(state.lastFeedItems).toMatchObject([{ id: 2 }]);

		updateFeedQuery("");
		await vi.advanceTimersByTimeAsync(FEED_QUERY_DEBOUNCE_MS);
		expect(apiMocks.loadMemoriesPage).toHaveBeenLastCalledWith("codemem", {
			limit: 20,
			offset: 0,
			scope: "all",
			q: undefined,
		});
		expect(apiMocks.loadSummariesPage).toHaveBeenLastCalledWith("codemem", {
			limit: 50,
			offset: 0,
			scope: "all",
			q: undefined,
		});
	});

	it("rejects an older primary response superseded in the same feed context", async () => {
		let resolveOlderObservations: (value: ReturnType<typeof page>) => void = () => undefined;
		let resolveOlderSummaries: (value: ReturnType<typeof page>) => void = () => undefined;
		apiMocks.loadMemoriesPage
			.mockReturnValueOnce(
				new Promise<ReturnType<typeof page>>((resolve) => {
					resolveOlderObservations = resolve;
				}),
			)
			.mockResolvedValueOnce(page(2));
		apiMocks.loadSummariesPage
			.mockReturnValueOnce(
				new Promise<ReturnType<typeof page>>((resolve) => {
					resolveOlderSummaries = resolve;
				}),
			)
			.mockResolvedValueOnce({ ...page(3), items: [] });

		const olderLoad = loadFeedData();
		const newerLoad = loadFeedData();
		await newerLoad;
		expect(state.lastFeedItems).toMatchObject([{ id: 2 }]);

		resolveOlderObservations(page(1));
		resolveOlderSummaries({ ...page(4), items: [] });
		await olderLoad;

		expect(state.lastFeedItems).toMatchObject([{ id: 2 }]);
	});

	it("resets both streams and lets new-query pagination proceed past stale load-more", async () => {
		let resolveOldObservations: (value: ReturnType<typeof page>) => void = () => undefined;
		let resolveOldSummaries: (value: ReturnType<typeof page>) => void = () => undefined;
		const oldObservations = new Promise<ReturnType<typeof page>>((resolve) => {
			resolveOldObservations = resolve;
		});
		const oldSummaries = new Promise<ReturnType<typeof page>>((resolve) => {
			resolveOldSummaries = resolve;
		});
		apiMocks.loadMemoriesPage.mockImplementation((_project: string, options?: FeedPageOptions) => {
			if (options?.q === "old pagination" && options.offset === 20) return oldObservations;
			if (options?.q === "new pagination" && options.offset === 20) return Promise.resolve(page(3));
			return Promise.resolve({
				...page(options?.q === "new pagination" ? 2 : 1),
				pagination: { has_more: true, next_offset: 20 },
			});
		});
		apiMocks.loadSummariesPage.mockImplementation((_project: string, options?: FeedPageOptions) => {
			if (options?.q === "old pagination" && options.offset === 50) return oldSummaries;
			if (options?.q === "new pagination" && options.offset === 50) {
				return Promise.resolve({ ...page(30), items: [] });
			}
			return Promise.resolve({
				...page(10),
				items: [],
				pagination: { has_more: true, next_offset: 50 },
			});
		});

		state.feedQuery = "old pagination";
		await loadFeedData();
		expect(__feedSearchTestHooks.pagination()).toMatchObject({
			observationOffset: 20,
			summaryOffset: 50,
			observationHasMore: true,
			summaryHasMore: true,
		});

		const stalePagination = __feedSearchTestHooks.loadMoreFeedPage();
		const oldGeneration = __feedSearchTestHooks.pagination().generation;
		updateFeedQuery("new pagination");
		expect(__feedSearchTestHooks.pagination()).toMatchObject({
			observationOffset: 0,
			summaryOffset: 0,
			observationHasMore: true,
			summaryHasMore: true,
		});
		expect(__feedSearchTestHooks.pagination().generation).toBeGreaterThan(oldGeneration);

		await vi.advanceTimersByTimeAsync(FEED_QUERY_DEBOUNCE_MS);
		await __feedSearchTestHooks.loadMoreFeedPage();
		expect(apiMocks.loadMemoriesPage).toHaveBeenLastCalledWith("codemem", {
			limit: 20,
			offset: 20,
			scope: "all",
			q: "new pagination",
		});
		expect(apiMocks.loadSummariesPage).toHaveBeenLastCalledWith("codemem", {
			limit: 50,
			offset: 50,
			scope: "all",
			q: "new pagination",
		});
		expect(__feedSearchTestHooks.pagination()).toMatchObject({
			observationOffset: 21,
			summaryOffset: 50,
			observationHasMore: false,
			summaryHasMore: false,
		});

		resolveOldObservations({
			...page(99),
			pagination: { has_more: true, next_offset: 999 },
		});
		resolveOldSummaries({
			...page(100),
			items: [],
			pagination: { has_more: true, next_offset: 999 },
		});
		await stalePagination;
		expect(__feedSearchTestHooks.pagination()).toMatchObject({
			observationOffset: 21,
			summaryOffset: 50,
			observationHasMore: false,
			summaryHasMore: false,
			loadMoreInFlightGeneration: null,
		});
		expect(state.lastFeedItems.map((item) => (item as { id: number }).id)).toEqual([2, 3]);
	});

	it("keeps short server-matched observations and their pagination state", async () => {
		state.feedQuery = "7";
		apiMocks.loadMemoriesPage.mockImplementation((_project: string, options?: FeedPageOptions) =>
			Promise.resolve(
				options?.offset === 20 ? shortPage(8, false, null, "7") : shortPage(7, true, 20),
			),
		);
		apiMocks.loadSummariesPage.mockResolvedValue({ ...page(30), items: [] });

		await loadFeedData();

		expect(state.lastFeedItems.map((item) => (item as { id: number }).id)).toEqual([7]);
		expect(__feedSearchTestHooks.pagination()).toMatchObject({
			observationOffset: 20,
			observationHasMore: true,
		});

		await __feedSearchTestHooks.loadMoreFeedPage();
		expect(state.lastFeedItems.map((item) => (item as { id: number }).id)).toEqual([7, 8]);
		expect(__feedSearchTestHooks.pagination()).toMatchObject({
			observationOffset: 21,
			observationHasMore: false,
		});
	});

	it("keeps low-signal suppression on unfiltered initial and later pages", async () => {
		apiMocks.loadMemoriesPage.mockImplementation((_project: string, options?: FeedPageOptions) =>
			Promise.resolve(options?.offset === 20 ? shortPage(8) : shortPage(7, true, 20)),
		);
		apiMocks.loadSummariesPage.mockResolvedValue({ ...page(30), items: [] });

		await loadFeedData();
		expect(state.lastFeedItems).toEqual([]);
		expect(__feedSearchTestHooks.pagination()).toMatchObject({
			observationOffset: 20,
			observationHasMore: true,
		});

		await __feedSearchTestHooks.loadMoreFeedPage();
		expect(state.lastFeedItems).toEqual([]);
		expect(state.lastFeedFilteredCount).toBe(2);
		expect(__feedSearchTestHooks.pagination().observationHasMore).toBe(false);
	});

	it("does not start scroll pagination while the primary Feed page is loading", async () => {
		let resolveObservations: (value: ReturnType<typeof page>) => void = () => undefined;
		let resolveSummaries: (value: ReturnType<typeof page>) => void = () => undefined;
		apiMocks.loadMemoriesPage.mockReturnValue(
			new Promise<ReturnType<typeof page>>((resolve) => {
				resolveObservations = resolve;
			}),
		);
		apiMocks.loadSummariesPage.mockReturnValue(
			new Promise<ReturnType<typeof page>>((resolve) => {
				resolveSummaries = resolve;
			}),
		);

		state.feedQuery = "loading";
		const initialLoad = loadFeedData();
		expect(__feedSearchTestHooks.pagination().primaryLoadInFlightGeneration).toBe(
			__feedSearchTestHooks.pagination().generation,
		);

		__feedSearchTestHooks.maybeLoadMoreFeedPage();
		expect(apiMocks.loadMemoriesPage).toHaveBeenCalledTimes(1);
		expect(apiMocks.loadSummariesPage).toHaveBeenCalledTimes(1);
		expect(apiMocks.loadMemoriesPage).toHaveBeenLastCalledWith(
			"codemem",
			expect.objectContaining({ offset: 0 }),
		);

		resolveObservations(page(1));
		resolveSummaries({ ...page(2), items: [] });
		await initialLoad;
		expect(__feedSearchTestHooks.pagination().primaryLoadInFlightGeneration).toBeNull();
	});

	it("treats whitespace-only query edits as the same effective query", async () => {
		state.feedQuery = "needle";
		apiMocks.loadMemoriesPage.mockResolvedValue(page(1));
		apiMocks.loadSummariesPage.mockResolvedValue({ ...page(2), items: [] });
		await loadFeedData();
		const generation = __feedSearchTestHooks.pagination().generation;

		updateFeedQuery(" needle ");
		await vi.advanceTimersByTimeAsync(FEED_QUERY_DEBOUNCE_MS);

		expect(state.feedQuery).toBe(" needle ");
		expect(__feedSearchTestHooks.pagination().generation).toBe(generation);
		expect(apiMocks.loadMemoriesPage).toHaveBeenCalledTimes(1);
		expect(apiMocks.loadSummariesPage).toHaveBeenCalledTimes(1);
	});

	it("does not start scroll pagination while a query debounce is pending", async () => {
		state.feedQuery = "old";
		apiMocks.loadMemoriesPage.mockResolvedValue({
			...page(1),
			pagination: { has_more: true, next_offset: 20 },
		});
		apiMocks.loadSummariesPage.mockResolvedValue({ ...page(2), items: [] });
		await loadFeedData();

		updateFeedQuery("new");
		state.activeTab = "feed";
		__feedSearchTestHooks.maybeLoadMoreFeedPage();

		expect(apiMocks.loadMemoriesPage).toHaveBeenCalledTimes(1);
		expect(apiMocks.loadSummariesPage).toHaveBeenCalledTimes(1);
		state.activeTab = "projects";
		await vi.advanceTimersByTimeAsync(FEED_QUERY_DEBOUNCE_MS);
		expect(apiMocks.loadMemoriesPage).toHaveBeenCalledTimes(2);
		expect(apiMocks.loadSummariesPage).toHaveBeenCalledTimes(2);
	});

	it("shows an error for a failed debounced query and clears it on retry", async () => {
		document.body.innerHTML = '<section id="tab-feed"></section>';
		apiMocks.loadMemoriesPage.mockRejectedValue(new Error("viewer restarting"));
		apiMocks.loadSummariesPage.mockResolvedValue({ ...page(2), items: [] });

		updateFeedQuery("unavailable");
		expect(mountMocks.renderIntoFeedMount.mock.lastCall?.[1].props.loadingText).toBe(
			"Searching memories…",
		);

		await vi.advanceTimersByTimeAsync(FEED_QUERY_DEBOUNCE_MS);

		expect(mountMocks.renderIntoFeedMount.mock.lastCall?.[1].props.loadingText).toBeUndefined();
		expect(mountMocks.renderIntoFeedMount.mock.lastCall?.[1].props.errorText).toBe(
			"Feed unavailable. Refresh and try again.",
		);
		expect(__feedSearchTestHooks.pagination()).toMatchObject({
			observationHasMore: false,
			summaryHasMore: false,
		});
		expect(apiMocks.loadMemoriesPage).toHaveBeenCalledTimes(1);
		expect(apiMocks.loadSummariesPage).toHaveBeenCalledTimes(1);

		apiMocks.loadMemoriesPage.mockResolvedValue(page(3));
		await loadFeedData();

		expect(mountMocks.renderIntoFeedMount.mock.lastCall?.[1].props.loadingText).toBeUndefined();
		expect(mountMocks.renderIntoFeedMount.mock.lastCall?.[1].props.errorText).toBeUndefined();
	});
});
