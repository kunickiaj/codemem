import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { loadSqliteVec } from "./db.js";
import { DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL } from "./embeddings.js";
import { MemoryStore } from "./index.js";
import {
	createFixture,
	MODEL,
	type RankingFixture,
	vector,
} from "./semantic/semantic-ranking.test-helper.js";
import { readCatalog, readState } from "./semantic/validated-vector-index-state.js";
import { upgradeVectorIndex } from "./vector-index-upgrade.js";

type Connection = Database.Database;
interface VectorRow {
	rowid: number;
	embedding: Buffer;
	memory_id: number;
	chunk_index: number;
	content_hash: string;
	model: string | null;
}

let directory: string;
let fixture: RankingFixture;
let store: MemoryStore | undefined;
const connections: Connection[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-vector-upgrade-"));
	for (const key of Object.keys(process.env).filter((key) => key.startsWith("CODEMEM_"))) {
		vi.stubEnv(key, "");
	}
	for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
		vi.stubEnv(key, directory);
	}
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_DEVICE_ID", "fixture-device");
	vi.stubEnv("CODEMEM_ACTOR_ID", "local:fixture-device");
	// Legacy bootstrap creates vec0 only when vector support is enabled; no inference is requested.
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	vi.stubEnv("HF_HUB_OFFLINE", "1");
	vi.stubEnv("TRANSFORMERS_OFFLINE", "1");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("test forbids network"));
	fixture = createFixture(directory);
	connections.push(fixture.db);
	fixture.db
		.prepare(`INSERT INTO artifacts(session_id,kind,content_text,content_hash,created_at)
	 VALUES (1,'source','Preserve source text','source-hash','2026-01-01T00:00:00.000Z')`)
		.run();
	const tombstone = fixture.memory();
	fixture.db
		.prepare(`UPDATE memory_items SET active=0,deleted_at='2026-01-02T00:00:00.000Z',rev=7
	 WHERE id=?`)
		.run(tombstone);
});

afterEach(async () => {
	vi.restoreAllMocks();
	try {
		await store?.closeAsync();
	} finally {
		store = undefined;
		for (const db of connections.splice(0)) {
			if (db.open) db.close();
		}
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	}
});

function openStore(): MemoryStore {
	store = new MemoryStore(fixture.path, {
		keysDir: join(directory, "keys"),
		runtimeSigningKey: { deviceId: "fixture-device", publicKey: CANONICAL_PUBLIC_KEY },
	});
	return store;
}

function secondConnection(): Connection {
	const db = new Database(fixture.path);
	loadSqliteVec(db);
	connections.push(db);
	return db;
}

function rows(db: Connection): VectorRow[] {
	return db
		.prepare(
			"SELECT rowid, embedding, memory_id, chunk_index, content_hash, model FROM memory_vectors ORDER BY rowid",
		)
		.all() as VectorRow[];
}

// Buffer.equals avoids assertion-library recursion over sqlite-vec's returned blobs.
function expectSameVectors(actual: VectorRow[], expected: VectorRow[]): void {
	expect(actual).toHaveLength(expected.length);
	for (const [index, row] of actual.entries()) {
		const previous = expected[index];
		expect(previous).toBeDefined();
		if (!previous) throw new Error("missing snapshot row");
		expect(row.embedding.equals(previous.embedding)).toBe(true);
		const { embedding: _actual, ...metadata } = row;
		const { embedding: _expected, ...previousMetadata } = previous;
		expect(metadata).toEqual(previousMetadata);
	}
}

function schemaSnapshot(db: Connection) {
	return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").all();
}

function sourceSnapshot(db: Connection) {
	return {
		memories: db.prepare("SELECT * FROM memory_items ORDER BY id").all(),
		artifacts: db.prepare("SELECT * FROM artifacts ORDER BY id").all(),
		sessions: db.prepare("SELECT * FROM sessions ORDER BY id").all(),
		scopes: db.prepare("SELECT * FROM replication_scopes ORDER BY scope_id").all(),
		memberships: db.prepare("SELECT * FROM scope_memberships ORDER BY scope_id").all(),
		operations: db.prepare("SELECT * FROM replication_ops ORDER BY op_id").all(),
	};
}

function indexSnapshot(db: Connection) {
	return {
		state: readState(db),
		rows: db.prepare("SELECT * FROM validated_vector_rows ORDER BY rowid").all(),
		models: db
			.prepare("SELECT * FROM validated_vector_models ORDER BY model_null, model_key")
			.all(),
		versions: db
			.prepare("SELECT * FROM validated_vector_versions ORDER BY memory_id, model_null, model_key")
			.all(),
	};
}

