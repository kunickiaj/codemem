import { describe, expect, it } from "vitest";

import {
	deriveScopeMembershipDeviceRows,
	scopeManagementReadinessMessage,
	scopeStatusLabel,
} from "./scope-management";

describe("coordinator admin scope management view helpers", () => {
	it("gates sharing-domain management when admin setup is incomplete", () => {
		expect(
			scopeManagementReadinessMessage({
				readiness: "partial",
				title: "Coordinator admin setup is incomplete",
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
});
