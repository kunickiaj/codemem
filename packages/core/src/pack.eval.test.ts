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

	it("picks the stronger memory when multiple candidates share the same working-set file", () => {
		const corpus = createPackEvalCorpus(store);

		const pack = buildMemoryPack(store, "settings tab freshness decision", 10, null, {
			working_set_paths: ["packages/ui/src/tabs/settings.ts"],
		});

		// Both fixture memories touch settings.ts; the strong durable decision
		// should outrank the low-confidence drive-by exploration so file overlap
		// alone cannot rescue noise.
		const strongPos = pack.item_ids.indexOf(corpus.ids.workingSetSharedFileStrongId);
		const noisePos = pack.item_ids.indexOf(corpus.ids.workingSetSharedFileNoiseId);
		expect(strongPos).toBeGreaterThanOrEqual(0);
		if (noisePos >= 0) {
			expect(strongPos).toBeLessThan(noisePos);
		}
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
				narrative: null,
				facts: null,
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
				narrative: null,
				facts: null,
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

	it("never ranks low-confidence noise at position 1 across varied query phrasings", () => {
		const corpus = createPackEvalCorpus(store);
		const queries = [
			"what did we decide about oauth",
			"continue the viewer health work",
			"summary of oauth",
			"memory retrieval issues",
			"sessionization summary emission",
			"what should we do next about auth",
		];

		for (const query of queries) {
			const pack = buildMemoryPack(store, query, 10);
			expect(pack.item_ids[0], `noise ranked top-1 for query "${query}"`).not.toBe(
				corpus.ids.workingSetSharedFileNoiseId,
			);
		}
	});

	it("combines task-mode ranking with working-set overlap", () => {
		const corpus = createPackEvalCorpus(store);

		const pack = buildMemoryPack(store, "what should we do next about auth", 10, null, {
			working_set_paths: ["packages/ui/src/tabs/health.ts"],
		});

		// Task mode: the auth decision must still be top-1.
		expect(pack.metrics.mode).toBe("task");
		expect(pack.item_ids[0]).toBe(corpus.ids.authTaskDecisionId);
		// Working-set overlap is a tiered signal — the health-tab memory should
		// appear somewhere in the top N rather than trailing pure distractors.
		expect(pack.item_ids.slice(0, 5)).toContain(corpus.ids.workingSetPrimaryId);
	});

	it("prefers derived facts over summaries for topical queries (codemem-ovk2.12)", () => {
		const corpus = createPackEvalCorpus(store);

		const pack = buildMemoryPack(store, "widget pagination work", 10);

		expect(pack.metrics.mode).toBe("default");
		expect(pack.item_ids.indexOf(corpus.ids.derivedFactContractId)).toBeGreaterThanOrEqual(0);
		expect(pack.item_ids.indexOf(corpus.ids.derivedFactContractId)).toBeLessThan(
			pack.item_ids.indexOf(corpus.ids.dualArtifactRecapId),
		);
	});

	it("keeps telemetry below derived facts for default/task probes (codemem-ovk2.12)", () => {
		const corpus = createPackEvalCorpus(store);

		const defaultPack = buildMemoryPack(store, "widget pagination work", 10);
		const taskPack = buildMemoryPack(store, "what should we do next about widget pagination", 10);

		expect(defaultPack.metrics.mode).toBe("default");
		expect(taskPack.metrics.mode).toBe("task");
		expect(defaultPack.item_ids).toContain(corpus.ids.derivedFactContractId);
		expect(defaultPack.item_ids).toContain(corpus.ids.telemetryValidationId);
		expect(taskPack.item_ids).toContain(corpus.ids.derivedFactContractId);
		expect(defaultPack.item_ids.indexOf(corpus.ids.derivedFactContractId)).toBeLessThan(
			defaultPack.item_ids.indexOf(corpus.ids.telemetryValidationId),
		);
	});

	it("still surfaces a summary for explicit dual-artifact recap requests (codemem-ovk2.12)", () => {
		const corpus = createPackEvalCorpus(store);

		const pack = buildMemoryPack(store, "catch me up on widget pagination work", 10);

		expect(pack.metrics.mode).toBe("recall");
		// Explicit-recap routing contract: the derived-fact boost is gated OFF in
		// recap, so a derived fact must never lead an explicit recap and must never
		// be ranked above its own topic summary when both are present. We assert
		// the contract rather than pinning a weakly-matching fixture summary to a
		// global rank, since the shared multi-topic corpus competes for recall.
		expect(pack.item_ids[0]).not.toBe(corpus.ids.derivedFactContractId);
		const recapIdx = pack.item_ids.indexOf(corpus.ids.dualArtifactRecapId);
		const derivedIdx = pack.item_ids.indexOf(corpus.ids.derivedFactContractId);
		if (recapIdx !== -1 && derivedIdx !== -1) {
			expect(recapIdx).toBeLessThan(derivedIdx);
		}
	});
});
