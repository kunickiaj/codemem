import { afterEach, describe, expect, it, vi } from "vitest";

import {
	advanceShareOperation,
	clearLegacyTeamSetupDecision,
	commitDeviceIdentityBindings,
	commitRecipientPolicyEdges,
	createRecipientInvite,
	finishLegacyTeamSetup,
	importCoordinatorInvite,
	inspectCoordinatorInvite,
	LegacyTeamSetupApiError,
	loadDeviceIdentityInventory,
	loadLegacyTeamSetupDetail,
	loadLegacyTeamSetupSummary,
	loadRecipientPolicyIntent,
	loadRecipientPolicyReconciliationStatus,
	loadRecipientPolicyReview,
	loadShareOperation,
	loadShareOperations,
	ProjectInviteAcceptanceError,
	previewDeviceIdentityBindings,
	previewRecipientInvite,
	previewRecipientPolicyEdges,
	RecipientPolicyEdgesStaleError,
	type RecipientPolicyReviewListV1,
	RecipientPolicyReviewStaleError,
	refreshLegacyTeamSetupCandidate,
	renameRecipientPolicyTeam,
	resolveRecipientPolicyReview,
	resolveRecipientPolicyReviewBulk,
	saveLegacyTeamSetupAssignment,
	saveLegacyTeamSetupDecision,
	saveLegacyTeamSetupProjectMapping,
	triggerSync,
} from "./sync";

describe("device Identity setup API", () => {
	it("loads inventory and sends exact preview and commit contracts", async () => {
		const inventory = {
			version: 1,
			items: [],
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		};
		const preview = {
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "digest",
			errorCode: null,
			outcomes: [],
			writeCount: 1,
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(inventory), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ...preview, status: "applied", idempotent: false }), {
					status: 200,
				}),
			);
		globalThis.fetch = fetchMock as typeof fetch;
		const request = {
			bindings: [{ deviceId: "device-one", targetIdentityId: "identity-one", confirmed: true }],
		};

		await loadDeviceIdentityInventory();
		await previewDeviceIdentityBindings(request);
		await commitDeviceIdentityBindings({ ...request, reviewedInventoryDigest: "digest" });

		expect(fetchMock.mock.calls).toEqual([
			["/api/sync/recipient-policy/v1/device-inventory"],
			[
				"/api/sync/recipient-policy/v1/device-bindings/preview",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(request),
				},
			],
			[
				"/api/sync/recipient-policy/v1/device-bindings/commit",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ...request, reviewedInventoryDigest: "digest" }),
				},
			],
		]);
	});
});

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("recipient policy Team metadata API", () => {
	it("sends the bounded rename contract and validates the response", async () => {
		const result = {
			version: 1 as const,
			teamId: "team-one",
			displayName: "New Team",
			revision: "revision-two",
			linkedCoordinatorGroupRenamed: true,
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		await expect(
			renameRecipientPolicyTeam({
				teamId: "team/one",
				displayName: "New Team",
				expectedDisplayName: "Old Team",
			}),
		).resolves.toEqual(result);
		expect(fetchMock).toHaveBeenCalledWith("/api/sync/recipient-policy/v1/teams/team%2Fone", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ displayName: "New Team", expectedDisplayName: "Old Team" }),
		});
	});

	it("maps unknown server failures to a safe typed error", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ error: "private_remote_detail" }), { status: 503 }),
			) as typeof fetch;

		await expect(
			renameRecipientPolicyTeam({
				teamId: "team-one",
				displayName: "New Team",
				expectedDisplayName: "Old Team",
			}),
		).rejects.toMatchObject({ statusCode: 503, errorCode: "team_rename_failed" });
	});
});

