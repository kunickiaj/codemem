import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import { isScopeDeviceAdmissionRefused } from "./scope-device-admission.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import {
	planTeamRecoveryDevices,
	type TeamRecoveryDeviceBlockCheck,
	type TeamRecoveryDeviceRemoval,
} from "./team-recovery-devices.js";
import { recordTeamRecoveryExclusions } from "./team-recovery-exclusions.js";
import {
	blockChecks,
	DESKTOP,
	GROUP_ID,
	insertScope,
	inviteMember,
	LAPTOP,
	LAPTOP_REMOVAL,
	NOW,
	OTHER_KEY,
	OTHER_PUBLIC_KEY,
	PHONE,
	pinDevice,
	quarantinedTeam,
	rekeyed,
	TABLET,
} from "./team-recovery-test-fixtures.js";

let db: InstanceType<typeof Database>;
let manifest: CoordinatorLegacyTeamCompletionManifestV1;

beforeEach(async () => {
	db = new Database(":memory:");
	manifest = await quarantinedTeam(db);
});

afterEach(() => db.close());

const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values);

/**
 * Plans against a roster and removal records, the Laptop removed unless stated
 * otherwise. Unless given, the block checks report every roster device unblocked.
 */
function plan(
	roster: ReadonlyArray<typeof LAPTOP> = [DESKTOP, TABLET],
	deviceRemovals: readonly TeamRecoveryDeviceRemoval[] = [LAPTOP_REMOVAL],
	deviceBlocks: readonly TeamRecoveryDeviceBlockCheck[] = blockChecks(roster),
) {
	const memberships = db
		.prepare("SELECT identity_id AS identityId, status FROM policy_team_memberships")
		.all() as Array<{ identityId: string; status: string }>;
	return planTeamRecoveryDevices(db, {
		teamId: manifest.team_id,
		groupId: GROUP_ID,
		manifest,
		roster: new Map(roster.map((device) => [device.deviceId, device])),
		deviceRemovals,
		deviceBlocks,
		memberships,
	});
}

function outcomes(result: ReturnType<typeof plan>): Record<string, string> {
	if (result.state !== "planned") throw new Error(`not planned: ${result.state}`);
	return Object.fromEntries(
		result.devices.map((device) => [
			device.deviceId,
			device.reason ? `${device.outcome}:${device.reason}` : device.outcome,
		]),
	);
}

const LAPTOP_EXCLUSION = {
	deviceId: "device-a",
	fingerprint: LAPTOP.fingerprint,
	reason: "removed_from_group" as const,
};

/** Records what an earlier recovery wrote when it left the Laptop out. */
const leaveOutLaptop = () =>
	recordTeamRecoveryExclusions(db, {
		teamId: manifest.team_id,
		devices: [LAPTOP_EXCLUSION],
		now: NOW,
	});

describe("Team recovery device plan", () => {
	it("restores enrolled devices, leaves out the removed one and keeps the review's exclusion", () => {
		const result = plan();

		expect(outcomes(result)).toEqual({
			"device-a": "stays_out:removed_from_group",
			"device-b": "regains_access",
			"device-x": "stays_out:excluded_in_review",
		});
		expect(result).toMatchObject({ exclusions: [LAPTOP_EXCLUSION] });
	});

	it("leaves out a removed device that still has a pin and a cached scope membership", () => {
		// Arrange: this machine never ended the Laptop's local access.
		pinDevice(db, "device-a", LAPTOP.publicKey);
		run(
			`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
			 VALUES ('scope-engineering', 'device-a', 'member', 'active', 1, ?)`,
			NOW,
		);

		expect(outcomes(plan())["device-a"]).toBe("stays_out:removed_from_group");
	});

	it("plans an exclusion that makes sync admission refuse the removed device once the Team is active", () => {
		// Arrange: the Team made active again with no exclusion, as a plain reactivation would.
		const laptop = { scopeId: "scope-engineering", deviceId: "device-a" };
		run("UPDATE policy_teams SET status = 'active', migration_state = 'completed'");
		run("UPDATE project_recipients SET status = 'active', migration_state = 'completed'");
		expect(isScopeDeviceAdmissionRefused(db, laptop)).toBe(false);

		// Act: the exclusion recovery plans for a device it leaves out.
		leaveOutLaptop();

		// Assert: refused from current state, with no cache refresh. The Desktop is served.
		expect(isScopeDeviceAdmissionRefused(db, laptop)).toBe(true);
		expect(isScopeDeviceAdmissionRefused(db, { ...laptop, deviceId: "device-b" })).toBe(false);
	});

	it("leaves out a device the coordinator blocked", () => {
		const result = plan(undefined, [{ ...LAPTOP_REMOVAL, revoked: true }]);

		expect(outcomes(result)["device-a"]).toBe("stays_out:blocked_by_coordinator");
	});

	it("leaves out the devices of a person who is no longer a member", () => {
		run("UPDATE policy_team_memberships SET status = 'revoked' WHERE identity_id = 'identity-b'");

		expect(outcomes(plan())["device-b"]).toBe("stays_out:person_left_out");
	});

	it("reports a Team whose policy rows would block it", () => {
		// Arrange: a membership status the reviewed allowlist does not know.
		run("UPDATE policy_team_memberships SET status = 'active' WHERE identity_id = 'identity-b'");

		expect(plan()).toEqual({ state: "blocked" });
	});
});

