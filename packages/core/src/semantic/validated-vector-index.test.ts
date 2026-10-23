import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMaintenanceJob } from "../maintenance-jobs.js";
import type { VectorRowInput } from "./semantic-ranking.js";
import { MODEL, type RankingFixture, vector } from "./semantic-ranking.test-helper.js";
import {
	auditBatch,
	deleteValidatedVectors,
	initializeValidatedIndex,
	invalidateValidatedIndex,
	rankValidatedIndex,
	readCandidateVersions,
	readCatalog,
	readSearchableModelLabels,
	startAudit,
	writeValidatedBatch,
} from "./validated-vector-index.js";
import {
	createDisposableIndexFixture,
	request,
	row,
} from "./validated-vector-index.test-helper.js";

let owned: ReturnType<typeof createDisposableIndexFixture>;
let fixture: RankingFixture;
const writer = { writerVersion: 1 as const };
beforeEach(() => {
	owned = createDisposableIndexFixture();
	fixture = owned.fixture;
});
afterEach(() => {
	owned.dispose();
});
function initialize() {
	return initializeValidatedIndex(fixture.db, { ...writer, allWritersUpgraded: true });
}
function write(rows: VectorRowInput[], mode: "append" | "replace-memory-model" = "append") {
	return writeValidatedBatch(fixture.db, {
		...writer,
		expectedModel: MODEL,
		model: MODEL,
		expectedCount: rows.length,
		mode,
		rows,
	});
}
function audit() {
	startAudit(fixture.db, { knownModels: [MODEL] });
	return auditBatch(fixture.db, { limit: 100 });
}
function versions(memoryId: number) {
	return readCandidateVersions(fixture.db, { memoryIds: [memoryId], models: [MODEL] });
}

it.each(["append", "replace-memory-model"] as const)(
	"generation-model: rejects an undeclared %s model atomically",
	(mode) => {
		// Arrange: model A is audited and ready; model B has never been declared.
		const id = fixture.memory();
		const nextModel = "undeclared-fixture-model";
		initialize();
		write([row(id)]);
		audit();
		const before = fixture.snapshot();
		const catalog = readCatalog(fixture.db);
		const options = { memoryIds: [id], models: [MODEL, nextModel] };
		const candidates = readCandidateVersions(fixture.db, options);
		// Act: producer/expected-model agreement alone does not authorize a new generation model.
		const rejected = () =>
			writeValidatedBatch(fixture.db, {
				...writer,
				expectedModel: nextModel,
				model: nextModel,
				expectedCount: 1,
				mode,
				rows: [row(id, -1)],
			});
		// Assert
		expect(catalog?.status).toBe("ready");
		expect(rejected).toThrow(/model/i);
		expect(fixture.snapshot()).toEqual(before);
		expect(readCatalog(fixture.db)).toEqual(catalog);
		expect(readCandidateVersions(fixture.db, options)).toEqual(candidates);
		expect(fixture.db.inTransaction).toBe(false);
	},
);

it("generation-model: accepts a model declared before auditing the ready generation", () => {
	// Arrange
	const id = fixture.memory();
	const nextModel = "declared-fixture-model";
	initialize();
	write([row(id)]);
	startAudit(fixture.db, { knownModels: [MODEL, nextModel] });
	auditBatch(fixture.db, { limit: 100 });
	const catalog = readCatalog(fixture.db);
	// Act
	const updated = writeValidatedBatch(fixture.db, {
		...writer,
		expectedModel: nextModel,
		model: nextModel,
		expectedCount: 1,
		mode: "append",
		rows: [row(id, -1)],
	});
	// Assert: a subsequent audit must agree with the writer's validity decision.
	expect(updated).toMatchObject({ status: "ready", generationId: catalog?.generationId });
	expect(updated.models).toEqual(
		expect.arrayContaining([
			{ model: MODEL, count: 1 },
			{ model: nextModel, count: 1 },
		]),
	);
	startAudit(fixture.db, { knownModels: [MODEL, nextModel] });
	expect(auditBatch(fixture.db, { limit: 100 })).toMatchObject({
		invalid: 0,
		catalog: { status: "ready" },
	});
});

