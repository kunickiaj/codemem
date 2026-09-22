import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLegacyRecipientPolicyProjections } from "./legacy-recipient-policy-projection.js";
import { countShareableProjectMemories } from "./share-provisioning.js";
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
});