describe("Team recovery device refusals", () => {
	const elsewhere = { ...LAPTOP_REMOVAL, group_id: "group-other" };

	it.each([
		["a changed key", [rekeyed(LAPTOP)], [], "device_key_changed"],
		["a disabled device", [{ ...LAPTOP, enabled: false }], [], "device_disabled"],
		["no removal record", [], [], "device_missing_without_removal"],
		["a removal record from another group", [], [elsewhere], "device_missing_without_removal"],
		[
			"a removal record for another key",
			[],
			[{ ...LAPTOP_REMOVAL, fingerprint: OTHER_KEY }],
			"device_missing_without_removal",
		],
		[
			"a device still enrolled that the coordinator blocked",
			[LAPTOP],
			[{ ...elsewhere, revoked: true as const }],
			"device_blocked",
		],
	])("refuses an included device with %s", (_case, laptop, removals, reason) => {
		const result = plan([...laptop, DESKTOP, TABLET], removals);

		expect(result).toEqual({ state: "refused", reason, deviceIds: ["device-a"] });
	});

	it("refuses an enrolled device the coordinator blocked without removing it", () => {
		// Arrange: a block leaves the enrollment enabled and writes no removal record.
		const roster = [LAPTOP, DESKTOP, TABLET];
		const blocks = blockChecks(roster, ["device-a"]);

		expect(plan(roster, [], blocks)).toEqual({
			state: "refused",
			reason: "device_blocked",
			deviceIds: ["device-a"],
		});
	});

	it.each([
		["no block check", []],
		["a block check made under another key", blockChecks([rekeyed(DESKTOP)])],
		["a block check made for another device", blockChecks([{ ...DESKTOP, deviceId: "device-z" }])],
	])("refuses an enrolled device with %s", (_case, checks) => {
		const result = plan(undefined, undefined, checks);

		expect(result).toEqual({
			state: "refused",
			reason: "device_block_unchecked",
			deviceIds: ["device-b"],
		});
	});

	it("refuses a setup that included a device the coordinator had disabled", () => {
		// Arrange: later reconciliation would reject this copy however the roster reads.
		manifest = {
			...manifest,
			device_decisions: manifest.device_decisions.map((decision) =>
				decision.device_id === "device-b" ? { ...decision, enabled: false } : decision,
			),
		};

		expect(plan()).toMatchObject({ reason: "device_disabled", deviceIds: ["device-b"] });
	});

	it("refuses a device that is enrolled and has a removal record for the same key in this group", () => {
		// Arrange: the two reads cannot both be right.
		const result = plan([LAPTOP, DESKTOP, TABLET], [LAPTOP_REMOVAL]);

		expect(result).toEqual({
			state: "refused",
			reason: "device_evidence_contradictory",
			deviceIds: ["device-a"],
		});
	});

	it("refuses a device the roster lists as enrolled and the block check reports removed", () => {
		// Arrange: the Desktop was removed after the roster was read and before the check was asked.
		const checks = blockChecks([DESKTOP, TABLET]).map((check) => ({
			...check,
			removed: check.deviceId === "device-b",
		}));

		const result = plan([DESKTOP, TABLET], [LAPTOP_REMOVAL], checks);

		expect(result).toEqual({
			state: "refused",
			reason: "device_evidence_contradictory",
			deviceIds: ["device-b"],
		});
	});

	it("does not clear a device whose block check does not say whether it was removed", () => {
		const checks = blockChecks([DESKTOP, TABLET]).map(({ removed: _removed, ...check }) => check);

		const result = plan([DESKTOP, TABLET], [LAPTOP_REMOVAL], checks as never);

		expect(result).toMatchObject({ state: "refused", reason: "device_block_unchecked" });
	});

	it("refuses an excluded device whose decision is now included", () => {
		run(
			"UPDATE policy_team_device_decisions SET decision = 'included' WHERE device_id = 'device-x'",
		);

		expect(plan()).toEqual({
			state: "refused",
			reason: "device_decision_changed",
			deviceIds: ["device-x"],
		});
	});

	it("reports the first refusal in a fixed order when several devices stop recovery", () => {
		const result = plan([{ ...DESKTOP, enabled: false }, TABLET], []);

		expect(result).toMatchObject({ reason: "device_disabled", deviceIds: ["device-b"] });
	});
});

