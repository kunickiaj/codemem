import { describe, expect, it, vi } from "vitest";
import {
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
	type CoordinatorListScopesInput,
	type CoordinatorPeerRecord,
	type CoordinatorPresenceRecord,
	type CoordinatorReciprocalApproval,
	type CoordinatorRequestVerifier,
	type CoordinatorReviewJoinRequestInput,
	type CoordinatorRevokeScopeMembershipInput,
	type CoordinatorScope,
	type CoordinatorScopeMembership,
	type CoordinatorStoreInterface,
	type CoordinatorUpdateScopeInput,
	type CoordinatorUpsertPresenceInput,
	createCoordinatorApp,
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
	};
	return { ...defaultStore, ...overrides };
}

const allowRequest: CoordinatorRequestVerifier = async () => true;

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
				body: { device_id: "device-a", membership_epoch: "   " },
			},
			{
				path: "/v1/admin/groups/g1/scopes/scope-acme/members/device-a/revoke",
				method: "POST",
				body: { membership_epoch: true },
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
		expect(store.getEnrollment).toHaveBeenCalledWith("g1", "device-a");
		expect(store.grantScopeMembership).toHaveBeenCalledWith({
			scopeId: "scope-acme",
			deviceId: "device-a",
			role: "admin",
			membershipEpoch: 4,
			coordinatorId: "coord-a",
			groupId: "g1",
			manifestIssuerDeviceId: null,
			manifestHash: "hash-2",
			signedManifestJson: null,
		});
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
		expect(await res.json()).toEqual({ error: "device_id_required" });
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
			getEnrollment: vi.fn(async () => null),
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
			body: JSON.stringify({ device_id: "device-a" }),
		});

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "device_not_enrolled_for_scope_group" });
		expect(store.grantScopeMembership).not.toHaveBeenCalled();
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
			body: JSON.stringify({ membership_epoch: 5, manifest_hash: "hash-revoke" }),
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
					"Revocation prevents future sync only; it does not remove data already copied to the revoked device.",
			},
		});
		expect(store.revokeScopeMembership).toHaveBeenCalledWith({
			scopeId: "scope-acme",
			deviceId: "device-a",
			membershipEpoch: 5,
			manifestHash: "hash-revoke",
			signedManifestJson: null,
		});
		expect(store.listScopeMemberships).toHaveBeenCalledWith("scope-acme", true);
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
			body: JSON.stringify({ membership_epoch: 5 }),
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
			scopeId: "scope-acme",
			deviceId: "device-a",
			membershipEpoch: 5,
			manifestHash: null,
			signedManifestJson: null,
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
			body: JSON.stringify({}),
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
