import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	type DiscoverLegacyTeamCandidatesOptions,
	discoverLegacyTeamCandidates,
} from "./legacy-team-candidate.js";
import { deterministicPolicyTeamId } from "./recipient-policy-identifiers.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-21T12:00:00.000Z";
const PROJECT_ID = "https://git.example.invalid/acme/api.git";

function discoveryOptions(): DiscoverLegacyTeamCandidatesOptions {
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
						displayName: "Laptop",
						enabled: true,
						fingerprint: "key-a",
					},
				],
			},
		],
		now: NOW,
	};
}

function seedCandidateFixture(db: InstanceType<typeof Database>): void {
	initTestSchema(db);
	db.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		VALUES ('actor-local', 'Local Person', 1, 'active', ?, ?),
		       ('identity-a', 'Person A', 0, 'active', ?, ?)`).run(NOW, NOW, NOW, NOW);
	db.prepare(`INSERT INTO replication_scopes(
		scope_id, label, kind, authority_type, coordinator_id, group_id,
		membership_epoch, status, created_at, updated_at
	 ) VALUES ('scope-api', 'Engineering', 'team', 'coordinator',
	 'coordinator-private', 'group-private', 1, 'active', ?, ?)`).run(NOW, NOW);
	db.prepare(`INSERT INTO project_scope_mappings(
		workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
	 ) VALUES (?, ?, 'scope-api', 1000, 'test', ?, ?)`).run(PROJECT_ID, PROJECT_ID, NOW, NOW);
	const sessionId = Number(
		db
			.prepare(
				"INSERT INTO sessions(started_at, project, git_remote, git_branch) VALUES (?, 'api', ?, 'main')",
			)
			.run(NOW, PROJECT_ID).lastInsertRowid,
	);
	db.prepare(`INSERT INTO memory_items(
		session_id, kind, title, body_text, active, created_at, updated_at,
		visibility, project, scope_id
	 ) VALUES (?, 'discovery', 'api', 'body', 1, ?, ?, 'shared', 'api', 'scope-api')`).run(
		sessionId,
		NOW,
		NOW,
	);
}

function completeCandidate(db: InstanceType<typeof Database>): string {
	const [initial] = discoverLegacyTeamCandidates(db, discoveryOptions());
	if (!initial) throw new Error("candidate not discovered");
	const draft = db
		.prepare(
			"SELECT attempt_id, candidate_id, roster_fingerprint FROM legacy_team_setup_drafts WHERE candidate_id = ?",
		)
		.get(initial.candidateRef) as {
		attempt_id: string;
		candidate_id: string;
		roster_fingerprint: string;
	};
	const teamId = deterministicPolicyTeamId(draft.candidate_id);
	db.prepare(
		"UPDATE legacy_team_setup_draft_devices SET decision = 'excluded' WHERE attempt_id = ?",
	).run(draft.attempt_id);
	db.prepare(`INSERT INTO policy_teams(
		team_id, display_name, status, device_eligibility_mode, provenance,
		revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
	 ) VALUES (?, 'Engineering', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
	 'revision-1', 'completed', ?, 'team-setup-test', ?, ?)`).run(
		teamId,
		draft.roster_fingerprint,
		NOW,
		NOW,
	);
	db.prepare(`INSERT INTO policy_team_device_decisions(
		team_id, device_id, decision, assignment_version, provenance, revision, created_at, updated_at
	 ) VALUES (?, 'device-a', 'excluded', 0, 'reviewed_team_setup', 'r1', ?, ?)`).run(
		teamId,
		NOW,
		NOW,
	);
	db.prepare(`INSERT INTO project_recipients(
		canonical_project_identity, recipient_kind, recipient_id, status, provenance,
		policy_revision, migration_state, idempotency_key, created_at, updated_at
	 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'r1', 'completed',
	 'ready-edge', ?, ?)`).run(PROJECT_ID, teamId, NOW, NOW);
	db.prepare(`UPDATE legacy_team_setup_drafts
		SET state = 'completed', completed_team_id = ?, completed_at = ?, updated_at = ?
		WHERE attempt_id = ?`).run(teamId, NOW, NOW, draft.attempt_id);
	return teamId;
}

describe("legacy Team recipient repair policy wake", () => {
	it("wakes active policy maintenance after reactivating a revoked completed edge", () => {
		const db = new Database(":memory:");
		try {
			seedCandidateFixture(db);
			const teamId = completeCandidate(db);
			expect(discoverLegacyTeamCandidates(db, discoveryOptions())[0]?.status).toBe("ready");
			db.prepare(`INSERT INTO recipient_policy_authority_states(
				canonical_project_identity, authority_state, generation, state_changed_at,
				last_attempt_at, created_at, updated_at
			 ) VALUES (?, 'active', 1, ?, ?, ?, ?)`).run(PROJECT_ID, NOW, NOW, NOW, NOW);
			db.prepare(`UPDATE project_recipients SET status = 'revoked'
				WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = ?`).run(
				PROJECT_ID,
				teamId,
			);

			expect(discoverLegacyTeamCandidates(db, discoveryOptions())[0]?.status).toBe("ready");
			expect(
				db.prepare("SELECT last_attempt_at FROM recipient_policy_authority_states").pluck().get(),
			).toBeNull();
		} finally {
			db.close();
		}
	});
});
