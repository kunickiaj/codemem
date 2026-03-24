import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { exportMemories, importMemories, readImportPayload } from "./export-import.js";
import { initTestSchema } from "./test-utils.js";

function createDbPath(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-export-import-"));
	return join(dir, `${name}.sqlite`);
}

function seedSourceDb(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		initTestSchema(db);
		db.prepare(
			`INSERT INTO sessions(id, started_at, cwd, project, user, tool_version, metadata_json, import_key)
			 VALUES (1, '2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'adam', 'test', '{"k":1}', 'sess-1')`,
		).run();
		db.prepare(
			`INSERT INTO user_prompts(id, session_id, project, prompt_text, prompt_number, created_at, created_at_epoch, metadata_json, import_key)
			 VALUES (10, 1, 'codemem', 'Run tests', 1, '2026-03-01T10:01:00Z', 1, '{"p":1}', 'prompt-1')`,
		).run();
		db.prepare(
			`INSERT INTO memory_items(
				id, session_id, kind, title, body_text, confidence, tags_text, active,
				created_at, updated_at, metadata_json, facts, concepts, files_read, files_modified,
				user_prompt_id, prompt_number, import_key
			) VALUES (
				100, 1, 'feature', 'Added export', 'implemented export', 0.9, 'ts export', 1,
				'2026-03-01T10:02:00Z', '2026-03-01T10:02:00Z', '{"m":1}', '["fact"]', '["concept"]', '["a.ts"]', '["b.ts"]',
				10, 1, 'memory-1'
			)`,
		).run();
		db.prepare(
			`INSERT INTO memory_items(
				id, session_id, kind, title, body_text, confidence, tags_text, active,
				created_at, updated_at, metadata_json, deleted_at, import_key
			) VALUES (
				101, 1, 'exploration', 'Inactive', 'skipped by default', 0.5, '', 0,
				'2026-03-01T10:03:00Z', '2026-03-01T10:03:00Z', '{}', '2026-03-01T10:03:30Z', 'memory-2'
			)`,
		).run();
		db.prepare(
			`INSERT INTO session_summaries(
				id, session_id, project, request, investigated, learned, completed, next_steps,
				notes, files_read, files_edited, prompt_number, created_at, created_at_epoch, metadata_json, import_key
			) VALUES (
				200, 1, 'codemem', 'ship export', 'cli parity', 'ts store is thinner', 'ported base', 'port config next',
				'', '["a.ts"]', '["b.ts"]', 1, '2026-03-01T10:04:00Z', 1, '{"s":1}', 'summary-1'
			)`,
		).run();
	} finally {
		db.close();
	}
}

describe("export/import", () => {
	it("exports parsed JSON fields and prompt import key links", () => {
		const dbPath = createDbPath("source");
		seedSourceDb(dbPath);

		const payload = exportMemories({ dbPath });

		expect(payload.version).toBe("1.0");
		expect(payload.sessions).toHaveLength(1);
		expect(payload.memory_items).toHaveLength(1);
		expect(payload.session_summaries).toHaveLength(1);
		expect(payload.user_prompts).toHaveLength(1);
		expect(payload.sessions[0]?.metadata_json).toEqual({ k: 1 });
		expect(payload.memory_items[0]?.facts).toEqual(["fact"]);
		expect(payload.memory_items[0]?.user_prompt_import_key).toBe("prompt-1");
	});

	it("includes inactive memories when requested", () => {
		const dbPath = createDbPath("inactive");
		seedSourceDb(dbPath);

		const payload = exportMemories({ dbPath, includeInactive: true });

		expect(payload.memory_items).toHaveLength(2);
	});

	it("imports idempotently and supports dry run", () => {
		const sourcePath = createDbPath("source-import");
		seedSourceDb(sourcePath);
		const payload = exportMemories({ dbPath: sourcePath, includeInactive: true });

		const destPath = createDbPath("dest-import");
		const destDb = new Database(destPath);
		initTestSchema(destDb);
		destDb.close();

		const dryRun = importMemories(payload, { dbPath: destPath, dryRun: true });
		expect(dryRun.dryRun).toBe(true);
		expect(dryRun.sessions).toBe(1);

		const first = importMemories(payload, { dbPath: destPath, remapProject: "/tmp/remapped" });
		expect(first.sessions).toBe(1);
		expect(first.user_prompts).toBe(1);
		expect(first.memory_items).toBe(2);
		expect(first.session_summaries).toBe(1);

		const second = importMemories(payload, { dbPath: destPath, remapProject: "/tmp/remapped" });
		expect(second.sessions).toBe(0);
		expect(second.user_prompts).toBe(0);
		expect(second.memory_items).toBe(0);
		expect(second.session_summaries).toBe(0);

		const checkDb = new Database(destPath, { readonly: true });
		try {
			const promptEpoch = (
				checkDb.prepare("SELECT created_at_epoch FROM user_prompts LIMIT 1").get() as {
					created_at_epoch: number;
				}
			).created_at_epoch;
			const summaryEpoch = (
				checkDb.prepare("SELECT created_at_epoch FROM session_summaries LIMIT 1").get() as {
					created_at_epoch: number;
				}
			).created_at_epoch;
			const counts = {
				sessions: (checkDb.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
				prompts: (checkDb.prepare("SELECT COUNT(*) AS n FROM user_prompts").get() as { n: number })
					.n,
				memories: (checkDb.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number })
					.n,
				summaries: (
					checkDb.prepare("SELECT COUNT(*) AS n FROM session_summaries").get() as { n: number }
				).n,
				project: (
					checkDb.prepare("SELECT project FROM sessions LIMIT 1").get() as { project: string }
				).project,
				inactiveMemory: checkDb
					.prepare("SELECT active, deleted_at FROM memory_items WHERE import_key = ?")
					.get("memory-2") as { active: number; deleted_at: string | null },
			};
			expect(counts).toEqual({
				sessions: 1,
				prompts: 1,
				memories: 2,
				summaries: 1,
				project: "/tmp/remapped",
				inactiveMemory: { active: 0, deleted_at: "2026-03-01T10:03:30Z" },
			});
			// Original created_at_epoch values (1) from the source DB are preserved
			expect(promptEpoch).toBe(1);
			expect(summaryEpoch).toBe(1);
		} finally {
			checkDb.close();
		}
	});

	it("reads import payload from file", () => {
		const file = join(mkdtempSync(join(tmpdir(), "codemem-export-file-")), "export.json");
		writeFileSync(
			file,
			JSON.stringify({
				version: "1.0",
				exported_at: "2026-03-01T00:00:00Z",
				export_metadata: {},
				sessions: [],
				memory_items: [],
				session_summaries: [],
				user_prompts: [],
			}),
			"utf8",
		);

		const payload = readImportPayload(file);
		expect(payload.version).toBe("1.0");
		expect(readFileSync(file, "utf8")).toContain('"1.0"');
	});
});
