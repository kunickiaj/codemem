import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExportPayload, importMemories } from "./export-import.js";
import { claimLocalOrigin } from "./local-origin-claim.js";
import { initTestSchema } from "./test-utils.js";

/** Another device's export of a memory it wrote before it had a sync identity. */
function preSyncExport(session: Record<string, unknown>): ExportPayload {
	return {
		version: "1.0",
		exported_at: "2026-03-01T00:00:00Z",
		export_metadata: {
			tool_version: "codemem",
			projects: ["api"],
			total_memories: 1,
			total_sessions: 1,
			include_inactive: false,
			filters: {},
		},
		sessions: [{ id: 1, ...session }],
		memory_items: [
			{
				id: 1,
				session_id: 1,
				project: "api",
				kind: "discovery",
				title: "written on the other device",
				body_text: "body",
				visibility: "shared",
				origin_device_id: "local",
				import_key: "memory-other-device",
			},
		],
		user_prompts: [],
		session_summaries: [],
	};
}

describe("claimLocalOrigin", () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(mkdtempSync(join(tmpdir(), "codemem-origin-claim-")), "test.sqlite");
		const db = new Database(dbPath);
		initTestSchema(db);
		db.close();
	});

	let db: InstanceType<typeof Database> | undefined;
	afterEach(() => {
		db?.close();
		db = undefined;
	});

	function onlyMemory(): { id: number; origin_device_id: string | null } {
		db ??= new Database(dbPath);
		return db.prepare("SELECT id, origin_device_id FROM memory_items").get() as {
			id: number;
			origin_device_id: string | null;
		};
	}

	it.each([
		[
			"a redacted export",
			{ export_session_key: `export-session:v1:${"a".repeat(64)}`, export_session_redacted: true },
		],
		["a full export", { project: "api", started_at: "2026-03-01T00:00:00Z", user: "other" }],
	])("leaves a memory imported from %s alone", (_label, session) => {
		// Arrange
		importMemories(preSyncExport(session), { dbPath });
		const memory = onlyMemory();
		expect(memory.origin_device_id).toBe("local");

		// Act
		const claimed = claimLocalOrigin(db as InstanceType<typeof Database>, memory.id, "owner");

		// Assert
		expect(claimed).toBe(false);
		expect(onlyMemory().origin_device_id).toBe("local");
	});

	it("claims a memory from a session started on this device", () => {
		// Arrange: sessions started here get a random key.
		db = new Database(dbPath);
		const session = db
			.prepare(`INSERT INTO sessions(started_at, project, user, tool_version, import_key)
				VALUES ('2026-03-01T00:00:00Z', 'api', 'adam', 'plugin-ts', '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d')`)
			.run();
		const memoryId = Number(
			db
				.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, active, created_at,
					updated_at, visibility, origin_device_id)
					VALUES (?, 'discovery', 'mine', 'body', 1, '2026-03-01T00:00:00Z',
					'2026-03-01T00:00:00Z', 'shared', 'local')`)
				.run(Number(session.lastInsertRowid)).lastInsertRowid,
		);

		// Act
		const claimed = claimLocalOrigin(db, memoryId, "owner");

		// Assert
		expect(claimed).toBe(true);
		expect(onlyMemory().origin_device_id).toBe("owner");
	});
});
