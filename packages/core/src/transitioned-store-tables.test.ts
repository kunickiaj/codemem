import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	readAccountLinkDevice,
	signAccountLinkRequest,
} from "./coordinator-account-link-signer.js";
import { readCoordinatorOwnerReviewLocalEvidence } from "./coordinator-owner-review-local.js";
import { loadSqliteVec } from "./database-runtime-primitives.js";
import { connect, connectReadOnly } from "./db.js";
import { exportMemories } from "./export-import.js";
import { getMemoryRoleReport } from "./maintenance/memory-role-report.js";
import { prepareOfflineScopeServingStore } from "./offline-serving-preparation.js";
import { columnExists, tableExists } from "./schema-lookups.js";
import { MemoryStore } from "./store.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { insertTestSession } from "./test-utils.js";
import { readVectorCorpusFence } from "./vector-corpus-epoch.js";
import { resolveVectorLayout } from "./vector-layout.js";

let home: string, path: string;
const prep = {
	coordinatorId: "fixture",
	groupId: "team",
	generation: "ddc460b1-6dd8-4489-ab5c-799c2319af62",
};
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "project-storage-"));
	path = join(home, "device.sqlite");
	const db = connect(path);
	try {
		const session = insertTestSession(db);
		db.prepare(`INSERT INTO memory_items(session_id,title,kind,body_text,created_at,updated_at)
		VALUES(?,'initial','discovery','orchid','now','now')`).run(session);
	} finally {
		db.close();
	}
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

it("reads the same identity and signs from the existing key on both store shapes", () => {
	const keysDir = join(home, "keys");
	const db = connect(path);
	try {
		ensureDeviceIdentity(db, { keysDir });
	} finally {
		db.close();
	}
	function profile() {
		const device = readAccountLinkDevice(path);
		expect(
			signAccountLinkRequest({
				dbPath: path,
				device,
				keysDir,
				method: "GET",
				url: "https://example.test/account",
				bodyBytes: Buffer.alloc(0),
			})["X-Opencode-Signature"],
		).toBeTruthy();
		const evidence = readCoordinatorOwnerReviewLocalEvidence({ dbPath: path });
		expect(evidence.memoryCounts.unknown).toBe(1);
		return { device, evidence };
	}
	const expected = profile();
	prepareOfflineScopeServingStore(path, prep, []);
	expect(profile()).toEqual(expected);
});

it("preserves history, updates and deletes from the FTS index, and supports a second group", () => {
	prepareOfflineScopeServingStore(path, prep, []);
	prepareOfflineScopeServingStore(path, { ...prep, groupId: "second" }, []);
	const store = new MemoryStore(path);
	try {
		const db = store.db;
		expect(tableExists(db, "memory_items")).toBe(true);
		expect(columnExists(db, "sync_device", "public_key")).toBe(true);
		expect(readVectorCorpusFence(db).epoch).not.toBeNull();
		const matches = (word: string) =>
			db.prepare(`SELECT body_text FROM memory_fts WHERE memory_fts MATCH ?`).pluck().all(word);
		expect(matches("orchid")).toEqual(["orchid"]);
		db.prepare("UPDATE memory_items SET body_text=? WHERE id=1").run("lilac");
		expect(matches("orchid")).toEqual([]);
		expect(matches("lilac")).toEqual(["lilac"]);
		db.prepare("DELETE FROM memory_items WHERE id=1").run();
		expect(matches("lilac")).toEqual([]);
		expect(db.pragma("foreign_key_check")).toEqual([]);
	} finally {
		store.close();
	}
});

it("keeps literal data, comments, and named bindings unchanged on read-only opens", () => {
	prepareOfflineScopeServingStore(path, prep, []);
	const db = connectReadOnly(path);
	try {
		expect(
			db
				.prepare(`SELECT 'memory_items' AS literal,@sync_device AS value,body_text
			FROM [MEMORY_ITEMS] /* 'memory_items' */ WHERE id=1 -- sync_device`)
				.get({ sync_device: "replication_ops" }),
		).toEqual({ literal: "memory_items", value: "replication_ops", body_text: "orchid" });
	} finally {
		db.close();
	}
});

