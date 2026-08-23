import { describe, expect, it } from "vitest";
import {
	classifyTeamPolicyOwnership,
	planInviteDeviceDecisionTransition,
	planInviteMembershipTransition,
	planSetupDeviceDecisionTransition,
	planSetupMembershipTransition,
} from "./team-ownership-transitions.js";

describe("team ownership transitions", () => {
	it.each([
		["reviewed_active", "setup"],
		["reviewed_team_candidate", "setup"],
		["reviewed_team_setup", "setup"],
		["team_invite", "invite"],
		["coordinator_invite", "invite"],
		["future_writer", "other"],
	] as const)("classifies %s as %s-owned", (provenance, expected) => {
		expect(classifyTeamPolicyOwnership(provenance)).toBe(expected);
	});

	describe("setup membership planning", () => {
		it.each([
			[undefined, true, "upsert_setup"],
			[undefined, false, "preserve"],
			[{ provenance: "reviewed_active", status: "reviewed_active" }, true, "upsert_setup"],
			[{ provenance: "reviewed_team_candidate", status: "active" }, false, "revoke_setup"],
			[{ provenance: "reviewed_team_setup", status: "revoked" }, false, "preserve"],
			[{ provenance: "reviewed_team_setup", status: "revoked" }, true, "upsert_setup"],
			[{ provenance: "team_invite", status: "active" }, true, "normalize_invite"],
			[{ provenance: "coordinator_invite", status: "active" }, false, "normalize_invite"],
			[{ provenance: "team_invite", status: "reviewed_active" }, false, "preserve"],
			[{ provenance: "team_invite", status: "revoked" }, true, "preserve"],
			[{ provenance: "future_writer", status: "active" }, true, "preserve"],
		] as const)("plans %#", (existing, desired, expected) => {
			expect(planSetupMembershipTransition(existing, desired)).toBe(expected);
		});
	});

	describe("invite membership planning", () => {
		it.each([
			[undefined, "active", "insert_invite"],
			[
				{ provenance: "reviewed_active", status: "reviewed_active" },
				"reviewed_active",
				"adopt_setup",
			],
			[{ provenance: "reviewed_team_candidate", status: "revoked" }, "active", "reauthorize_setup"],
			[{ provenance: "reviewed_team_setup", status: "pending" }, "active", "reject"],
			[{ provenance: "team_invite", status: "active" }, "active", "preserve"],
			[
				{ provenance: "coordinator_invite", status: "active" },
				"reviewed_active",
				"normalize_invite",
			],
			[{ provenance: "coordinator_invite", status: "reviewed_active" }, "active", "reject"],
			[{ provenance: "team_invite", status: "revoked" }, "active", "reject"],
			[{ provenance: "future_writer", status: "active" }, "active", "reject"],
		] as const)("plans %#", (existing, targetStatus, expected) => {
			expect(planInviteMembershipTransition(existing, targetStatus)).toBe(expected);
		});
	});

	describe("setup device-decision planning", () => {
		it.each([
			[undefined, { desiredDecision: "included", belongsToRoster: true }, "upsert_setup"],
			[undefined, { belongsToRoster: false }, "preserve"],
			[
				{ provenance: "reviewed_team_setup", decision: "included" },
				{ desiredDecision: "excluded", belongsToRoster: true },
				"upsert_setup",
			],
			[
				{ provenance: "team_invite", decision: "included" },
				{ desiredDecision: "excluded", belongsToRoster: true },
				"upsert_preserving_invite",
			],
			[
				{ provenance: "future_writer", decision: "included" },
				{ desiredDecision: "excluded", belongsToRoster: true },
				"preserve",
			],
			[
				{ provenance: "reviewed_team_setup", decision: "included" },
				{ belongsToRoster: true },
				"delete_setup",
			],
			[
				{ provenance: "coordinator_invite", decision: "included" },
				{ belongsToRoster: true },
				"settle_invite_excluded",
			],
			[
				{ provenance: "team_invite", decision: "unresolved" },
				{ belongsToRoster: false },
				"settle_invite_excluded",
			],
			[{ provenance: "team_invite", decision: "included" }, { belongsToRoster: false }, "preserve"],
			[
				{ provenance: "future_writer", decision: "unresolved" },
				{ belongsToRoster: false },
				"preserve",
			],
		] as const)("plans %#", (existing, options, expected) => {
			expect(planSetupDeviceDecisionTransition(existing, options)).toBe(expected);
		});
	});

	describe("invite device-decision planning", () => {
		it.each([
			[undefined, false, "insert_unresolved"],
			[{ provenance: "reviewed_team_setup", decision: "included" }, false, "adopt_setup"],
			[{ provenance: "reviewed_active", decision: "excluded" }, true, "adopt_setup"],
			[{ provenance: "team_invite", decision: "included" }, false, "preserve"],
			[{ provenance: "coordinator_invite", decision: "included" }, true, "replace_unresolved"],
			[{ provenance: "future_writer", decision: "excluded" }, false, "preserve"],
			[{ provenance: "future_writer", decision: "excluded" }, true, "replace_unresolved"],
		] as const)("plans %#", (existing, newlyAuthorized, expected) => {
			expect(planInviteDeviceDecisionTransition(existing, newlyAuthorized)).toBe(expected);
		});
	});
});
