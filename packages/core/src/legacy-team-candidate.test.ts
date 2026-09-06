import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listLegacyRecipientPolicyProjections } from "./legacy-recipient-policy-projection.js";
import {
	type DiscoverLegacyTeamCandidatesOptions,
	discoverLegacyTeamCandidates,
	isLegacyTeamCandidateSelectable,
	legacyTeamCandidateProjectInventory,
	refreshLegacyTeamCandidate,
} from "./legacy-team-candidate.js";
import { isFilesystemRootProjectIdentity } from "./legacy-team-project-policy.js";

describe("filesystem-root Project identities", () => {
	it.each([
		"/",
		"C:\\",
		"D:/",
		"//server/share",
		"file:///",
		"file:///C:/",
		"file://server/share",
		"file://server/share/",
		"file:////server/share",
	])("rejects %s", (identity) => {
		expect(isFilesystemRootProjectIdentity(identity)).toBe(true);
	});

	it.each([
		"/workspace/repo",
		"C:\\workspace\\repo",
		"//server/share/repo",
		"file://server/share/repo",
		"file:///C:/workspace/repo",
		"codemem",
	])("keeps %s", (identity) => {
		expect(isFilesystemRootProjectIdentity(identity)).toBe(false);
	});
});

import { latestLegacyTeamSetupAttempt } from "./legacy-team-setup-attempt.js";
import { getLegacyTeamSetupDraft } from "./legacy-team-setup-draft.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "./recipient-policy-identifiers.js";
import { canonicalWorkspaceIdentity } from "./scope-resolution.js";
import { shareProjectSetDigest } from "./share-operation.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-21T12:00:00.000Z";
const PROJECT_ID = "https://git.example.invalid/acme/api.git";

function options(
	fingerprint = "key-a",
	displayName = "Laptop",
): DiscoverLegacyTeamCandidatesOptions {
	return {
		projection: { localActorId: "actor-local", localDeviceId: "device-local" },
		groups: [
			{
				coordinatorId: "coordinator-private",
				groupId: "group-private",
				displayName: "Engineering",
				devices: [
					{
						deviceId: "device-a",
						fingerprint,
						displayName,
						enabled: true,
					},
				],
			},
		],
		now: NOW,
	};
}

