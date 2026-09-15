import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReadTimeoutError } from "../read-request";
import { fetchJson } from "./internal";

const originalFetch = globalThis.fetch;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("fetchJson read deadlines", () => {
	it("keeps one deadline through successful header and body reads", async () => {
		// Arrange
		globalThis.fetch = vi.fn(async () =>
			Object.assign(new Response(), {
				json: async () => ({ status: "ok" }),
			}),
		) as typeof fetch;

		// Act
		const payload = await fetchJson("/api/test", { deadlineMs: 100 });

		// Assert
		expect(payload).toEqual({ status: "ok" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("times out when response headers never arrive", async () => {
		// Arrange
		globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch;
		const request = fetchJson("/api/test", { deadlineMs: 100 });
		const rejection = expect(request).rejects.toEqual(expect.any(ReadTimeoutError));

		// Act
		await vi.advanceTimersByTimeAsync(100);

		// Assert
		await rejection;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the deadline active while the response body stalls", async () => {
		// Arrange
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			json: () => new Promise<unknown>(() => undefined),
		})) as unknown as typeof fetch;
		const request = fetchJson("/api/test", { deadlineMs: 100 });
		const rejection = expect(request).rejects.toEqual(expect.any(ReadTimeoutError));
		await vi.advanceTimersByTimeAsync(99);
		expect(vi.getTimerCount()).toBe(1);

		// Act
		await vi.advanceTimersByTimeAsync(1);

		// Assert
		await rejection;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves caller cancellation instead of reporting a timeout", async () => {
		// Arrange
		const controller = new AbortController();
		const reason = new DOMException("surface changed", "AbortError");
		const addListener = vi.spyOn(controller.signal, "addEventListener");
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");
		globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch;
		const request = fetchJson("/api/test", { deadlineMs: 100, signal: controller.signal });

		// Act
		controller.abort(reason);

		// Assert
		await expect(request).rejects.toBe(reason);
		expect(vi.getTimerCount()).toBe(0);
		const parentAbortListener = addListener.mock.calls.find(([type]) => type === "abort")?.[1];
		expect(parentAbortListener).toBeDefined();
		expect(removeListener).toHaveBeenCalledWith("abort", parentAbortListener);
		await vi.advanceTimersByTimeAsync(100);
		expect(controller.signal.reason).toBe(reason);
	});

	it("does not start fetch for a pre-aborted caller", async () => {
		// Arrange
		const controller = new AbortController();
		const reason = new DOMException("hidden", "AbortError");
		controller.abort(reason);
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as typeof fetch;

		// Act
		const request = fetchJson("/api/test", { signal: controller.signal });

		// Assert
		await expect(request).rejects.toBe(reason);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans up the deadline after HTTP and parser failures", async () => {
		// Arrange
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 503, statusText: "Unavailable" }))
			.mockResolvedValueOnce(
				Object.assign(new Response(), {
					json: async () => {
						throw new SyntaxError("invalid JSON");
					},
				}),
			) as typeof fetch;

		// Act / Assert
		await expect(fetchJson("/api/http", { deadlineMs: 100 })).rejects.toThrow("503");
		expect(vi.getTimerCount()).toBe(0);
		await expect(fetchJson("/api/json", { deadlineMs: 100 })).rejects.toThrow("invalid JSON");
		expect(vi.getTimerCount()).toBe(0);
	});
});
