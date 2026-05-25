import { afterEach, describe, expect, it, vi } from "vitest";

import { triggerSync } from "./sync";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("triggerSync", () => {
	it("can scope a manual sync by peer device id when addresses are hidden", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
		);
		globalThis.fetch = fetchMock as typeof fetch;

		await triggerSync({ peerDeviceId: "peer-redacted" });

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sync/run",
			expect.objectContaining({
				body: JSON.stringify({ peer_device_id: "peer-redacted" }),
				method: "POST",
			}),
		);
	});
});
