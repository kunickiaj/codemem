import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFixture,
	MODEL,
	type RankingFixture,
	vector,
} from "./semantic/semantic-ranking.test-helper.js";
import { auditBatch } from "./semantic/validated-vector-index-audit.js";
import { upgradeVectorIndex } from "./vector-index-upgrade.js";
import {
	readVectorMetadataRows,
	type VectorMetadataFilter,
	type VectorMetadataRow,
} from "./vector-metadata-rows.js";
import { createVectorMetadataSnapshot } from "./vector-metadata-snapshot.js";
import { ensureVectorWriteModel, prepareVectorWrites } from "./vector-writes.js";

const NEW_MODEL = "fixture-model-next";
const UNKNOWN_MODEL = "unlisted-model";
const MISSING_MEMORY = 999;

let directory: string;
let fixture: RankingFixture;
let db: Database.Database;
let ids: { a: number; b: number; c: number; d: number };

type Row = { rowid: number; memory_id: number | null; model: string | null; content_hash: string };

function normalize(rows: Iterable<VectorMetadataRow | Record<string, unknown>>): Row[] {
	return [...rows]
		.map((row) => ({
			rowid: Number(row.rowid),
			memory_id: row.memory_id === null ? null : Number(row.memory_id),
			model: row.model as string | null,
			content_hash: row.content_hash as string,
		}))
		.sort((left, right) => left.rowid - right.rowid);
}

/** The reference answer: what the old code read from vec0 through the memory_vectors name. */
function vec0Rows({ memoryIds, model }: VectorMetadataFilter): Row[] {
	const all = normalize(
		db.prepare("SELECT rowid, memory_id, model, content_hash FROM memory_vectors").all() as Array<
			Record<string, unknown>
		>,
	);
	return all.filter(
		(row) =>
			(memoryIds === undefined || memoryIds.includes(row.memory_id ?? -1)) &&
			(model === undefined || row.model === model),
	);
}

function readWithSql(filter: VectorMetadataFilter): { rows: Row[]; sql: string[] } {
	const sql: string[] = [];
	const prepare = Database.prototype.prepare;
	const spy = vi.spyOn(db, "prepare").mockImplementation((text: string) => {
		sql.push(text);
		return prepare.call(db, text);
	});
	try {
		return { rows: normalize(readVectorMetadataRows(db, filter, "rows-test")), sql };
	} finally {
		spy.mockRestore();
	}
}

function usedIndexedTable(sql: string[]): boolean {
	return sql.some((text) => text.includes("rows-test indexed"));
}

function auditStates(): Record<string, number> {
	const rows = db
		.prepare("SELECT audit_state, COUNT(*) AS n FROM validated_vector_rows GROUP BY audit_state")
		.all() as Array<{ audit_state: string; n: number }>;
	return Object.fromEntries(rows.map((row) => [row.audit_state, row.n]));
}

function writeNewModelRows(memoryId: number): void {
	db.transaction(() => {
		ensureVectorWriteModel(db, NEW_MODEL);
		prepareVectorWrites(db)({
			insert: {
				model: NEW_MODEL,
				rows: [0, 1].map((chunkIndex) => ({
					memoryId,
					chunkIndex,
					contentHash: `next-${memoryId}-${chunkIndex}`,
					vector: vector(chunkIndex),
				})),
				expectedCount: 2,
			},
		});
	}).immediate();
}

/** Legacy rows cover valid, wrong-model, and missing-source cases before the upgrade. */
function seedLegacyVectors(): void {
	ids = { a: fixture.memory(), b: fixture.memory(), c: fixture.memory(), d: fixture.memory() };
	fixture.rawVector(ids.a, vector(1), 0);
	fixture.rawVector(ids.a, vector(2), 1);
	fixture.rawVector(ids.b, vector(3), 0);
	fixture.rawVector(ids.b, vector(4), 0, UNKNOWN_MODEL);
	fixture.rawVector(ids.c, vector(5), 0);
	fixture.rawVector(ids.d, vector(6), 0, UNKNOWN_MODEL);
	fixture.rawVector(MISSING_MEMORY, vector(7), 0);
}

// Filters are built per test because memory IDs are assigned in beforeEach.
const FILTERS: Array<[string, () => VectorMetadataFilter]> = [
	["all rows", () => ({})],
	["one model", () => ({ model: MODEL })],
	["memories across models", () => ({ memoryIds: [ids.a, ids.b, MISSING_MEMORY] })],
	["memories and model", () => ({ memoryIds: [ids.a, ids.b, MISSING_MEMORY], model: MODEL })],
	["repeated and absent memories", () => ({ memoryIds: [ids.d, ids.d, 123_456] })],
	["empty memory list", () => ({ memoryIds: [] })],
];

