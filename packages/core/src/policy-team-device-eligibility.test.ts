import { describe, expect, it } from "vitest";
import {
	derivePolicyTeamDeviceEligibility,
	isPolicyTeamMembershipActiveForMode,
} from "./policy-team-device-eligibility.js";

const devices = [
	{ identityId: "identity-a", deviceId: "device-a", status: "active", assignmentVersion: 0 },
	{
		identityId: "identity-a",
		deviceId: "device-a-revoked",
		status: "revoked",
		assignmentVersion: 0,
	},
	{ identityId: "identity-b", deviceId: "device-b", status: "active", assignmentVersion: 0 },
];
const identities = [
	{ identityId: "identity-a", status: "active", mergedIntoIdentityId: null },
	{ identityId: "identity-b", status: "active", mergedIntoIdentityId: null },
];

describe("Team device eligibility", () => {
	it("preserves person_all_devices expansion", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "person_all_devices",
			identities,
			memberships: [
				{ identityId: "identity-a", status: "active" },
				{ identityId: "identity-b", status: "pending" },
			],
			devices,
			decisions: [],
		});

		expect(result).toEqual({
			status: "eligible",
			activeMemberIdentityIds: ["identity-a"],
			eligibleDeviceIds: ["device-a"],
			blocked: [],
		});
	});

	it("allows only explicitly included active devices for reviewed Teams", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities,
			memberships: [
				{ identityId: "identity-a", status: "reviewed_active" },
				{ identityId: "identity-b", status: "reviewed_active" },
			],
			devices,
			decisions: [
				{ deviceId: "device-a", decision: "included", assignmentVersion: 0 },
				{ deviceId: "device-a-revoked", decision: "included", assignmentVersion: 0 },
				{ deviceId: "device-b", decision: "excluded", assignmentVersion: 0 },
				{ deviceId: "device-off-roster", decision: "included", assignmentVersion: 0 },
			],
		});

		if (result.status !== "eligible") throw new Error("expected eligible result");
		expect(result.eligibleDeviceIds).toEqual(["device-a"]);
	});

	it("denies every device when a reviewed Team has no included decisions", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities,
			memberships: [{ identityId: "identity-a", status: "reviewed_active" }],
			devices,
			decisions: [{ deviceId: "device-a", decision: "unresolved", assignmentVersion: 0 }],
		});

		expect(result.status).toBe("eligible");
		if (result.status !== "eligible") throw new Error("expected eligible result");
		expect(result.eligibleDeviceIds).toEqual([]);
	});

	it("blocks an empty mode", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "",
			identities: [],
			memberships: [{ identityId: "identity-a", status: "future_status" }],
			devices: [
				{
					identityId: "identity-a",
					deviceId: "device-a",
					status: "future_status",
					assignmentVersion: 0,
				},
			],
			decisions: [{ deviceId: "device-a", decision: "future_decision", assignmentVersion: 0 }],
		});

		expect(result).toEqual({
			status: "blocked",
			blocked: [{ code: "team_device_eligibility_mode_invalid", referenceId: "team-a" }],
		});
		expect(result).not.toHaveProperty("eligibleDeviceIds");
		expect(result).not.toHaveProperty("activeMemberIdentityIds");
	});

	it("blocks every decision row in person_all_devices mode", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "person_all_devices",
			identities,
			memberships: [{ identityId: "identity-a", status: "active" }],
			devices,
			decisions: [{ deviceId: "device-a", decision: "included", assignmentVersion: 0 }],
		});

		expect(result.status).toBe("blocked");
		expect(result).not.toHaveProperty("eligibleDeviceIds");
		expect(result.blocked).toContainEqual({
			code: "team_device_decision_invalid",
			referenceId: "team-a:device-a",
		});
	});

	it("blocks duplicate reviewed decisions for the same device", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities,
			memberships: [{ identityId: "identity-a", status: "reviewed_active" }],
			devices,
			decisions: [
				{ deviceId: "device-a", decision: "included", assignmentVersion: 0 },
				{ deviceId: "device-a", decision: "excluded", assignmentVersion: 0 },
			],
		});

		expect(result.status).toBe("blocked");
		expect(result).not.toHaveProperty("eligibleDeviceIds");
		expect(result.blocked).toContainEqual({
			code: "team_device_decision_invalid",
			referenceId: "team-a:device-a",
		});
	});

	it.each([
		"",
		" device-a",
		"device-a ",
		"device-a\n",
		"device-\u200B-a",
		"d".repeat(257),
	])("blocks malformed reviewed decision device ID %j", (deviceId) => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities,
			memberships: [{ identityId: "identity-a", status: "reviewed_active" }],
			devices,
			decisions: [{ deviceId, decision: "included", assignmentVersion: 0 }],
		});

		expect(result).toEqual({
			status: "blocked",
			blocked: [{ code: "team_device_decision_invalid", referenceId: `team-a:${deviceId}` }],
		});
	});

	it("accepts a canonical device ID at the 256 UTF-16-unit boundary", () => {
		const deviceId = "d".repeat(256);
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "person_all_devices",
			identities,
			memberships: [{ identityId: "identity-a", status: "active" }],
			devices: [{ identityId: "identity-a", deviceId, status: "active", assignmentVersion: 0 }],
			decisions: [],
		});

		expect(result).toMatchObject({ status: "eligible", eligibleDeviceIds: [deviceId] });
	});

	it("accepts reviewed_active membership only for reviewed_allowlist", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities,
			memberships: [{ identityId: "identity-a", status: "reviewed_active" }],
			devices,
			decisions: [{ deviceId: "device-a", decision: "included", assignmentVersion: 0 }],
		});

		expect(result).toMatchObject({
			status: "eligible",
			activeMemberIdentityIds: ["identity-a"],
			eligibleDeviceIds: ["device-a"],
			blocked: [],
		});
	});

	it("does not reuse an included decision after device reassignment", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities,
			memberships: [{ identityId: "identity-a", status: "reviewed_active" }],
			devices: [
				{
					identityId: "identity-a",
					deviceId: "device-a",
					status: "active",
					assignmentVersion: 1,
				},
			],
			decisions: [{ deviceId: "device-a", decision: "included", assignmentVersion: 0 }],
		});

		expect(result).toMatchObject({
			status: "eligible",
			eligibleDeviceIds: [],
			blocked: [],
		});
	});

	it("blocks a versionless reviewed decision", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities,
			memberships: [{ identityId: "identity-a", status: "reviewed_active" }],
			devices: [
				{
					identityId: "identity-a",
					deviceId: "device-a",
					status: "active",
					assignmentVersion: 2,
				},
			],
			decisions: [
				{ deviceId: "device-a", decision: "included" } as unknown as {
					deviceId: string;
					decision: string;
					assignmentVersion: number;
				},
			],
		});

		expect(result).toEqual({
			status: "blocked",
			blocked: [{ code: "team_device_decision_invalid", referenceId: "team-a:device-a" }],
		});
	});

	it("accepts an included decision matching a non-zero assignment version", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities,
			memberships: [{ identityId: "identity-a", status: "reviewed_active" }],
			devices: [
				{
					identityId: "identity-a",
					deviceId: "device-a",
					status: "active",
					assignmentVersion: 2,
				},
			],
			decisions: [{ deviceId: "device-a", decision: "included", assignmentVersion: 2 }],
		});

		expect(result).toMatchObject({ status: "eligible", eligibleDeviceIds: ["device-a"] });
	});

	it.each([-1, 1.5])("blocks an invalid assignment version %d", (assignmentVersion) => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "person_all_devices",
			identities,
			memberships: [{ identityId: "identity-a", status: "active" }],
			devices: [
				{ identityId: "identity-a", deviceId: "device-a", status: "active", assignmentVersion },
			],
			decisions: [],
		});

		expect(result.blocked).toEqual([{ code: "identity_device_invalid", referenceId: "device-a" }]);
	});

	it("never grants an included device owned by a non-member", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities,
			memberships: [{ identityId: "identity-a", status: "reviewed_active" }],
			devices,
			decisions: [{ deviceId: "device-b", decision: "included", assignmentVersion: 0 }],
		});

		expect(result.status).toBe("eligible");
		if (result.status !== "eligible") throw new Error("expected eligible result");
		expect(result.eligibleDeviceIds).toEqual([]);
	});

	it.each([
		{
			label: "unknown mode",
			mode: "future_mode",
			membershipStatus: "active",
			decision: "included",
			code: "team_device_eligibility_mode_invalid",
		},
		{
			label: "reviewed membership on a normal Team",
			mode: "person_all_devices",
			membershipStatus: "reviewed_active",
			decision: "included",
			code: "team_membership_mode_invalid",
		},
		{
			label: "normal membership on a reviewed Team",
			mode: "reviewed_allowlist",
			membershipStatus: "active",
			decision: "included",
			code: "team_membership_mode_invalid",
		},
		{
			label: "unknown decision",
			mode: "reviewed_allowlist",
			membershipStatus: "reviewed_active",
			decision: "future_decision",
			code: "team_device_decision_invalid",
		},
	] as const)("blocks $label", ({ mode, membershipStatus, decision, code }) => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode,
			identities,
			memberships: [{ identityId: "identity-a", status: membershipStatus }],
			devices,
			decisions: [{ deviceId: "device-a", decision, assignmentVersion: 0 }],
		});

		expect(result.status).toBe("blocked");
		expect(result).not.toHaveProperty("eligibleDeviceIds");
		expect(result).not.toHaveProperty("activeMemberIdentityIds");
		expect(result.blocked).toContainEqual(expect.objectContaining({ code }));
	});

	it("blocks unknown device status instead of treating it as active", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "person_all_devices",
			identities,
			memberships: [{ identityId: "identity-a", status: "active" }],
			devices: [{ identityId: "identity-a", deviceId: "device-a", status: "future_status" }],
			decisions: [],
		});

		expect(result.status).toBe("blocked");
		expect(result).not.toHaveProperty("eligibleDeviceIds");
		expect(result.blocked).toEqual([{ code: "identity_device_invalid", referenceId: "device-a" }]);
	});

	it.each([
		"",
		" device-a",
		"device-a ",
		"device-a\n",
	])("blocks malformed active device ID %j", (deviceId) => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "person_all_devices",
			identities,
			memberships: [{ identityId: "identity-a", status: "active" }],
			devices: [{ identityId: "identity-a", deviceId, status: "active", assignmentVersion: 0 }],
			decisions: [],
		});

		expect(result.status).toBe("blocked");
		expect(result).not.toHaveProperty("eligibleDeviceIds");
		expect(result.blocked).toEqual([{ code: "identity_device_invalid", referenceId: deviceId }]);
	});

	it.each([
		"",
		" identity-a",
		"identity-a ",
		"identity-a\n",
	])("blocks malformed inactive reviewed membership ID %j", (identityId) => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities,
			memberships: [{ identityId, status: "pending" }],
			devices: [],
			decisions: [],
		});

		expect(result.status).toBe("blocked");
		expect(result).not.toHaveProperty("eligibleDeviceIds");
		expect(result.blocked).toEqual([
			{ code: "team_membership_invalid", referenceId: `team-a:${identityId}` },
		]);
	});

	it.each([
		["missing", [], "team_member_identity_missing"],
		[
			"pending",
			[{ identityId: "identity-a", status: "pending", mergedIntoIdentityId: null }],
			"team_member_identity_not_active",
		],
		[
			"deactivated",
			[{ identityId: "identity-a", status: "deactivated", mergedIntoIdentityId: null }],
			"team_member_identity_not_active",
		],
		[
			"merged",
			[
				{
					identityId: "identity-a",
					status: "active",
					mergedIntoIdentityId: "identity-b",
				},
			],
			"team_member_identity_merged",
		],
	] as const)("blocks a $label active Team-member identity", (_label, identityFacts, code) => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "person_all_devices",
			identities: [...identityFacts],
			memberships: [{ identityId: "identity-a", status: "active" }],
			devices,
			decisions: [],
		});

		expect(result.status).toBe("blocked");
		expect(result).not.toHaveProperty("eligibleDeviceIds");
		expect(result.blocked[0]).toEqual({ code, referenceId: "identity-a" });
	});

	it("orders identity-integrity blocks before decision and device blocks", () => {
		const result = derivePolicyTeamDeviceEligibility({
			teamId: "team-a",
			mode: "reviewed_allowlist",
			identities: [],
			memberships: [{ identityId: "identity-a", status: "reviewed_active" }],
			devices: [
				{
					identityId: "identity-a",
					deviceId: "device-a",
					status: "future_status",
					assignmentVersion: 0,
				},
			],
			decisions: [{ deviceId: "device-a", decision: "future_decision", assignmentVersion: 0 }],
		});

		expect(result.status).toBe("blocked");
		expect(result.blocked.map((block) => block.code)).toEqual([
			"team_member_identity_missing",
			"team_device_decision_invalid",
			"identity_device_invalid",
		]);
	});

	it("recognizes active membership status only for its exact mode", () => {
		expect(isPolicyTeamMembershipActiveForMode("person_all_devices", "active")).toBe(true);
		expect(isPolicyTeamMembershipActiveForMode("reviewed_allowlist", "reviewed_active")).toBe(true);
		for (const [mode, status] of [
			["person_all_devices", "reviewed_active"],
			["reviewed_allowlist", "active"],
			["future_mode", "active"],
			["reviewed_allowlist", "future_status"],
		]) {
			expect(isPolicyTeamMembershipActiveForMode(mode, status)).toBe(false);
		}
	});
});
