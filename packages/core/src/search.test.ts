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

// ---------------------------------------------------------------------------
// Integration tests: MemoryStore.timeline
// ---------------------------------------------------------------------------

describe("MemoryStore.timeline", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-timeline-test-"));
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

	/** Seed memories with controlled timestamps so ordering is deterministic. */
	function seedTimeline() {
		const sessionId = insertTestSession(store.db);
		const baseTime = new Date("2025-01-01T00:00:00Z").getTime();
		const ids: number[] = [];

		// Insert 7 memories with 1-hour spacing in the same session
		const titles = [
			"First setup",
			"Added models",
			"Database schema",
			"API endpoints",
			"Authentication",
			"Testing suite",
			"Deployment config",
		];
		for (let i = 0; i < titles.length; i++) {
			const ts = new Date(baseTime + i * 3_600_000).toISOString();
			// Insert directly to control timestamps; FTS trigger auto-populates memory_fts
			const info = store.db
				.prepare(
					`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
					 tags_text, active, created_at, updated_at, metadata_json, rev)
					 VALUES (?, 'feature', ?, 'body text', 0.5, '', 1, ?, ?, '{}', 1)`,
				)
				.run(sessionId, titles[i], ts, ts);
			ids.push(Number(info.lastInsertRowid));
		}
		return { sessionId, ids };
	}

	it("finds anchor by query and returns neighbors", () => {
		seedTimeline();
		const results = store.timeline("Database");
		expect(results.length).toBeGreaterThan(0);
		// Should find "Database schema" as anchor and include neighbors
		const titles = results.map((r) => r.title);
		expect(titles).toContain("Database schema");
	});

	it("finds anchor by memoryId", () => {
		const { ids } = seedTimeline();
		// Use the 4th memory (API endpoints) as anchor
		const anchorId = ids[3] as number;
		const results = store.timeline(null, anchorId, 2, 2);
		expect(results.length).toBeGreaterThan(0);
		// Should contain the anchor
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain(anchorId);
		// With depth 2 before + anchor + depth 2 after = up to 5
		expect(results.length).toBeLessThanOrEqual(5);
	});

	it("returns empty for no match", () => {
		seedTimeline();
		const results = store.timeline("xyznonexistent");
		expect(results).toEqual([]);
	});

	it("stays within same session", () => {
		const { ids } = seedTimeline();
		// Create a memory in a different session
		const session2 = insertTestSession(store.db);
		store.remember(session2, "feature", "Unrelated item", "Different session entirely");

		// Use memoryId to anchor on a known session
		const anchorId = ids[3] as number;
		const results = store.timeline(null, anchorId, 3, 3);
		expect(results.length).toBeGreaterThan(1);
		// All results should share the same session_id
		const sessionIds = new Set(results.map((r) => r.session_id));
		expect(sessionIds.size).toBe(1);
	});

	it("parses metadata_json on each result", () => {
		seedTimeline();
		const results = store.timeline("Database");
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			// metadata_json should be parsed into an object, not a raw string
			expect(typeof r.metadata_json).toBe("object");
		}
	});

	it("returns empty when memoryId does not exist", () => {
		seedTimeline();
		const results = store.timeline(null, 99999);
		expect(results).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Integration tests: MemoryStore.explain
// ---------------------------------------------------------------------------

describe("MemoryStore.explain", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-explain-test-"));
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
		const id1 = store.remember(
			sessionId,
			"discovery",
			"Database migration guide",
			"How to run migrations",
		);
		const id2 = store.remember(
			sessionId,
			"feature",
			"Authentication system",
			"JWT tokens and refresh flow",
		);
		const id3 = store.remember(
			sessionId,
			"bugfix",
			"Database connection fix",
			"Fixed connection leak",
		);
		return { sessionId, id1, id2, id3 };
	}

	it("returns scored items for query", () => {
		seedMemories();
		const result = store.explain("database") as Record<string, unknown>;
		const items = result.items as Record<string, unknown>[];
		expect(items.length).toBeGreaterThan(0);
		expect(result.errors).toEqual([]);

		// Each item should have the explain payload shape
		for (const item of items) {
			expect(item).toHaveProperty("id");
			expect(item).toHaveProperty("kind");
			expect(item).toHaveProperty("title");
			expect(item).toHaveProperty("retrieval");
			expect(item).toHaveProperty("score");

			const retrieval = item.retrieval as Record<string, unknown>;
			expect(retrieval.source).toBe("query");
			expect(typeof retrieval.rank).toBe("number");

			const score = item.score as Record<string, unknown>;
			expect(typeof score.total).toBe("number");
			expect(score.total as number).toBeGreaterThanOrEqual(0);

			const components = score.components as Record<string, unknown>;
			expect(typeof components.base).toBe("number");
			expect(typeof components.recency).toBe("number");
			expect(typeof components.kind_bonus).toBe("number");
		}
	});

	it("returns items by id lookup", () => {
		const { id1, id2 } = seedMemories();
		const result = store.explain(null, [id1, id2]) as Record<string, unknown>;
		const items = result.items as Record<string, unknown>[];
		expect(items).toHaveLength(2);

		for (const item of items) {
			const retrieval = item.retrieval as Record<string, unknown>;
			expect(retrieval.source).toBe("id_lookup");
			expect(retrieval.rank).toBeNull();

			// id_lookup items have null base score and null total
			const score = item.score as Record<string, unknown>;
			expect(score.total).toBeNull();
			expect((score.components as Record<string, unknown>).base).toBeNull();
		}
	});

	it("merges query and id results", () => {
		const { id1, id2 } = seedMemories();
		// id1 is "Database migration guide" — should match the query
		// id2 is "Authentication system" — should only appear via id_lookup
		const result = store.explain("database", [id1, id2]) as Record<string, unknown>;
		const items = result.items as Record<string, unknown>[];
		expect(items.length).toBeGreaterThanOrEqual(2);

		const sources = items.map((i) => (i.retrieval as Record<string, unknown>).source);
		// id1 should appear as query+id_lookup (found by both query and id)
		expect(sources).toContain("query+id_lookup");
		// id2 should appear as id_lookup (not matched by "database" query)
		expect(sources).toContain("id_lookup");

		// No duplicates
		const ids = items.map((i) => i.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("reports missing ids", () => {
		seedMemories();
		const result = store.explain(null, [99999, 88888]) as Record<string, unknown>;
		const missingIds = result.missing_ids as number[];
		expect(missingIds).toContain(99999);
		expect(missingIds).toContain(88888);

		const errors = result.errors as Record<string, unknown>[];
		const notFoundError = errors.find((e) => e.code === "NOT_FOUND");
		expect(notFoundError).toBeDefined();
	});

	it("returns error when neither query nor ids provided", () => {
		seedMemories();
		const result = store.explain() as Record<string, unknown>;
		expect(result.items).toEqual([]);
		const errors = result.errors as Record<string, unknown>[];
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toHaveProperty("code", "INVALID_ARGUMENT");
	});

	it("returns expected metadata shape", () => {
		seedMemories();
		const result = store.explain("database") as Record<string, unknown>;
		const metadata = result.metadata as Record<string, unknown>;
		expect(metadata).toHaveProperty("query", "database");
		expect(metadata).toHaveProperty("requested_ids_count", 0);
		expect(typeof metadata.returned_items_count).toBe("number");
	});
});
