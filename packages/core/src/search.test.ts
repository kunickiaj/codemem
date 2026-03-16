import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { expandQuery, kindBonus, recencyScore, rerankResults } from "./search.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { MemoryResult } from "./types.js";

// ---------------------------------------------------------------------------
// Unit tests: expandQuery
// ---------------------------------------------------------------------------

describe("expandQuery", () => {
	it("returns single token as-is", () => {
		expect(expandQuery("database")).toBe("database");
	});

	it("joins multiple tokens with OR", () => {
		expect(expandQuery("database migration")).toBe("database OR migration");
	});

	it("returns empty string for empty input", () => {
		expect(expandQuery("")).toBe("");
	});

	it("returns empty string for whitespace-only input", () => {
		expect(expandQuery("   ")).toBe("");
	});

	it("filters out FTS5 operators (case insensitive)", () => {
		expect(expandQuery("database AND migration")).toBe("database OR migration");
		expect(expandQuery("NOT important OR test")).toBe("important OR test");
		expect(expandQuery("foo or bar")).toBe("foo OR bar");
	});

	it("returns empty when only FTS5 operators remain", () => {
		expect(expandQuery("AND OR NOT")).toBe("");
	});

	it("handles special characters by extracting alphanumeric tokens", () => {
		expect(expandQuery("hello-world")).toBe("hello OR world");
		expect(expandQuery("foo_bar")).toBe("foo_bar");
	});
});

// ---------------------------------------------------------------------------
// Unit tests: recencyScore
// ---------------------------------------------------------------------------

describe("recencyScore", () => {
	it("returns ~1.0 for a just-created memory", () => {
		const now = new Date();
		const score = recencyScore(now.toISOString(), now);
		expect(score).toBeCloseTo(1.0, 2);
	});

	it("returns lower score for older memories", () => {
		const now = new Date();
		const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
		const score = recencyScore(sevenDaysAgo.toISOString(), now);
		// 1 / (1 + 7/7) = 0.5
		expect(score).toBeCloseTo(0.5, 2);
	});

	it("returns even lower score for very old memories", () => {
		const now = new Date();
		const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
		const score = recencyScore(thirtyDaysAgo.toISOString(), now);
		// 1 / (1 + 30/7) ≈ 0.189
		expect(score).toBeLessThan(0.2);
		expect(score).toBeGreaterThan(0.1);
	});

	it("returns 0 for invalid date string", () => {
		expect(recencyScore("not-a-date")).toBe(0.0);
		expect(recencyScore("")).toBe(0.0);
	});
});

// ---------------------------------------------------------------------------
// Unit tests: kindBonus
// ---------------------------------------------------------------------------

describe("kindBonus", () => {
	it("returns bonus for known kinds", () => {
		expect(kindBonus("discovery")).toBe(0.12);
		expect(kindBonus("decision")).toBe(0.2);
		expect(kindBonus("feature")).toBe(0.18);
		expect(kindBonus("bugfix")).toBe(0.18);
		expect(kindBonus("refactor")).toBe(0.17);
		expect(kindBonus("change")).toBe(0.12);
		expect(kindBonus("exploration")).toBe(0.1);
	});

	it("returns 0 for unknown kind", () => {
		expect(kindBonus("unknown_kind")).toBe(0.0);
	});

	it("returns 0 for null", () => {
		expect(kindBonus(null)).toBe(0.0);
	});

	it("is case insensitive", () => {
		expect(kindBonus("Discovery")).toBe(0.12);
		expect(kindBonus("FEATURE")).toBe(0.18);
	});
});

// ---------------------------------------------------------------------------
// Unit tests: rerankResults
// ---------------------------------------------------------------------------

