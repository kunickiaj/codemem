import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { buildMemoryPack, estimateTokens } from "./pack.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Unit tests: estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
	it("estimates roughly 4 chars per token", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcdefgh")).toBe(2);
		expect(estimateTokens("a")).toBe(1); // ceil(1/4) = 1
	});

	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Integration tests: buildMemoryPack
// ---------------------------------------------------------------------------

describe("buildMemoryPack", () => {
	let tmpDir: string;
	let store: MemoryStore;
	let sessionId: number;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-pack-"));
		const dbPath = join(tmpDir, "test.db");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
		sessionId = insertTestSession(store.db);
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns items and pack_text for matching context", () => {
		store.remember(sessionId, "discovery", "Found database issue", "The DB was slow", 0.8);
		store.remember(sessionId, "bugfix", "Fixed database query", "Optimized the join", 0.9);

		const pack = buildMemoryPack(store, "database");

		expect(pack.items.length).toBeGreaterThanOrEqual(1);
		expect(pack.pack_text).toBeTruthy();
		expect(typeof pack.pack_text).toBe("string");
		expect(pack.item_ids.length).toBeGreaterThanOrEqual(1);
	});

	it("falls back to recent when no search results", () => {
		store.remember(sessionId, "feature", "Add login page", "Built the login UI", 0.7);

		const pack = buildMemoryPack(store, "zzz_nomatch_zzz");

		expect(pack.metrics.fallback_used).toBe(true);
		expect(pack.items.length).toBeGreaterThanOrEqual(1);
	});

	it("respects token budget by truncating items", () => {
		// Insert several items with substantial text
		for (let i = 0; i < 10; i++) {
			store.remember(
				sessionId,
				"discovery",
				`Discovery item ${i} about testing`,
				`This is a long body text for item ${i} that should consume tokens in the budget calculation`,
				0.5,
			);
		}

		// Very small budget — should get fewer items than unlimited
		const smallPack = buildMemoryPack(store, "testing", 10, 20);
		const fullPack = buildMemoryPack(store, "testing", 10, null);

		expect(smallPack.items.length).toBeLessThanOrEqual(fullPack.items.length);
	});

	it("formats sections correctly", () => {
		store.remember(sessionId, "decision", "Use PostgreSQL", "Decided on PG for prod", 0.9);
		store.remember(sessionId, "discovery", "Found Redis cache", "Redis speeds up lookups", 0.7);

		const pack = buildMemoryPack(store, "PostgreSQL Redis");
		const text = pack.pack_text;

		// Should have section headers
		expect(text).toContain("## Timeline");
		// Items should appear with [id] (kind) format
		expect(text).toMatch(/\[\d+\]/);
		expect(text).toMatch(/\((decision|discovery)\)/);
	});

	it("metrics has expected shape", () => {
		store.remember(sessionId, "feature", "Add search", "FTS5 search feature", 0.8);

		const pack = buildMemoryPack(store, "search");

		expect(pack.metrics).toHaveProperty("total_items");
		expect(pack.metrics).toHaveProperty("pack_tokens");
		expect(pack.metrics).toHaveProperty("fallback_used");
		expect(pack.metrics).toHaveProperty("sources");
		expect(typeof pack.metrics.total_items).toBe("number");
		expect(typeof pack.metrics.pack_tokens).toBe("number");
		expect(typeof pack.metrics.fallback_used).toBe("boolean");

		expect(pack.metrics.sources).toHaveProperty("fts");
		expect(pack.metrics.sources).toHaveProperty("semantic");
		expect(pack.metrics.sources).toHaveProperty("fuzzy");
		expect(pack.metrics.sources.semantic).toBe(0);
		expect(pack.metrics.sources.fuzzy).toBe(0);
	});

	it("returns empty pack for empty database", () => {
		const pack = buildMemoryPack(store, "anything");

		expect(pack.items.length).toBe(0);
		expect(pack.pack_text).toBe("");
		expect(pack.item_ids.length).toBe(0);

		expect(pack.metrics.total_items).toBe(0);
		expect(pack.metrics.fallback_used).toBe(true);
	});

	it("includes context in the result", () => {
		const pack = buildMemoryPack(store, "my test context");
		expect(pack.context).toBe("my test context");
	});

	it("with tokenBudget=0 skips budget enforcement (treats as no budget)", () => {
		store.remember(sessionId, "discovery", "Found database issue", "The DB was slow", 0.8);
		store.remember(sessionId, "bugfix", "Fixed database query", "Optimized the join", 0.9);

		// tokenBudget=0 — the code checks `tokenBudget > 0`, so 0 means no budgeting
		const pack = buildMemoryPack(store, "database", 10, 0);

		// Should still return a valid structure
		expect(pack.metrics).toHaveProperty("total_items");
		expect(pack.metrics).toHaveProperty("pack_tokens");
		expect(pack.metrics).toHaveProperty("fallback_used");
		expect(typeof pack.metrics.total_items).toBe("number");
		expect(typeof pack.metrics.pack_tokens).toBe("number");

		// Items should be present (budget not enforced since 0 > 0 is false)
		expect(pack.items.length).toBeGreaterThanOrEqual(1);
		expect(pack.pack_text).toBeTruthy();
	});

	it("pack items have expected fields", () => {
		store.remember(sessionId, "bugfix", "Fix crash", "Null pointer fix", 0.9, ["crash", "fix"]);

		const pack = buildMemoryPack(store, "crash");

		expect(pack.items.length).toBeGreaterThanOrEqual(1);
		const item = pack.items[0];
		expect(item).toHaveProperty("id");
		expect(item).toHaveProperty("kind");
		expect(item).toHaveProperty("title");
		expect(item).toHaveProperty("body");
		expect(item).toHaveProperty("confidence");
		expect(item).toHaveProperty("tags");
		expect(item).toHaveProperty("metadata");
	});
});
