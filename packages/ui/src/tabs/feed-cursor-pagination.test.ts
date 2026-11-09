import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMemoriesPage as requestMemories } from "../lib/api/memories";
import { state } from "../lib/state";

const api = vi.hoisted(() => ({ loadMemoriesPage: vi.fn(), loadSummariesPage: vi.fn() }));
const mount = vi.hoisted(() => ({ renderIntoFeedMount: vi.fn() }));
vi.mock("../lib/api", () => api);
vi.mock("./feed/data/mount", () => ({
	ensureFeedRenderBoundary: vi.fn(),
	renderIntoFeedMount: mount.renderIntoFeedMount,
}));

import { __feedSearchTestHooks as hooks, loadFeedData } from "./feed";

function page(id: number | null, next: string | null, kind = "change") {
	return {
		items:
			id === null
				? []
				: [
						{
							id,
							kind,
							title: `Memory ${id}`,
							body_text: "A durable detail from the garden.",
							created_at: "2026-05-25T12:00:00Z",
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
function deferred() {
	let resolve = (_value: ReturnType<typeof page>) => {};
	const promise = new Promise<ReturnType<typeof page>>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function options(limit: number, cursor?: string) {
	const result = { view: "feed", paging: "cursor", limit, scope: "all", q: undefined };
	if (cursor !== undefined) return { ...result, cursor };
	return result;
}
function ids() {
	return state.lastFeedItems.map((item) => item.id);
}

async function unavailableError() {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ error: "cursor_unavailable" }), { status: 409 }),
			),
	);
	try {
		await requestMemories("garden", { view: "feed", paging: "cursor" });
		throw new Error("Expected cursor_unavailable rejection");
	} catch (error) {
		return error;
	} finally {
		vi.unstubAllGlobals();
	}
}
async function advance() {
	api.loadMemoriesPage
		.mockResolvedValueOnce(page(1, "observation:first"))
		.mockResolvedValueOnce(page(2, "observation:deep"));
	api.loadSummariesPage
		.mockResolvedValueOnce(page(11, "summary:first", "session_summary"))
		.mockResolvedValueOnce(page(12, "summary:deep", "session_summary"));
	await loadFeedData();
	await hooks.loadMoreFeedPage();
}
beforeEach(() => {
	localStorage.clear();
	document.body.innerHTML = '<section id="tab-feed"></section>';
	vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(100_000);
	window.scrollTo = vi.fn();
	state.currentProject = "garden";
	state.feedScopeFilter = "all";
	state.feedTypeFilter = "all";
	state.feedQuery = "";
	state.viewerActorId = "actor-a";
	state.activeTab = "feed";
	hooks.resetPagination("garden");
	api.loadMemoriesPage.mockReset().mockResolvedValue(page(null, null));
	api.loadSummariesPage.mockReset().mockResolvedValue(page(null, null));
	mount.renderIntoFeedMount.mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Feed independent cursor streams", () => {
	it("negotiates both streams and sends their opaque continuations independently", async () => {
		// Arrange
		api.loadMemoriesPage.mockResolvedValueOnce(page(1, "opaque:/?+&"));
		api.loadSummariesPage.mockResolvedValueOnce(page(11, "summary:not-json", "session_summary"));
		// Act
		await loadFeedData();
		await hooks.loadMoreFeedPage();
		// Assert
		expect(api.loadMemoriesPage.mock.calls).toEqual([
			["garden", options(20)],
			["garden", options(20, "opaque:/?+&")],
		]);
		expect(api.loadSummariesPage.mock.calls).toEqual([
			["garden", options(50)],
			["garden", options(50, "summary:not-json")],
		]);
	});

	it.each(["observations", "summaries"])(
		"does not restart an empty exhausted %s stream",
		async (exhausted) => {
			// Arrange
			const active = exhausted === "observations" ? api.loadSummariesPage : api.loadMemoriesPage;
			const inactive = exhausted === "observations" ? api.loadMemoriesPage : api.loadSummariesPage;
			active.mockResolvedValueOnce(page(null, "continue"));
			// Act
			await loadFeedData();
			await hooks.loadMoreFeedPage();
			await hooks.loadMoreFeedPage();
			// Assert
			expect(active).toHaveBeenCalledTimes(2);
			expect(inactive).toHaveBeenCalledTimes(1);
			expect(active.mock.calls[1][1].cursor).toBe("continue");
		},
	);

	it.each([false, true])(
		"refreshes the head without changing advanced continuation, exhausted=%s",
		async (exhausted) => {
			// Arrange
			await advance();
			if (exhausted) await hooks.loadMoreFeedPage();
			api.loadMemoriesPage.mockResolvedValueOnce(page(3, "new-head"));
			api.loadSummariesPage.mockResolvedValueOnce(page(13, "new-summary", "session_summary"));
			// Act
			await loadFeedData();
			expect(api.loadMemoriesPage).toHaveBeenLastCalledWith("garden", options(20));
			expect(api.loadSummariesPage).toHaveBeenLastCalledWith("garden", options(50));
			const before = api.loadMemoriesPage.mock.calls.length;
			await hooks.loadMoreFeedPage();
			// Assert
			if (exhausted) expect(api.loadMemoriesPage).toHaveBeenCalledTimes(before);
			else {
				expect(api.loadMemoriesPage).toHaveBeenLastCalledWith(
					"garden",
					options(20, "observation:deep"),
				);
				expect(api.loadSummariesPage).toHaveBeenLastCalledWith(
					"garden",
					options(50, "summary:deep"),
				);
			}
		},
	);

	it("does not overwrite a more-page continuation when a pending head refresh finishes", async () => {
		// Arrange
		await advance();
		const head = deferred();
		api.loadMemoriesPage
			.mockReturnValueOnce(head.promise)
			.mockResolvedValueOnce(page(4, "deepest"));
		api.loadSummariesPage.mockResolvedValue(page(null, null));
		// Act
		const pending = loadFeedData();
		await hooks.loadMoreFeedPage();
		head.resolve(page(3, "head-only"));
		await pending;
		await hooks.loadMoreFeedPage();
		// Assert
		expect(api.loadMemoriesPage).toHaveBeenLastCalledWith("garden", options(20, "deepest"));
		expect(ids()).toContain(4);
	});

	it("preserves legacy offset progress across head refreshes", async () => {
		// Arrange
		const legacy = (id: number, next: number) => ({
			items: page(id, null).items,
			pagination: { has_more: true, next_offset: next },
		});
		api.loadMemoriesPage
			.mockResolvedValueOnce(legacy(1, 20))
			.mockResolvedValueOnce(legacy(2, 40))
			.mockResolvedValueOnce(legacy(3, 20));
		// Act
		await loadFeedData();
		await hooks.loadMoreFeedPage();
		await loadFeedData();
		await hooks.loadMoreFeedPage();
		// Assert
		expect(api.loadMemoriesPage).toHaveBeenLastCalledWith("garden", {
			limit: 20,
			offset: 40,
			view: "feed",
			scope: "all",
			q: undefined,
		});
	});
});

