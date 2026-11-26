import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_ACCOUNT_PROFILE_SCHEMA_SQL } from "./coordinator-auth-account-profile-contract.js";
import {
	AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL,
	AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL,
} from "./coordinator-auth-lifecycle-schema.js";
import { COORDINATOR_DEVICE_OWNERSHIP_SCHEMA_SQL } from "./coordinator-device-ownership-schema.js";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import { discoverLegacyTeamCandidates } from "./legacy-team-candidate.js";
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
	legacyTeamDeviceRef,
} from "./recipient-policy-identifiers.js";
import {
	applyTeamMemberRemovals,
	isTeamMemberRemoved,
	type TeamMemberRemovalRecord,
} from "./team-member-removal-policy.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-09-01T12:00:00.000Z";
const COORDINATOR = "https://coordinator.example.invalid";
const GROUP = "group-recovery";
const CANDIDATE = legacyTeamCandidateId(COORDINATOR, GROUP);
const ROSTER = ["a", "b", "c", "excluded"].map((suffix, index) => ({
	deviceId: `device-${suffix}`,
	fingerprint: String(index + 1).repeat(64),
	displayName: `Laptop ${suffix}`,
	enabled: true,
}));
type Db = InstanceType<typeof Database>;

function addActor(db: Db, id: string, name = "Existing person", local = 0) {
	db.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
	 VALUES (?, ?, ?, 'active', ?, ?)`).run(id, name, local, NOW, NOW);
}

function createDb() {
	const db = new Database(":memory:");
	initTestSchema(db);
	db.exec(COORDINATOR_DEVICE_OWNERSHIP_SCHEMA_SQL);
	db.exec(AUTH_ACCOUNT_ASSOCIATION_TABLE_SQL);
	db.exec(AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL);
	db.exec(AUTH_ACCOUNT_PROFILE_SCHEMA_SQL);
	addActor(db, "identity-a", "Self", 1);
	return db;
}

function discover(db: Db, deviceId = "device-a") {
	return discoverLegacyTeamCandidates(db, {
		projection: { localActorId: "identity-a", localDeviceId: deviceId },
		groups: [
			{ coordinatorId: COORDINATOR, groupId: GROUP, displayName: "Recovery Team", devices: ROSTER },
		],
		now: NOW,
	});
}

function reviewedManifest(db: Db, options: { legacyEvidence?: boolean } = {}) {
	discover(db);
	let draft = getLegacyTeamSetupDraft(db, CANDIDATE);
	if (!draft) throw new Error("Missing source draft");
	for (const device of draft.devices) {
		const rosterDevice = ROSTER.find(
			(row) => legacyTeamDeviceRef(CANDIDATE, row.deviceId) === device.deviceRef,
		);
		if (!rosterDevice) throw new Error("Missing source roster device");
		const suffix = rosterDevice.deviceId.replace("device-", "");
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: `identity-${suffix}`,
			expectation: device.expectation,
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			decision: suffix === "excluded" ? "excluded" : "included",
			now: NOW,
		});
	}
	// Preserve the uploader's self evidence and every remote label.
	db.prepare(`UPDATE legacy_team_setup_draft_devices SET identity_evidence = CASE
	 WHEN device_id = 'device-a' THEN 'self' ELSE 'label' END
	 WHERE attempt_id = ?`).run(draft.attemptId);
	if (options.legacyEvidence)
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET identity_evidence = NULL WHERE attempt_id = ?",
		).run(draft.attemptId);
	return deriveLegacyTeamSetupCompletionManifest(db, {
		candidateRef: CANDIDATE,
		attemptId: draft.attemptId,
		completedAt: NOW,
	});
}

function recoveryState(db: Db) {
	return [
		"actors",
		"policy_teams",
		"policy_team_memberships",
		"legacy_team_setup_drafts",
		"legacy_team_setup_draft_devices",
		"identity_devices",
		"legacy_team_setup_completions",
	].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

let source: Db;
let target: Db;
let manifest: CoordinatorLegacyTeamCompletionManifestV1;
const apply = (db: Db, overrides = {}) =>
	applyLegacyTeamSetupCompletionManifest(db, {
		coordinatorId: COORDINATOR,
		groupId: GROUP,
		freshRoster: ROSTER,
		manifest,
		...overrides,
	});

beforeEach(async () => {
	source = createDb();
	target = createDb();
	for (const suffix of ["b", "c", "excluded"]) addActor(source, `identity-${suffix}`);
	manifest = reviewedManifest(source);
	await apply(source);
	expect(discover(source)[0]?.status).toBe("ready");
	discover(target, "device-fresh");
});
afterEach(() => {
	source.close();
	target.close();
});

const TEAM = deterministicPolicyTeamId(CANDIDATE);

function removal(identityId: string, overrides: Partial<TeamMemberRemovalRecord> = {}) {
	return {
		group_id: GROUP,
		team_id: TEAM,
		identity_id: identityId,
		removal_seq: 7,
		removed_at: NOW,
		removed_by_device_id: "device-a",
		...overrides,
	};
}

const remove = (db: Db, ...removals: TeamMemberRemovalRecord[]) =>
	applyTeamMemberRemovals(db, { coordinatorId: COORDINATOR, groupId: GROUP, removals, now: NOW });

function memberships(db: Db) {
	return db
		.prepare(
			"SELECT identity_id, status FROM policy_team_memberships WHERE team_id = ? ORDER BY identity_id",
		)
		.all(TEAM);
}

describe("recording a Team member removal on this machine", () => {
	it("revokes the removed membership and keeps every other member", () => {
		const result = remove(source, removal("identity-c"));

		expect(result).toEqual({ recorded: 1, revoked: [{ teamId: TEAM, identityId: "identity-c" }] });
		expect(memberships(source)).toEqual([
			{ identity_id: "identity-a", status: "reviewed_active" },
			{ identity_id: "identity-b", status: "reviewed_active" },
			{ identity_id: "identity-c", status: "revoked" },
		]);
		expect(isTeamMemberRemoved(source, TEAM, "identity-c")).toBe(true);
		expect(isTeamMemberRemoved(source, TEAM, "identity-b")).toBe(false);
	});

	it("wakes the Team's shared Projects while the membership still selects them", () => {
		const project = "https://git.example.invalid/team/project.git";
		source
			.prepare(`INSERT INTO project_recipients(canonical_project_identity, recipient_kind, recipient_id,
			 status, provenance, policy_revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES (?, 'team', ?, 'active', 'fixture', 'r1', 'completed', 'fixture-recipient', ?, ?)`)
			.run(project, TEAM, NOW, NOW);
		source
			.prepare(`INSERT INTO recipient_policy_authority_states(canonical_project_identity,
			 state_changed_at, created_at, updated_at) VALUES (?, ?, ?, ?)`)
			.run(project, NOW, NOW, NOW);
		const epoch = () =>
			source
				.prepare(
					"SELECT wake_epoch FROM recipient_policy_authority_states WHERE canonical_project_identity = ?",
				)
				.pluck()
				.get(project);
		const before = epoch() as number;

		remove(source, removal("identity-c"));

		expect(epoch()).toBe(before + 1);
	});

	it("writes nothing more when the same removal arrives again", () => {
		remove(source, removal("identity-c"));
		const before = recoveryState(source);

		expect(remove(source, removal("identity-c", { removal_seq: 9 }))).toEqual({
			recorded: 0,
			revoked: [],
		});
		expect(recoveryState(source)).toEqual(before);
	});

	it("refuses a list with a malformed record or one from another group and changes nothing", () => {
		const before = recoveryState(source);
		for (const bad of [
			removal("identity-c", { group_id: "other-group" }),
			removal(" identity-c"),
			removal("identity-c", { removal_seq: 0 }),
		])
			expect(() => remove(source, removal("identity-b"), bad)).toThrow(
				"team_member_removal_invalid",
			);
		expect(recoveryState(source)).toEqual(before);
		expect(isTeamMemberRemoved(source, TEAM, "identity-b")).toBe(false);
	});

	it("keeps a completed Team ready after a member is removed", () => {
		remove(source, removal("identity-c"));

		expect(discover(source)[0]?.status).toBe("ready");
	});
});

describe("a Team setup never restores a removed member", () => {
	it("keeps the member removed when this machine applies the completed setup again", async () => {
		remove(source, removal("identity-c"));

		await apply(source);

		expect(memberships(source)).toContainEqual({ identity_id: "identity-c", status: "revoked" });
		expect(discover(source)[0]?.status).toBe("ready");
	});

	it("never adds the removed member on another admin device that applies the setup afterwards", async () => {
		remove(target, removal("identity-c"));

		await apply(target);

		expect(memberships(target)).toEqual([
			{ identity_id: "identity-a", status: "reviewed_active" },
			{ identity_id: "identity-b", status: "reviewed_active" },
		]);
		expect(discover(target, "device-fresh")[0]?.status).toBe("ready");
	});

	it("revokes an active membership of a removed person when another admin device applies the setup", async () => {
		// The removal is known here while an invitation-owned membership is still active.
		addActor(target, "identity-c");
		target
			.prepare(`INSERT INTO policy_team_memberships(team_id, identity_id, role, status, provenance,
			 revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES (?, 'identity-c', 'member', 'active', 'team_invite', 'r1', 'user_managed', 'invite-c', ?, ?)`)
			.run(TEAM, NOW, NOW);
		target
			.prepare(`INSERT INTO policy_team_member_removals(team_id, identity_id, coordinator_id,
			 group_id, removal_seq, removed_at, removed_by_device_id, recorded_at)
			 VALUES (?, 'identity-c', ?, ?, 1, ?, NULL, ?)`)
			.run(TEAM, COORDINATOR, GROUP, NOW, NOW);

		await apply(target);

		expect(memberships(target)).toContainEqual({ identity_id: "identity-c", status: "revoked" });
		expect(discover(target, "device-fresh")[0]?.status).toBe("ready");
	});

	it("does not report the Team ready while a removed person's devices still receive its Projects", () => {
		source
			.prepare(`INSERT INTO policy_team_member_removals(team_id, identity_id, coordinator_id,
			 group_id, removal_seq, removed_at, removed_by_device_id, recorded_at)
			 VALUES (?, 'identity-c', ?, ?, 1, ?, NULL, ?)`)
			.run(TEAM, COORDINATOR, GROUP, NOW, NOW);

		expect(discover(source)[0]?.status).not.toBe("ready");
	});

	it("revokes the member on another admin device that learns of the removal after applying the setup", async () => {
		await apply(target);

		remove(target, removal("identity-c"));
		await apply(target);

		expect(memberships(target)).toContainEqual({ identity_id: "identity-c", status: "revoked" });
		expect(discover(target, "device-fresh")[0]?.status).toBe("ready");
	});
});
