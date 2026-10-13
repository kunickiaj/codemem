import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

const TABLE = "coordinator_owner_enrollment_audit_log";
const auditRow = {
	coordinator_id: "coordinator-a",
	event_id: "event-a",
	attempt_id: "attempt-a",
	action: "owner_device_enrolled",
	binding_id: "binding-a",
	device_id: "device-a",
	created_at_ms: 1_700_000_000_000,
};
type AuditRow = Record<keyof typeof auditRow, string | number | null>;

function insertAudit(row: AuditRow = auditRow) {
	const entries = Object.entries(row);
	return env.COORDINATOR_DB.prepare(
		`INSERT INTO ${TABLE} (${entries.map(([column]) => column).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
	)
		.bind(...entries.map(([, value]) => value))
		.run();
}

async function auditRows() {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM ${TABLE} ORDER BY coordinator_id, event_id`,
		).all<AuditRow>()
	).results;
}

// The setup file applies TEST_MIGRATIONS in full; no private audit DDL is injected.
const test = it.extend<{ auditFixture: void }>({
	auditFixture: async ({ task: _task }, use) => {
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await env.COORDINATOR_DB.prepare(`DELETE FROM ${TABLE}`).run();
			await use();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.prepare(`DELETE FROM ${TABLE}`).run();
		}
	},
});

describe("native D1 owner audit migration", () => {
	test("the full migration chain creates the required audit columns", async ({ auditFixture }) => {
		// Arrange: rely only on the officially migrated database.
		void auditFixture;
		const migrationNames = env.TEST_MIGRATIONS.map(({ name }) => name);

		// Act: inspect the resulting schema rather than recreating it in a fixture.
		const columns = await env.COORDINATOR_DB.prepare(`PRAGMA table_info(${TABLE})`).all<{
			name: string;
			type: string;
			notnull: number;
			pk: number;
		}>();

		// Assert: every persisted audit fact is required, including the composite event key.
		expect(migrationNames).toContain("0031_add_owner_enrollment_audit_log.sql");
		expect(
			columns.results.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
		).toEqual([
			{ name: "coordinator_id", type: "TEXT", notnull: 1, pk: 1 },
			{ name: "event_id", type: "TEXT", notnull: 1, pk: 2 },
			{ name: "attempt_id", type: "TEXT", notnull: 1, pk: 0 },
			{ name: "action", type: "TEXT", notnull: 1, pk: 0 },
			{ name: "binding_id", type: "TEXT", notnull: 1, pk: 0 },
			{ name: "device_id", type: "TEXT", notnull: 1, pk: 0 },
			{ name: "created_at_ms", type: "INTEGER", notnull: 1, pk: 0 },
		]);
	});

	test("distinct attempts and events succeed and their IDs can repeat across coordinators", async ({
		auditFixture,
	}) => {
		// Arrange: audit uniqueness must not cross coordinator boundaries.
		void auditFixture;
		const distinct = { ...auditRow, event_id: "event-b", attempt_id: "attempt-b" };
		const otherCoordinator = { ...auditRow, coordinator_id: "coordinator-b" };

		// Act.
		await insertAudit();
		await insertAudit(distinct);
		await insertAudit(otherCoordinator);

		// Assert: repeated action, binding and device are not extra uniqueness constraints.
		expect(await auditRows()).toEqual([auditRow, distinct, otherCoordinator]);
	});

	test.for([
		{ event_id: "event-b", attempt_id: "attempt-a" },
		{ event_id: "event-a", attempt_id: "attempt-b" },
		{ event_id: "event-a", attempt_id: "attempt-a" },
	])(
		"rejects coordinator-local audit identity collision %j",
		async (identity, { auditFixture }) => {
			// Arrange: retain the original audit event even when the competing facts differ.
			void auditFixture;
			await insertAudit();
			const duplicate = {
				...auditRow,
				...identity,
				binding_id: "binding-b",
				device_id: "device-b",
			};

			// Act / Assert: both the event primary key and attempt uniqueness reject duplicates.
			await expect(insertAudit(duplicate)).rejects.toThrow(/UNIQUE constraint failed/);
			expect(await auditRows()).toEqual([auditRow]);
		},
	);

	test.for(["owner_device_revoked", "", "OWNER_DEVICE_ENROLLED"])(
		"rejects unsupported audit action %j",
		async (action, { auditFixture }) => {
			// Arrange.
			void auditFixture;
			const invalid = { ...auditRow, action };

			// Act / Assert: only the enrollment action is allowed and failure leaves no row.
			await expect(insertAudit(invalid)).rejects.toThrow(/CHECK constraint failed/);
			expect(await auditRows()).toEqual([]);
		},
	);

	test.for(Object.keys(auditRow) as (keyof AuditRow)[])(
		"rejects a missing required audit fact: %s",
		async (column, { auditFixture }) => {
			// Arrange.
			void auditFixture;
			const invalid = { ...auditRow, [column]: null };

			// Act / Assert: no partial audit event can be persisted.
			await expect(insertAudit(invalid)).rejects.toThrow(/NOT NULL constraint failed/);
			expect(await auditRows()).toEqual([]);
		},
	);

	test("reapplying migrations retains audit rows and duplicate protection", async ({
		auditFixture,
	}) => {
		// Arrange: seed an event in the table created by the full migration chain.
		void auditFixture;
		await insertAudit();
		const migration = env.TEST_MIGRATIONS.find(
			({ name }) => name === "0031_add_owner_enrollment_audit_log.sql",
		);
		if (!migration) throw new Error("Missing owner audit migration fixture");

		// Act: test both migration bookkeeping and repeated execution of the migration DDL.
		await applyD1Migrations(env.COORDINATOR_DB, env.TEST_MIGRATIONS);
		await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));

		// Assert: repeat application neither erases the event nor weakens its constraints.
		expect(await auditRows()).toEqual([auditRow]);
		await expect(insertAudit()).rejects.toThrow(/UNIQUE constraint failed/);
		expect(await auditRows()).toEqual([auditRow]);
	});
});
