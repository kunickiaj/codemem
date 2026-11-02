import { describe, expect, it } from "vitest";
import type { AdmissionBudgetPool } from "./admission-budget-allocation-schema.js";
import type {
	SchemaDatabase,
	Value,
} from "./peer-traversal-coordinator-schema-common-test-fixtures.js";

export const MAX_BURST = 150119987579;
export const ALLOCATION =
	"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id,rate_per_min,burst) VALUES (?1,?2,?3,?4,?5,?6)";
export interface AllocationKey {
	authorityId: string;
	pool: AdmissionBudgetPool;
	audienceId: string;
	groupId: string;
}
export interface AllocationFixture {
	db: SchemaDatabase;
	authority: string;
	group: string;
}
type Create = () => Promise<AllocationFixture>;
export function allocationFixture(
	db: SchemaDatabase,
	id: number,
	prefix: "b6a2" | "b6d2",
): AllocationFixture {
	return { db, authority: `${prefix}${id.toString(16).padStart(60, "0")}`, group: `budget-${id}` };
}
export function allocationKeyFor(
	f: AllocationFixture,
	changes: Partial<AllocationKey> = {},
): AllocationKey {
	return { authorityId: f.authority, pool: "authority", audienceId: "", groupId: "", ...changes };
}
export function allocate(f: AllocationFixture, key = allocationKeyFor(f), rate = 1, burst = 1) {
	return f.db.run(ALLOCATION, [
		key.authorityId,
		key.pool,
		key.audienceId,
		key.groupId,
		rate,
		burst,
	]);
}
export function updateRoot(f: AllocationFixture, rate: number, burst: number) {
	return f.db.run(
		"UPDATE admission_budget_allocations SET rate_per_min=?2,burst=?3 WHERE authority_id=?1 AND pool='authority'",
		[f.authority, rate, burst],
	);
}

