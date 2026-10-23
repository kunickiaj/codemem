import {
	ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
	LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCoordinatorAccountSchemaCommand } from "./coordinator-auth-schema.js";

const helpers = vi.hoisted(() => ({ owner: vi.fn(), account: vi.fn(), auth: vi.fn() }));
vi.mock("@codemem/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@codemem/core")>()),
	upgradeCoordinatorOwnerResolutionSchemaFile: helpers.owner,
	upgradeCoordinatorAccountSchemaFile: helpers.account,
	upgradeCoordinatorAuthSchemaFile: helpers.auth,
}));

const originalExit = process.exitCode;
beforeEach(() => {
	vi.clearAllMocks();
	helpers.owner.mockReset().mockResolvedValue(undefined);
	helpers.account.mockReset().mockResolvedValue(undefined);
	process.exitCode = 0;
});
afterEach(() => {
	process.exitCode = originalExit;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function run(args: string[]) {
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const jsonErrors = vi.spyOn(console, "log").mockImplementation(() => {});
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	// Unknown options throw in the expected RED phase instead of terminating vitest.
	await buildCoordinatorAccountSchemaCommand().exitOverride().parseAsync(args, { from: "user" });
	const output = () => stdout.mock.calls.map(([value]) => String(value)).join("");
	const failure = () => JSON.parse(jsonErrors.mock.calls.map(([value]) => String(value)).join(""));
	return { stdout, stderr, jsonErrors, output, failure };
}

function expectNoUpgrade() {
	expect(helpers.owner).not.toHaveBeenCalled();
	expect(helpers.account).not.toHaveBeenCalled();
	expect(helpers.auth).not.toHaveBeenCalled();
}

it("exports the shared reviewed statement boundaries with applied:false and ignores environment defaults", async () => {
	// Arrange
	vi.stubEnv("CODEMEM_DB", "synthetic-never-open.sqlite");
	// Act
	const out = await run(["--owner-resolution", "--export-sql", "--json"]);
	// Assert
	expect(JSON.parse(out.output())).toEqual({
		statements: LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS,
		applied: false,
	});
	expect(LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS).toHaveLength(6);
	expectNoUpgrade();
	expect(out.stderr).not.toHaveBeenCalled();
	expect(out.jsonErrors).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(0);
});

it("exports complete plaintext SQL with honest atomic-batch and backup guidance", async () => {
	// Arrange
	const args = ["--owner-resolution", "--export-sql"];
	// Act
	const out = await run(args);
	// Assert
	for (const sql of LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS)
		expect(out.output()).toContain(sql.trim().replace(/;$/u, ""));
	expect(out.output()).toContain("ONE atomic D1 batch");
	expect(out.output()).toMatch(/back up/i);
	expect(out.output()).toMatch(/nothing has been applied/i);
	expect(out.output()).toMatch(/;\n$/u);
	expectNoUpgrade();
});

it.each(["--db-path", "--db"])(
	"applies only the new helper to the explicit %s selection",
	async (flag) => {
		// Arrange
		const path = "synthetic-explicit.sqlite";
		// Act
		const out = await run(["--owner-resolution", flag, path, "--json"]);
		// Assert
		expect(helpers.owner).toHaveBeenCalledExactlyOnceWith(path);
		expect(helpers.account).not.toHaveBeenCalled();
		expect(helpers.auth).not.toHaveBeenCalled();
		expect(JSON.parse(out.output())).toEqual({ upgraded: true });
		expect(out.jsonErrors).not.toHaveBeenCalled();
		expect(out.stderr).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(0);
	},
);

it("prints pause/drain/backup warnings on stderr rather than success stdout", async () => {
	// Arrange
	const args = ["--owner-resolution", "--db-path", "synthetic-explicit.sqlite"];
	// Act
	const out = await run(args);
	// Assert
	const warnings = out.stderr.mock.calls.map(([value]) => String(value)).join("");
	expect(warnings).toMatch(/pause auth writers/i);
	expect(warnings).toMatch(/drain/i);
	expect(warnings).toMatch(/back up/i);
	expect(warnings).toMatch(/does not pause writers or create a backup/i);
	expect(out.output()).not.toMatch(/pause|back up/i);
	expect(helpers.owner).toHaveBeenCalledOnce();
});

it.each([
	["--device-unlink", "--export-sql"],
	["--device-unlink", "--db-path", "synthetic-explicit.sqlite"],
	["--export-sql", "--db-path", "synthetic-explicit.sqlite"],
	["--export-sql", "--db", "synthetic-explicit.sqlite"],
	["--export-sql", "--db-path", ""],
	[],
])(
	"rejects invalid owner-resolution options %j before calling any database helper",
	async (...args) => {
		// Arrange
		vi.stubEnv("CODEMEM_DB", "synthetic-default-must-not-open.sqlite");
		// Act
		const out = await run(["--owner-resolution", ...args, "--json"]);
		// Assert
		expect(out.failure()).toMatchObject({ error: "usage_error", message: expect.any(String) });
		expect(process.exitCode).toBe(2);
		expect(out.stdout).not.toHaveBeenCalled();
		expect(out.stderr).not.toHaveBeenCalled();
		expectNoUpgrade();
	},
);

it("contains helper failures in the standard JSON contract without a stack or internal path", async () => {
	// Arrange
	const error = new Error("owner_resolution_schema_unsupported");
	error.stack =
		"Error: synthetic failure\n at syntheticInternal (/synthetic/private/implementation.ts:1:1)";
	helpers.owner.mockRejectedValueOnce(error);
	// Act
	const out = await run(["--owner-resolution", "--db-path", "synthetic-explicit.sqlite", "--json"]);
	// Assert
	expect(out.failure()).toMatchObject({
		error: expect.any(String),
		message: expect.stringMatching(/schema|upgrade/i),
	});
	expect(process.exitCode).toBe(1);
	expect(JSON.stringify(out.failure())).not.toContain("/synthetic/private/");
	expect(out.stderr).not.toHaveBeenCalled();
	expect(out.stdout).not.toHaveBeenCalled();
	expect(helpers.owner).toHaveBeenCalledOnce();
	expect(helpers.account).not.toHaveBeenCalled();
});

it("control: keeps ordinary account-schema export unchanged when the new flag is absent", async () => {
	// Arrange
	const args = ["--export-sql", "--json"];
	// Act
	const out = await run(args);
	// Assert
	expect(JSON.parse(out.output())).toEqual({
		statements: ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
		applied: false,
	});
	expectNoUpgrade();
});

it("control: keeps ordinary account-schema apply on its existing helper", async () => {
	// Arrange
	const path = "synthetic-account.sqlite";
	// Act
	const out = await run(["--db-path", path, "--json"]);
	// Assert
	expect(helpers.account).toHaveBeenCalledExactlyOnceWith(path);
	expect(helpers.owner).not.toHaveBeenCalled();
	expect(JSON.parse(out.output())).toEqual({ upgraded: true });
});

it("advertises the explicit mode on the existing leaf without adding a deeper command", () => {
	// Arrange
	const command = buildCoordinatorAccountSchemaCommand();
	// Act
	const help = command.helpInformation();
	// Assert
	expect(command.name()).toBe("upgrade-account-schema");
	expect(command.commands).toEqual([]);
	expect(help).toContain("--owner-resolution");
	expect(help).toContain("--db-path");
	expect(help).toContain("--json");
});
