import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VectorRowInput } from "./semantic-ranking.js";
import { MODEL, type RankingFixture, vector } from "./semantic-ranking.test-helper.js";
import {
	auditBatch,
	deleteValidatedVectors,
	initializeValidatedIndex,
	readCandidateVersions,
	readCatalog,
	startAudit,
	writeValidatedBatch,
} from "./validated-vector-index.js";
import { createDisposableIndexFixture, row } from "./validated-vector-index.test-helper.js";

let owned: ReturnType<typeof createDisposableIndexFixture>;
let fixture: RankingFixture;
const writer = { writerVersion: 1 as const };
const otherModel = "other-fixture-model";
beforeEach(() => {
	owned = createDisposableIndexFixture();
	fixture = owned.fixture;
});
afterEach(() => owned.dispose());

function rows(count: number): VectorRowInput[] {
	return Array.from({ length: count / 2 }, () => fixture.memory()).flatMap((id) => [
		row(id, 1, 0),
		row(id, -1, 1),
	]);
}

function write(
	batch: VectorRowInput[],
	mode: "append" | "replace-memory-model" = "append",
	model = MODEL,
) {
	return writeValidatedBatch(fixture.db, {
		...writer,
		expectedModel: model,
		model,
		expectedCount: batch.length,
		mode,
		rows: batch,
	});
}

function initialize() {
	initializeValidatedIndex(fixture.db, { ...writer, allWritersUpgraded: true });
	startAudit(fixture.db, { knownModels: [MODEL, otherModel] });
	return auditBatch(fixture.db, { limit: 1000 });
}

function versions(batch: VectorRowInput[]) {
	return readCandidateVersions(fixture.db, {
		memoryIds: [...new Set(batch.map((item) => item.memoryId))],
		models: [MODEL, otherModel],
	});
}

function measure<T>(operation: () => T) {
	const prepare = vi.spyOn(fixture.db, "prepare");
	try {
		const result = operation();
		return { result, preparations: prepare.mock.calls.length };
	} finally {
		prepare.mockRestore();
	}
}

function storedRows(model = MODEL) {
	return fixture.db
		.prepare(`SELECT memory_id,chunk_index,content_hash,model,embedding
		FROM memory_vectors WHERE model=? ORDER BY memory_id,chunk_index`)
		.all(model);
}

function expectedRows(batch: VectorRowInput[], model = MODEL) {
	return batch.map((item) => ({
		memory_id: item.memoryId,
		chunk_index: item.chunkIndex,
		content_hash: item.contentHash,
		model,
		embedding: Buffer.from(item.vector.buffer),
	}));
}

it.each(["append", "replace-memory-model"] as const)(
	"prepares a fixed statement set for 10-row and 100-row %s batches with fresh bindings",
	(mode) => {
		// Arrange: counts exclude setup and assertions; each memory has two different chunks.
		const small = rows(10);
		const large = rows(100);
		const all = [...small, ...large];
		const incumbents = all
			.filter((item) => item.chunkIndex === 0)
			.map((item) => row(item.memoryId, 2, 9));
		initialize();
		write(incumbents);
		write(incumbents, "append", otherModel);
		const before = versions(all);
		const otherRows = storedRows(otherModel);
		// Act
		const first = measure(() => write(small, mode));
		const second = measure(() => write(large, mode));
		// Assert: native preparations stay constant across rows, IDs, and chunk bindings.
		expect(second.preparations).toBe(first.preparations);
		expect(second.preparations).toBeLessThan(80);
		const expected = mode === "append" ? [...all, ...incumbents] : all;
		expected.sort((a, b) => a.memoryId - b.memoryId || a.chunkIndex - b.chunkIndex);
		expect(storedRows()).toEqual(expectedRows(expected));
		expect(storedRows(otherModel)).toEqual(otherRows);
		expect(second.result.models).toEqual(
			expect.arrayContaining([
				{ model: MODEL, count: expected.length },
				{ model: otherModel, count: incumbents.length },
			]),
		);
		const after = versions(all);
		for (const previous of before) {
			const current = after.find(
				(item) => item.memoryId === previous.memoryId && item.model === previous.model,
			);
			if (previous.model === otherModel) {
				expect(current).toEqual(previous);
				continue;
			}
			expect(current?.count).toBe(mode === "append" ? 3 : 2);
			expect(current?.version).toBeGreaterThan(previous.version);
		}
		expect(second.result.revision).toBeGreaterThan(first.result.revision);
		expect(fixture.db.inTransaction).toBe(false);
	},
);

it.each(["vector", "source"] as const)(
	"rejects a late invalid %s without changing a replacement batch",
	(invalid) => {
		// Arrange: a missing final source fails inside the transaction, after earlier removals.
		const batch = rows(100);
		initialize();
		write(batch);
		write(batch, "append", otherModel);
		const before = fixture.snapshot();
		const catalog = readCatalog(fixture.db);
		const candidates = versions(batch);
		const replacement = batch.map((item) => ({ ...item, vector: vector(-1) }));
		const last = replacement[replacement.length - 1];
		if (invalid === "vector") last.vector = vector(Number.NaN);
		if (invalid === "source") last.memoryId = 999999;
		// Act
		const rejected = () => write(replacement, "replace-memory-model");
		// Assert: no partial removal, insertion, version bump, or catalog change survives.
		expect(rejected).toThrow();
		expect(fixture.snapshot()).toEqual(before);
		expect(readCatalog(fixture.db)).toEqual(catalog);
		expect(versions(batch)).toEqual(candidates);
		expect(fixture.db.inTransaction).toBe(false);
	},
);