it("rolls the table changes back when proof validation fails", () => {
	expect(() =>
		prepareOfflineScopeServingStore(path, prep, [
			{ scopeId: "", deviceId: "peer", keyId: "ab".repeat(32), envelope: Buffer.from("x") },
		]),
	).toThrow("Invalid scope serving envelope");
	const db = new Database(path, { readonly: true });
	try {
		expect(
			db.prepare("SELECT body_text FROM memory_fts WHERE memory_fts MATCH 'orchid'").pluck().get(),
		).toBe("orchid");
		expect(
			db
				.prepare(
					"SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('project_memory_items','scope_serving_preparations')",
				)
				.pluck()
				.get(),
		).toBe(0);
	} finally {
		db.close();
	}
});

it("refuses mixed shapes on all current opens rather than using a restored legacy table", () => {
	prepareOfflineScopeServingStore(path, prep, []);
	const raw = new Database(path);
	try {
		raw.exec("CREATE TABLE sync_device(fake TEXT)");
	} finally {
		raw.close();
	}
	expect(() => connect(path)).toThrow("conflicting Project storage format");
	expect(() => connectReadOnly(path)).toThrow("conflicting Project storage format");
});

it("ignores the empty reference tables a released sync pass recreates, and refuses them once filled", () => {
	prepareOfflineScopeServingStore(path, prep, []);
	const raw = new Database(path);
	try {
		// What the additive schema step of 0.49.1 through 0.50.0-beta.4 creates.
		raw.exec(`CREATE TABLE IF NOT EXISTS memory_concept_refs (memory_id INTEGER NOT NULL,
			concept TEXT NOT NULL, PRIMARY KEY (memory_id, concept));
			CREATE TABLE IF NOT EXISTS memory_file_refs (memory_id INTEGER NOT NULL,
			file_path TEXT NOT NULL, relation TEXT NOT NULL, PRIMARY KEY (memory_id, file_path, relation))`);
	} finally {
		raw.close();
	}
	const store = new MemoryStore(path);
	try {
		expect(store.db.prepare("SELECT body_text FROM memory_items").pluck().all()).toEqual([
			"orchid",
		]);
	} finally {
		store.close();
	}
	const filled = new Database(path);
	try {
		filled.prepare("INSERT INTO memory_concept_refs VALUES (1, 'orchid')").run();
	} finally {
		filled.close();
	}
	expect(() => connectReadOnly(path)).toThrow("conflicting Project storage format");
});

/** Names on disk, read without the shape-aware connection. */
function physicalTables(): string[] {
	const raw = new Database(path, { readonly: true });
	try {
		return raw
			.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view')")
			.pluck()
			.all() as string[];
	} finally {
		raw.close();
	}
}

function seedContent(): void {
	const db = connect(path);
	try {
		db.prepare("UPDATE memory_items SET import_key = 'memory-key-1' WHERE id = 1").run();
		db.prepare(
			"INSERT INTO user_prompts(session_id, prompt_text, created_at, created_at_epoch) VALUES (1, 'prompt', 'now', 0)",
		).run();
		db.prepare(
			"INSERT INTO session_summaries(session_id, learned, created_at, created_at_epoch) VALUES (1, 'summary', 'now', 0)",
		).run();
		db.prepare(`INSERT INTO raw_event_sessions(opencode_session_id, stream_id, last_received_event_seq, updated_at)
			VALUES ('stream', 'stream', 2, 'now')`).run();
		for (const seq of [1, 2])
			db.prepare(`INSERT INTO raw_events(stream_id, opencode_session_id, event_seq, event_type, payload_json, created_at)
				VALUES ('stream', 'stream', ?, 'user_prompt', '{}', 'now')`).run(seq);
	} finally {
		db.close();
	}
}

it("moves prompts, summaries, sessions and raw events, and current reads return the same rows", () => {
	seedContent();
	const read = () => {
		const store = new MemoryStore(path);
		try {
			return {
				backlog: store.rawEventBacklogTotals(),
				sessions: store.stats().database.sessions,
				role: getMemoryRoleReport(path, { allProjects: true }).totals,
				exported: (({ exported_at: _at, ...rest }) => rest)(
					exportMemories({ dbPath: path, allProjects: true }),
				),
			};
		} finally {
			store.close();
		}
	};
	const before = read();
	prepareOfflineScopeServingStore(path, prep, []);
	const names = physicalTables();
	for (const table of [
		"sessions",
		"user_prompts",
		"session_summaries",
		"raw_events",
		"artifacts",
	]) {
		expect(names).not.toContain(table);
		expect(names).toContain(`project_${table}`);
	}
	expect(read()).toEqual(before);
	// The backlog is the highest sequence (2) minus the last flushed one (-1 before any flush).
	expect(before.backlog).toEqual({ pending: 3, sessions: 1 });
});

