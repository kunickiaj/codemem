import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema } from "@codemem/core";
import { describe, expect, it } from "vitest";
import {
	claudeHookIngestCommand,
	directEnqueue,
	ingestClaudeHookPayload,
} from "./claude-hook-ingest.js";

function createTempDbPath(): { dbPath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "codemem-cli-claude-hook-"));
	const dbPath = join(dir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	return {
		dbPath,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("claude-hook-ingest command", () => {
	it("registers expected options and help text", () => {
		const longs = claudeHookIngestCommand.options.map((option) => option.long);
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--host");
		expect(longs).toContain("--port");

		const help = claudeHookIngestCommand.helpInformation();
		expect(help).toContain("HTTP first");
		expect(help).toContain("direct DB fallback");
	});

	it("returns HTTP result when viewer ingest succeeds", async () => {
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "SessionStart", session_id: "sess-http", cwd: "/tmp/demo" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 2, skipped: 1 }),
				directIngest: () => {
					throw new Error("direct ingest should not be called");
				},
				resolveDb: () => {
					throw new Error("resolveDb should not be called");
				},
			},
		);

		expect(result).toEqual({ inserted: 2, skipped: 1, via: "http" });
	});

	it("falls back to direct ingest when HTTP path fails", async () => {
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "SessionStart", session_id: "sess-direct", cwd: "/tmp/demo" },
			{ host: "127.0.0.1", port: 38888, db: "/tmp/custom.sqlite" },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => ({ inserted: 1, skipped: 0 }),
				resolveDb: () => "/tmp/resolved.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 1, skipped: 0, via: "direct" });
	});

	it("direct enqueue inserts once and then deduplicates event_id", () => {
		const { dbPath, cleanup } = createTempDbPath();
		try {
			const payload = {
				hook_event_name: "SessionStart",
				session_id: "sess-dedup",
				timestamp: "2026-01-01T00:00:00Z",
				cwd: "/tmp/demo",
			};

			const first = directEnqueue(payload, dbPath);
			const second = directEnqueue(payload, dbPath);

			expect(first).toEqual({ inserted: 1, skipped: 0 });
			expect(second).toEqual({ inserted: 0, skipped: 0 });

			const db = connect(dbPath);
			try {
				const rawCount = db.prepare("SELECT COUNT(*) AS c FROM raw_events").get() as { c: number };
				const sessionCount = db.prepare("SELECT COUNT(*) AS c FROM raw_event_sessions").get() as {
					c: number;
				};
				expect(rawCount.c).toBe(1);
				expect(sessionCount.c).toBe(1);
			} finally {
				db.close();
			}
		} finally {
			cleanup();
		}
	});

	it("direct enqueue skips unsupported hook payloads gracefully", () => {
		const { dbPath, cleanup } = createTempDbPath();
		try {
			const result = directEnqueue(
				{ hook_event_name: "UnknownEvent", session_id: "sess-x" },
				dbPath,
			);
			expect(result).toEqual({ inserted: 0, skipped: 1 });
		} finally {
			cleanup();
		}
	});
});
