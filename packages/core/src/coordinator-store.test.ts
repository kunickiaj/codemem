import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { runCoordinatorStoreContract } from "./coordinator-store-test-harness.js";

describe("CoordinatorStore", () => {
	function setupStore() {
		const tmpDir = mkdtempSync(join(tmpdir(), "coord-test-"));
		const store = new BetterSqliteCoordinatorStore(join(tmpDir, "coordinator.sqlite"));
		return {
			store,
			clearInviteReviewedIntent: (inviteId: string) => {
				store.db
					.prepare("UPDATE coordinator_invites SET reviewed_intent_json = NULL WHERE invite_id = ?")
					.run(inviteId);
			},
			revokeInvite: (inviteId: string, revokedAt: string) => {
				store.db
					.prepare("UPDATE coordinator_invites SET revoked_at = ? WHERE invite_id = ?")
					.run(revokedAt, inviteId);
			},
			cleanup: async () => {
				await store.close();
				rmSync(tmpDir, { recursive: true, force: true });
			},
		};
	}

	describe("schema", () => {
		it("upgrades an existing project-intent invite table additively", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "coord-upgrade-test-"));
			const path = join(tmpDir, "coordinator.sqlite");
			const legacy = new Database(path);
			legacy.exec(`
				CREATE TABLE coordinator_invites (
					invite_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
					policy TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
					created_by TEXT, team_name_snapshot TEXT, revoked_at TEXT, operation_id TEXT,
					reviewed_project_set_digest TEXT
				);
				INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at)
				VALUES ('legacy', 'g1', 'token', 'auto_admit', '2099-01-01T00:00:00Z',
					'2026-07-20T00:00:00Z');
			`);
			legacy.close();
			const store = new BetterSqliteCoordinatorStore(path);
			try {
				const row = store.db
					.prepare(
						`SELECT token, token_digest, consumed_at, bound_device_id, trust_state,
							invite_kind, policy_team_id, target_identity_id, reviewed_preview_digest,
							reviewed_intent_json
						 FROM coordinator_invites`,
					)
					.get();
				expect(row).toEqual({
					token: "token",
					token_digest: null,
					consumed_at: null,
					bound_device_id: null,
					trust_state: null,
					invite_kind: "legacy_enrollment",
					policy_team_id: null,
					target_identity_id: null,
					reviewed_preview_digest: null,
					reviewed_intent_json: null,
				});
			} finally {
				await store.close();
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("creates all expected tables", async () => {
			const { store, cleanup } = setupStore();
			try {
				const tables = store.db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
					)
					.all() as { name: string }[];
				const names = tables.map((t) => t.name).sort();
				expect(names).toEqual([
					"coordinator_bootstrap_grants",
					"coordinator_invites",
					"coordinator_join_requests",
					"coordinator_reciprocal_approvals",
					"coordinator_scope_membership_audit_log",
					"coordinator_scope_membership_effect_receipts",
					"coordinator_scope_memberships",
					"coordinator_scopes",
					"enrolled_devices",
					"groups",
					"presence_records",
					"request_nonces",
				]);
			} finally {
				await cleanup();
			}
		});

		it("backfills project invite columns before creating their index", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "coord-upgrade-test-"));
			const dbPath = join(tmpDir, "coordinator.sqlite");
			const legacy = new Database(dbPath);
			legacy.exec(`CREATE TABLE coordinator_invites (
				invite_id TEXT PRIMARY KEY,
				group_id TEXT NOT NULL,
				token TEXT NOT NULL UNIQUE,
				policy TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				created_at TEXT NOT NULL,
				created_by TEXT,
				team_name_snapshot TEXT,
				revoked_at TEXT
			)`);
			legacy.close();

			const store = new BetterSqliteCoordinatorStore(dbPath);
			try {
				const columns = store.db.prepare("PRAGMA table_info(coordinator_invites)").all() as Array<{
					name: string;
				}>;
				expect(columns.map((column) => column.name)).toEqual(
					expect.arrayContaining([
						"operation_id",
						"reviewed_project_set_digest",
						"reviewed_intent_json",
					]),
				);
				expect(
					store.db
						.prepare(
							"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_coordinator_invites_operation_id'",
						)
						.pluck()
						.get(),
				).toBe("idx_coordinator_invites_operation_id");
			} finally {
				await store.close();
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	runCoordinatorStoreContract("contract", setupStore);
});
