import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLegacyRecipientPolicyProjections } from "./legacy-recipient-policy-projection.js";
import { analyzeProjectScopeMappingChangeGuardrails } from "./project-scope-settings.js";
import { countShareableProjectMemories, planShareProvisioning } from "./share-provisioning.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-09-22T12:00:00.000Z";
const CWD = "/workspace/api";
const REPOSITORY = "https://git.example.invalid/acme/api.git";
const SCOPE = "managed-project-api";

function insertLegacyMemory(db: InstanceType<typeof Database>): void {
	const sessionId = Number(
		db.prepare("INSERT INTO sessions(started_at, cwd, project) VALUES (?, ?, 'api')").run(NOW, CWD)
			.lastInsertRowid,
	);
	db.prepare(`INSERT INTO memory_items(
		session_id, kind, title, body_text, active, created_at, updated_at,
		metadata_json, import_key, rev, visibility, scope_id
	 ) VALUES (?, 'discovery', 'legacy', 'body', 1, ?, ?, '{}',
		'legacy:repository', 1, 'shared', ?)`).run(sessionId, NOW, NOW, SCOPE);
}

function insertRepositoryEvidence(db: InstanceType<typeof Database>): void {
	db.prepare(`INSERT INTO sessions(started_at, cwd, project, metadata_json)
		VALUES (?, ?, 'api', ?)`).run(
		NOW,
		CWD,
		JSON.stringify({ codemem_repository_identity: REPOSITORY }),
	);
}

function insertManagedMapping(db: InstanceType<typeof Database>): void {
	db.prepare(`INSERT INTO replication_scopes(
		scope_id, label, kind, authority_type, coordinator_id, group_id,
		membership_epoch, status, created_at, updated_at
	 ) VALUES (?, 'api', 'managed_project', 'coordinator', 'coordinator-a', 'group-a',
		1, 'active', ?, ?)`).run(SCOPE, NOW, NOW);
	db.prepare(`INSERT INTO project_scope_mappings(
		workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
	 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`).run(CWD, CWD, SCOPE, NOW, NOW);
	db.prepare(`INSERT INTO scope_memberships(
		scope_id, device_id, role, status, membership_epoch, updated_at
	 ) VALUES (?, 'device-local', 'member', 'active', 1, ?)`).run(SCOPE, NOW);
}

function insertRequestedScopes(db: InstanceType<typeof Database>): void {
	for (const scopeId of ["scope-a", "scope-b"]) {
		db.prepare(`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', 1, 'active', ?, ?)`).run(scopeId, scopeId, NOW, NOW);
	}
}

