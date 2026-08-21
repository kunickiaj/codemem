import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMemoriesPage, loadSummariesPage } from "./memories";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("Feed memory API", () => {
	it("passes q with project, scope, and pagination to both Feed streams", async () => {
		const fetchMock = vi.fn(
			async (_input: Parameters<typeof fetch>[0]) =>
				new Response(JSON.stringify({ items: [], pagination: { has_more: false } }), {
					status: 200,
				}),
		);
		globalThis.fetch = fetchMock as typeof fetch;

		await loadMemoriesPage("codemem", { limit: 20, offset: 40, scope: "mine", q: "tag value" });
		await loadSummariesPage("codemem", {
			limit: 50,
			offset: 100,
			scope: "theirs",
			q: "tag value",
		});

		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			"/api/observations?project=codemem&limit=20&offset=40&scope=mine&q=tag+value",
			"/api/summaries?project=codemem&limit=50&offset=100&scope=theirs&q=tag+value",
		]);
	});

	it("omits empty q and safely encodes reserved query characters", async () => {
		const fetchMock = vi.fn(
			async (_input: Parameters<typeof fetch>[0]) =>
				new Response(JSON.stringify({ items: [], pagination: { has_more: false } }), {
					status: 200,
				}),
		);
		globalThis.fetch = fetchMock as typeof fetch;

		await loadMemoriesPage("", { q: "" });
		await loadSummariesPage("", { q: "?&/# +" });

		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			"/api/observations?project=",
			"/api/summaries?project=&q=%3F%26%2F%23+%2B",
		]);
	});
});
