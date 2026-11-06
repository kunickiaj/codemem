import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { buildAdmissionBudgetReservationStatement } from "./admission-budget.js";
import { createAdmissionBudgetAdapters } from "./admission-budget-adapters.js";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "./admission-budget-schema.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";
import { relayAdmissionStorage } from "./relay-admission-storage-test-fixtures.js";
import { simulatedRelayPairPacing } from "./relay-pair-pacing-test-fixtures.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(options: { simulate?: boolean } = {}) {
	const auth = new Database(":memory:");
	cleanups.push(() => auth.close());
	for (const sql of ADMISSION_BUDGET_SCHEMA_STATEMENTS) auth.exec(sql);
	const namespace = {
		authorityId: "a".repeat(64),
		groupId: "group-A",
		relayAudienceId: "b".repeat(64),
	};
	auth
		.prepare(
			"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id,rate_per_min,burst) VALUES (?,'authority','','',384,64)",
		)
		.run(namespace.authorityId);
	auth
		.prepare(
			"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id,rate_per_min,burst) VALUES (?,'device','','',96,16)",
		)
		.run(namespace.authorityId);
	const clock = simulatedRelayPairPacing();
	const storage = relayAdmissionStorage(auth, options.simulate === false ? undefined : clock);
	cleanups.push(() => storage.close());
	return { auth, clock, storage, namespace };
}

it("refills unchanged admission budgets only when simulated time covers one token", async () => {
	// The same adapters and compiler execute against real SQLite budget storage.
	const { auth, clock, storage, namespace } = fixture();
	const budgets = createAdmissionBudgetAdapters({
		database: { writeReturning: storage.database.insertReturning },
	}).relay;
	const reserve = () =>
		budgets.reserveVerifiedDevice({
			namespace,
			ingressKey: "disposable-test",
			expected: { kind: "admission", role: "source" },
			deviceId: "source",
			keyId: "c".repeat(64),
		});
	// 96/minute refills one token in 625 ms, independently of native UTC.
	const burst = [];
	for (let index = 0; index < 16; index++) burst.push(await reserve());
	const exhausted = await reserve();
	clock.advance(624);
	const tooEarly = await reserve();
	clock.advance(1);
	const refilled = await reserve();
	const exhaustedAgain = await reserve();
	// No allocation or authorization database clock was changed.
	expect(burst).toEqual(Array(16).fill("reserved"));
	expect([exhausted, tooEarly, refilled, exhaustedAgain]).toEqual([
		"denied",
		"denied",
		"reserved",
		"denied",
	]);
	expect(auth.prepare("SELECT * FROM admission_budget_buckets").all()).toEqual([]);
	expect(
		storage.budget
			.prepare("SELECT rate_per_min,burst FROM admission_budget_allocations WHERE pool='device'")
			.all(),
	).toEqual([{ rate_per_min: 96, burst: 16 }]);
});

it("routes only the exact compiled reservation to simulated storage", async () => {
	// A semantically identical statement with a comment must use native storage.
	const { auth, clock, storage, namespace } = fixture();
	const statement = buildAdmissionBudgetReservationStatement({
		authorityId: namespace.authorityId,
		pool: "device",
		audienceId: "",
		groupId: namespace.groupId,
		deviceId: "source",
		execId: "d".repeat(32),
	});
	if (!statement) throw new Error("Invalid test budget key");
	clock.advance(600_000);
	const before = Date.now();
	// Unchanged SQL uses virtual refill time, other SQL keeps native UTC.
	const exact = await storage.database.insertReturning(statement.sql, statement.bindings);
	const other = await storage.database.insertReturning(
		`${statement.sql}\n-- native`,
		statement.bindings,
	);
	const utc = await storage.database.query(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`, []);
	const after = Date.now();
	// Exact matching cannot redirect nonce or authorization statements.
	expect(exact).toMatchObject({ decidedAtMs: clock.quotaUtcMs(), granted: 1 });
	expect(other).toMatchObject({ granted: 1 });
	const nativeReceipt = other as { decidedAtMs: number };
	expect(nativeReceipt.decidedAtMs).toBeGreaterThanOrEqual(before);
	expect(nativeReceipt.decidedAtMs).toBeLessThanOrEqual(after);
	expect(utc).toEqual([{ now: expect.any(Number) }]);
	expect(auth.prepare("SELECT COUNT(*) AS count FROM admission_budget_buckets").get()).toEqual({
		count: 1,
	});
});

it("keeps default fixtures on their original native database", async () => {
	const { auth, clock, storage } = fixture({ simulate: false });
	clock.advance(600_000);
	const before = Date.now();
	const rows = await storage.database.query(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`, []);
	const after = Date.now();
	// Creating a simulated bundle elsewhere cannot change native storage.
	expect(storage.budget).toBe(auth);
	const [{ now }] = rows as { now: number }[];
	expect(now).toBeGreaterThanOrEqual(before);
	expect(now).toBeLessThanOrEqual(after);
});
