import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyLegacyTeamSetupCompletionManifest,
	containLegacyTeamSetupCompletionConflict,
} from "./legacy-team-setup-completion-manifest.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import { recordTeamRecoveryExclusions } from "./team-recovery-exclusions.js";
import {
	discoverSetup,
	keepSetupScopeProof,
	loseSetupRecipient,
	reviewDiscoveredSetup,
	SETUP_ROSTER,
	seedDiscoverableSetup,
	setupRecipientStatus,
	setupScopeRead,
} from "./team-recovery-repair-test-fixtures.js";
import {
	DESKTOP,
	LAPTOP,
	NOW,
	PHONE,
	PROJECT,
	rekeyed,
	TABLET,
	TARGET,
} from "./team-recovery-test-fixtures.js";

/*
 * Discovery repairs a completed setup's missing Project recipients only while
 * the roster fingerprint the activation saved equals the one discovery
 * computes. An activation saves the coordinator roster's fingerprint, so the
 * repair also runs when the roster and the setup differ. These tests run that
 * repair for each such roster and check what it gives each device.
 */

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	seedDiscoverableSetup(db);
});

afterEach(() => db.close());

/** The devices recipient policy gives the Project to. */
function policyDevices(): string[] {
	const derivation = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, PROJECT);
	if (derivation.status === "blocked") throw new Error("policy blocked");
	return derivation.devices.map((device) => device.deviceId).toSorted();
}

describe("the repair of a completed setup's Project recipients, for a roster that differs from the setup", () => {
	it("restores the recipient and gives nothing to a device the setup does not list", async () => {
		// Arrange: the Phone joined the group after the review, and the setup's recipient was lost.
		const withPhone = [...SETUP_ROSTER, PHONE];
		const manifest = reviewDiscoveredSetup(db);
		await applyLegacyTeamSetupCompletionManifest(db, {
			...TARGET,
			manifest,
			freshRoster: withPhone,
		});
		loseSetupRecipient(db);

		const status = discoverSetup(db, withPhone);

		expect([status, setupRecipientStatus(db)]).toEqual([["ready"], "active"]);
		expect(policyDevices()).toEqual([LAPTOP.deviceId, DESKTOP.deviceId]);
		expect(
			db
				.prepare("SELECT COUNT(*) FROM policy_team_device_decisions WHERE device_id = ?")
				.pluck()
				.get(PHONE.deviceId),
		).toBe(0);
	});

	it.each([
		["with a different key", rekeyed(LAPTOP)],
		["disabled", { ...LAPTOP, enabled: false }],
	])(
		"restores the recipient and gives nothing to a device a recovery left out that is back %s",
		async (_case, laptopNow) => {
			// Arrange: the Team was disabled, a recovery left the Laptop out, and the setup was applied again.
			const roster = [laptopNow, DESKTOP, TABLET];
			const manifest = reviewDiscoveredSetup(db);
			const apply = (freshRoster: typeof roster) =>
				applyLegacyTeamSetupCompletionManifest(db, { ...TARGET, manifest, freshRoster });
			await apply(SETUP_ROSTER);
			await keepSetupScopeProof(db, LAPTOP.deviceId);
			await keepSetupScopeProof(db, DESKTOP.deviceId);
			await containLegacyTeamSetupCompletionConflict(db, TARGET);
			recordTeamRecoveryExclusions(db, {
				teamId: manifest.team_id,
				devices: [
					{ deviceId: "device-a", fingerprint: LAPTOP.fingerprint, reason: "removed_from_group" },
				],
				now: NOW,
			});
			db.prepare(
				"UPDATE identity_devices SET status = 'removed' WHERE device_id = 'device-a'",
			).run();
			await apply(roster);
			loseSetupRecipient(db);

			const status = discoverSetup(db, roster);

			expect([status, setupRecipientStatus(db)]).toEqual([["ready"], "active"]);
			expect(policyDevices()).toEqual([DESKTOP.deviceId]);
			expect(setupScopeRead(db, LAPTOP.deviceId)).toBe("policy_denied");
			expect(setupScopeRead(db, DESKTOP.deviceId)).toBe("authorized");
		},
	);
});