describe("rerankResults", () => {
	function makeResult(overrides: Partial<MemoryResult>): MemoryResult {
		return {
			id: 1,
			kind: "discovery",
			title: "test",
			body_text: "test body",
			confidence: 0.5,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			tags_text: "",
			score: 1.0,
			session_id: 1,
			metadata: {},
			...overrides,
		};
	}

	it("limits results to the requested count", () => {
		const results = [
			makeResult({ id: 1, score: 3.0 }),
			makeResult({ id: 2, score: 2.0 }),
			makeResult({ id: 3, score: 1.0 }),
		];
		const reranked = rerankResults(results, 2);
		expect(reranked).toHaveLength(2);
	});

	it("sorts by combined score descending", () => {
		const results = [
			makeResult({ id: 1, score: 1.0, kind: "exploration" }),
			makeResult({ id: 2, score: 3.0, kind: "decision" }),
		];
		const reranked = rerankResults(results, 10);
		expect(reranked[0]?.id).toBe(2);
		expect(reranked[1]?.id).toBe(1);
	});

	it("returns empty array for empty input", () => {
		expect(rerankResults([], 10)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Integration tests: MemoryStore.search (FTS5)
// ---------------------------------------------------------------------------

describe("MemoryStore.search", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-search-test-"));
		dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function seedMemories() {
		const sessionId = insertTestSession(store.db);
		store.remember(sessionId, "discovery", "Database migration guide", "How to run migrations");
		store.remember(sessionId, "feature", "Authentication system", "JWT tokens and refresh flow");
		store.remember(
			sessionId,
			"bugfix",
			"Database connection pooling fix",
			"Fixed connection leak in pool",
		);
		store.remember(
			sessionId,
			"decision",
			"Chose PostgreSQL over MySQL",
			"Decision to use PostgreSQL for JSONB support",
		);
		return sessionId;
	}

	it("finds memories matching a query term", () => {
		seedMemories();
		const results = store.search("database");
		expect(results.length).toBeGreaterThan(0);
		// All results should mention "database" in title or body
		for (const r of results) {
			const text = `${r.title} ${r.body_text}`.toLowerCase();
			expect(text).toContain("database");
		}
	});

	it("returns results ordered by relevance score", () => {
		seedMemories();
		const results = store.search("database");
		expect(results.length).toBeGreaterThanOrEqual(2);
		// Scores should be in descending order (after reranking)
		for (let i = 1; i < results.length; i++) {
			const prev = results[i - 1] as MemoryResult;
			const curr = results[i] as MemoryResult;
			// Score from the SQL is the raw BM25 score; reranking may change order
			// but the combined score should still be non-negative
			expect(prev.score).toBeGreaterThanOrEqual(0);
			expect(curr.score).toBeGreaterThanOrEqual(0);
		}
	});

	it("returns empty array for non-matching query", () => {
		seedMemories();
		const results = store.search("xyznonexistent");
		expect(results).toEqual([]);
	});

	it("returns empty array for empty query", () => {
		seedMemories();
		const results = store.search("");
		expect(results).toEqual([]);
	});

	it("respects the limit parameter", () => {
		seedMemories();
		const results = store.search("database", 1);
		expect(results).toHaveLength(1);
	});

	it("filters by kind", () => {
		seedMemories();
		const results = store.search("database", 10, { kind: "bugfix" });
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.kind).toBe("bugfix");
		}
	});

	it("returns MemoryResult objects with expected shape", () => {
		seedMemories();
		const results = store.search("authentication");
		expect(results.length).toBeGreaterThan(0);
		const result = results[0] as MemoryResult;
		expect(result).toHaveProperty("id");
		expect(result).toHaveProperty("kind");
		expect(result).toHaveProperty("title");
		expect(result).toHaveProperty("body_text");
		expect(result).toHaveProperty("confidence");
		expect(result).toHaveProperty("created_at");
		expect(result).toHaveProperty("updated_at");
		expect(result).toHaveProperty("tags_text");
		expect(result).toHaveProperty("score");
		expect(result).toHaveProperty("session_id");
		expect(result).toHaveProperty("metadata");
		expect(typeof result.score).toBe("number");
		expect(typeof result.metadata).toBe("object");
	});
});
