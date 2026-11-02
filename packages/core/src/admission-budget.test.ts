import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "./admission-budget-schema.js";
import {
	allocate,
	type BudgetDatabase,
	buckets,
	budgetFixture,
	compile,
	keyFor,
	registerBudgetScenarios,
	reserve,
	UNIT,
	updateRoot,
} from "./admission-budget-test-fixtures.js";
import type { Value } from "./peer-traversal-coordinator-schema-common-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";

const databases: Database.Database[] = [];
let sequence = 0;
async function create() {
	const native = new Database(":memory:");
	databases.push(native);
	native.pragma("foreign_keys=ON");
	const clock = { now: 1_800_000_000_000 as number | string | null };
	native.function("budget_test_clock", () => {
		if (typeof clock.now === "number" && Number.isInteger(clock.now)) return BigInt(clock.now);
		return clock.now;
	});
	const sql = (text: string) => text.replaceAll(RELAY_ADMISSION_CLOCK_SQL, "budget_test_clock()");
	for (const text of ADMISSION_BUDGET_SCHEMA_STATEMENTS) native.exec(sql(text));
	const bind = (values: readonly Value[]) =>
		Object.fromEntries(values.map((value, index) => [index + 1, value]));
	const run = (text: string, values: readonly Value[] = []) =>
		native.prepare(sql(text)).run(bind(values));
	const db: BudgetDatabase = {
		run: async (text, values) => run(text, values),
		all: async (text, values = []) =>
			native.prepare(sql(text)).all(bind(values)) as Record<string, Value>[],
		batch: async (statements) =>
			native.transaction(() => {
				for (const entry of statements) run(entry.sql, entry.values);
			})(),
		returning: async (statement) =>
			native.prepare(sql(statement.sql)).get(bind(statement.bindings)) ?? null,
	};
	return { ...budgetFixture(db, ++sequence, "b6a0"), clock };
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
registerBudgetScenarios(create);

describe("inert budget definitions", () => {
	it("exports frozen SQL and installs exactly two empty WITHOUT ROWID tables only on request", () => {
		const native = new Database(":memory:");
		databases.push(native);
		const before = native.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

		for (const sql of ADMISSION_BUDGET_SCHEMA_STATEMENTS) native.exec(sql);
		const tables = native
			.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string; sql: string }[];

		expect(Object.isFrozen(ADMISSION_BUDGET_SCHEMA_STATEMENTS)).toBe(true);
		expect(before).toEqual([]);
		expect(tables.map((row) => row.name)).toEqual([
			"admission_budget_allocations",
			"admission_budget_buckets",
		]);
		for (const table of tables) expect(table.sql).toMatch(/WITHOUT\s+ROWID/i);
		expect(native.prepare("SELECT * FROM admission_budget_allocations").all()).toEqual([]);
	});
	it("does not make an uninstalled reservation executable", async () => {
		const native = new Database(":memory:");
		databases.push(native);
		const f = await create();
		const statement = compile(f);

		const execute = () => native.prepare(statement.sql);

		expect(execute).toThrow(/no such table/);
	});
});

describe("exact integer refill and profile transitions", () => {
	it("retains every millisecond of fractional-token credit across repeated denied writes", async () => {
		const f = await create();
		await allocate(f);
		await reserve(f);
		const start = Number(f.clock.now);

		for (const delta of [1, 2, 59999, 60000]) {
			f.clock.now = start + delta;
			const result = await reserve(f);

			expect(result.receipt).toMatchObject({
				status: delta === 60000 ? "reserved" : "denied",
				units: delta === 60000 ? 0 : delta,
			});
			expect(result.receipt?.decidedAtMs).toBe(f.clock.now);
		}
	});
	it("settles elapsed time at the smaller old rate before saving an increased rate and capacity", async () => {
		const f = await create();
		await allocate(f, keyFor(f), 1, 2);
		await reserve(f);
		await reserve(f);
		f.clock.now = Number(f.clock.now) + 5000;
		await updateRoot(f, 10, 4);

		const changed = await reserve(f);
		f.clock.now = Number(f.clock.now) + 5500;
		const later = await reserve(f);

		expect(changed.receipt).toMatchObject({ status: "denied", units: 5000 });
		expect(later.receipt).toMatchObject({ status: "reserved", units: 0 });
		expect(await buckets(f)).toMatchObject([{ last_rate: 10, last_capacity: 4 * UNIT }]);
	});
	it("cannot retroactively refill a newly raised capacity above the old capacity or recover discarded credits", async () => {
		const f = await create();
		await allocate(f);
		await reserve(f);
		f.clock.now = Number(f.clock.now) + 240000;
		await updateRoot(f, 1, 4);

		const changed = await reserve(f);
		const immediate = await reserve(f);

		expect(changed.receipt).toMatchObject({ status: "reserved", units: 0 });
		expect(immediate.receipt).toMatchObject({ status: "denied", units: 0 });
	});
	it("settles disabled snapshots once, then resumes gradual refill without retroactive credit", async () => {
		const f = await create();
		await allocate(f);
		await reserve(f);
		await updateRoot(f, 0, 0);
		f.clock.now = Number(f.clock.now) + 60000;
		const paused = await reserve(f);
		f.clock.now = Number(f.clock.now) + 60000;
		await updateRoot(f, 1, 1);

		const enabled = await reserve(f);
		f.clock.now = Number(f.clock.now) + 59999;
		const partial = await reserve(f);
		f.clock.now = Number(f.clock.now) + 1;
		const full = await reserve(f);

		expect(paused.receipt).toMatchObject({ status: "denied", units: 0 });
		expect(enabled.receipt).toMatchObject({ status: "denied", units: 0 });
		expect(partial.receipt).toMatchObject({ status: "denied", units: 59999 });
		expect(full.receipt).toMatchObject({ status: "reserved", units: 0 });
	});
});

describe("invalid SQL clocks fail closed", () => {
	it.each(
		[null, "1800000000000", 1.5, -1, Number.MAX_SAFE_INTEGER + 1, 1_799_999_999_999].flatMap(
			(now) => [false, true].map((disabled) => ({ now, disabled })),
		),
	)(
		"returns no receipt for clock $now (disabled=$disabled) and preserves existing stored state",
		async ({ now, disabled }) => {
			const f = await create();
			const rate = disabled ? 0 : 1;
			await allocate(f, keyFor(f), rate, rate);
			await reserve(f);
			const before = await buckets(f);
			f.clock.now = now;

			const result = await reserve(f);

			expect(result.row).toBeNull();
			expect(result.receipt).toBeNull();
			expect(await buckets(f)).toEqual(before);
		},
	);
	it.each(
		[null, "1800000000000", 1.5, -1, Number.MAX_SAFE_INTEGER + 1].flatMap((now) =>
			[false, true].map((disabled) => ({ now, disabled })),
		),
	)(
		"cannot create a bucket with invalid initial clock $now (disabled=$disabled)",
		async ({ now, disabled }) => {
			const f = await create();
			const rate = disabled ? 0 : 1;
			await allocate(f, keyFor(f), rate, rate);
			f.clock.now = now;

			const result = await reserve(f);

			expect(result.row).toBeNull();
			expect(result.receipt).toBeNull();
			expect(await buckets(f)).toEqual([]);
		},
	);
	it.each([0, Number.MAX_SAFE_INTEGER])(
		"accepts safe inclusive SQL clock boundary %s",
		async (now) => {
			const f = await create();
			await allocate(f);
			f.clock.now = now;

			const result = await reserve(f);

			expect(result.receipt).toEqual({ status: "reserved", units: 0, decidedAtMs: now });
		},
	);
});