function upgrade() {
	return upgradeVectorIndex(fixture.db, { configuredModel: MODEL });
}

function explicitLegacyRowid(rowid: bigint, memoryId: number, model: string): void {
	fixture.db
		.prepare(`INSERT INTO memory_vectors(rowid,embedding,memory_id,chunk_index,content_hash,model)
	 VALUES (?,?,?,0,'explicit-rowid-hash',?)`)
		.run(rowid, Buffer.from(vector(1).buffer), BigInt(memoryId), model);
}

describe("automatic vector layout upgrade", () => {
	it("upgrades an ordinary MemoryStore open and preserves explicit rowids, bytes, and source data", () => {
		// Arrange: bootstrap remains the raw legacy fixture path, not a production upgrade.
		const id = fixture.memory();
		explicitLegacyRowid(41n, id, DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL);
		// Match the existing session-project backfill before comparing an ordinary store open.
		fixture.db.prepare("UPDATE memory_items SET project='fixture' WHERE session_id=1").run();
		const before = rows(fixture.db);
		const source = sourceSnapshot(fixture.db);
		fixture.db.close();

		// Act
		const current = openStore();

		// Assert: opening alone must perform the migration, without helper attachment or inference.
		expect(
			current.db.prepare("SELECT type FROM sqlite_schema WHERE name='memory_vectors'").get(),
		).toEqual({ type: "view" });
		expect(
			current.db
				.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_vectors_v1'")
				.pluck()
				.get(),
		).toMatch(/USING vec0\([\s\S]*embedding float\[384\]/i);
		expectSameVectors(rows(current.db), before);
		expect(current.db.prepare("SELECT rowid FROM memory_vectors WHERE rowid=41").all()).toEqual([
			{ rowid: 41 },
		]);
		expect(sourceSnapshot(current.db)).toEqual(source);
		expect(readCatalog(current.db)).toMatchObject({
			status: "ready",
			writerVersion: 1,
			models: [{ model: DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL, count: 1 }],
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("opens an empty legacy store with a ready, empty vector catalog", () => {
		// Arrange
		fixture.db.close();

		// Act
		const current = openStore();

		// Assert
		expect(readCatalog(current.db)).toMatchObject({
			status: "ready",
			writerVersion: 1,
			models: [],
		});
		expect(rows(current.db)).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("does not re-audit or change generation, revision, or versions on repeated upgrade", () => {
		// Arrange
		explicitLegacyRowid(41n, fixture.memory(), MODEL);
		upgrade();
		const before = indexSnapshot(fixture.db);
		const vectors = rows(fixture.db);

		// Act
		const catalog = upgrade();

		// Assert
		expect(catalog).toEqual(readCatalog(fixture.db));
		expect(indexSnapshot(fixture.db)).toEqual(before);
		expectSameVectors(rows(fixture.db), vectors);
	});

	it("copies bad norms, nonfinite bytes, and unknown models but excludes them from valid audit rows", () => {
		// Arrange
		const id = fixture.memory();
		const good = fixture.rawVector(id, vector(1));
		const norm = fixture.rawVector(id, vector(3), 1);
		const nonfinite = fixture.rawVector(id, vector(Number.NaN), 2);
		const unknown = fixture.rawVector(id, vector(1), 3, "unrecognized-model");
		const before = rows(fixture.db);
		const source = sourceSnapshot(fixture.db);

		// Act
		const catalog = upgrade();

		// Assert: preserve repair inputs; never trust observed labels as a model manifest.
		expect(catalog?.status).toBe("needsrepair");
		expectSameVectors(rows(fixture.db), before);
		expect(sourceSnapshot(fixture.db)).toEqual(source);
		expect(
			fixture.db
				.prepare("SELECT rowid,audit_state,reason FROM validated_vector_rows ORDER BY rowid")
				.all(),
		).toEqual([
			{ rowid: good, audit_state: "valid", reason: null },
			{ rowid: norm, audit_state: "invalid", reason: "norm" },
			{ rowid: nonfinite, audit_state: "invalid", reason: "nonfinite" },
			{ rowid: unknown, audit_state: "invalid", reason: "model" },
		]);
		expect(readState(fixture.db)).toMatchObject({
			known_models: JSON.stringify([MODEL]),
			pending_count: 0,
			invalid_count: 3,
		});
	});
});

describe("persisted upgrade model declarations", () => {
	it("accepts persisted source and target models without accepting arbitrary observed labels", () => {
		// Arrange
		const id = fixture.memory();
		fixture.rawVector(id, vector(1), 0, "previous-model");
		fixture.rawVector(id, vector(1), 1, "next-model");
		fixture.rawVector(id, vector(1), 2, "unrecognized-model");
		fixture.db
			.prepare(`INSERT INTO maintenance_jobs(kind,title,status,metadata_json,updated_at)
		 VALUES ('vector_model_migration','Model migration','running',?,'2026-01-01T00:00:00.000Z')`)
			.run(JSON.stringify({ source_model: "previous-model", target_model: "next-model" }));
		const before = rows(fixture.db);

		// Act
		upgrade();

		// Assert
		expect(new Set(JSON.parse(readState(fixture.db).known_models))).toEqual(
			new Set([MODEL, "previous-model", "next-model"]),
		);
		expect(
			fixture.db
				.prepare("SELECT model,audit_state FROM validated_vector_rows ORDER BY rowid")
				.all(),
		).toEqual([
			{ model: "previous-model", audit_state: "valid" },
			{ model: "next-model", audit_state: "valid" },
			{ model: "unrecognized-model", audit_state: "invalid" },
		]);
		expectSameVectors(rows(fixture.db), before);
	});
});

describe("compatibility view writer fencing", () => {
	it("fences INSERT and UPDATE statements prepared on an old connection before cutover", () => {
		// Arrange
		const id = fixture.memory();
		const rowid = fixture.rawVector(id, vector(1));
		const old = secondConnection();
		const insert = old.prepare(
			"INSERT INTO memory_vectors(embedding,memory_id,chunk_index,content_hash,model) VALUES (?,?,?,?,?)",
		);
		const update = old.prepare("UPDATE memory_vectors SET content_hash=? WHERE rowid=?");
		upgrade();
		const before = rows(fixture.db);
		const index = indexSnapshot(fixture.db);

		// Act / Assert: SQLite must recompile old statements against the fenced view.
		expect(() =>
			insert.run(Buffer.from(vector(1).buffer), BigInt(id), 1n, "old-writer", MODEL),
		).toThrow("vector_writer_upgrade_required");
		expect(() => update.run("old-writer", BigInt(rowid))).toThrow("vector_writer_upgrade_required");
		expectSameVectors(rows(fixture.db), before);
		expect(indexSnapshot(fixture.db)).toEqual(index);
	});

	it.each(["INSERT", "UPDATE"] as const)(
		"rejects a newly prepared legacy %s without changing catalog state",
		(operation) => {
			// Arrange
			fixture.rawVector(fixture.memory(), vector(1));
			upgrade();
			const before = rows(fixture.db);
			const index = indexSnapshot(fixture.db);
			const sql =
				operation === "INSERT"
					? "INSERT INTO memory_vectors(embedding,memory_id,chunk_index,content_hash,model) SELECT embedding,memory_id,chunk_index,content_hash,model FROM memory_vectors"
					: "UPDATE memory_vectors SET content_hash='legacy-write'";

			// Act / Assert
			expect(() => fixture.db.exec(sql)).toThrow("vector_writer_upgrade_required");
			expectSameVectors(rows(fixture.db), before);
			expect(indexSnapshot(fixture.db)).toEqual(index);
		},
	);
});

describe("compatibility view retirement deletes", () => {
	it.each(["rowid", "memory_id"] as const)(
		"deletes by legacy %s and updates counts, versions, and audit state in the same transaction",
		(selector) => {
			// Arrange
			const id = fixture.memory();
			const rowid = fixture.rawVector(id, vector(3));
			const retainedId = fixture.memory();
			const retained = fixture.rawVector(retainedId, vector(1));
			upgrade();
			const before = readState(fixture.db);
			const source = sourceSnapshot(fixture.db);
			const version = fixture.db
				.prepare("SELECT version FROM validated_vector_versions WHERE memory_id=?")
				.pluck()
				.get(id) as number;
			const value = selector === "rowid" ? rowid : id;

			// Act
			fixture.db
				.transaction(() =>
					fixture.db.prepare(`DELETE FROM memory_vectors WHERE ${selector}=?`).run(BigInt(value)),
				)
				.immediate();

			// Assert: no source or scope authority mutation is hidden in the compatibility delete.
			expect(
				fixture.db.prepare("SELECT rowid FROM memory_vectors_v1 ORDER BY rowid").all(),
			).toEqual([{ rowid: retained }]);
			expect(
				fixture.db.prepare("SELECT rowid FROM validated_vector_rows ORDER BY rowid").all(),
			).toEqual([{ rowid: retained }]);
			expect(
				fixture.db
					.prepare("SELECT count FROM validated_vector_models WHERE model=?")
					.pluck()
					.get(MODEL),
			).toBe(1);
			expect(
				fixture.db
					.prepare("SELECT version,count FROM validated_vector_versions WHERE memory_id=?")
					.get(id),
			).toEqual({ version: version + 1, count: 0 });
			expect(readState(fixture.db)).toMatchObject({
				generation_id: before.generation_id,
				revision: before.revision + 1,
				pending_count: 0,
				invalid_count: 0,
				status: "ready",
			});
			expect(sourceSnapshot(fixture.db)).toEqual(source);
		},
	);

	it("rolls compatibility deletion back with its surrounding transaction", () => {
		// Arrange
		const id = fixture.memory();
		fixture.rawVector(id, vector(1));
		fixture.rawVector(id, vector(3), 1);
		upgrade();
		const before = rows(fixture.db);
		const index = indexSnapshot(fixture.db);
		const source = sourceSnapshot(fixture.db);

		// Act / Assert
		expect(() =>
			fixture.db
				.transaction(() => {
					fixture.db.prepare("DELETE FROM memory_vectors WHERE memory_id=?").run(BigInt(id));
					throw new Error("retirement transaction failed");
				})
				.immediate(),
		).toThrow("retirement transaction failed");
		expectSameVectors(rows(fixture.db), before);
		expect(indexSnapshot(fixture.db)).toEqual(index);
		expect(sourceSnapshot(fixture.db)).toEqual(source);
	});

	it("treats deletion of a missing row as a no-op without bumping revision", () => {
		// Arrange
		fixture.rawVector(fixture.memory(), vector(1));
		upgrade();
		const before = rows(fixture.db);
		const index = indexSnapshot(fixture.db);

		// Act
		fixture.db.prepare("DELETE FROM memory_vectors WHERE rowid=?").run(999n);

		// Assert
		expectSameVectors(rows(fixture.db), before);
		expect(indexSnapshot(fixture.db)).toEqual(index);
	});
});

describe("compatibility deletion consistency", () => {
	it("deletes every chunk for selected memory IDs while retaining other memories", () => {
		// Arrange
		const first = fixture.memory();
		const second = fixture.memory();
		fixture.rawVector(first, vector(1));
		fixture.rawVector(first, vector(3), 1);
		fixture.rawVector(second, vector(1));
		const retained = fixture.rawVector(fixture.memory(), vector(1));
		upgrade();
		const state = readState(fixture.db);
		const source = sourceSnapshot(fixture.db);

		// Act
		fixture.db
			.prepare("DELETE FROM memory_vectors WHERE memory_id IN (?,?)")
			.run(BigInt(first), BigInt(second));

		// Assert
		expect(fixture.db.prepare("SELECT rowid FROM memory_vectors_v1").all()).toEqual([
			{ rowid: retained },
		]);
		expect(fixture.db.prepare("SELECT rowid FROM validated_vector_rows").all()).toEqual([
			{ rowid: retained },
		]);
		expect(
			fixture.db
				.prepare(
					"SELECT memory_id,count FROM validated_vector_versions WHERE memory_id IN (?,?) ORDER BY memory_id",
				)
				.all(first, second),
		).toEqual([
			{ memory_id: first, count: 0 },
			{ memory_id: second, count: 0 },
		]);
		expect(readState(fixture.db)).toMatchObject({
			revision: state.revision + 3,
			invalid_count: 0,
			status: "ready",
		});
		expect(sourceSnapshot(fixture.db)).toEqual(source);
	});

	it("refuses deletion when validated row metadata is missing, leaving the physical row intact", () => {
		// Arrange: simulate an inconsistent derived index, not source or virtual-table corruption.
		const rowid = fixture.rawVector(fixture.memory(), vector(1));
		upgrade();
		fixture.db.prepare("DELETE FROM validated_vector_rows WHERE rowid=?").run(rowid);
		const before = rows(fixture.db);
		const index = indexSnapshot(fixture.db);

		// Act / Assert
		expect(() =>
			fixture.db.prepare("DELETE FROM memory_vectors WHERE rowid=?").run(BigInt(rowid)),
		).toThrow("vector_index_metadata_missing");
		expectSameVectors(rows(fixture.db), before);
		expect(indexSnapshot(fixture.db)).toEqual(index);
	});
});

describe("atomic upgrade failures", () => {
	it("rejects an unsafe legacy rowid and restores its bytes and complete legacy schema", () => {
		// Arrange
		explicitLegacyRowid(9007199254740993n, fixture.memory(), MODEL);
		const before = rows(fixture.db);
		const schema = schemaSnapshot(fixture.db);
		const source = sourceSnapshot(fixture.db);

		// Act / Assert
		expect(upgrade).toThrow(/previous layout was preserved/i);
		expectSameVectors(rows(fixture.db), before);
		expect(schemaSnapshot(fixture.db)).toEqual(schema);
		expect(sourceSnapshot(fixture.db)).toEqual(source);
	});

	it.each(["copy", "drop", "view"] as const)(
		"restores the full legacy layout after an injected %s fault",
		(stage) => {
			// Arrange
			fixture.rawVector(fixture.memory(), vector(1));
			const before = rows(fixture.db);
			const schema = schemaSnapshot(fixture.db);
			const source = sourceSnapshot(fixture.db);
			const prepare = fixture.db.prepare.bind(fixture.db);
			const exec = fixture.db.exec.bind(fixture.db);
			let injected = false;
			const fail = () => {
				expect(fixture.db.inTransaction).toBe(true);
				injected = true;
				throw new Error(`injected ${stage} fault`);
			};
			const prepareSpy = vi.spyOn(fixture.db, "prepare").mockImplementation((sql) => {
				if (stage === "copy" && /INSERT INTO memory_vectors_v1\(/i.test(sql)) fail();
				return prepare(sql);
			});
			const execSpy = vi.spyOn(fixture.db, "exec").mockImplementation((sql) => {
				if (stage === "drop" && /DROP TABLE memory_vectors\b/i.test(sql)) fail();
				if (stage === "view" && /CREATE VIEW memory_vectors\b/i.test(sql)) fail();
				return exec(sql);
			});

			// Act / Assert
			expect(upgrade).toThrow(/previous layout was preserved/i);
			prepareSpy.mockRestore();
			execSpy.mockRestore();
			expect(injected).toBe(true);
			expect(fixture.db.inTransaction).toBe(false);
			expectSameVectors(rows(fixture.db), before);
			expect(schemaSnapshot(fixture.db)).toEqual(schema);
			expect(sourceSnapshot(fixture.db)).toEqual(source);
			// The same fixture remains usable after rollback; no orphan v1 shadow tables block retry.
			expect(upgrade()?.status).toBe("ready");
		},
	);

	it("fails fast under another writer lock and restores the connection timeout and legacy layout", () => {
		// Arrange
		fixture.rawVector(fixture.memory(), vector(1));
		const before = rows(fixture.db);
		const schema = schemaSnapshot(fixture.db);
		const source = sourceSnapshot(fixture.db);
		fixture.db.pragma("busy_timeout = 1234");
		const locker = secondConnection();
		locker.exec("BEGIN IMMEDIATE");
		const pragma = vi.spyOn(fixture.db, "pragma");

		// Act
		let failure: unknown;
		try {
			upgrade();
		} catch (error) {
			failure = error;
		} finally {
			locker.exec("ROLLBACK");
		}

		// Assert: verify a zero wait setting, not a machine-speed timing threshold.
		expect(failure).toMatchObject({
			code: "vector_upgrade_busy",
			message: expect.stringMatching(/close other vector writers/i),
		});
		expect(pragma).toHaveBeenCalledWith("busy_timeout = 0");
		expect(fixture.db.pragma("busy_timeout", { simple: true })).toBe(1234);
		expectSameVectors(rows(fixture.db), before);
		expect(schemaSnapshot(fixture.db)).toEqual(schema);
		expect(sourceSnapshot(fixture.db)).toEqual(source);
		expect(upgrade()?.status).toBe("ready");
	});

	it("rejects a nested caller transaction without committing any source or vector changes", () => {
		// Arrange
		fixture.rawVector(fixture.memory(), vector(1));
		const before = rows(fixture.db);
		const schema = schemaSnapshot(fixture.db);
		const source = sourceSnapshot(fixture.db);

		// Act / Assert
		expect(() => fixture.db.transaction(upgrade)()).toThrow(
			"vector_upgrade_requires_standalone_transaction",
		);
		expectSameVectors(rows(fixture.db), before);
		expect(schemaSnapshot(fixture.db)).toEqual(schema);
		expect(sourceSnapshot(fixture.db)).toEqual(source);
	});
});
