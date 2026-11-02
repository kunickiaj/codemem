import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { readTraversalStateReceipt } from "../../core/src/peer-traversal-coordinator-attempt-write.js";
import {
	compileWrites,
	registerWriteScenarios,
	type WriteDatabase,
	type WriteSeedOptions,
	writeFixture,
} from "../../core/src/peer-traversal-coordinator-attempt-write-test-fixtures.js";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "../../core/src/peer-traversal-coordinator-schema.js";
import type { Value } from "../../core/src/peer-traversal-coordinator-schema-common-test-fixtures.js";
import {
	RELAY_ADMISSION_CLOCK_SQL,
	readRelayAdmissionNonceReceipt,
} from "../../core/src/relay-admission-clock.js";
import { readRelayAdmissionReadinessStamp } from "../../core/src/relay-admission-readiness.js";

// Existing migrated LOCAL D1 binding. No protected metadata deletion or remote DB.
const native = (env as { COORDINATOR_DB: D1Database }).COORDINATOR_DB;
let sequence = 0x750000;
const db: WriteDatabase = {
	run: async (sql, values = []) =>
		native
			.prepare(sql)
			.bind(...values)
			.run(),
	all: async (sql, values = []) =>
		(
			await native
				.prepare(sql)
				.bind(...values)
				.all<Record<string, Value>>()
		).results,
	batch: async (statements) =>
		native.batch(statements.map(({ sql, values }) => native.prepare(sql).bind(...values))),
	returning: async (statement) =>
		native
			.prepare(statement.sql)
			.bind(...statement.bindings)
			.first(),
};
beforeAll(async () => {
	for (const sql of TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS) await native.prepare(sql).run();
});
async function create(options: WriteSeedOptions = {}) {
	const row = await native
		.prepare(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`)
		.first<{ now: number }>();
	if (!row || !Number.isSafeInteger(row.now)) throw new Error("local SQL clock unavailable");
	return writeFixture(db, row.now, ++sequence, options);
}
registerWriteScenarios(create);

it("parses own nonce and state receipts from native D1 all().results rows", async () => {
	const f = await create();
	const { nonce, state } = await compileWrites(f);

	const nonceResult = await native
		.prepare(nonce.sql)
		.bind(...nonce.bindings)
		.all();
	expect(nonceResult.results).toHaveLength(1);
	const receipt = readRelayAdmissionNonceReceipt(nonceResult.results[0], nonce.association);
	expect(receipt).not.toBeNull();
	if (!receipt) throw new Error("missing own nonce receipt");
	expect(readRelayAdmissionReadinessStamp(nonceResult.results[0], receipt)).toMatchObject({
		state: "ready",
		revision: 1,
		observedAtMs: f.now,
	});

	const stateResult = await native
		.prepare(state.sql)
		.bind(...state.bindings)
		.all();
	expect(stateResult.results).toHaveLength(1);
	const parsed = readTraversalStateReceipt(stateResult.results[0], state);
	expect(parsed).not.toBeNull();
	if (!parsed) throw new Error("missing own state receipt");
	const stored = await native
		.prepare("SELECT exec_id FROM traversal_attempts WHERE session_id=?1")
		.bind(state.expected.sessionId)
		.first();
	expect(parsed.receipt.attemptId).toBe(state.association.attemptId);
	expect(stored).toEqual({ exec_id: parsed.receipt.attemptId });
});
