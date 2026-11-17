import { coordinatorAuthStageBaselineSql, coordinatorD1BaselineMigrations } from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import { buildCoordinatorD1BaselineCommand } from "./coordinator-d1-baseline.js";

afterEach(() => {
	vi.restoreAllMocks();
});

it("exports the guarded baseline for the named stage without applying it", async () => {
	// Arrange
	const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	// Act
	await buildCoordinatorD1BaselineCommand().parseAsync(["--stage", "current", "--json"], {
		from: "user",
	});
	// Assert: the whole prefix from 0001, not just the auth-stage migrations.
	expect(coordinatorD1BaselineMigrations("current")[0]).toMatch(/^0001_/u);
	expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
		statement: coordinatorAuthStageBaselineSql("current"),
		migrations: coordinatorD1BaselineMigrations("current"),
		applied: false,
	});
});

it("says that 0048 is recorded only when its storage exists", async () => {
	// Arrange
	const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	// Act
	for (const stage of ["current", "prior_extension"]) {
		await buildCoordinatorD1BaselineCommand().parseAsync(["--stage", stage], { from: "user" });
	}
	// Assert: the count covers the migrations recorded whenever the stage checks pass.
	const [current, prior] = output.mock.calls.map(([text]) =>
		String(text)
			.split("\n")
			.filter((line) => line.startsWith("-- ")),
	);
	const unconditional = coordinatorD1BaselineMigrations("current").length - 1;
	expect(current?.[0]).toBe(
		`-- Records ${unconditional} migrations, 0001_init.sql through 0047_add_account_unlink.sql, in the existing d1_migrations ledger`,
	);
	expect(current?.slice(2, 4)).toEqual([
		"-- Also records 0048_add_device_removals.sql when the storage it adds already exists.",
		"-- Without that storage it stays unrecorded, and wrangler d1 migrations apply runs it.",
	]);
	expect(prior?.[0]).toMatch(/ through 0046_\S+, in the existing d1_migrations ledger$/u);
	expect(prior?.join("\n")).not.toContain("0048");
});

it("rejects an unrecognized stage instead of guessing", async () => {
	// Arrange
	const command = buildCoordinatorD1BaselineCommand().exitOverride();
	command.configureOutput({ writeErr: () => {} });
	// Act / Assert
	await expect(command.parseAsync(["--stage", "legacy"], { from: "user" })).rejects.toThrow(
		/invalid|Allowed choices/i,
	);
});
