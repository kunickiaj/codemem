import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS } from "../../core/src/peer-traversal-coordinator-metadata-schema.js";
import { registerMetadataScenarios } from "../../core/src/peer-traversal-coordinator-metadata-schema-test-fixtures.js";
import type {
	SchemaDatabase,
	Value,
} from "../../core/src/peer-traversal-coordinator-schema-common-test-fixtures.js";

// Existing local D1 binding. Distinct file prefixes avoid relying on storage isolation.
const native = env.COORDINATOR_DB;
let sequence = 0;
const db: SchemaDatabase = {
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
};
beforeAll(async () => {
	for (const sql of TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS)
		await native.prepare(sql).run();
});
registerMetadataScenarios(async () => ({
	db,
	now: 1_800_000_000_000,
	authority: `d1a0${(++sequence).toString(16).padStart(60, "0")}`,
}));

it("exports frozen metadata definitions independently of attempts", () => {
	const statements = TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS;

	const frozen = Object.isFrozen(statements);

	expect(frozen).toBe(true);
});
