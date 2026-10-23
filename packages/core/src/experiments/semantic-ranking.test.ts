import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { auditCorpus, rankExact, writeFixtureBatch } from "./semantic-ranking.js";
import { createFixture, MODEL, vector } from "./semantic-ranking.test-helper.js";

let directory: string;
let fixture: ReturnType<typeof createFixture>;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "semantic-ranking-"));
	vi.stubEnv("HOME", directory);
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	fixture = createFixture(directory);
});
afterEach(() => {
	fixture.db.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});
function rank(limit = 2, token = auditCorpus(fixture.db, { knownModels: [MODEL] }).token) {
	return rankExact(fixture.db, {
		query: { model: MODEL, vectors: [vector()] },
		limit,
		filters: null,
		context: fixture.context,
		token,
	});
}
function row(memoryId: number, value: Float32Array) {
	return { memoryId, chunkIndex: 0, contentHash: `hash-${memoryId}`, vector: value };
}

it("writes an entire valid batch without renormalizing vectors", () => {
	// Arrange
	const rows = [row(fixture.memory(), vector(2)), row(fixture.memory(), vector(0.5))];
	// Act
	writeFixtureBatch(fixture.db, { expectedModel: MODEL, model: MODEL, expectedCount: 2, rows });
	// Assert
	expect(fixture.db.prepare("SELECT embedding FROM memory_vectors ORDER BY rowid").all()).toEqual(
		rows.map((item) => ({ embedding: Buffer.from(item.vector.buffer) })),
	);
});

it.each([
	["NaN", vector(Number.NaN), MODEL, 2],
	["Infinity", vector(Number.POSITIVE_INFINITY), MODEL, 2],
	["huge finite", vector(1e30), MODEL, 2],
	["shape", new Float32Array(383), MODEL, 2],
	["model mismatch", vector(), "other-model", 2],
	["count mismatch", vector(), MODEL, 3],
] as const)(
	"rejects %s before writing the valid first row",
	(_name, invalid, model, expectedCount) => {
		// Arrange
		const rows = [row(fixture.memory(), vector(1)), row(fixture.memory(), invalid)];
		const before = fixture.snapshot();
		// Act
		const write = () =>
			writeFixtureBatch(fixture.db, {
				expectedModel: MODEL,
				model,
				expectedCount,
				rows,
			});
		// Assert
		expect(write).toThrow();
		expect(fixture.snapshot()).toEqual(before);
	},
);

it("audits invalid legacy vectors without altering memories or vector bytes", () => {
	// Arrange: raw insertion deliberately bypasses the new writer.
	fixture.rawVector(fixture.memory(), vector(1));
	const nonfinite = fixture.rawVector(fixture.memory(), vector(Number.NaN));
	const norm = fixture.rawVector(fixture.memory(), vector(1e30));
	const model = fixture.rawVector(fixture.memory(), vector(), 0, "unknown");
	// A completed migration explicitly selects MODEL despite the mixed legacy catalog.
	fixture.db
		.prepare(`INSERT INTO maintenance_jobs(kind, title, status, metadata_json, updated_at)
			VALUES ('vector_model_migration', 'Fixture migration', 'completed', ?, '2026-01-01')`)
		.run(JSON.stringify({ target_model: MODEL }));
	const before = fixture.snapshot();
	// Act
	const audit = auditCorpus(fixture.db, { knownModels: [MODEL] });
	// Assert
	expect(audit).toMatchObject({
		scanned: 4,
		accepted: 1,
		rejected: [
			{ rowid: nonfinite, reason: "nonfinite" },
			{ rowid: norm, reason: "norm" },
			{ rowid: model, reason: "model" },
		],
	});
	expect(fixture.snapshot()).toEqual(before);
	expect(rank(2, audit.token).results.map((item) => item.distance)).toEqual([1]);
});

it("applies scope authorization before native KNN so hidden closest rows cannot consume k", () => {
	// Arrange
	for (let index = 0; index < 12; index++) fixture.rawVector(fixture.memory("hidden"), vector());
	const ids = [fixture.memory(), fixture.memory()];
	ids.forEach((id, index) => {
		fixture.rawVector(id, vector(0.25 + index * 0.25));
	});
	// Act
	const result = rank();
	// Assert
	expect(result.results.map((item) => item.id)).toEqual(ids);
	expect(result).toMatchObject({
		strategy: "native",
		fallbackCount: 0,
		probes: [{ model: MODEL, k: 8, returned: 2, exhausted: true }],
	});
});

it("falls back exactly once when duplicate chunks hide a distinct memory beyond k", () => {
	// Arrange
	const first = fixture.memory();
	for (let index = 0; index < 9; index++) fixture.rawVector(first, vector(0.125), index);
	const second = fixture.memory();
	fixture.rawVector(second, vector(0.5));
	// Act
	const result = rank();
	// Assert
	expect(result.results.map((item) => [item.id, item.distance])).toEqual([
		[first, 0.125],
		[second, 0.5],
	]);
	expect(result).toMatchObject({
		strategy: "scalar",
		fallbackCount: 1,
		probes: [{ k: 8, returned: 8, exhausted: false }],
	});
});

it("resolves uncertified cutoff ties by memory id instead of vector insertion order", () => {
	// Arrange
	const ids = Array.from({ length: 10 }, () => fixture.memory());
	for (const id of [...ids].reverse()) fixture.rawVector(id, vector(0.5));
	// Act
	const result = rank();
	// Assert
	expect(result.results.map((item) => item.id)).toEqual(ids.slice(0, 2));
	expect(result).toMatchObject({ strategy: "scalar", fallbackCount: 1 });
});

it.each(["memory update", "usage write", "other connection commit"])(
	"rejects a token after %s instead of silently auditing again",
	(mutation) => {
		// Arrange
		const id = fixture.memory();
		fixture.rawVector(id, vector(1));
		const { token } = auditCorpus(fixture.db, { knownModels: [MODEL] });
		const before = rank(1, token);
		if (mutation === "other connection commit") {
			const other = new Database(fixture.path);
			try {
				other.prepare("UPDATE sessions SET project = 'changed' WHERE id = 1").run();
			} finally {
				other.close();
			}
		} else if (mutation === "usage write") {
			fixture.db
				.prepare("INSERT INTO usage_events(event, created_at) VALUES ('fixture', '2026-01-01')")
				.run();
		} else {
			fixture.db.prepare("UPDATE memory_items SET title = 'changed' WHERE id = ?").run(id);
		}
		// Act
		const staleRank = () => rank(1, token);
		// Assert
		expect(before.results.map((item) => item.id)).toEqual([id]);
		expect(staleRank).toThrow();
	},
);

it("rejects existing transactions for both audit and ranking without ending the caller transaction", () => {
	// Arrange
	fixture.rawVector(fixture.memory(), vector());
	const { token } = auditCorpus(fixture.db, { knownModels: [MODEL] });
	fixture.db.exec("BEGIN");
	// Act
	const audit = () => auditCorpus(fixture.db, { knownModels: [MODEL] });
	const nestedRank = () => rank(1, token);
	// Assert
	expect(audit).toThrow();
	expect(nestedRank).toThrow();
	expect(fixture.db.inTransaction).toBe(true);
	fixture.db.exec("ROLLBACK");
});
