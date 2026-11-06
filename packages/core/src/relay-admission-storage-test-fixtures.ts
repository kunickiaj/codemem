import Database from "better-sqlite3";
import { buildAdmissionBudgetReservationStatement } from "./admission-budget.js";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "./admission-budget-schema.js";
import type { RelayAdmissionDecisionDependencies } from "./relay-admission-decision.js";
import {
	installSimulatedRelayBudgetClock,
	type SimulatedRelayPairPacing,
} from "./relay-pair-pacing-test-fixtures.js";

const budgetStatement = buildAdmissionBudgetReservationStatement({
	authorityId: "0".repeat(64),
	pool: "authority",
	audienceId: "",
	groupId: "",
	deviceId: "",
	execId: "0".repeat(32),
});
if (!budgetStatement) throw new Error("Cannot compile fixture budget reservation");
const budgetSql = budgetStatement.sql;
const allocationColumns = "authority_id,pool,audience_id,group_id,rate_per_min,burst";
const bind = (values: readonly (string | number | null)[]) =>
	Object.fromEntries(values.map((value, index) => [index + 1, value]));

export interface RelayAdmissionTestStorage {
	readonly database: RelayAdmissionDecisionDependencies["database"];
	readonly budget: Database.Database;
	close(): void;
}

function budgetDatabase(auth: Database.Database, clock: SimulatedRelayPairPacing) {
	const budget = new Database(":memory:");
	for (const sql of ADMISSION_BUDGET_SCHEMA_STATEMENTS) budget.exec(sql);
	const insert = budget.prepare(
		`INSERT INTO admission_budget_allocations (${allocationColumns})
		 VALUES (@authority_id,@pool,@audience_id,@group_id,@rate_per_min,@burst)`,
	);
	for (const row of auth
		.prepare<[], Record<string, string | number>>(
			`SELECT ${allocationColumns} FROM admission_budget_allocations ORDER BY pool,audience_id,group_id`,
		)
		.all())
		insert.run(row);
	installSimulatedRelayBudgetClock(budget, clock);
	return budget;
}

/**
 * Budgets reserve through independent autocommit INSERT RETURNING statements.
 * Their receipts bind execution IDs, not nonce/auth receipt times or transactions.
 * Route only the exact compiler output to simulated storage. Authorization and
 * nonce SQL always execute on the original database with native UTC.
 */
export function relayAdmissionStorage(
	auth: Database.Database,
	clock?: SimulatedRelayPairPacing,
): RelayAdmissionTestStorage {
	const budget = clock ? budgetDatabase(auth, clock) : auth;
	const database: RelayAdmissionDecisionDependencies["database"] = {
		query: async (sql, values) => auth.prepare(sql).all(bind(values)),
		insertReturning: async (sql, values) =>
			(sql === budgetSql ? budget : auth).prepare(sql).get(bind(values)) ?? null,
	};
	return {
		database,
		budget,
		close() {
			if (budget !== auth) budget.close();
		},
	};
}
