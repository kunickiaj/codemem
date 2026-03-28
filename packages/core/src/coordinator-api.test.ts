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
		close: vi.fn(),
		createGroup: vi.fn(),
		getGroup: vi.fn((): CoordinatorGroup | null => null),
		listGroups: vi.fn((): CoordinatorGroup[] => []),
		enrollDevice: vi.fn((_: string, __: CoordinatorEnrollDeviceInput) => undefined),
		listEnrolledDevices: vi.fn((_: string, __?: boolean): CoordinatorEnrollment[] => []),
		getEnrollment: vi.fn((_: string, __: string): CoordinatorEnrollment | null => null),
		renameDevice: vi.fn(() => false),
		setDeviceEnabled: vi.fn(() => false),
		removeDevice: vi.fn(() => false),
		recordNonce: vi.fn(() => true),
		cleanupNonces: vi.fn(),
		createInvite: vi.fn((_: CoordinatorCreateInviteInput): CoordinatorInvite => {
			throw new Error("not implemented");
		}),
		getInviteByToken: vi.fn((_: string): CoordinatorInvite | null => null),
		listInvites: vi.fn((_: string): CoordinatorInvite[] => []),
		createJoinRequest: vi.fn((_: CoordinatorCreateJoinRequestInput): CoordinatorJoinRequest => {
			throw new Error("not implemented");
		}),
		listJoinRequests: vi.fn((_: string, __?: string): CoordinatorJoinRequest[] => []),
		reviewJoinRequest: vi.fn(
			(_: CoordinatorReviewJoinRequestInput): CoordinatorJoinRequestReviewResult | null => null,
		),
		upsertPresence: vi.fn((_: CoordinatorUpsertPresenceInput): CoordinatorPresenceRecord => {
			throw new Error("not implemented");
		}),
		listGroupPeers: vi.fn((_: string, __: string): CoordinatorPeerRecord[] => []),
	};
	return { ...defaultStore, ...overrides };
}

describe("createCoordinatorApp dependency injection", () => {
	it("uses injected admin secret and store factory for admin routes", async () => {
		const store = createMockStore({
			listEnrolledDevices: vi.fn(() => [
				{
					group_id: "g1",
					device_id: "d1",
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
