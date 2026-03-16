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

		expect((pack.items as unknown[]).length).toBeGreaterThanOrEqual(1);
		expect(pack.pack_text).toBeTruthy();
		expect(typeof pack.pack_text).toBe("string");
		expect((pack.item_ids as number[]).length).toBeGreaterThanOrEqual(1);
	});

	it("falls back to recent when no search results", () => {
		store.remember(sessionId, "feature", "Add login page", "Built the login UI", 0.7);

		const pack = buildMemoryPack(store, "zzz_nomatch_zzz");
		const metrics = pack.metrics as Record<string, unknown>;

		expect(metrics.fallback_used).toBe(true);
		expect((pack.items as unknown[]).length).toBeGreaterThanOrEqual(1);
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

		const smallItems = smallPack.items as unknown[];
		const fullItems = fullPack.items as unknown[];

		expect(smallItems.length).toBeLessThanOrEqual(fullItems.length);
	});

	it("formats sections correctly", () => {
		store.remember(sessionId, "decision", "Use PostgreSQL", "Decided on PG for prod", 0.9);
		store.remember(sessionId, "discovery", "Found Redis cache", "Redis speeds up lookups", 0.7);

		const pack = buildMemoryPack(store, "PostgreSQL Redis");
		const text = pack.pack_text as string;

		// Should have section headers
		expect(text).toContain("## Timeline");
		// Items should appear with [id] (kind) format
		expect(text).toMatch(/\[\d+\]/);
		expect(text).toMatch(/\((decision|discovery)\)/);
	});

	it("metrics has expected shape", () => {
		store.remember(sessionId, "feature", "Add search", "FTS5 search feature", 0.8);

		const pack = buildMemoryPack(store, "search");
		const metrics = pack.metrics as Record<string, unknown>;

		expect(metrics).toHaveProperty("total_items");
		expect(metrics).toHaveProperty("pack_tokens");
		expect(metrics).toHaveProperty("fallback_used");
		expect(metrics).toHaveProperty("sources");
		expect(typeof metrics.total_items).toBe("number");
		expect(typeof metrics.pack_tokens).toBe("number");
		expect(typeof metrics.fallback_used).toBe("boolean");

		const sources = metrics.sources as Record<string, number>;
		expect(sources).toHaveProperty("fts");
		expect(sources).toHaveProperty("semantic");
		expect(sources).toHaveProperty("fuzzy");
		expect(sources.semantic).toBe(0);
		expect(sources.fuzzy).toBe(0);
	});

	it("returns empty pack for empty database", () => {
		const pack = buildMemoryPack(store, "anything");

		expect((pack.items as unknown[]).length).toBe(0);
		expect(pack.pack_text).toBe("");
		expect((pack.item_ids as number[]).length).toBe(0);

		const metrics = pack.metrics as Record<string, unknown>;
		expect(metrics.total_items).toBe(0);
		expect(metrics.fallback_used).toBe(true);
	});

	it("includes context in the result", () => {
		const pack = buildMemoryPack(store, "my test context");
		expect(pack.context).toBe("my test context");
	});

	it("pack items have expected fields", () => {
		store.remember(sessionId, "bugfix", "Fix crash", "Null pointer fix", 0.9, ["crash", "fix"]);

		const pack = buildMemoryPack(store, "crash");
		const items = pack.items as Array<Record<string, unknown>>;

		expect(items.length).toBeGreaterThanOrEqual(1);
		const item = items[0] as Record<string, unknown>;
		expect(item).toHaveProperty("id");
		expect(item).toHaveProperty("kind");
		expect(item).toHaveProperty("title");
		expect(item).toHaveProperty("body");
		expect(item).toHaveProperty("confidence");
		expect(item).toHaveProperty("tags");
		expect(item).toHaveProperty("metadata");
	});
});
