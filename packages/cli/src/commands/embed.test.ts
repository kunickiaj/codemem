import { afterEach, describe, expect, it } from "vitest";
import { embedCommand, resolveEmbedProjectScope } from "./embed.js";

const prevProject = process.env.CODEMEM_PROJECT;

afterEach(() => {
	if (prevProject === undefined) delete process.env.CODEMEM_PROJECT;
	else process.env.CODEMEM_PROJECT = prevProject;
});

describe("embed command", () => {
	it("registers expected options for vector backfill", () => {
		const longs = embedCommand.options.map((option) => option.long);
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

	it("documents embed backfill behavior in help output", () => {
		const help = embedCommand.helpInformation();
		expect(help).toContain("Backfill semantic embeddings");
		expect(help).toContain("--all-projects");
		expect(help).toContain("--dry-run");
	});

	it("prefers explicit --project over CODEMEM_PROJECT", () => {
		process.env.CODEMEM_PROJECT = "env-project";
		expect(resolveEmbedProjectScope("/tmp", "cli-project", false)).toBe("cli-project");
	});

	it("supports all-projects override", () => {
		process.env.CODEMEM_PROJECT = "env-project";
		expect(resolveEmbedProjectScope("/tmp", "cli-project", true)).toBeNull();
	});
});
