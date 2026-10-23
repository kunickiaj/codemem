import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadSqliteVec } from "../db.js";
import { MODEL, type RankingFixture, vector } from "./semantic-ranking.test-helper.js";
import {
	auditBatch,
	initializeValidatedIndex,
	rankValidatedIndex,
	readCatalog,
	startAudit,
} from "./validated-vector-index.js";
import { createDisposableIndexFixture, request } from "./validated-vector-index.test-helper.js";

let owned: ReturnType<typeof createDisposableIndexFixture>;
let fixture: RankingFixture;
beforeEach(() => {
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	owned = createDisposableIndexFixture();
	fixture = owned.fixture;
});
afterEach(() => owned.dispose());

function census() {
	initializeValidatedIndex(fixture.db, { allWritersUpgraded: true, writerVersion: 1 });
	startAudit(fixture.db, { knownModels: [MODEL] });
	return auditBatch(fixture.db, { limit: 100 });
}

it("ranks authorized valid chunk minima natively in an audited needsrepair generation without mutating it", () => {
	// Arrange: closer invalid/unknown rows and a hidden valid row cannot provide evidence.
	const valid = fixture.memory();
	fixture.rawVector(valid, vector(-1));
	fixture.rawVector(valid, vector(-0.5), 1);
	fixture.rawVector(fixture.memory(), vector(3));
	fixture.rawVector(fixture.memory(), vector(2), 0, "unknown-model");
	fixture.rawVector(fixture.memory("hidden"), vector(2));
	expect(census()).toMatchObject({ invalid: 2, remaining: 0, catalog: { status: "needsrepair" } });
	const before = fixture.snapshot();
	const catalog = readCatalog(fixture.db);
	const schema = fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
	fixture.db.pragma("query_only = ON");
	// Act: ranking must work while SQLite prohibits repair, DDL, and bookkeeping writes.
	const ranked = rankValidatedIndex(fixture.db, {
		...request(fixture),
		query: { model: MODEL, vectors: [vector(2)] },
		limit: 1,
	});
	const plan = fixture.db
		.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM validated_vector_rows
		WHERE model=? AND audit_state='valid' AND memory_id IN (?)`)
		.all(MODEL, valid) as { detail: string }[];
	// Assert: admission depends on eligible rows, not global repair completion or unknown labels.
	expect(ranked).toMatchObject({ strategy: "native", fallbackCount: 0, models: [MODEL] });
	expect(ranked?.results.map(({ id, distance }) => ({ id, distance }))).toEqual([
		{ id: valid, distance: 2.5 },
	]);
	expect(plan.some(({ detail }) => /COVERING INDEX/i.test(detail))).toBe(true);
	expect(fixture.snapshot()).toEqual(before);
	expect(readCatalog(fixture.db)).toEqual(catalog);
	expect(catalog?.models).toContainEqual({ model: "unknown-model", count: 1 });
	expect(fixture.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
		schema,
	);
});

it("filters invalid rows before scalar distances and grouping when tied duplicate chunks defeat native certification", () => {
	// Arrange: twelve ties from one memory fill the probe, requiring an exact scalar fallback.
	const first = fixture.memory();
	const second = fixture.memory();
	for (let chunk = 0; chunk < 12; chunk++) fixture.rawVector(first, vector(-1), chunk);
	fixture.rawVector(second, vector(-1));
	fixture.rawVector(first, vector(3), 12);
	fixture.rawVector(fixture.memory(), vector(Number.NaN));
	fixture.rawVector(fixture.memory(), vector(3));
	expect(census()).toMatchObject({ invalid: 3, remaining: 0, catalog: { status: "needsrepair" } });
	const before = fixture.snapshot();
	const catalog = readCatalog(fixture.db);
	const distanceDb = new Database(":memory:");
	loadSqliteVec(distanceDb);
	const realDistance = distanceDb.prepare("SELECT vec_distance_l2(?, ?) AS distance");
	const evaluated: number[] = [];
	// Observe actual scalar evaluation; delegate valid distances to unmodified sqlite-vec on another DB.
	fixture.db.function("vec_distance_l2", { deterministic: true }, (left: Buffer, right: Buffer) => {
		for (const bytes of [left, right]) {
			let normSquared = 0;
			for (let offset = 0; offset < bytes.length; offset += 4) {
				const component = bytes.readFloatLE(offset);
				if (!Number.isFinite(component)) throw new Error("distance_evaluated_nonfinite_row");
				normSquared += component * component;
			}
			if (normSquared > 4) throw new Error("distance_evaluated_invalid_norm_row");
		}
		evaluated.push(left.readFloatLE(0));
		return (realDistance.get(left, right) as { distance: number }).distance;
	});
	try {
		// Act
		const ranked = rankValidatedIndex(fixture.db, {
			...request(fixture),
			query: { model: MODEL, vectors: [vector(2)] },
			limit: 2,
		});
		// Assert: invalid chunks cannot lower the valid memory's minimum or enter the scalar function.
		expect(ranked).toMatchObject({ strategy: "scalar", fallbackCount: 1 });
		expect(ranked?.results.map(({ id, distance }) => ({ id, distance }))).toEqual([
			{ id: first, distance: 3 },
			{ id: second, distance: 3 },
		]);
		expect(evaluated).toHaveLength(13);
		expect(evaluated.every((value) => value === -1)).toBe(true);
		expect(fixture.snapshot()).toEqual(before);
		expect(readCatalog(fixture.db)).toEqual(catalog);
	} finally {
		distanceDb.close();
	}
});

it("keeps an all-invalid catalog unavailable while retaining null and unknown legacy labels", () => {
	// Arrange: an ordinary legacy table permits NULL model metadata; no native-KNN claim is made.
	fixture.db.exec(`DROP TABLE memory_vectors;
		CREATE TABLE memory_vectors(embedding BLOB,memory_id INTEGER,chunk_index INTEGER,content_hash TEXT,model TEXT)`);
	fixture.rawVector(fixture.memory(), vector(3));
	fixture.rawVector(fixture.memory(), vector(1), 0, "unknown-model");
	const nullRow = fixture.rawVector(fixture.memory(), vector(1));
	fixture.db.prepare("UPDATE memory_vectors SET model=NULL WHERE rowid=?").run(nullRow);
	expect(census()).toMatchObject({ invalid: 3, remaining: 0, catalog: { status: "needsrepair" } });
	const before = fixture.snapshot();
	const catalog = readCatalog(fixture.db);
	const prepare = vi.spyOn(fixture.db, "prepare");
	fixture.db.pragma("query_only = ON");
	// Act
	const ranked = rankValidatedIndex(fixture.db, request(fixture));
	const queries = prepare.mock.calls.map(([sql]) => sql);
	// Assert: no valid evidence means no distance evaluation, not an empty successful ranking.
	expect(ranked).toBeNull();
	expect(queries.some((sql) => /embedding\s+MATCH|vec_distance_l2/i.test(sql))).toBe(false);
	expect(catalog?.models).toEqual(
		expect.arrayContaining([
			{ model: null, count: 1 },
			{ model: "unknown-model", count: 1 },
			{ model: MODEL, count: 1 },
		]),
	);
	expect(fixture.snapshot()).toEqual(before);
	expect(readCatalog(fixture.db)).toEqual(catalog);
});

it("does not admit a building generation even after its first valid row passes audit", () => {
	// Arrange
	fixture.rawVector(fixture.memory(), vector(1));
	fixture.rawVector(fixture.memory(), vector(1));
	initializeValidatedIndex(fixture.db, { allWritersUpgraded: true, writerVersion: 1 });
	startAudit(fixture.db, { knownModels: [MODEL] });
	expect(auditBatch(fixture.db, { limit: 1 })).toMatchObject({
		checked: 1,
		remaining: 1,
		catalog: { status: "building" },
	});
	const catalog = readCatalog(fixture.db);
	// Act
	const ranked = rankValidatedIndex(fixture.db, request(fixture));
	// Assert: partial validation cannot authorize the generation.
	expect(ranked).toBeNull();
	expect(readCatalog(fixture.db)).toEqual(catalog);
});