it.each([false, true])(
	"prepares a fixed audit statement set while honoring 10/100 row limits (invalid rows: %s)",
	(invalid) => {
		// Arrange: leave pending rows after both calls so neither can silently audit the corpus.
		const batch = rows(120);
		for (const item of batch) {
			const model = item.chunkIndex === 0 ? MODEL : otherModel;
			const value = invalid && item.chunkIndex === 1 ? vector(3) : item.vector;
			fixture.rawVector(item.memoryId, value, item.chunkIndex, model);
		}
		initializeValidatedIndex(fixture.db, { ...writer, allWritersUpgraded: true });
		startAudit(fixture.db, { knownModels: [MODEL, otherModel] });
		const before = versions(batch);
		// Act
		const first = measure(() => auditBatch(fixture.db, { limit: 10 }));
		const second = measure(() => auditBatch(fixture.db, { limit: 100 }));
		// Assert: valid/invalid updates bind each row correctly without preparing per row.
		expect(second.preparations).toBe(first.preparations);
		expect(second.preparations).toBeLessThan(80);
		expect(first.result).toMatchObject({ checked: 10, remaining: 110, invalid: invalid ? 5 : 0 });
		expect(second.result).toMatchObject({
			checked: 100,
			remaining: 10,
			invalid: invalid ? 55 : 0,
			catalog: { status: "building" },
		});
		expect(second.result.diagnostics).toHaveLength(invalid ? 50 : 0);
		expect(
			fixture.db
				.prepare(
					"SELECT memory_id,chunk_index,audit_state FROM validated_vector_rows ORDER BY rowid",
				)
				.all(),
		).toEqual(
			batch.map((item, index) => {
				let state = "valid";
				if (invalid && item.chunkIndex === 1) state = "invalid";
				if (index >= 110) state = "pending";
				return { memory_id: item.memoryId, chunk_index: item.chunkIndex, audit_state: state };
			}),
		);
		expect(versions(batch)).toEqual(before);
		expect(second.result.catalog.models).toEqual(
			expect.arrayContaining([
				{ model: MODEL, count: 60 },
				{ model: otherModel, count: 60 },
			]),
		);
	},
);

it("prepares a fixed delete statement set for 10 and 100 chunks without deleting another model", () => {
	// Arrange
	const smallId = fixture.memory();
	const largeId = fixture.memory();
	const small = Array.from({ length: 10 }, (_, index) => row(smallId, 1, index));
	const large = Array.from({ length: 100 }, (_, index) => row(largeId, -1, index));
	initialize();
	write([...small, ...large]);
	write([row(smallId), row(largeId)], "append", otherModel);
	const before = versions([...small, ...large]);
	const otherRows = storedRows(otherModel);
	// Act
	const first = measure(() =>
		deleteValidatedVectors(fixture.db, { ...writer, memoryId: smallId, model: MODEL }),
	);
	const second = measure(() =>
		deleteValidatedVectors(fixture.db, { ...writer, memoryId: largeId, model: MODEL }),
	);
	// Assert: row removal and count updates reuse bindings, including the final tombstones.
	expect(second.preparations).toBe(first.preparations);
	expect(second.preparations).toBeLessThan(80);
	expect(storedRows()).toEqual([]);
	expect(storedRows(otherModel)).toEqual(otherRows);
	expect(second.result.models).toEqual([{ model: otherModel, count: 2 }]);
	const after = versions([...small, ...large]);
	for (const previous of before) {
		const current = after.find(
			(item) => item.memoryId === previous.memoryId && item.model === previous.model,
		);
		if (previous.model === otherModel) {
			expect(current).toEqual(previous);
			continue;
		}
		expect(current?.count).toBe(0);
		expect(current?.version).toBeGreaterThan(previous.version);
	}
});

it("rejects invalid audit and delete inputs without changing vectors or metadata", () => {
	// Arrange
	const batch = rows(10);
	initialize();
	write(batch);
	const before = fixture.snapshot();
	const catalog = readCatalog(fixture.db);
	const candidates = versions(batch);
	// Act
	const invalidAudit = () => auditBatch(fixture.db, { limit: 0 });
	const invalidDelete = () =>
		deleteValidatedVectors(fixture.db, { ...writer, memoryId: -1, model: MODEL });
	// Assert
	expect(invalidAudit).toThrow();
	expect(invalidDelete).toThrow();
	expect(fixture.snapshot()).toEqual(before);
	expect(readCatalog(fixture.db)).toEqual(catalog);
	expect(versions(batch)).toEqual(candidates);
	expect(fixture.db.inTransaction).toBe(false);
});
