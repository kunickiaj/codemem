import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "./peer-traversal-coordinator-schema.js";
import {
	advance,
	attemptRow,
	insertAttempt,
	type SchemaDatabase,
	schemaScenarios,
	seed,
	successor,
	updateAttempt,
	type Value,
} from "./peer-traversal-coordinator-schema-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";

const databases: Database.Database[] = [];
function fixture() {
	const native = new Database(":memory:");
	databases.push(native);
	native.pragma("foreign_keys = ON");
	const clock = { now: 1_800_000_000_000 as number | string | null };
	native.function("traversal_test_clock", () => {
		const value = clock.now;
		if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
		return value;
	});
	for (const sql of TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS) {
		// Replace only the shared exact expression, never a production clock option.
		native.exec(sql.replaceAll(RELAY_ADMISSION_CLOCK_SQL, "traversal_test_clock()"));
	}
	const bindings = (values: Value[]) =>
		Object.fromEntries(values.map((value, index) => [index + 1, value]));
	const execute = (sql: string, values: Value[] = []) => native.prepare(sql).run(bindings(values));
	const db: SchemaDatabase = {
		run: async (sql, values = []) => execute(sql, values),
		all: async (sql, values = []) =>
			native.prepare(sql).all(bindings(values)) as Record<string, Value>[],
		batch: async (statements) =>
			native.transaction(() => {
				for (const entry of statements) execute(entry.sql, entry.values);
			})(),
	};
	return { db, native, clock, authority: "0".repeat(64), now: Number(clock.now) };
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
schemaScenarios(async () => fixture());

describe("inert traversal definitions on disposable native SQLite", () => {
	it("exports frozen definitions and installs exactly four tables only on request", () => {
		const native = new Database(":memory:");
		databases.push(native);
		const before = native.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

		for (const sql of TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS) native.exec(sql);
		const tables = native
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all();

		expect(Object.isFrozen(TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS)).toBe(true);
		expect(before).toEqual([]);
		expect(tables).toEqual(
			[
				"traversal_attempts",
				"traversal_authority_policy",
				"traversal_readiness",
				"traversal_realms",
			].map((name) => ({ name })),
		);
	});
	it("cannot use definitions without explicitly installing them", () => {
		const native = new Database(":memory:");
		databases.push(native);

		const read = () => native.prepare("SELECT * FROM traversal_authority_policy").all();

		expect(read).toThrow(/no such table/);
	});
	it.each(["source_device_id", "target_device_id"] as const)(
		"uses a realm/device/phase/deadline index for %s",
		(column) => {
			// Identifiers are a literal allowlist.
			const f = fixture();

			const indexes = f.native
				.prepare("SELECT name FROM pragma_index_list('traversal_attempts')")
				.all() as { name: string }[];
			const layouts = indexes.map(({ name }) =>
				(
					f.native
						.prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
						.all({ 1: name }) as { name: string }[]
				).map((entry) => entry.name),
			);
			const plan = f.native
				.prepare(
					`EXPLAIN QUERY PLAN SELECT count(*) FROM traversal_attempts WHERE authority_id=?1 AND group_id=?2 AND ${column}=?3 AND phase<5 AND attempt_not_after*1000>?4`,
				)
				.all({ 1: f.authority, 2: "group", 3: "peer", 4: f.now }) as { detail: string }[];

			expect(layouts).toContainEqual([
				"authority_id",
				"group_id",
				column,
				"phase",
				"attempt_not_after",
			]);
			expect(plan.map((entry) => entry.detail).join(" ")).toMatch(
				/SEARCH.*USING (?:COVERING )?INDEX/i,
			);
			expect(plan.some((entry) => /SCAN traversal_attempts/i.test(entry.detail))).toBe(false);
		},
	);
});

describe("SQL clock boundaries on native SQLite", () => {
	it.each([-1, 0])(
		"counts live pairs only strictly before expiry (offset %s ms)",
		async (offset) => {
			const f = fixture();
			await seed(f);
			const row = attemptRow(f);
			await insertAttempt(f.db, row);
			f.clock.now = Number(row.attempt_not_after) * 1000 + offset;

			const result = insertAttempt(f.db, { ...row, session_id: "3".repeat(32) });

			if (offset < 0) await expect(result).rejects.toThrow();
			else await expect(result).resolves.toBeDefined();
		},
	);
	it.each([1, 5].flatMap((phase) => [-1, 0, 1].map((offset) => ({ phase, offset }))))(
		"allows phase $phase deletion only at expiry plus 120 seconds (offset $offset ms)",
		async ({ phase, offset }) => {
			const f = fixture();
			await seed(f);
			const row = attemptRow(f);
			await insertAttempt(f.db, row);
			await advance(f, row, phase);
			f.clock.now = (Number(row.attempt_not_after) + 120) * 1000 + offset;

			const result = f.db.run("DELETE FROM traversal_attempts WHERE session_id=?1", [
				row.session_id,
			]);

			if (offset < 0) await expect(result).rejects.toThrow();
			else await expect(result).resolves.toBeDefined();
		},
	);
	it.each([null, -1, Number.MAX_SAFE_INTEGER + 1, 1.5, "1800000000000"])(
		"fails closed for invalid SQL clock %s on inserts, updates and deletes",
		async (now) => {
			const f = fixture();
			await seed(f);
			const row = attemptRow(f);
			await insertAttempt(f.db, row);
			f.clock.now = now;

			// Valid row shapes cannot bypass quotas or retention with NULL comparisons.
			await expect(
				insertAttempt(f.db, { ...row, session_id: "3".repeat(32), target_device_id: "other" }),
			).rejects.toThrow();
			await expect(
				insertAttempt(f.db, {
					...row,
					session_id: "4".repeat(32),
					target_device_id: "historical",
					prepare_created_at: 0,
					attempt_not_after: 55,
				}),
			).rejects.toThrow();
			await expect(updateAttempt(f.db, row, successor(row))).rejects.toThrow();
			await expect(
				f.db.run("DELETE FROM traversal_attempts WHERE session_id=?1", [row.session_id]),
			).rejects.toThrow();
			expect(await f.db.all("SELECT * FROM traversal_attempts")).toEqual([row]);
		},
	);
	it("rejects update time before the prior update even when after creation", async () => {
		const f = fixture();
		await seed(f);
		const row = attemptRow(f);
		await insertAttempt(f.db, row);
		const second = successor(row, { updated_at_ms: f.now + 10 });
		await updateAttempt(f.db, row, second);

		const result = updateAttempt(f.db, second, successor(second, { updated_at_ms: f.now + 9 }));

		await expect(result).rejects.toThrow();
	});
});
