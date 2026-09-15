import { afterEach, describe, expect, it, vi } from "vitest";

import { loadViewerStatus, pingViewerReady } from "./runtime";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("loadViewerStatus", () => {
	it("uses the identity-aware lightweight status endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ identity: { actor_id: "actor-local" } }), { status: 200 }),
		);
		globalThis.fetch = fetchMock as typeof fetch;

		expect(await loadViewerStatus()).toEqual({ identity: { actor_id: "actor-local" } });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/viewer-status",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});
});

describe("pingViewerReady", () => {
	it("uses the lightweight runtime endpoint instead of the stats hot path", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ version: "test" }), { status: 200 }),
		);
		globalThis.fetch = fetchMock as typeof fetch;

		await pingViewerReady();

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/runtime",
			expect.objectContaining({ cache: "no-store" }),
		);
	});
});
