import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMemoriesPage, loadMemoryContext, loadSummariesPage } from "./memories";

const fetchMock = vi.fn<typeof fetch>();
const context = { id: 17, revision: "r17", context: "Entire context" };
function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status });
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

describe("Feed projection API opt-in", () => {
	it.each([loadMemoriesPage, loadSummariesPage])(
		"preserves default URLs and adds view only for explicit feed opt-in",
		async (load) => {
			// Arrange
			fetchMock.mockImplementation(async () => json({ items: [] }));
			// Act
			await load("garden");
			await load("garden", { view: "feed", limit: 20, offset: 40 });
			// Assert
			const urls = fetchMock.mock.calls.map(
				([input]) => new URL(String(input), "https://example.test"),
			);
			expect(urls[0].search).toBe("?project=garden");
			expect(urls[1].searchParams.get("view")).toBe("feed");
			expect(urls[1].searchParams.get("limit")).toBe("20");
			expect(urls[1].searchParams.get("offset")).toBe("40");
		},
	);
});

describe("Feed context API", () => {
	it("encodes read filters, bypasses cache, and returns the validated context DTO", async () => {
		// Arrange
		fetchMock.mockResolvedValue(json(context));
		const controller = new AbortController();
		// Act
		const result = await loadMemoryContext({
			id: 17,
			project: "a&b/🪴",
			scope: "mine",
			q: "?/# +",
			classification: "observation",
			signal: controller.signal,
		});
		// Assert
		const [input, init] = fetchMock.mock.calls[0];
		const url = new URL(String(input), "https://example.test");
		expect(url.pathname).toBe("/api/memory/17/context");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			project: "a&b/🪴",
			scope: "mine",
			q: "?/# +",
			classification: "observation",
		});
		expect(init?.cache).toBe("no-store");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(result).toEqual(context);
	});

	it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		"rejects unsafe id %s before a request",
		async (id) => {
			// Arrange
			fetchMock.mockResolvedValue(json(context));
			// Act
			const result = loadMemoryContext({
				id,
				project: "",
				scope: "all",
				q: "",
				classification: "observation",
			});
			// Assert
			await expect(result).rejects.toThrow();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		null,
		{},
		{ ...context, id: "17" },
		{ ...context, id: 18 },
		{ ...context, revision: 7 },
		{ ...context, context: [] },
	])("rejects malformed DTO %j", async (payload) => {
		// Arrange
		fetchMock.mockResolvedValue(json(payload));
		// Act
		const result = loadMemoryContext({
			id: 17,
			project: "",
			scope: "all",
			q: "",
			classification: "observation",
		});
		// Assert
		await expect(result).rejects.toThrow();
	});

	it.each(["fetch", "body"])(
		"aborts a stalled %s after the 15-second read deadline",
		async (stage) => {
			// Arrange
			vi.useFakeTimers();
			const never = new Promise<never>(() => {});
			if (stage === "fetch") fetchMock.mockReturnValue(never);
			else {
				const response = json(context);
				vi.spyOn(response, "json").mockReturnValue(never);
				fetchMock.mockResolvedValue(response);
			}
			// Act
			const result = loadMemoryContext({
				id: 17,
				project: "",
				scope: "all",
				q: "",
				classification: "observation",
			});
			const rejected = expect(result).rejects.toThrow();
			await vi.advanceTimersByTimeAsync(14_999);
			expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			// Assert
			await rejected;
			expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
		},
	);

	it("honors parent cancellation during response-body reading", async () => {
		// Arrange
		const controller = new AbortController();
		let markBodyStarted = () => {};
		const bodyStarted = new Promise<void>((resolve) => {
			markBodyStarted = resolve;
		});
		const response = json(context);
		vi.spyOn(response, "json").mockImplementation(() => {
			markBodyStarted();
			return new Promise(() => {});
		});
		fetchMock.mockResolvedValue(response);
		// Act
		const result = loadMemoryContext({
			id: 17,
			project: "",
			scope: "all",
			q: "",
			classification: "observation",
			signal: controller.signal,
		});
		const rejected = expect(result).rejects.toThrow();
		await bodyStarted;
		controller.abort();
		// Assert
		await rejected;
		expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
	});

	it.each([404, 500])("rejects HTTP %s instead of returning a context DTO", async (status) => {
		// Arrange
		fetchMock.mockResolvedValue(json({ error: "private error" }, status));
		// Act
		const result = loadMemoryContext({
			id: 17,
			project: "",
			scope: "all",
			q: "",
			classification: "observation",
		});
		// Assert
		await expect(result).rejects.toThrow();
	});
});
