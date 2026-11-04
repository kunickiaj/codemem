import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMISSION_BUDGET_SCHEMA_STATEMENTS } from "../../core/src/admission-budget-schema.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "../../core/src/relay-admission-metadata-schema.js";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Each migration is a header comment and the core statements, one per line group. */
const RELAY_MIGRATIONS = [
	{
		file: "migrations/0041_add_relay_admission_metadata.sql",
		source: "packages/core/src/relay-admission-metadata-schema.ts",
		statements: RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS,
	},
	{
		file: "migrations/0042_add_admission_budgets.sql",
		source: "packages/core/src/admission-budget-schema.ts",
		statements: ADMISSION_BUDGET_SCHEMA_STATEMENTS,
	},
] as const;

function relayMigrationSql(migration: (typeof RELAY_MIGRATIONS)[number]): string {
	return [
		"-- Relay admission tables, read by POST /v1/relay/admission-check. Every row",
		"-- starts absent, which keeps admission off until trusted provisioning writes it.",
		`-- Generated from ${migration.source}. relay-migrations.test.ts checks parity.`,
		...migration.statements,
		"",
	].join("\n");
}

describe("relay admission migrations", () => {
	it.each(RELAY_MIGRATIONS)("$file matches the core schema statements", (migration) => {
		// Act / Assert
		expect(read(migration.file)).toBe(relayMigrationSql(migration));
	});

	it("keeps schema.sql in sync with every generated statement", () => {
		// Arrange
		const schema = read("schema.sql");
		// Act
		const missing = RELAY_MIGRATIONS.flatMap((m) => m.statements).filter(
			(statement) => !schema.includes(statement),
		);
		// Assert
		expect(missing).toEqual([]);
	});
});
