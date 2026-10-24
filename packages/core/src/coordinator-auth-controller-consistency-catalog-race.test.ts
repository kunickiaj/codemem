import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
	beforeControllerWrite,
	ordinaryReview,
} from "./coordinator-auth-controller-consistency-test-fixtures.js";
import type { Fixture } from "./coordinator-auth-store-test-fixtures.js";
import {
	databaseSnapshot,
	evidenceTest,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";

const indexName = "idx_legacy_owner_resolutions_key";

function state(f: Fixture) {
	return {
		catalog: f.db
			.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
			.all(),
		rows: databaseSnapshot(f),
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-23T00:00:00.000Z"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = evidenceTest(backend);
	describe(`${backend}: controller consistency catalog capture`, () => {
		test("accepts an unchanged supported catalog without changing other state", async ({ f }) => {
			// Arrange: no subject resolution means ordinary review is otherwise eligible.
			const input = await ordinaryReview(f);
			const before = state(f);
			// Act
			const result = await f.store.createAuthControllerAttestation(input);
			// Assert
			expect(result).toMatchObject({ kind: "created" });
			expect(state(f).catalog).toEqual(before.catalog);
			expect(
				databaseSnapshot(f).filter(([name]) => name !== "coordinator_auth_controller_attestations"),
			).toEqual(
				before.rows.filter(([name]) => name !== "coordinator_auth_controller_attestations"),
			);
		});

		test("never validates one catalog snapshot and pins another at the winning INSERT", async ({
			f,
		}) => {
			// Arrange: retain the exact installed DDL, then begin with an unsupported catalog.
			const definition = f.db
				.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
				.get(indexName) as { sql: string };
			const input = await ordinaryReview(f);
			f.db.exec(`DROP INDEX ${indexName}`);
			const prepare = f.db.prepare.bind(f.db);
			const transitions: string[] = [];
			let afterExternalChange = state(f);
			let winning: ReturnType<typeof beforeControllerWrite> | undefined;
			const capture = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
				const statement = prepare(sql);
				// Match the catalog read by subject and operation, not one SQL serialization.
				if (
					!/\bSELECT\b/iu.test(sql) ||
					!/\bFROM\s+sqlite_master\b/iu.test(sql) ||
					!sql.includes("coordinator_legacy_owner_resolutions")
				)
					return statement;
				const get = statement.get.bind(statement);
				vi.spyOn(statement, "get").mockImplementation((...values: unknown[]) => {
					const captured = get(...values);
					transitions.push("captured unsupported catalog");
					// Restore the prepare hook before installing the existing winning-write hook.
					capture.mockRestore();
					f.db.exec(definition.sql);
					transitions.push("restored required index");
					afterExternalChange = state(f);
					winning = beforeControllerWrite(f, () => {
						f.db.exec(`DROP INDEX ${indexName}`);
						transitions.push("removed index at winning INSERT");
						afterExternalChange = state(f);
					});
					return captured;
				});
				return statement;
			});
			// Act: return the first real read before making the second catalog read see ready.
			const result = await f.store.createAuthControllerAttestation(input);
			winning?.restore();
			// Assert: an early refusal is valid; reaching the INSERT must execute the second change.
			expect(transitions.slice(0, 2)).toEqual([
				"captured unsupported catalog",
				"restored required index",
			]);
			if (winning?.afterChange()) {
				expect(transitions).toEqual([
					"captured unsupported catalog",
					"restored required index",
					"removed index at winning INSERT",
				]);
			}
			expect(result).toMatchObject({ kind: "rejected" });
			if (winning?.afterChange()) expect(databaseSnapshot(f)).toEqual(winning.afterChange());
			expect(state(f)).toEqual(afterExternalChange);
		});
	});
}
