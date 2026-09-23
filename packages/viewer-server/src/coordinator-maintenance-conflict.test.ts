import { initTestSchema, type MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { advancePendingProjectSharesOperation } from "./application/coordinator-maintenance.js";

it.each(["conflicting_repository_mappings", "project_mapping_conflict"])(
	"moves %s to explicit recovery",
	async (errorCode) => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const now = "2026-07-20T00:00:00Z";
			db.prepare(`INSERT INTO share_operations(
			operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
			person_kind, teammate_name, history_policy, reviewed_project_set_digest,
			coordinator_group_id, invite_token_digest, invite_expires_at, created_at, updated_at
		) VALUES ('share-conflicting-mappings', 'accepted', 'actor-local', '[]', 'person-conflict',
			'existing', 'Recipient', 'existing_and_future', 'digest-conflict',
			'team-a', 'token-conflict', '2099-01-01T00:00:00.000Z', ?, ?)`).run(now, now);
			db.prepare(`INSERT INTO share_operation_steps(
			operation_id, step_key, effect_id, status, attempt_count, updated_at
		) VALUES ('share-conflicting-mappings', 'invite_consumption',
			'invite-consumption:share-conflicting-mappings', 'pending', 0, ?)`).run(now);
			const store = { actorId: "actor-local", db } as unknown as MemoryStore;
			const advanceOperation = vi.fn(async () => {
				throw new Error(errorCode);
			});

			const result = await advancePendingProjectSharesOperation(store, {
				now: new Date("2026-07-20T01:00:00Z"),
				advanceOperation,
			});

			expect(result).toMatchObject({ processed: 1, attention: 1, failed: 0 });
			expect(result.items[0]).toMatchObject({ outcome: "needs_attention" });
			expect(db.prepare("SELECT state FROM share_operations").pluck().get()).toBe(
				"needs_attention",
			);
		} finally {
			db.close();
		}
	},
);
