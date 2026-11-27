import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import { applyLegacyTeamSetupCompletionManifest } from "./legacy-team-setup-completion-manifest.js";
import { isScopeDeviceAdmissionRefused } from "./scope-device-admission.js";
import {
	isTeamRecoveryHeld,
	isTeamRecoveryHeldBy,
	liftTeamRecoveryHold,
	placeTeamRecoveryHold,
	recordTeamRecoveryHoldReason,
} from "./team-recovery-holds.js";
import {
	DESKTOP,
	LAPTOP,
	NOW,
	quarantinedTeam,
	TABLET,
	TARGET,
} from "./team-recovery-test-fixtures.js";

let db: InstanceType<typeof Database>;
let manifest: CoordinatorLegacyTeamCompletionManifestV1;
let teamId: string;

beforeEach(async () => {
	db = new Database(":memory:");
	manifest = await quarantinedTeam(db);
	teamId = manifest.team_id;
});

afterEach(() => db.close());

const run = (sql: string) => db.prepare(sql).run();
const teamStatus = () => db.prepare("SELECT status FROM policy_teams").pluck().get();
const holdReason = () => db.prepare("SELECT reason FROM policy_team_recovery_holds").pluck().get();

/** Makes the Team active again as its completed setup left it, the way a recovery does. */
function reactivate() {
	run("UPDATE policy_teams SET status = 'active', migration_state = 'completed'");
	run(
		"UPDATE legacy_team_setup_drafts SET finish_digest = (SELECT finish_digest FROM legacy_team_setup_completions)",
	);
	run("UPDATE project_recipients SET status = 'active', migration_state = 'completed'");
}

const hold = (recoveryId: string) => placeTeamRecoveryHold(db, { teamId, recoveryId, now: NOW });

const refused = (deviceId: string) =>
	isScopeDeviceAdmissionRefused(db, { scopeId: "scope-engineering", deviceId });

/** Ordinary reconciliation: the coordinator's copy of the setup, with every reviewed device enrolled. */
const applyCoordinatorCopy = () =>
	applyLegacyTeamSetupCompletionManifest(db, {
		...TARGET,
		manifest,
		freshRoster: [LAPTOP, DESKTOP, TABLET],
	});

describe("a Team recovery hold", () => {
	it("makes an active Team serve its devices nothing until the recovery that holds it lifts it", () => {
		reactivate();
		expect(refused("device-b")).toBe(false);

		hold("recovery-1");
		expect(refused("device-b")).toBe(true);

		// A later recovery takes the hold over, and the earlier one can no longer change it.
		hold("recovery-2");
		recordTeamRecoveryHoldReason(db, {
			teamId,
			recoveryId: "recovery-1",
			reason: "evidence_changed",
		});
		liftTeamRecoveryHold(db, { teamId, recoveryId: "recovery-1" });
		expect(isTeamRecoveryHeldBy(db, { teamId, recoveryId: "recovery-1" })).toBe(false);
		expect(isTeamRecoveryHeldBy(db, { teamId, recoveryId: "recovery-2" })).toBe(true);
		expect(holdReason()).toBe("awaiting_verification");
		expect(refused("device-b")).toBe(true);

		liftTeamRecoveryHold(db, { teamId, recoveryId: "recovery-2" });
		expect(isTeamRecoveryHeld(db, teamId)).toBe(false);
		expect(refused("device-b")).toBe(false);
	});

	it.each([
		["a disabled Team disabled", () => undefined],
		["an active Team, which it disables", reactivate],
	])("is kept by ordinary reconciliation, which leaves %s", async (_case, arrange) => {
		arrange();
		hold("recovery-1");

		await expect(applyCoordinatorCopy()).rejects.toThrow("team_setup_completion_invalid");

		expect(teamStatus()).toBe("inactive");
		expect(isTeamRecoveryHeld(db, teamId)).toBe(true);
		expect(refused("device-b")).toBe(true);

		// The hold is what stopped it: once lifted, the same apply makes the Team active.
		liftTeamRecoveryHold(db, { teamId, recoveryId: "recovery-1" });
		await expect(applyCoordinatorCopy()).resolves.toEqual(manifest);
		expect(teamStatus()).toBe("active");
	});
});
