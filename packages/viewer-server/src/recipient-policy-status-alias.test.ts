import { initTestSchema, type MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { listRecipientPolicyReconciliationStatus } from "./routes/sync.js";

it("shows one canonical status for a recipient alias and its authority", () => {
	const db = new Database(":memory:");
	const cwd = "/workspace/status-alias";
	const repository = "https://example.test/acme/status-alias.git";
	const now = "2026-07-22T10:00:00.000Z";
	try {
		initTestSchema(db);
		db.prepare(
			"INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, 'status-alias', ?)",
		).run(now, cwd, JSON.stringify({ codemem_repository_identity: repository }));
		db.prepare(`INSERT INTO project_recipients(
			canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			policy_revision, migration_state, idempotency_key, created_at, updated_at
		 ) VALUES (?, 'identity', 'recipient', 'active', 'test', '1', 'native', 'status-alias', ?, ?)`).run(
			cwd,
			now,
			now,
		);
		for (const [identity, state] of [
			[cwd, "legacy"],
			[repository, "active"],
		]) {
			db.prepare(`INSERT INTO recipient_policy_authority_states(
				canonical_project_identity, authority_state, generation, state_changed_at, created_at, updated_at
			 ) VALUES (?, ?, 1, ?, ?, ?)`).run(identity, state, now, now, now);
		}
		const store = { db } as unknown as MemoryStore;
		expect(listRecipientPolicyReconciliationStatus(store).items).toMatchObject([
			{ canonicalProjectIdentity: repository, state: "active" },
		]);
		db.prepare(
			"DELETE FROM recipient_policy_authority_states WHERE canonical_project_identity = ?",
		).run(repository);
		db.prepare(
			"UPDATE recipient_policy_authority_states SET authority_state = 'active' WHERE canonical_project_identity = ?",
		).run(cwd);
		expect(listRecipientPolicyReconciliationStatus(store).items).toMatchObject([
			{ canonicalProjectIdentity: repository, state: "active" },
		]);
	} finally {
		db.close();
	}
});
