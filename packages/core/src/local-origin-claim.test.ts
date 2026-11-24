import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExportPayload, importMemories } from "./export-import.js";
import { claimLocalOrigin } from "./local-origin-claim.js";
import { applyReplicationOps, recordReplicationOp } from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

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

/**
 * A session started here that export bookkeeping keyed, holding one memory
 * written here, then an import of an export naming that key, which adds the
 * other device's memory to the same local session.
 */
function importIntoLocalSession(dbPath: string): { nativeId: number; importedId: number } {
	const marker = `export-session:v1:${"f".repeat(64)}`;
	const local = new Database(dbPath);
	const session = local
		.prepare(`INSERT INTO sessions(started_at, project, user, tool_version, import_key, metadata_json)
			VALUES ('2026-03-01T00:00:00Z', 'api', 'adam', 'plugin-ts', ?, '{}')`)
		.run(marker);
	const nativeId = Number(
		local
			.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, active, created_at,
				updated_at, visibility, origin_device_id, import_key)
				VALUES (?, 'discovery', 'mine', 'body', 1, '2026-03-01T00:00:00Z',
				'2026-03-01T00:00:00Z', 'shared', 'local', 'memory-native')`)
			.run(Number(session.lastInsertRowid)).lastInsertRowid,
	);
	local.close();
	importMemories(preSyncExport({ export_session_key: marker, export_session_redacted: true }), {
		dbPath,
	});
	const after = new Database(dbPath, { readonly: true });
	const importedId = Number(
		after
			.prepare("SELECT id FROM memory_items WHERE import_key = 'memory-other-device'")
			.pluck()
			.get(),
	);
	after.close();
	return { nativeId, importedId };
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

	it("leaves a memory imported into an existing local session alone", () => {
		// Arrange
		const { nativeId, importedId } = importIntoLocalSession(dbPath);
		db = new Database(dbPath);

		// Act
		const claimed = [
			claimLocalOrigin(db, importedId, "owner"),
			claimLocalOrigin(db, nativeId, "owner"),
		];

		// Assert
		expect(db.prepare("SELECT COUNT(*) FROM sessions").pluck().get()).toBe(1);
		expect(claimed).toEqual([false, true]);
	});

	it("keeps an imported memory unclaimed after a peer's update replaces its metadata", () => {
		// Arrange: a peer's newer update of the memory imported into a local
		// session, with empty metadata and no origin.
		const { nativeId } = importIntoLocalSession(dbPath);
		const peer = new Database(":memory:");
		initTestSchema(peer);
		const at = "2026-03-02T00:00:00Z";
		const peerSessionId = Number(
			peer.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'api')").run(at)
				.lastInsertRowid,
		);
		const peerMemoryId = Number(
			peer
				.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, active, created_at,
					updated_at, metadata_json, visibility, import_key, rev)
					VALUES (?, 'discovery', 'edited by peer', 'body', 1, ?, ?, '{}', 'shared',
					'memory-other-device', 9)`)
				.run(peerSessionId, at, at).lastInsertRowid,
		);
		recordReplicationOp(peer, { memoryId: peerMemoryId, opType: "upsert", deviceId: "peer" });
		const update = peer.prepare("SELECT * FROM replication_ops").all() as ReplicationOp[];
		peer.close();
		db = new Database(dbPath);

		// Act
		const applied = applyReplicationOps(db, update, "owner");
		const memory = db
			.prepare(`SELECT id, title, origin_device_id FROM memory_items
				WHERE import_key = 'memory-other-device'`)
			.get() as { id: number; title: string; origin_device_id: string | null };

		// Assert
		expect(applied.applied).toBe(1);
		expect(memory).toMatchObject({ title: "edited by peer", origin_device_id: "local" });
		expect(claimLocalOrigin(db, memory.id, "owner")).toBe(false);
		expect(claimLocalOrigin(db, nativeId, "owner")).toBe(true);
	});

	it("claims a memory whose local session only export bookkeeping keyed", () => {
		// Arrange: export bookkeeping writes the canonical key onto local sessions too.
		db = new Database(dbPath);
		const session = db
			.prepare(`INSERT INTO sessions(started_at, project, user, tool_version, import_key, metadata_json)
				VALUES ('2026-03-01T00:00:00Z', 'api', 'adam', 'plugin-ts', ?, '{}')`)
			.run(`export-session:v1:${"e".repeat(64)}`);
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
