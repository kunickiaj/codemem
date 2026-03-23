import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { buildMemoryPack, estimateTokens } from "./pack.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { MemoryResult } from "./types.js";

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
		expect(pack.metrics).toHaveProperty("fallback");
		expect(pack.metrics).toHaveProperty("limit");
		expect(pack.metrics).toHaveProperty("token_budget");
		expect(pack.metrics).toHaveProperty("project");
		expect(pack.metrics).toHaveProperty("pack_item_ids");
		expect(pack.metrics).toHaveProperty("sources");
		expect(typeof pack.metrics.total_items).toBe("number");
		expect(typeof pack.metrics.pack_tokens).toBe("number");
		expect(typeof pack.metrics.fallback_used).toBe("boolean");
		expect(["recent", null]).toContain(pack.metrics.fallback);
		expect(typeof pack.metrics.limit).toBe("number");
		expect(Array.isArray(pack.metrics.pack_item_ids)).toBe(true);

		expect(pack.metrics.sources).toHaveProperty("fts");
		expect(pack.metrics.sources).toHaveProperty("semantic");
		expect(pack.metrics.sources).toHaveProperty("fuzzy");
		expect(pack.metrics.sources.semantic).toBe(0);
		expect(pack.metrics.sources.fuzzy).toBe(0);
	});

	it("returns empty pack for empty database", () => {
		const pack = buildMemoryPack(store, "anything");

		expect(pack.items.length).toBe(0);
		expect(pack.pack_text).toContain("## Summary");
		expect(pack.pack_text).toContain("## Timeline");
		expect(pack.pack_text).toContain("## Observations");
		expect(pack.item_ids.length).toBe(0);

		expect(pack.metrics.total_items).toBe(0);
		expect(pack.metrics.fallback_used).toBe(true);
	});

	it("always emits all three section headers", () => {
		const pack = buildMemoryPack(store, "anything");

		expect(pack.pack_text).toContain("## Summary");
		expect(pack.pack_text).toContain("## Timeline");
		expect(pack.pack_text).toContain("## Observations");
	});

	it("falls back to timeline items for observations when none exist", () => {
		store.remember(sessionId, "feature", "Runtime entities", "Tracked agent entities", 0.7);

		const originalRecentByKinds = store.recentByKinds.bind(store);
		(store as unknown as { recentByKinds: typeof store.recentByKinds }).recentByKinds = () => [];
		try {
			const pack = buildMemoryPack(store, "runtime entities");

			const observationsBlock = pack.pack_text.split("## Observations")[1] ?? "";
			expect(observationsBlock).toContain("(feature)");
		} finally {
			(store as unknown as { recentByKinds: typeof store.recentByKinds }).recentByKinds =
				originalRecentByKinds;
		}
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

	it("keeps working-set overlaps prioritized when semantic candidates are merged", () => {
		const semanticResults: MemoryResult[] = [
			{
				id: 1,
				kind: "feature",
				title: "Overlapping file",
				body_text: "Directly related to current file",
				confidence: 0.9,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				tags_text: "",
				score: 0.22,
				session_id: sessionId,
				metadata: { files_modified: ["src/important.ts"] },
			},
			{
				id: 2,
				kind: "feature",
				title: "Non-overlapping file",
				body_text: "Not tied to working set",
				confidence: 0.9,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				tags_text: "",
				score: 0.25,
				session_id: sessionId,
				metadata: { files_modified: ["src/other.ts"] },
			},
		];

		const pack = buildMemoryPack(
			store,
			"zzz_nomatch_zzz",
			10,
			null,
			{ working_set_paths: ["src/important.ts"] },
			semanticResults,
		);

		expect(pack.item_ids[0]).toBe(1);
	});
});
