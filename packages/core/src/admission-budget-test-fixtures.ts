import { describe, expect, it } from "vitest";
import {
	type AdmissionBudgetKey,
	type AdmissionBudgetReservationStatement,
	buildAdmissionBudgetReservationStatement,
	readAdmissionBudgetReservationReceipt,
} from "./admission-budget.js";
import {
	ALLOCATION,
	allocate,
	allocationKeyFor,
	MAX_BURST,
	registerAllocationScenarios,
	updateRoot,
} from "./admission-budget-allocation-schema-test-fixtures.js";
import type { SchemaDatabase } from "./peer-traversal-coordinator-schema-common-test-fixtures.js";

export {
	ALLOCATION,
	allocate,
	MAX_BURST,
	updateRoot,
} from "./admission-budget-allocation-schema-test-fixtures.js";

export const UNIT = 60000;
export const MAX_CAPACITY = MAX_BURST * UNIT;
export interface BudgetDatabase extends SchemaDatabase {
	returning(statement: AdmissionBudgetReservationStatement): Promise<unknown>;
}
export function budgetFixture(db: BudgetDatabase, id: number, prefix: "b6a0" | "b6d1") {
	let execution = 0;
	return {
		db,
		authority: `${prefix}${id.toString(16).padStart(60, "0")}`,
		group: `budget-${id}`,
		nextExecId: () =>
			`${id.toString(16).padStart(24, "0")}${(++execution).toString(16).padStart(8, "0")}`,
	};
}
export type BudgetFixture = ReturnType<typeof budgetFixture>;
type Create = () => Promise<BudgetFixture>;
export function keyFor(
	f: BudgetFixture,
	changes: Partial<AdmissionBudgetKey> = {},
): AdmissionBudgetKey {
	return { ...allocationKeyFor(f), deviceId: "", ...changes };
}
export function compile(f: BudgetFixture, key = keyFor(f)) {
	const statement = buildAdmissionBudgetReservationStatement({ ...key, execId: f.nextExecId() });
	if (!statement) throw new Error("valid budget key rejected");
	return statement;
}
export async function reserve(f: BudgetFixture, key = keyFor(f)) {
	const statement = compile(f, key);
	const row = await f.db.returning(statement);
	return { statement, row, receipt: readAdmissionBudgetReservationReceipt(row, statement) };
}
export const buckets = (f: BudgetFixture) =>
	f.db.all("SELECT * FROM admission_budget_buckets WHERE authority_id=?1", [f.authority]);
export async function historicalBucket(f: BudgetFixture, rate: number, capacity: number) {
	await f.db.run(
		"INSERT INTO admission_budget_buckets(authority_id,pool,audience_id,group_id,device_id,units,refilled_at_ms,last_rate,last_capacity,exec_id,granted) VALUES (?1,'authority','','','',0,0,?2,?3,?4,0)",
		[f.authority, rate, capacity, f.nextExecId()],
	);
}