describe("recipient invitation API", () => {
	it("preserves allowlisted Project invitation error codes without changing safe detail", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						detail: "This invitation expired. Ask the owner to create a new invitation.",
						error: "invite_expired",
					}),
					{ status: 400 },
				),
		) as typeof fetch;

		const failure = await importCoordinatorInvite(
			"expired-project-invite",
			undefined,
			"project_share_invite",
		).catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(ProjectInviteAcceptanceError);
		expect(failure).toMatchObject({
			errorCode: "invite_expired",
			message: "This invitation expired. Ask the owner to create a new invitation.",
		});
	});

	it.each(["team_member", "add_device"] as const)(
		"does not classify %s failures as Project invitation failures",
		async (inviteKind) => {
			globalThis.fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "invite_identity_conflict" }), {
						status: 409,
					}),
			) as typeof fetch;

			const failure = await importCoordinatorInvite(
				"recipient-invite",
				undefined,
				inviteKind,
			).catch((cause: unknown) => cause);

			expect(failure).toBeInstanceOf(Error);
			expect(failure).not.toBeInstanceOf(ProjectInviteAcceptanceError);
			expect(failure).toMatchObject({ message: "invite_identity_conflict" });
		},
	);

	it("keeps unknown Project invitation errors untyped", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ detail: "private backend detail", error: "private_code" }), {
					status: 400,
				}),
		) as typeof fetch;

		const failure = await importCoordinatorInvite("unknown-project-invite").catch(
			(cause: unknown) => cause,
		);

		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(ProjectInviteAcceptanceError);
	});

	it("prefers actionable invite-import detail over an opaque error code", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						detail: "Restart codemem to finish project setup.",
						error: "sync_runtime_disabled",
					}),
					{ status: 409 },
				),
		) as typeof fetch;

		await expect(importCoordinatorInvite("project-invite")).rejects.toThrow(
			"Restart codemem to finish project setup.",
		);
	});

	it("ignores blank invite-import detail and falls back to the error code", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ detail: "   ", error: "invalid_invite" }), {
					status: 400,
				}),
		) as typeof fetch;

		await expect(importCoordinatorInvite("bad-invite")).rejects.toThrow("invalid_invite");
	});

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

	it("preserves safe recipient invitation error codes for contextual UI guidance", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: "recipient_invite_intent_mismatch" }), {
				status: 409,
			}),
		) as typeof fetch;

		await expect(inspectCoordinatorInvite("tampered-invite")).rejects.toThrow(
			"recipient_invite_intent_mismatch",
		);
	});
});