const STATES: Array<[string, () => void]> = [
	["after the upgrade audit (valid and invalid rows)", () => undefined],
	[
		"during a new census (pending rows, partly audited)",
		() => {
			db.transaction(() => ensureVectorWriteModel(db, NEW_MODEL)).immediate();
			auditBatch(db, { limit: 2 });
		},
	],
	[
		"after inserts and deletes through the vector writer",
		() => {
			writeNewModelRows(ids.c);
			db.transaction(() => prepareVectorWrites(db)({ deleteMemoryIds: [ids.b] })).immediate();
		},
	],
];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-vector-metadata-rows-"));
	// Bootstrap creates the legacy vec0 table only when vectors are enabled.
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	fixture = createFixture(directory);
	db = fixture.db;
	seedLegacyVectors();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (db.open) db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("indexed vector metadata on the v1 layout", () => {
	for (const [stateName, arrange] of STATES) {
		it.each(FILTERS)(`matches vec0 for %s ${stateName}`, (_name, buildFilter) => {
			// Arrange
			upgradeVectorIndex(db, { configuredModel: MODEL });
			arrange();
			const filter = buildFilter();

			// Act
			const { rows, sql } = readWithSql(filter);

			// Assert
			expect(rows).toEqual(vec0Rows(filter));
			if (filter.memoryIds?.length !== 0) expect(usedIndexedTable(sql)).toBe(true);
		});
	}

	it("covers every audit state across the scenarios", () => {
		// Arrange + Act
		upgradeVectorIndex(db, { configuredModel: MODEL });
		const afterUpgrade = auditStates();
		db.transaction(() => ensureVectorWriteModel(db, NEW_MODEL)).immediate();
		auditBatch(db, { limit: 2 });
		const duringCensus = auditStates();

		// Assert: the equivalence cases above see valid, invalid, and pending rows.
		expect(afterUpgrade.valid).toBeGreaterThan(0);
		expect(afterUpgrade.invalid).toBeGreaterThan(0);
		expect(afterUpgrade.pending).toBeUndefined();
		expect(duringCensus).toMatchObject({ pending: 5 });
		expect(duringCensus.valid).toBeGreaterThan(0);
	});

	it("builds the same snapshot as vec0", () => {
		// Arrange
		upgradeVectorIndex(db, { configuredModel: MODEL });
		writeNewModelRows(ids.a);
		const filter = { memoryIds: [ids.a, ids.b] };

		// Act
		const snapshot = createVectorMetadataSnapshot(db, filter);
		const rows = normalize(
			snapshot.prepare("SELECT * FROM vector_metadata").all() as Array<Record<string, unknown>>,
		);
		snapshot.close();

		// Assert
		expect(rows).toEqual(vec0Rows(filter));
	});

	it("deletes exactly the vec0 rows of the requested memories", () => {
		// Arrange
		upgradeVectorIndex(db, { configuredModel: MODEL });
		writeNewModelRows(ids.b);
		const kept = vec0Rows({}).filter((row) => row.memory_id !== ids.b);
		const sql: string[] = [];
		const prepare = Database.prototype.prepare;
		vi.spyOn(db, "prepare").mockImplementation((text: string) => {
			sql.push(text);
			return prepare.call(db, text);
		});

		// Act
		const result = db
			.transaction(() => prepareVectorWrites(db)({ deleteMemoryIds: [ids.b] }))
			.immediate();

		// Assert
		expect(result.deleted).toBe(4);
		expect(vec0Rows({})).toEqual(kept);
		expect(sql.some((text) => text.includes("vector-delete-memory-rows indexed"))).toBe(true);
	});

	it("falls back to vec0 when a write outside the vector writer breaks the mirror", () => {
		// Arrange: delete one physical row behind the compatibility view's back.
		upgradeVectorIndex(db, { configuredModel: MODEL });
		const [first] = vec0Rows({ memoryIds: [ids.a] });
		db.prepare("DELETE FROM memory_vectors_v1 WHERE rowid = ?").run(BigInt(first?.rowid ?? 0));
		const filter = { memoryIds: [ids.a] };

		// Act
		const { rows, sql } = readWithSql(filter);

		// Assert
		expect(rows).toEqual(vec0Rows(filter));
		expect(rows).toHaveLength(1);
		expect(usedIndexedTable(sql)).toBe(false);
	});
});

describe("vector metadata on the legacy layout", () => {
	it("keeps reading vec0", () => {
		// Arrange
		const filter = { memoryIds: [ids.a, ids.b] };

		// Act
		const { rows, sql } = readWithSql(filter);

		// Assert
		expect(rows).toEqual(vec0Rows(filter));
		expect(usedIndexedTable(sql)).toBe(false);
	});
});
