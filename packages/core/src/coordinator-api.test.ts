import { describe, expect, it, vi } from "vitest";
import {
	type CoordinatorCreateInviteInput,
	type CoordinatorCreateJoinRequestInput,
	type CoordinatorEnrollDeviceInput,
	type CoordinatorEnrollment,
	type CoordinatorGroup,
	type CoordinatorInvite,
	type CoordinatorJoinRequest,
	type CoordinatorJoinRequestReviewResult,
	type CoordinatorPeerRecord,
	type CoordinatorPresenceRecord,
	type CoordinatorReviewJoinRequestInput,
	type CoordinatorStoreInterface,
	type CoordinatorUpsertPresenceInput,
	createCoordinatorApp,
} from "./index.js";

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
		upsertPresence: vi.fn(
			async (_: CoordinatorUpsertPresenceInput): Promise<CoordinatorPresenceRecord> => {
				throw new Error("not implemented");
			},
		),
		listGroupPeers: vi.fn(async (_: string, __: string): Promise<CoordinatorPeerRecord[]> => []),
	};
	return { ...defaultStore, ...overrides };
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

	it("does not rely on process env when runtime admin secret is unset", async () => {
		const app = createCoordinatorApp({
			storeFactory: () => createMockStore(),
			runtime: {
				adminSecret: () => null,
				now: () => "2026-03-28T00:00:00Z",
			},
		});

		const res = await app.request("/v1/admin/devices?group_id=g1", {
			headers: { "X-Codemem-Coordinator-Admin": "ignored" },
		});

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "admin_not_configured" });
	});
});
