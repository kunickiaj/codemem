import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { putRecipientPolicyDenyOverlay } from "./recipient-policy-reconciliation.js";
import {
	liftTeamSetupQuarantineDenials,
	TEAM_SETUP_QUARANTINE_DENY_REASON,
	teamSetupQuarantineDenyKey,
} from "./team-setup-quarantine-delivery.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-26T00:00:00.000Z";

describe("liftTeamSetupQuarantineDenials", () => {
	let db: InstanceType<typeof Database>;

	function denyForQuarantine(teamId: string, scopeId: string, deviceId: string) {
		db.prepare(
			`INSERT INTO recipient_policy_deny_overlays(
			 canonical_project_identity, scope_id, device_id, generation, reason_code, created_at, updated_at
			 ) VALUES (?, ?, ?, 0, ?, ?, ?)`,
		).run(
			teamSetupQuarantineDenyKey(teamId),
			scopeId,
			deviceId,
			TEAM_SETUP_QUARANTINE_DENY_REASON,
			NOW,
			NOW,
		);
	}

	function overlays() {
		return db
			.prepare(
				`SELECT canonical_project_identity AS project, device_id AS device, reason_code AS reason
				 FROM recipient_policy_deny_overlays ORDER BY project, device`,
			)
			.all();
	}

	beforeEach(() => {
		// Arrange: two devices denied by Team A's quarantine, one by Team B's, and a
		// reconciler denial for the same scope and device under a real Project.
		db = new Database(":memory:");
		initTestSchema(db);
		denyForQuarantine("team-a", "scope-1", "device-1");
		denyForQuarantine("team-a", "scope-1", "device-2");
		denyForQuarantine("team-b", "scope-1", "device-1");
		putRecipientPolicyDenyOverlay(db, {
			canonicalProjectIdentity: "git:acme/internal",
			scopeId: "scope-1",
			deviceId: "device-1",
			generation: 1,
			reasonCode: "pending_revoke",
			now: NOW,
		});
	});

	afterEach(() => db.close());

	it("lifts only the named Team's denials for the given devices", () => {
		expect(liftTeamSetupQuarantineDenials(db, { teamId: "team-a", deviceIds: ["device-1"] })).toBe(
			1,
		);
		expect(overlays()).toEqual([
			{ project: "git:acme/internal", device: "device-1", reason: "pending_revoke" },
			{
				project: "team-setup-quarantine:team-a",
				device: "device-2",
				reason: "team_setup_quarantine",
			},
			{
				project: "team-setup-quarantine:team-b",
				device: "device-1",
				reason: "team_setup_quarantine",
			},
		]);
	});

	it("lifts every denial of the named Team, and nothing else, without device IDs", () => {
		expect(liftTeamSetupQuarantineDenials(db, { teamId: "team-a" })).toBe(2);
		expect(overlays()).toEqual([
			{ project: "git:acme/internal", device: "device-1", reason: "pending_revoke" },
			{
				project: "team-setup-quarantine:team-b",
				device: "device-1",
				reason: "team_setup_quarantine",
			},
		]);
	});
});
