import { afterEach, expect, it, vi } from "vitest";

const upgrade = vi.hoisted(() => vi.fn());
vi.mock("@codemem/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@codemem/core")>()),
	upgradeCoordinatorAuthSchemaFile: upgrade,
}));

import { buildCoordinatorAuthSchemaCommand } from "./coordinator-auth-schema.js";

const exitCode = process.exitCode;
afterEach(() => {
	process.exitCode = exitCode;
	upgrade.mockReset();
	vi.restoreAllMocks();
});

it("exports complete D1 SQL including intact proof triggers without opening a database", async () => {
	// Arrange
	const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	// Act
	await buildCoordinatorAuthSchemaCommand().parseAsync(["--export-sql", "--json"], {
		from: "user",
	});
	const result = JSON.parse(String(output.mock.calls[0]?.[0]));
	// Assert: the CLI must not reintroduce empty statements into the exported file.
	expect(result.applied).toBe(false);
	expect(result.sql).not.toMatch(/;\s*;/u);
	expect(result.sql).toMatch(/;\n+$/u);
	expect(result.sql).toContain("CREATE TABLE coordinator_auth_link_authority_upgrade_checks");
	expect(result.sql).toContain("RAISE(ABORT, 'auth_device_claim_immutable');\nEND;");
	expect(upgrade).not.toHaveBeenCalled();
});

it("requires explicit local selection, never a profile default", async () => {
	const output = vi.spyOn(console, "log").mockImplementation(() => {});
	await buildCoordinatorAuthSchemaCommand().parseAsync(["--json"], { from: "user" });
	expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ error: "usage_error" });
	expect(process.exitCode).toBe(2);
	expect(upgrade).not.toHaveBeenCalled();
});

it("invokes only the selected local upgrade and formats a failed assertion without an uncaught throw", async () => {
	upgrade.mockImplementation(() => {
		throw new Error("CHECK constraint failed: passed = 1");
	});
	const output = vi.spyOn(console, "log").mockImplementation(() => {});
	await buildCoordinatorAuthSchemaCommand().parseAsync(["--db-path", "fixture.sqlite", "--json"], {
		from: "user",
	});
	expect(upgrade).toHaveBeenCalledWith("fixture.sqlite");
	expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
		error: "auth_schema_upgrade_failed",
	});
	expect(process.exitCode).toBe(1);
});
