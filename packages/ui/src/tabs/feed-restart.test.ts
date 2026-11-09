import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { state } from "../lib/state";

const api = vi.hoisted(() => ({ loadMemoriesPage: vi.fn(), loadSummariesPage: vi.fn() }));
vi.mock("../lib/api", () => api);
vi.mock("./feed/data/mount", () => ({
	ensureFeedRenderBoundary: vi.fn(),
	renderIntoFeedMount: vi.fn(),
}));

import { __feedSearchTestHooks, loadFeedData } from "./feed";

afterEach(() => vi.unstubAllGlobals());

function page(id: number, nextOffset: number | null) {
	return {
		items: [
			{
				id,
				kind: "change",
				title: `Memory ${id}`,
				body_text: "A durable stored detail.",
				created_at: id === 1 ? "2026-05-26T12:00:00Z" : "2026-05-25T12:00:00Z",
			},
		],
		pagination: { has_more: nextOffset !== null, next_offset: nextOffset },
	};
}

beforeEach(() => {
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	document.body.innerHTML = "";
	state.currentProject = "garden";
	state.feedScopeFilter = "all";
	state.feedTypeFilter = "all";
	state.feedQuery = "";
	__feedSearchTestHooks.resetPagination("garden");
	api.loadMemoriesPage.mockReset();
	api.loadSummariesPage.mockReset();
	api.loadSummariesPage.mockResolvedValue({
		items: [],
		pagination: { has_more: false, next_offset: null },
	});
});

it.each([false, true])(
	"retains older rows only without an explicit restart: %s",
	async (restart) => {
		// Arrange: load an older row beyond the refreshed first page.
		api.loadMemoriesPage
			.mockResolvedValueOnce(page(1, 20))
			.mockResolvedValueOnce(page(2, 40))
			.mockResolvedValue(page(1, 20));
		await loadFeedData();
		await __feedSearchTestHooks.loadMoreFeedPage();
		expect(state.lastFeedItems.map((item) => item.id)).toEqual([1, 2]);
		const generation = __feedSearchTestHooks.pagination().generation;
		state.lastFeedFilteredCount = 9;

		// Act: routine head refresh preserves history, changed-context reload restarts it.
		await loadFeedData({ restart });

		// Assert: restart discards the stale older card and resets pagination progress.
		expect(api.loadMemoriesPage).toHaveBeenLastCalledWith(
			"garden",
			expect.objectContaining(
				restart ? { paging: "cursor", view: "feed" } : { offset: 0, view: "feed" },
			),
		);
		expect(api.loadSummariesPage).toHaveBeenLastCalledWith(
			"garden",
			expect.objectContaining(
				restart ? { paging: "cursor", view: "feed" } : { offset: 0, view: "feed" },
			),
		);
		expect(state.lastFeedItems.map((item) => item.id)).toEqual(restart ? [1] : [1, 2]);
		expect(state.lastFeedFilteredCount).toBe(restart ? 0 : 9);
		expect(__feedSearchTestHooks.pagination()).toMatchObject({
			observationOffset: restart ? 20 : 40,
			summaryOffset: 0,
			observationHasMore: true,
			summaryHasMore: false,
			generation: generation + Number(restart),
		});
	},
);
