import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CoordinatorMembershipError } from "./coordinator-membership-effects.js";
import {
	BetterSqliteCoordinatorStore,
	type CoordinatorCreateInviteInput,
	type CoordinatorCreateJoinRequestInput,
	type CoordinatorCreateReciprocalApprovalInput,
	type CoordinatorCreateScopeInput,
	type CoordinatorEnrollDeviceInput,
	type CoordinatorEnrollment,
	type CoordinatorGrantScopeMembershipInput,
	type CoordinatorGroup,
	type CoordinatorInvite,
	type CoordinatorJoinRequest,
	type CoordinatorJoinRequestReviewResult,
	type CoordinatorListReciprocalApprovalsInput,
	type CoordinatorListScopeMembershipAuditInput,
	type CoordinatorListScopesInput,
	type CoordinatorPeerRecord,
	type CoordinatorPresenceRecord,
	type CoordinatorReciprocalApproval,
	type CoordinatorRequestVerifier,
	type CoordinatorReviewJoinRequestInput,
	type CoordinatorRevokeScopeMembershipInput,
	type CoordinatorScope,
	type CoordinatorScopeMembership,
	type CoordinatorScopeMembershipAuditEvent,
	type CoordinatorStoreInterface,
	type CoordinatorUpdateScopeInput,
	type CoordinatorUpsertPresenceInput,
	createCoordinatorApp,
	fingerprintPublicKey,
	type RecipientReviewedIntentV1,
	recipientReviewedIntentDigest,
} from "./index.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

function createMockStore(
	overrides?: Partial<CoordinatorStoreInterface>,
): CoordinatorStoreInterface {
	const defaultStore: CoordinatorStoreInterface = {
		close: vi.fn(async () => undefined),
		createGroup: vi.fn(async () => undefined),
		getGroup: vi.fn(async (): Promise<CoordinatorGroup | null> => null),
		listGroups: vi.fn(async (): Promise<CoordinatorGroup[]> => []),
		renameGroup: vi.fn(async () => false),
		archiveGroup: vi.fn(async () => false),
		unarchiveGroup: vi.fn(async () => false),
		enrollDevice: vi.fn(async (_: string, __: CoordinatorEnrollDeviceInput) => undefined),
		listEnrolledDevices: vi.fn(
			async (_: string, __?: boolean): Promise<CoordinatorEnrollment[]> => [],
		),
		getEnrollment: vi.fn(
			async (_: string, __: string): Promise<CoordinatorEnrollment | null> => null,
		),
		renameDevice: vi.fn(async () => false),
		setDeviceEnabled: vi.fn(async () => false),
		removeDevice: vi.fn(async () => false),
		recordNonce: vi.fn(async () => true),
		cleanupNonces: vi.fn(async () => undefined),
		createInvite: vi.fn(async (_: CoordinatorCreateInviteInput): Promise<CoordinatorInvite> => {
			throw new Error("not implemented");
		}),
		getInviteByToken: vi.fn(async (_: string): Promise<CoordinatorInvite | null> => null),
		getInviteByTokenForInspection: vi.fn(
			async (_: string): Promise<CoordinatorInvite | null> => null,
		),
		inspectRecipientInvite: vi.fn(async () => null),
		consumeRecipientInvite: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		consumeProjectInvite: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		listInvites: vi.fn(async (_: string): Promise<CoordinatorInvite[]> => []),
		createJoinRequest: vi.fn(
			async (_: CoordinatorCreateJoinRequestInput): Promise<CoordinatorJoinRequest> => {
				throw new Error("not implemented");
			},
		),
		listJoinRequests: vi.fn(
			async (_: string, __?: string): Promise<CoordinatorJoinRequest[]> => [],
		),
		reviewJoinRequest: vi.fn(
			async (
				_: CoordinatorReviewJoinRequestInput,
			): Promise<CoordinatorJoinRequestReviewResult | null> => null,
		),
		createReciprocalApproval: vi.fn(
			async (
				_: CoordinatorCreateReciprocalApprovalInput,
			): Promise<CoordinatorReciprocalApproval> => {
				throw new Error("not implemented");
			},
		),
		listReciprocalApprovals: vi.fn(
			async (
				_: CoordinatorListReciprocalApprovalsInput,
			): Promise<CoordinatorReciprocalApproval[]> => [],
		),
		upsertPresence: vi.fn(
			async (_: CoordinatorUpsertPresenceInput): Promise<CoordinatorPresenceRecord> => {
				throw new Error("not implemented");
			},
		),
		listGroupPeers: vi.fn(async (_: string, __: string): Promise<CoordinatorPeerRecord[]> => []),
		createBootstrapGrant: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		getBootstrapGrant: vi.fn(async () => null),
		listBootstrapGrants: vi.fn(async () => []),
		revokeBootstrapGrant: vi.fn(async () => false),
		createScope: vi.fn(async (_: CoordinatorCreateScopeInput): Promise<CoordinatorScope> => {
			throw new Error("not implemented");
		}),
		updateScope: vi.fn(
			async (_: CoordinatorUpdateScopeInput): Promise<CoordinatorScope | null> => null,
		),
		listScopes: vi.fn(async (_?: CoordinatorListScopesInput): Promise<CoordinatorScope[]> => []),
		grantScopeMembership: vi.fn(
			async (_: CoordinatorGrantScopeMembershipInput): Promise<CoordinatorScopeMembership> => {
				throw new Error("not implemented");
			},
		),
		revokeScopeMembership: vi.fn(
			async (_: CoordinatorRevokeScopeMembershipInput): Promise<boolean> => false,
		),
		listScopeMemberships: vi.fn(
			async (_: string, __?: boolean): Promise<CoordinatorScopeMembership[]> => [],
		),
		listScopeMembershipAuditEvents: vi.fn(
			async (
				_: CoordinatorListScopeMembershipAuditInput,
			): Promise<CoordinatorScopeMembershipAuditEvent[]> => [],
		),
	};
	return { ...defaultStore, ...overrides };
}

const allowRequest: CoordinatorRequestVerifier = async () => true;

function authHeaders(deviceId = "device-a", nonce = "nonce-a") {
	return {
		"X-Opencode-Device": deviceId,
		"X-Opencode-Signature": "sig",
		"X-Opencode-Timestamp": "2026-03-28T00:00:00Z",
		"X-Opencode-Nonce": nonce,
	};
}

function teamReviewedIntent(teamId = "policy-team-1"): RecipientReviewedIntentV1 {
	return {
		version: 1,
		journey: "team",
		team: { teamId, displayName: "Product", futureProjectsInherit: true },
		projects: [
			{
				canonicalProjectIdentity: "git:https://example.test/codemem",
				displayName: "codemem",
				existingMemoryCount: 3,
				futureMemoriesShared: true,
				sources: [{ kind: "team", teamId, displayName: "Product" }],
			},
		],
		excludedProjects: [],
	};
}

