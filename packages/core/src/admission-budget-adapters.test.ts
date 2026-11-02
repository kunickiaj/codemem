import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import {
	adapterFixture,
	adapterHarness,
	registerAdapterScenarios,
} from "./admission-budget-adapter-test-fixtures.js";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "./admission-budget-schema.js";
import type { WriteDatabase } from "./peer-traversal-coordinator-attempt-write-test-fixtures.js";
import { decideTraversalSignal } from "./peer-traversal-coordinator-decision.js";
import { decisionOptions } from "./peer-traversal-coordinator-decision-test-fixtures.js";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "./peer-traversal-coordinator-schema.js";
import type { Value } from "./peer-traversal-coordinator-schema-common-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "./relay-admission-metadata-schema.js";
import { PARTICIPANT_TEST_SCHEMA_SQL } from "./relay-admission-participant-nonce-test-fixtures.js";

const databases: Database.Database[] = [];
let sequence = 0x820000;
async function create() {
	const native = new Database(":memory:");
	databases.push(native);
	native.pragma("foreign_keys=ON");
	native.exec(PARTICIPANT_TEST_SCHEMA_SQL);
	const now = 1_800_000_000_000;
	native.function("adapter_test_clock", () => BigInt(now));
	native.function("strftime", (format, when) => {
		if (format !== "%Y-%m-%dT%H:%M:%fZ" || when !== "now")
			throw new Error("unexpected clock format");
		return new Date(now).toISOString();
	});
	const sql = (text: string) => text.replaceAll(RELAY_ADMISSION_CLOCK_SQL, "adapter_test_clock()");
	for (const statement of [
		...ADMISSION_BUDGET_SCHEMA_STATEMENTS,
		...TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS,
		...RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS,
	])
		native.exec(sql(statement));
	const bind = (values: readonly Value[]) =>
		Object.fromEntries(values.map((value, index) => [index + 1, value]));
	const run = (text: string, values: readonly Value[] = []) =>
		native.prepare(sql(text)).run(bind(values));
	const db: WriteDatabase = {
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
	return adapterFixture(db, now, ++sequence);
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	vi.restoreAllMocks();
});
registerAdapterScenarios(create);

it("denies missing durable ingress before enrollment lookup or any signature/key hashing", async () => {
	const f = await create();
	const h = adapterHarness(f);
	const digest = vi.spyOn(crypto.subtle, "digest");
	const verify = vi.spyOn(crypto.subtle, "verify");

	const result = await decideTraversalSignal(decisionOptions(f), {
		database: { query: h.query, writeReturning: h.protocolWrite },
		budgets: h.adapters.traversal,
	});

	expect(result).toBeNull();
	expect(digest).not.toHaveBeenCalled();
	expect(verify).not.toHaveBeenCalled();
	expect(h.query).not.toHaveBeenCalled();
	expect(h.protocolWrite).not.toHaveBeenCalled();
});
