import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import { applyLegacyTeamSetupCompletionManifest } from "./legacy-team-setup-completion-manifest.js";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "./recipient-policy-reconciliation.js";
import { isScopeDeviceAdmissionRefused } from "./scope-device-admission.js";
import { recordTeamRecoveryExclusions } from "./team-recovery-exclusions.js";
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

beforeEach(async () => {
	db = new Database(":memory:");
	manifest = await quarantinedTeam(db);
});

afterEach(() => db.close());

const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values);

/** Makes the Team active again as its completed setup left it, the way a recovery does. */
function reactivate(options: { recipients?: boolean } = {}) {
	run("UPDATE policy_teams SET status = 'active', migration_state = 'completed'");
	run(
		"UPDATE legacy_team_setup_drafts SET finish_digest = (SELECT finish_digest FROM legacy_team_setup_completions)",
	);
	if (options.recipients === false) return;
	run("UPDATE project_recipients SET status = 'active', migration_state = 'completed'");
}

const leaveOutLaptop = () =>
	recordTeamRecoveryExclusions(db, {
		teamId: manifest.team_id,
		devices: [
			{ deviceId: "device-a", fingerprint: LAPTOP.fingerprint, reason: "removed_from_group" },
		],
		now: NOW,
	});

const refused = (deviceId: string) =>
	isScopeDeviceAdmissionRefused(db, { scopeId: "scope-engineering", deviceId });

const includeAgain = (deviceId: string) =>
	run(
		`INSERT INTO policy_team_device_decisions(team_id, device_id, decision, assignment_version,
		 provenance, revision, created_at, updated_at)
		 VALUES (?, ?, 'included', 0, 'reviewed_team_setup', 'r2', ?, ?)
		 ON CONFLICT(team_id, device_id) DO UPDATE SET decision = 'included'`,
		manifest.team_id,
		deviceId,
		NOW,
		NOW,
	);

describe("Team recovery exclusions", () => {
	beforeEach(() => {
		reactivate();
		leaveOutLaptop();
	});

	it("refuse the device at sync admission while its decision still says included", () => {
		expect(refused("device-a")).toBe(true);
		expect(refused("device-b")).toBe(false);
	});

	it.each([
		[
			"an invitation resets the decision and a setup includes it again",
			() => {
				run(
					"UPDATE policy_team_device_decisions SET decision = 'unresolved', provenance = 'team_invite' WHERE device_id = 'device-a'",
				);
				includeAgain("device-a");
			},
		],
		[
			"its binding is deleted, which deletes the decision, and both are written again",
			() => {
				const binding = db
					.prepare("SELECT * FROM identity_devices WHERE device_id = 'device-a'")
					.get() as Record<string, unknown>;
				run("DELETE FROM identity_devices WHERE device_id = 'device-a'");
				const columns = Object.keys(binding);
				run(
					`INSERT INTO identity_devices(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
					...Object.values(binding),
				);
				includeAgain("device-a");
			},
		],
	])("survive when %s", (_case, undo) => {
		undo();

		expect(
			db
				.prepare("SELECT decision FROM policy_team_device_decisions WHERE device_id = 'device-a'")
				.pluck()
				.get(),
		).toBe("included");
		expect(refused("device-a")).toBe(true);
	});

	it("keep the device out of the devices recipient policy derives for the Team's Project", () => {
		const derived = deriveRecipientPolicyEffectiveDevicesFromDatabase(db, PROJECT);

		expect(derived.status).toBe("eligible");
		expect(derived.status === "eligible" && derived.devices.map((row) => row.deviceId)).toEqual([
			"device-b",
		]);
	});

	it("keep later reconciliation from quarantining the Team over the device the manifest still lists", async () => {
		// Act: the coordinator's copy still includes the Laptop, and the roster no longer has it.
		const reapply = applyLegacyTeamSetupCompletionManifest(db, {
			...TARGET,
			manifest,
			freshRoster: [DESKTOP, TABLET],
			deviceRemovals: { status: "read", removals: [] },
		});

		await expect(reapply).resolves.toEqual(manifest);
		expect(db.prepare("SELECT status FROM policy_teams").pluck().get()).toBe("active");
	});
});

describe("a setup activation after a Team recovery exclusion", () => {
	it("neither binds nor includes the excluded device, and keeps its person a member", async () => {
		// Arrange: the Team is still quarantined, the Laptop's binding has ended, and the
		// roster lists the Laptop again under its reviewed key. A full activation runs.
		leaveOutLaptop();
		run("UPDATE identity_devices SET status = 'removed' WHERE device_id = 'device-a'");

		await applyLegacyTeamSetupCompletionManifest(db, {
			...TARGET,
			manifest,
			freshRoster: [LAPTOP, DESKTOP, TABLET],
		});

		const row = (sql: string) => db.prepare(sql).pluck().get();
		expect(row("SELECT status FROM policy_teams")).toBe("active");
		expect(row("SELECT status FROM identity_devices WHERE device_id = 'device-a'")).toBe("removed");
		expect(
			row("SELECT decision FROM policy_team_device_decisions WHERE device_id = 'device-a'"),
		).toBe("excluded");
		expect(row("SELECT status FROM policy_team_memberships WHERE identity_id = 'identity-a'")).toBe(
			"reviewed_active",
		);
		expect(refused("device-a")).toBe(true);
		expect(refused("device-b")).toBe(false);
	});
});

describe("sync admission for an active reviewed Team", () => {
	beforeEach(() => reactivate());

	it.each([
		[
			"was revoked from the Team",
			"UPDATE policy_team_memberships SET status = 'revoked' WHERE identity_id = 'identity-b'",
		],
		["was deactivated", "UPDATE actors SET status = 'deactivated' WHERE actor_id = 'identity-b'"],
		[
			"was merged into another person",
			"UPDATE actors SET merged_into_actor_id = 'identity-a' WHERE actor_id = 'identity-b'",
		],
		[
			"no longer has it bound",
			"UPDATE identity_devices SET status = 'removed' WHERE device_id = 'device-b'",
		],
	])("refuses a device with an included decision whose person %s", (_case, sql) => {
		expect(refused("device-b")).toBe(false);

		run(sql);

		expect(
			db
				.prepare("SELECT decision FROM policy_team_device_decisions WHERE device_id = 'device-b'")
				.pluck()
				.get(),
		).toBe("included");
		expect(refused("device-b")).toBe(true);
		expect(refused("device-a")).toBe(false);
	});

	it("serves a revoked member's device a Project that is also shared with the person directly", () => {
		run("UPDATE policy_team_memberships SET status = 'revoked' WHERE identity_id = 'identity-b'");
		expect(refused("device-b")).toBe(true);

		run(
			`INSERT INTO project_recipients(canonical_project_identity, recipient_kind, recipient_id,
			 status, provenance, policy_revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES (?, 'identity', 'identity-b', 'active', 'user', 'r1', 'user_managed', 'direct-b', ?, ?)`,
			PROJECT,
			NOW,
			NOW,
		);

		expect(refused("device-b")).toBe(false);
	});
});

describe("sync admission for a Project a recovery skipped", () => {
	it("refuses a revoked member's device and serves an eligible one", () => {
		// Arrange: the Team is active again, but its recipient for the Project stays revoked.
		reactivate({ recipients: false });
		run("UPDATE policy_team_memberships SET status = 'revoked' WHERE identity_id = 'identity-b'");

		expect(refused("device-b")).toBe(true);
		expect(refused("device-a")).toBe(false);
	});
});
