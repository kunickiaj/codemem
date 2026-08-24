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
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(0);
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
		const [second] = discoverLegacyTeamCandidates(db, options("key-a", "Renamed Laptop"));

		expect(second?.status).toBe("needs_setup");
		expect(second?.candidateRef).toBe(first?.candidateRef);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
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
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
	});

	it("does not stale a candidate when a scope label changes", () => {
		const [first] = discoverLegacyTeamCandidates(db, options());
		db.prepare("UPDATE replication_scopes SET label = 'Renamed Engineering'").run();

		const [second] = discoverLegacyTeamCandidates(db, options());

		expect(second?.status).toBe("needs_setup");
		expect(second?.candidateRef).toBe(first?.candidateRef);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
	});

	it("marks changed roster evidence stale until explicit refresh", () => {
		const [first] = discoverLegacyTeamCandidates(db, options());
		const [stale] = discoverLegacyTeamCandidates(db, options("key-b"));

		expect(stale?.status).toBe("stale");
		const refreshed = refreshLegacyTeamCandidate(
			db,
			options("key-b"),
			first?.candidateRef as string,
		);
		expect(refreshed.state).toBe("needs_setup");
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(2);
	});

	it("keeps a stale attempt blocked if roster evidence reverts", () => {
		discoverLegacyTeamCandidates(db, options());
		discoverLegacyTeamCandidates(db, options("key-b"));

		const [reverted] = discoverLegacyTeamCandidates(db, options("key-a"));

		expect(reverted?.status).toBe("stale");
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
	});

	it("derives ready only from a current completed draft and compatible canonical Team", () => {
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
		db.prepare(
			`INSERT INTO policy_teams(
				team_id, display_name, status, device_eligibility_mode, provenance,
				revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Engineering', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
				'revision-1', 'completed', ?, 'team-setup-test', ?, ?)`,
		).run(deterministicPolicyTeamId(draft.candidate_id), draft.roster_fingerprint, NOW, NOW);

		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");

		db.prepare(
			`INSERT INTO project_recipients(
				canonical_project_identity, recipient_kind, recipient_id, status, provenance,
				policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'revision-1', 'completed',
				'ready-edge', ?, ?)`,
		).run(PROJECT_ID, deterministicPolicyTeamId(draft.candidate_id), NOW, NOW);
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(deterministicPolicyTeamId(draft.candidate_id), NOW, NOW, draft.attempt_id);

		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		// Removing a completion-bound canonical row must drop Ready even though
		// the Team header and legacy inventory are unchanged.
		db.prepare("UPDATE project_recipients SET status = 'revoked'").run();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("needs_setup");
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
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);

		// A genuinely new Project still reopens setup for review.
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

	function completeCandidate(): { teamId: string; attemptId: string } {
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
		return { teamId, attemptId: draft.attempt_id };
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

	it("keeps Ready when merged resolutions share one selected mapping", () => {
		const { attemptId } = completeCandidate();
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");

		// A second confirmed source resolved to the same canonical identity:
		// selection can pick only one mapping, so Ready must accept the
		// authoritative pattern matching ANY confirmed source.
		db.prepare(
			`INSERT INTO legacy_team_setup_draft_projects(
				attempt_id, project_ref, source_project_identity, display_name,
				source_fingerprint, resolution_kind, resolved_project_identity, updated_at
			 ) VALUES (?, 'project-ref-mirror', 'unmapped:mirror', 'Mirror', 'source-mirror',
				'explicit', ?, ?)`,
		).run(attemptId, PROJECT_ID, NOW);
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, 'unmapped:mirror', 'scope-api', 1000, 'reviewed_team_setup', ?, ?)`,
		).run(PROJECT_ID, NOW, NOW);
		const prepareSpy = vi.spyOn(db, "prepare");
		try {
			expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");
			expect(
				prepareSpy.mock.calls.filter(([sql]) => /FROM actors ORDER BY actor_id/.test(String(sql))),
			).toHaveLength(1);
		} finally {
			prepareSpy.mockRestore();
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

	it("blocks selection when current evidence drifted from the completion", () => {
		completeCandidate();
		const [candidate] = discoverLegacyTeamCandidates(db, options());
		expect(candidate?.status).toBe("ready");
		const candidateId = candidate?.candidateRef as string;
		const projection = options().projection;
		const liveInventory = legacyTeamCandidateProjectInventory(db, projection, candidateId);

		// Matching current evidence keeps the Team selectable.
		expect(isLegacyTeamCandidateSelectable(db, candidateId, { projects: liveInventory })).toBe(
			true,
		);

		// Roster drift the next discovery would reopen setup for must also
		// block selection when the caller holds a current snapshot.
		expect(
			isLegacyTeamCandidateSelectable(db, candidateId, {
				rosterFingerprint: "drifted-roster",
				projects: liveInventory,
			}),
		).toBe(false);

		// Inventory drift — a reviewed Project vanished or a new one appeared —
		// blocks selection the same way.
		expect(isLegacyTeamCandidateSelectable(db, candidateId, { projects: [] })).toBe(false);
	});

	it("rejects rosters with conflicting duplicate device rows", () => {
		const base = options();
		const group = base.groups[0];
		if (!group) throw new Error("invalid test fixture");
		// Exact duplicates collapse; the candidate stays discoverable.
		group.devices = [
			{ deviceId: "device-a", fingerprint: "key-a", displayName: "Laptop", enabled: true },
			{ deviceId: "device-a", fingerprint: "key-a", displayName: "Laptop copy", enabled: true },
		];
		const [collapsed] = discoverLegacyTeamCandidates(db, base);
		expect(collapsed).toMatchObject({ deviceCount: 1 });
		const candidateRef = collapsed?.candidateRef as string;

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

		// Identical twin snapshots still merge.
		twin.groups = [first, { ...first, displayName: "Engineering copy" }];
		expect(discoverLegacyTeamCandidates(db, twin)).toHaveLength(1);
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

		const [candidate] = discoverLegacyTeamCandidates(db, options());

		// The invite-only Project has no relevant replication scope, but its
		// group resolves to the configured coordinator, so it belongs to the
		// candidate's inventory instead of being dropped by a fallback ID.
		expect(candidate?.projectCount).toBe(2);
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM legacy_team_setup_draft_projects
					 WHERE source_project_identity = ?`,
				)
				.pluck()
				.get(inviteProject),
		).toBe(1);

		// A local-authority scope that carries the group ID and a bogus
		// coordinator is not coordinator evidence: it must neither hijack the
		// association nor suppress the legitimate global coordinator match.
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-local-rogue', 'Local Rogue', 'team', 'local',
				'coordinator-rogue', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 'scope-local-rogue', 500, 'test', ?, ?)`,
		).run(inviteProject, inviteProject, NOW, NOW);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.projectCount).toBe(2);

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
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe("ready");
	});

	it("serializes a competing refresh before reading candidate authority", () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "codemem-legacy-team-authority-"));
		const path = join(directory, "candidate.sqlite");
		const primary = new Database(path);
		const competing = new Database(path);
		try {
			seedCandidateFixture(primary);
			const initial = refreshLegacyTeamCandidate(
				primary,
				options(),
				legacyTeamCandidateId("coordinator-private", "group-private"),
			);
			primary.pragma("busy_timeout = 1");
			const prepare = vi.spyOn(primary, "prepare");
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
			if (competing.inTransaction) competing.exec("ROLLBACK");
			competing.close();
			primary.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps Ready when a group exposes multiple scopes and mappings use their own", () => {
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-api-second', 'Engineering Second', 'managed_project', 'coordinator',
				'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		// The confirmed mapping targets the second scope of the same group.
		db.prepare("UPDATE project_scope_mappings SET scope_id = 'scope-api-second'").run();
		runExcludedCompletionScenario(() => undefined, "ready");
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
		expectedStatus: "ready" | "needs_setup",
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
		expect(discoverLegacyTeamCandidates(db, options())[0]?.status).toBe(expectedStatus);
	}

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
	] as const)("drops Ready for an included-device completion when %s", (_label, mutate) => {
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
	});

	it("reopens a completed candidate when its Project inventory fingerprint is stale", () => {
		const [initial] = discoverLegacyTeamCandidates(db, options());
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', projection_fingerprint = 'stale-projects', completed_at = ?
			 WHERE candidate_id = ?`,
		).run(NOW, initial?.candidateRef);

		const [reopened] = discoverLegacyTeamCandidates(db, options());

		expect(reopened?.status).toBe("needs_setup");
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(2);
	});
});
