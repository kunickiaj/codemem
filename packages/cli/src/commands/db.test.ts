import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { initDatabase } from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
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

	it("registers dedup-memories, backfill-dedup-keys, backfill-narrative, and ai-backfill-structured subcommands", () => {
		const dedup = dbCommand.commands.find((command) => command.name() === "dedup-memories");
		const dedupKeys = dbCommand.commands.find(
			(command) => command.name() === "backfill-dedup-keys",
		);
		const narrative = dbCommand.commands.find((command) => command.name() === "backfill-narrative");
		const aiStructured = dbCommand.commands.find(
			(command) => command.name() === "ai-backfill-structured",
		);
		expect(dedup).toBeDefined();
		expect(dedupKeys).toBeDefined();
		expect(narrative).toBeDefined();
		expect(aiStructured).toBeDefined();

		const dedupLongs = dedup?.options.map((option) => option.long) ?? [];
		expect(dedupLongs).toContain("--window");
		expect(dedupLongs).toContain("--limit");
		expect(dedupLongs).toContain("--dry-run");
		expect(dedupLongs).toContain("--json");

		const dedupKeysLongs = dedupKeys?.options.map((option) => option.long) ?? [];
		expect(dedupKeysLongs).toContain("--limit");
		expect(dedupKeysLongs).toContain("--dry-run");
		expect(dedupKeysLongs).toContain("--json");

		const narrativeLongs = narrative?.options.map((option) => option.long) ?? [];
		expect(narrativeLongs).toContain("--limit");
		expect(narrativeLongs).toContain("--dry-run");
		expect(narrativeLongs).toContain("--json");

		const aiLongs = aiStructured?.options.map((option) => option.long) ?? [];
		expect(aiLongs).toContain("--limit");
		expect(aiLongs).toContain("--kinds");
		expect(aiLongs).toContain("--overwrite");
		expect(aiLongs).toContain("--dry-run");
		expect(aiLongs).toContain("--json");
	});

	it("rejects invalid dedup window input", async () => {
		const dedup = dbCommand.commands.find((command) => command.name() === "dedup-memories");
		expect(dedup).toBeDefined();
		if (!dedup) throw new Error("expected dedup-memories command");

		const dbPath = join(mkdtempSync(join(tmpdir(), "codemem-db-cmd-")), "test.sqlite");
		initDatabase(dbPath);
		const logErrorSpy = vi.spyOn(p.log, "error").mockImplementation(() => {});
		const originalExitCode = process.exitCode;
		process.exitCode = undefined;
		try {
			await dedup.parseAsync(["node", "dedup-memories", "--db-path", dbPath, "--window", "foo"], {
				from: "node",
			});
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = originalExitCode;
			logErrorSpy.mockRestore();
		}
	});
});
