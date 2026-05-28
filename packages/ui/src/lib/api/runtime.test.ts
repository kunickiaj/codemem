import { afterEach, describe, expect, it, vi } from "vitest";

import { pingViewerReady } from "./runtime";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
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
