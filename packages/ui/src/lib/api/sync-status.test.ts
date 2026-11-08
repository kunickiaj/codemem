import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let loadSyncStatus: typeof import("./sync").loadSyncStatus;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function statusResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), { status: 200 });
}

function mockPendingFetch() {
	const response = deferred<Response>();
	// Deliberately ignore abort so cancellation races do not depend on fetch settling.
	const fetchMock = vi.fn<typeof fetch>(() => response.promise);
	vi.stubGlobal("fetch", fetchMock);
	return { response, fetchMock };
}

beforeEach(async () => {
	vi.useFakeTimers();
	vi.resetModules();
	({ loadSyncStatus } = await import("./sync"));
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("loadSyncStatus in-flight sharing", () => {
	it.each(["signal first", "signal second"])(
		"shares identical URLs between independent callers with %s",
		async (order) => {
			// Arrange
			const { response, fetchMock } = mockPendingFetch();
			const controller = new AbortController();
			const withSignal = () => loadSyncStatus(false, "", { signal: controller.signal });
			const withoutSignal = () => loadSyncStatus(false);
			const callers =
				order === "signal first" ? [withSignal, withoutSignal] : [withoutSignal, withSignal];

			// Act
			const requests = callers.map((call) => call());
			await vi.advanceTimersByTimeAsync(0);
			response.resolve(statusResponse({ status: "ready" }));
			const results = await Promise.all(requests);

			// Assert
			expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
				"/api/sync/status",
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			expect(results).toEqual([{ status: "ready" }, { status: "ready" }]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each([
		{
			name: "diagnostics",
			diagnostics: true,
			project: "",
			options: {},
			suffix: "?includeDiagnostics=1",
		},
		{
			name: "project",
			diagnostics: false,
			project: "project / one",
			options: {},
			suffix: "?project=project+%2F+one",
		},
		{
			name: "join requests",
			diagnostics: false,
			project: "",
			options: { includeJoinRequests: true },
			suffix: "?includeJoinRequests=1",
		},
	])(
		"does not share requests with different $name",
		async ({ diagnostics, project, options, suffix }) => {
			// Arrange
			const { response, fetchMock } = mockPendingFetch();
			const otherResponse = deferred<Response>();
			fetchMock
				.mockImplementationOnce(() => response.promise)
				.mockImplementationOnce(() => otherResponse.promise);

			// Act
			const first = loadSyncStatus(false);
			const second = loadSyncStatus(diagnostics, project, options);
			await vi.advanceTimersByTimeAsync(0);
			response.resolve(statusResponse({ status: "ready" }));
			otherResponse.resolve(statusResponse({ status: "ready" }));
			await Promise.all([first, second]);

			// Assert
			expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
				"/api/sync/status",
				`/api/sync/status${suffix}`,
			]);
		},
	);
});

describe("loadSyncStatus settlement cleanup", () => {
	it("fetches fresh status immediately after success instead of retaining a response cache", async () => {
		// Arrange
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(statusResponse({ count: 1 }))
			.mockResolvedValueOnce(statusResponse({ count: 2 }));
		vi.stubGlobal("fetch", fetchMock);

		// Act
		const first = await loadSyncStatus(false);
		const second = await loadSyncStatus(false);

		// Assert
		expect([first, second]).toEqual([{ count: 1 }, { count: 2 }]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each(["network", "HTTP", "JSON"])(
		"evicts a shared request after a %s failure",
		async (failure) => {
			// Arrange
			const { response, fetchMock } = mockPendingFetch();
			const first = loadSyncStatus(false);
			const second = loadSyncStatus(false);
			const failures = Promise.allSettled([first, second]);
			await vi.advanceTimersByTimeAsync(0);

			// Act
			if (failure === "network") response.reject(new Error("offline"));
			if (failure === "HTTP") response.resolve(new Response(null, { status: 503 }));
			if (failure === "JSON") response.resolve(new Response("invalid JSON"));
			const results = await failures;
			fetchMock.mockResolvedValueOnce(statusResponse({ status: "recovered" }));
			const retry = await loadSyncStatus(false);

			// Assert
			expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
			expect(retry).toEqual({ status: "recovered" });
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["headers", "body"])(
		"evicts a shared request after the 15-second %s timeout",
		async (stage) => {
			// Arrange
			const { response, fetchMock } = mockPendingFetch();
			const first = loadSyncStatus(false);
			const second = loadSyncStatus(false);
			const failures = Promise.allSettled([first, second]);
			if (stage === "body") {
				response.resolve(
					Object.assign(new Response(), { json: () => new Promise(() => undefined) }),
				);
			}
			await vi.advanceTimersByTimeAsync(14_999);
			const signal = fetchMock.mock.calls[0][1]?.signal;
			expect(signal?.aborted).toBe(false);

			// Act
			await vi.advanceTimersByTimeAsync(1);
			const results = await failures;
			fetchMock.mockResolvedValueOnce(statusResponse({ status: "recovered" }));
			const retry = await loadSyncStatus(false);

			// Assert
			expect(results).toEqual([
				{
					status: "rejected",
					reason: expect.objectContaining({ name: "ReadTimeoutError", timeoutMs: 15_000 }),
				},
				{
					status: "rejected",
					reason: expect.objectContaining({ name: "ReadTimeoutError", timeoutMs: 15_000 }),
				},
			]);
			expect(signal?.aborted).toBe(true);
			expect(retry).toEqual({ status: "recovered" });
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

describe("loadSyncStatus caller cancellation", () => {
	it("rejects a pre-aborted caller without starting fetch", async () => {
		// Arrange
		const { fetchMock } = mockPendingFetch();
		const controller = new AbortController();
		const reason = new DOMException("hidden", "AbortError");
		controller.abort(reason);

		// Act
		const request = loadSyncStatus(false, "", { signal: controller.signal });

		// Assert
		await expect(request).rejects.toBe(reason);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects a pre-aborted caller without disrupting an existing request", async () => {
		// Arrange
		const { response, fetchMock } = mockPendingFetch();
		const first = loadSyncStatus(false);
		const controller = new AbortController();
		controller.abort();

		// Act
		const cancelled = loadSyncStatus(false, "", { signal: controller.signal });
		await expect(cancelled).rejects.toBe(controller.signal.reason);
		await vi.advanceTimersByTimeAsync(0);
		response.resolve(statusResponse({ status: "ready" }));

		// Assert
		await expect(first).resolves.toEqual({ status: "ready" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
	});

	it.each(["first", "second"])(
		"cancels only the %s caller while the other receives status",
		async (cancelledCaller) => {
			// Arrange
			const { response, fetchMock } = mockPendingFetch();
			const firstController = new AbortController();
			const secondController = new AbortController();
			const first = loadSyncStatus(false, "", { signal: firstController.signal });
			const second = loadSyncStatus(false, "", { signal: secondController.signal });
			const cancelled = cancelledCaller === "first" ? first : second;
			const survivor = cancelledCaller === "first" ? second : first;
			const controller = cancelledCaller === "first" ? firstController : secondController;
			await vi.advanceTimersByTimeAsync(0);
			const reason = new DOMException("surface changed", "AbortError");

			// Act
			controller.abort(reason);
			await expect(cancelled).rejects.toBe(reason);
			const underlyingAborted = fetchMock.mock.calls[0][1]?.signal?.aborted;
			response.resolve(statusResponse({ status: "ready" }));

			// Assert
			expect(underlyingAborted).toBe(false);
			await expect(survivor).resolves.toEqual({ status: "ready" });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("abandons an all-cancelled request immediately and preserves its replacement after old cleanup", async () => {
		// Arrange
		const { response: oldResponse, fetchMock } = mockPendingFetch();
		const replacementResponse = deferred<Response>();
		fetchMock
			.mockImplementationOnce(() => oldResponse.promise)
			.mockImplementationOnce(() => replacementResponse.promise);
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = loadSyncStatus(false, "", { signal: firstController.signal });
		const second = loadSyncStatus(false, "", { signal: secondController.signal });
		const cancellations = Promise.allSettled([first, second]);
		await vi.advanceTimersByTimeAsync(0);
		const oldSignal = fetchMock.mock.calls[0][1]?.signal;

		// Act
		firstController.abort();
		secondController.abort();
		// Start before any promise cleanup or the ignored fetch abort can settle.
		const replacement = loadSyncStatus(false);
		const cancelledResults = await cancellations;
		oldResponse.resolve(statusResponse({ status: "obsolete" }));
		await vi.advanceTimersByTimeAsync(0);
		const joinedReplacement = loadSyncStatus(false);
		await vi.advanceTimersByTimeAsync(0);
		replacementResponse.resolve(statusResponse({ status: "fresh" }));
		const results = await Promise.all([replacement, joinedReplacement]);

		// Assert
		expect(cancelledResults.map((result) => result.status)).toEqual(["rejected", "rejected"]);
		expect(oldSignal?.aborted).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(false);
		expect(results).toEqual([{ status: "fresh" }, { status: "fresh" }]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
