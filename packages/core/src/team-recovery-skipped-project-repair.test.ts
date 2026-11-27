import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import { currentLegacyTeamRosterFingerprint } from "./legacy-team-roster-fingerprint.js";
import {
	applyLegacyTeamSetupCompletionManifest,
	containLegacyTeamSetupCompletionConflict,
} from "./legacy-team-setup-completion-manifest.js";
import { isScopeDeviceAdmissionRefused } from "./scope-device-admission.js";
import { commitTeamRecovery } from "./team-recovery-commit.js";
import { previewTeamRecovery, type TeamRecoveryEvidence } from "./team-recovery-preview.js";
import {
	discoverSetup,
	keepSetupScopeProof,
	loseSetupRecipient,
	reviewDiscoveredSetup,
	SETUP_ROSTER,
	SETUP_SCOPE,
	seedDiscoverableSetup,
	setupRecipientStatus,
	setupScopeRead,
} from "./team-recovery-repair-test-fixtures.js";
import {
	blockChecks,
	DESKTOP,
	GROUP_ID,
	insertScope,
	NOW,
	TARGET,
} from "./team-recovery-test-fixtures.js";

/*
 * A Team recovery skips a Project whose sharing or routing someone changed
 * while the Team was disabled. Discovery later repairs a completed setup's
 * missing Project recipients. These tests recover a Team, run that repair with
 * the roster fingerprints equal, and check that it restores a recipient the
 * setup still owns and never shares a skipped Project again.
 */

const HERE = { coordinatorId: TARGET.coordinatorId };
const GROUP = { ...HERE, groupId: GROUP_ID };
const CLOCK_MS = Date.parse(NOW);

let db: InstanceType<typeof Database>;
let manifest: CoordinatorLegacyTeamCompletionManifestV1;

const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values);
const value = (sql: string) => db.prepare(sql).pluck().get();

// A Team every device of which is still enrolled, disabled by a conflict. The Desktop kept its proof.
beforeEach(async () => {
	db = new Database(":memory:");
	seedDiscoverableSetup(db);
	manifest = reviewDiscoveredSetup(db);
	await applyLegacyTeamSetupCompletionManifest(db, {
		...TARGET,
		manifest,
		freshRoster: SETUP_ROSTER,
	});
	await keepSetupScopeProof(db, DESKTOP.deviceId);
	await containLegacyTeamSetupCompletionConflict(db, TARGET);
});

afterEach(() => db.close());

/** Recovers the Team on evidence that lists every device of the setup. Returns the Projects it reviewed. */
async function recover() {
	const evidence: TeamRecoveryEvidence = {
		roster: { status: "read", source: GROUP, devices: SETUP_ROSTER },
		deviceRemovals: { status: "read", source: HERE, removals: [] },
		deviceBlocks: { status: "read", source: GROUP, checks: blockChecks(SETUP_ROSTER) },
		completion: { status: "read", source: GROUP, manifest },
		memberRemovals: { status: "read", source: GROUP, removals: [] },
		groupBinding: {
			status: "read",
			source: HERE,
			binding: { team_id: manifest.team_id, state: "unbound" },
		},
	};
	const preview = previewTeamRecovery(db, TARGET, evidence);
	if (preview.state !== "ready") throw new Error(`refused: ${preview.reason}`);
	const result = await commitTeamRecovery(
		db,
		{ ...TARGET, expectedDigest: preview.expectedDigest },
		{ nowMs: () => CLOCK_MS, readEvidence: async () => ({ evidence, startedAtMs: CLOCK_MS }) },
	);
	if (result.state !== "recovered") throw new Error(`not recovered: ${result.state}`);
	return preview.projects;
}

/** Whether discovery's roster fingerprint equals the one the completed setup saved, which lets the repair run. */
const fingerprintsMatch = () =>
	value("SELECT roster_fingerprint FROM legacy_team_setup_drafts WHERE state = 'completed'") ===
	currentLegacyTeamRosterFingerprint(db, SETUP_ROSTER);

const CHANGES: Array<[string, string, () => unknown]> = [
	[
		"a person stopped sharing it with the Team",
		"sharing_changed",
		() =>
			run(
				`UPDATE project_recipients SET status = 'revoked', provenance = 'user',
				 migration_state = 'user_managed', source_fingerprint = NULL WHERE recipient_kind = 'team'`,
			),
	],
	[
		"its memories were routed to another scope",
		"mapping_changed",
		() => {
			insertScope(db, "scope-elsewhere", GROUP_ID);
			run("UPDATE project_scope_mappings SET scope_id = 'scope-elsewhere' WHERE source = 'test'");
		},
	],
	[
		"its scope was archived",
		"scope_unavailable",
		() => run("UPDATE replication_scopes SET status = 'archived' WHERE scope_id = ?", SETUP_SCOPE),
	],
];

describe("the repair of a completed setup's Project recipients after a Team recovery", () => {
	it("restores a recipient the setup still owns, for a Project the recovery shared again", async () => {
		const projects = await recover();
		loseSetupRecipient(db);

		const status = discoverSetup(db, SETUP_ROSTER);

		expect(projects).toMatchObject([{ outcome: "restored" }]);
		expect(fingerprintsMatch()).toBe(true);
		expect([status, setupRecipientStatus(db)]).toEqual([["ready"], "active"]);
		expect(setupScopeRead(db, DESKTOP.deviceId)).toBe("authorized");
	});

	it.each(CHANGES)(
		"leaves a Project the recovery skipped unshared when %s",
		async (_case, reason, change) => {
			// Arrange: the change was made while the Team was disabled, so the recovery skips the Project.
			change();
			const projects = await recover();

			discoverSetup(db, SETUP_ROSTER);

			expect(projects).toMatchObject([{ outcome: "skipped", reason }]);
			expect(fingerprintsMatch()).toBe(true);
			expect(setupRecipientStatus(db)).toBe("revoked");
			expect(value("SELECT COUNT(*) FROM policy_team_recovery_skipped_projects")).toBe(1);
			// The Desktop is a Team device again, and still gets nothing of the skipped Project.
			expect(setupScopeRead(db, DESKTOP.deviceId)).toBe("policy_denied");
			expect(
				isScopeDeviceAdmissionRefused(db, { scopeId: SETUP_SCOPE, deviceId: DESKTOP.deviceId }),
			).toBe(true);
		},
	);
});
