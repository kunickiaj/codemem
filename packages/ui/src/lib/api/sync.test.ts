import { afterEach, describe, expect, it, vi } from "vitest";

import {
	advanceShareOperation,
	loadRecipientPolicyReview,
	loadShareOperation,
	loadShareOperations,
	RecipientPolicyReviewStaleError,
	resolveRecipientPolicyReview,
	resolveRecipientPolicyReviewBulk,
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

describe("recipient policy review API", () => {
	it("loads the camelCase review DTO and submits an input-free decision unchanged", async () => {
		const review = { version: 1, reviewItems: [], blockedItems: [] } as const;
		const applied = {
			reviewItemId: "review-1",
			sourceFingerprint: "fingerprint-1",
			status: "applied",
			errorCode: null,
			idempotent: false,
		} as const;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(review), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(applied), { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		expect(await loadRecipientPolicyReview()).toEqual(review);
		expect(
			await resolveRecipientPolicyReview({
				reviewItemId: "review-1",
				sourceFingerprint: "fingerprint-1",
				decision: "keep_current_setup",
			}),
		).toEqual(applied);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/api/sync/recipient-policy/v1/review/resolve",
			expect.objectContaining({
				body: JSON.stringify({
					reviewItemId: "review-1",
					sourceFingerprint: "fingerprint-1",
					decision: "keep_current_setup",
				}),
				method: "POST",
			}),
		);
	});

	it("throws a typed stale error for a stale 409 result", async () => {
		const stale = {
			reviewItemId: "review-1",
			sourceFingerprint: "stale-fingerprint",
			status: "stale",
			errorCode: "source_fingerprint_stale",
			idempotent: false,
		} as const;
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify(stale), { status: 409 }),
		) as typeof fetch;

		const promise = resolveRecipientPolicyReview({
			reviewItemId: "review-1",
			sourceFingerprint: "stale-fingerprint",
			decision: "reject_suggestion",
		});
		await expect(promise).rejects.toBeInstanceOf(RecipientPolicyReviewStaleError);
		await expect(promise).rejects.toMatchObject({ result: stale });
	});

	it("returns per-item results from a 207 bulk response", async () => {
		const bulk = {
			version: 1,
			results: [
				{
					reviewItemId: "review-1",
					sourceFingerprint: "fingerprint-1",
					status: "not_found",
					errorCode: "review_item_not_found",
					idempotent: false,
				},
			],
		} as const;
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(bulk), { status: 207 }));
		globalThis.fetch = fetchMock as typeof fetch;

		const requests = [
			{
				reviewItemId: "review-1",
				sourceFingerprint: "fingerprint-1",
				decision: "keep_current_setup" as const,
			},
		];
		expect(await resolveRecipientPolicyReviewBulk(requests)).toEqual(bulk);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/sync/recipient-policy/v1/review/resolve-bulk",
			expect.objectContaining({ body: JSON.stringify({ requests }), method: "POST" }),
		);
	});
});