describe("Team recovery block answers", () => {
	const roster = [LAPTOP, DESKTOP, TABLET];
	const elsewhere = { group_id: "group-other", device_id: "device-z", revoked: true as const };

	it("refuses an unblocked answer that asserts a fingerprint without the key it was asked with", () => {
		// Arrange: answers that name each device and its fingerprint, but no key.
		const keyless = blockChecks(roster).map(({ publicKey: _asked, ...answer }) => answer);

		const result = plan(roster, [], keyless as unknown as TeamRecoveryDeviceBlockCheck[]);

		expect(result).toEqual({
			state: "refused",
			reason: "device_block_unchecked",
			deviceIds: ["device-a", "device-b"],
		});
	});

	it.each([
		["a malformed Ed25519 key", "ssh-ed25519 AAAA"],
		["a key of another type", "ssh-rsa AAAAB3NzaC1yc2E"],
	])(
		"refuses an unblocked answer for %s, which the coordinator checks by device ID alone",
		(_case, publicKey) => {
			// Arrange: the Phone's only trusted key is one no key ID can be derived from.
			inviteMember(db, manifest.team_id, { enrolledKey: null });
			pinDevice(db, "device-d", publicKey);
			const phone = { ...PHONE, publicKey, fingerprint: fingerprintPublicKey(publicKey) };

			const result = plan([DESKTOP, TABLET, phone]);

			expect(result).toEqual({
				state: "refused",
				reason: "device_block_unchecked",
				deviceIds: ["device-d"],
			});
		},
	);

	it.each([
		[
			"a blocked removal record of its key under another device in another group",
			[{ ...elsewhere, fingerprint: DESKTOP.fingerprint }],
			[],
		],
		[
			"a block answer for its key asked under another device",
			[],
			[{ deviceId: "device-z", publicKey: DESKTOP.publicKey, blocked: true }],
		],
		[
			"a block answer for its device ID that carries no key",
			[],
			[{ deviceId: "device-b", blocked: true }],
		],
	])("honors %s", (_case, removals, answers) => {
		// Arrange: the Desktop's own answer, asked with its key, says it is not blocked.
		const checks = [...blockChecks(roster), ...answers] as TeamRecoveryDeviceBlockCheck[];

		const result = plan(roster, removals, checks);

		expect(result).toEqual({ state: "refused", reason: "device_blocked", deviceIds: ["device-b"] });
	});
});

