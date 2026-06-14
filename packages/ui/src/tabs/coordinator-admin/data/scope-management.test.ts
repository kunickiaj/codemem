import { describe, expect, it } from "vitest";

import {
	coordinatorAdminDevicesForGroup,
	deriveScopeMembershipDeviceRows,
	scopeManagementReadinessMessage,
	scopeStatusLabel,
	spaceAccessDeviceCopy,
	spaceCardCopy,
	spaceRevokeMemberTitle,
} from "./scope-management";

describe("coordinator admin scope management view helpers", () => {
	it("gates sharing-domain management when admin setup is incomplete", () => {
		expect(
			scopeManagementReadinessMessage({
				readiness: "partial",
				title: "Teams setup is incomplete",
				detail: "Set a coordinator admin secret.",
			}),
		).toContain("admin secret");
		expect(
			scopeManagementReadinessMessage({
				readiness: "ready",
				title: "Ready",
				detail: "Ready",
			}),
		).toBeNull();
	});

	it("shows enrolled devices that are not members as explicit non-member rows", () => {
		const rows = deriveScopeMembershipDeviceRows(
			[
				{ device_id: "dev-a", display_name: "Alice laptop", enabled: true },
				{ device_id: "dev-b", display_name: "Build box", enabled: true },
				{ device_id: "dev-c", display_name: "Old phone", enabled: false },
			],
			[
				{
					device_id: "dev-a",
					role: "admin",
					status: "active",
					membership_epoch: 4,
					updated_at: "2026-05-05T00:00:00Z",
				},
				{ device_id: "dev-c", role: "member", status: "revoked", membership_epoch: 6 },
			],
		);

		expect(rows.map((row) => [row.deviceId, row.status, row.role, row.membershipEpoch])).toEqual([
			["dev-a", "active", "admin", 4],
			["dev-c", "revoked", "member", 6],
			["dev-b", "not_member", "member", null],
		]);
		expect(rows[2]?.displayName).toBe("Build box");
	});

	it("formats empty or underscored scope statuses for operator copy", () => {
		expect(scopeStatusLabel(null)).toBe("active");
		expect(scopeStatusLabel("needs_review")).toBe("needs review");
	});

	it("keeps raw Space ids in advanced Space card copy", () => {
		const copy = spaceCardCopy({
			kind: "team_default",
			membership_epoch: 7,
			scope_id: "team-alpha-default",
			status: "active",
		});

		expect(copy.summary).toBe("active Space · team default");
		expect(copy.title).toBe("Untitled Space");
		expect(copy.title).not.toContain("team-alpha-default");
		expect(copy.summary).not.toContain("team-alpha-default");
		expect(copy.advancedDetail).toBe("Advanced: Space ID team-alpha-default · Membership epoch 7");
	});

	it("formats missing Space membership epochs as unknown in advanced copy", () => {
		const copy = spaceCardCopy({ label: "Household", scope_id: "household", status: "active" });

		expect(copy.title).toBe("Household");
		expect(copy.advancedDetail).toBe("Advanced: Space ID household · Membership epoch —");
	});

	it("labels device Space access without making membership epochs primary copy", () => {
		const copy = spaceAccessDeviceCopy({
			deviceId: "dev-a",
			displayName: "Alice laptop",
			enabled: true,
			membershipEpoch: 4,
			role: "admin_member",
			status: "active",
			updatedAt: null,
		});

		expect(copy.detail).toBe("Space access active · admin member");
		expect(copy.detail).not.toContain("epoch");
		expect(copy.advancedDetail).toBe("Advanced: membership epoch 4");
	});

	it("uses Space card copy in revoke prompts instead of raw ids", () => {
		expect(
			spaceRevokeMemberTitle(
				{ membership_epoch: 7, scope_id: "team-alpha-default", status: "active" },
				"Alice laptop",
				"dev-a",
			),
		).toBe("Revoke Alice laptop from Untitled Space?");
	});

	it("falls back to cached enrolled devices for the selected group", () => {
		expect(
			coordinatorAdminDevicesForGroup(
				[],
				[
					{ group_id: "team-a", device_id: "dev-a", display_name: "Alice", enabled: true },
					{ group_id: "team-b", device_id: "dev-b", display_name: "Bob", enabled: true },
				],
				"team-a",
				false,
			),
		).toEqual([{ group_id: "team-a", device_id: "dev-a", display_name: "Alice", enabled: true }]);

		expect(
			coordinatorAdminDevicesForGroup(
				[],
				[{ group_id: "team-a", device_id: "stale-dev", enabled: true }],
				"team-a",
				true,
			),
		).toEqual([]);

		expect(
			coordinatorAdminDevicesForGroup(
				[{ group_id: "team-a", device_id: "fresh-dev", enabled: true }],
				[{ group_id: "team-a", device_id: "cached-dev", enabled: true }],
				"team-a",
				true,
			),
		).toEqual([{ group_id: "team-a", device_id: "fresh-dev", enabled: true }]);
	});
});
