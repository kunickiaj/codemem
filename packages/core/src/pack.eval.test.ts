import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { buildMemoryPack } from "./pack.js";
import { createPackEvalCorpus } from "./pack-eval-fixtures.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";
import type { MemoryResult } from "./types.js";

describe("buildMemoryPack usefulness evals", () => {
	let tmpDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-pack-eval-"));
		const dbPath = join(tmpDir, "test.db");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("surfaces detailed recall anchors for oauth recap queries", () => {
		const corpus = createPackEvalCorpus(store);

		const pack = buildMemoryPack(store, "what did we decide last time about oauth", 10);

		expect(pack.metrics.mode).toBe("recall");
		expect(pack.item_ids.slice(0, 3)).toContain(corpus.ids.oauthDecisionId);
		expect(pack.item_ids).not.toContain(corpus.ids.sessionizationSummaryId);
		expect(pack.pack_text).toContain("OAuth callback fix");
		expect(pack.pack_text).toContain("callback verification");
	});

	it("prioritizes auth follow-up work for task-oriented auth queries", () => {
		const corpus = createPackEvalCorpus(store);

		const pack = buildMemoryPack(store, "what should we do next about auth", 10);

		expect(pack.metrics.mode).toBe("task");
		expect(pack.item_ids[0]).toBe(corpus.ids.authTaskDecisionId);
		expect(pack.item_ids.slice(0, 5)).toContain(corpus.ids.viewerTaskFeatureId);
		expect(pack.pack_text.toLowerCase()).toContain("auth");
	});

	it("keeps continuation queries focused on the current viewer health track", () => {
		const corpus = createPackEvalCorpus(store);

		const pack = buildMemoryPack(store, "continue the viewer health work", 10);

		expect(pack.metrics.mode).toBe("task");
		expect(pack.item_ids.slice(0, 3)).toContain(corpus.ids.viewerHealthFeatureId);
		expect(pack.pack_text).toContain("Viewer health improvements");
		expect(pack.pack_text).toContain("freshness and backlog diagnostics");
	});

	it("demotes recap-like rows for default retrieval queries that do not ask for a summary", () => {
		const corpus = createPackEvalCorpus(store);

		const pack = buildMemoryPack(store, "memory retrieval issues", 10);

		expect(pack.metrics.mode).toBe("default");
		expect(pack.item_ids[0]).toBe(corpus.ids.memoryIssuesDurableId);
		expect(pack.item_ids.indexOf(corpus.ids.memoryIssuesDurableId)).toBeLessThan(
			pack.item_ids.indexOf(corpus.ids.memoryIssuesRecapId),
		);
	});

	it("does not treat topic queries mentioning summary as explicit recap requests", () => {
		const corpus = createPackEvalCorpus(store);

		const pack = buildMemoryPack(store, "sessionization summary emission", 10);

		expect(pack.metrics.mode).toBe("recall");
		expect(pack.item_ids[0]).toBe(corpus.ids.sessionizationDurableId);
		expect(pack.item_ids.indexOf(corpus.ids.sessionizationDurableId)).toBeLessThan(
			pack.item_ids.indexOf(corpus.ids.sessionizationSummaryId),
		);
	});

	it("treats noun-form summary requests as explicit recap requests", () => {
		const corpus = createPackEvalCorpus(store);

		const pack = buildMemoryPack(store, "summary of oauth", 10);

		expect(pack.metrics.mode).toBe("recall");
		expect(pack.item_ids.slice(0, 3)).toContain(corpus.ids.oauthDecisionId);
		expect(pack.pack_text.toLowerCase()).toContain("summary");
	});

	it("boosts working-set overlaps ahead of distractors when semantic candidates tie", () => {
		const corpus = createPackEvalCorpus(store);
		const semanticResults: MemoryResult[] = [
			{
				id: corpus.ids.workingSetPrimaryId,
				kind: "feature",
				title: "Health tab file overlap",
				body_text: "Work tied directly to the health tab implementation",
				confidence: 0.8,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				tags_text: "",
				score: 0.24,
				session_id: corpus.currentSessionId,
				metadata: { files_modified: ["packages/ui/src/tabs/health.ts"] },
			},
			{
				id: corpus.ids.workingSetDistractorId,
				kind: "feature",
				title: "Other tab work",
				body_text: "Unrelated work in another viewer tab",
				confidence: 0.8,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				tags_text: "",
				score: 0.24,
				session_id: corpus.currentSessionId,
				metadata: { files_modified: ["packages/ui/src/tabs/feed.ts"] },
			},
		];

		const pack = buildMemoryPack(
			store,
			"zzz_nomatch_zzz",
			10,
			null,
			{ working_set_paths: ["packages/ui/src/tabs/health.ts"] },
			semanticResults,
		);

		expect(pack.item_ids[0]).toBe(corpus.ids.workingSetPrimaryId);
		expect(pack.item_ids.indexOf(corpus.ids.workingSetPrimaryId)).toBeLessThan(
			pack.item_ids.indexOf(corpus.ids.workingSetDistractorId),
		);
	});
});
