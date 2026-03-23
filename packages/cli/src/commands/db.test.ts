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
});
