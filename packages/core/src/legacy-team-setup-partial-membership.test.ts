import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import {
	type DiscoverLegacyTeamCandidatesOptions,
	discoverLegacyTeamCandidates,
} from "./legacy-team-candidate.js";
import {
	applyLegacyTeamSetupCompletionManifest,
	deriveLegacyTeamSetupCompletionManifest,
} from "./legacy-team-setup-completion-manifest.js";
import {
	getLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "./legacy-team-setup-draft.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "./recipient-policy-identifiers.js";
import { initTestSchema } from "./test-utils.js";

/*
 * Two devices share one coordinator group. Device A finishes setup with
 * Projects in two Spaces; device B belongs to only some of those Spaces and
 * its membership changes over time. Device B must apply A's completion at
 * every step, share only Projects in Spaces it can see, and never quarantine
 * the Team because of its own membership.
 */

const NOW = "2026-09-01T12:00:00.000Z";
const COORDINATOR_ID = "coordinator-private";
const GROUP_ID = "group-private";
const CANDIDATE = legacyTeamCandidateId(COORDINATOR_ID, GROUP_ID);
const TEAM_ID = deterministicPolicyTeamId(CANDIDATE);
const WORK = "https://git.example.invalid/acme/work.git";
const PERSONAL = "https://git.example.invalid/me/personal.git";
const SPACES = { work: "scope-work", personal: "scope-personal" } as const;
const ROSTER = [
	{ deviceId: "device-a", fingerprint: "a".repeat(64), displayName: "Home", enabled: true },
	{ deviceId: "device-b", fingerprint: "b".repeat(64), displayName: "Work", enabled: true },
];

type Db = InstanceType<typeof Database>;

function discoveryOptions(localDeviceId: string, now = NOW): DiscoverLegacyTeamCandidatesOptions {
	return {
		projection: { localActorId: "identity-me", localDeviceId },
		groups: [
			{ coordinatorId: COORDINATOR_ID, groupId: GROUP_ID, displayName: "Team", devices: ROSTER },
		],
		now,
	};
}

function seedDevice(db: Db): void {
	initTestSchema(db);
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES ('identity-me', 'Me', 1, 'active', ?, ?)`,
	).run(NOW, NOW);
	const insertScope = db.prepare(
		`INSERT INTO replication_scopes(
		 scope_id, label, kind, authority_type, coordinator_id, group_id,
		 membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', ?, ?, 1, 'active', ?, ?)`,
	);
	const insertMapping = db.prepare(
		`INSERT INTO project_scope_mappings(
		 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
		 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
	);
	const insertSession = db.prepare(
		"INSERT INTO sessions(started_at, project, git_remote, git_branch) VALUES (?, ?, ?, 'main')",
	);
	for (const [project, scopeId] of [
		[WORK, SPACES.work],
		[PERSONAL, SPACES.personal],
	] as const) {
		insertScope.run(scopeId, scopeId, COORDINATOR_ID, GROUP_ID, NOW, NOW);
		insertMapping.run(project, project, scopeId, NOW, NOW);
		insertSession.run(NOW, project, project);
	}
}

function setSpace(db: Db, scopeId: string, status: "active" | "archived"): void {
	db.prepare("UPDATE replication_scopes SET status = ? WHERE scope_id = ?").run(status, scopeId);
}

/** Device A reviews every device as its owner's and finishes setup. */
function finishOnDeviceA(db: Db): CoordinatorLegacyTeamCompletionManifestV1 {
	discoverLegacyTeamCandidates(db, discoveryOptions("device-a"));
	let draft = getLegacyTeamSetupDraft(db, CANDIDATE);
	if (!draft) throw new Error("device A draft missing");
	for (const device of draft.devices) {
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: "identity-me",
			expectation: device.expectation,
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			decision: "included",
			now: NOW,
		});
	}
	return deriveLegacyTeamSetupCompletionManifest(db, {
		candidateRef: CANDIDATE,
		attemptId: draft.attemptId,
		completedAt: NOW,
	});
}

function teamState(db: Db) {
	return {
		team: db
			.prepare("SELECT status, migration_state FROM policy_teams WHERE team_id = ?")
			.get(TEAM_ID),
		shared: db
			.prepare(
				`SELECT canonical_project_identity FROM project_recipients
				 WHERE recipient_kind = 'team' AND recipient_id = ? AND status = 'active'
				 ORDER BY canonical_project_identity`,
			)
			.pluck()
			.all(TEAM_ID),
	};
}

describe("legacy Team setup with partial Space membership", () => {
	let deviceA: Db;
	let deviceB: Db;
	let manifest: CoordinatorLegacyTeamCompletionManifestV1;
	let step = 0;

	/** One viewer pass on device B: discover the candidate, then apply the completion. */
	async function syncDeviceB() {
		step += 1;
		const now = new Date(Date.parse(NOW) + step * 60_000).toISOString();
		const [candidate] = discoverLegacyTeamCandidates(deviceB, discoveryOptions("device-b", now));
		await applyLegacyTeamSetupCompletionManifest(deviceB, {
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			freshRoster: ROSTER,
			manifest,
		});
		const [after] = discoverLegacyTeamCandidates(deviceB, discoveryOptions("device-b", now));
		return { before: candidate?.status, after: after?.status, ...teamState(deviceB) };
	}

	beforeEach(() => {
		step = 0;
		deviceA = new Database(":memory:");
		deviceB = new Database(":memory:");
		seedDevice(deviceA);
		seedDevice(deviceB);
		manifest = finishOnDeviceA(deviceA);
	});

	afterEach(() => {
		deviceA.close();
		deviceB.close();
	});

	it("maps both Projects on the device that finished setup", () => {
		expect(manifest.project_mappings.map((mapping) => mapping.scope_id).toSorted()).toEqual([
			SPACES.personal,
			SPACES.work,
		]);
	});

	it("applies on a device outside one Space and shares only the visible Project", async () => {
		setSpace(deviceB, SPACES.personal, "archived");

		await expect(syncDeviceB()).resolves.toMatchObject({
			after: "ready",
			team: { status: "active", migration_state: "completed" },
			shared: [WORK],
		});
		await expect(syncDeviceB()).resolves.toMatchObject({ after: "ready", shared: [WORK] });
	});

	it("adds the Project when the device joins its Space later", async () => {
		setSpace(deviceB, SPACES.personal, "archived");
		await syncDeviceB();

		setSpace(deviceB, SPACES.personal, "active");

		await expect(syncDeviceB()).resolves.toMatchObject({
			after: "ready",
			team: { status: "active" },
			shared: [PERSONAL, WORK].toSorted(),
		});
	});

	it("keeps the Team active when the device leaves a Space after setup", async () => {
		await expect(syncDeviceB()).resolves.toMatchObject({
			team: { status: "active" },
			shared: [PERSONAL, WORK].toSorted(),
		});

		setSpace(deviceB, SPACES.personal, "archived");

		await expect(syncDeviceB()).resolves.toMatchObject({
			after: "ready",
			team: { status: "active", migration_state: "completed" },
		});
	});

	it("asks for review again when a hidden Project is remapped into another Space", async () => {
		await syncDeviceB();
		setSpace(deviceB, SPACES.personal, "archived");
		deviceB
			.prepare(
				`INSERT INTO project_scope_mappings(
				 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
				 ) VALUES (?, ?, ?, 2000, 'user', ?, ?)`,
			)
			.run(PERSONAL, PERSONAL, SPACES.work, NOW, NOW);

		const [candidate] = discoverLegacyTeamCandidates(
			deviceB,
			discoveryOptions("device-b", "2026-09-01T13:00:00.000Z"),
		);

		expect(candidate?.status).not.toBe("ready");
	});

	it("repairs missing Team access only for Projects in Spaces the device can see", async () => {
		await syncDeviceB();
		setSpace(deviceB, SPACES.personal, "archived");
		deviceB
			.prepare(
				`UPDATE project_recipients SET status = 'revoked'
				 WHERE recipient_kind = 'team' AND recipient_id = ?`,
			)
			.run(TEAM_ID);

		discoverLegacyTeamCandidates(deviceB, discoveryOptions("device-b", "2026-09-01T13:00:00.000Z"));

		expect(
			deviceB
				.prepare(
					`SELECT canonical_project_identity, status, provenance FROM project_recipients
					 WHERE recipient_kind = 'team' AND recipient_id = ?
					 ORDER BY canonical_project_identity`,
				)
				.all(TEAM_ID),
		).toEqual([
			{ canonical_project_identity: WORK, status: "active", provenance: "reviewed_team_setup" },
			{
				canonical_project_identity: PERSONAL,
				status: "revoked",
				provenance: "reviewed_team_setup",
			},
		]);
	});

	it("keeps the Team active when the device can see none of its Spaces", async () => {
		await syncDeviceB();

		setSpace(deviceB, SPACES.work, "archived");
		setSpace(deviceB, SPACES.personal, "archived");

		await expect(syncDeviceB()).resolves.toMatchObject({
			after: "ready",
			team: { status: "active", migration_state: "completed" },
		});
	});

	it("applies when the device could never see any of the Team's Spaces", async () => {
		setSpace(deviceB, SPACES.work, "archived");
		setSpace(deviceB, SPACES.personal, "archived");

		await expect(syncDeviceB()).resolves.toMatchObject({
			after: "ready",
			team: { status: "active", migration_state: "completed" },
			shared: [],
		});
	});
});
