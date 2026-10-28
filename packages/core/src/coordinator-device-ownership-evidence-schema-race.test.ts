import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import type { Backend, Fixture } from "./coordinator-auth-store-test-fixtures.js";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import {
	cfg,
	collectInput,
	databaseSnapshot,
	evidenceBackend,
	evidenceTest,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { readLegacyOwnerResolutionSchemaState } from "./coordinator-legacy-owner-resolution-metadata.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";

type CatalogRow = [type: string, name: string, table: string, sql: string];
const table = "coordinator_legacy_owner_resolutions";
const mutations = [
	{
		name: "immutable update trigger",
		object: "legacy_owner_resolution_immutable_update",
		sql: "DROP TRIGGER legacy_owner_resolution_immutable_update",
	},
	{
		name: "immutable delete trigger",
		object: "legacy_owner_resolution_immutable_delete",
		sql: "DROP TRIGGER legacy_owner_resolution_immutable_delete",
	},
	{
		name: "required device index",
		object: "idx_legacy_owner_resolutions_device",
		sql: "DROP INDEX idx_legacy_owner_resolutions_device",
	},
	{
		name: "extra attached trigger",
		object: "unexpected_resolution_trigger",
		sql: `CREATE TRIGGER unexpected_resolution_trigger AFTER INSERT ON ${table} BEGIN SELECT 1; END`,
	},
] as const;

function catalog(f: Fixture): CatalogRow[] {
	const rows = f.db
		.prepare(
			"SELECT json_array(type,name,tbl_name,sql) AS row FROM sqlite_master WHERE tbl_name=? AND sql IS NOT NULL ORDER BY row",
		)
		.all(table) as { row: string }[];
	return rows.map(({ row }) => JSON.parse(row) as CatalogRow);
}

// Interleave real DDL at query boundaries, never replace a database proof/result.
function observeCatalog(
	f: Fixture,
	backend: Backend,
	hooks: { afterReadiness?: () => void; afterCapture?: () => void } = {},
) {
	const actual = evidenceBackend(f, backend);
	const observed = {
		readiness: [] as { type: string; sql: string }[][],
		captured: [] as CatalogRow[][],
		atomic: [] as unknown[],
		events: [] as string[],
	};
	const db = {
		async first<T>(statement: AuthLinkStatement): Promise<T | null> {
			const result = await actual.first<T>(statement);
			if (statement.sql.includes("AS objects")) {
				const { objects } = result as { objects: string };
				observed.readiness.push(JSON.parse(objects));
				observed.events.push("readiness");
				if (observed.readiness.length === 1) hooks.afterReadiness?.();
			} else if (statement.sql.includes("AS matches")) {
				observed.atomic.push(result);
				observed.events.push("atomic");
			}
			return result;
		},
		async all<T>(statement: AuthLinkStatement): Promise<T[]> {
			const result = await actual.all<T>(statement);
			if (statement.sql.includes("json_array(type,name,tbl_name,sql)")) {
				observed.captured.push(
					(result as { category: string; row: string }[])
						.filter(({ category }) => category === "schema")
						.map(({ row }) => JSON.parse(row) as CatalogRow),
				);
				observed.events.push("capture");
				hooks.afterCapture?.();
			}
			return result;
		},
	};
	return { db, observed };
}

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = evidenceTest(backend);
	describe(`${backend}: validate the captured ownership schema`, () => {
		test.for(["canonical", "semantic whitespace", "unrelated catalog objects"])(
			"accepts a stable %s catalog without data writes",
			async (variant, { f }) => {
				// Arrange: normalization must preserve supported DDL and ignore other tables.
				if (variant === "semantic whitespace") {
					f.db.exec(`DROP TABLE ${table}`);
					f.db.exec(
						LEGACY_OWNER_RESOLUTION_SCHEMA_SQL.replaceAll(
							"CREATE ",
							"create /* supported catalog formatting */\n\t",
						),
					);
				}
				if (variant === "unrelated catalog objects") {
					f.db.exec(
						"CREATE TABLE unrelated_catalog (value TEXT); CREATE INDEX unrelated_index ON unrelated_catalog(value); CREATE TRIGGER unrelated_trigger AFTER INSERT ON unrelated_catalog BEGIN SELECT 1; END",
					);
				}
				const { db, observed } = observeCatalog(f, backend);
				const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
				const input = await collectInput(f);
				const before = databaseSnapshot(f);
				const expectedCatalog = catalog(f);
				expect(await readLegacyOwnerResolutionSchemaState(evidenceBackend(f, backend))).toBe(
					"ready",
				);
				// Act
				const result = await reader.collect(input);
				// Assert: real schema rows and the atomic comparison agree.
				expect(observed.captured).toEqual([expectedCatalog]);
				expect(observed.events).toEqual(["readiness", "capture", "atomic"]);
				expect(observed.atomic).toEqual([{ matches: 1 }]);
				expect(databaseSnapshot(f)).toEqual(before);
				expect(result).toMatchObject({ kind: "collected", decision: "compatible" });
			},
		);

		test.for(mutations)(
			"rejects $name changed after successful readiness but before capture",
			async (mutation, { f }) => {
				// Arrange: only actual catalog state changes, not query return values.
				const initialCatalog = catalog(f);
				let changedCatalog: CatalogRow[] = [];
				const { db, observed } = observeCatalog(f, backend, {
					afterReadiness: () => {
						f.db.exec(mutation.sql);
						changedCatalog = catalog(f);
					},
				});
				const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
				const input = await collectInput(f);
				const before = databaseSnapshot(f);
				expect(await readLegacyOwnerResolutionSchemaState(evidenceBackend(f, backend))).toBe(
					"ready",
				);
				// Act
				const result = await reader.collect(input);
				// Assert: unsupported captured rows must never become the accepted baseline.
				expect(observed.readiness[0]).toEqual(
					expect.arrayContaining(initialCatalog.map(([type, , , sql]) => ({ type, sql }))),
				);
				expect(changedCatalog).not.toEqual(initialCatalog);
				expect(observed.captured).toEqual([changedCatalog]);
				expect(await readLegacyOwnerResolutionSchemaState(evidenceBackend(f, backend))).toBe(
					"unsupported",
				);
				expect(databaseSnapshot(f)).toEqual(before);
				expect(result).toEqual({ kind: "unavailable", authorizationUnavailable: true });
			},
		);

		test.for([mutations[0], mutations[2]])(
			"rejects captured missing $name even when restored before the next read",
			async (mutation, { f }) => {
				// Arrange: a later ready catalog is not validation of the captured rowset.
				const initialCatalog = catalog(f);
				const { db, observed } = observeCatalog(f, backend, {
					afterReadiness: () => f.db.exec(mutation.sql),
					afterCapture: () => f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL),
				});
				const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
				const input = await collectInput(f);
				const before = databaseSnapshot(f);
				// Act
				const result = await reader.collect(input);
				// Assert: reject before an atomic mismatch could mask a later-schema reread.
				expect(observed.captured).toEqual([
					initialCatalog.filter(([, name]) => name !== mutation.object),
				]);
				expect(catalog(f)).toEqual(initialCatalog);
				expect(await readLegacyOwnerResolutionSchemaState(evidenceBackend(f, backend))).toBe(
					"ready",
				);
				expect(databaseSnapshot(f)).toEqual(before);
				expect(result).toEqual({ kind: "unavailable", authorizationUnavailable: true });
				expect(observed.atomic).toEqual([]);
			},
		);

		test("still rejects a catalog change after a supported schema capture", async ({ f }) => {
			// Arrange: validating captured definitions does not replace the atomic recheck.
			const initialCatalog = catalog(f);
			const { db, observed } = observeCatalog(f, backend, {
				afterCapture: () => f.db.exec(mutations[0].sql),
			});
			const reader = new CoordinatorDeviceOwnershipEvidence(db, cfg);
			const input = await collectInput(f);
			const before = databaseSnapshot(f);
			// Act
			const result = await reader.collect(input);
			// Assert
			expect(observed.captured).toEqual([initialCatalog]);
			expect(observed.atomic).toEqual([{ matches: 0 }]);
			expect(databaseSnapshot(f)).toEqual(before);
			expect(result).toEqual({ kind: "unavailable", authorizationUnavailable: true });
		});
	});
}