function seedCandidateFixture(targetDb: InstanceType<typeof Database>): void {
	initTestSchema(targetDb);
	targetDb
		.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('actor-local', 'Local Person', 1, 'active', ?, ?)`,
		)
		.run(NOW, NOW);
	targetDb
		.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-api', 'Engineering', 'team', 'coordinator',
			 'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		)
		.run(NOW, NOW);
	targetDb
		.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-api', 1000, 'test', ?, ?)`,
		)
		.run(PROJECT_ID, PROJECT_ID, NOW, NOW);
	const sessionId = Number(
		targetDb
			.prepare(
				`INSERT INTO sessions(started_at, project, git_remote, git_branch)
				 VALUES (?, 'api', ?, 'main')`,
			)
			.run(NOW, PROJECT_ID).lastInsertRowid,
	);
	targetDb
		.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at,
				visibility, project, scope_id
			 ) VALUES (?, 'discovery', 'api', 'body', 1, ?, ?, 'shared', 'api', 'scope-api')`,
		)
		.run(sessionId, NOW, NOW);
}

describe("legacy Team candidate discovery", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		seedCandidateFixture(db);
	});

	afterEach(() => db.close());

	it("discovers configured candidates and persists their Project inventory", () => {
		const [candidate] = discoverLegacyTeamCandidates(db, options());

		expect(candidate).toMatchObject({
			displayName: "Engineering",
			status: "needs_setup",
			deviceCount: 1,
			projectCount: 1,
		});
		expect(candidate?.candidateRef).not.toContain("coordinator-private");
		expect(candidate?.candidateRef).not.toContain("group-private");
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_draft_projects").pluck().get()).toBe(
			1,
		);
	});

	it("keeps the synthetic shared fallback outside Team setup inventory", () => {
		const sessionId = Number(
			db
				.prepare(
					`INSERT INTO sessions(started_at, project, git_remote, git_branch)
					 VALUES (?, 'legacy shared', NULL, NULL)`,
				)
				.run(NOW).lastInsertRowid,
		);
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at,
				visibility, workspace_id, project, scope_id
			 ) VALUES (?, 'discovery', 'legacy shared', 'body', 1, ?, ?,
				'shared', 'shared:default', 'legacy shared', 'scope-api')`,
		).run(sessionId, NOW, NOW);

		const [candidate] = discoverLegacyTeamCandidates(db, options());

		expect(candidate?.projectCount).toBe(1);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) FROM legacy_team_setup_draft_projects WHERE source_project_identity = 'shared:default'",
				)
				.pluck()
				.get(),
		).toBe(0);
	});

	it("rejects malformed discovery identities without hiding independent valid groups", () => {
		const input = options();
		const validGroup = input.groups[0];
		if (!validGroup) throw new Error("invalid test fixture");
		input.groups = [
			{
				...validGroup,
				coordinatorId: " coordinator-padded",
				groupId: "group-padded-coordinator",
				displayName: "Padded coordinator",
			},
			{
				...validGroup,
				coordinatorId: "coordinator-control-group",
				groupId: "group-control\n",
				displayName: "Control group",
			},
			{
				...validGroup,
				coordinatorId: "coordinator-malformed-roster",
				groupId: "group-malformed-roster",
				displayName: "Malformed roster",
				devices: [
					...validGroup.devices,
					{
						deviceId: "device-padded ",
						fingerprint: "key-padded",
						displayName: "Padded device",
						enabled: true,
					},
				],
			},
			validGroup,
		];

		const candidates = discoverLegacyTeamCandidates(db, input);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.displayName).toBe("Engineering");
		expect(
			latestLegacyTeamSetupAttempt(
				db,
				legacyTeamCandidateId("coordinator-private", "group-private"),
			)?.candidateId,
		).toBe(candidates[0]?.candidateRef);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
	});

	it.each([
		["device ID", (device: { deviceId: string }) => (device.deviceId = "device-\u200B-a")],
		["fingerprint", (device: { fingerprint: string }) => (device.fingerprint = "key-\u200B-a")],
	] as const)("rejects refresh with a malformed roster %s before writes", (_label, mutate) => {
		const initialOptions = options();
		const [candidate] = discoverLegacyTeamCandidates(db, initialOptions);
		const candidateRef = candidate?.candidateRef as string;
		const initialDraft = db
			.prepare(
				`SELECT attempt_id, updated_at FROM legacy_team_setup_drafts
				 WHERE candidate_id = ?`,
			)
			.get(candidateRef);
		const malformedOptions = options();
		const malformedGroup = malformedOptions.groups[0];
		const malformedDevice = malformedGroup?.devices[0];
		if (!malformedGroup || !malformedDevice) throw new Error("invalid test fixture");
		mutate(malformedDevice);

		expect(() => refreshLegacyTeamCandidate(db, malformedOptions, candidateRef)).toThrow(
			"legacy_team_setup_roster_conflict",
		);
		expect(
			db
				.prepare(
					`SELECT attempt_id, updated_at FROM legacy_team_setup_drafts
					 WHERE candidate_id = ?`,
				)
				.get(candidateRef),
		).toEqual(initialDraft);
		expect(
			db.prepare("SELECT device_id FROM legacy_team_setup_draft_devices").pluck().all(),
		).toEqual(["device-a"]);
	});

	it("skips an oversized group without aborting other candidate discovery", () => {
		const input = options();
		input.groups.unshift({
			coordinatorId: "coordinator-oversized",
			groupId: "group-oversized",
			displayName: "Oversized",
			devices: Array.from({ length: 501 }, (_, index) => ({
				deviceId: `oversized-device-${index}`,
				fingerprint: `oversized-key-${index}`,
				displayName: `Oversized Device ${index}`,
				enabled: true,
			})),
		});

		const candidates = discoverLegacyTeamCandidates(db, input);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.displayName).toBe("Engineering");
		expect(
			latestLegacyTeamSetupAttempt(
				db,
				legacyTeamCandidateId("coordinator-private", "group-private"),
			)?.candidateId,
		).toBe(candidates[0]?.candidateRef);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
	});

	it("skips oversized existing candidates before changing their state", () => {
		const initial = options();
		const [candidate] = discoverLegacyTeamCandidates(db, initial);
		const oversized = options();
		const [oversizedGroup] = oversized.groups;
		if (!oversizedGroup) throw new Error("test_fixture_missing_group");
		oversizedGroup.devices = Array.from({ length: 501 }, (_, index) => ({
			deviceId: `oversized-device-${index}`,
			fingerprint: `oversized-key-${index}`,
			displayName: `Oversized Device ${index}`,
			enabled: true,
		}));

		expect(discoverLegacyTeamCandidates(db, oversized)).toEqual([]);
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE candidate_id = ?")
				.pluck()
				.get(candidate?.candidateRef),
		).toBe("needs_setup");

		db.prepare("UPDATE legacy_team_setup_drafts SET state = 'stale'").run();

		expect(discoverLegacyTeamCandidates(db, oversized)).toEqual([]);
		expect(db.prepare("SELECT state FROM legacy_team_setup_drafts").pluck().get()).toBe("stale");
	});

	it("rejects oversized single-candidate refreshes before assignment reads", () => {
		const input = options();
		const [group] = input.groups;
		if (!group) throw new Error("test_fixture_missing_group");
		group.devices = Array.from({ length: 501 }, (_, index) => ({
			deviceId: `oversized-device-${index}`,
			fingerprint: `oversized-key-${index}`,
			displayName: `Oversized Device ${index}`,
			enabled: true,
		}));
		const prepare = vi.spyOn(db, "prepare");
		try {
			expect(() =>
				refreshLegacyTeamCandidate(
					db,
					input,
					legacyTeamCandidateId(group.coordinatorId, group.groupId),
				),
			).toThrow("legacy_team_setup_roster_too_large");
			expect(
				prepare.mock.calls.some(([sql]) =>
					String(sql).includes("SELECT identity_id FROM identity_devices"),
				),
			).toBe(false);
			expect(
				latestLegacyTeamSetupAttempt(db, legacyTeamCandidateId(group.coordinatorId, group.groupId)),
			).toBeNull();
			expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(0);
		} finally {
			prepare.mockRestore();
		}
	});

	it("bounds assignment statement preparation for multi-device candidate authority", () => {
		const input = options();
		const group = input.groups[0];
		if (!group) throw new Error("test_fixture_missing_group");
		group.devices = Array.from({ length: 8 }, (_, index) => ({
			deviceId: `device-${index}`,
			fingerprint: `key-${index}`,
			displayName: `Device ${index}`,
			enabled: true,
		}));
		const prepare = vi.spyOn(db, "prepare");
		try {
			const [candidate] = discoverLegacyTeamCandidates(db, input);

			expect(candidate?.deviceCount).toBe(8);
			expect(
				prepare.mock.calls.filter(([sql]) =>
					/^\s*SELECT identity_id FROM identity_devices\s+WHERE device_id/u.test(String(sql)),
				),
			).toHaveLength(1);
		} finally {
			prepare.mockRestore();
		}
	});

	it("retains coordinator-backed ambiguous Projects without exposing public Team intent", () => {
		const sessionId = Number(
			db
				.prepare(
					`INSERT INTO sessions(started_at, project, git_branch)
					 VALUES (?, 'unmapped-api', 'main')`,
				)
				.run(NOW).lastInsertRowid,
		);
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at,
				visibility, project, scope_id
			 ) VALUES (?, 'discovery', 'unmapped', 'body', 1, ?, ?, 'shared',
			 'unmapped-api', 'scope-api')`,
		).run(sessionId, NOW, NOW);

		const projections = listLegacyRecipientPolicyProjections(db, options().projection);
		const ambiguous = projections.find((projection) =>
			projection.project.canonicalIdentity.startsWith("unmapped:"),
		);
		const [candidate] = discoverLegacyTeamCandidates(db, options());

		expect(ambiguous).toMatchObject({
			teamCandidates: [],
			enforcement: { state: "ambiguous" },
		});
		expect(candidate).toMatchObject({ projectCount: 2, unresolvedProjectCount: 1 });
		expect(
			db
				.prepare(
					`SELECT resolution_kind FROM legacy_team_setup_draft_projects
					 WHERE source_project_identity LIKE 'unmapped:%'`,
				)
				.pluck()
				.get(),
		).toBe("unresolved");
	});

	it("does not stale a candidate for display-only roster changes", () => {
		const [first] = discoverLegacyTeamCandidates(db, options());
		const firstAttempt = latestLegacyTeamSetupAttempt(db, first?.candidateRef as string);
		expect(firstAttempt).not.toBeNull();
		if (!firstAttempt) throw new Error("initial display-change attempt missing");
		const [second] = discoverLegacyTeamCandidates(db, options("key-a", "Renamed Laptop"));

		expect(second?.status).toBe("needs_setup");
		expect(second?.candidateRef).toBe(first?.candidateRef);
		expect(latestLegacyTeamSetupAttempt(db, second?.candidateRef as string)?.attemptId).toBe(
			firstAttempt.attemptId,
		);
	});

	it("keeps configured groups discoverable without displayed Projects", () => {
		db.prepare("DELETE FROM memory_items").run();
		db.prepare("DELETE FROM sessions").run();
		db.prepare("DELETE FROM project_scope_mappings").run();

		const [candidate] = discoverLegacyTeamCandidates(db, options());

		expect(candidate).toMatchObject({
			displayName: "Engineering",
			status: "needs_setup",
			deviceCount: 1,
			projectCount: 0,
			unresolvedProjectCount: 0,
		});
		expect(
			refreshLegacyTeamCandidate(db, options(), candidate?.candidateRef as string).attemptId,
		).toBeTruthy();
	});

	it("reports Ready for a completed group with no Projects and no local scope", () => {
		db.prepare("DELETE FROM memory_items").run();
		db.prepare("DELETE FROM sessions").run();
		db.prepare("DELETE FROM project_scope_mappings").run();
		db.prepare("DELETE FROM replication_scopes").run();
		const [initial] = discoverLegacyTeamCandidates(db, options());
		const draft = db
			.prepare(
				`SELECT attempt_id, candidate_id, roster_fingerprint
				 FROM legacy_team_setup_drafts WHERE candidate_id = ?`,
			)
			.get(initial?.candidateRef) as {
			attempt_id: string;
			candidate_id: string;
			roster_fingerprint: string;
		};
		const teamId = deterministicPolicyTeamId(draft.candidate_id);
		db.prepare(
			`INSERT INTO policy_teams(
				team_id, display_name, status, device_eligibility_mode, provenance,
				revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Engineering', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
				'revision-1', 'completed', ?, 'team-setup-test', ?, ?)`,
		).run(teamId, draft.roster_fingerprint, NOW, NOW);
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(teamId, NOW, NOW, draft.attempt_id);

		// An empty Project inventory has no confirmed mapping whose scope could
		// drift, so completion must stay Ready instead of being replaced with a
		// fresh needs_setup attempt on every discovery pass.
		expect(discoverLegacyTeamCandidates(db, options())[0]).toMatchObject({
			projectCount: 0,
			status: "ready",
		});
		expect(latestLegacyTeamSetupAttempt(db, draft.candidate_id)?.attemptId).toBe(draft.attempt_id);
	});

	it("does not stale a candidate when a scope label changes", () => {
		const [first] = discoverLegacyTeamCandidates(db, options());
		const firstAttempt = latestLegacyTeamSetupAttempt(db, first?.candidateRef as string);
		expect(firstAttempt).not.toBeNull();
		if (!firstAttempt) throw new Error("initial scope-label attempt missing");
		db.prepare("UPDATE replication_scopes SET label = 'Renamed Engineering'").run();

		const [second] = discoverLegacyTeamCandidates(db, options());

		expect(second?.status).toBe("needs_setup");
		expect(second?.candidateRef).toBe(first?.candidateRef);
		expect(latestLegacyTeamSetupAttempt(db, second?.candidateRef as string)?.attemptId).toBe(
			firstAttempt.attemptId,
		);
	});

	it("replaces changed roster evidence during discovery", () => {
		const [first] = discoverLegacyTeamCandidates(db, options());
		const firstAttempt = latestLegacyTeamSetupAttempt(db, first?.candidateRef as string);
		expect(firstAttempt).not.toBeNull();
		if (!firstAttempt) throw new Error("initial refresh attempt missing");
		const [refreshedCandidate] = discoverLegacyTeamCandidates(db, options("key-b"));

		expect(refreshedCandidate?.status).toBe("needs_setup");
		const refreshed = getLegacyTeamSetupDraft(db, first?.candidateRef as string);
		expect(refreshed).not.toBeNull();
		if (!refreshed) throw new Error("replacement attempt missing");
		expect(refreshed.state).toBe("needs_setup");
		expect(latestLegacyTeamSetupAttempt(db, first?.candidateRef as string)?.attemptId).toBe(
			refreshed.attemptId,
		);
		expect(refreshed.attemptId).not.toBe(firstAttempt.attemptId);
		expect(
			db
				.prepare("SELECT attempt_id FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(firstAttempt.attemptId),
		).toBe(firstAttempt.attemptId);
	});

	it("replaces an activation-staled attempt during discovery", () => {
		const [candidate] = discoverLegacyTeamCandidates(db, options());
		const firstAttempt = latestLegacyTeamSetupAttempt(db, candidate?.candidateRef as string);
		if (!firstAttempt) throw new Error("initial attempt missing");
		db.prepare("UPDATE legacy_team_setup_drafts SET state = 'stale' WHERE attempt_id = ?").run(
			firstAttempt.attemptId,
		);

		const [rediscovered] = discoverLegacyTeamCandidates(db, options());
		const replacement = latestLegacyTeamSetupAttempt(db, candidate?.candidateRef as string);
		const historical = db
			.prepare("SELECT state, superseded_at FROM legacy_team_setup_drafts WHERE attempt_id = ?")
			.get(firstAttempt.attemptId);

		expect(rediscovered?.status).toBe("needs_setup");
		expect(replacement?.attemptId).not.toBe(firstAttempt.attemptId);
		expect(historical).toEqual({ state: "stale", superseded_at: NOW });
	});

	it.each([
		["first replacement", false],
		["subsequent replacement", true],
	] as const)("sanitizes labels for a %s", (_label, replaceFirst) => {
		const initialOptions = options("key-a", "api");
		const initialGroup = initialOptions.groups[0];
		if (!initialGroup) throw new Error("invalid test fixture");
		initialGroup.displayName = "api";
		const [initial] = discoverLegacyTeamCandidates(db, initialOptions);
		const attemptId = latestLegacyTeamSetupAttempt(db, initial?.candidateRef as string)?.attemptId;
		if (!attemptId) throw new Error("initial sanitization attempt missing");
		expect(getLegacyTeamSetupDraft(db, initial?.candidateRef as string)).toMatchObject({
			displayName: "api",
			devices: [{ displayName: "api" }],
			projects: [{ displayName: "api" }],
		});

		if (replaceFirst) {
			const replacementOptions = options("key-b", "api");
			const replacementGroup = replacementOptions.groups[0];
			if (!replacementGroup) throw new Error("invalid test fixture");
			replacementGroup.displayName = "api";
			expect(discoverLegacyTeamCandidates(db, replacementOptions)[0]?.status).toBe("needs_setup");
		}

		const changedOptions = options(replaceFirst ? "key-b" : "key-a", "api");
		const changedGroup = changedOptions.groups[0];
		if (!changedGroup) throw new Error("invalid test fixture");
		changedGroup.displayName = "api";
		changedGroup.devices = [
			{ deviceId: "api", fingerprint: "key-new", displayName: "New Device", enabled: true },
		];
		db.prepare("DELETE FROM memory_items").run();
		db.prepare("DELETE FROM sessions").run();
		db.prepare("DELETE FROM project_scope_mappings").run();

		const [replacement] = discoverLegacyTeamCandidates(db, changedOptions);
		const replacementDraft = getLegacyTeamSetupDraft(db, initial?.candidateRef as string);

		expect(replacement).toMatchObject({ displayName: "Legacy Team", status: "needs_setup" });
		expect(replacementDraft).toMatchObject({
			state: "needs_setup",
			displayName: "Legacy Team",
			projects: [],
		});
		expect(replacementDraft?.devices.map((device) => device.displayName)).toEqual([
			"New Device",
			"Removed device",
		]);
		expect(replacementDraft?.attemptId).not.toBe(attemptId);
	});

	it("creates a fresh attempt if roster evidence reverts", () => {
		const [first] = discoverLegacyTeamCandidates(db, options());
		const firstAttempt = latestLegacyTeamSetupAttempt(db, first?.candidateRef as string);
		expect(firstAttempt).not.toBeNull();
		if (!firstAttempt) throw new Error("initial stale-reversion attempt missing");
		discoverLegacyTeamCandidates(db, options("key-b"));
		const changedAttempt = latestLegacyTeamSetupAttempt(db, first?.candidateRef as string);

		const [reverted] = discoverLegacyTeamCandidates(db, options("key-a"));

		expect(reverted?.status).toBe("needs_setup");
		const revertedAttempt = latestLegacyTeamSetupAttempt(db, reverted?.candidateRef as string);
		expect(revertedAttempt?.attemptId).not.toBe(firstAttempt.attemptId);
		expect(revertedAttempt?.attemptId).not.toBe(changedAttempt?.attemptId);
	});

	it("reconciles a missing setup-owned Project edge for a compatible completion", () => {
		const [initial] = discoverLegacyTeamCandidates(db, options());
		const draft = db
			.prepare(
				`SELECT attempt_id, candidate_id, roster_fingerprint
				 FROM legacy_team_setup_drafts WHERE candidate_id = ?`,
			)
			.get(initial?.candidateRef) as {
			attempt_id: string;
			candidate_id: string;
			roster_fingerprint: string;
		};
		const completedTeamId = deterministicPolicyTeamId(draft.candidate_id);
		db.prepare(
			`INSERT INTO policy_teams(
				team_id, display_name, status, device_eligibility_mode, provenance,
				revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Engineering', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
				'revision-1', 'completed', ?, 'team-setup-test', ?, ?)`,
		).run(completedTeamId, draft.roster_fingerprint, NOW, NOW);

		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");

		db.prepare(
			`INSERT INTO project_recipients(
				canonical_project_identity, recipient_kind, recipient_id, status, provenance,
				policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'revision-1', 'completed',
				'ready-edge', ?, ?)`,
		).run(PROJECT_ID, completedTeamId, NOW, NOW);
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(completedTeamId, NOW, NOW, draft.attempt_id);

		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance,
			 revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES ('team-independent', 'Independent', 'active', 'reviewed_allowlist', 'user',
			 'independent-r1', 'user_managed', 'independent-team', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', 'team-independent', 'active', 'review_resolution',
			 'independent-r1', 'user_managed', 'independent-edge', ?, ?)`,
		).run(PROJECT_ID, NOW, NOW);
		const independentEdge = db
			.prepare("SELECT * FROM project_recipients WHERE recipient_id = 'team-independent'")
			.get();

		// Older completions may predate Project edge materialization. A setup-owned
		// missing edge is restored once, without reopening an otherwise compatible Team.
		db.prepare("DELETE FROM project_recipients WHERE recipient_id = ?").run(completedTeamId);
		const supersedingAttemptId = "legacy-team-attempt:00000000-0000-4000-8000-000000000099";
		db.prepare(
			`INSERT INTO legacy_team_setup_drafts(
			 attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
			 roster_fingerprint, projection_fingerprint, created_at, updated_at
			 ) SELECT ?, candidate_id, coordinator_id, group_id, 'needs_setup', display_name,
			 'superseding-roster', 'superseding-projection', ?, ?
			 FROM legacy_team_setup_drafts WHERE attempt_id = ?`,
		).run(supersedingAttemptId, NOW, NOW, draft.attempt_id);
		const firstReconciliation = options();
		firstReconciliation.now = "2026-08-21T12:01:00.000Z";
		expect(discoverLegacyTeamCandidates(db, firstReconciliation)[0]?.status).toBe("ready");
		expect(
			db
				.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts WHERE candidate_id = ?")
				.pluck()
				.get(draft.candidate_id),
		).toBe(2);
		expect(
			db
				.prepare(
					"SELECT state, completed_team_id FROM legacy_team_setup_drafts WHERE attempt_id = ?",
				)
				.get(supersedingAttemptId),
		).toEqual({ state: "needs_setup", completed_team_id: null });
		expect(
			db
				.prepare(
					`SELECT status, provenance, updated_at FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
				)
				.get(PROJECT_ID, completedTeamId),
		).toEqual({
			status: "active",
			provenance: "reviewed_team_setup",
			updated_at: firstReconciliation.now,
		});
		expect(
			db.prepare("SELECT * FROM project_recipients WHERE recipient_id = 'team-independent'").get(),
		).toEqual(independentEdge);

		const replay = options();
		replay.now = "2026-08-21T12:02:00.000Z";
		expect(discoverLegacyTeamCandidates(db, replay)[0]?.status).toBe("ready");
		expect(
			db
				.prepare(
					`SELECT updated_at FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_id = ?`,
				)
				.pluck()
				.get(PROJECT_ID, completedTeamId),
		).toBe(firstReconciliation.now);

		db.prepare(
			`UPDATE project_recipients
			 SET status = 'revoked', provenance = 'review_resolution', policy_revision = 'user-r1',
			     migration_state = 'user_managed', source_fingerprint = 'user-source',
			     idempotency_key = 'user-edge', updated_at = '2026-08-21T12:03:00.000Z'
			 WHERE canonical_project_identity = ? AND recipient_id = ?`,
		).run(PROJECT_ID, completedTeamId);
		const userOwnedEdge = db
			.prepare(
				"SELECT * FROM project_recipients WHERE canonical_project_identity = ? AND recipient_id = ?",
			)
			.get(PROJECT_ID, completedTeamId);
		const unsafeReconciliation = options();
		unsafeReconciliation.now = "2026-08-21T12:04:00.000Z";
		expect(discoverLegacyTeamCandidates(db, unsafeReconciliation)[0]?.status).toBe("needs_setup");
		expect(
			db
				.prepare(
					"SELECT * FROM project_recipients WHERE canonical_project_identity = ? AND recipient_id = ?",
				)
				.get(PROJECT_ID, completedTeamId),
		).toEqual(userOwnedEdge);
	});

	it("stays Ready after an explicit Project resolution is materialized", () => {
		const webId = "https://git.example.invalid/acme/web.git";
		// A session without git remote/cwd/workspace canonicalizes to an
		// `unmapped:` identity — the shape explicit resolution exists for.
		const sessionId = Number(
			db.prepare(`INSERT INTO sessions(started_at, project) VALUES (?, 'web')`).run(NOW)
				.lastInsertRowid,
		);
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at,
				visibility, project, scope_id
			 ) VALUES (?, 'discovery', 'web', 'body', 1, ?, ?, 'shared', 'web', 'scope-api')`,
		).run(sessionId, NOW, NOW);
		const unmappedId = canonicalWorkspaceIdentity({ project: "web" }).value;
		const [initial] = discoverLegacyTeamCandidates(db, options());
		expect(initial?.projectCount).toBe(2);
		const draft = db
			.prepare(
				`SELECT attempt_id, candidate_id, roster_fingerprint
				 FROM legacy_team_setup_drafts WHERE candidate_id = ?`,
			)
			.get(initial?.candidateRef) as {
			attempt_id: string;
			candidate_id: string;
			roster_fingerprint: string;
		};
		const teamId = deterministicPolicyTeamId(draft.candidate_id);
		db.prepare(
			`INSERT INTO policy_teams(
				team_id, display_name, status, device_eligibility_mode, provenance,
				revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Engineering', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
				'revision-1', 'completed', ?, 'resolution-team', ?, ?)`,
		).run(teamId, draft.roster_fingerprint, NOW, NOW);
		for (const [key, projectId] of [
			["edge-api", PROJECT_ID],
			["edge-web", webId],
		] as const) {
			db.prepare(
				`INSERT INTO project_recipients(
					canonical_project_identity, recipient_kind, recipient_id, status, provenance,
					policy_revision, migration_state, idempotency_key, created_at, updated_at
				 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'revision-1', 'completed',
					?, ?, ?)`,
			).run(projectId, teamId, key, NOW, NOW);
		}
		db.prepare(
			`UPDATE legacy_team_setup_draft_projects
			 SET resolution_kind = 'explicit', resolved_project_identity = ?
			 WHERE attempt_id = ? AND source_project_identity = ?`,
		).run(webId, draft.attempt_id, unmappedId);
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(teamId, NOW, NOW, draft.attempt_id);
		// Activation materializes the reviewed resolution as a mapping from the
		// original identity to its target.
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-api', 1000, 'test', ?, ?)`,
		).run(webId, unmappedId, NOW, NOW);

		// The source identity collapses into its reviewed target, so the
		// completed attempt stays Ready instead of being replaced.
		expect(discoverLegacyTeamCandidates(db, options())[0]).toMatchObject({
			status: "ready",
			projectCount: 2,
		});
		expect(latestLegacyTeamSetupAttempt(db, draft.candidate_id)?.attemptId).toBe(draft.attempt_id);

		// A genuinely new Project drops the legacy Ready diagnostic without
		// superseding the terminal completion.
		const newSession = Number(
			db.prepare(`INSERT INTO sessions(started_at, project) VALUES (?, 'brand-new')`).run(NOW)
				.lastInsertRowid,
		);
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at,
				visibility, project, scope_id
			 ) VALUES (?, 'discovery', 'new', 'body', 1, ?, ?, 'shared', 'brand-new', 'scope-api')`,
		).run(newSession, NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
	});

	function completeCandidate(): { teamId: string; attemptId: string; candidateId: string } {
		const [initial] = discoverLegacyTeamCandidates(db, options());
		const draft = db
			.prepare(
				`SELECT attempt_id, candidate_id, roster_fingerprint
				 FROM legacy_team_setup_drafts WHERE candidate_id = ?`,
			)
			.get(initial?.candidateRef) as {
			attempt_id: string;
			candidate_id: string;
			roster_fingerprint: string;
		};
		const teamId = deterministicPolicyTeamId(draft.candidate_id);
		db.prepare(
			`INSERT INTO policy_teams(
				team_id, display_name, status, device_eligibility_mode, provenance,
				revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Engineering', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
				'revision-1', 'completed', ?, ?, ?, ?)`,
		).run(teamId, draft.roster_fingerprint, `team-${draft.attempt_id}`, NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
				canonical_project_identity, recipient_kind, recipient_id, status, provenance,
				policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'revision-1', 'completed',
				?, ?, ?)`,
		).run(PROJECT_ID, teamId, `edge-${draft.attempt_id}`, NOW, NOW);
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(teamId, NOW, NOW, draft.attempt_id);
		return { teamId, attemptId: draft.attempt_id, candidateId: draft.candidate_id };
	}

	it("drops Ready when a higher-priority mapping shadows the completion mapping", () => {
		completeCandidate();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		// The setup-created mapping still exists, but selection now resolves
		// the Project to a scope outside the coordinator group.
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-foreign', 9000, 'test', ?, ?)`,
		).run(PROJECT_ID, PROJECT_ID, NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
	});

	it("drops Ready when the selected mapping moves to another active scope in the group", () => {
		completeCandidate();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-api-second', 'Engineering Second', 'managed_project', 'coordinator',
			 'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);

		// Group membership alone is insufficient: completion reviewed scope-api.
		db.prepare("UPDATE project_scope_mappings SET scope_id = 'scope-api-second'").run();

		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
	});

	it("keeps Ready for a higher-priority exact mapping to the reviewed scope", () => {
		completeCandidate();
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, 'older-exact-pattern', 'scope-api', 9000, 'test', ?, ?)`,
		).run(PROJECT_ID, NOW, NOW);

		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");
	});

	it("drops Ready for malformed inactive membership identities", () => {
		const { teamId } = completeCandidate();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		// Authoritative eligibility applies the strict identifier rule to every
		// membership row regardless of status; readiness must match it.
		db.prepare(
			`INSERT INTO policy_team_memberships(
				team_id, identity_id, role, status, provenance, revision, migration_state,
				idempotency_key, created_at, updated_at
			 ) VALUES (?, ' identity-padded', 'member', 'pending', 'coordinator_invite',
				'r1', 'user_managed', 'padded-membership', ?, ?)`,
		).run(teamId, NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
	});

	it("drops Ready when a reviewed member gains a malformed device row", () => {
		const { teamId } = completeCandidate();
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-member', 'Member', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_memberships(
				team_id, identity_id, role, status, provenance, revision, migration_state,
				idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-member', 'member', 'reviewed_active', 'coordinator_invite',
				'r1', 'user_managed', 'member-membership', ?, ?)`,
		).run(teamId, NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		// Authoritative eligibility validates every device of every active
		// member; an unknown-status row blocks the whole Team, so Ready must
		// run the same pass instead of stopping at the person.
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-member-extra', 'identity-member', 'Extra', 'suspended', 'test',
				'r1', 'user_managed', 1, 'member-extra', ?, ?)`,
		).run(NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
	});

	it("bounds the assignment fan-out re-derived for a completed candidate", () => {
		// A one-device roster with one completed Project still re-derives
		// effective devices across every persisted assignment row, so a large
		// assignment table must trip the pair bound before that derivation runs.
		const { candidateId } = completeCandidate();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");
		const insertAssignment = db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-member', ?, 'revoked', 'test', 'r1', 'user_managed', 1, ?, ?, ?)`,
		);
		db.transaction(() => {
			for (let index = 0; index < 10_000; index += 1) {
				insertAssignment.run(
					`device-historical-${index}`,
					`Old ${index}`,
					`hist-${index}`,
					NOW,
					NOW,
				);
			}
		})();
		const derive = vi.spyOn(db, "prepare");
		try {
			expect(discoverLegacyTeamCandidates(db, options())).toEqual([]);
			expect(
				derive.mock.calls.some(([sql]) => String(sql).includes("FROM policy_team_memberships")),
			).toBe(false);
		} finally {
			derive.mockRestore();
		}
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE candidate_id = ?")
				.pluck()
				.get(candidateId),
		).toBe("completed");
	});

	it("still discovers a small new candidate alongside many unrelated assignments", () => {
		// The readiness fan-out bound only applies once a completed candidate's
		// compatibility derivation will run; a fresh candidate must not be
		// hidden by historical assignment rows it never traverses.
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-historical', 'Historical', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const insertAssignment = db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-historical', ?, 'revoked', 'test', 'r1', 'user_managed', 1, ?, ?, ?)`,
		);
		db.transaction(() => {
			for (let index = 0; index < 10_000; index += 1) {
				insertAssignment.run(
					`device-historical-${index}`,
					`Old ${index}`,
					`hist-${index}`,
					NOW,
					NOW,
				);
			}
		})();

		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
	});

	it("keeps a completed Team selectable when merged resolutions share one mapping", () => {
		const { teamId, attemptId, candidateId } = completeCandidate();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");
		// Exercise the full compatibility path used by completions created before
		// terminal migration provenance was introduced.
		db.prepare(
			"UPDATE policy_teams SET provenance = 'legacy_team_candidate' WHERE team_id = ?",
		).run(teamId);
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-api-second', 'Engineering Second', 'managed_project', 'coordinator',
			 'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);

		// A second confirmed source resolved to the same canonical identity:
		// selection can pick only one mapping, so Ready must accept the
		// authoritative pattern with that source's own confirmed target scope.
		db.prepare(
			`INSERT INTO legacy_team_setup_draft_projects(
				attempt_id, project_ref, source_project_identity, display_name,
				source_fingerprint, resolution_kind, resolved_project_identity, target_scope_id, updated_at
			 ) VALUES (?, 'project-ref-mirror', 'unmapped:mirror', 'Mirror', 'source-mirror',
			 'explicit', ?, 'scope-api', ?)`,
		).run(attemptId, PROJECT_ID, NOW);
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, 'unmapped:mirror', 'scope-api', 1000, 'reviewed_team_setup', ?, ?)`,
		).run(PROJECT_ID, NOW, NOW);
		expect(isLegacyTeamCandidateSelectable(db, candidateId)).toBe(true);

		// The other merged source targets scope-api-second, but that cannot
		// authorize moving the selected primary source away from scope-api.
		db.prepare("UPDATE project_scope_mappings SET scope_id = 'scope-api-second'").run();
		expect(isLegacyTeamCandidateSelectable(db, candidateId)).toBe(false);
	});

	it("rejects a legacy null-scope completion redirected to local authority", () => {
		const { teamId, attemptId, candidateId } = completeCandidate();
		// Exercise the compatibility gate for completions created before terminal
		// provenance markers, rather than the canonical completion fast path.
		db.prepare(
			"UPDATE policy_teams SET provenance = 'legacy_team_candidate' WHERE team_id = ?",
		).run(teamId);
		db.prepare(
			"UPDATE legacy_team_setup_draft_projects SET target_scope_id = NULL WHERE attempt_id = ?",
		).run(attemptId);
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-local-rogue', 'Local Rogue', 'team', 'local',
			 'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare("UPDATE project_scope_mappings SET scope_id = 'scope-local-rogue'").run();

		expect(isLegacyTeamCandidateSelectable(db, candidateId)).toBe(false);
	});

	it("recovers a legacy null-scope completion from its reviewed coordinator mapping", () => {
		const { teamId, attemptId, candidateId } = completeCandidate();
		db.prepare(
			"UPDATE policy_teams SET provenance = 'legacy_team_candidate' WHERE team_id = ?",
		).run(teamId);
		db.prepare(
			"UPDATE legacy_team_setup_draft_projects SET target_scope_id = NULL WHERE attempt_id = ?",
		).run(attemptId);

		expect(isLegacyTeamCandidateSelectable(db, candidateId)).toBe(true);
	});

	it("loads the current selectable draft in one authoritative query", () => {
		const { candidateId } = completeCandidate();
		const prepare = vi.spyOn(db, "prepare");
		try {
			expect(isLegacyTeamCandidateSelectable(db, candidateId)).toBe(true);
			const authorityReads = prepare.mock.calls
				.map(([sql]) => String(sql))
				.filter(
					(sql) =>
						sql.includes("FROM legacy_team_setup_drafts") && sql.includes("completed_team_id"),
				);
			expect(authorityReads).toHaveLength(1);
			expect(authorityReads[0]).toMatch(
				/WHERE draft\.candidate_id = \?.*ORDER BY draft\.rowid DESC LIMIT 1/su,
			);
			expect(authorityReads[0]).not.toMatch(/WHERE attempt_id = \?/u);
		} finally {
			prepare.mockRestore();
		}
	});

	it("does not revalidate completion-bound devices after migration", () => {
		const { teamId, attemptId, candidateId } = completeCandidate();
		const insertActor = db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES (?, ?, 0, 'active', ?, ?)`,
		);
		const insertMembership = db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'member', 'reviewed_active', 'reviewed_team_setup', 'r1',
			 'completed', ?, ?, ?)`,
		);
		const insertAssignment = db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision,
			 migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, ?, 'active', 'reviewed_team_setup', 'r1', 'completed', 1, ?, ?, ?)`,
		);
		const insertDraftDevice = db.prepare(
			`INSERT INTO legacy_team_setup_draft_devices(
			 attempt_id, device_id, device_ref, key_fingerprint, display_name, enabled,
			 decision, target_identity_id, updated_at
			 ) VALUES (?, ?, ?, ?, ?, 1, 'included', ?, ?)`,
		);
		const insertDecision = db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision, created_at, updated_at
			 ) VALUES (?, ?, 'included', 1, 'reviewed_team_setup', 'r1', ?, ?)`,
		);
		for (let index = 0; index < 8; index += 1) {
			const actorId = `identity-ready-${index}`;
			const deviceId = `device-ready-${index}`;
			insertActor.run(actorId, `Ready Person ${index}`, NOW, NOW);
			insertMembership.run(teamId, actorId, `membership-ready-${index}`, NOW, NOW);
			insertAssignment.run(
				deviceId,
				actorId,
				`Ready Device ${index}`,
				`assignment-ready-${index}`,
				NOW,
				NOW,
			);
			insertDraftDevice.run(
				attemptId,
				deviceId,
				`device-ref-ready-${index}`,
				`key-ready-${index}`,
				`Ready Device ${index}`,
				actorId,
				NOW,
			);
			insertDecision.run(teamId, deviceId, NOW, NOW);
		}
		const prepare = vi.spyOn(db, "prepare");
		try {
			expect(isLegacyTeamCandidateSelectable(db, candidateId)).toBe(true);
			expect(
				prepare.mock.calls.filter(([sql]) =>
					/SELECT identity_id, assignment_version FROM identity_devices\s+WHERE device_id/u.test(
						String(sql),
					),
				),
			).toHaveLength(0);
		} finally {
			prepare.mockRestore();
		}
	});

	it("drops Ready when a removed device keeps a granting invite decision", () => {
		const { teamId, attemptId } = completeCandidate();
		// Simulate a reviewed removal of an extra roster device.
		db.prepare(
			`INSERT INTO legacy_team_setup_draft_devices(
				attempt_id, device_id, device_ref, key_fingerprint, display_name, enabled,
				decision, updated_at
			 ) VALUES (?, 'device-removed', 'device-ref-removed', 'key-removed', 'Removed device',
				0, 'removed', ?)`,
		).run(attemptId, NOW);
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-removed', 'identity-removed', 'Removed device', 'active',
				'coordinator_invite', 'r1', 'user_managed', 2, 'removed-live', ?, ?)`,
		).run(NOW, NOW);
		// A settled non-granting invite decision is the sanctioned survivor.
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
				team_id, device_id, decision, assignment_version, provenance, revision,
				created_at, updated_at
			 ) VALUES (?, 'device-removed', 'excluded', 2, 'coordinator_invite', 'r1', ?, ?)`,
		).run(teamId, NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		// An `included` invite decision on a removed device would keep granting
		// Project access through reviewed-allowlist eligibility.
		db.prepare(
			`UPDATE policy_team_device_decisions SET decision = 'included'
			 WHERE device_id = 'device-removed'`,
		).run();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
	});

	it("drops Ready for a canonical decision with a malformed device ID", () => {
		const { teamId } = completeCandidate();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		// An invite-owned excluded decision is otherwise well-shaped, but
		// authoritative eligibility rejects the padded device ID and blocks
		// the whole Team; readiness must apply the same identifier rule.
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
				team_id, device_id, decision, assignment_version, provenance, revision,
				created_at, updated_at
			 ) VALUES (?, ' device-padded', 'excluded', 0, 'coordinator_invite', 'r1', ?, ?)`,
		).run(teamId, NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
	});

	it("drops Ready when a preserved invite included decision loses its live assignment", () => {
		const { teamId } = completeCandidate();
		// A sanctioned invite addition with a matching live assignment keeps
		// the Team Ready.
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-invited', 'identity-invited', 'Invited', 'active', 'coordinator_invite',
				'r1', 'user_managed', 3, 'invited-device', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
				team_id, device_id, decision, assignment_version, provenance, revision,
				created_at, updated_at
			 ) VALUES (?, 'device-invited', 'included', 3, 'coordinator_invite', 'r1', ?, ?)`,
		).run(teamId, NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		// Reassignment advances the version: authoritative eligibility silently
		// drops the device while the roster fingerprint is unchanged, so Ready
		// must reopen setup instead of advertising stale access.
		db.prepare(
			"UPDATE identity_devices SET assignment_version = 4 WHERE device_id = 'device-invited'",
		).run();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
	});

	it("does not collapse a resolution shadowed by a higher-priority wildcard mapping", () => {
		const webId = "https://git.example.invalid/acme/web.git";
		const sessionId = Number(
			db.prepare(`INSERT INTO sessions(started_at, project) VALUES (?, 'web')`).run(NOW)
				.lastInsertRowid,
		);
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at,
				visibility, project, scope_id
			 ) VALUES (?, 'discovery', 'web', 'body', 1, ?, ?, 'shared', 'web', 'scope-api')`,
		).run(sessionId, NOW, NOW);
		const unmappedId = canonicalWorkspaceIdentity({ project: "web" }).value;
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-api', 1000, 'reviewed_team_setup', ?, ?)`,
		).run(webId, unmappedId, NOW, NOW);
		// The resolution row is authoritative for the source: it collapses.
		expect(discoverLegacyTeamCandidates(db, options())[0]?.projectCount).toBe(2);

		// A higher-priority wildcard now wins selection for the source, so the
		// lower-priority resolution must not bypass it: the source surfaces as
		// its own Project again.
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (NULL, 'unmapped:*', 'scope-api', 9000, 'test', ?, ?)`,
		).run(NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.projectCount).toBe(3);
	});

	it("does not collapse a source that has its own exact workspace mapping", () => {
		const webId = "https://git.example.invalid/acme/web.git";
		const sessionId = Number(
			db.prepare(`INSERT INTO sessions(started_at, project) VALUES (?, 'web')`).run(NOW)
				.lastInsertRowid,
		);
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at,
				visibility, project, scope_id
			 ) VALUES (?, 'discovery', 'web', 'body', 1, ?, ?, 'shared', 'web', 'scope-api')`,
		).run(sessionId, NOW, NOW);
		const unmappedId = canonicalWorkspaceIdentity({ project: "web" }).value;
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-api', 1000, 'reviewed_team_setup', ?, ?)`,
		).run(webId, unmappedId, NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.projectCount).toBe(2);

		// An exact workspace mapping routing the SOURCE identity itself takes
		// unconditional precedence in selection, so the lower-priority
		// resolution must not collapse it — even though the resolution's
		// pattern still matches.
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-foreign', 500, 'test', ?, ?)`,
		).run(unmappedId, unmappedId, NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.projectCount).toBe(3);
	});

	it("keeps a completed Team selectable when current evidence drifts", () => {
		const completion = completeCandidate();
		const [candidate] = discoverLegacyTeamCandidates(db, options());
		expect(candidate?.status).toBe("ready");
		const candidateId = candidate?.candidateRef as string;
		const projection = options().projection;
		const liveInventory = legacyTeamCandidateProjectInventory(db, projection, candidateId);

		// Matching current evidence keeps the Team selectable.
		expect(isLegacyTeamCandidateSelectable(db, candidateId, { projects: liveInventory })).toBe(
			true,
		);

		// Roster and Project drift belong to normal Team management after the
		// one-time migration completes; they must not revoke that completion.
		expect(
			isLegacyTeamCandidateSelectable(db, candidateId, {
				rosterFingerprint: "drifted-roster",
				projects: liveInventory,
			}),
		).toBe(true);

		expect(isLegacyTeamCandidateSelectable(db, candidateId, { projects: [] })).toBe(true);

		const driftedRoster = options("key-b");
		expect(discoverLegacyTeamCandidates(db, driftedRoster)[0]?.status).toBe("needs_setup");
		expect(latestLegacyTeamSetupAttempt(db, candidateId)?.attemptId).toBe(completion.attemptId);
		expect(getLegacyTeamSetupDraft(db, candidateId)?.state).toBe("completed");
		expect(isLegacyTeamCandidateSelectable(db, candidateId)).toBe(true);
	});

	it("validates normalized current Project evidence for pre-marker completions", () => {
		const completion = completeCandidate();
		db.prepare(
			"UPDATE policy_teams SET provenance = 'legacy_team_candidate' WHERE team_id = ?",
		).run(completion.teamId);
		const liveInventory = legacyTeamCandidateProjectInventory(
			db,
			options().projection,
			completion.candidateId,
		);
		db.prepare("UPDATE project_scope_mappings SET workspace_identity = ?").run(`${PROJECT_ID}/`);

		expect(
			isLegacyTeamCandidateSelectable(db, completion.candidateId, {
				projects: liveInventory.map((project) => ({
					...project,
					sourceProjectIdentity: `${project.sourceProjectIdentity}/`,
				})),
			}),
		).toBe(true);
		expect(isLegacyTeamCandidateSelectable(db, completion.candidateId, { projects: [] })).toBe(
			false,
		);
	});

	it("keeps pre-marker completions selectable after root Projects are retired", () => {
		const completion = completeCandidate();
		db.prepare(
			"UPDATE policy_teams SET provenance = 'legacy_team_candidate' WHERE team_id = ?",
		).run(completion.teamId);
		db.prepare(
			`UPDATE legacy_team_setup_draft_projects
			 SET source_project_identity = '/', resolved_project_identity = '/'
			 WHERE attempt_id = ?`,
		).run(completion.attemptId);
		db.prepare("DELETE FROM memory_items").run();
		db.prepare("DELETE FROM sessions").run();
		db.prepare("DELETE FROM project_scope_mappings").run();

		expect(isLegacyTeamCandidateSelectable(db, completion.candidateId, { projects: [] })).toBe(
			true,
		);
	});

	it.each(["/", null])(
		"reconciles non-root edges without restoring a retired root resolved as %s",
		(rootResolution) => {
			const completion = completeCandidate();
			db.prepare(
				"UPDATE policy_teams SET provenance = 'legacy_team_candidate' WHERE team_id = ?",
			).run(completion.teamId);
			db.prepare(
				`INSERT INTO legacy_team_setup_draft_projects(
				 attempt_id, project_ref, source_project_identity, display_name,
				 source_fingerprint, resolution_kind, resolved_project_identity,
				 target_scope_id, updated_at
				 ) VALUES (?, '000-root', '/', 'Filesystem root', 'root-source',
				 'explicit', ?, 'scope-api', ?)`,
			).run(completion.attemptId, rootResolution, NOW);
			db.prepare(
				"DELETE FROM project_recipients WHERE canonical_project_identity = ? AND recipient_id = ?",
			).run(PROJECT_ID, completion.teamId);

			expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");
			expect(
				db
					.prepare(
						`SELECT COUNT(*) FROM project_recipients
						 WHERE canonical_project_identity = ? AND recipient_id = ? AND status = 'active'`,
					)
					.pluck()
					.get(PROJECT_ID, completion.teamId),
			).toBe(1);
			expect(
				db
					.prepare(
						`SELECT COUNT(*) FROM project_recipients
						 WHERE canonical_project_identity = '/' AND recipient_id = ?`,
					)
					.pluck()
					.get(completion.teamId),
			).toBe(0);
		},
	);

	it("keeps validating a retired root source resolved to a non-root Project", () => {
		const completion = completeCandidate();
		db.prepare(
			"UPDATE policy_teams SET provenance = 'legacy_team_candidate' WHERE team_id = ?",
		).run(completion.teamId);
		db.prepare(
			`UPDATE legacy_team_setup_draft_projects
			 SET source_project_identity = '/'
			 WHERE attempt_id = ?`,
		).run(completion.attemptId);
		db.prepare(
			"DELETE FROM project_recipients WHERE canonical_project_identity = ? AND recipient_id = ?",
		).run(PROJECT_ID, completion.teamId);

		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_id = ? AND status = 'active'`,
				)
				.pluck()
				.get(PROJECT_ID, completion.teamId),
		).toBe(1);
	});

	it("reopens an incompatible completion that predates terminal migration markers", () => {
		const completion = completeCandidate();
		db.prepare(
			`UPDATE policy_teams
			 SET provenance = 'legacy_team_candidate', source_fingerprint = 'drifted-roster'
			 WHERE team_id = ?`,
		).run(completion.teamId);

		expect(isLegacyTeamCandidateSelectable(db, completion.candidateId)).toBe(false);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
		expect(latestLegacyTeamSetupAttempt(db, completion.candidateId)?.attemptId).not.toBe(
			completion.attemptId,
		);
		expect(getLegacyTeamSetupDraft(db, completion.candidateId)?.state).toBe("needs_setup");
	});

	it("rejects rosters with conflicting duplicate device rows", () => {
		const base = options();
		const group = base.groups[0];
		if (!group) throw new Error("invalid test fixture");
		// Exact duplicates collapse; the candidate stays discoverable.
		group.devices = [
			{
				deviceId: "device-a",
				fingerprint: "key-a",
				displayName: "Laptop opaque-duplicate-private",
				enabled: true,
				labelRedactionIds: ["opaque-first-private"],
			},
			{
				deviceId: "device-a",
				fingerprint: "key-a",
				displayName: "Laptop copy",
				enabled: true,
				labelRedactionIds: ["opaque-duplicate-private"],
			},
		];
		const [collapsed] = discoverLegacyTeamCandidates(db, base);
		expect(collapsed).toMatchObject({ deviceCount: 1 });
		const candidateRef = collapsed?.candidateRef as string;
		expect(getLegacyTeamSetupDraft(db, candidateRef)?.devices[0]?.displayName).toBe("Device");

		// A fingerprint conflict is not reviewable evidence: silently keeping
		// either row would authorize review against arbitrary key material.
		group.devices = [
			{ deviceId: "device-a", fingerprint: "key-a", displayName: "Laptop", enabled: true },
			{ deviceId: "device-a", fingerprint: "key-forged", displayName: "Laptop", enabled: true },
		];
		expect(discoverLegacyTeamCandidates(db, base)).toHaveLength(0);
		expect(() => refreshLegacyTeamCandidate(db, base, candidateRef)).toThrow(
			"legacy_team_setup_roster_conflict",
		);

		// Two snapshots for the same group with contradictory rosters are the
		// same class of conflict: the accepted evidence must not depend on
		// which snapshot happens to appear first.
		const twin = options();
		const first = twin.groups[0];
		if (!first) throw new Error("invalid test fixture");
		twin.groups = [
			first,
			{
				...first,
				devices: [
					{ deviceId: "device-a", fingerprint: "key-forged", displayName: "Laptop", enabled: true },
				],
			},
		];
		expect(discoverLegacyTeamCandidates(db, twin)).toHaveLength(0);
		expect(() => refreshLegacyTeamCandidate(db, twin, candidateRef)).toThrow(
			"legacy_team_setup_roster_conflict",
		);

		// Identical twin snapshots still merge and retain the union of their
		// transient label-redaction identifiers.
		const firstDevice = first.devices[0];
		if (!firstDevice) throw new Error("invalid test fixture");
		firstDevice.displayName = "Laptop opaque-twin-private";
		firstDevice.labelRedactionIds = ["opaque-first-private"];
		twin.groups = [
			first,
			{
				...first,
				displayName: "Engineering copy",
				devices: [
					{
						...firstDevice,
						displayName: "Laptop copy",
						labelRedactionIds: ["opaque-twin-private"],
					},
				],
			},
		];
		expect(discoverLegacyTeamCandidates(db, twin)).toHaveLength(1);
		expect(getLegacyTeamSetupDraft(db, candidateRef)?.devices[0]?.displayName).toBe("Device");
	});

	it("collapses invite-operation identities through explicit resolutions", () => {
		const webId = "https://git.example.invalid/acme/web.git";
		const unmappedId = canonicalWorkspaceIdentity({ project: "web" }).value;
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-recipient', 'Recipient', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const reviewedDigest = shareProjectSetDigest([
			{
				canonicalIdentity: unmappedId,
				displayName: "Web",
				identitySource: "unmapped",
				existingMemoryCount: 1,
			},
		]);
		db.prepare(
			`INSERT INTO share_operations(
				operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
				person_kind, teammate_name, history_policy, reviewed_project_set_digest,
				coordinator_group_id, invite_token_digest, invite_expires_at,
				recipient_actor_id, recipient_device_id, acceptance_consumed_at, created_at, updated_at
			 ) VALUES ('op-unmapped', 'active', 'actor-local', '[]', 'identity-recipient',
				'existing', 'Recipient', 'existing_and_future', ?, 'group-private',
				'invite-token-2', '2099-01-01T00:00:00.000Z', 'identity-recipient',
				'device-recipient', ?, ?, ?)`,
		).run(reviewedDigest, NOW, NOW, NOW);
		db.prepare(
			`INSERT INTO share_operation_projects(
				operation_id, canonical_project_identity, display_name, identity_source,
				existing_memory_count, ordinal
			 ) VALUES ('op-unmapped', ?, 'Web', 'unmapped', 1, 0)`,
		).run(unmappedId);
		// Without a resolution, the invite contributes the unmapped source.
		expect(discoverLegacyTeamCandidates(db, options())[0]?.projectCount).toBe(2);

		// An explicit resolution collapses the invite-contributed source into
		// its reviewed target instead of surfacing both as Projects.
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-api', 1000, 'reviewed_team_setup', ?, ?)`,
		).run(webId, unmappedId, NOW, NOW);
		const [candidate] = discoverLegacyTeamCandidates(db, options());
		expect(candidate?.projectCount).toBe(2);
		const refreshed = refreshLegacyTeamCandidate(db, options(), candidate?.candidateRef as string);
		const sources = db
			.prepare(
				`SELECT source_project_identity FROM legacy_team_setup_draft_projects
				 WHERE attempt_id = ? ORDER BY source_project_identity`,
			)
			.pluck()
			.all(refreshed.attemptId) as string[];
		expect(sources).not.toContain(unmappedId);
		expect(sources).toContain(webId);
	});

	it("associates invite-only Projects with the configured group's coordinator", () => {
		const inviteProject = "https://git.example.invalid/acme/invite-only.git";
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-recipient', 'Recipient', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const sessionId = Number(
			db
				.prepare(
					`INSERT INTO sessions(started_at, project, git_remote, git_branch)
					 VALUES (?, 'invite-only', ?, 'main')`,
				)
				.run(NOW, inviteProject).lastInsertRowid,
		);
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at,
				visibility, project
			 ) VALUES (?, 'discovery', 'invite', 'body', 1, ?, ?, 'shared', 'invite-only')`,
		).run(sessionId, NOW, NOW);
		const reviewedDigest = shareProjectSetDigest([
			{
				canonicalIdentity: inviteProject,
				displayName: "Invite Only",
				identitySource: "git_remote",
				existingMemoryCount: 1,
			},
		]);
		db.prepare(
			`INSERT INTO share_operations(
				operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
				person_kind, teammate_name, history_policy, reviewed_project_set_digest,
				coordinator_group_id, invite_token_digest, invite_expires_at,
				recipient_actor_id, recipient_device_id, acceptance_consumed_at, created_at, updated_at
			 ) VALUES ('op-invite', 'active', 'actor-local', '[]', 'identity-recipient',
				'existing', 'Recipient', 'existing_and_future', ?, 'group-private',
				'invite-token', '2099-01-01T00:00:00.000Z', 'identity-recipient',
				'device-recipient', ?, ?, ?)`,
		).run(reviewedDigest, NOW, NOW, NOW);
		db.prepare(
			`INSERT INTO share_operation_projects(
				operation_id, canonical_project_identity, display_name, identity_source,
				existing_memory_count, ordinal
			 ) VALUES ('op-invite', ?, 'Invite Only', 'git_remote', 1, 0)`,
		).run(inviteProject);
		// A local-authority scope carrying the same coordinator and group IDs is
		// not coordinator evidence: it must neither hijack the association nor
		// suppress the legitimate coordinator fallback.
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-local-rogue', 'Local Rogue', 'team', 'local',
			 'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		const [candidate] = discoverLegacyTeamCandidates(db, options());

		// The invite-only Project has no relevant replication scope, but its
		// group resolves to the configured coordinator, so it belongs to the
		// candidate's inventory and inherits the sole active group scope.
		expect(candidate).toMatchObject({ projectCount: 2, unresolvedProjectCount: 0 });
		expect(
			db
				.prepare(
					`SELECT resolution_kind, resolved_project_identity, target_scope_id
					 FROM legacy_team_setup_draft_projects
					 WHERE source_project_identity = ?`,
				)
				.get(inviteProject),
		).toEqual({
			resolution_kind: "deterministic",
			resolved_project_identity: inviteProject,
			target_scope_id: "scope-api",
		});
		expect(discoverLegacyTeamCandidates(db, options())[0]).toMatchObject({
			status: "needs_setup",
			projectCount: 2,
			unresolvedProjectCount: 0,
		});
		db.prepare(
			"UPDATE legacy_team_setup_draft_devices SET decision = 'excluded' WHERE attempt_id = ?",
		).run(latestLegacyTeamSetupAttempt(db, candidate?.candidateRef as string)?.attemptId);
		expect(getLegacyTeamSetupDraft(db, candidate?.candidateRef as string)?.canFinish).toBe(true);

		// A second coordinator sharing the group ID makes the association
		// ambiguous, so the invite-only Project must drop out again.
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-ambiguous', 'Other Org', 'team', 'coordinator',
				'coordinator-other', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		const [ambiguous] = discoverLegacyTeamCandidates(db, options());
		expect(ambiguous?.projectCount).toBe(1);
	});

	it.each([
		[
			"the excluded decision drifts to included",
			(db2: InstanceType<typeof Database>, teamId: string) =>
				db2
					.prepare(
						"UPDATE policy_team_device_decisions SET decision = 'included' WHERE team_id = ?",
					)
					.run(teamId),
		],
		[
			"a decision row is added for a device outside the completed draft",
			(db2: InstanceType<typeof Database>, teamId: string) =>
				db2
					.prepare(
						`INSERT INTO policy_team_device_decisions(
						 team_id, device_id, decision, assignment_version, provenance, revision,
						 created_at, updated_at
						 ) VALUES (?, 'device-foreign', 'included', 0, 'test', 'r1', ?, ?)`,
					)
					.run(teamId, NOW, NOW),
		],
		[
			"the excluded decision's assignment version is malformed",
			(db2: InstanceType<typeof Database>, teamId: string) =>
				db2
					.prepare(
						"UPDATE policy_team_device_decisions SET assignment_version = -1 WHERE team_id = ?",
					)
					.run(teamId),
		],
	] as const)("drops Ready for an excluded-device completion when %s", (_label, mutate) => {
		runExcludedCompletionScenario(mutate, "needs_setup");
	});

	it("preserves a compatible Ready completion during explicit refresh", () => {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const [initial] = discoverLegacyTeamCandidates(db, options());
		const draft = db
			.prepare(
				`SELECT attempt_id, candidate_id, roster_fingerprint
				 FROM legacy_team_setup_drafts WHERE candidate_id = ?`,
			)
			.get(initial?.candidateRef) as {
			attempt_id: string;
			candidate_id: string;
			roster_fingerprint: string;
		};
		const teamId = deterministicPolicyTeamId(draft.candidate_id);
		db.prepare(
			`UPDATE legacy_team_setup_draft_devices SET decision = 'excluded' WHERE attempt_id = ?`,
		).run(draft.attempt_id);
		db.prepare(
			`INSERT INTO policy_teams(
				team_id, display_name, status, device_eligibility_mode, provenance,
				revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Engineering', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
				'revision-1', 'completed', ?, 'team-setup-test', ?, ?)`,
		).run(teamId, draft.roster_fingerprint, NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
				team_id, device_id, decision, assignment_version, provenance, revision,
				created_at, updated_at
			 ) VALUES (?, 'device-a', 'excluded', 0, 'reviewed_team_setup', 'r1', ?, ?)`,
		).run(teamId, NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
				canonical_project_identity, recipient_kind, recipient_id, status, provenance,
				policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'r1', 'completed',
				'ready-edge', ?, ?)`,
		).run(PROJECT_ID, teamId, NOW, NOW);
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(teamId, NOW, NOW, draft.attempt_id);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		const refreshed = refreshLegacyTeamCandidate(
			db,
			options("key-a", "Renamed Laptop"),
			draft.candidate_id,
		);

		expect(refreshed.attemptId).toBe(draft.attempt_id);
		expect(refreshed.state).toBe("completed");
		expect(refreshed.devices[0]?.displayName).toBe("Renamed Laptop");
		expect(latestLegacyTeamSetupAttempt(db, draft.candidate_id)?.attemptId).toBe(draft.attempt_id);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");
	});

	it("keeps the active Team name and completion when coordinator evidence changes", () => {
		const [initial] = discoverLegacyTeamCandidates(db, options());
		const draft = db
			.prepare(
				`SELECT attempt_id, candidate_id, roster_fingerprint
				 FROM legacy_team_setup_drafts WHERE candidate_id = ?`,
			)
			.get(initial?.candidateRef) as {
			attempt_id: string;
			candidate_id: string;
			roster_fingerprint: string;
		};
		const teamId = deterministicPolicyTeamId(draft.candidate_id);
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance,
			 revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Renamed Engineering', 'active', 'reviewed_allowlist',
			 'reviewed_team_candidate', 'revision-1', 'completed', ?, 'team-setup-test', ?, ?)`,
		).run(teamId, draft.roster_fingerprint, NOW, NOW);
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(teamId, NOW, NOW, draft.attempt_id);

		const refreshed = refreshLegacyTeamCandidate(db, options("changed-key"), draft.candidate_id);

		expect(refreshed.attemptId).toBe(draft.attempt_id);
		expect(refreshed.state).toBe("completed");
		expect(refreshed.displayName).toBe("Renamed Engineering");
	});

	it("keeps the last reviewed Team name when coordinator labels temporarily fall back", () => {
		const namedOptions = options();
		const namedGroup = namedOptions.groups[0];
		if (!namedGroup) throw new Error("group fixture missing");
		namedGroup.displayName = "Nerdworld";
		const [initial] = discoverLegacyTeamCandidates(db, namedOptions);
		expect(initial?.displayName).toBe("Nerdworld");

		const fallbackOptions = options("changed-key");
		const fallbackGroup = fallbackOptions.groups[0];
		if (!fallbackGroup) throw new Error("group fixture missing");
		fallbackGroup.displayName = "Legacy Team";
		const [refreshed] = discoverLegacyTeamCandidates(db, fallbackOptions);

		expect(refreshed?.displayName).toBe("Nerdworld");
		expect(getLegacyTeamSetupDraft(db, refreshed?.candidateRef as string)?.displayName).toBe(
			"Nerdworld",
		);
	});

	it("serializes a competing refresh before reading candidate authority", () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "codemem-legacy-team-authority-"));
		const path = join(directory, "candidate.sqlite");
		const primary = new Database(path);
		const competing = new Database(path);
		let restorePrepare: (() => void) | undefined;
		try {
			seedCandidateFixture(primary);
			const initial = refreshLegacyTeamCandidate(
				primary,
				options(),
				legacyTeamCandidateId("coordinator-private", "group-private"),
			);
			primary.pragma("busy_timeout = 1");
			const prepare = vi.spyOn(primary, "prepare");
			restorePrepare = () => prepare.mockRestore();
			const draftReadProbe = () =>
				prepare.mock.calls.some(([sql]) => String(sql).includes("FROM legacy_team_setup_drafts"));
			const projectReadProbe = () =>
				prepare.mock.calls.some(([sql]) => String(sql).includes("FROM project_scope_mappings"));
			competing.exec("BEGIN IMMEDIATE");
			competing
				.prepare("UPDATE legacy_team_setup_drafts SET updated_at = ? WHERE attempt_id = ?")
				.run("2026-08-21T12:00:01.000Z", initial.attemptId);

			// Act
			const blockedRefresh = () =>
				refreshLegacyTeamCandidate(
					primary,
					options("key-b"),
					legacyTeamCandidateId("coordinator-private", "group-private"),
				);

			// Assert
			expect(blockedRefresh).toThrow(/SQLITE_BUSY|database is locked/i);
			expect(draftReadProbe()).toBe(false);
			expect(projectReadProbe()).toBe(false);
			competing.exec("ROLLBACK");

			const current = refreshLegacyTeamCandidate(
				primary,
				options("key-b"),
				legacyTeamCandidateId("coordinator-private", "group-private"),
			);
			expect(draftReadProbe()).toBe(true);
			expect(projectReadProbe()).toBe(true);
			const attempts = primary
				.prepare(
					`SELECT attempt_id, state, superseded_at FROM legacy_team_setup_drafts
					 ORDER BY rowid`,
				)
				.all() as Array<{ attempt_id: string; state: string; superseded_at: string | null }>;
			expect(attempts).toEqual([
				{ attempt_id: initial.attemptId, state: "stale", superseded_at: NOW },
				{ attempt_id: current.attemptId, state: "needs_setup", superseded_at: null },
			]);
		} finally {
			restorePrepare?.();
			if (competing.inTransaction) competing.exec("ROLLBACK");
			competing.close();
			primary.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("requires setup when Project evidence spans multiple group scopes", () => {
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-api-second', 'Engineering Second', 'managed_project', 'coordinator',
				'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		// The confirmed mapping targets the second scope of the same group.
		db.prepare("UPDATE project_scope_mappings SET scope_id = 'scope-api-second'").run();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
	});

	it("keeps Ready when an invite-owned decision is preserved outside the draft", () => {
		runExcludedCompletionScenario((db2, teamId) => {
			// A preserved invite `included` decision stays sanctioned only while
			// its live active assignment matches the reviewed version.
			db2
				.prepare(
					`INSERT INTO identity_devices(
					 device_id, identity_id, display_name, status, provenance, revision,
					 migration_state, assignment_version, idempotency_key, created_at, updated_at
					 ) VALUES ('device-invited', 'identity-invited', 'Invited', 'active',
					 'coordinator_invite', 'r1', 'user_managed', 0, 'invited-live', ?, ?)`,
				)
				.run(NOW, NOW);
			db2
				.prepare(
					`INSERT INTO policy_team_device_decisions(
					 team_id, device_id, decision, assignment_version, provenance, revision,
					 created_at, updated_at
					 ) VALUES (?, 'device-invited', 'included', 0, 'coordinator_invite', 'r1', ?, ?)`,
				)
				.run(teamId, NOW, NOW);
		}, "ready");
	});

	it("reopens setup when an invite-owned decision awaits review", () => {
		runExcludedCompletionScenario(
			(db2, teamId) =>
				db2
					.prepare(
						`INSERT INTO policy_team_device_decisions(
						 team_id, device_id, decision, assignment_version, provenance, revision,
						 created_at, updated_at
						 ) VALUES (?, 'device-invited', 'unresolved', 0, 'coordinator_invite', 'r1', ?, ?)`,
					)
					.run(teamId, NOW, NOW),
			"needs_setup",
		);
	});

	it("drops Ready when an invite-owned decision is malformed", () => {
		runExcludedCompletionScenario(
			(db2, teamId) =>
				db2
					.prepare(
						`INSERT INTO policy_team_device_decisions(
						 team_id, device_id, decision, assignment_version, provenance, revision,
						 created_at, updated_at
						 ) VALUES (?, 'device-invited', 'granted', 0, 'coordinator_invite', 'r1', ?, ?)`,
					)
					.run(teamId, NOW, NOW),
			"needs_setup",
		);
	});

	function runExcludedCompletionScenario(
		mutate: (db2: InstanceType<typeof Database>, teamId: string) => unknown,
		expectedStatus: "ready" | "needs_setup" | "missing",
	) {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		const [initial] = discoverLegacyTeamCandidates(db, options());
		const draft = db
			.prepare(
				`SELECT attempt_id, candidate_id, roster_fingerprint
				 FROM legacy_team_setup_drafts WHERE candidate_id = ?`,
			)
			.get(initial?.candidateRef) as {
			attempt_id: string;
			candidate_id: string;
			roster_fingerprint: string;
		};
		const teamId = deterministicPolicyTeamId(draft.candidate_id);
		db.prepare(
			`UPDATE legacy_team_setup_draft_devices SET decision = 'excluded' WHERE attempt_id = ?`,
		).run(draft.attempt_id);
		db.prepare(
			`INSERT INTO policy_teams(
				team_id, display_name, status, device_eligibility_mode, provenance,
				revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Engineering', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
				'revision-1', 'completed', ?, 'team-setup-test', ?, ?)`,
		).run(teamId, draft.roster_fingerprint, NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
				team_id, device_id, decision, assignment_version, provenance, revision,
				created_at, updated_at
			 ) VALUES (?, 'device-a', 'excluded', 0, 'reviewed_team_setup', 'r1', ?, ?)`,
		).run(teamId, NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
				canonical_project_identity, recipient_kind, recipient_id, status, provenance,
				policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'r1', 'completed',
				'ready-edge', ?, ?)`,
		).run(PROJECT_ID, teamId, NOW, NOW);
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(teamId, NOW, NOW, draft.attempt_id);

		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		mutate(db, teamId);
		const discovered = discoverLegacyTeamCandidates(db, options());
		if (expectedStatus === "missing") expect(discovered).toEqual([]);
		else expect(discovered[0]?.status).toBe(expectedStatus);
	}

	it("does not restore a Project edge when another recipient blocks canonical derivation", () => {
		let completedTeamId = "";
		runExcludedCompletionScenario((db2, teamId) => {
			completedTeamId = teamId;
			db2
				.prepare(
					`DELETE FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
				)
				.run(PROJECT_ID, teamId);
			db2
				.prepare(
					`INSERT INTO project_recipients(
					 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
					 policy_revision, migration_state, idempotency_key, created_at, updated_at
					 ) VALUES (?, 'team', 'missing-team', 'active', 'test', 'r1', 'completed',
					 'blocking-recipient', ?, ?)`,
				)
				.run(PROJECT_ID, NOW, NOW);
		}, "needs_setup");

		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
				)
				.pluck()
				.get(PROJECT_ID, completedTeamId),
		).toBe(0);
	});

	it("rolls back reconciliation if the strict post-write invariant changes", () => {
		let completedTeamId = "";
		runExcludedCompletionScenario((db2, teamId) => {
			completedTeamId = teamId;
			db2
				.prepare(
					`DELETE FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
				)
				.run(PROJECT_ID, teamId);
			db2.exec(
				`CREATE TRIGGER block_reconciled_team_edge
				 AFTER INSERT ON project_recipients
				 WHEN NEW.provenance = 'reviewed_team_setup'
				 BEGIN
				   INSERT INTO project_recipients(
				     canonical_project_identity, recipient_kind, recipient_id, status, provenance,
				     policy_revision, migration_state, idempotency_key, created_at, updated_at
				   ) VALUES (NEW.canonical_project_identity, 'team', 'missing-after-write', 'active',
				     'test', 'r1', 'completed', 'post-write-blocker', NEW.created_at, NEW.updated_at);
				 END`,
			);
		}, "missing");

		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team'
					   AND recipient_id IN (?, 'missing-after-write')`,
				)
				.pluck()
				.get(PROJECT_ID, completedTeamId),
		).toBe(0);
		expect(db.prepare("SELECT state FROM legacy_team_setup_drafts").pluck().get()).toBe(
			"completed",
		);
	});

	it("reactivates a revoked setup-owned Project edge", () => {
		let completedTeamId = "";
		runExcludedCompletionScenario((db2, teamId) => {
			completedTeamId = teamId;
			db2
				.prepare(
					`UPDATE project_recipients SET status = 'revoked', policy_revision = 'old-r1',
					 source_fingerprint = 'old-source'
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
				)
				.run(PROJECT_ID, teamId);
		}, "ready");

		expect(
			db
				.prepare(
					`SELECT status, provenance, policy_revision FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`,
				)
				.get(PROJECT_ID, completedTeamId),
		).toEqual({
			status: "active",
			provenance: "reviewed_team_setup",
			policy_revision: "revision-1",
		});
	});

	it.each([
		[
			"the included decision drifts to unresolved",
			(db2: InstanceType<typeof Database>, teamId: string) =>
				db2
					.prepare(
						"UPDATE policy_team_device_decisions SET decision = 'unresolved' WHERE team_id = ?",
					)
					.run(teamId),
		],
		[
			"the completed draft loses its included target",
			(db2: InstanceType<typeof Database>) =>
				db2
					.prepare(
						"UPDATE legacy_team_setup_draft_devices SET target_identity_id = NULL WHERE decision = 'included'",
					)
					.run(),
		],
		[
			"the included member identity is deactivated",
			(db2: InstanceType<typeof Database>) =>
				db2.prepare("UPDATE actors SET status = 'deactivated' WHERE actor_id = 'identity-a'").run(),
		],
		[
			"canonical Project effective-device derivation is blocked",
			(db2: InstanceType<typeof Database>) =>
				db2
					.prepare(
						`INSERT INTO project_recipients(
						 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
						 policy_revision, migration_state, idempotency_key, created_at, updated_at
						 ) VALUES (?, 'identity', 'identity-missing', 'active', 'test', 'r1', 'completed',
						 'missing-identity-recipient', ?, ?)`,
					)
					.run(PROJECT_ID, NOW, NOW),
		],
		[
			"a membership status invalid for reviewed mode appears",
			(db2: InstanceType<typeof Database>, teamId: string) => {
				db2
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES ('identity-legacy', 'Legacy Invitee', 0, 'active', ?, ?)`,
					)
					.run(NOW, NOW);
				db2
					.prepare(
						`INSERT INTO policy_team_memberships(
						 team_id, identity_id, role, status, provenance, revision, migration_state,
						 idempotency_key, created_at, updated_at
						 ) VALUES (?, 'identity-legacy', 'member', 'active', 'coordinator_invite',
						 'r1', 'user_managed', 'legacy-status-membership', ?, ?)`,
					)
					.run(teamId, NOW, NOW);
			},
		],
		[
			"the included pair agrees on a malformed assignment version",
			(db2: InstanceType<typeof Database>, teamId: string) => {
				db2.prepare("UPDATE identity_devices SET assignment_version = -1").run();
				db2
					.prepare(
						"UPDATE policy_team_device_decisions SET assignment_version = -1 WHERE team_id = ?",
					)
					.run(teamId);
			},
		],
		[
			"an invite-provenance member with no roster device is deactivated",
			(db2: InstanceType<typeof Database>, teamId: string) => {
				db2
					.prepare(
						`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
						 VALUES ('identity-invited', 'Invited', 0, 'deactivated', ?, ?)`,
					)
					.run(NOW, NOW);
				db2
					.prepare(
						`INSERT INTO policy_team_memberships(
						 team_id, identity_id, role, status, provenance, revision, migration_state,
						 idempotency_key, created_at, updated_at
						 ) VALUES (?, 'identity-invited', 'member', 'reviewed_active', 'coordinator_invite',
						 'r1', 'user_managed', 'invited-membership', ?, ?)`,
					)
					.run(teamId, NOW, NOW);
			},
		],
	] as const)("preserves terminal completion when %s", (_label, mutate) => {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
				'completed', 2, 'device-a', ?, ?)`,
		).run(NOW, NOW);
		const [initial] = discoverLegacyTeamCandidates(db, options());
		const draft = db
			.prepare(
				`SELECT attempt_id, candidate_id, roster_fingerprint
				 FROM legacy_team_setup_drafts WHERE candidate_id = ?`,
			)
			.get(initial?.candidateRef) as {
			attempt_id: string;
			candidate_id: string;
			roster_fingerprint: string;
		};
		const teamId = deterministicPolicyTeamId(draft.candidate_id);
		db.prepare(
			`UPDATE legacy_team_setup_draft_devices
			 SET decision = 'included', target_identity_id = 'identity-a'
			 WHERE attempt_id = ?`,
		).run(draft.attempt_id);
		db.prepare(
			`INSERT INTO policy_teams(
				team_id, display_name, status, device_eligibility_mode, provenance,
				revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Engineering', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
				'revision-1', 'completed', ?, 'team-setup-test', ?, ?)`,
		).run(teamId, draft.roster_fingerprint, NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_memberships(
				team_id, identity_id, role, status, provenance, revision, migration_state,
				idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-a', 'member', 'reviewed_active', 'reviewed_active', 'r1',
				'completed', 'ready-membership', ?, ?)`,
		).run(teamId, NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
				team_id, device_id, decision, assignment_version, provenance, revision,
				created_at, updated_at
			 ) VALUES (?, 'device-a', 'included', 2, 'reviewed_team_setup', 'r1', ?, ?)`,
		).run(teamId, NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
				canonical_project_identity, recipient_kind, recipient_id, status, provenance,
				policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'r1', 'completed',
				'ready-edge', ?, ?)`,
		).run(PROJECT_ID, teamId, NOW, NOW);
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(teamId, NOW, NOW, draft.attempt_id);

		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		mutate(db, teamId);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
		expect(latestLegacyTeamSetupAttempt(db, draft.candidate_id)?.attemptId).toBe(draft.attempt_id);
		expect(getLegacyTeamSetupDraft(db, draft.candidate_id)?.state).toBe("completed");
		expect(isLegacyTeamCandidateSelectable(db, draft.candidate_id)).toBe(true);
	});

	it("replaces a malformed completion without a terminal Team", () => {
		const [initial] = discoverLegacyTeamCandidates(db, options());
		if (!initial) throw new Error("initial candidate missing");
		const initialAttempt = latestLegacyTeamSetupAttempt(db, initial.candidateRef);
		if (!initialAttempt) throw new Error("initial attempt missing");
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', projection_fingerprint = 'stale-projects', completed_at = ?
			 WHERE candidate_id = ?`,
		).run(NOW, initial.candidateRef);

		const [rediscovered] = discoverLegacyTeamCandidates(db, options());
		if (!rediscovered) throw new Error("rediscovered candidate missing");
		const rediscoveredAttempt = latestLegacyTeamSetupAttempt(db, rediscovered.candidateRef);

		expect(rediscovered.status).toBe("needs_setup");
		expect(rediscoveredAttempt).toMatchObject({
			candidateId: initial.candidateRef,
			isCurrent: true,
		});
		expect(rediscoveredAttempt?.attemptId).not.toBe(initialAttempt.attemptId);
		expect(getLegacyTeamSetupDraft(db, initial.candidateRef)?.state).toBe("needs_setup");
	});
});
