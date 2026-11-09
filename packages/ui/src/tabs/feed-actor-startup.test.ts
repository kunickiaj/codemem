import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../lib/state";

const api = vi.hoisted(() => ({
	loadMemoriesPage: vi.fn(),
	loadSummariesPage: vi.fn(),
	loadViewerStatus: vi.fn(),
}));
const mount = vi.hoisted(() => ({ renderIntoFeedMount: vi.fn() }));
vi.mock("../lib/api", () => api);
vi.mock("./feed/data/mount", () => ({
	ensureFeedRenderBoundary: vi.fn(),
	renderIntoFeedMount: mount.renderIntoFeedMount,
}));

import { __feedSearchTestHooks as hooks, loadFeedData } from "./feed";
import { refreshViewerStatus } from "./health/lifecycle";

function page(id: number | null, next: string | null) {
	return {
		items:
			id === null
				? []
				: [
						{
							id,
							kind: "change",
							title: `Memory ${id}`,
							body_text: "A durable detail from the garden.",
						},
					],
		pagination: {
			limit: 20,
			offset: null,
			next_offset: null,
			has_more: next !== null,
			paging: "cursor",
			next_cursor: next,
		},
	};
}
function legacy(id: number, next: number | null) {
	return {
		items: page(id, null).items,
		pagination: { has_more: next !== null, next_offset: next },
	};
}
function deferred() {
	let resolve = (_value: ReturnType<typeof page>) => {};
	const promise = new Promise<ReturnType<typeof page>>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function ids() {
	return state.lastFeedItems.map((item) => item.id);
}
beforeEach(() => {
	localStorage.clear();
	document.body.innerHTML = '<section id="tab-feed"></section>';
	vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(100_000);
	window.scrollTo = vi.fn();
	state.activeTab = "feed";
	state.currentProject = "garden";
	state.feedScopeFilter = "all";
	state.feedTypeFilter = "all";
	state.feedQuery = "";
	state.viewerActorId = null;
	hooks.resetPagination("garden");
	api.loadMemoriesPage.mockReset().mockResolvedValue(page(null, null));
	api.loadSummariesPage.mockReset().mockResolvedValue(page(null, null));
	api.loadViewerStatus.mockReset().mockResolvedValue({ identity: { actor_id: "actor-a" } });
	mount.renderIntoFeedMount.mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("Feed startup identity resolution", () => {
	it("renders the pending initial head when status resolves null to known without another request", async () => {
		// Arrange: startup runs Feed and lightweight status concurrently.
		const head = deferred();
		api.loadMemoriesPage.mockReturnValueOnce(head.promise);
		const generation = hooks.pagination().generation;
		// Act
		const pending = loadFeedData();
		await refreshViewerStatus();
		head.resolve(page(1, "first"));
		await pending;
		// Assert: the first response renders immediately instead of waiting for a poll.
		expect(ids()).toEqual([1]);
		expect(api.loadMemoriesPage).toHaveBeenCalledTimes(1);
		expect(api.loadSummariesPage).toHaveBeenCalledTimes(1);
		expect(hooks.pagination().generation).toBe(generation);
		expect(mount.renderIntoFeedMount).toHaveBeenCalled();
	});

	it.each(
		[
			{ mode: "cursor", exhausted: false },
			{ mode: "cursor", exhausted: true },
			{ mode: "offset", exhausted: false },
			{ mode: "offset", exhausted: true },
		].flatMap((fixture) => [true, false].map((statusFirst) => ({ ...fixture, statusFirst }))),
	)(
		"adopts null identity without resetting $mode progress, exhausted=$exhausted, statusBeforeMore=$statusFirst",
		async ({ mode, exhausted, statusFirst }) => {
			// Arrange: Feed responds before viewer status, and the reader pages once.
			if (mode === "cursor")
				api.loadMemoriesPage
					.mockResolvedValueOnce(page(1, "first"))
					.mockResolvedValueOnce(page(2, exhausted ? null : "deep"));
			else
				api.loadMemoriesPage
					.mockResolvedValueOnce(legacy(1, 20))
					.mockResolvedValueOnce(legacy(2, exhausted ? null : 40));
			await loadFeedData();
			const generation = hooks.pagination().generation;
			if (statusFirst) await refreshViewerStatus();
			await hooks.loadMoreFeedPage();
			const before = hooks.pagination();
			// Act
			if (!statusFirst) await refreshViewerStatus();
			api.loadMemoriesPage.mockResolvedValueOnce(
				mode === "cursor" ? page(3, "head") : legacy(3, 20),
			);
			await loadFeedData();
			// Assert: actor discovery cannot discard older rows or renegotiate streams.
			expect(hooks.pagination()).toEqual(before);
			expect(hooks.pagination().generation).toBe(generation);
			expect(ids()).toEqual(expect.arrayContaining([1, 2, 3]));
			const calls = api.loadMemoriesPage.mock.calls.length;
			await hooks.loadMoreFeedPage();
			if (exhausted) expect(api.loadMemoriesPage).toHaveBeenCalledTimes(calls);
			else if (mode === "cursor")
				expect(api.loadMemoriesPage.mock.lastCall?.[1]).toMatchObject({
					paging: "cursor",
					cursor: "deep",
				});
			else expect(api.loadMemoriesPage.mock.lastCall?.[1]).toMatchObject({ offset: 40 });
		},
	);

	it("does not let an unresolved startup response return after a subsequent known actor switch", async () => {
		// Arrange
		const old = deferred();
		api.loadMemoriesPage.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(2, "actor-b"));
		const pending = loadFeedData();
		await refreshViewerStatus();
		const generation = hooks.pagination().generation;
		api.loadViewerStatus.mockResolvedValueOnce({ identity: { actor_id: "actor-b" } });
		// Act: the known switch must trigger a fresh Feed immediately.
		await refreshViewerStatus();
		old.resolve(page(99, "stale-startup"));
		await pending;
		// Assert
		expect(api.loadMemoriesPage).toHaveBeenCalledTimes(2);
		expect(ids()).toEqual([2]);
		expect(hooks.pagination().generation).toBeGreaterThan(generation);
		expect(api.loadMemoriesPage.mock.lastCall?.[1].cursor).toBeUndefined();
	});
});
