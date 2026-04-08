import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { buildMemoryPack, buildMemoryPackTrace, estimateTokens } from "./pack.js";
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
		expect(pack.metrics).toHaveProperty("mode");
		expect(pack.metrics).toHaveProperty("added_ids");
		expect(pack.metrics).toHaveProperty("removed_ids");
		expect(pack.metrics).toHaveProperty("retained_ids");
		expect(pack.metrics).toHaveProperty("pack_token_delta");
		expect(pack.metrics).toHaveProperty("pack_delta_available");
		expect(pack.metrics).toHaveProperty("work_tokens");
		expect(pack.metrics).toHaveProperty("work_tokens_unique");
		expect(pack.metrics).toHaveProperty("tokens_saved");
		expect(pack.metrics).toHaveProperty("avoided_work_tokens");
		expect(pack.metrics).toHaveProperty("avoided_work_saved");
		expect(pack.metrics).toHaveProperty("work_source");
		expect(pack.metrics).toHaveProperty("savings_reliable");
		expect(pack.metrics).toHaveProperty("sources");
		expect(typeof pack.metrics.total_items).toBe("number");
		expect(typeof pack.metrics.pack_tokens).toBe("number");
		expect(typeof pack.metrics.fallback_used).toBe("boolean");
		expect(["recent", null]).toContain(pack.metrics.fallback);
		expect(typeof pack.metrics.limit).toBe("number");
		expect(Array.isArray(pack.metrics.pack_item_ids)).toBe(true);
		expect(["default", "task", "recall"]).toContain(pack.metrics.mode);

		expect(pack.metrics.sources).toHaveProperty("fts");
		expect(pack.metrics.sources).toHaveProperty("semantic");
		expect(pack.metrics.sources).toHaveProperty("fuzzy");
		expect(pack.metrics.sources.semantic).toBe(0);
		expect(pack.metrics.sources.fuzzy).toBe(0);
	});

	it("tracks pack delta against prior pack usage metadata", () => {
		const id1 = store.remember(sessionId, "feature", "First item", "Body one", 0.7);
		const first = buildMemoryPack(store, "first", 10);
		expect(first.metrics.pack_delta_available).toBe(false);

		const id2 = store.remember(sessionId, "feature", "Second item", "Body two", 0.7);
		const second = buildMemoryPack(store, "item", 10);

		expect(second.metrics.pack_delta_available).toBe(true);
		expect(second.metrics.added_ids).toContain(id2);
		expect(second.metrics.retained_ids).toContain(id1);
		expect(typeof second.metrics.pack_token_delta).toBe("number");
	});

	it("keeps project delta baseline after many packs in other projects", () => {
		store.remember(sessionId, "feature", "Project A item", "Body A", 0.7);

		const firstA = buildMemoryPack(store, "project", 10, null, { project: "test-project" });
		expect(firstA.metrics.pack_delta_available).toBe(false);

		for (let i = 0; i < 26; i++) {
			buildMemoryPack(store, `noise ${i}`, 10, null, { project: "other-project" });
		}

		const secondA = buildMemoryPack(store, "project", 10, null, { project: "test-project" });
		expect(secondA.metrics.pack_delta_available).toBe(true);
	});

	it("records pack usage with project-linked session id when project is provided", () => {
		store.remember(sessionId, "feature", "Project scoped item", "Body", 0.7);

		buildMemoryPack(store, "project scoped", 10, null, { project: "test-project" });

		const row = store.db
			.prepare(
				"SELECT session_id, metadata_json FROM usage_events WHERE event = 'pack' ORDER BY id DESC LIMIT 1",
			)
			.get() as { session_id: number | null; metadata_json: string | null };

		expect(row.session_id).toBe(sessionId);
		const metadata = row.metadata_json
			? (JSON.parse(row.metadata_json) as Record<string, unknown>)
			: {};
		expect(metadata.project).toBe("test-project");
	});

	it("uses discovery_tokens metadata for avoided-work metrics", () => {
		store.remember(sessionId, "feature", "Token heavy memory", "Useful context", 0.8, undefined, {
			discovery_tokens: 6000,
			discovery_source: "usage",
			discovery_group: "g1",
		});

		const pack = buildMemoryPack(store, "token heavy", 10);

		expect(pack.metrics.avoided_work_tokens).toBeGreaterThan(0);
		expect(pack.metrics.avoided_work_known_items).toBeGreaterThan(0);
		expect(pack.metrics.work_source).toBe("usage");
		expect(pack.metrics.work_usage_items).toBeGreaterThan(0);
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

	it("builds a deterministic pack trace with pack parity", () => {
		store.remember(
			sessionId,
			"decision",
			"Use SQLite for local state",
			"Chosen for portability",
			0.9,
			undefined,
			{
				files_modified: ["packages/core/src/store.ts"],
			},
		);
		store.remember(
			sessionId,
			"feature",
			"Continue viewer health work",
			"Next step is to improve the viewer health panel",
			0.8,
			undefined,
			{
				files_modified: ["packages/ui/src/app.ts"],
			},
		);

		const pack = buildMemoryPack(store, "continue viewer health work", 10, null, {
			working_set_paths: ["packages/ui/src/app.ts"],
		});
		const trace = buildMemoryPackTrace(store, "continue viewer health work", 10, null, {
			working_set_paths: ["packages/ui/src/app.ts"],
		});

		expect(trace.version).toBe(1);
		expect(trace.inputs.query).toBe("continue viewer health work");
		expect(trace.mode.selected).toBe(pack.metrics.mode);
		expect(trace.output.pack_text).toBe(pack.pack_text);
		expect(trace.output.estimated_tokens).toBe(pack.metrics.pack_tokens);
		expect(trace.assembly.sections.summary).toEqual(expect.any(Array));
		expect(trace.assembly.sections.timeline).toEqual(expect.any(Array));
		expect(trace.assembly.sections.observations).toEqual(expect.any(Array));
		expect(trace.retrieval.candidates.length).toBeGreaterThan(0);
		expect(trace.retrieval.candidates[0]).toEqual(
			expect.objectContaining({
				rank: 1,
				disposition: expect.stringMatching(/selected|dropped|deduped|trimmed/),
				scores: expect.objectContaining({
					combined_score: expect.any(Number),
					text_overlap: expect.any(Number),
					tag_overlap: expect.any(Number),
				}),
			}),
		);
	});

	it("marks deduped and trimmed candidates in pack trace", () => {
		for (let i = 0; i < 6; i++) {
			store.remember(
				sessionId,
				"feature",
				`Feature item ${i} about tracing`,
				`This is a long body for tracing item ${i} that should consume budget and ranking space`,
				0.7,
			);
		}
		const canonicalId = store.remember(
			sessionId,
			"decision",
			"Tracing duplicate title",
			"Tracing duplicate body",
			0.9,
		);
		const duplicateId = store.remember(
			sessionId,
			"decision",
			"Tracing duplicate title",
			"Tracing duplicate body",
			0.8,
		);

		const trace = buildMemoryPackTrace(store, "tracing", 10, 30);
		const collapsedGroup = trace.assembly.collapsed_groups.find(
			(group) => group.kept === canonicalId || group.kept === duplicateId,
		);

		expect(collapsedGroup).toBeTruthy();
		expect(collapsedGroup?.support_count).toBe(2);
		expect(
			[collapsedGroup?.kept, ...(collapsedGroup?.dropped ?? [])].sort((a, b) => a - b),
		).toEqual([canonicalId, duplicateId].sort((a, b) => a - b));
		for (const droppedId of collapsedGroup?.dropped ?? []) {
			expect(trace.assembly.deduped_ids).toContain(droppedId);
		}
		expect(trace.assembly.trimmed_ids.length).toBeGreaterThan(0);
		expect(trace.output.truncated).toBe(true);
		expect(
			trace.retrieval.candidates.some((candidate) => candidate.disposition === "trimmed"),
		).toBe(true);
		expect(
			trace.retrieval.candidates.some((candidate) => candidate.disposition === "deduped"),
		).toBe(true);
	});

	it("does not record usage events for trace-only calls", () => {
		store.remember(sessionId, "feature", "Trace-only item", "Useful trace context", 0.8);

		const before = store.db
			.prepare("SELECT COUNT(*) AS total FROM usage_events WHERE event = 'pack'")
			.get() as { total: number };
		const pack = buildMemoryPack(store, "trace-only item", 10);
		const afterPack = store.db
			.prepare("SELECT COUNT(*) AS total FROM usage_events WHERE event = 'pack'")
			.get() as { total: number };
		buildMemoryPackTrace(store, "trace-only item", 10);
		const afterTrace = store.db
			.prepare("SELECT COUNT(*) AS total FROM usage_events WHERE event = 'pack'")
			.get() as { total: number };

		expect(pack.items.length).toBeGreaterThan(0);
		expect(afterPack.total).toBe(before.total + 1);
		expect(afterTrace.total).toBe(afterPack.total);
	});

	it("uses the effective retrieval query in task-mode trace scoring", () => {
		store.remember(
			sessionId,
			"feature",
			"Review unresolved stack comments",
			"Track the unresolved Graphite review thread and CLI follow-up",
			0.9,
		);

		const trace = buildMemoryPackTrace(store, "continue review stack comments", 10);
		const candidate = trace.retrieval.candidates[0];

		expect(trace.mode.selected).toBe("task");
		expect(candidate).toBeDefined();
		expect(candidate.scores.text_overlap).toBeGreaterThan(0);
		expect(candidate.reasons).toContain("matched query terms");
	});

	it("keeps retrieval candidates anchored to retrieval instead of fallback assembly", () => {
		store.remember(sessionId, "session_summary", "Latest summary", "Summary fallback text", 0.9);

		const trace = buildMemoryPackTrace(store, "zzz_nomatch_zzz", 10);

		expect(trace.retrieval.candidate_count).toBe(0);
		expect(trace.output.pack_text).toContain("## Summary");
		expect(trace.output.pack_text).toContain("Latest summary");
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
				narrative: null,
				facts: null,
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
				narrative: null,
				facts: null,
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

	it("keeps topical terms when using task mode", () => {
		const decisionId = store.remember(
			sessionId,
			"decision",
			"Task: auth hardening",
			"Need to add OAuth callback validation",
			0.9,
		);
		store.remember(
			sessionId,
			"feature",
			"Task: polish viewer cards",
			"Refine spacing in cards",
			0.8,
		);

		const pack = buildMemoryPack(store, "what should we do next about auth", 10);

		expect(pack.metrics.mode).toBe("task");
		expect(pack.item_ids[0]).toBe(decisionId);
		expect(pack.pack_text.toLowerCase()).toContain("auth");
	});

	it("finds detailed recall anchors before summary narrowing", () => {
		const insertSummary = (targetSessionId: number, title: string, body: string) => {
			const now = new Date().toISOString();
			store.db
				.prepare(
					`INSERT INTO memory_items(
						session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, rev
					) VALUES (?, 'session_summary', ?, ?, 0.8, '', 1, ?, ?, '{}', 1)`,
				)
				.run(targetSessionId, title, body, now, now);
		};

		const olderSession = insertTestSession(store.db);
		const decisionId = store.remember(
			olderSession,
			"decision",
			"OAuth callback fix",
			"Patched callback verification",
			0.8,
		);
		insertSummary(olderSession, "Old summary", "Earlier wrap-up without oauth keyword");

		insertSummary(sessionId, "Recent summary", "Latest generic session wrap-up");
		store.remember(sessionId, "feature", "Recent unrelated", "Viewer polish task", 0.7);

		const pack = buildMemoryPack(store, "what did we do last time about oauth", 10);

		expect(pack.item_ids[0]).toBe(decisionId);
		expect(pack.pack_text).toContain("OAuth callback fix");
	});

	it("keeps broad recap queries summary-first in recall mode", () => {
		const now = new Date().toISOString();
		store.db
			.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, rev
				) VALUES (?, 'session_summary', ?, ?, 0.8, '', 1, ?, ?, '{}', 1)`,
			)
			.run(sessionId, "Recent summary", "Catch-up recap for current work", now, now);
		const decisionId = store.remember(
			sessionId,
			"decision",
			"OAuth callback fix",
			"Patched callback verification",
			0.8,
		);

		const pack = buildMemoryPack(store, "catch me up", 10);

		expect(pack.metrics.mode).toBe("recall");
		expect(pack.pack_text).toContain("Recent summary");
		expect(pack.item_ids[0]).not.toBe(decisionId);
	});

	it("does not inject legacy summary rows into non-summary recall packs", () => {
		const now = new Date().toISOString();
		store.db
			.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, rev
				) VALUES (?, 'change', ?, ?, 0.3, '', 1, ?, ?, ?, 1)`,
			)
			.run(
				sessionId,
				"Legacy summary",
				"## Request\nFix auth timeout\n\n## Completed\nAdded callback validation",
				now,
				now,
				JSON.stringify({ is_summary: true }),
			);
		store.remember(
			sessionId,
			"decision",
			"OAuth callback fix",
			"Patched callback verification",
			0.8,
		);

		const pack = buildMemoryPack(store, "what did we do last time about oauth", 10);

		expect(pack.pack_text).toContain("## Summary");
		expect(pack.pack_text).not.toContain("Legacy summary");
		expect(pack.pack_text).toContain("## Timeline\n[2] (decision) OAuth callback fix");
	});

	it("uses legacy summary-like rows in recall fallback when no session_summary exists", () => {
		const now = new Date().toISOString();
		store.db
			.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, rev
				) VALUES (?, 'change', ?, ?, 0.3, '', 1, ?, ?, ?, 1)`,
			)
			.run(
				sessionId,
				"Fallback summary",
				"## Request\nInvestigate auth failure\n\n## Learned\nOAuth callback state was missing",
				now,
				now,
				JSON.stringify({ is_summary: true }),
			);

		const pack = buildMemoryPack(store, "catch me up", 10);

		expect(pack.metrics.mode).toBe("recall");
		expect(pack.pack_text).toContain("Fallback summary");
	});

	it("finds the latest summary-like fallback even with many newer non-summary memories", () => {
		const older = new Date(Date.now() - 86_400_000).toISOString();
		store.db
			.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, rev
				) VALUES (?, 'session_summary', ?, ?, 0.8, '', 1, ?, ?, '{}', 1)`,
			)
			.run(sessionId, "Older summary", "Still the latest available summary", older, older);

		for (let i = 0; i < 50; i += 1) {
			store.remember(sessionId, "feature", `Recent feature ${i}`, "Newer non-summary memory", 0.5);
		}

		const pack = buildMemoryPack(store, "zzz_nomatch_zzz", 10);

		expect(pack.pack_text).toContain("## Summary");
		expect(pack.pack_text).toContain("Older summary");
	});

	it("keeps item_ids in relevance order even when summary is only display fallback", () => {
		const now = new Date().toISOString();
		store.db
			.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, rev
				) VALUES (?, 'session_summary', ?, ?, 0.8, '', 1, ?, ?, '{}', 1)`,
			)
			.run(sessionId, "Recent summary", "Generic recap text", now, now);

		const decisionId = store.remember(
			sessionId,
			"decision",
			"OAuth callback fix",
			"Patched callback verification for auth flow",
			0.9,
		);

		const pack = buildMemoryPack(store, "oauth callback", 10);

		expect(pack.pack_text).toContain("## Summary\n[1] (session_summary) Recent summary");
		expect(pack.item_ids[0]).toBe(decisionId);
	});
});

// ---------------------------------------------------------------------------
// Structured content tests: narrative and facts rendering
// ---------------------------------------------------------------------------

describe("buildMemoryPack structured content", () => {
	let tmpDir: string;
	let store: MemoryStore;
	let sessionId: number;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-pack-structured-"));
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

	it("renders narrative instead of body_text when available", () => {
		store.remember(
			sessionId,
			"discovery",
			"Found stale branches",
			"Raw body text blob",
			0.8,
			undefined,
			{ narrative: "The branch audit clarified which branches were real work" },
		);

		const pack = buildMemoryPack(store, "stale branches");

		expect(pack.pack_text).toContain("Found stale branches");
		expect(pack.pack_text).toContain("The branch audit clarified");
		expect(pack.pack_text).not.toContain("Raw body text blob");
	});

	it("renders facts as bullet points after narrative", () => {
		store.remember(
			sessionId,
			"discovery",
			"Branch cleanup analysis",
			"Raw body fallback",
			0.8,
			undefined,
			{
				narrative: "Audit identified several stale branches",
				facts: ["Branch A was already merged", "Branch B had no unique commits"],
			},
		);

		const pack = buildMemoryPack(store, "branch cleanup");

		expect(pack.pack_text).toContain("Audit identified several stale branches");
		expect(pack.pack_text).toContain("- Branch A was already merged");
		expect(pack.pack_text).toContain("- Branch B had no unique commits");
		expect(pack.pack_text).not.toContain("Raw body fallback");
	});

	it("renders facts without narrative when only facts exist", () => {
		store.remember(sessionId, "decision", "Migration rules", "Raw body fallback", 0.9, undefined, {
			facts: ["Always run migrations in a transaction", "Never drop columns in-place"],
		});

		const pack = buildMemoryPack(store, "migration rules");

		expect(pack.pack_text).toContain("- Always run migrations in a transaction");
		expect(pack.pack_text).toContain("- Never drop columns in-place");
		expect(pack.pack_text).not.toContain("Raw body fallback");
	});

	it("falls back to body_text when neither narrative nor facts exist", () => {
		store.remember(
			sessionId,
			"bugfix",
			"Fixed null pointer",
			"Checked for null before access",
			0.9,
		);

		const pack = buildMemoryPack(store, "null pointer");

		expect(pack.pack_text).toContain("Fixed null pointer - Checked for null before access");
	});

	it("falls back to body_text when narrative is an empty string", () => {
		store.remember(
			sessionId,
			"discovery",
			"Empty narrative test",
			"Body text should win here",
			0.8,
			undefined,
			{ narrative: "" },
		);

		const pack = buildMemoryPack(store, "empty narrative");

		expect(pack.pack_text).toContain("Empty narrative test - Body text should win here");

		const item = pack.items.find((i) => i.title === "Empty narrative test");
		expect(item).toBeDefined();
		expect(item?.body).toBe("Body text should win here");
	});

	it("prefers narrative for PackItem.body in response items", () => {
		store.remember(sessionId, "feature", "Add search feature", "Raw body text", 0.8, undefined, {
			narrative: "Implemented FTS5 full-text search with BM25 scoring",
		});

		const pack = buildMemoryPack(store, "search feature");

		expect(pack.items.length).toBeGreaterThanOrEqual(1);
		const item = pack.items.find((i) => i.title === "Add search feature");
		expect(item).toBeDefined();
		expect(item?.body).toBe("Implemented FTS5 full-text search with BM25 scoring");
	});

	it("uses body_text for PackItem.body when no narrative exists", () => {
		store.remember(sessionId, "feature", "Add login page", "Built the login UI", 0.7);

		const pack = buildMemoryPack(store, "login page");

		expect(pack.items.length).toBeGreaterThanOrEqual(1);
		const item = pack.items.find((i) => i.title === "Add login page");
		expect(item).toBeDefined();
		expect(item?.body).toBe("Built the login UI");
	});

	it("prefers narrative in pack trace preview", () => {
		store.remember(sessionId, "discovery", "Trace preview test", "Short raw body", 0.8, undefined, {
			narrative: "Detailed narrative for trace preview rendering",
		});

		const trace = buildMemoryPackTrace(store, "trace preview test");

		expect(trace.retrieval.candidates.length).toBeGreaterThan(0);
		const candidate = trace.retrieval.candidates[0];
		expect(candidate?.preview).toContain("Detailed narrative for trace preview");
		expect(candidate?.preview).not.toContain("Short raw body");
	});

	it("still trims correctly under token budget with longer structured content", () => {
		for (let i = 0; i < 8; i++) {
			store.remember(
				sessionId,
				"discovery",
				`Structured item ${i} about budgeting`,
				"Short fallback",
				0.5,
				undefined,
				{
					narrative: `This is a detailed narrative for item ${i} that provides context about the budgeting work and should consume tokens in the budget calculation`,
					facts: [
						`Fact A for item ${i}: something important`,
						`Fact B for item ${i}: another detail`,
					],
				},
			);
		}

		const smallPack = buildMemoryPack(store, "budgeting", 10, 40);
		const fullPack = buildMemoryPack(store, "budgeting", 10, null);

		expect(smallPack.items.length).toBeLessThanOrEqual(fullPack.items.length);
	});

	it("pack text and trace pack text agree on structured content", () => {
		store.remember(
			sessionId,
			"decision",
			"Use SQLite for structured test",
			"Fallback body",
			0.9,
			undefined,
			{
				narrative: "Chose SQLite for its zero-config embedded nature",
				facts: ["No server process needed", "Single-file database"],
			},
		);

		const pack = buildMemoryPack(store, "SQLite structured test", 10);
		const trace = buildMemoryPackTrace(store, "SQLite structured test", 10);

		expect(trace.output.pack_text).toBe(pack.pack_text);
	});
});
