import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { enroll, review, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	IDENTITY_GROUP_GRANT_RETRY_SQL,
	IDENTITY_GROUP_GRANT_SCHEMA_SQL,
} from "./coordinator-identity-group-grant.js";
import { registerGrantInputTests } from "./coordinator-identity-group-grant-input-test-harness.js";
import {
	contractHarness,
	registerIdentityGroupGrantContract,
} from "./coordinator-identity-group-grant-test-harness.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

it("keeps the grant table definition aligned across the module, Worker schema, and migration 0026", () => {
	// Arrange: read only the grant table, not unrelated schema definitions or comments.
	const workerSchema = readFileSync(
		new URL("../../cloudflare-coordinator-worker/schema.sql", import.meta.url),
		"utf8",
	);
	const migration = readFileSync(
		new URL(
			"../../cloudflare-coordinator-worker/migrations/0026_add_identity_group_grants.sql",
			import.meta.url,
		),
		"utf8",
	);
	const definition =
		/CREATE TABLE IF NOT EXISTS coordinator_identity_group_grants\s*\([\s\S]*?\);/u;
	// Act
	const tables = [IDENTITY_GROUP_GRANT_SCHEMA_SQL, workerSchema, migration].map((sql) =>
		sql.match(definition)?.[0].replace(/\s+/gu, " ").trim(),
	);
	// Assert: missing table definitions must not compare equal as undefined values.
	const [moduleTable, schemaTable, migrationTable] = tables;
	expect(moduleTable).toBeTypeOf("string");
	expect(schemaTable).toBe(moduleTable);
	expect(migrationTable).toBe(moduleTable);
});

describe.each(["SQLite", "D1"] as const)("%s identity group grant contract", (backend) => {
	const test = contractHarness(async (use) => {
		const fixture = setupStore(backend, { authClock: () => 1791028800000 });
		try {
			await use({
				store: fixture.store,
				review: review(),
				exec: async (sql, ...values) => {
					fixture.db.prepare(sql).run(...values);
				},
				rows: async (table) => fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
			});
		} finally {
			await fixture.store.close();
			if (fixture.db.open) fixture.db.close();
		}
	});
	registerIdentityGroupGrantContract(test);
	registerGrantInputTests(test);

	test("propagates insertion failures rather than claiming successful authority", async ({
		fixture: f,
	}) => {
		// Arrange: only a disposable fixture's grant insertion fails.
		await enroll(f.store);
		await f.store.createAuthControllerAttestation(f.review);
		await f.exec(`CREATE TEMP TRIGGER fail_grant_insert BEFORE INSERT ON coordinator_identity_group_grants
			BEGIN SELECT RAISE(ABORT, 'test grant insertion failure'); END;`);
		// Act
		const pending = f.store.issueIdentityGroupGrantFromControllerAttestation({
			coordinatorId: f.review.coordinatorId,
			attestationId: f.review.attestationId,
		});
		// Assert
		await expect(pending).rejects.toThrow(/^identity_group_grant_write_incomplete$/);
		expect(await f.store.listIdentityGroupGrantRevisions(f.review)).toEqual([]);
	});
});

describe("D1 identity group grant read guards", () => {
	it("checks current controller authority in the same final retry read", async () => {
		// Arrange
		const f = setupStore("D1");
		try {
			await enroll(f.store);
			await f.store.createAuthControllerAttestation(review());
			const input = { coordinatorId: "coordinator-a", attestationId: "attestation-a" };
			await f.store.issueIdentityGroupGrantFromControllerAttestation(input);
			const beforeRead = vi.fn((query: string) => {
				if (query !== IDENTITY_GROUP_GRANT_RETRY_SQL) return;
				f.db
					.prepare(
						"UPDATE coordinator_auth_controller_attestations SET revoked_at = ? WHERE coordinator_id = ?",
					)
					.run("2026-10-03T12:00:00.000Z", input.coordinatorId);
			});
			const racing = new D1CoordinatorStore(sqliteD1(f.db, { beforeRead }));
			// Act
			const retry = await racing.issueIdentityGroupGrantFromControllerAttestation(input);
			// Assert: a separately cached controller read would return stale success.
			expect(
				beforeRead.mock.calls.some(([query]) => query === IDENTITY_GROUP_GRANT_RETRY_SQL),
			).toBe(true);
			expect(retry).toMatchObject({ kind: "rejected" });
			expect(await racing.listIdentityGroupGrantRevisions(review())).toHaveLength(1);
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});

	it("recovers by exact retry after a backend read failure without duplicating the grant", async () => {
		// Arrange
		const f = setupStore("D1");
		try {
			await enroll(f.store);
			await f.store.createAuthControllerAttestation(review());
			const input = { coordinatorId: "coordinator-a", attestationId: "attestation-a" };
			await f.store.issueIdentityGroupGrantFromControllerAttestation(input);
			const beforeFirst = vi.fn().mockImplementationOnce(() => {
				throw new Error("test grant read failure");
			});
			const faulting = new D1CoordinatorStore(sqliteD1(f.db, { beforeFirst }));
			// Act
			const pending = faulting.issueIdentityGroupGrantFromControllerAttestation(input);
			// Assert
			await expect(pending).rejects.toThrow(/^identity_group_grant_write_incomplete$/);
			expect(await faulting.issueIdentityGroupGrantFromControllerAttestation(input)).toMatchObject({
				kind: "existing",
			});
			expect(await faulting.listIdentityGroupGrantRevisions(review())).toHaveLength(1);
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
});
