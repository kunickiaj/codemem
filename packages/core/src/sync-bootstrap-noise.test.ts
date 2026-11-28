import { afterEach, expect, it, vi } from "vitest";
import { fetchAllSnapshotPages } from "./sync-bootstrap.js";

vi.mock("./sync-transport-policy.js", async (original) => ({
	...(await original<typeof import("./sync-transport-policy.js")>()),
	DIRECT_NOISE_ACTIVE: true,
}));

// Snapshot requests are signed. These tests check routing, so signing needs no key.
vi.mock("./sync-auth.js", async (original) => ({
	...(await original<typeof import("./sync-auth.js")>()),
	buildAuthHeaders: () => ({}),
	buildDirectPeerAuthHeaders: () => ({}),
}));

afterEach(() => vi.restoreAllMocks());

const reset = {
	reset_required: true as const,
	reason: "missing_scope",
	generation: 1,
	snapshot_id: "snap",
	baseline_cursor: null,
	retained_floor_cursor: null,
};

it("refuses to build its own plaintext executor while direct Noise is on", async () => {
	const fetch = vi.spyOn(globalThis, "fetch");

	await expect(fetchAllSnapshotPages("http://127.0.0.1:9", reset, "device")).rejects.toThrow(
		/transport policy's executor/,
	);
	expect(fetch).not.toHaveBeenCalled();
});

it("uses the executor the caller's transport policy chose", async () => {
	const requestExecutor = vi.fn(async () => [
		200,
		{
			items: [],
			next_page_token: null,
			has_more: false,
			generation: 1,
			snapshot_id: "snap",
			baseline_cursor: null,
		},
	]);

	await fetchAllSnapshotPages("http://127.0.0.1:9", reset, "device", {
		requestExecutor: requestExecutor as never,
	});

	expect(requestExecutor).toHaveBeenCalledWith(
		"GET",
		expect.stringContaining("/v1/snapshot?"),
		expect.anything(),
	);
});
