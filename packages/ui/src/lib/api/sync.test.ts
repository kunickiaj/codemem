import { afterEach, describe, expect, it, vi } from "vitest";

import {
	advanceShareOperation,
	loadShareOperation,
	loadShareOperations,
	triggerSync,
} from "./sync";

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

describe("share operation API", () => {
	it("loads the typed lifecycle list and advances through the single recovery endpoint", async () => {
		const operation = {
			operation_id: `share_${"a".repeat(40)}`,
			person: { actor_id: "actor-brian", display_name: "Brian" },
			devices: [],
			projects: [{ display_name: "codemem", existing_memory_count: 3 }],
			project_count: 1,
			lifecycle: {
				state: "active",
				label: "Up to date",
				explanation: "Existing memories and future activity are shared.",
				primary_action: null,
			},
			timestamps: {
				created_at: "2026-07-20T00:00:00Z",
				updated_at: "2026-07-20T00:01:00Z",
				accepted_at: "2026-07-20T00:00:30Z",
				invite_expires_at: "2026-07-27T00:00:00Z",
			},
		} as const;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ items: [operation] }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(operation), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, operation }), { status: 200 }),
			);
		globalThis.fetch = fetchMock as typeof fetch;

		expect((await loadShareOperations()).items[0]?.lifecycle.label).toBe("Up to date");
		expect((await loadShareOperation(operation.operation_id)).operation_id).toBe(
			operation.operation_id,
		);
		expect((await advanceShareOperation(operation.operation_id)).operation_id).toBe(
			operation.operation_id,
		);
		expect(fetchMock).toHaveBeenLastCalledWith(
			`/api/sync/share-operations/${operation.operation_id}/advance`,
			{ method: "POST" },
		);
	});
});
