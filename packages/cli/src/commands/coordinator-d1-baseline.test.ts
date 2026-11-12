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

it("rejects an unrecognized stage instead of guessing", async () => {
	// Arrange
	const command = buildCoordinatorD1BaselineCommand().exitOverride();
	command.configureOutput({ writeErr: () => {} });
	// Act / Assert
	await expect(command.parseAsync(["--stage", "legacy"], { from: "user" })).rejects.toThrow(
		/invalid|Allowed choices/i,
	);
});
