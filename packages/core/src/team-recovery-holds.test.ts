import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import { applyLegacyTeamSetupCompletionManifest } from "./legacy-team-setup-completion-manifest.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import { isScopeDeviceAdmissionRefused } from "./scope-device-admission.js";
import {
	isTeamRecoveryHeld,
	isTeamRecoveryHeldBy,
	isTeamRecoveryHoldAbandoned,
	liftTeamRecoveryHold,
	placeTeamRecoveryHold,
	recordTeamRecoveryHoldReason,
	TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS,
	trackLiveTeamRecovery,
} from "./team-recovery-holds.js";
import { recordTeamRecoverySkippedProjects } from "./team-recovery-skipped-projects.js";
import {
	DESKTOP,
	LAPTOP,
	NOW,
	PROJECT,
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

const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values);
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

describe("a Team recovery hold in recipient policy", () => {
	const derived = () => {
		const { status, devices } = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, PROJECT);
		return { status, deviceIds: devices.map((device) => device.deviceId) };
	};

	it("makes the Team read as inactive, so no device is derived for its Projects until it is lifted", () => {
		reactivate();
		const active = { status: "eligible", deviceIds: ["device-a", "device-b"] };
		expect(derived()).toEqual(active);

		// As for a disabled Team: the derivation is blocked, and the reconciler grants nothing.
		hold("recovery-1");
		expect(derived()).toEqual({ status: "blocked", deviceIds: [] });

		liftTeamRecoveryHold(db, { teamId, recoveryId: "recovery-1" });
		expect(derived()).toEqual(active);
	});
});

describe("an abandoned Team recovery hold", () => {
	const NOW_MS = Date.parse(NOW);
	const abandoned = (nowMs: number) => isTeamRecoveryHoldAbandoned(db, teamId, nowMs);

	it("is one that no recovery in this process is verifying, or one older than a recovery is given", () => {
		expect(abandoned(NOW_MS)).toBe(false);

		hold("recovery-1");
		expect(abandoned(NOW_MS)).toBe(true);

		const end = trackLiveTeamRecovery("recovery-1");
		expect(abandoned(NOW_MS + TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS)).toBe(false);
		expect(abandoned(NOW_MS + TEAM_RECOVERY_EVIDENCE_MAX_AGE_MS + 1)).toBe(true);

		end();
		expect(abandoned(NOW_MS)).toBe(true);
	});
});

describe("sync admission for a Project a Team recovery recorded as skipped", () => {
	const skip = () =>
		recordTeamRecoverySkippedProjects(db, {
			teamId,
			recoveryId: "recovery-1",
			projects: [{ projectIdentity: PROJECT, reason: "sharing_changed" }],
			now: NOW,
		});

	beforeEach(() => {
		// The Team is active again, and a person took the Project away from it.
		reactivate();
		run(
			`UPDATE project_recipients SET status = 'revoked', provenance = 'user',
			 migration_state = 'user_managed'`,
		);
	});

	it("refuses an eligible device the scope that holds it, whoever revoked its recipient", () => {
		skip();

		expect(refused("device-b")).toBe(true);
		expect(refused("device-a")).toBe(true);
	});

	it.each([
		[
			"the Project is shared with the device's person directly",
			() =>
				run(
					`INSERT INTO project_recipients(canonical_project_identity, recipient_kind, recipient_id,
					 status, provenance, policy_revision, migration_state, idempotency_key, created_at, updated_at)
					 VALUES (?, 'identity', 'identity-b', 'active', 'user', 'r1', 'user_managed', 'direct-b', ?, ?)`,
					PROJECT,
					NOW,
					NOW,
				),
		],
		[
			"the Team shares the Project again",
			() => run("UPDATE project_recipients SET status = 'active'"),
		],
		[
			"a later recovery no longer skips the Project",
			() =>
				recordTeamRecoverySkippedProjects(db, {
					teamId,
					recoveryId: "recovery-2",
					projects: [],
					now: NOW,
				}),
		],
	])("serves the device again once %s", (_case, change) => {
		skip();
		expect(refused("device-b")).toBe(true);

		change();

		expect(refused("device-b")).toBe(false);
	});
});
