import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, getSchemaVersion, SCHEMA_VERSION } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statsCommand } from "./stats.js";

describe("stats command", () => {
	let tmpDir: string;
	let prevCodememConfig: string | undefined;

	beforeEach(() => {
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-stats-command-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
	});

	afterEach(() => {
		if (prevCodememConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("auto-initializes a fresh database before reporting stats", async () => {
		const dbPath = join(tmpDir, "fresh.sqlite");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await statsCommand.parseAsync(["--db-path", dbPath, "--json"], { from: "user" });

			const output = logSpy.mock.calls.at(-1)?.[0];
			expect(typeof output).toBe("string");
			const result = JSON.parse(String(output));
			expect(result.database.path).toBe(dbPath);
			expect(result.database.memory_items).toBe(0);

			const db = connect(dbPath);
			try {
				expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
			} finally {
				db.close();
			}
		} finally {
			logSpy.mockRestore();
		}
	});
});
