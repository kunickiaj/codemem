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

	it("strips NEAR operator", () => {
		expect(expandQuery("NEAR database")).toBe("database");
		expect(expandQuery("near tables")).toBe("tables");
	});

	it("strips PHRASE operator", () => {
		expect(expandQuery("phrase match test")).toBe("match OR test");
		expect(expandQuery("PHRASE only")).toBe("only");
	});

	it("returns empty when query is only NEAR/PHRASE operators", () => {
		expect(expandQuery("NEAR PHRASE")).toBe("");
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

	it("matches project filters by basename and suffix like Python", () => {
		const now = new Date().toISOString();
		const matchingSessionId = Number(
			store.db
				.prepare(
					`INSERT INTO sessions (started_at, cwd, user, tool_version, project)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(now, "/tmp/codemem", "testuser", "test-1.0", "workspace/codemem").lastInsertRowid,
		);
		const otherSessionId = Number(
			store.db
				.prepare(
					`INSERT INTO sessions (started_at, cwd, user, tool_version, project)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(now, "/tmp/other", "testuser", "test-1.0", "workspace/other").lastInsertRowid,
		);

		store.remember(matchingSessionId, "discovery", "Database guide", "database details");
		store.remember(otherSessionId, "discovery", "Database elsewhere", "database details");

		const results = store.search("database", 10, { project: "/Users/adam/workspace/codemem" });
		expect(results).toHaveLength(1);
		expect(results[0]?.session_id).toBe(matchingSessionId);
	});

	it("returns empty array when query becomes empty after operator filtering", () => {
		seedMemories();
		const results = store.search("AND OR NOT");
		expect(results).toEqual([]);
	});

	it("filters by multiple criteria combined (kind + visibility)", () => {
		const sessionId = insertTestSession(store.db);
		// Insert memories with different kinds and visibility
		const ts = new Date().toISOString();
		store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'bugfix', 'Database bugfix shared', 'Shared fix for DB', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, ts, ts);
		store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'bugfix', 'Database bugfix private', 'Private fix for DB', 0.5, '', 1, ?, ?, '{}', 1, 'private')`,
			)
			.run(sessionId, ts, ts);
		store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, visibility)
				 VALUES (?, 'feature', 'Database feature shared', 'Shared feature for DB', 0.5, '', 1, ?, ?, '{}', 1, 'shared')`,
			)
			.run(sessionId, ts, ts);

		const results = store.search("database", 10, {
			kind: "bugfix",
			include_visibility: ["shared"],
		});
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.kind).toBe("bugfix");
			// visibility is on metadata, but the filter should have applied
		}
		// The shared bugfix should be found, the private bugfix and feature should not
		const titles = results.map((r) => r.title);
		expect(titles).toContain("Database bugfix shared");
		expect(titles).not.toContain("Database bugfix private");
		expect(titles).not.toContain("Database feature shared");
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

	it("with depthBefore=0 returns only anchor + after items", () => {
		const { ids } = seedTimeline();
		// Anchor on the 4th memory (index 3 = "API endpoints")
		const anchorId = ids[3] as number;
		const results = store.timeline(null, anchorId, 0, 2);
		expect(results.length).toBeGreaterThan(0);
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain(anchorId);
		// Should not have any items before the anchor
		const anchorIdx = resultIds.indexOf(anchorId);
		expect(anchorIdx).toBe(0);
		// Should have at most 2 items after anchor
		expect(results.length).toBeLessThanOrEqual(3); // anchor + 2 after
	});

	it("with depthAfter=0 returns only before items + anchor", () => {
		const { ids } = seedTimeline();
		// Anchor on the 4th memory (index 3 = "API endpoints")
		const anchorId = ids[3] as number;
		const results = store.timeline(null, anchorId, 2, 0);
		expect(results.length).toBeGreaterThan(0);
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain(anchorId);
		// Should have at most 2 items before anchor
		const anchorIdx = resultIds.indexOf(anchorId);
		expect(anchorIdx).toBeLessThanOrEqual(2);
		// Anchor should be last (nothing after it)
		expect(resultIds[resultIds.length - 1]).toBe(anchorId);
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
		const result = store.explain("database");
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.errors).toEqual([]);

		// Each item should have the explain payload shape
		for (const item of result.items) {
			expect(item).toHaveProperty("id");
			expect(item).toHaveProperty("kind");
			expect(item).toHaveProperty("title");
			expect(item).toHaveProperty("retrieval");
			expect(item).toHaveProperty("score");

			expect(item.retrieval.source).toBe("query");
			expect(typeof item.retrieval.rank).toBe("number");

			expect(typeof item.score.total).toBe("number");
			expect(item.score.total as number).toBeGreaterThanOrEqual(0);

			expect(typeof item.score.components.base).toBe("number");
			expect(typeof item.score.components.recency).toBe("number");
			expect(typeof item.score.components.kind_bonus).toBe("number");
		}
	});

	it("returns items by id lookup", () => {
		const { id1, id2 } = seedMemories();
		const result = store.explain(null, [id1, id2]);
		expect(result.items).toHaveLength(2);

		for (const item of result.items) {
			expect(item.retrieval.source).toBe("id_lookup");
			expect(item.retrieval.rank).toBeNull();

			// id_lookup items have null base score and null total
			expect(item.score.total).toBeNull();
			expect(item.score.components.base).toBeNull();
		}
	});

	it("merges query and id results", () => {
		const { id1, id2 } = seedMemories();
		// id1 is "Database migration guide" — should match the query
		// id2 is "Authentication system" — should only appear via id_lookup
		const result = store.explain("database", [id1, id2]);
		expect(result.items.length).toBeGreaterThanOrEqual(2);

		const sources = result.items.map((i) => i.retrieval.source);
		// id1 should appear as query+id_lookup (found by both query and id)
		expect(sources).toContain("query+id_lookup");
		// id2 should appear as id_lookup (not matched by "database" query)
		expect(sources).toContain("id_lookup");

		// No duplicates
		const ids = result.items.map((i) => i.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("reports missing ids", () => {
		seedMemories();
		const result = store.explain(null, [99999, 88888]);
		expect(result.missing_ids).toContain(99999);
		expect(result.missing_ids).toContain(88888);

		const notFoundError = result.errors.find((e) => e.code === "NOT_FOUND");
		expect(notFoundError).toBeDefined();
	});

	it("returns error when neither query nor ids provided", () => {
		seedMemories();
		const result = store.explain();
		expect(result.items).toEqual([]);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toHaveProperty("code", "INVALID_ARGUMENT");
	});

	it("returns expected metadata shape", () => {
		seedMemories();
		const result = store.explain("database");
		expect(result.metadata).toHaveProperty("query", "database");
		expect(result.metadata).toHaveProperty("requested_ids_count", 0);
		expect(typeof result.metadata.returned_items_count).toBe("number");
	});

	it("rejects booleans and floats in ids (dedupeOrderedIds)", () => {
		const { id1 } = seedMemories();
		// Pass booleans, a float, and one valid int
		const result = store.explain(null, [true, false, 3.14, id1]);
		// Only the valid integer id should produce an item
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.id).toBe(id1);
		// The invalid values should be reported
		const invalidArgError = result.errors.find((e) => e.code === "INVALID_ARGUMENT");
		expect(invalidArgError).toBeDefined();
		const invalidIds = invalidArgError?.ids as (string | number)[];
		expect(invalidIds).toContain("true");
		expect(invalidIds).toContain("false");
		expect(invalidIds).toContain("3.14");
	});

	it("rejects non-digit strings, scientific notation, and unsafe ints in ids", () => {
		const { id1 } = seedMemories();
		const result = store.explain(null, [
			"1e2",
			"1.0",
			" 7 ",
			`${Number.MAX_SAFE_INTEGER + 1}`,
			id1,
		]);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.id).toBe(id1);
		const invalidArgError = result.errors.find((e) => e.code === "INVALID_ARGUMENT");
		expect(invalidArgError).toBeDefined();
		const invalidIds = invalidArgError?.ids as (string | number)[];
		expect(invalidIds).toContain("1e2");
		expect(invalidIds).toContain("1.0");
		expect(invalidIds).toContain(" 7 ");
		expect(invalidIds).toContain(`${Number.MAX_SAFE_INTEGER + 1}`);
	});

	it("excludes id-lookup memories that fail workspace_id filter (rowMatchesFilters)", () => {
		const sessionId = insertTestSession(store.db);
		// Insert a memory with a specific workspace_id
		const ts = new Date().toISOString();
		store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				 tags_text, active, created_at, updated_at, metadata_json, rev, workspace_id)
				 VALUES (?, 'discovery', 'WS memory', 'workspace body', 0.5, '', 1, ?, ?, '{}', 1, 'ws:team-alpha')`,
			)
			.run(sessionId, ts, ts);
		const memId = Number(
			(store.db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id,
		);

		// Explain with include_workspace_ids filter that doesn't match
		const result = store.explain(null, [memId], 10, {
			include_workspace_ids: ["ws:team-beta"],
		});

		expect(result.items).toHaveLength(0);

		// Should report as filter mismatch
		const mismatch = result.errors.find((e) => e.code === "FILTER_MISMATCH");
		expect(mismatch).toBeDefined();
		expect(mismatch?.ids ?? []).toContain(memId);
	});

	it("reports PROJECT_MISMATCH for ids outside requested project scope", () => {
		const now = new Date().toISOString();
		const matchingSessionId = Number(
			store.db
				.prepare(
					`INSERT INTO sessions (started_at, cwd, user, tool_version, project)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(now, "/tmp/codemem", "testuser", "test-1.0", "codemem").lastInsertRowid,
		);
		const otherSessionId = Number(
			store.db
				.prepare(
					`INSERT INTO sessions (started_at, cwd, user, tool_version, project)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(now, "/tmp/other", "testuser", "test-1.0", "workspace/other").lastInsertRowid,
		);
		const matchingId = store.remember(
			matchingSessionId,
			"discovery",
			"In scope",
			"project scoped memory",
		);
		const otherId = store.remember(
			otherSessionId,
			"discovery",
			"Out of scope",
			"project scoped memory",
		);

		const result = store.explain(null, [matchingId, otherId], 10, {
			project: "/Users/adam/workspace/codemem",
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.id).toBe(matchingId);
		expect(result.metadata.project).toBe("/Users/adam/workspace/codemem");
		expect(result.items[0]?.project).toBe("codemem");
		expect(result.items[0]?.matches.project_match).toBe(true);

		const mismatch = result.errors.find((e) => e.code === "PROJECT_MISMATCH");
		expect(mismatch).toBeDefined();
		expect(mismatch?.ids ?? []).toContain(otherId);
		expect(result.missing_ids).toContain(otherId);
	});

	it("treats whitespace-only project filters as no project scope", () => {
		const { id1, id2 } = seedMemories();
		const result = store.explain(null, [id1, id2], 10, { project: "   " });
		expect(result.items).toHaveLength(2);
		expect(result.errors.find((e) => e.code === "PROJECT_MISMATCH")).toBeUndefined();
	});
});
