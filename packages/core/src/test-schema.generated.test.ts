import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import { schema as drizzleSchema } from "./schema.js";
import { TEST_SCHEMA_BASE_DDL } from "./test-schema.generated.js";

function makeIdempotentStatements(statements: string[]): string[] {
	return statements.map((statement) =>
		statement
			.replace(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS ")
			.replace(/^CREATE UNIQUE INDEX /, "CREATE UNIQUE INDEX IF NOT EXISTS ")
			.replace(/^CREATE INDEX /, "CREATE INDEX IF NOT EXISTS "),
	);
}

describe("test schema generation", () => {
	it("matches the current Drizzle schema snapshot", async () => {
		const prev = await generateSQLiteDrizzleJson({});
		const cur = await generateSQLiteDrizzleJson(drizzleSchema);
		const statements = await generateSQLiteMigration(prev, cur);

		expect(TEST_SCHEMA_BASE_DDL).toBe(makeIdempotentStatements(statements).join("\n"));
	});
});