// The aggregate suite includes the independently executable allocation scenarios.
export function registerBudgetScenarios(create: Create) {
	registerAllocationScenarios(create);
	describe("atomic stored budget reservations", () => {
		registerDisabledAndMissing(create);
		registerAllocationReservations(create);
		registerBurst(create);
		registerConcurrentBurst(create);
		registerScopes(create);
		registerSnapshotChanges(create);
		registerBucketConstraints(create);
		registerBucketPermanence(create);
		registerDeviceBucketShapes(create);
		registerIntegerOverflow(create);
		registerCompilerInputs(create);
		registerReceiptShapes(create);
	});
}
function registerDisabledAndMissing(create: Create) {
	it("defaults to a disabled profile, returning denied while missing profiles return unknown without a bucket", async () => {
		const f = await create();
		const missing = await reserve(f);
		expect(missing.row).toBeNull();
		expect(missing.receipt).toBeNull();
		expect(await buckets(f)).toEqual([]);
		await f.db.run(
			"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id) VALUES (?1,'authority','','')",
			[f.authority],
		);

		const disabled = await reserve(f);

		expect(disabled.receipt).toMatchObject({ status: "denied", units: 0 });
		expect(await buckets(f)).toMatchObject([
			{ last_rate: 0, last_capacity: 0, units: 0, granted: 0 },
		]);
	});
}
function registerAllocationReservations(create: Create) {
	it("reserves from a realm after its matching pool parent has been installed", async () => {
		const f = await create();
		await allocate(f, keyFor(f), 10, 10);
		const realm = keyFor(f, { pool: "relay-route", audienceId: "a".repeat(64), groupId: f.group });
		await expect(allocate(f, realm)).rejects.toThrow();
		await allocate(f, { ...realm, groupId: "" });
		await allocate(f, realm);

		const result = await reserve(f, realm);

		expect(result.receipt?.status).toBe("reserved");
	});
	it("reserves a device scope independently from disabled authority capacity", async () => {
		const f = await create();
		await allocate(f, keyFor(f), 0, 0);
		await allocate(f, keyFor(f, { pool: "device" }), 96, 16);
		await allocate(f, keyFor(f, { pool: "device-registration" }), 2, 2);

		const result = await reserve(
			f,
			keyFor(f, { pool: "device", groupId: f.group, deviceId: "peer" }),
		);

		expect(result.receipt?.status).toBe("reserved");
	});
	it("preserves an enabled reservation after rejected allocation collisions and deletion", async () => {
		const f = await create();
		await allocate(f);
		const values = [f.authority, "authority", "", "", 1, 1];
		const variants = [
			ALLOCATION,
			ALLOCATION.replace("INSERT", "INSERT OR REPLACE"),
			ALLOCATION.replace("INSERT", "INSERT OR IGNORE"),
			`${ALLOCATION} ON CONFLICT DO NOTHING`,
			`${ALLOCATION} ON CONFLICT DO UPDATE SET burst=excluded.burst`,
		];
		for (const sql of variants) await expect(f.db.run(sql, values)).rejects.toThrow();
		await expect(
			f.db.run("DELETE FROM admission_budget_allocations WHERE authority_id=?1", [f.authority]),
		).rejects.toThrow();

		const result = await reserve(f);

		expect(result.receipt?.status).toBe("reserved");
	});
}
function registerBurst(create: Create) {
	it("exhausts a stored burst and never resets it through fresh compiled statements", async () => {
		const f = await create();
		await allocate(f, keyFor(f), 1, 2);

		const results = [await reserve(f), await reserve(f), await reserve(f), await reserve(f)];

		expect(results.map((result) => result.receipt?.status)).toEqual([
			"reserved",
			"reserved",
			"denied",
			"denied",
		]);
		expect(results[0]?.receipt?.units).toBe(UNIT);
		expect(await buckets(f)).toHaveLength(1);
	});
}
function registerConcurrentBurst(create: Create) {
	it("atomically grants exactly sixteen of twenty concurrent reservations at one unit/minute refill", async () => {
		const f = await create();
		await allocate(f, keyFor(f), 1, 16);

		const results = await Promise.all(Array.from({ length: 20 }, () => reserve(f)));

		expect(results.filter((result) => result.receipt?.status === "reserved")).toHaveLength(16);
		expect(results.filter((result) => result.receipt?.status === "denied")).toHaveLength(4);
		expect(await buckets(f)).toHaveLength(1);
	});
}
async function scopeKeys(f: BudgetFixture) {
	await allocate(f, keyFor(f), 16, 16);
	const keys: AdmissionBudgetKey[] = [keyFor(f)];
	for (const pool of ["relay-route", "relay-registration", "traversal"] as const) {
		const parent = keyFor(f, { pool, audienceId: pool === "traversal" ? "" : "a".repeat(64) });
		await allocate(f, parent);
		const realm = { ...parent, groupId: "é".repeat(64) };
		await allocate(f, realm);
		keys.push(parent, realm);
	}
	for (const pool of ["device", "device-registration"] as const) {
		await allocate(f, keyFor(f, { pool }));
		keys.push(keyFor(f, { pool, groupId: f.group, deviceId: "peer" }));
	}
	return keys;
}
function registerScopes(create: Create) {
	it("uses one static statement for all scopes and maps device realm buckets to the empty-group policy", async () => {
		const f = await create();
		const keys = await scopeKeys(f);

		const results = await Promise.all(keys.map((key) => reserve(f, key)));

		expect(new Set(results.map((result) => result.statement.sql)).size).toBe(1);
		expect(results.map((result) => result.receipt?.status)).toEqual(keys.map(() => "reserved"));
		expect((await buckets(f)).filter((row) => row.pool === "device")).toMatchObject([
			{ audience_id: "", group_id: f.group, device_id: "peer" },
		]);
	});
	it("binds SQL-looking realm text as data without modifying any schema", async () => {
		const f = await create();
		const parent = keyFor(f, { pool: "traversal" });
		await allocate(f);
		await allocate(f, parent);
		const key = { ...parent, groupId: "x'); DROP TABLE admission_budget_allocations;--" };
		await allocate(f, key);

		const result = await reserve(f, key);

		expect(result.receipt?.status).toBe("reserved");
		expect(result.statement.sql).not.toContain(key.groupId);
		expect(
			await f.db.all("SELECT pool FROM admission_budget_allocations WHERE authority_id=?1", [
				f.authority,
			]),
		).toHaveLength(3);
	});
}
function registerSnapshotChanges(create: Create) {
	it("reads a lowered current capacity in the write and clamps balance before debit", async () => {
		const f = await create();
		await allocate(f, keyFor(f), 1, 4);
		await reserve(f);
		const statement = compile(f);
		await updateRoot(f, 1, 1);

		const row = await f.db.returning(statement);

		expect(readAdmissionBudgetReservationReceipt(row, statement)).toMatchObject({
			status: "reserved",
			units: 0,
		});
		expect((await reserve(f)).receipt?.status).toBe("denied");
	});
	it("warms disabled snapshots without minting immediate credits when a profile is enabled", async () => {
		const f = await create();
		await allocate(f, keyFor(f), 0, 0);
		await reserve(f);
		await updateRoot(f, 1, 2);

		const result = await reserve(f);

		expect(result.receipt).toMatchObject({ status: "denied", units: 0 });
		expect(await buckets(f)).toMatchObject([
			{ last_rate: 1, last_capacity: 2 * UNIT, units: 0, granted: 0 },
		]);
	});
}
const BAD_BUCKET_UPDATES = [
	["units", -1],
	["units", 0.5],
	["units", Number.MAX_SAFE_INTEGER + 1],
	["units", 2 * UNIT],
	["refilled_at_ms", -1],
	["refilled_at_ms", 0.5],
	["refilled_at_ms", Number.MAX_SAFE_INTEGER + 1],
	["last_rate", -1],
	["last_rate", 0.5],
	["last_rate", 0],
	["last_capacity", 1],
	["last_capacity", Number.MAX_SAFE_INTEGER + 1],
	["last_capacity", 0],
	["granted", 2],
	["granted", null],
	["granted", 0],
	["exec_id", "A".repeat(32)],
] as const;
function registerBucketConstraints(create: Create) {
	it.each(BAD_BUCKET_UPDATES)("rejects malformed stored bucket %s=%s", async (column, value) => {
		const f = await create();
		await allocate(f, keyFor(f), 1, 2);
		await reserve(f);
		const before = await buckets(f);
		// Column identifiers are the fixed matrix above. Values and execution IDs are bound.
		const sql = `UPDATE admission_budget_buckets SET ${column}=?2,exec_id=?3 WHERE authority_id=?1`;
		const actual =
			column === "exec_id"
				? "UPDATE admission_budget_buckets SET exec_id=?2 WHERE authority_id=?1"
				: sql;

		await expect(
			f.db.run(
				actual,
				column === "exec_id" ? [f.authority, value] : [f.authority, value, f.nextExecId()],
			),
		).rejects.toThrow();
		expect(await buckets(f)).toEqual(before);
	});
}
function registerBucketPermanence(create: Create) {
	it("protects bucket keys, execution freshness, refill monotonicity and permanent rows", async () => {
		const f = await create();
		await allocate(f);
		await allocate(f, keyFor(f, { pool: "device" }));
		const key = keyFor(f, { pool: "device", groupId: f.group, deviceId: "peer" });
		await reserve(f, key);
		const before = await buckets(f);

		const changes = [
			"UPDATE admission_budget_buckets SET group_id='other',exec_id=?2 WHERE authority_id=?1",
			"UPDATE admission_budget_buckets SET device_id='other',exec_id=?2 WHERE authority_id=?1",
			"UPDATE admission_budget_buckets SET refilled_at_ms=refilled_at_ms-1,exec_id=?2 WHERE authority_id=?1",
			"UPDATE admission_budget_buckets SET exec_id=exec_id WHERE authority_id=?1",
			"DELETE FROM admission_budget_buckets WHERE authority_id=?1",
		];
		for (const sql of changes)
			await expect(
				f.db.run(sql, sql.includes("?2") ? [f.authority, f.nextExecId()] : [f.authority]),
			).rejects.toThrow();
		expect(await buckets(f)).toEqual(before);
	});
}
function registerDeviceBucketShapes(create: Create) {
	it.each([
		{ groupId: "", deviceId: "peer" },
		...["", "a b", "é", "a\0b", "a".repeat(65)].map((deviceId) => ({ groupId: "realm", deviceId })),
	])("rejects malformed stored device scope %j", async ({ groupId, deviceId }) => {
		const f = await create();
		await allocate(f);
		await allocate(f, keyFor(f, { pool: "device" }));

		const attempt = f.db.run(
			"INSERT INTO admission_budget_buckets(authority_id,pool,audience_id,group_id,device_id,units,refilled_at_ms,last_rate,last_capacity,exec_id,granted) VALUES (?1,'device','',?2,?3,0,0,1,60000,?4,0)",
			[f.authority, groupId, deviceId, f.nextExecId()],
		);

		await expect(attempt).rejects.toThrow();
		expect(await buckets(f)).toEqual([]);
	});
}
function registerIntegerOverflow(create: Create) {
	it("settles MAX rate/capacity after a long idle with integer arithmetic before multiplication", async () => {
		const f = await create();
		await allocate(f, keyFor(f), Number.MAX_SAFE_INTEGER, MAX_BURST);
		await historicalBucket(f, Number.MAX_SAFE_INTEGER, MAX_CAPACITY);

		const result = await reserve(f);

		expect(result.receipt).toMatchObject({ status: "reserved", units: MAX_CAPACITY - UNIT });
		expect(
			await f.db.all(
				"SELECT typeof(units) AS unitsType,typeof(last_rate) AS rateType,typeof(last_capacity) AS capType FROM admission_budget_buckets WHERE authority_id=?1",
				[f.authority],
			),
		).toEqual([{ unitsType: "integer", rateType: "integer", capType: "integer" }]);
	});
}
const BAD_KEYS: Record<string, unknown>[] = [
	{ authorityId: "A".repeat(64) },
	{ authorityId: "a".repeat(63) },
	{ pool: "unknown" },
	{ audienceId: "a".repeat(64) },
	{ groupId: "" },
	{ groupId: " group" },
	{ groupId: "group " },
	{ groupId: "a\0b" },
	{ groupId: "a\x1fb" },
	{ groupId: "a\x7fb" },
	{ groupId: "\ud800" },
	{ groupId: "é".repeat(65) },
	{ deviceId: "" },
	{ deviceId: "a b" },
	{ deviceId: "é" },
	{ deviceId: "a".repeat(65) },
	{ execId: null },
	{ execId: "A".repeat(32) },
	{ execId: "a".repeat(31) },
	{ pool: "authority", audienceId: "", groupId: "", deviceId: "peer" },
	{ pool: "authority", audienceId: "", groupId: "realm", deviceId: "" },
	{ pool: "relay-route", audienceId: "", groupId: "", deviceId: "" },
	{ pool: "traversal", audienceId: "", groupId: "", deviceId: "peer" },
];
function registerCompilerInputs(create: Create) {
	it.each(BAD_KEYS)("rejects malformed reservation keys %j", async (changes) => {
		const f = await create();
		const options = {
			...keyFor(f, { pool: "device", groupId: f.group, deviceId: "peer" }),
			execId: f.nextExecId(),
		};
		for (const [field, value] of Object.entries(changes)) Reflect.set(options, field, value);

		const result = buildAdmissionBudgetReservationStatement(options);

		expect(result).toBeNull();
		expect(await buckets(f)).toEqual([]);
	});
	it("captures frozen keys and cannot accept caller rate, capacity or clock overrides", async () => {
		const f = await create();
		await allocate(f, keyFor(f), 0, 0);
		const options = { ...keyFor(f), execId: f.nextExecId() };
		const expected = { ...options };
		const statement = buildAdmissionBudgetReservationStatement(options);
		if (!statement) throw new Error("valid immutable compiler input rejected");
		Object.assign(options, { authorityId: "0".repeat(64), execId: f.nextExecId() });

		expect(statement.association).toEqual(expected);
		expect(Object.isFrozen(statement.association)).toBe(true);
		expect(Object.isFrozen(statement.bindings)).toBe(true);
		const claimed = {
			...expected,
			ratePerMin: Number.MAX_SAFE_INTEGER,
			burst: 16,
			nowMs: 0,
			keyId: "0".repeat(64),
			policyRevision: 99,
			ingressKey: "other",
			protocol: "relay",
		};
		const override = buildAdmissionBudgetReservationStatement(claimed);
		if (!override) return;
		expect(override.sql).toBe(statement.sql);
		expect(override.bindings).toEqual(statement.bindings);
		expect(
			readAdmissionBudgetReservationReceipt(await f.db.returning(override), override),
		).toMatchObject({ status: "denied", units: 0 });
	});
}
function registerReceiptShapes(create: Create) {
	it("accepts only its own singular raw receipt and rejects bad associations, clocks, balances, snapshots and grant flags", async () => {
		const f = await create();
		await allocate(f);
		const { statement, row, receipt } = await reserve(f);
		if (!row || typeof row !== "object") throw new Error("missing raw receipt fixture");
		const bad = [
			null,
			undefined,
			[],
			[row],
			[row, row],
			{ results: [row] },
			...Object.entries({
				authorityId: "0".repeat(64),
				pool: "device",
				audienceId: "a".repeat(64),
				groupId: "other",
				deviceId: "other",
				execId: f.nextExecId(),
				decidedAtMs: null,
				granted: 2,
				units: -1,
				ratePerMin: 0,
				capacityUnits: 1,
			}).map(([field, value]) => ({ ...row, [field]: value })),
			{ ...row, granted: 0, units: UNIT },
			{ ...row, granted: 1, units: UNIT },
			{ ...row, granted: 1, ratePerMin: 0, capacityUnits: 0, units: 0 },
			{ ...row, granted: 0, ratePerMin: 0, units: 0 },
			...[0.5, -1, null, "1", Number.MAX_SAFE_INTEGER + 1].map((value) => ({
				...row,
				ratePerMin: value,
			})),
			...[0.5, -1, Number.MAX_SAFE_INTEGER + 1, "1"].map((value) => ({
				...row,
				decidedAtMs: value,
			})),
			...[0.5, Number.MAX_SAFE_INTEGER + 1, "0"].map((value) => ({ ...row, units: value })),
			{ ...row, capacityUnits: Number.MAX_SAFE_INTEGER + 1 },
			{ ...row, granted: "1" },
			{ ...row, granted: null },
		];

		const results = bad.map((value) => readAdmissionBudgetReservationReceipt(value, statement));

		expect(receipt).toMatchObject({ status: "reserved", units: 0 });
		expect(Number.isSafeInteger(receipt?.decidedAtMs)).toBe(true);
		expect(results).toEqual(bad.map(() => null));
		let reads = 0;
		const changing = Object.defineProperty({ ...row }, "units", {
			get: () => (++reads === 1 ? 0 : -1),
		});
		expect(readAdmissionBudgetReservationReceipt(changing, statement)).toEqual(receipt);
		expect(reads).toBe(1);
	});
}