// Positive values are disposable fixture policy only, with no production capacity claim.
export function registerAllocationScenarios(create: Create) {
	describe("allocation hierarchy and permanent policy", () => {
		registerDefaults(create);
		registerShapes(create);
		registerHierarchy(create);
		registerMatchingParent(create);
		registerIndependentSums(create);
		registerPolicyCaps(create);
		registerIntegrity(create);
		registerImmutableKeys(create);
	});
}
function registerDefaults(create: Create) {
	it("defaults omitted rate and burst to zero", async () => {
		const f = await create();

		await f.db.run(
			"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id) VALUES (?1,'authority','','')",
			[f.authority],
		);

		expect(
			await f.db.all(
				"SELECT rate_per_min,burst FROM admission_budget_allocations WHERE authority_id=?1",
				[f.authority],
			),
		).toEqual([{ rate_per_min: 0, burst: 0 }]);
	});
}
const BAD_ALLOCATIONS: [string, Value[]][] = [
	["authority alphabet", ["A".repeat(64), "authority", "", "", 1, 1]],
	["authority length", ["a".repeat(63), "authority", "", "", 1, 1]],
	["authority NUL", [`${"a".repeat(63)}\0`, "authority", "", "", 1, 1]],
	["pool", ["", "unknown", "", "", 1, 1]],
	["authority audience", ["", "authority", "a".repeat(64), "", 1, 1]],
	["authority group", ["", "authority", "", "realm", 1, 1]],
	["traversal audience", ["", "traversal", "a".repeat(64), "", 1, 1]],
	["relay audience absent", ["", "relay-route", "", "", 1, 1]],
	["relay audience alphabet", ["", "relay-registration", "G".repeat(64), "", 1, 1]],
	["device group", ["", "device", "", "realm", 1, 1]],
	["group byte length", ["", "traversal", "", "é".repeat(65), 1, 1]],
	["group NUL", ["", "traversal", "", "a\0b", 1, 1]],
	...[null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "invalid"].map((value): [string, Value[]] => [
		"rate",
		["", "authority", "", "", value, 1],
	]),
	...[null, -1, 0.5, MAX_BURST + 1, "invalid"].map((value): [string, Value[]] => [
		"burst",
		["", "authority", "", "", 1, value],
	]),
	["unpaired zero rate", ["", "authority", "", "", 0, 1]],
	["unpaired zero burst", ["", "authority", "", "", 1, 0]],
];
function registerShapes(create: Create) {
	it.each(BAD_ALLOCATIONS)("rejects invalid allocation %s %#", async (_name, values) => {
		const f = await create();
		const bindings = [...values];
		if (bindings[0] === "") bindings[0] = f.authority;
		if (bindings[1] !== "authority") {
			await allocate(f, allocationKeyFor(f), 32, 32);
			if (bindings[1] === "traversal" && bindings[3] !== "")
				await allocate(f, allocationKeyFor(f, { pool: "traversal" }), 32, 32);
		}

		const attempt = f.db.run(ALLOCATION, bindings);

		await expect(attempt).rejects.toThrow();
	});
	it.each([
		"traversal",
		"relay-route",
		"relay-registration",
		"device",
		"device-registration",
	] as const)("requires an authority parent for %s", async (pool) => {
		const f = await create();
		const key = allocationKeyFor(f, {
			pool,
			audienceId: pool.startsWith("relay") ? "a".repeat(64) : "",
		});

		const attempt = allocate(f, key);

		await expect(attempt).rejects.toThrow();
	});
}
function registerHierarchy(create: Create) {
	it("permits exact parent totals and rejects excess rates, bursts and parent shrinkage", async () => {
		const f = await create();
		const traversal = allocationKeyFor(f, { pool: "traversal" });
		await allocate(f, allocationKeyFor(f), 12, 12);
		await allocate(f, traversal, 5, 5);
		await allocate(
			f,
			allocationKeyFor(f, { pool: "relay-route", audienceId: "a".repeat(64) }),
			6,
			6,
		);
		await allocate(f, { ...traversal, groupId: "a" }, 2, 2);
		await allocate(f, { ...traversal, groupId: "b" }, 2, 2);
		await f.db.run(
			"UPDATE admission_budget_allocations SET rate_per_min=4,burst=4 WHERE authority_id=?1 AND pool='traversal' AND group_id=''",
			[f.authority],
		);
		await updateRoot(f, 10, 10);

		for (const [rate, burst] of [
			[1, 1],
			[1, 2],
			[2, 1],
		]) {
			await expect(
				allocate(
					f,
					allocationKeyFor(f, { pool: "relay-registration", audienceId: "b".repeat(64) }),
					rate,
					burst,
				),
			).rejects.toThrow();
			await expect(allocate(f, { ...traversal, groupId: "c" }, rate, burst)).rejects.toThrow();
		}
		const shrinks = [
			"UPDATE admission_budget_allocations SET rate_per_min=9 WHERE authority_id=?1 AND pool='authority'",
			"UPDATE admission_budget_allocations SET burst=9 WHERE authority_id=?1 AND pool='authority'",
			"UPDATE admission_budget_allocations SET rate_per_min=3 WHERE authority_id=?1 AND pool='traversal' AND group_id=''",
			"UPDATE admission_budget_allocations SET burst=3 WHERE authority_id=?1 AND pool='traversal' AND group_id=''",
		];
		for (const sql of shrinks) await expect(f.db.run(sql, [f.authority])).rejects.toThrow();
	});
}
function registerMatchingParent(create: Create) {
	it("requires a matching audience/pool parent before adding a realm", async () => {
		const f = await create();
		await allocate(f, allocationKeyFor(f), 10, 10);
		const realm = allocationKeyFor(f, {
			pool: "relay-route",
			audienceId: "a".repeat(64),
			groupId: f.group,
		});

		await expect(allocate(f, realm)).rejects.toThrow();
		await allocate(f, { ...realm, groupId: "" });
		await allocate(f, realm);

		expect(
			await f.db.all(
				"SELECT rate_per_min,burst FROM admission_budget_allocations WHERE authority_id=?1 AND group_id=?2",
				[f.authority, f.group],
			),
		).toEqual([{ rate_per_min: 1, burst: 1 }]);
	});
}
function registerPolicyCaps(create: Create) {
	it("excludes both device policy ceilings from authority sums, even with authority capacity disabled", async () => {
		const f = await create();
		await allocate(f, allocationKeyFor(f), 0, 0);

		await allocate(f, allocationKeyFor(f, { pool: "device" }), 96, 16);
		await allocate(f, allocationKeyFor(f, { pool: "device-registration" }), 2, 2);

		expect(
			await f.db.all(
				"SELECT pool,rate_per_min,burst FROM admission_budget_allocations WHERE authority_id=?1 AND pool<>'authority' ORDER BY pool",
				[f.authority],
			),
		).toEqual([
			{ pool: "device", rate_per_min: 96, burst: 16 },
			{ pool: "device-registration", rate_per_min: 2, burst: 2 },
		]);
		const excess = [
			"UPDATE admission_budget_allocations SET rate_per_min=97 WHERE authority_id=?1 AND pool='device'",
			"UPDATE admission_budget_allocations SET burst=17 WHERE authority_id=?1 AND pool='device'",
			"UPDATE admission_budget_allocations SET rate_per_min=3 WHERE authority_id=?1 AND pool='device-registration'",
			"UPDATE admission_budget_allocations SET burst=3 WHERE authority_id=?1 AND pool='device-registration'",
		];
		for (const sql of excess) await expect(f.db.run(sql, [f.authority])).rejects.toThrow();
	});
}
function registerIndependentSums(create: Create) {
	it.each(
		(["authority", "realm"] as const).flatMap((level) =>
			(["rate", "burst"] as const).map((dimension) => ({ level, dimension })),
		),
	)(
		"rejects $level child $dimension excess even while the other dimension fits",
		async ({ level, dimension }) => {
			const f = await create();
			if (level === "realm") await allocate(f, allocationKeyFor(f), 10, 10);
			const parent = allocationKeyFor(f, {
				pool: level === "authority" ? "authority" : "traversal",
			});
			await allocate(f, parent, dimension === "rate" ? 1 : 2, dimension === "burst" ? 1 : 2);
			const first =
				level === "authority"
					? allocationKeyFor(f, { pool: "traversal" })
					: { ...parent, groupId: "a" };
			await allocate(f, first);
			const second =
				level === "authority"
					? allocationKeyFor(f, { pool: "relay-route", audienceId: "a".repeat(64) })
					: { ...parent, groupId: "b" };

			const attempt = allocate(f, second);

			await expect(attempt).rejects.toThrow();
		},
	);
}
function registerIntegrity(create: Create) {
	it("rejects allocation collisions, replacement, upsert, ignore and permanent deletes", async () => {
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

		expect(
			await f.db.all(
				"SELECT rate_per_min,burst FROM admission_budget_allocations WHERE authority_id=?1",
				[f.authority],
			),
		).toEqual([{ rate_per_min: 1, burst: 1 }]);
	});
}
function registerImmutableKeys(create: Create) {
	it.each(["authority_id", "pool", "audience_id", "group_id"] as const)(
		"keeps allocation key %s immutable",
		async (column) => {
			const f = await create();
			await allocate(f, allocationKeyFor(f), 10, 10);
			const otherAuthority = `c${f.authority.slice(1)}`;
			await allocate(
				f,
				allocationKeyFor(f, { pool: "relay-route", audienceId: "a".repeat(64) }),
				2,
				2,
			);
			if (column === "group_id")
				await allocate(
					f,
					allocationKeyFor(f, {
						pool: "relay-route",
						audienceId: "a".repeat(64),
						groupId: f.group,
					}),
				);
			if (column === "authority_id")
				await allocate(f, allocationKeyFor(f, { authorityId: otherAuthority }), 10, 10);
			const values = {
				authority_id: otherAuthority,
				pool: "relay-registration",
				audience_id: "b".repeat(64),
				group_id: "changed",
			};
			const group = column === "group_id" ? f.group : "";
			// Identifiers come only from this literal four-column matrix.
			const attempt = f.db.run(
				`UPDATE admission_budget_allocations SET ${column}=?2 WHERE authority_id=?1 AND pool='relay-route' AND group_id=?3`,
				[f.authority, values[column], group],
			);

			await expect(attempt).rejects.toThrow();
		},
	);
}
