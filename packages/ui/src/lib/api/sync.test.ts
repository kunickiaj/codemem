import { afterEach, describe, expect, it, vi } from "vitest";

import {
	advanceShareOperation,
	commitRecipientPolicyEdges,
	createRecipientInvite,
	importCoordinatorInvite,
	inspectCoordinatorInvite,
	loadRecipientPolicyIntent,
	loadRecipientPolicyReconciliationStatus,
	loadRecipientPolicyReview,
	loadShareOperation,
	loadShareOperations,
	previewRecipientInvite,
	previewRecipientPolicyEdges,
	RecipientPolicyEdgesStaleError,
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

describe("recipient invitation API", () => {
	it("omits unavailable optional identity names from Project invitation imports", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ status: "pending_setup", type: "project_share" }), {
				status: 200,
			}),
		);
		globalThis.fetch = fetchMock as typeof fetch;

		await importCoordinatorInvite("project-invite", {});

		expect(fetchMock).toHaveBeenCalledWith("/api/sync/invites/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ invite: "project-invite" }),
		});
	});

	it("sends exact Team preview/create and add-device inspect payloads", async () => {
		const preview = {
			kind: "team_member",
			preview: { reviewedOnboardingDigest: "recipient-onboarding-preview-v1:digest" },
		};
		const created = { ok: true, ...preview, invite: { link: "codemem://join" } };
		const inspected = { kind: "add_device", onboarding: { journey: "add_device" } };
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(inspected), { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		await previewRecipientInvite({ kind: "team_member", policy_team_id: "team-one" });
		await createRecipientInvite({
			kind: "team_member",
			policy_team_id: "team-one",
			reviewed_onboarding_digest: "recipient-onboarding-preview-v1:digest",
		});
		await inspectCoordinatorInvite("invite-value", { device_name: "Travel Laptop" });

		expect(fetchMock.mock.calls).toEqual([
			[
				"/api/sync/recipient-policy/v1/invites/preview",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ kind: "team_member", policy_team_id: "team-one" }),
				},
			],
			[
				"/api/sync/recipient-policy/v1/invites",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						kind: "team_member",
						policy_team_id: "team-one",
						reviewed_onboarding_digest: "recipient-onboarding-preview-v1:digest",
					}),
				},
			],
			[
				"/api/sync/invites/inspect",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ invite: "invite-value", device_name: "Travel Laptop" }),
				},
			],
		]);
	});

	it("sends only the target Identity and reviewed digest for add-device creation", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						kind: "add_device",
						preview: { reviewedOnboardingDigest: "recipient-onboarding-preview-v1:device" },
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true, kind: "add_device", invite: {} }), {
					status: 200,
				}),
			);
		globalThis.fetch = fetchMock as typeof fetch;

		await previewRecipientInvite({ kind: "add_device", target_identity_id: "identity-one" });
		await createRecipientInvite({
			kind: "add_device",
			target_identity_id: "identity-one",
			reviewed_onboarding_digest: "recipient-onboarding-preview-v1:device",
		});

		expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
			{ kind: "add_device", target_identity_id: "identity-one" },
			{
				kind: "add_device",
				target_identity_id: "identity-one",
				reviewed_onboarding_digest: "recipient-onboarding-preview-v1:device",
			},
		]);
	});
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

describe("recipient policy edge API", () => {
	it("loads the typed safe reconciliation status", async () => {
		const status = {
			version: 1,
			items: [
				{
					canonicalProjectIdentity: "git:codemem",
					state: "waiting",
					label: "Waiting to reconcile",
					explanation: "Waiting for devices or a fresh coordinator snapshot.",
					deliveredCopiesMayRemain: true,
					revocationWarning: "Copies already delivered may remain.",
				},
			],
		} as const;
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(status), { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		expect(await loadRecipientPolicyReconciliationStatus()).toEqual(status);
		expect(fetchMock).toHaveBeenCalledWith("/api/sync/recipient-policy/v1/reconciliation-status");
	});

	it("loads intent and sends exact preview and commit payloads", async () => {
		const intent = {
			version: 1,
			identities: [],
			teams: [],
			teamMemberships: [],
			identityDevices: [],
			projectRecipients: [],
		} as const;
		const changes = [
			{
				canonicalProjectIdentity: "git:codemem",
				recipient: { recipientKind: "team" as const, teamId: "team-1" },
				action: "add" as const,
			},
		];
		const preview = {
			version: 1,
			normalizedChanges: changes,
			projects: [],
			selectedRecipients: [],
			effectiveDevices: [],
			unchangedProjects: [],
			reviewedPolicyDigest: "policy:digest",
			addCount: 1,
			removeCount: 0,
			netWriteCount: 1,
		} as const;
		const committed = {
			version: 1,
			status: "applied",
			reviewedPolicyDigest: "policy:digest",
			errorCode: null,
			outcomes: [{ change: changes[0], outcome: "added" }],
			writeCount: 1,
			idempotent: false,
		} as const;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(intent), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(committed), { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		expect(await loadRecipientPolicyIntent()).toEqual(intent);
		expect(await previewRecipientPolicyEdges({ version: 1, changes })).toEqual(preview);
		expect(
			await commitRecipientPolicyEdges({
				version: 1,
				changes: preview.normalizedChanges,
				reviewedPolicyDigest: preview.reviewedPolicyDigest,
			}),
		).toEqual(committed);
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/sync/recipient-policy/v1/edges/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ version: 1, changes }),
		});
		expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/sync/recipient-policy/v1/edges/commit", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				version: 1,
				changes: preview.normalizedChanges,
				reviewedPolicyDigest: preview.reviewedPolicyDigest,
			}),
		});
	});

	it("throws a typed stale error for a stale edge commit", async () => {
		const stale = {
			version: 1,
			status: "stale",
			reviewedPolicyDigest: "policy:old",
			errorCode: "reviewed_policy_stale",
			outcomes: [],
			writeCount: 0,
			idempotent: false,
		} as const;
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify(stale), { status: 409 }),
		) as typeof fetch;

		const promise = commitRecipientPolicyEdges({
			version: 1,
			changes: [
				{
					canonicalProjectIdentity: "git:codemem",
					recipient: { recipientKind: "identity", identityId: "identity-1" },
					action: "remove",
				},
			],
			reviewedPolicyDigest: "policy:old",
		});

		await expect(promise).rejects.toBeInstanceOf(RecipientPolicyEdgesStaleError);
		await expect(promise).rejects.toMatchObject({ result: stale });
	});
});
