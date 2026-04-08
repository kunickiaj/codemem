import { describe, expect, it } from "vitest";
import {
	forgetMemoryCommand,
	memoryCommand,
	rememberMemoryCommand,
	showMemoryCommand,
} from "./memory.js";

describe("memory command aliases", () => {
	it("keeps memory subcommands available under the memory group", () => {
		expect(memoryCommand.commands.map((command) => command.name())).toEqual([
			"show",
			"forget",
			"remember",
			"inject",
			"role-report",
			"role-compare",
			"extraction-report",
			"extraction-replay",
			"extraction-benchmark",
			"relink-report",
			"relink-plan",
		]);
	});

	it("exports top-level compatibility aliases", () => {
		expect(showMemoryCommand.name()).toBe("show");
		expect(forgetMemoryCommand.name()).toBe("forget");
		expect(rememberMemoryCommand.name()).toBe("remember");
	});

	it("keeps inject expecting a context argument", () => {
		const inject = memoryCommand.commands.find((command) => command.name() === "inject");
		expect(inject).toBeDefined();
		expect(inject?.registeredArguments[0]?.required).toBe(true);
		expect(inject?.registeredArguments[0]?.name()).toBe("context");
		expect(inject?.options.some((option) => option.long === "--working-set-file")).toBe(true);
	});

	it("registers role-report under memory with shared analysis options", () => {
		const roleReport = memoryCommand.commands.find((command) => command.name() === "role-report");
		expect(roleReport).toBeDefined();
		const longs = roleReport?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--probe");
		expect(longs).toContain("--scenario");
		expect(longs).toContain("--inactive");
		expect(longs).toContain("--json");
	});

	it("registers role-compare under memory with scenario options", () => {
		const roleCompare = memoryCommand.commands.find((command) => command.name() === "role-compare");
		expect(roleCompare).toBeDefined();
		const longs = roleCompare?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--probe");
		expect(longs).toContain("--scenario");
		expect(longs).toContain("--inactive");
		expect(longs).toContain("--json");
	});

	it("registers extraction-report under memory with session eval options", () => {
		const extractionReport = memoryCommand.commands.find(
			(command) => command.name() === "extraction-report",
		);
		expect(extractionReport).toBeDefined();
		const longs = extractionReport?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--session-id");
		expect(longs).toContain("--batch-id");
		expect(longs).toContain("--scenario");
		expect(longs).toContain("--inactive");
		expect(longs).toContain("--json");
	});

	it("registers extraction-replay under memory with replay eval options", () => {
		const extractionReplay = memoryCommand.commands.find(
			(command) => command.name() === "extraction-replay",
		);
		expect(extractionReplay).toBeDefined();
		const longs = extractionReplay?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--batch-id");
		expect(longs).toContain("--observer-tier-routing");
		expect(longs).toContain("--openai-responses");
		expect(longs).toContain("--reasoning-effort");
		expect(longs).toContain("--reasoning-summary");
		expect(longs).toContain("--max-output-tokens");
		expect(longs).toContain("--observer-temperature");
		expect(longs).toContain("--transcript-budget");
		expect(longs).toContain("--scenario");
		expect(longs).toContain("--json");
	});

	it("registers extraction-benchmark under memory with benchmark-runner options", () => {
		const extractionBenchmark = memoryCommand.commands.find(
			(command) => command.name() === "extraction-benchmark",
		);
		expect(extractionBenchmark).toBeDefined();
		const longs = extractionBenchmark?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--benchmark");
		expect(longs).toContain("--observer-provider");
		expect(longs).toContain("--observer-model");
		expect(longs).toContain("--observer-tier-routing");
		expect(longs).toContain("--openai-responses");
		expect(longs).toContain("--reasoning-effort");
		expect(longs).toContain("--reasoning-summary");
		expect(longs).toContain("--max-output-tokens");
		expect(longs).toContain("--observer-temperature");
		expect(longs).toContain("--transcript-budget");
		expect(longs).toContain("--json");
	});

	it("registers relink-report under memory with dry-run analysis options", () => {
		const relinkReport = memoryCommand.commands.find(
			(command) => command.name() === "relink-report",
		);
		expect(relinkReport).toBeDefined();
		const longs = relinkReport?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--limit");
		expect(longs).toContain("--json");
	});

	it("registers relink-plan under memory with dry-run planning options", () => {
		const relinkPlan = memoryCommand.commands.find((command) => command.name() === "relink-plan");
		expect(relinkPlan).toBeDefined();
		const longs = relinkPlan?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--limit");
		expect(longs).toContain("--json");
	});
});
