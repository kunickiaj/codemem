import { describe, expect, it, vi } from "vitest";
import {
	type CoordinatorCreateInviteInput,
	type CoordinatorCreateJoinRequestInput,
	type CoordinatorCreateReciprocalApprovalInput,
	type CoordinatorEnrollDeviceInput,
	type CoordinatorEnrollment,
	type CoordinatorGroup,
	type CoordinatorInvite,
	type CoordinatorJoinRequest,
	type CoordinatorJoinRequestReviewResult,
	type CoordinatorListReciprocalApprovalsInput,
	type CoordinatorPeerRecord,
	type CoordinatorPresenceRecord,
	type CoordinatorReciprocalApproval,
	type CoordinatorRequestVerifier,
	type CoordinatorReviewJoinRequestInput,
	type CoordinatorStoreInterface,
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
					scope: "bootstrap",
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
});