const contexts = [
	{
		name: "project",
		change: () => {
			state.currentProject = "orchard";
		},
	},
	{
		name: "scope",
		change: () => {
			state.feedScopeFilter = "mine";
		},
	},
	{
		name: "query",
		change: () => {
			state.feedQuery = "needle";
		},
	},
	{
		name: "actor",
		change: () => {
			state.viewerActorId = "actor-b";
		},
	},
];
describe("Feed cursor context isolation", () => {
	it.each(contexts)("renegotiates both streams after changing $name", async ({ change }) => {
		// Arrange
		await advance();
		// Act
		change();
		await loadFeedData();
		// Assert
		for (const load of [api.loadMemoriesPage, api.loadSummariesPage]) {
			expect(load.mock.lastCall?.[1]).toMatchObject({ paging: "cursor" });
			expect(load.mock.lastCall?.[1].cursor).toBeUndefined();
			expect(load.mock.lastCall?.[1].offset ?? 0).toBe(0);
		}
		expect(ids()).toEqual([]);
	});

	it("renegotiates both streams on explicit restart", async () => {
		// Arrange
		await advance();
		// Act
		await loadFeedData({ restart: true });
		// Assert
		expect(api.loadMemoriesPage).toHaveBeenLastCalledWith("garden", options(20));
		expect(api.loadSummariesPage).toHaveBeenLastCalledWith("garden", options(50));
		expect(ids()).toEqual([]);
	});

	it.each(
		contexts.flatMap((context) => ["primary", "more"].map((stage) => ({ ...context, stage }))),
	)(
		"rejects late $stage data after live $name changes before another load",
		async ({ change, stage }) => {
			// Arrange
			if (stage === "more") await advance();
			const pendingPage = deferred();
			api.loadMemoriesPage.mockReturnValueOnce(pendingPage.promise);
			const before = [...ids()];
			// Act
			const pending = stage === "primary" ? loadFeedData() : hooks.loadMoreFeedPage();
			change();
			pendingPage.resolve(page(99, "stale-token"));
			await pending;
			// Assert
			expect(ids()).toEqual(before);
			expect(ids()).not.toContain(99);
		},
	);

	it("lets the latest concurrent primary request own continuation", async () => {
		// Arrange
		const old = deferred();
		api.loadMemoriesPage.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(2, "latest"));
		// Act
		const pending = loadFeedData();
		await loadFeedData();
		old.resolve(page(1, "stale"));
		await pending;
		await hooks.loadMoreFeedPage();
		// Assert
		expect(api.loadMemoriesPage).toHaveBeenLastCalledWith("garden", options(20, "latest"));
		expect(ids()).not.toContain(1);
	});
});

