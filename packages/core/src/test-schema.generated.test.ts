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

	it("contains Team device eligibility compatibility state", () => {
		expect(TEST_SCHEMA_BASE_DDL).toContain("device_eligibility_mode");
		expect(TEST_SCHEMA_BASE_DDL).toContain("policy_team_device_decisions");
		expect(TEST_SCHEMA_BASE_DDL).toContain(
			"`policy_team_device_decisions` (\n\t`team_id` text NOT NULL,\n\t`device_id` text NOT NULL,\n\t`decision` text NOT NULL,\n\t`assignment_version` integer DEFAULT 0 NOT NULL",
		);
	});

	it("contains device Identity binding commit and audit state", () => {
		expect(drizzleSchema.deviceIdentityBindingCommits).toBeDefined();
		expect(drizzleSchema.deviceIdentityBindingAudit).toBeDefined();
		expect(TEST_SCHEMA_BASE_DDL).toContain("device_identity_binding_commits");
		expect(TEST_SCHEMA_BASE_DDL).toContain("device_identity_binding_audit");
		expect(TEST_SCHEMA_BASE_DDL).toContain("idx_device_identity_binding_audit_commit_device");
	});

	it("contains durable legacy Team setup draft state", () => {
		expect(drizzleSchema.legacyTeamSetupDrafts).toBeDefined();
		expect(drizzleSchema.legacyTeamSetupDraftDevices).toBeDefined();
		expect(drizzleSchema.legacyTeamSetupDraftProjects).toBeDefined();
		expect(TEST_SCHEMA_BASE_DDL).toContain("legacy_team_setup_drafts");
		expect(TEST_SCHEMA_BASE_DDL).toContain("legacy_team_setup_draft_devices");
		expect(TEST_SCHEMA_BASE_DDL).toContain("legacy_team_setup_draft_projects");
		expect(TEST_SCHEMA_BASE_DDL).toContain("`target_scope_id` text");
		expect(drizzleSchema.legacyTeamSetupDrafts.safe_error_code).toBeDefined();
		expect(drizzleSchema.legacyTeamSetupDrafts.completed_team_id).toBeDefined();
		expect(drizzleSchema.legacyTeamSetupDraftDevices.verified_evidence_kind).toBeDefined();
	});
});