describe("pre-upgrade repository sharing", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		insertLegacyMemory(db);
		insertRepositoryEvidence(db);
	});

	afterEach(() => db.close());

	it("counts metadata-less memories under the recorded repository identity", () => {
		expect(
			countShareableProjectMemories(db, {
				canonicalIdentity: REPOSITORY,
				initiatingDeviceId: "device-local",
			}),
		).toBe(1);
	});

	it("does not materialize the cwd alias as a second policy Project", () => {
		db.prepare(`INSERT INTO actors(
			actor_id, display_name, is_local, status, created_at, updated_at
		 ) VALUES ('actor-local', 'Local', 1, 'active', ?, ?)`).run(NOW, NOW);
		insertManagedMapping(db);

		const result = listLegacyRecipientPolicyProjections(db, {
			localActorId: "actor-local",
			localDeviceId: "device-local",
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.project.canonicalIdentity).toBe(REPOSITORY);
		expect(result[0]?.conditions).not.toContainEqual(
			expect.objectContaining({ code: "ambiguous_multi_project_scope" }),
		);
	});

	it("rejects provisioning after sibling worktrees gain conflicting mappings", () => {
		const sibling = "/workspace/api-worktree";
		db.prepare(`INSERT INTO sessions(started_at, cwd, project, metadata_json)
			VALUES (?, ?, 'api', ?)`).run(
			NOW,
			sibling,
			JSON.stringify({ codemem_repository_identity: REPOSITORY }),
		);
		for (const [cwd, scope] of [
			[CWD, "scope-a"],
			[sibling, "scope-b"],
		]) {
			db.prepare(`INSERT INTO project_scope_mappings(
				workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`).run(cwd, cwd, scope, NOW, NOW);
		}
		db.prepare(`INSERT INTO share_operations(
			operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
			person_kind, teammate_name, history_policy, reviewed_project_set_digest,
			coordinator_group_id, invite_token_digest, invite_expires_at,
			recipient_actor_id, recipient_device_id, acceptance_consumed_at, created_at, updated_at
		 ) VALUES ('share-conflict', 'accepted', 'actor-owner', '["device-local"]',
			'actor-recipient', 'existing', 'Recipient', 'existing_and_future', 'digest',
			'group-a', 'invite-digest', '2099-01-01T00:00:00.000Z', 'actor-recipient',
			'recipient', ?, ?, ?)`).run(NOW, NOW, NOW);
		db.prepare(`INSERT INTO share_operation_projects(
			operation_id, canonical_project_identity, display_name, identity_source,
			existing_memory_count, ordinal
		 ) VALUES ('share-conflict', ?, 'api', 'git_repository', 1, 0)`).run(REPOSITORY);

		expect(() =>
			planShareProvisioning(db, {
				operationId: "share-conflict",
				initiatingDeviceId: "device-local",
			}),
		).toThrow("conflicting_repository_mappings");
	});
});

describe("requested repository mapping guardrails", () => {
	it("checks all mappings in a bulk request as one proposed state", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			insertRequestedScopes(db);
			const sibling = "/workspace/api-worktree";
			for (const cwd of [CWD, sibling]) {
				db.prepare(`INSERT INTO sessions(started_at, cwd, project, metadata_json)
					VALUES (?, ?, 'api', ?)`).run(
					NOW,
					cwd,
					JSON.stringify({ codemem_repository_identity: REPOSITORY }),
				);
			}
			const requestedMappings = [
				{ workspace_identity: CWD, project_pattern: CWD, scope_id: "scope-a" },
				{ workspace_identity: sibling, project_pattern: sibling, scope_id: "scope-b" },
			];
			const firstMapping = requestedMappings[0];
			if (!firstMapping) throw new Error("test mapping missing");

			const analysis = analyzeProjectScopeMappingChangeGuardrails(db, firstMapping, {
				requestedMappings,
			});

			expect(analysis.warnings).toContainEqual(
				expect.objectContaining({ code: "conflicting_repository_mappings" }),
			);
			const copiedSecond = analyzeProjectScopeMappingChangeGuardrails(
				db,
				{ ...requestedMappings[1] },
				{ requestedMappings },
			);
			expect(copiedSecond.requested_scope_id).toBe("scope-b");
		} finally {
			db.close();
		}
	});

	it("checks pattern-only mappings against every known repository", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			insertRequestedScopes(db);
			const sibling = "/workspace/api-worktree";
			for (const cwd of [CWD, sibling]) {
				db.prepare(`INSERT INTO sessions(started_at, cwd, project, metadata_json)
					VALUES (?, ?, 'api', ?)`).run(
					NOW,
					cwd,
					JSON.stringify({ codemem_repository_identity: REPOSITORY }),
				);
			}
			const requestedMappings = [
				{ project_pattern: CWD, scope_id: "scope-a" },
				{ project_pattern: sibling, scope_id: "scope-b" },
			];
			const firstMapping = requestedMappings[0];
			if (!firstMapping) throw new Error("test mapping missing");

			const analysis = analyzeProjectScopeMappingChangeGuardrails(db, firstMapping, {
				requestedMappings,
			});

			expect(analysis.warnings).toContainEqual(
				expect.objectContaining({
					code: "conflicting_repository_mappings",
					project_pattern: CWD,
				}),
			);
		} finally {
			db.close();
		}
	});
});
