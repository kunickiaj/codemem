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

it("says that each migration after 0047 is recorded only when its objects exist", async () => {
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
	const conditional = [
		"0048_add_device_removals.sql",
		"0049_add_enrollment_removal_triggers.sql",
		"0050_add_boundary_readiness.sql",
		"0051_add_device_rejoin.sql",
		"0052_add_team_member_removals.sql",
		"0053_add_team_group_bindings.sql",
	];
	const unconditional = coordinatorD1BaselineMigrations("current").length - conditional.length;
	expect(current?.[0]).toBe(
		`-- Records ${unconditional} migrations, 0001_init.sql through 0047_add_account_unlink.sql, in the existing d1_migrations ledger`,
	);
	expect(current?.slice(2, 4)).toEqual([
		`-- Also records ${conditional.join(" and ")}, each only when the objects it adds already exist.`,
		"-- A migration without them stays unrecorded, and wrangler d1 migrations apply runs it.",
	]);
	expect(prior?.[0]).toMatch(/ through 0046_\S+, in the existing d1_migrations ledger$/u);
	for (const name of conditional) expect(prior?.join("\n")).not.toContain(name);
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
