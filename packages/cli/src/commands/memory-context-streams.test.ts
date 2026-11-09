import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("plain context process streams", () => {
	it.each([{ subcommand: [] }, { subcommand: ["trace"] }])(
		"keeps usage errors off stdout for context $subcommand",
		({ subcommand }) => {
			// Arrange: isolate config/database and reject input before retrieval or model access.
			const directory = mkdtempSync(join(tmpdir(), "codemem-context-streams-"));
			const configPath = join(directory, "config.json");
			writeFileSync(configPath, "{}");
			try {
				// Act: execute source without console or Clack mocks so actual stream routing is checked.
				const result = spawnSync(
					process.execPath,
					[
						"--import",
						"tsx",
						"--conditions",
						"source",
						resolve(import.meta.dirname, "../index.ts"),
						"memory",
						"context",
						...subcommand,
						"fixture task",
						"--limit",
						"0",
						"--db-path",
						join(directory, "test.sqlite"),
					],
					{
						cwd: resolve(import.meta.dirname, "../../../.."),
						encoding: "utf8",
						timeout: 15_000,
						env: {
							...process.env,
							HOME: directory,
							CODEMEM_CONFIG: configPath,
							CODEMEM_PROJECT: "",
							NO_COLOR: "1",
						},
					},
				);
				// Assert: command substitution must never capture errors as prompt memory.
				expect(result.error).toBeUndefined();
				expect(result.status).toBe(2);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("limit must be a positive integer");
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});

describe("internal ledger command boundary", () => {
	it("dispatches the ledger callback and rejects malformed stdin as a usage error", () => {
		// Arrange: keep the legacy ledger report style and use only a test-owned database.
		const directory = mkdtempSync(join(tmpdir(), "codemem-ledger-command-"));
		const configPath = join(directory, "config.json");
		writeFileSync(configPath, "{}");
		try {
			// Act: pipe malformed JSON through the parsed command and shared store helper.
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--conditions",
					"source",
					resolve(import.meta.dirname, "../index.ts"),
					"prompt-pack-ledger",
					"--db-path",
					join(directory, "test.sqlite"),
				],
				{
					cwd: resolve(import.meta.dirname, "../../../.."),
					input: "not-json",
					encoding: "utf8",
					timeout: 15_000,
					env: {
						...process.env,
						HOME: directory,
						CODEMEM_CONFIG: configPath,
						CODEMEM_PROJECT: "",
						NO_COLOR: "1",
					},
				},
			);
			// Assert: failure must come from ledger validation, not broken callback dispatch.
			const output = result.stdout + result.stderr;
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(2);
			expect(output).toContain("internal ledger metadata must be valid JSON");
			expect(output).not.toContain("run is not a function");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