describe("Feed cursor unavailable recovery", () => {
	it.each(["head", "more"])(
		"restarts BOTH streams in plain offset mode after typed 409 during %s",
		async (stage) => {
			// Arrange
			state.feedQuery = "needle";
			if (stage === "more") await advance();
			const error = await unavailableError();
			api.loadMemoriesPage.mockRejectedValueOnce(error).mockResolvedValueOnce({
				items: page(9, null).items,
				pagination: { has_more: true, next_offset: 20 },
			});
			api.loadSummariesPage
				.mockResolvedValueOnce(page(19, "discarded", "session_summary"))
				.mockResolvedValueOnce({ items: [], pagination: { has_more: true, next_offset: 50 } });
			// Act
			if (stage === "head") await loadFeedData();
			else await hooks.loadMoreFeedPage();
			// Assert
			const q = "needle";
			expect(api.loadMemoriesPage).toHaveBeenLastCalledWith("garden", {
				view: "feed",
				limit: 20,
				offset: 0,
				scope: "all",
				q,
			});
			expect(api.loadSummariesPage).toHaveBeenLastCalledWith("garden", {
				view: "feed",
				limit: 50,
				offset: 0,
				scope: "all",
				q,
			});
			expect(ids()).toEqual([9]);
			await hooks.loadMoreFeedPage();
			expect(api.loadMemoriesPage).toHaveBeenLastCalledWith("garden", {
				view: "feed",
				limit: 20,
				offset: 20,
				scope: "all",
				q,
			});
			expect(api.loadSummariesPage).toHaveBeenLastCalledWith("garden", {
				view: "feed",
				limit: 50,
				offset: 50,
				scope: "all",
				q,
			});
		},
	);

	it("does not loop when an offset restart also fails with cursor_unavailable", async () => {
		// Arrange
		api.loadMemoriesPage.mockRejectedValue(await unavailableError());
		// Act
		await expect(loadFeedData()).rejects.toThrow();
		// Assert
		expect(api.loadMemoriesPage).toHaveBeenCalledTimes(2);
		expect(api.loadSummariesPage).toHaveBeenCalledTimes(2);
	});
});

describe("Feed cursor failures preserve progress", () => {
	it("keeps exhausted streams exhausted through a failed head refresh and retry", async () => {
		// Arrange
		await advance();
		await hooks.loadMoreFeedPage();
		api.loadMemoriesPage.mockRejectedValueOnce(new Error("temporary outage"));
		// Act
		await expect(loadFeedData()).rejects.toThrow();
		api.loadMemoriesPage.mockResolvedValueOnce(page(3, "head-only"));
		api.loadSummariesPage.mockResolvedValueOnce(page(13, "summary-head", "session_summary"));
		await loadFeedData();
		const before = api.loadMemoriesPage.mock.calls.length;
		await hooks.loadMoreFeedPage();
		// Assert
		expect(api.loadMemoriesPage).toHaveBeenCalledTimes(before);
		expect(hooks.pagination()).toMatchObject({ observationHasMore: false, summaryHasMore: false });
	});

	it.each(contexts)(
		"does not apply a late failure after live $name changes",
		async ({ change }) => {
			// Arrange
			let reject = (_reason: Error) => {};
			api.loadMemoriesPage.mockReturnValueOnce(
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
			);
			const pending = loadFeedData();
			const handled = pending.catch(() => undefined);
			// Act
			change();
			reject(new Error("stale failure"));
			await handled;
			// Assert
			expect(mount.renderIntoFeedMount.mock.lastCall?.[1].props.errorText).toBeUndefined();
			expect(hooks.pagination()).toMatchObject({ observationHasMore: true, summaryHasMore: true });
		},
	);

	it.each(["head", "more"])(
		"retries the head after a %s failure without losing deep continuations",
		async (stage) => {
			// Arrange
			await advance();
			api.loadMemoriesPage.mockRejectedValueOnce(new Error("temporary outage"));
			// Act
			if (stage === "head") await expect(loadFeedData()).rejects.toThrow();
			else await hooks.loadMoreFeedPage().catch(() => undefined);
			const failedCount = api.loadMemoriesPage.mock.calls.length;
			vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(0);
			hooks.maybeLoadMoreFeedPage();
			// Assert: automatic scroll waits for a successful explicit retry.
			expect(api.loadMemoriesPage).toHaveBeenCalledTimes(failedCount);
			expect(mount.renderIntoFeedMount.mock.lastCall?.[1].props.errorText).toBe(
				"Feed unavailable. Refresh and try again.",
			);
			vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(100_000);
			api.loadMemoriesPage.mockResolvedValueOnce(page(3, "new-head"));
			api.loadSummariesPage.mockResolvedValueOnce(page(13, "new-summary", "session_summary"));
			await loadFeedData();
			expect(mount.renderIntoFeedMount.mock.lastCall?.[1].props.errorText).toBeUndefined();
			await hooks.loadMoreFeedPage();
			expect(api.loadMemoriesPage).toHaveBeenLastCalledWith(
				"garden",
				options(20, "observation:deep"),
			);
			expect(api.loadSummariesPage).toHaveBeenLastCalledWith("garden", options(50, "summary:deep"));
		},
	);
});