it("generation-model: an explicit new generation permits writes for its newly declared model", () => {
	// Arrange
	const id = fixture.memory();
	const nextModel = "new-generation-model";
	initialize();
	write([row(id)]);
	audit();
	const previous = readCatalog(fixture.db);
	// Act: declaring B deliberately starts a new generation before its first supported write.
	const next = startAudit(fixture.db, { knownModels: [MODEL, nextModel] });
	const updated = writeValidatedBatch(fixture.db, {
		...writer,
		expectedModel: nextModel,
		model: nextModel,
		expectedCount: 1,
		mode: "append",
		rows: [row(id, -1)],
	});
	const completed = auditBatch(fixture.db, { limit: 100 });
	// Assert
	expect(next.generationId).not.toBe(previous?.generationId);
	expect(updated.generationId).toBe(next.generationId);
	expect(completed).toMatchObject({
		invalid: 0,
		catalog: { status: "ready", generationId: next.generationId },
	});
	expect(completed.catalog.models).toContainEqual({ model: nextModel, count: 1 });
	expect(fixture.snapshot().vectors).toHaveLength(2);
});

it("generation-model: permits fixture append seeding before the first audit manifest exists", () => {
	// Arrange
	const id = fixture.memory();
	const nextModel = "seed-fixture-model";
	initialize();
	// Act
	const seeded = writeValidatedBatch(fixture.db, {
		...writer,
		expectedModel: nextModel,
		model: nextModel,
		expectedCount: 1,
		mode: "append",
		rows: [row(id)],
	});
	startAudit(fixture.db, { knownModels: [MODEL, nextModel] });
	const completed = auditBatch(fixture.db, { limit: 100 });
	// Assert
	expect(seeded.status).toBe("building");
	expect(completed).toMatchObject({ invalid: 0, catalog: { status: "ready" } });
	expect(completed.catalog.models).toEqual([{ model: nextModel, count: 1 }]);
});

