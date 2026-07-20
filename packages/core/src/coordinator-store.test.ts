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
			cleanup: async () => {
				await store.close();
				rmSync(tmpDir, { recursive: true, force: true });
			},
		};
	}

	describe("schema", () => {
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
					expect.arrayContaining(["operation_id", "reviewed_project_set_digest"]),
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