describe("legacy Team setup API", () => {
	it("preserves exactly the ten stable design error codes", async () => {
		const errorCodes = [
			"team_setup_incomplete",
			"team_setup_roster_changed",
			"team_setup_assignment_changed",
			"team_setup_roster_unavailable",
			"team_setup_conflict",
			"team_setup_confirmation_stale",
			"team_setup_completion_unavailable",
			"team_setup_completion_conflict",
			"team_setup_completion_invalid",
			"team_setup_failed",
		] as const;
		const responses = [...errorCodes];
		globalThis.fetch = vi.fn(async () => {
			const error = responses.shift();
			return new Response(JSON.stringify({ error }), { status: 409 });
		}) as typeof fetch;

		for (const errorCode of errorCodes) {
			await expect(loadLegacyTeamSetupSummary()).rejects.toMatchObject({ errorCode });
		}
	});

	it("mirrors summary, detail, and all mutation routes without changing payloads", async () => {
		const summary = { version: 1, candidates: [] } as const;
		const detail = {
			version: 1,
			candidate: {
				candidateRef: "candidate/ref",
				displayName: "Example Team",
				status: "in_progress",
				deviceCount: 1,
				projectCount: 1,
				unresolvedDeviceCount: 1,
				unresolvedProjectCount: 0,
			},
			attemptId: "attempt-one",
			state: "reviewing",
			unresolvedDeviceCount: 1,
			unresolvedProjectCount: 0,
			devices: [],
			projects: [],
			identityChoices: [],
			actions: {
				refresh: { enabled: true, blockedReason: null },
				finish: { enabled: false, blockedReason: "setup_incomplete" },
			},
		} as const;
		const mutation = detail;
		const finished = {
			version: 1,
			status: "completed",
			teamRef: "team-ref",
			attemptId: "attempt-one",
			accessDeltaDigest: "access-digest",
			completedAt: "2026-08-24T00:00:00Z",
		} as const;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(mutation), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(mutation), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(mutation), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(mutation), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(mutation), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(finished), { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;
		const assignment = {
			attemptId: "attempt-one",
			targetIdentityRef: "identity-ref",
			expectation: { kind: "absent" as const },
		};
		const decision = {
			attemptId: "attempt-one",
			decision: "included" as const,
			expectedTargetIdentityRef: "identity-ref",
		};
		const clear = { attemptId: "attempt-one" };
		const mapping = { attemptId: "attempt-one", resolvedProjectRef: "resolved-project" };
		const finish = {
			attemptId: "attempt-one",
			finishDigest: "finish-digest",
			confirmedAccessDeltaDigest: "access-digest",
			confirmedViewerAccessDeltaDigest: "viewer-access-digest",
		};

		await loadLegacyTeamSetupSummary();
		await loadLegacyTeamSetupDetail("candidate/ref");
		await saveLegacyTeamSetupAssignment("candidate/ref", "device/ref", assignment);
		await saveLegacyTeamSetupDecision("candidate/ref", "device/ref", decision);
		await clearLegacyTeamSetupDecision("candidate/ref", "device/ref", clear);
		await saveLegacyTeamSetupProjectMapping("candidate/ref", "project/ref", mapping);
		await refreshLegacyTeamSetupCandidate("candidate/ref");
		await finishLegacyTeamSetup("candidate/ref", finish);

		expect(fetchMock.mock.calls).toEqual([
			["/api/sync/team-setup/v1", undefined],
			["/api/sync/team-setup/v1/candidate%2Fref", undefined],
			[
				"/api/sync/team-setup/v1/candidate%2Fref/devices/device%2Fref/assignment",
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(assignment),
				},
			],
			[
				"/api/sync/team-setup/v1/candidate%2Fref/devices/device%2Fref/decision",
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(decision),
				},
			],
			[
				"/api/sync/team-setup/v1/candidate%2Fref/devices/device%2Fref/decision",
				{
					method: "DELETE",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(clear),
				},
			],
			[
				"/api/sync/team-setup/v1/candidate%2Fref/projects/project%2Fref/mapping",
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(mapping),
				},
			],
			[
				"/api/sync/team-setup/v1/candidate%2Fref/refresh",
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
			],
			[
				"/api/sync/team-setup/v1/candidate%2Fref/finish",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(finish),
				},
			],
		]);
	});

	it("rejects completed candidates in the pending-only summary contract", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					version: 1,
					candidates: [
						{
							candidateRef: "completed-candidate",
							displayName: "Completed Team",
							status: "ready",
							deviceCount: 1,
							projectCount: 1,
							unresolvedDeviceCount: 0,
							unresolvedProjectCount: 0,
						},
					],
				}),
				{ status: 200 },
			),
		) as typeof fetch;

		await expect(loadLegacyTeamSetupSummary()).rejects.toMatchObject({
			statusCode: 200,
			errorCode: "team_setup_failed",
		});
	});

	it("preserves only stable bounded error codes and never exposes raw response text", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "team_setup_roster_changed", detail: "secret" }), {
					status: 409,
				}),
			)
			.mockResolvedValueOnce(new Response("private coordinator failure", { status: 500 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: "team_setup_projection_changed",
						detail: "private projection state",
					}),
					{ status: 409 },
				),
			)
			.mockRejectedValueOnce(new Error("private network failure")) as typeof fetch;

		const stable = loadLegacyTeamSetupSummary();
		await expect(stable).rejects.toMatchObject({
			statusCode: 409,
			errorCode: "team_setup_roster_changed",
			message: "team_setup_roster_changed",
		});
		await expect(stable).rejects.toBeInstanceOf(LegacyTeamSetupApiError);
		const unknown = loadLegacyTeamSetupSummary();
		await expect(unknown).rejects.toMatchObject({
			statusCode: 500,
			errorCode: "team_setup_failed",
			message: "team_setup_failed",
		});
		await expect(unknown).rejects.not.toMatchObject({ message: "private coordinator failure" });
		const unexpected = loadLegacyTeamSetupSummary();
		await expect(unexpected).rejects.toMatchObject({
			statusCode: 409,
			errorCode: "team_setup_failed",
			message: "team_setup_failed",
		});
		await expect(unexpected).rejects.not.toMatchObject({ message: "private projection state" });
		await expect(loadLegacyTeamSetupSummary()).rejects.toMatchObject({
			statusCode: 0,
			errorCode: "team_setup_failed",
			message: "team_setup_failed",
		});
	});

	it.each(["", "not json", "{}", "[]"])(
		"rejects malformed successful Team setup payload %j",
		async (body) => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response(body, { status: 200 })) as typeof fetch;

			await expect(loadLegacyTeamSetupSummary()).rejects.toMatchObject({
				statusCode: 200,
				errorCode: "team_setup_failed",
				message: "team_setup_failed",
			});
		},
	);

	it("rejects finishable detail without viewer-bound confirmation evidence", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					version: 1,
					candidate: {
						candidateRef: "candidate/ref",
						displayName: "Example Team",
						status: "in_progress",
						deviceCount: 0,
						projectCount: 0,
						unresolvedDeviceCount: 0,
						unresolvedProjectCount: 0,
					},
					attemptId: "attempt-one",
					state: "ready_to_finish",
					unresolvedDeviceCount: 0,
					unresolvedProjectCount: 0,
					devices: [],
					projects: [],
					identityChoices: [],
					actions: {
						refresh: { enabled: true, blockedReason: null },
						finish: { enabled: true, blockedReason: null },
					},
					finishDigest: "finish-digest",
					accessDeltaDigest: "access-digest",
					accessDelta: {
						teamChanges: [],
						membershipChanges: [],
						projectChanges: [],
						recipientChanges: [],
						deviceAccessChanges: [],
					},
				}),
				{ status: 200 },
			),
		) as typeof fetch;

		await expect(loadLegacyTeamSetupDetail("candidate/ref")).rejects.toMatchObject({
			statusCode: 200,
			errorCode: "team_setup_failed",
		});
	});

	it("accepts each exclusive Team setup view variant with server-computed gates", async () => {
		const enabled = { enabled: true, blockedReason: null } as const;
		const blocked = (blockedReason: "setup_unavailable" | "setup_completed") => ({
			enabled: false as const,
			blockedReason,
		});
		const base = {
			version: 1 as const,
			candidate: {
				candidateRef: "candidate/ref",
				displayName: "Example Team",
				status: "in_progress" as const,
				deviceCount: 1,
				projectCount: 1,
				unresolvedDeviceCount: 0,
				unresolvedProjectCount: 0,
			},
			attemptId: "attempt-one",
			unresolvedDeviceCount: 0,
			unresolvedProjectCount: 0,
			identityChoices: [],
		};
		const items = (reason?: "setup_unavailable" | "setup_completed") => ({
			devices: [
				{
					deviceRef: "device-ref",
					displayName: "Laptop",
					enabled: true,
					existingIdentityRef: null,
					suggestedIdentityRef: null,
					verifiedEvidenceKind: null,
					decision: "unresolved",
					targetIdentityRef: null,
					expectation: { kind: "absent" },
					actions: {
						assignIdentity: reason ? blocked(reason) : enabled,
						include: reason
							? blocked(reason)
							: { enabled: false, blockedReason: "assignment_required" },
						exclude: reason ? blocked(reason) : enabled,
						remove: reason ? blocked(reason) : { enabled: false, blockedReason: "device_active" },
						clearDecision: reason
							? blocked(reason)
							: { enabled: false, blockedReason: "decision_unresolved" },
					},
				},
			],
			projects: [
				{
					projectRef: "project-ref",
					displayName: "Project",
					resolution: "unresolved",
					canonicalProjectRef: null,
					resolvedProjectRef: null,
					mappingChoices: [],
					actions: { map: reason ? blocked(reason) : enabled },
				},
			],
		});
		const accessDelta = {
			teamChanges: [],
			membershipChanges: [],
			projectChanges: [],
			recipientChanges: [],
			deviceAccessChanges: [],
		};
		const views = [
			{
				...base,
				...items(),
				state: "reviewing",
				actions: {
					refresh: enabled,
					finish: { enabled: false, blockedReason: "setup_incomplete" },
				},
			},
			{
				...base,
				...items(),
				state: "ready_to_finish",
				actions: { refresh: enabled, finish: enabled },
				finishDigest: "finish",
				accessDeltaDigest: "access",
				viewerAccessDeltaDigest: "viewer",
				accessDelta,
			},
			{
				...base,
				...items("setup_unavailable"),
				state: "unavailable",
				unavailableReason: "team_setup_conflict",
				actions: {
					refresh: enabled,
					finish: blocked("setup_unavailable"),
				},
			},
			{
				...base,
				...items("setup_completed"),
				state: "completed",
				actions: {
					refresh: blocked("setup_completed"),
					finish: blocked("setup_completed"),
				},
			},
		];
		globalThis.fetch = vi.fn(async () => {
			const view = views.shift();
			return new Response(JSON.stringify(view), { status: 200 });
		}) as typeof fetch;

		for (const state of ["reviewing", "ready_to_finish", "unavailable", "completed"]) {
			await expect(loadLegacyTeamSetupDetail("candidate/ref")).resolves.toMatchObject({ state });
		}
	});

	it("rejects mixed variants and unavailable views with editable item gates", async () => {
		const unavailable = {
			version: 1,
			candidate: {
				candidateRef: "candidate/ref",
				displayName: "Example Team",
				status: "stale",
				deviceCount: 1,
				projectCount: 0,
				unresolvedDeviceCount: 1,
				unresolvedProjectCount: 0,
			},
			attemptId: "attempt-one",
			state: "unavailable",
			unavailableReason: "team_setup_conflict",
			unresolvedDeviceCount: 1,
			unresolvedProjectCount: 0,
			identityChoices: [],
			projects: [],
			devices: [
				{
					deviceRef: "device-ref",
					displayName: "Laptop",
					enabled: true,
					existingIdentityRef: null,
					suggestedIdentityRef: null,
					verifiedEvidenceKind: null,
					decision: "unresolved",
					targetIdentityRef: null,
					expectation: { kind: "absent" },
					actions: {
						assignIdentity: { enabled: true, blockedReason: null },
						include: { enabled: false, blockedReason: "setup_unavailable" },
						exclude: { enabled: false, blockedReason: "setup_unavailable" },
						remove: { enabled: false, blockedReason: "setup_unavailable" },
						clearDecision: { enabled: false, blockedReason: "setup_unavailable" },
					},
				},
			],
			actions: {
				refresh: { enabled: true, blockedReason: null },
				finish: { enabled: false, blockedReason: "setup_unavailable" },
			},
		};
		const mixed = {
			...unavailable,
			devices: unavailable.devices.map((device) => ({
				...device,
				actions: {
					...device.actions,
					assignIdentity: { enabled: false, blockedReason: "setup_unavailable" },
				},
			})),
			finishDigest: "must-not-appear",
		};
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(mixed), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify(unavailable), { status: 200 }),
			) as typeof fetch;

		for (let attempt = 0; attempt < 2; attempt += 1) {
			await expect(loadLegacyTeamSetupDetail("candidate/ref")).rejects.toMatchObject({
				errorCode: "team_setup_failed",
			});
		}
	});

	it.each([
		["summary", () => loadLegacyTeamSetupSummary()],
		["detail", () => loadLegacyTeamSetupDetail("candidate/ref")],
		[
			"mutation",
			() =>
				saveLegacyTeamSetupDecision("candidate/ref", "device/ref", {
					attemptId: "attempt-one",
					decision: "included",
					expectedTargetIdentityRef: "identity-ref",
				}),
		],
		[
			"finish",
			() =>
				finishLegacyTeamSetup("candidate/ref", {
					attemptId: "attempt-one",
					finishDigest: "finish-digest",
					confirmedAccessDeltaDigest: "access-digest",
					confirmedViewerAccessDeltaDigest: "viewer-access-digest",
				}),
		],
	] as const)("rejects a version-only successful %s DTO", async (_name, request) => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ version: 1 }), { status: 200 }),
			) as typeof fetch;

		await expect(request()).rejects.toMatchObject({
			statusCode: 200,
			errorCode: "team_setup_failed",
			message: "team_setup_failed",
		});
	});

	it("rejects non-string enum values in successful Team setup DTOs", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					version: 1,
					candidate: {
						candidateRef: "candidate/ref",
						displayName: "Example Team",
						status: "in_progress",
						deviceCount: 0,
						projectCount: 0,
						unresolvedDeviceCount: 1,
						unresolvedProjectCount: 0,
					},
					attemptId: "attempt-one",
					state: ["reviewing"],
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
					devices: [],
					projects: [],
					identityChoices: [],
					actions: {
						refresh: { enabled: true, blockedReason: null },
						finish: { enabled: false, blockedReason: "setup_incomplete" },
					},
				}),
				{ status: 200 },
			),
		) as typeof fetch;

		await expect(
			saveLegacyTeamSetupDecision("candidate/ref", "device/ref", {
				attemptId: "attempt-one",
				decision: "included",
				expectedTargetIdentityRef: "identity-ref",
			}),
		).rejects.toMatchObject({
			statusCode: 200,
			errorCode: "team_setup_failed",
			message: "team_setup_failed",
		});
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
		const review: RecipientPolicyReviewListV1 = {
			version: 1,
			reviewItems: [],
			blockedItems: [],
			continuity: null,
		};
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

	it("keeps legacy review items visible when continuity is absent", async () => {
		const legacyReview = {
			version: 1,
			reviewItems: [{ reviewItemId: "legacy-review" }],
			blockedItems: [],
		};
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify(legacyReview), { status: 200 }),
			) as typeof fetch;

		await expect(loadRecipientPolicyReview()).resolves.toEqual({
			...legacyReview,
			continuity: { findingCount: 1, state: "legacy_access_preserved" },
		});
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
			outcomes: [{ change: changes[0], outcome: "added" }],
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

	it("returns structured conflict results from edge commit 409 responses", async () => {
		const conflict = {
			version: 1,
			status: "conflict",
			reviewedPolicyDigest: "policy:digest",
			errorCode: "edge_commit_conflict",
			outcomes: [],
			writeCount: 0,
			idempotent: false,
		} as const;
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify(conflict), { status: 409 }),
		) as typeof fetch;

		await expect(
			commitRecipientPolicyEdges({
				version: 1,
				changes: [],
				reviewedPolicyDigest: "policy:digest",
			}),
		).resolves.toEqual(conflict);
	});
});