it("reads an absent catalog without DDL, then initializes only with the upgraded-writer prerequisite", () => {
	// Arrange
	const before = fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
	fixture.db.pragma("query_only = ON");
	// Act
	const absent = readCatalog(fixture.db);
	fixture.db.pragma("query_only = OFF");
	// Assert
	expect(absent).toBeNull();
	expect(fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
		before,
	);
	expect(initialize()).toMatchObject({ writerVersion: 1, status: "building" });
});
it.each([
	{ allWritersUpgraded: false, writerVersion: 1 },
	{ allWritersUpgraded: true, writerVersion: 0 },
])("rejects unsupported initialization before any DDL: %j", (options) => {
	// Arrange
	const before = fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
	// Act
	const initializeUnsupported = () =>
		initializeValidatedIndex(fixture.db, options as Parameters<typeof initializeValidatedIndex>[1]);
	// Assert
	expect(initializeUnsupported).toThrow();
	expect(fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
		before,
	);
});
it("publishes ready only after bounded audit covers every row", () => {
	// Arrange
	const ids = [fixture.memory(), fixture.memory()];
	for (const id of ids) fixture.rawVector(id, vector(1));
	initialize();
	startAudit(fixture.db, { knownModels: [MODEL] });
	// Act
	const first = auditBatch(fixture.db, { limit: 1 });
	const unavailable = rankValidatedIndex(fixture.db, request(fixture));
	const second = auditBatch(fixture.db, { limit: 1 });
	// Assert
	expect(first).toMatchObject({ checked: 1, remaining: 1, catalog: { status: "building" } });
	expect(unavailable).toBeNull();
	expect(second).toMatchObject({
		checked: 1,
		remaining: 0,
		invalid: 0,
		catalog: { status: "ready" },
	});
	expect(rankValidatedIndex(fixture.db, request(fixture))?.results.map((item) => item.id)).toEqual(
		ids,
	);
});
it("keeps the full unknown and null model catalog while blocking invalid legacy rows", () => {
	// Arrange: this disposable legacy table tests metadata only, not native KNN support.
	fixture.db.exec(`DROP TABLE memory_vectors;
		CREATE TABLE memory_vectors (
			embedding BLOB, memory_id INTEGER, chunk_index INTEGER, content_hash TEXT, model TEXT
		)`);
	initialize();
	invalidateValidatedIndex(fixture.db);
	fixture.rawVector(fixture.memory(), vector(1));
	fixture.rawVector(fixture.memory(), vector(1), 0, "unknown-model");
	const nullRow = fixture.rawVector(fixture.memory(), vector(1));
	fixture.db.prepare("UPDATE memory_vectors SET model = NULL WHERE rowid = ?").run(nullRow);
	const memories = fixture.snapshot().memories;
	// Act
	const progress = audit();
	// Assert
	expect(progress).toMatchObject({ remaining: 0, invalid: 2, catalog: { status: "needsrepair" } });
	expect(progress.catalog.models).toEqual(
		expect.arrayContaining([
			{ model: MODEL, count: 1 },
			{ model: "unknown-model", count: 1 },
			{ model: null, count: 1 },
		]),
	);
	expect(readSearchableModelLabels(fixture.db, progress.catalog)).toEqual([MODEL]);
	expect(fixture.snapshot().memories).toEqual(memories);
});
it.each(["replace", "delete"] as const)(
	"rejects %s before the initial census without changing legacy vectors or metadata",
	(operation) => {
		// Arrange: supported legacy seeding precedes initialization, not a ready generation.
		const id = fixture.memory();
		fixture.rawVector(id, vector(1));
		initialize();
		const before = fixture.snapshot();
		const catalog = readCatalog(fixture.db);
		const candidates = versions(id);
		// Act
		const mutate = () => {
			if (operation === "replace") return write([row(id, -1)], "replace-memory-model");
			return deleteValidatedVectors(fixture.db, { ...writer, memoryId: id, model: MODEL });
		};
		// Assert: empty metadata cannot authorize a partial replacement or a silent no-op delete.
		expect(mutate).toThrow(/audit|census/i);
		expect(fixture.snapshot()).toEqual(before);
		expect(readCatalog(fixture.db)).toEqual(catalog);
		expect(versions(id)).toEqual(candidates);
		expect(fixture.db.inTransaction).toBe(false);
	},
);
it("maintains model counts and per-memory revisions through append, replacement, deletion and reinsertion", () => {
	// Arrange
	const id = fixture.memory();
	initialize();
	audit();
	// Act
	const appended = write([row(id), row(id, 2, 1)]);
	const first = versions(id)[0];
	const replaced = write([row(id, -1)], "replace-memory-model");
	const second = versions(id)[0];
	const deleted = deleteValidatedVectors(fixture.db, { ...writer, memoryId: id, model: MODEL });
	const tombstone = versions(id)[0];
	const reinserted = write([row(id)]);
	const last = versions(id)[0];
	// Assert
	expect(appended.models).toContainEqual({ model: MODEL, count: 2 });
	expect(replaced.models).toContainEqual({ model: MODEL, count: 1 });
	expect(deleted.models.find((entry) => entry.model === MODEL)?.count ?? 0).toBe(0);
	expect([first.count, second.count, tombstone.count, last.count]).toEqual([2, 1, 0, 1]);
	expect(second.version).toBeGreaterThan(first.version);
	expect(tombstone.version).toBeGreaterThan(second.version);
	expect(last.version).toBeGreaterThan(tombstone.version);
	expect(reinserted.revision).toBeGreaterThan(deleted.revision);
	expect(readCatalog(fixture.db)).toEqual(reinserted);
});
it.each([
	["shape", new Float32Array(383), MODEL, 2],
	["nonfinite", vector(Number.NaN), MODEL, 2],
	["infinite", vector(Number.POSITIVE_INFINITY), MODEL, 2],
	["norm", vector(2.01), MODEL, 2],
	["model", vector(1), "different-model", 2],
	["count", vector(1), MODEL, 3],
] as const)("rejects a whole batch atomically for %s", (_reason, invalid, model, expectedCount) => {
	// Arrange: the valid first row must not be inserted before validation fails on the second.
	const id = fixture.memory();
	initialize();
	audit();
	const before = fixture.snapshot();
	const catalog = readCatalog(fixture.db);
	const priorVersions = versions(id);
	// Act
	const invalidWrite = () =>
		writeValidatedBatch(fixture.db, {
			...writer,
			expectedModel: MODEL,
			model,
			expectedCount,
			mode: "append",
			rows: [row(id), { ...row(id, 1, 1), vector: invalid }],
		});
	// Assert
	expect(invalidWrite).toThrow();
	expect(fixture.snapshot()).toEqual(before);
	expect(readCatalog(fixture.db)).toEqual(catalog);
	expect(versions(id)).toEqual(priorVersions);
	expect(fixture.db.inTransaction).toBe(false);
});
it("ignores usage writes but explicitly invalidated maintenance disables ranking until re-audit", () => {
	// Arrange
	const id = fixture.memory();
	initialize();
	write([row(id)]);
	audit();
	const before = readCatalog(fixture.db);
	// Act
	fixture.db
		.prepare("INSERT INTO usage_events(event, created_at) VALUES (?, ?)")
		.run("search", "2026-01-01");
	const afterUsage = readCatalog(fixture.db);
	const ranked = rankValidatedIndex(fixture.db, request(fixture));
	invalidateValidatedIndex(fixture.db);
	fixture.db
		.prepare("UPDATE memory_vectors SET embedding = ? WHERE memory_id = ?")
		.run(Buffer.from(vector(2).buffer), id);
	const invalidated = rankValidatedIndex(fixture.db, request(fixture));
	const repaired = audit();
	// Assert
	expect(afterUsage).toEqual(before);
	expect(ranked?.results.map((item) => item.id)).toEqual([id]);
	expect(invalidated).toBeNull();
	expect(repaired.catalog.status).toBe("ready");
});
it("reads persisted metadata on another connection and observes supported writes", () => {
	// Arrange
	const id = fixture.memory();
	initialize();
	write([row(id)]);
	audit();
	const other = new Database(fixture.path);
	try {
		// Act
		const before = readCatalog(other);
		const updated = write([row(id, 1, 1)]);
		const after = readCatalog(other);
		const current = readCandidateVersions(other, { memoryIds: [id], models: [MODEL] });
		// Assert
		expect(after).toEqual(updated);
		expect(after?.revision).toBeGreaterThan(before?.revision ?? -1);
		expect(current).toEqual(versions(id));
	} finally {
		other.close();
	}
});
it("uses native indexed ranking without rescanning the vector corpus or model catalog", () => {
	// Arrange
	const id = fixture.memory();
	initialize();
	write([row(id)]);
	audit();
	const prepare = vi.spyOn(fixture.db, "prepare");
	// Act
	const result = rankValidatedIndex(fixture.db, { ...request(fixture), limit: 1 });
	const sql = prepare.mock.calls.map(([query]) => query);
	// Assert: SQL instrumentation observes real SQLite queries; ranking is not mocked.
	expect(result).toMatchObject({
		strategy: "native",
		models: [MODEL],
		candidateVersions: versions(id),
	});
	expect(result?.results.map((item) => item.id)).toEqual([id]);
	expect(
		sql.some(
			(query) =>
				/memory_vectors/i.test(query) &&
				/group\s+by|select\s+distinct|count\s*\(|select\s+rowid\s*,\s*embedding/i.test(query),
		),
	).toBe(false);
	expect(sql.filter((query) => /\bFROM\s+memory_vectors\b/i.test(query))).not.toHaveLength(0);
	expect(
		sql
			.filter((query) => /\bFROM\s+memory_vectors\b/i.test(query))
			.every((query) => /embedding\s+MATCH/i.test(query)),
	).toBe(true);
	expect(result?.generationId).toBe(readCatalog(fixture.db)?.generationId);
});
it("reuses a caller-owned read snapshot and closes only transactions it owns", () => {
	// Arrange
	const id = fixture.memory();
	initialize();
	write([row(id)]);
	audit();
	fixture.db.exec("BEGIN");
	try {
		const catalog = readCatalog(fixture.db);
		const candidates = versions(id);
		// Act
		const result = rankValidatedIndex(fixture.db, request(fixture));
		// Assert: the caller retains its snapshot for subsequent authorization and version reads.
		expect(fixture.db.inTransaction).toBe(true);
		expect(result).toMatchObject({
			generationId: catalog?.generationId,
			revision: catalog?.revision,
			candidateVersions: candidates,
		});
		expect(result?.results.map((item) => item.id)).toEqual([id]);
	} finally {
		fixture.db.exec("ROLLBACK");
	}
	expect(rankValidatedIndex(fixture.db, request(fixture))?.results).toHaveLength(1);
	expect(fixture.db.inTransaction).toBe(false);
});
it("does not revise vectors or rebuild their generation for ordinary ledger writes", () => {
	// Arrange
	const id = fixture.memory();
	initialize();
	write([row(id)]);
	audit();
	const catalog = readCatalog(fixture.db);
	const candidates = versions(id);
	const before = fixture.snapshot();
	// Act
	fixture.db
		.prepare(`INSERT INTO replication_ops
		(op_id, entity_type, entity_id, op_type, payload_json, clock_rev,
		clock_updated_at, clock_device_id, device_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(
			"fixture-op",
			"memory",
			String(id),
			"upsert",
			"{}",
			1,
			"2026-01-01",
			"fixture-device",
			"fixture-device",
			"2026-01-01",
		);
	const result = rankValidatedIndex(fixture.db, request(fixture));
	// Assert: non-vector bookkeeping neither invalidates nor mutates candidate versions.
	expect(result?.results.map((item) => item.id)).toEqual([id]);
	expect(readCatalog(fixture.db)).toEqual(catalog);
	expect(versions(id)).toEqual(candidates);
	expect(fixture.snapshot()).toEqual(before);
});

it.each([false, true])(
	"rejects old/future writer APIs without DDL or writes (initialized: %s)",
	(initialized) => {
		// Arrange
		const id = fixture.memory();
		if (initialized) {
			initialize();
			write([row(id)]);
			audit();
		}
		const catalog = readCatalog(fixture.db);
		const before = fixture.snapshot();
		const schema = fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
		// Act
		const operations = [0, 2].flatMap((writerVersion) => [
			() =>
				writeValidatedBatch(fixture.db, {
					writerVersion: writerVersion as 1,
					expectedModel: MODEL,
					model: MODEL,
					expectedCount: 1,
					mode: "replace-memory-model",
					rows: [row(id, -1)],
				}),
			() =>
				deleteValidatedVectors(fixture.db, {
					writerVersion: writerVersion as 1,
					memoryId: id,
					model: MODEL,
				}),
		]);
		// Assert
		for (const operation of operations)
			expect(operation).toThrow("validated_writer_version_required");
		expect(fixture.snapshot()).toEqual(before);
		expect(readCatalog(fixture.db)).toEqual(catalog);
		expect(fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
			schema,
		);
	},
);

it.each([{ memoryId: -1 }, { memoryId: 9999 }, { chunkIndex: -1 }, { contentHash: "" }])(
	"rejects invalid replacement metadata without deleting the previous vectors: %j",
	(invalid) => {
		// Arrange
		const id = fixture.memory();
		initialize();
		write([row(id)]);
		audit();
		const before = fixture.snapshot();
		const catalog = readCatalog(fixture.db);
		const candidates = versions(id);
		// Act: even a valid first memory must survive failure on the second replacement.
		const replace = () =>
			write([row(id, -1), { ...row(id, 1, 1), ...invalid }], "replace-memory-model");
		// Assert
		expect(replace).toThrow();
		expect(fixture.snapshot()).toEqual(before);
		expect(readCatalog(fixture.db)).toEqual(catalog);
		expect(versions(id)).toEqual(candidates);
	},
);

it.each([
	["shape", "invalid_vector_shape"],
	["count", "vector_count_mismatch"],
	["model", "vector_model_mismatch"],
	["metadata", "invalid_vector_metadata"],
] as const)("validates %s before accessing an uninitialized database", (invalid, error) => {
	// Arrange
	const id = fixture.memory();
	const before = fixture.snapshot();
	const schema = fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
	const prepare = vi.spyOn(fixture.db, "prepare");
	const exec = vi.spyOn(fixture.db, "exec");
	const candidate = row(id);
	if (invalid === "shape") candidate.vector = new Float32Array(383);
	if (invalid === "metadata") candidate.contentHash = "";
	// Act
	const invalidWrite = () =>
		writeValidatedBatch(fixture.db, {
			...writer,
			expectedModel: MODEL,
			model: invalid === "model" ? "other-model" : MODEL,
			expectedCount: invalid === "count" ? 2 : 1,
			mode: "append",
			rows: [candidate],
		});
	// Assert: failure must come from validation, not missing metadata tables.
	expect(invalidWrite).toThrow(error);
	expect(prepare).not.toHaveBeenCalled();
	expect(exec).not.toHaveBeenCalled();
	expect(fixture.snapshot()).toEqual(before);
	expect(fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
		schema,
	);
});

it.each([false, true])(
	"reads under query_only without creating absent metadata/job tables (initialized: %s)",
	(initialized) => {
		// Arrange: table removal is restricted to this disposable fixture.
		const id = fixture.memory();
		if (initialized) {
			initialize();
			write([row(id)]);
			audit();
		}
		fixture.db.exec("DROP TABLE IF EXISTS maintenance_jobs");
		const schema = fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
		fixture.db.pragma("query_only = ON");
		// Act
		const catalog = readCatalog(fixture.db);
		const candidates = versions(id);
		const result = rankValidatedIndex(fixture.db, request(fixture));
		// Assert
		if (initialized) {
			expect(catalog).toMatchObject({ status: "ready", migration: null });
			expect(candidates).toMatchObject([{ memoryId: id, model: MODEL, count: 1 }]);
			expect(result?.results.map((item) => item.id)).toEqual([id]);
		} else {
			expect(catalog).toBeNull();
			expect(candidates).toEqual([]);
			expect(result).toBeNull();
		}
		expect(fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
			schema,
		);
	},
);

it("reads current migration progress without rescanning vectors or changing their generation", () => {
	// Arrange
	const id = fixture.memory();
	getMaintenanceJob(fixture.db, "vector_model_migration");
	fixture.db
		.prepare(`INSERT INTO maintenance_jobs(kind,title,status,metadata_json,updated_at)
		VALUES ('vector_model_migration','Fixture migration','running',?,'2026-01-01')`)
		.run(JSON.stringify({ source_model: MODEL, target_model: MODEL, fixture_progress: 1 }));
	initialize();
	write([row(id)]);
	audit();
	const catalog = readCatalog(fixture.db);
	const candidates = versions(id);
	fixture.db
		.prepare("UPDATE maintenance_jobs SET metadata_json=? WHERE kind='vector_model_migration'")
		.run(JSON.stringify({ source_model: MODEL, target_model: MODEL, fixture_progress: 2 }));
	const prepare = vi.spyOn(fixture.db, "prepare");
	// Act
	const after = readCatalog(fixture.db);
	const result = rankValidatedIndex(fixture.db, { ...request(fixture), limit: 1 });
	const vectorQueries = prepare.mock.calls
		.map(([sql]) => sql)
		.filter((sql) => /\bFROM\s+memory_vectors\b/i.test(sql));
	// Assert
	expect(after).toMatchObject({
		generationId: catalog?.generationId,
		revision: catalog?.revision,
		migration: { status: "running", metadata: { fixture_progress: 2 } },
	});
	expect(result).toMatchObject({ strategy: "native", candidateVersions: candidates });
	expect(result?.results.map((item) => item.id)).toEqual([id]);
	expect(vectorQueries).not.toHaveLength(0);
	expect(vectorQueries.every((sql) => /embedding\s+MATCH/i.test(sql))).toBe(true);
});