describe("createCoordinatorApp dependency injection", () => {
	it("uses injected admin secret and store factory for admin routes", async () => {
		const store = createMockStore({
			listEnrolledDevices: vi.fn(async () => [
				{
					group_id: "g1",
					device_id: "d1",
					public_key: "pk1",
					fingerprint: "fp1",
					display_name: "Laptop",
					enabled: 1,
					created_at: "2026-03-28T00:00:00Z",
				},
			]),
		});
		const storeFactory = vi.fn(() => store);
		const app = createCoordinatorApp({
			storeFactory,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/devices?group_id=g1", {
			headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			items: [
				{
					group_id: "g1",
					device_id: "d1",
					public_key: "pk1",
					fingerprint: "fp1",
					display_name: "Laptop",
					enabled: 1,
					created_at: "2026-03-28T00:00:00Z",
				},
			],
		});
		expect(storeFactory).toHaveBeenCalledTimes(1);
		expect(store.listEnrolledDevices).toHaveBeenCalledWith("g1", false);
		expect(store.close).toHaveBeenCalledTimes(1);
	});

	it("rejects an invalid invite expires_at with 400 instead of a 500", async () => {
		const store = createMockStore({});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/invites", {
			method: "POST",
			headers: {
				"X-Codemem-Coordinator-Admin": "test-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ group_id: "g1", policy: "auto_admit", expires_at: "not-a-date" }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_expires_at" });
		expect(store.createInvite).not.toHaveBeenCalled();
	});

	it("validates and retains an additive project-intent reference while legacy invites remain valid", async () => {
		const createInvite = vi.fn(async (input: CoordinatorCreateInviteInput) => ({
			invite_id: "invite-1",
			group_id: input.groupId,
			token: "token-1",
			policy: input.policy,
			expires_at: input.expiresAt,
			created_at: "2026-03-28T00:00:00Z",
			created_by: null,
			team_name_snapshot: "Team One",
			revoked_at: null,
			operation_id: input.operationId ?? null,
			reviewed_project_set_digest: input.reviewedProjectSetDigest ?? null,
			inviter_actor_id: input.inviterActorId ?? null,
			inviter_display_name: input.inviterDisplayName ?? null,
			inviter_device_id: input.inviterDeviceId ?? null,
			pending_person_id: input.pendingPersonId ?? null,
		}));
		const store = createMockStore({
			createInvite,
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Team One",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});
		const headers = {
			"X-Codemem-Coordinator-Admin": "test-secret",
			"Content-Type": "application/json",
		};
		const base = {
			group_id: "g1",
			policy: "auto_admit",
			expires_at: "2026-04-04T00:00:00Z",
			coordinator_url: "https://coord.example.test",
		};

		const incomplete = await app.request("/v1/admin/invites", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...base, operation_id: `share_${"a".repeat(40)}` }),
		});
		expect(incomplete.status).toBe(400);
		expect(await incomplete.json()).toEqual({ error: "operation_intent_reference_incomplete" });

		const legacy = await app.request("/v1/admin/invites", {
			method: "POST",
			headers,
			body: JSON.stringify(base),
		});
		expect(legacy.status).toBe(200);

		const operationId = `share_${"a".repeat(40)}`;
		const reviewedProjectSetDigest = "b".repeat(64);
		const projectFirst = await app.request("/v1/admin/invites", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...base,
				operation_id: operationId,
				reviewed_project_set_digest: reviewedProjectSetDigest,
				inviter_actor_id: "actor-adam",
				inviter_display_name: "Adam",
				inviter_device_id: "device-adam",
				pending_person_id: "pending-brian",
				project_summaries: [{ display_name: "codemem", existing_memory_count: 3 }],
				project_intent: [
					{
						canonical_identity: "git:https://example.test/codemem",
						display_name: "codemem",
						existing_memory_count: 3,
					},
				],
			}),
		});
		expect(projectFirst.status).toBe(200);
		const projectPayload = (await projectFirst.json()) as {
			payload: Record<string, unknown>;
		};
		expect(projectPayload.payload).toMatchObject({
			operation_id: operationId,
			inviter_name: "Adam",
			project_summaries: [{ display_name: "codemem", existing_memory_count: 3 }],
		});
		expect(projectPayload.payload).not.toHaveProperty("project_intent");
		expect(projectPayload.payload).not.toHaveProperty("scope_ids");
		expect(createInvite).toHaveBeenLastCalledWith(
			expect.objectContaining({ operationId, reviewedProjectSetDigest }),
		);
	});

	it("validates recipient reviewed intent at creation and keeps invitation payloads digest-only", async () => {
		const reviewedIntent = teamReviewedIntent();
		const digest = await recipientReviewedIntentDigest(reviewedIntent);
		const createInvite = vi.fn(async (input: CoordinatorCreateInviteInput) => ({
			invite_id: "invite-team-1",
			group_id: input.groupId,
			token: "team-token",
			policy: input.policy,
			expires_at: input.expiresAt,
			created_at: "2026-03-28T00:00:00Z",
			created_by: null,
			team_name_snapshot: "Coordinator One",
			revoked_at: null,
			invite_kind: "team_member" as const,
			policy_team_id: "policy-team-1",
			reviewed_preview_digest: digest,
		}));
		const store = createMockStore({
			createInvite,
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Coordinator One",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});
		const headers = {
			"X-Codemem-Coordinator-Admin": "test-secret",
			"Content-Type": "application/json",
		};
		const base = {
			group_id: "g1",
			policy: "auto_admit",
			expires_at: "2026-04-04T00:00:00Z",
			coordinator_url: "https://coord.example.test",
			invite_kind: "team_member",
			policy_team_id: "policy-team-1",
			reviewed_preview_digest: digest,
		};

		const missing = await app.request("/v1/admin/invites", {
			method: "POST",
			headers,
			body: JSON.stringify(base),
		});
		expect(missing.status).toBe(400);
		expect(await missing.json()).toEqual({ error: "recipient_invite_review_unavailable" });

		const mismatched = await app.request("/v1/admin/invites", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...base, reviewed_intent: teamReviewedIntent("other-team") }),
		});
		expect(mismatched.status).toBe(409);
		expect(await mismatched.json()).toEqual({ error: "recipient_invite_intent_mismatch" });

		const malformed = await app.request("/v1/admin/invites", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...base, reviewed_intent: { version: 1, journey: "team" } }),
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toEqual({ error: "recipient_invite_review_unavailable" });

		const digestMismatch = await app.request("/v1/admin/invites", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...base,
				reviewed_preview_digest: "f".repeat(64),
				reviewed_intent: reviewedIntent,
			}),
		});
		expect(digestMismatch.status).toBe(409);
		expect(await digestMismatch.json()).toEqual({ error: "recipient_invite_intent_mismatch" });

		const valid = await app.request("/v1/admin/invites", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...base, reviewed_intent: reviewedIntent }),
		});
		expect(valid.status).toBe(200);
		const response = (await valid.json()) as {
			payload: Record<string, unknown>;
			encoded: string;
			link: string;
		};
		expect(createInvite).toHaveBeenCalledWith(
			expect.objectContaining({ reviewedIntent, reviewedPreviewDigest: digest }),
		);
		expect(response.payload).not.toHaveProperty("reviewed_intent");
		expect(response.encoded).not.toContain("reviewed_intent");
		expect(response.link).not.toContain("reviewed_intent");
	});

	it("returns safe errors for unavailable or mismatched stored recipient reviews", async () => {
		const invite: CoordinatorInvite = {
			invite_id: "invite-team-1",
			group_id: "g1",
			token: "team-token",
			policy: "auto_admit",
			expires_at: "2099-01-01T00:00:00Z",
			created_at: "2026-03-28T00:00:00Z",
			created_by: null,
			team_name_snapshot: "Coordinator One",
			revoked_at: null,
			invite_kind: "team_member",
			policy_team_id: "policy-team-1",
			reviewed_preview_digest: "e".repeat(64),
		};
		const inspectRecipientInvite = vi
			.fn()
			.mockRejectedValueOnce(new Error("recipient_invite_review_unavailable"))
			.mockRejectedValueOnce(new Error("recipient_invite_intent_mismatch"));
		const store = createMockStore({
			getInviteByTokenForInspection: vi.fn(async () => invite),
			inspectRecipientInvite,
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});
		const inspect = () =>
			app.request("/v1/invites/inspect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: invite.token }),
			});

		const unavailable = await inspect();
		expect(unavailable.status).toBe(409);
		expect(await unavailable.json()).toEqual({ error: "recipient_invite_review_unavailable" });
		const mismatched = await inspect();
		expect(mismatched.status).toBe(409);
		expect(await mismatched.json()).toEqual({ error: "recipient_invite_intent_mismatch" });
	});

	it("inspects and consumes explicit Team invitations without enrollment or scope grants", async () => {
		const publicKey = "recipient-public-key";
		const reviewedIntent = teamReviewedIntent();
		const digest = await recipientReviewedIntentDigest(reviewedIntent);
		const invite: CoordinatorInvite = {
			invite_id: "invite-team-1",
			group_id: "g1",
			token: "team-token",
			policy: "auto_admit",
			expires_at: "2099-01-01T00:00:00Z",
			created_at: "2026-03-28T00:00:00Z",
			created_by: null,
			team_name_snapshot: "Coordinator One",
			revoked_at: null,
			invite_kind: "team_member",
			policy_team_id: "policy-team-1",
			reviewed_preview_digest: digest,
		};
		const consumeRecipientInvite = vi.fn(async () => ({
			status: "accepted" as const,
			invite: {
				...invite,
				consumed_at: "2026-03-28T00:00:00Z",
				recipient_actor_id: "identity-brian",
			},
			reviewed_intent: reviewedIntent,
		}));
		const store = createMockStore({
			getInviteByTokenForInspection: vi.fn(async () => invite),
			inspectRecipientInvite: vi.fn(async () => ({
				kind: "team_member" as const,
				invite,
				policy_team_id: "policy-team-1",
				reviewed_preview_digest: digest,
				reviewed_intent: reviewedIntent,
				bound: false,
			})),
			consumeRecipientInvite,
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});

		const inspection = await app.request("/v1/invites/inspect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: invite.token }),
		});
		expect(await inspection.json()).toEqual({
			kind: "team_member",
			policy_team_id: "policy-team-1",
			reviewed_preview_digest: digest,
			reviewed_intent: reviewedIntent,
			bound: false,
		});

		const accepted = await app.request("/v1/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: invite.token,
				invite_kind: "team_member",
				identity_id: "identity-brian",
				device_id: "device-brian",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
			}),
		});
		expect(await accepted.json()).toMatchObject({
			ok: true,
			status: "accepted",
			kind: "team_member",
			identity_id: "identity-brian",
			policy_team_id: "policy-team-1",
			reviewed_preview_digest: digest,
			reviewed_intent: reviewedIntent,
		});
		expect(consumeRecipientInvite).toHaveBeenCalledOnce();
		expect(store.enrollDevice).not.toHaveBeenCalled();
		expect(store.grantScopeMembership).not.toHaveBeenCalled();
	});

	it("fails closed when project-first acceptance omits identity confirmation", async () => {
		const publicKey = "recipient-public-key";
		const store = createMockStore({
			getInviteByTokenForInspection: vi.fn(async () => ({
				invite_id: "invite-project-1",
				group_id: "g1",
				token: "token-project-1",
				policy: "auto_admit",
				expires_at: "2099-01-01T00:00:00Z",
				created_at: "2026-03-28T00:00:00Z",
				created_by: null,
				team_name_snapshot: "Team One",
				revoked_at: null,
				operation_id: `share_${"a".repeat(40)}`,
				reviewed_project_set_digest: "b".repeat(64),
			})),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});

		const response = await app.request("/v1/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: "token-project-1",
				device_id: "device-recipient",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "project_invite_identity_required",
		});
		expect(store.enrollDevice).not.toHaveBeenCalled();
		expect(store.createJoinRequest).not.toHaveBeenCalled();
	});

	it("preserves add-device idempotent existing status", async () => {
		const publicKey = "add-device-public-key";
		const invite = {
			invite_id: "invite-add-device-1",
			group_id: "g1",
			token: "token-add-device-1",
			policy: "auto_admit",
			expires_at: "2099-01-01T00:00:00Z",
			created_at: "2026-03-28T00:00:00Z",
			created_by: null,
			team_name_snapshot: "Coordinator One",
			revoked_at: null,
			invite_kind: "add_device" as const,
			target_identity_id: "identity-brian",
			reviewed_preview_digest: "d".repeat(64),
		};
		const consumeRecipientInvite = vi.fn(async () => ({
			status: "existing" as const,
			invite: { ...invite, recipient_actor_id: "identity-brian" },
		}));
		const store = createMockStore({
			getInviteByTokenForInspection: vi.fn(async () => invite),
			consumeRecipientInvite,
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});

		const response = await app.request("/v1/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: invite.token,
				invite_kind: "add_device",
				identity_id: "identity-brian",
				device_id: "device-brian-2",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "existing",
			kind: "add_device",
			target_identity_id: "identity-brian",
		});
		expect(consumeRecipientInvite).toHaveBeenCalledOnce();
	});

	it("rejects project invites accepted by the inviter device", async () => {
		const publicKey = "inviter-public-key";
		const operationId = `share_${"a".repeat(40)}`;
		const consumeProjectInvite = vi.fn(async () => {
			throw new Error("should not consume an invite on the inviter device");
		});
		const store = createMockStore({
			getInviteByTokenForInspection: vi.fn(async () => ({
				invite_id: "invite-project-1",
				group_id: "g1",
				token: "token-project-1",
				policy: "auto_admit",
				expires_at: "2099-01-01T00:00:00Z",
				created_at: "2026-03-28T00:00:00Z",
				created_by: null,
				team_name_snapshot: "Team One",
				revoked_at: null,
				operation_id: operationId,
				reviewed_project_set_digest: "b".repeat(64),
				inviter_device_id: "device-adam",
			})),
			consumeProjectInvite,
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});

		const response = await app.request("/v1/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: "token-project-1",
				operation_id: operationId,
				device_id: "device-adam",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				recipient_actor_id: "actor-adam",
				recipient_display_name: "Adam",
				device_display_name: "Adam's Mac",
			}),
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "project_invite_self_acceptance_forbidden",
		});
		expect(consumeProjectInvite).not.toHaveBeenCalled();
	});

	it("rejects project identity fields on a legacy invite before enrollment", async () => {
		const publicKey = "recipient-public-key";
		const enrollDevice = vi.fn(async () => undefined);
		const store = createMockStore({
			getInviteByTokenForInspection: vi.fn(async () => ({
				invite_id: "invite-legacy-1",
				group_id: "g1",
				token: "token-legacy-1",
				policy: "auto_admit",
				expires_at: "2099-01-01T00:00:00Z",
				created_at: "2026-03-28T00:00:00Z",
				created_by: null,
				team_name_snapshot: "Team One",
				revoked_at: null,
				operation_id: null,
				reviewed_project_set_digest: null,
			})),
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Team One",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			enrollDevice,
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});

		const response = await app.request("/v1/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: "token-legacy-1",
				operation_id: `share_${"a".repeat(40)}`,
				device_id: "device-recipient",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				recipient_actor_id: "actor-brian",
				recipient_display_name: "Brian",
				device_display_name: "Brian's Mac",
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "unexpected_project_invite_fields" });
		expect(enrollDevice).not.toHaveBeenCalled();
	});

	it("allows an identically bound project invite retry after expiry", async () => {
		const publicKey = "recipient-public-key";
		const operationId = `share_${"a".repeat(40)}`;
		const consumeProjectInvite = vi.fn(async () => ({
			status: "existing" as const,
			invite: { trust_state: "bootstrap_grant_created" },
			bootstrap_grant: null,
		}));
		const store = createMockStore({
			getInviteByTokenForInspection: vi.fn(async () => ({
				invite_id: "invite-project-1",
				group_id: "g1",
				token: "consumed:invite-project-1",
				policy: "auto_admit",
				expires_at: "2026-03-27T00:00:00Z",
				created_at: "2026-03-20T00:00:00Z",
				created_by: null,
				team_name_snapshot: "Team One",
				revoked_at: null,
				consumed_at: "2026-03-26T00:00:00Z",
				operation_id: operationId,
				reviewed_project_set_digest: "b".repeat(64),
				inviter_device_id: "device-adam",
			})),
			consumeProjectInvite,
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});

		const response = await app.request("/v1/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: "token-project-1",
				operation_id: operationId,
				device_id: "device-recipient",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				recipient_actor_id: "actor-brian",
				recipient_display_name: "Brian",
				device_display_name: "Brian's Mac",
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, status: "pending_setup" });
		expect(consumeProjectInvite).toHaveBeenCalledOnce();
	});

	it("reports a newly consumed project invite as pending setup", async () => {
		const publicKey = "recipient-public-key";
		const operationId = `share_${"b".repeat(40)}`;
		const consumeProjectInvite = vi.fn(async () => ({
			status: "accepted" as const,
			invite: {
				group_id: "g1",
				operation_id: operationId,
				trust_state: "pending_inviter_device",
			},
			bootstrap_grant: null,
			seed_enrollment: null,
		}));
		const store = createMockStore({
			getInviteByTokenForInspection: vi.fn(async () => ({
				invite_id: "invite-project-new",
				group_id: "g1",
				token: "token-project-new",
				policy: "auto_admit",
				expires_at: "2099-01-01T00:00:00Z",
				created_at: "2026-03-28T00:00:00Z",
				created_by: null,
				team_name_snapshot: "Team One",
				revoked_at: null,
				operation_id: operationId,
				reviewed_project_set_digest: "c".repeat(64),
				inviter_device_id: "device-adam",
			})),
			consumeProjectInvite,
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});

		const response = await app.request("/v1/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token: "token-project-new",
				operation_id: operationId,
				device_id: "device-recipient",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				recipient_actor_id: "actor-brian",
				recipient_display_name: "Brian",
				device_display_name: "Brian's Mac",
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			status: "pending_setup",
			operation_id: operationId,
			trust_state: "pending_inviter_device",
		});
		expect(consumeProjectInvite).toHaveBeenCalledOnce();
	});

	it("reconstructs a safe project invite link only while the coordinator token is unconsumed", async () => {
		const operationId = `share_${"c".repeat(40)}`;
		const invite = {
			invite_id: "invite-project-copy",
			group_id: "g1",
			token: "token-project-copy",
			policy: "auto_admit",
			expires_at: "2099-01-01T00:00:00Z",
			created_at: "2026-03-28T00:00:00Z",
			created_by: null,
			team_name_snapshot: "Team One",
			revoked_at: null,
			operation_id: operationId,
			reviewed_project_set_digest: "d".repeat(64),
			inviter_display_name: "Adam",
			project_intent_json: JSON.stringify([
				{
					canonical_identity: "git:https://example.test/codemem",
					display_name: "codemem",
					existing_memory_count: 3,
				},
			]),
			consumed_at: null as string | null,
		};
		const store = createMockStore({ listInvites: vi.fn(async () => [invite]) });
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});
		const request = () =>
			app.request(`/v1/admin/project-invites/${operationId}?group_id=g1`, {
				headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
			});

		const pending = (await (await request()).json()) as Record<string, unknown>;
		expect(pending.invite_link).toMatch(/^codemem:\/\/join\?invite=/u);
		expect(JSON.stringify(pending)).not.toContain("token-project-copy");

		invite.consumed_at = "2026-03-28T01:00:00Z";
		invite.token = "consumed:invite-project-copy";
		const consumed = (await (await request()).json()) as Record<string, unknown>;
		expect(consumed.invite_link).toBeNull();
		expect(JSON.stringify(consumed)).not.toContain("token-project-copy");
	});

	it("rejects invalid project-invite identity fields before consuming the invite", async () => {
		const publicKey = "recipient-public-key";
		const consumeProjectInvite = vi.fn(async () => {
			throw new Error("should not consume invalid identity");
		});
		const store = createMockStore({
			getInviteByTokenForInspection: vi.fn(async () => ({
				invite_id: "invite-project-1",
				group_id: "g1",
				token: "token-project-1",
				policy: "auto_admit",
				expires_at: "2099-01-01T00:00:00Z",
				created_at: "2026-03-28T00:00:00Z",
				created_by: null,
				team_name_snapshot: "Team One",
				revoked_at: null,
				operation_id: `share_${"a".repeat(40)}`,
				reviewed_project_set_digest: "b".repeat(64),
			})),
			consumeProjectInvite,
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "test-secret", now: () => "2026-03-28T00:00:00Z" },
			requestVerifier: allowRequest,
		});
		const base = {
			token: "token-project-1",
			operation_id: `share_${"a".repeat(40)}`,
			device_id: "device-recipient",
			public_key: publicKey,
			fingerprint: fingerprintPublicKey(publicKey),
			recipient_actor_id: "actor-brian",
			recipient_display_name: "Brian",
			device_display_name: "Brian's Mac",
		};

		const invalidActor = await app.request("/v1/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...base, recipient_actor_id: "actor\u0000brian" }),
		});
		expect(invalidActor.status).toBe(400);
		expect(await invalidActor.json()).toEqual({ error: "recipient_actor_id_invalid" });

		const invalidName = await app.request("/v1/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...base, recipient_display_name: "x".repeat(121) }),
		});
		expect(invalidName.status).toBe(400);
		expect(await invalidName.json()).toEqual({ error: "recipient_display_name_too_long" });
		expect(consumeProjectInvite).not.toHaveBeenCalled();
	});

	it("rate limits repeated coordinator reads before route handling continues", async () => {
		const store = createMockStore({
			listEnrolledDevices: vi.fn(async () => []),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
			requestRateLimit: {
				limiter: createInMemoryRequestRateLimiter(),
				readLimit: 1,
			},
		});

		expect(
			await app.request("/v1/admin/devices?group_id=g1", {
				headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
			}),
		).toHaveProperty("status", 200);

		const limited = await app.request("/v1/admin/devices?group_id=g1", {
			headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
		});
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBeTruthy();
		expect(await limited.json()).toEqual({
			error: "rate_limited",
			retry_after_s: expect.any(Number),
		});
	});

	it("does not let invalid admin requests consume the authenticated admin bucket", async () => {
		const store = createMockStore({
			listEnrolledDevices: vi.fn(async () => []),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
			requestRateLimit: {
				limiter: createInMemoryRequestRateLimiter(),
				readLimit: 1,
				unauthenticatedReadLimit: 1,
			},
		});

		expect(
			await app.request("/v1/admin/devices?group_id=g1", {
				headers: { "X-Codemem-Coordinator-Admin": "wrong-secret" },
			}),
		).toHaveProperty("status", 401);

		expect(
			await app.request("/v1/admin/devices?group_id=g1", {
				headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
			}),
		).toHaveProperty("status", 200);
	});

	it("rejects signed presence and peer reads for archived groups", async () => {
		const enrollment: CoordinatorEnrollment = {
			group_id: "g1",
			device_id: "d1",
			public_key: "pk1",
			fingerprint: "fp1",
			display_name: "Laptop",
			enabled: 1,
			created_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getEnrollment: vi.fn(async () => enrollment),
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Group 1",
				archived_at: "2026-05-22T00:00:00Z",
				created_at: "2026-03-28T00:00:00Z",
			})),
			upsertPresence: vi.fn(async (): Promise<CoordinatorPresenceRecord> => {
				throw new Error("presence should not update archived groups");
			}),
			listGroupPeers: vi.fn(async (): Promise<CoordinatorPeerRecord[]> => {
				throw new Error("peers should not list archived groups");
			}),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const headers = {
			"Content-Type": "application/json",
			"X-Opencode-Device": "d1",
			"X-Opencode-Signature": "sig",
			"X-Opencode-Timestamp": "2026-03-28T00:00:00Z",
			"X-Opencode-Nonce": "nonce-1",
		};
		const presence = await app.request("/v1/presence", {
			method: "POST",
			headers,
			body: JSON.stringify({ group_id: "g1", fingerprint: "fp1", addresses: [] }),
		});
		const peers = await app.request("/v1/peers?group_id=g1", {
			headers: { ...headers, "X-Opencode-Nonce": "nonce-2" },
		});

		expect(presence.status).toBe(409);
		expect(await presence.json()).toEqual({ error: "group_archived" });
		expect(peers.status).toBe(409);
		expect(await peers.json()).toEqual({ error: "group_archived" });
		expect(store.upsertPresence).not.toHaveBeenCalled();
		expect(store.listGroupPeers).not.toHaveBeenCalled();
	});

	it("rate limits archived-group authentication failures", async () => {
		const enrollment: CoordinatorEnrollment = {
			group_id: "g1",
			device_id: "d1",
			public_key: "pk1",
			fingerprint: "fp1",
			display_name: "Laptop",
			enabled: 1,
			created_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getEnrollment: vi.fn(async () => enrollment),
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Group 1",
				archived_at: "2026-05-22T00:00:00Z",
				created_at: "2026-03-28T00:00:00Z",
			})),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
			requestRateLimit: {
				limiter: createInMemoryRequestRateLimiter(),
				readLimit: 10,
				unauthenticatedReadLimit: 1,
				unauthenticatedMutationLimit: 1,
			},
		});

		const headers = {
			"Content-Type": "application/json",
			"X-Opencode-Device": "d1",
			"X-Opencode-Signature": "sig",
			"X-Opencode-Timestamp": "2026-03-28T00:00:00Z",
			"X-Opencode-Nonce": "nonce-1",
		};
		expect(
			await app.request("/v1/presence", {
				method: "POST",
				headers,
				body: JSON.stringify({ group_id: "g1", fingerprint: "fp1", addresses: [] }),
			}),
		).toHaveProperty("status", 409);

		const limited = await app.request("/v1/presence", {
			method: "POST",
			headers: { ...headers, "X-Opencode-Nonce": "nonce-2" },
			body: JSON.stringify({ group_id: "g1", fingerprint: "fp1", addresses: [] }),
		});

		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({
			error: "rate_limited",
			retry_after_s: expect.any(Number),
		});
	});

	it("does not rely on process env when runtime admin secret is unset", async () => {
		const app = createCoordinatorApp({
			storeFactory: () => createMockStore(),
			runtime: {
				adminSecret: () => null,
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/devices?group_id=g1", {
			headers: { "X-Codemem-Coordinator-Admin": "ignored" },
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "admin_not_configured" });
	});

	it("lists bootstrap grants for admins", async () => {
		const store = createMockStore({
			listBootstrapGrants: vi.fn(async () => [
				{
					grant_id: "grant-1",
					group_id: "g1",
					seed_device_id: "seed-1",
					worker_device_id: "worker-1",
					expires_at: "2099-01-01T00:00:00Z",
					created_at: "2026-01-01T00:00:00Z",
					created_by: "admin",
					revoked_at: null,
				},
			]),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});
		const res = await app.request("/v1/admin/bootstrap-grants?group_id=g1", {
			headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			items: [
				expect.objectContaining({
					grant_id: "grant-1",
					group_id: "g1",
					seed_device_id: "seed-1",
				}),
			],
		});
	});

	it("revokes bootstrap grants for admins", async () => {
		const store = createMockStore({
			revokeBootstrapGrant: vi.fn(async () => true),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});
		const res = await app.request("/v1/admin/bootstrap-grants/revoke", {
			method: "POST",
			headers: {
				"X-Codemem-Coordinator-Admin": "test-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ grant_id: "grant-1" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, grant_id: "grant-1" });
	});

	it("lists reciprocal approvals for the authenticated device", async () => {
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Group 1",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			getEnrollment: vi.fn(async () => ({
				group_id: "g1",
				device_id: "local-device",
				public_key: "pk1",
				fingerprint: "fp1",
				display_name: "Laptop",
				enabled: 1,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listReciprocalApprovals: vi.fn(async () => [
				{
					request_id: "req-1",
					group_id: "g1",
					requesting_device_id: "peer-a",
					requested_device_id: "local-device",
					status: "pending",
					created_at: "2026-03-28T00:00:00Z",
					resolved_at: null,
				},
			]),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request(
			"/v1/reciprocal-approvals?group_id=g1&direction=incoming&status=pending",
			{
				headers: {
					"X-Opencode-Device": "local-device",
					"X-Opencode-Signature": "v1:test",
					"X-Opencode-Timestamp": "123",
					"X-Opencode-Nonce": "nonce-1",
				},
			},
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			items: [
				{
					request_id: "req-1",
					group_id: "g1",
					requesting_device_id: "peer-a",
					requested_device_id: "local-device",
					status: "pending",
					created_at: "2026-03-28T00:00:00Z",
					resolved_at: null,
				},
			],
		});
		expect(store.listReciprocalApprovals).toHaveBeenCalledWith({
			groupId: "g1",
			deviceId: "local-device",
			direction: "incoming",
			status: "pending",
		});
	});

	it("creates a reciprocal approval for the authenticated device", async () => {
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Group 1",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			getEnrollment: vi.fn(async (groupId: string, deviceId: string) => {
				if (groupId !== "g1") return null;
				if (deviceId === "local-device" || deviceId === "peer-a") {
					return {
						group_id: "g1",
						device_id: deviceId,
						public_key: deviceId === "local-device" ? "pk1" : "pk2",
						fingerprint: deviceId === "local-device" ? "fp1" : "fp2",
						display_name: deviceId,
						enabled: 1,
						created_at: "2026-03-28T00:00:00Z",
					};
				}
				return null;
			}),
			createReciprocalApproval: vi.fn(async () => ({
				request_id: "req-2",
				group_id: "g1",
				requesting_device_id: "local-device",
				requested_device_id: "peer-a",
				status: "pending",
				created_at: "2026-03-28T00:00:00Z",
				resolved_at: null,
			})),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/reciprocal-approvals", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Opencode-Device": "local-device",
				"X-Opencode-Signature": "v1:test",
				"X-Opencode-Timestamp": "123",
				"X-Opencode-Nonce": "nonce-2",
			},
			body: JSON.stringify({ group_id: "g1", requested_device_id: "peer-a" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			request: {
				request_id: "req-2",
				group_id: "g1",
				requesting_device_id: "local-device",
				requested_device_id: "peer-a",
				status: "pending",
				created_at: "2026-03-28T00:00:00Z",
				resolved_at: null,
			},
		});
		expect(store.createReciprocalApproval).toHaveBeenCalledWith({
			groupId: "g1",
			requestingDeviceId: "local-device",
			requestedDeviceId: "peer-a",
		});
	});

	it("lists Sharing domains for an admin-authenticated group", async () => {
		const scope: CoordinatorScope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			membership_epoch: 3,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listScopes: vi.fn(async () => [scope]),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes", {
			headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ items: [scope] });
		expect(store.listScopes).toHaveBeenCalledWith({ groupId: "g1", includeInactive: false });
	});

	it("rejects missing or invalid admin auth on Sharing domain routes", async () => {
		const store = createMockStore();
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const missing = await app.request("/v1/admin/groups/g1/scopes");
		const invalid = await app.request("/v1/admin/groups/g1/scopes", {
			headers: { "X-Codemem-Coordinator-Admin": "wrong" },
		});

		expect(missing.status).toBe(401);
		expect(await missing.json()).toEqual({ error: "missing_admin_header" });
		expect(invalid.status).toBe(401);
		expect(await invalid.json()).toEqual({ error: "invalid_admin_secret" });
		expect(store.listScopes).not.toHaveBeenCalled();
	});

	it("creates Sharing domain metadata without accepting memory payloads", async () => {
		const created: CoordinatorScope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			membership_epoch: 5,
			manifest_hash: "hash-1",
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			createScope: vi.fn(async () => created),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({
				scope_id: "scope-acme",
				label: "Acme Work",
				kind: "team",
				coordinator_id: "coord-a",
				membership_epoch: 5,
				manifest_hash: "hash-1",
				memory_payload: { body: "must not be routed" },
			}),
		});

		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ ok: true, scope: created });
		expect(store.createScope).toHaveBeenCalledWith({
			scopeId: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authorityType: null,
			coordinatorId: "coord-a",
			groupId: "g1",
			manifestIssuerDeviceId: null,
			membershipEpoch: 5,
			manifestHash: "hash-1",
			status: null,
		});
	});

	it("validates Sharing domain create inputs", async () => {
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({ scope_id: "scope-acme", membership_epoch: "nope" }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "scope_id_and_label_required" });
		expect(store.createScope).not.toHaveBeenCalled();
	});

	it("rejects non-numeric Sharing domain epochs before coercion", async () => {
		const storeFactory = vi.fn(() => createMockStore());
		const app = createCoordinatorApp({
			storeFactory,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});
		const requests = [
			{
				path: "/v1/admin/groups/g1/scopes",
				method: "POST",
				body: { scope_id: "scope-acme", label: "Acme Work", membership_epoch: true },
			},
			{
				path: "/v1/admin/groups/g1/scopes/scope-acme",
				method: "PATCH",
				body: { membership_epoch: [] },
			},
			{
				path: "/v1/admin/groups/g1/scopes/scope-acme/members",
				method: "POST",
				body: {
					effect_id: "test:invalid-epoch:grant",
					device_id: "device-a",
					membership_epoch: "   ",
				},
			},
			{
				path: "/v1/admin/groups/g1/scopes/scope-acme/members/device-a/revoke",
				method: "POST",
				body: { effect_id: "test:invalid-epoch:revoke", membership_epoch: true },
			},
		];

		for (const request of requests) {
			const res = await app.request(request.path, {
				method: request.method,
				headers: {
					"Content-Type": "application/json",
					"X-Codemem-Coordinator-Admin": "test-secret",
				},
				body: JSON.stringify(request.body),
			});

			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "membership_epoch_must_be_number" });
		}
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it("updates Sharing domain metadata only within the requested group", async () => {
		const existing: CoordinatorScope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			membership_epoch: 5,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const updated = { ...existing, label: "Acme Engineering", membership_epoch: 6 };
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listScopes: vi.fn(async () => [existing]),
			updateScope: vi.fn(async () => updated),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes/scope-acme", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({ label: "Acme Engineering", membership_epoch: 6 }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, scope: updated });
		expect(store.updateScope).toHaveBeenCalledWith({
			scopeId: "scope-acme",
			label: "Acme Engineering",
			kind: undefined,
			authorityType: undefined,
			coordinatorId: undefined,
			groupId: "g1",
			manifestIssuerDeviceId: undefined,
			membershipEpoch: 6,
			manifestHash: undefined,
			status: undefined,
		});
	});

	it("returns not found when updating a scope outside the requested group", async () => {
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listScopes: vi.fn(async () => []),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes/scope-acme", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({ label: "Acme Engineering" }),
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "scope_not_found" });
		expect(store.updateScope).not.toHaveBeenCalled();
	});

	it("lists explicit Sharing domain memberships separately from group enrollment", async () => {
		const scope: CoordinatorScope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			membership_epoch: 1,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listEnrolledDevices: vi.fn(async () => [
				{
					group_id: "g1",
					device_id: "device-a",
					public_key: "pk1",
					fingerprint: "fp1",
					display_name: "Laptop",
					enabled: 1,
					created_at: "2026-03-28T00:00:00Z",
				},
			]),
			listScopes: vi.fn(async () => [scope]),
			listScopeMemberships: vi.fn(async () => []),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const devices = await app.request("/v1/admin/devices?group_id=g1", {
			headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
		});
		const members = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members", {
			headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
		});

		expect(devices.status).toBe(200);
		expect(await devices.json()).toMatchObject({ items: [{ device_id: "device-a" }] });
		expect(members.status).toBe(200);
		expect(await members.json()).toEqual({ items: [] });
		expect(store.listScopeMemberships).toHaveBeenCalledWith("scope-acme", false);
	});

	it("rejects missing or invalid admin auth on Sharing domain membership routes", async () => {
		const store = createMockStore();
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const missing = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members");
		const invalid = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members", {
			headers: { "X-Codemem-Coordinator-Admin": "wrong" },
		});

		expect(missing.status).toBe(401);
		expect(await missing.json()).toEqual({ error: "missing_admin_header" });
		expect(invalid.status).toBe(401);
		expect(await invalid.json()).toEqual({ error: "invalid_admin_secret" });
		expect(store.listScopeMemberships).not.toHaveBeenCalled();
	});

	it("lets enrolled devices read non-admin Sharing domain membership snapshots", async () => {
		const scopes: CoordinatorScope[] = [
			{
				scope_id: "scope-acme",
				label: "Acme Work",
				kind: "team",
				authority_type: "coordinator",
				coordinator_id: "coord-a",
				group_id: "g1",
				manifest_issuer_device_id: null,
				membership_epoch: 3,
				manifest_hash: null,
				status: "active",
				created_at: "2026-03-28T00:00:00Z",
				updated_at: "2026-03-28T00:00:00Z",
			},
			{
				scope_id: "scope-other",
				label: "Other Work",
				kind: "team",
				authority_type: "coordinator",
				coordinator_id: "coord-a",
				group_id: "g1",
				manifest_issuer_device_id: null,
				membership_epoch: 1,
				manifest_hash: null,
				status: "active",
				created_at: "2026-03-28T00:00:00Z",
				updated_at: "2026-03-28T00:00:00Z",
			},
		];
		const memberships: Record<string, CoordinatorScopeMembership[]> = {
			"scope-acme": [
				{
					scope_id: "scope-acme",
					device_id: "device-a",
					role: "member",
					status: "active",
					membership_epoch: 3,
					coordinator_id: "coord-a",
					group_id: "g1",
					manifest_issuer_device_id: null,
					manifest_hash: null,
					signed_manifest_json: null,
					updated_at: "2026-03-28T00:00:00Z",
				},
				{
					scope_id: "scope-acme",
					device_id: "device-b",
					role: "member",
					status: "active",
					membership_epoch: 3,
					coordinator_id: "coord-a",
					group_id: "g1",
					manifest_issuer_device_id: null,
					manifest_hash: null,
					signed_manifest_json: null,
					updated_at: "2026-03-28T00:00:00Z",
				},
			],
			"scope-other": [
				{
					scope_id: "scope-other",
					device_id: "device-b",
					role: "member",
					status: "active",
					membership_epoch: 1,
					coordinator_id: "coord-a",
					group_id: "g1",
					manifest_issuer_device_id: null,
					manifest_hash: null,
					signed_manifest_json: null,
					updated_at: "2026-03-28T00:00:00Z",
				},
			],
		};
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			getEnrollment: vi.fn(async () => ({
				group_id: "g1",
				device_id: "device-a",
				public_key: "pk-a",
				fingerprint: "fp-a",
				display_name: "Device A",
				enabled: 1,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listScopes: vi.fn(async () => scopes),
			listScopeMemberships: vi.fn(async (scopeId: string) => memberships[scopeId] ?? []),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const scopeRes = await app.request("/v1/scopes?group_id=g1", {
			headers: authHeaders("device-a", "nonce-scopes"),
		});
		const memberRes = await app.request("/v1/scopes/scope-acme/members?group_id=g1", {
			headers: authHeaders("device-a", "nonce-members"),
		});
		const otherRes = await app.request("/v1/scopes/scope-other/members?group_id=g1", {
			headers: authHeaders("device-a", "nonce-other"),
		});

		expect(scopeRes.status).toBe(200);
		expect(await scopeRes.json()).toEqual({ items: [scopes[0]] });
		expect(memberRes.status).toBe(200);
		expect(await memberRes.json()).toEqual({ items: memberships["scope-acme"] });
		expect(otherRes.status).toBe(403);
		expect(await otherRes.json()).toEqual({ error: "scope_not_authorized" });
	});

	it("grants devices explicitly to a Sharing domain", async () => {
		const scope: CoordinatorScope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			membership_epoch: 3,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const membership: CoordinatorScopeMembership = {
			scope_id: "scope-acme",
			device_id: "device-a",
			role: "admin",
			status: "active",
			membership_epoch: 4,
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			manifest_hash: "hash-2",
			signed_manifest_json: null,
			updated_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			getEnrollment: vi.fn(async () => ({
				group_id: "g1",
				device_id: "device-a",
				public_key: "pk-a",
				fingerprint: "fp-a",
				display_name: "Device A",
				enabled: 1,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listScopes: vi.fn(async () => [scope]),
			grantScopeMembership: vi.fn(async () => membership),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({
				effect_id: "api:grant:scope-acme:device-a:4",
				device_id: "device-a",
				role: "admin",
				membership_epoch: 4,
				coordinator_id: "coord-a",
				manifest_hash: "hash-2",
				memory_payload: { body: "must not be routed" },
			}),
		});

		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ ok: true, membership });
		expect(store.grantScopeMembership).toHaveBeenCalledWith({
			effectId: "api:grant:scope-acme:device-a:4",
			scopeId: "scope-acme",
			deviceId: "device-a",
			role: "admin",
			membershipEpoch: 4,
			coordinatorId: "coord-a",
			groupId: "g1",
			manifestIssuerDeviceId: null,
			manifestHash: "hash-2",
			signedManifestJson: null,
			actorType: "admin",
			actorId: null,
		});
	});

	it("rejects grants for archived groups before mutating membership", async () => {
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Archived",
				archived_at: "2026-03-28T00:00:00Z",
				created_at: "2026-03-27T00:00:00Z",
			})),
			grantScopeMembership: vi.fn(async () => {
				throw new Error("grant must not run");
			}),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({ effect_id: "api:archived:grant", device_id: "device-a" }),
		});

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "group_archived" });
		expect(store.grantScopeMembership).not.toHaveBeenCalled();
	});

	it("writes audit rows through admin Sharing domain grant and revoke APIs", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "coord-api-audit-test-"));
		const dbPath = join(tmpDir, "coordinator.sqlite");
		const setupStore = new BetterSqliteCoordinatorStore(dbPath);
		try {
			await setupStore.createGroup("g1", "Acme");
			await setupStore.enrollDevice("g1", {
				deviceId: "device-a",
				fingerprint: "fp-a",
				publicKey: "pk-a",
			});
			await setupStore.createScope({
				scopeId: "scope-acme",
				label: "Acme Work",
				coordinatorId: "coord-a",
				groupId: "g1",
				membershipEpoch: 1,
			});

			const app = createCoordinatorApp({
				storeFactory: () => new BetterSqliteCoordinatorStore(dbPath),
				runtime: {
					adminSecret: () => "test-secret",
					now: () => "2026-03-28T00:00:00Z",
				},
				requestVerifier: allowRequest,
			});

			const grantRes = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Codemem-Coordinator-Admin": "test-secret",
					"X-Codemem-Coordinator-Admin-Actor": "admin-alice",
				},
				body: JSON.stringify({
					effect_id: "api:audit:grant",
					device_id: "device-a",
					membership_epoch: 2,
					manifest_hash: "hash-grant",
					actor_id: "spoofed-body-actor",
				}),
			});
			expect(grantRes.status).toBe(201);
			const grantReplay = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Codemem-Coordinator-Admin": "test-secret",
					"X-Codemem-Coordinator-Admin-Actor": "admin-alice",
				},
				body: JSON.stringify({
					effect_id: "api:audit:grant",
					device_id: "device-a",
					membership_epoch: 2,
					manifest_hash: "hash-grant",
					actor_id: "another-spoofed-body-actor",
				}),
			});
			expect(grantReplay.status).toBe(201);
			const grantConflict = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Codemem-Coordinator-Admin": "test-secret",
					"X-Codemem-Coordinator-Admin-Actor": "admin-alice",
				},
				body: JSON.stringify({
					effect_id: "api:audit:grant",
					device_id: "device-a",
					role: "admin",
					membership_epoch: 2,
					manifest_hash: "hash-grant",
				}),
			});
			expect(grantConflict.status).toBe(409);
			expect(await grantConflict.json()).toEqual({ error: "scope_membership_effect_conflict" });

			const revokeRes = await app.request(
				"/v1/admin/groups/g1/scopes/scope-acme/members/device-a/revoke",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Codemem-Coordinator-Admin": "test-secret",
						"X-Codemem-Coordinator-Admin-Actor": "admin-bob",
					},
					body: JSON.stringify({
						effect_id: "api:audit:revoke",
						membership_epoch: 3,
						manifest_hash: "hash-revoke",
					}),
				},
			);
			expect(revokeRes.status).toBe(200);
			const revokeReplay = await app.request(
				"/v1/admin/groups/g1/scopes/scope-acme/members/device-a/revoke",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Codemem-Coordinator-Admin": "test-secret",
						"X-Codemem-Coordinator-Admin-Actor": "admin-bob",
					},
					body: JSON.stringify({
						effect_id: "api:audit:revoke",
						membership_epoch: 3,
						manifest_hash: "hash-revoke",
					}),
				},
			);
			expect(revokeReplay.status).toBe(200);

			const verifyStore = new BetterSqliteCoordinatorStore(dbPath);
			try {
				expect(await verifyStore.listScopeMembershipAuditEvents({ scopeId: "scope-acme" })).toEqual(
					[
						expect.objectContaining({
							action: "grant",
							device_id: "device-a",
							membership_epoch: 2,
							previous_status: null,
							previous_membership_epoch: null,
							actor_type: "admin",
							actor_id: "admin-alice",
							manifest_hash: "hash-grant",
						}),
						expect.objectContaining({
							action: "revoke",
							device_id: "device-a",
							status: "revoked",
							membership_epoch: 3,
							previous_status: "active",
							previous_membership_epoch: 2,
							actor_type: "admin",
							actor_id: "admin-bob",
							manifest_hash: "hash-revoke",
						}),
					],
				);
			} finally {
				await verifyStore.close();
			}
		} finally {
			await setupStore.close();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("validates Sharing domain grant inputs", async () => {
		const scope: CoordinatorScope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			membership_epoch: 3,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listScopes: vi.fn(async () => [scope]),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({ membership_epoch: "not-a-number" }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "effect_id_required" });
		expect(store.grantScopeMembership).not.toHaveBeenCalled();
	});

	it("rejects Sharing domain grants for devices outside the scope group", async () => {
		const scope: CoordinatorScope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			membership_epoch: 3,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listScopes: vi.fn(async () => [scope]),
			grantScopeMembership: vi.fn(async () => {
				throw new CoordinatorMembershipError("device_not_enrolled");
			}),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({ effect_id: "api:outside-group:grant", device_id: "device-a" }),
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "device_not_enrolled_for_scope_group" });
		expect(store.grantScopeMembership).toHaveBeenCalledOnce();
	});

	it("revokes explicit Sharing domain memberships", async () => {
		const scope: CoordinatorScope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			membership_epoch: 3,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listScopes: vi.fn(async () => [scope]),
			revokeScopeMembership: vi.fn(async () => true),
			listScopeMemberships: vi.fn(async () => [
				{
					scope_id: "scope-acme",
					device_id: "device-a",
					role: "member",
					status: "revoked",
					membership_epoch: 5,
					coordinator_id: "coord-a",
					group_id: "g1",
					manifest_issuer_device_id: null,
					manifest_hash: "hash-revoke",
					signed_manifest_json: null,
					updated_at: "2026-03-28T00:00:00Z",
				},
			]),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members/device-a/revoke", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({
				effect_id: "api:revoke:scope-acme:device-a:5",
				membership_epoch: 5,
				manifest_hash: "hash-revoke",
			}),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			scope_id: "scope-acme",
			device_id: "device-a",
			revocation: {
				scope_id: "scope-acme",
				device_id: "device-a",
				membership_epoch: 5,
				prevents_future_sync: true,
				deletes_already_copied_data: false,
				message:
					"Revocation blocks future sync for this Space. It does not remove data already copied to the revoked device; offline devices, backups, copied databases, malicious peers, or old versions may retain data.",
			},
		});
		expect(store.revokeScopeMembership).toHaveBeenCalledWith({
			effectId: "api:revoke:scope-acme:device-a:5",
			scopeId: "scope-acme",
			deviceId: "device-a",
			groupId: "g1",
			membershipEpoch: 5,
			manifestHash: "hash-revoke",
			signedManifestJson: null,
			actorType: "admin",
			actorId: null,
		});
		expect(store.listScopeMemberships).toHaveBeenCalledWith("scope-acme", true);
	});

	it("rejects revokes for archived groups before mutating membership", async () => {
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Archived",
				archived_at: "2026-03-28T00:00:00Z",
				created_at: "2026-03-27T00:00:00Z",
			})),
			revokeScopeMembership: vi.fn(async () => {
				throw new Error("revoke must not run");
			}),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members/device-a/revoke", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({ effect_id: "api:archived:revoke" }),
		});

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "group_archived" });
		expect(store.revokeScopeMembership).not.toHaveBeenCalled();
	});

	it("does not fail a persisted revoke when response enrichment cannot reload it", async () => {
		const scope: CoordinatorScope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			membership_epoch: 3,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listScopes: vi.fn(async () => [scope]),
			revokeScopeMembership: vi.fn(async () => true),
			listScopeMemberships: vi.fn(async () => {
				throw new Error("temporarily locked");
			}),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members/device-a/revoke", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({
				effect_id: "api:revoke:enrichment-failure",
				membership_epoch: 5,
			}),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			revocation: {
				membership_epoch: 5,
				prevents_future_sync: true,
				deletes_already_copied_data: false,
			},
		});
		expect(store.revokeScopeMembership).toHaveBeenCalledWith({
			effectId: "api:revoke:enrichment-failure",
			scopeId: "scope-acme",
			deviceId: "device-a",
			groupId: "g1",
			membershipEpoch: 5,
			manifestHash: null,
			signedManifestJson: null,
			actorType: "admin",
			actorId: null,
		});
		expect(store.listScopeMemberships).toHaveBeenCalledWith("scope-acme", true);
	});

	it("reports persisted revoke epoch when request omits membership_epoch", async () => {
		const scope: CoordinatorScope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "g1",
			manifest_issuer_device_id: null,
			membership_epoch: 3,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const store = createMockStore({
			getGroup: vi.fn(async () => ({
				group_id: "g1",
				display_name: "Acme",
				archived_at: null,
				created_at: "2026-03-28T00:00:00Z",
			})),
			listScopes: vi.fn(async () => [scope]),
			revokeScopeMembership: vi.fn(async () => true),
			listScopeMemberships: vi.fn(async () => [
				{
					scope_id: "scope-acme",
					device_id: "device-a",
					role: "member",
					status: "revoked",
					membership_epoch: 4,
					coordinator_id: "coord-a",
					group_id: "g1",
					manifest_issuer_device_id: null,
					manifest_hash: null,
					signed_manifest_json: null,
					updated_at: "2026-03-28T00:00:00Z",
				},
			]),
		});
		const app = createCoordinatorApp({
			storeFactory: () => store,
			runtime: {
				adminSecret: () => "test-secret",
				now: () => "2026-03-28T00:00:00Z",
			},
			requestVerifier: allowRequest,
		});

		const res = await app.request("/v1/admin/groups/g1/scopes/scope-acme/members/device-a/revoke", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "test-secret",
			},
			body: JSON.stringify({ effect_id: "api:revoke:implicit-epoch" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			revocation: {
				membership_epoch: 4,
				prevents_future_sync: true,
				deletes_already_copied_data: false,
			},
		});
	});
});
