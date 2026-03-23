import { describe, expect, it } from "vitest";
import { dbCommand } from "./db.js";

describe("db command", () => {
	it("registers backfill-tags maintenance subcommand", () => {
		const backfill = dbCommand.commands.find((command) => command.name() === "backfill-tags");
		expect(backfill).toBeDefined();
		const longs = backfill?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--limit");
		expect(longs).toContain("--since");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--inactive");
		expect(longs).toContain("--dry-run");
		expect(longs).toContain("--json");
	});

	it("registers prune-observations and prune-memories subcommands", () => {
		const pruneObs = dbCommand.commands.find((command) => command.name() === "prune-observations");
		const pruneMem = dbCommand.commands.find((command) => command.name() === "prune-memories");
		expect(pruneObs).toBeDefined();
		expect(pruneMem).toBeDefined();

		const pruneObsLongs = pruneObs?.options.map((option) => option.long) ?? [];
		expect(pruneObsLongs).toContain("--limit");
		expect(pruneObsLongs).toContain("--dry-run");
		expect(pruneObsLongs).toContain("--json");

		const pruneMemLongs = pruneMem?.options.map((option) => option.long) ?? [];
		expect(pruneMemLongs).toContain("--limit");
		expect(pruneMemLongs).toContain("--kinds");
		expect(pruneMemLongs).toContain("--dry-run");
		expect(pruneMemLongs).toContain("--json");
	});
});