// Current code compares trigger and view definitions to decide whether to repair
// them. Index definitions are only checked by name.
it("keeps every trigger and view definition current code compares", () => {
	const definitions = () => {
		const db = connectReadOnly(path);
		try {
			return db
				.prepare(
					"SELECT name, sql FROM sqlite_schema WHERE type IN ('trigger','view') ORDER BY name",
				)
				.all()
				.map((row) => {
					const { name, sql } = row as { name: string; sql: string };
					return { name, sql: sql.replace(/\s+/g, " ") };
				})
				.filter(({ name }) => !/^memory_items_a[iud]$/.test(name))
				.sort((a, b) => a.name.localeCompare(b.name));
		} finally {
			db.close();
		}
	};
	new MemoryStore(path).close();
	const before = definitions();
	expect(before.map(({ name }) => name)).toContain("memory_vectors");
	prepareOfflineScopeServingStore(path, prep, []);
	expect(physicalTables()).not.toContain("memory_items");
	expect(definitions()).toEqual(before);
});

it("moves the vector index with its rows, and the compatibility view keeps its definition", () => {
	const store = new MemoryStore(path);
	try {
		store.db
			.prepare(`INSERT INTO memory_vectors_v1(rowid, embedding, memory_id, chunk_index, content_hash, model)
				VALUES (7, ?, 1, 0, 'hash', 'model')`)
			.run(new Float32Array(384).fill(0.5));
	} finally {
		store.close();
	}
	prepareOfflineScopeServingStore(path, prep, []);
	const names = physicalTables();
	expect(names.filter((name) => name.startsWith("memory_vectors"))).toEqual([]);
	expect(names).toEqual(
		expect.arrayContaining(["project_memory_vectors", "project_memory_vectors_v1"]),
	);
	const reopened = new MemoryStore(path);
	try {
		expect(resolveVectorLayout(reopened.db).kind).toBe("v1");
		expect(
			reopened.db
				.prepare(
					"SELECT rowid, memory_id, vec_distance_l2(embedding, ?) AS d FROM memory_vectors ORDER BY d LIMIT 1",
				)
				.get(new Float32Array(384).fill(0.5)),
		).toEqual({ rowid: 7, memory_id: 1, d: 0 });
		expect(() =>
			reopened.db.prepare("INSERT INTO memory_vectors(memory_id) VALUES (2)").run(),
		).toThrow("vector_writer_upgrade_required");
	} finally {
		reopened.close();
	}
});

it("moves a legacy vector table before the vector index upgrade has run", () => {
	const db = connect(path);
	try {
		loadSqliteVec(db);
		db.prepare(`INSERT INTO memory_vectors(rowid, embedding, memory_id, chunk_index, content_hash, model)
			VALUES (3, ?, 1, 0, 'hash', 'model')`).run(new Float32Array(384).fill(0.25));
	} finally {
		db.close();
	}
	prepareOfflineScopeServingStore(path, prep, []);
	expect(physicalTables().filter((name) => name.startsWith("memory_vectors"))).toEqual([]);
	const store = new MemoryStore(path);
	try {
		expect(store.db.prepare("SELECT rowid, memory_id FROM memory_vectors").all()).toEqual([
			{ rowid: 3, memory_id: 1 },
		]);
	} finally {
		store.close();
	}
});

it("keeps a column alias that shares a moved table's name", () => {
	prepareOfflineScopeServingStore(path, prep, []);
	const db = connectReadOnly(path);
	try {
		expect(
			db
				.prepare(`WITH bounded AS (SELECT id, project FROM sessions)
					SELECT sessions.project, (SELECT COUNT(*) FROM sessions s) AS sessions
					FROM bounded AS sessions`)
				.get(),
		).toEqual({ project: "test-project", sessions: 1 });
	} finally {
		db.close();
	}
	expect(physicalTables()).not.toContain("sessions");
});