describe("Team recovery plan for invitation-added devices", () => {
	const phoneRemoval = {
		group_id: GROUP_ID,
		device_id: PHONE.deviceId,
		fingerprint: PHONE.fingerprint,
	};
	const replaced = rekeyed(PHONE);

	it.each([
		["enrolled", [PHONE], [], "regains_access"],
		["removed from the group", [], [phoneRemoval], "stays_out:removed_from_group"],
	])("applies the roster rule to one that is %s", (_case, phone, removals, expected) => {
		inviteMember(db, manifest.team_id);

		const result = plan([DESKTOP, TABLET, ...phone], [LAPTOP_REMOVAL, ...removals]);

		expect(outcomes(result)["device-d"]).toBe(expected);
	});

	it("trusts the key this machine pinned when the binding names none", () => {
		// Arrange: enrolled under its own key, which nothing here vouches for yet.
		inviteMember(db, manifest.team_id, { enrolledKey: null });
		const unpaired = plan([DESKTOP, TABLET, PHONE]);

		// Act: this machine paired with the Phone under that key.
		pinDevice(db, "device-d", PHONE.publicKey);

		expect(unpaired).toMatchObject({ reason: "device_key_unverified", deviceIds: ["device-d"] });
		expect(outcomes(plan([DESKTOP, TABLET, PHONE]))["device-d"]).toBe("regains_access");
	});

	it.each([
		["missing from the roster without a removal record", [], "device_missing_without_removal"],
		[
			"enrolled under another key than its binding was recorded for",
			[replaced],
			"device_key_unverified",
		],
		["disabled", [{ ...PHONE, enabled: false }], "device_disabled"],
	])("refuses one that is %s", (_case, phone, reason) => {
		inviteMember(db, manifest.team_id);

		const result = plan([DESKTOP, TABLET, ...phone]);

		expect(result).toEqual({ state: "refused", reason, deviceIds: ["device-d"] });
	});

	it("refuses one that is pinned here under another key than it is enrolled under", () => {
		inviteMember(db, manifest.team_id);
		pinDevice(db, "device-d", OTHER_PUBLIC_KEY);

		const result = plan([DESKTOP, TABLET, PHONE]);

		expect(result).toMatchObject({ reason: "device_key_changed", deviceIds: ["device-d"] });
	});

	it.each([
		["another group this machine knows, with no pin", "group-other", false],
		["a group this machine does not know, with a matching pin", "group-unknown", true],
	])("accepts one whose binding was recorded by %s", (_case, enrolledGroupId, pinned) => {
		// Arrange: a device has one binding, and it keeps the first group's digest.
		insertScope(db, "scope-other", "group-other");
		inviteMember(db, manifest.team_id, { enrolledGroupId });
		if (pinned) pinDevice(db, "device-d", PHONE.publicKey);

		expect(outcomes(plan([DESKTOP, TABLET, PHONE]))["device-d"]).toBe("regains_access");
	});

	it("refuses one whose binding was recorded by a group this machine does not know, with no pin", () => {
		inviteMember(db, manifest.team_id, { enrolledGroupId: "group-unknown" });

		const result = plan([DESKTOP, TABLET, PHONE]);

		expect(result).toMatchObject({ reason: "device_key_unverified", deviceIds: ["device-d"] });
	});

	it.each([
		["enrolled under a key nothing here vouches for", [replaced], []],
		["missing, with a removal record that matches by device ID alone", [], [phoneRemoval]],
	])("refuses one with no trusted key that is %s", (_case, phone, removals) => {
		// Arrange: the binding names no key and this machine never paired with the Phone.
		inviteMember(db, manifest.team_id, { enrolledKey: null });

		const result = plan([DESKTOP, TABLET, ...phone], [LAPTOP_REMOVAL, ...removals]);

		expect(result).toEqual({
			state: "refused",
			reason: "device_key_unverified",
			deviceIds: ["device-d"],
		});
	});

	it("does not trust a pin whose fingerprint no longer matches the key stored with it", () => {
		inviteMember(db, manifest.team_id, { enrolledKey: null });
		pinDevice(db, "device-d", PHONE.publicKey);
		run("UPDATE sync_peers SET public_key = ? WHERE peer_device_id = 'device-d'", OTHER_PUBLIC_KEY);

		expect(plan([DESKTOP, TABLET, PHONE])).toMatchObject({ reason: "device_key_unverified" });
	});

	it("needs the trusted key in the removal record of one that is missing", () => {
		inviteMember(db, manifest.team_id);

		const result = plan(
			[DESKTOP, TABLET],
			[LAPTOP_REMOVAL, { ...phoneRemoval, fingerprint: OTHER_KEY }],
		);

		expect(result).toMatchObject({ reason: "device_missing_without_removal" });
	});
});

describe("Team recovery plan after an earlier recovery", () => {
	it("keeps out a device an earlier recovery left out, even when it is enrolled again", () => {
		// Arrange: left out earlier, then back on the roster under a new key with no removal record.
		leaveOutLaptop();

		const result = plan([rekeyed(LAPTOP), DESKTOP, TABLET], []);

		expect(outcomes(result)).toMatchObject({
			"device-a": "stays_out:left_out_by_recovery",
			"device-b": "regains_access",
		});
		expect(result).toMatchObject({ exclusions: [] });
	});

	it("keeps it out after its decision is deleted and written again as included", () => {
		// Arrange: deleting a binding deletes the decision, and a later setup can write a new one.
		leaveOutLaptop();
		run("DELETE FROM policy_team_device_decisions WHERE device_id = 'device-a'");
		run(
			`INSERT INTO policy_team_device_decisions(team_id, device_id, decision, assignment_version,
			 provenance, revision, created_at, updated_at)
			 VALUES (?, 'device-a', 'included', 0, 'reviewed_team_setup', 'r2', ?, ?)`,
			manifest.team_id,
			NOW,
			NOW,
		);

		expect(outcomes(plan([LAPTOP, DESKTOP, TABLET], []))["device-a"]).toBe(
			"stays_out:left_out_by_recovery",
		);
	});
});
