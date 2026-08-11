import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportMemoriesCommand } from "./export-memories.js";
import { importMemoriesCommand } from "./import-memories.js";

describe("deprecated top-level alias warnings", () => {
	const originalArgv = process.argv;
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		dir = mkdtempSync(join(tmpdir(), "codemem-alias-"));
		dbPath = join(dir, "alias.sqlite");
		new MemoryStore(dbPath).close();
	});

	afterEach(() => {
		process.argv = originalArgv;
		delete process.env.CODEMEM_EMBEDDING_DISABLED;
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("warns on the top-level alias but keeps JSON automation paths clean", async () => {
		const exportPath = join(dir, "export.json");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		// Top-level file export warns on stderr.
		process.argv = ["node", "codemem", "export-memories", exportPath];
		await exportMemoriesCommand.parseAsync([
			"node",
			"export-memories",
			exportPath,
			"--db-path",
			dbPath,
			"--all-projects",
		]);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("deprecated"));

		// Stdout export streams machine-readable JSON: no stderr warning.
		errorSpy.mockClear();
		process.argv = ["node", "codemem", "export-memories", "-"];
		await exportMemoriesCommand.parseAsync([
			"node",
			"export-memories",
			"-",
			"--db-path",
			dbPath,
			"--all-projects",
		]);
		expect(errorSpy).not.toHaveBeenCalled();

		// JSON-mode import: no stderr warning.
		process.argv = ["node", "codemem", "import-memories", exportPath, "--json"];
		await importMemoriesCommand.parseAsync([
			"node",
			"import-memories",
			exportPath,
			"--db-path",
			dbPath,
			"--json",
		]);
		expect(errorSpy).not.toHaveBeenCalled();

		// Human-mode top-level import still warns.
		process.argv = ["node", "codemem", "import-memories", exportPath];
		await importMemoriesCommand.parseAsync([
			"node",
			"import-memories",
			exportPath,
			"--db-path",
			dbPath,
		]);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
	});
});
