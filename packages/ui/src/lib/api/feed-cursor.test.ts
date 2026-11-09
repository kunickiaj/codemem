import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadTimeoutError } from "../read-request";
import { loadMemoriesPage, loadSummariesPage } from "./memories";

const fetchMock = vi.fn<typeof fetch>();
const loaders = [
	{ name: "observations", load: loadMemoriesPage },
	{ name: "summaries", load: loadSummariesPage },
];
const opaque = "not-json:/?&=+ 🪴";
function page(next: string | null = opaque) {
	return {
		items: [],
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
function json(payload: unknown, status = 200) {
	return new Response(JSON.stringify(payload), { status });
}
function urls() {
	return fetchMock.mock.calls.map(([input]) => new URL(String(input), "https://example.test"));
}
beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe.each(loaders)("$name cursor transport", ({ load, name }) => {
	it("encodes only explicitly requested cursor paging and preserves opaque tokens", async () => {
		// Arrange
		fetchMock.mockImplementation(async () => json(page()));
		// Act
		await load("garden");
		const result = await load("a&b", {
			view: "feed",
			paging: "cursor",
			cursor: opaque,
			limit: 20,
			scope: "mine",
			q: "?needle&",
		});
		// Assert
		expect(urls()[0].pathname).toBe(`/api/${name}`);
		expect(urls()[0].search).toBe("?project=garden");
		expect(Object.fromEntries(urls()[1].searchParams)).toEqual({
			project: "a&b",
			view: "feed",
			paging: "cursor",
			cursor: opaque,
			limit: "20",
			scope: "mine",
			q: "?needle&",
		});
		expect(result).toEqual(page());
	});

	it.each([
		{ label: "exhausted", next: null },
		{ label: "maximum-length", next: "x".repeat(4096) },
	])("accepts $label continuation", async ({ next }) => {
		// Arrange
		fetchMock.mockResolvedValue(json(page(next)));
		// Act
		const result = await load("garden", { view: "feed", paging: "cursor" });
		// Assert
		expect(result).toEqual(page(next));
		expect(urls()[0].searchParams.has("cursor")).toBe(false);
	});

	it("keeps an older offset response usable without inventing cursor metadata", async () => {
		// Arrange
		const legacy = { items: [], pagination: { has_more: true, next_offset: 40 } };
		fetchMock.mockResolvedValue(json(legacy));
		// Act
		const result = await load("garden", { view: "feed", paging: "cursor" });
		// Assert
		expect(result).toEqual(legacy);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ label: "missing token", change: { next_cursor: undefined } },
		{ label: "empty token", change: { next_cursor: "" } },
		{ label: "oversized token", change: { next_cursor: "x".repeat(4097) } },
		{ label: "non-string token", change: { next_cursor: 1 } },
		{ label: "ambiguous null continuation", change: { next_cursor: null } },
		{ label: "token after exhaustion", change: { has_more: false } },
		{ label: "non-boolean continuation", change: { has_more: "true" } },
		{ label: "offset in cursor page", change: { offset: 0 } },
		{ label: "next offset in cursor page", change: { next_offset: 20 } },
		{ label: "invalid limit", change: { limit: 0 } },
		{ label: "fractional limit", change: { limit: 1.5 } },
		{ label: "missing limit", change: { limit: undefined } },
		{ label: "missing offset", change: { offset: undefined } },
		{ label: "missing next offset", change: { next_offset: undefined } },
		{ label: "missing has_more", change: { has_more: undefined } },
	])("rejects recognized cursor pagination with $label without retrying", async ({ change }) => {
		// Arrange
		const payload = page();
		fetchMock.mockResolvedValue(
			json({ ...payload, pagination: { ...payload.pagination, ...change } }),
		);
		// Act
		const result = load("garden", { view: "feed", paging: "cursor" });
		// Assert
		await expect(result).rejects.toThrow("Feed unavailable. Refresh and try again.");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ label: "other conflict", status: 409, body: { error: "different_error" } },
		{ label: "bad request", status: 400, body: { error: "cursor_unavailable" } },
		{ label: "server failure", status: 500, body: { error: "cursor_unavailable" } },
		{ label: "malformed error", status: 409, body: { error: 1 } },
	])("does not retry $label as an offset request", async ({ status, body }) => {
		// Arrange
		fetchMock.mockResolvedValue(json(body, status));
		// Act
		const result = load("garden", { view: "feed", paging: "cursor", cursor: opaque });
		// Assert
		await expect(result).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not retry malformed JSON or network failures", async () => {
		// Arrange
		fetchMock
			.mockResolvedValueOnce(new Response("not json", { status: 409 }))
			.mockRejectedValueOnce(new TypeError("network unavailable"));
		// Act / Assert
		await expect(load("garden", { paging: "cursor", view: "feed" })).rejects.toThrow();
		await expect(load("garden", { paging: "cursor", view: "feed" })).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each(["headers", "success body", "conflict body"])(
		"applies the read deadline through %s",
		async (stage) => {
			// Arrange
			vi.useFakeTimers();
			const never = new Promise<never>(() => {});
			if (stage === "headers") fetchMock.mockReturnValue(never);
			else {
				const response = json(
					stage === "conflict body" ? { error: "cursor_unavailable" } : page(),
					stage === "conflict body" ? 409 : 200,
				);
				vi.spyOn(response, "json").mockReturnValue(never);
				vi.spyOn(response, "text").mockReturnValue(never);
				fetchMock.mockResolvedValue(response);
			}
			// Act
			const result = load("garden", { view: "feed", paging: "cursor" });
			const rejection = expect(result).rejects.toBeInstanceOf(ReadTimeoutError);
			await vi.advanceTimersByTimeAsync(15_000);
			// Assert
			await rejection;
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each([200, 409])("honors parent cancellation during HTTP %i body reading", async (status) => {
		// Arrange
		const controller = new AbortController();
		const reason = new DOMException("context changed", "AbortError");
		let bodyStarted = () => {};
		const started = new Promise<void>((resolve) => {
			bodyStarted = resolve;
		});
		const response = json(status === 409 ? { error: "cursor_unavailable" } : page(), status);
		const stalled = () => {
			bodyStarted();
			return new Promise<never>(() => {});
		};
		vi.spyOn(response, "json").mockImplementation(stalled);
		vi.spyOn(response, "text").mockImplementation(stalled);
		fetchMock.mockResolvedValue(response);
		// Act
		const result = load("garden", { view: "feed", paging: "cursor", signal: controller.signal });
		const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
		await started;
		controller.abort(reason);
		// Assert
		await rejection;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
