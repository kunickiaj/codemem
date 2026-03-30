import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
					"coordinator_invites",
					"coordinator_join_requests",
					"coordinator_reciprocal_approvals",
					"enrolled_devices",
					"groups",
					"presence_records",
					"request_nonces",
				]);
			} finally {
				await cleanup();
			}
		});
	});

	runCoordinatorStoreContract("contract", setupStore);
});
