import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import {
	chunkDistillContextDocuments,
	clusterDistillFeatures,
	createContextFactDetector,
	loadDistillVectorFeatures,
	markDistillClustersDocumented,
	projectContextFactFeatures,
	scoreDistillClusters,
	selectDistillCorpus,
} from "./distill.js";
import { resolveEmbeddingModel, serializeFloat32 } from "./embeddings.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

describe("distill", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;
	let prevCodememConfig: string | undefined;
	let prevEmbeddingDisabled: string | undefined;

	beforeEach(() => {
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		prevEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-distill-test-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		dbPath = join(tmpDir, "test.sqlite");

		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store?.close();
		if (prevCodememConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		if (prevEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
		else process.env.CODEMEM_EMBEDDING_DISABLED = prevEmbeddingDisabled;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function insertSession(project: string): number {
		const now = "2026-06-01T00:00:00.000Z";
		const info = store.db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, user, tool_version)
				 VALUES (?, ?, ?, 'test-user', 'test')`,
			)
			.run(now, `/tmp/${project}`, project);
		return Number(info.lastInsertRowid);
	}

	function rememberAt(input: {
		sessionId: number;
		kind: string;
		title: string;
		bodyText?: string;
		confidence?: number;
		createdAt: string;
		metadata?: Record<string, unknown>;
	}): number {
		const id = store.remember(
			input.sessionId,
			input.kind,
			input.title,
			input.bodyText ?? `${input.title} body`,
			input.confidence ?? 0.8,
			undefined,
			input.metadata,
		);
		store.db
			.prepare("UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?")
			.run(input.createdAt, input.createdAt, id);
		return id;
	}

	it("selects the default context-fact corpus deterministically across pages", () => {
		const alpha = insertSession("alpha-project");
		const beta = insertSession("beta-project");

		const discoveryId = rememberAt({
			sessionId: alpha,
			kind: "discovery",
			title: "Alpha repeated lesson",
			createdAt: "2026-06-01T00:00:01.000Z",
		});
		rememberAt({
			sessionId: alpha,
			kind: "feature",
			title: "Feature should not be selected by default",
			createdAt: "2026-06-01T00:00:02.000Z",
		});
		const decisionId = rememberAt({
			sessionId: beta,
			kind: "decision",
			title: "Beta operational rule",
			createdAt: "2026-06-01T00:00:03.000Z",
		});

		const corpus = selectDistillCorpus(store, { batchSize: 1 });

		expect(corpus.map((item) => item.id)).toEqual([decisionId, discoveryId]);
		expect(corpus.map((item) => item.project)).toEqual(["beta-project", "alpha-project"]);
	});

	it("normalizes explicit kinds and respects limits", () => {
		const sessionId = insertSession("codemem");
		const bugfixId = rememberAt({
			sessionId,
			kind: "bugfix",
			title: "Guardrail candidate",
			createdAt: "2026-06-01T00:00:02.000Z",
		});
		rememberAt({
			sessionId,
			kind: "decision",
			title: "Older operational rule",
			createdAt: "2026-06-01T00:00:01.000Z",
		});

		const corpus = selectDistillCorpus(store, {
			kinds: [" Bugfix ", "bugfix", "decision"],
			limit: 1,
		});

		expect(corpus.map((item) => item.id)).toEqual([bugfixId]);
	});

	it("projects context-fact features from structured memory fields", () => {
		const sessionId = insertSession("codemem");
		const id = rememberAt({
			sessionId,
			kind: "discovery",
			title: "Release preflight requires main",
			createdAt: "2026-06-01T00:00:01.000Z",
			metadata: {
				narrative: "Release preflight rejects detached HEADs.",
				concepts: ["release", " preflight "],
			},
		});

		const item = store.get(id);
		if (!item) throw new Error("expected seeded memory");

		expect(projectContextFactFeatures([item])).toEqual([
			{
				memory_id: id,
				title: "Release preflight requires main",
				text: "Release preflight requires main\n\nRelease preflight rejects detached HEADs.",
				concepts: ["release", "preflight"],
				project: "codemem",
				session_id: sessionId,
				created_at: "2026-06-01T00:00:01.000Z",
				confidence: 0.8,
			},
		]);
	});

	it("exposes a context-fact detector seam for the v2 skill miner", () => {
		const sessionId = insertSession("codemem");
		const id = rememberAt({
			sessionId,
			kind: "decision",
			title: "Keep distill writes human-gated",
			createdAt: "2026-06-01T00:00:01.000Z",
		});

		const detector = createContextFactDetector();
		const selected = detector.select(store);

		expect(detector.artifactKind).toBe("context_fact");
		expect(selected.map((item) => item.id)).toEqual([id]);
		expect(detector.project(selected)).toHaveLength(1);
	});

	it("clusters semantically similar vector features", () => {
		const clusters = clusterDistillFeatures(
			[
				{
					memory_id: 1,
					title: "release preflight requires main",
					text: "release preflight requires main",
					concepts: ["release"],
					project: "codemem",
					vector: new Float32Array([1, 0]),
				},
				{
					memory_id: 2,
					title: "tag preflight must run on main branch",
					text: "tag preflight must run on main branch",
					concepts: ["release"],
					project: "codemem",
					vector: new Float32Array([0.98, 0.2]),
				},
				{
					memory_id: 3,
					title: "viewer bundle changed",
					text: "viewer bundle changed",
					concepts: ["viewer"],
					project: "codemem",
					vector: new Float32Array([0, 1]),
				},
			],
			{ semanticThreshold: 0.95 },
		);

		expect(clusters).toEqual([
			{
				representative_id: 1,
				member_ids: [1, 2],
				overlap_concepts: ["release"],
				overlap_words: ["main", "preflight"],
				signal: "semantic",
			},
		]);
	});

	it("falls back to concept and title overlap when vectors are absent", () => {
		const clusters = clusterDistillFeatures(
			[
				{
					memory_id: 1,
					title: "release tag preflight clean main branch",
					text: "release tag preflight clean main branch",
					concepts: ["release", "preflight"],
					project: "codemem",
				},
				{
					memory_id: 2,
					title: "preflight requires clean main branch before tagging",
					text: "preflight requires clean main branch before tagging",
					concepts: ["release", "preflight"],
					project: "codemem",
				},
				{
					memory_id: 3,
					title: "sync peer bootstrap",
					text: "sync peer bootstrap",
					concepts: ["sync"],
					project: "codemem",
				},
			],
			{ minConceptOverlap: 2, minTitleWordOverlap: 4 },
		);

		expect(clusters).toEqual([
			{
				representative_id: 1,
				member_ids: [1, 2],
				overlap_concepts: ["preflight", "release"],
				overlap_words: ["branch", "clean", "main", "preflight"],
				signal: "concept",
			},
		]);
	});

	it("preserves the strongest signal across chained unions", () => {
		// Concept and title edges can chain among un-embedded members; the
		// cluster reports the strongest signal seen on any edge.
		const clusters = clusterDistillFeatures(
			[
				{
					memory_id: 1,
					title: "release preflight guard rules",
					text: "release preflight guard rules",
					concepts: ["release", "preflight"],
					project: "codemem",
				},
				{
					memory_id: 2,
					title: "release preflight tag checks",
					text: "release preflight tag checks",
					concepts: ["release", "preflight"],
					project: "codemem",
				},
				{
					// Links to member 2 via shared title words only (single shared
					// concept stays below minConceptOverlap).
					memory_id: 3,
					title: "release preflight tag sync",
					text: "release preflight tag sync",
					concepts: ["release"],
					project: "codemem",
				},
			],
			{ minConceptOverlap: 2, minTitleWordOverlap: 3 },
		);

		expect(clusters[0]?.member_ids).toEqual([1, 2, 3]);
		expect(clusters[0]?.signal).toBe("concept");
	});

	it("does not chain embedded memories through shared generic concepts", () => {
		// Two memories that are NOT semantically similar but share generic concept
		// tags must stay separate when both are embedded (regression for the
		// real-DB mega-cluster).
		const clusters = clusterDistillFeatures(
			[
				{
					memory_id: 1,
					title: "kube storage constraints",
					text: "kube storage constraints",
					concepts: ["decision", "security", "bugfix"],
					project: "codemem",
					vector: new Float32Array([1, 0]),
				},
				{
					memory_id: 2,
					title: "secret cli surface",
					text: "secret cli surface",
					concepts: ["decision", "security", "discovery"],
					project: "codemem",
					vector: new Float32Array([0, 1]),
				},
			],
			{ semanticThreshold: 0.82, minConceptOverlap: 2 },
		);

		expect(clusters).toEqual([]);
	});

	it("does not let an unembedded memory bridge embedded clusters via concepts", () => {
		// In a partially indexed store, an unembedded memory sharing generic
		// concepts with two dissimilar embedded memories must not union with
		// either — that would transitively merge clusters whose embedded-vs-
		// embedded comparisons already failed.
		const clusters = clusterDistillFeatures(
			[
				{
					memory_id: 1,
					title: "kube storage constraints",
					text: "kube storage constraints",
					concepts: ["decision", "security"],
					project: "codemem",
					vector: new Float32Array([1, 0]),
				},
				{
					memory_id: 2,
					title: "secret cli surface",
					text: "secret cli surface",
					concepts: ["decision", "security"],
					project: "codemem",
					vector: new Float32Array([0, 1]),
				},
				{
					memory_id: 3,
					title: "unindexed generic memory",
					text: "unindexed generic memory",
					concepts: ["decision", "security"],
					project: "codemem",
				},
			],
			{ semanticThreshold: 0.82, minConceptOverlap: 2 },
		);

		expect(clusters).toEqual([]);
	});

	it("does not cluster vectors with mismatched dimensions", () => {
		const clusters = clusterDistillFeatures(
			[
				{
					memory_id: 1,
					title: "short vector",
					text: "short vector",
					concepts: [],
					project: "codemem",
					vector: new Float32Array([1]),
				},
				{
					memory_id: 2,
					title: "long vector",
					text: "long vector",
					concepts: [],
					project: "codemem",
					vector: new Float32Array([1, 0]),
				},
			],
			{ semanticThreshold: 0.1, minTitleWordOverlap: 3 },
		);

		expect(clusters).toEqual([]);
	});

	it("does not use body words for title fallback clustering", () => {
		const sessionId = insertSession("codemem");
		const firstId = rememberAt({
			sessionId,
			kind: "discovery",
			title: "Alpha only",
			bodyText: "shared fallback body words",
			createdAt: "2026-06-01T00:00:01.000Z",
		});
		const secondId = rememberAt({
			sessionId,
			kind: "decision",
			title: "Beta only",
			bodyText: "shared fallback body words",
			createdAt: "2026-06-01T00:00:02.000Z",
		});
		const items = [store.get(firstId), store.get(secondId)];
		if (!items[0] || !items[1]) throw new Error("expected seeded memories");

		const clusters = clusterDistillFeatures(projectContextFactFeatures(items), {
			minConceptOverlap: 99,
			minTitleWordOverlap: 3,
		});

		expect(clusters).toEqual([]);
	});

	it("loads vector features as text/concept features when vector storage is unavailable", () => {
		const sessionId = insertSession("codemem");
		const id = rememberAt({
			sessionId,
			kind: "decision",
			title: "Keep distill deterministic",
			createdAt: "2026-06-01T00:00:01.000Z",
			metadata: { concepts: ["distill"] },
		});
		const item = store.get(id);
		if (!item) throw new Error("expected seeded memory");

		expect(loadDistillVectorFeatures(store, [item])).toEqual([
			{
				memory_id: id,
				title: "Keep distill deterministic",
				text: "Keep distill deterministic\n\nKeep distill deterministic body",
				concepts: ["distill"],
				project: "codemem",
				session_id: sessionId,
				created_at: "2026-06-01T00:00:01.000Z",
				confidence: 0.8,
			},
		]);
	});

	it("derives feature project from the session after a project move", () => {
		const sessionId = insertSession("old-project");
		const id = rememberAt({
			sessionId,
			kind: "decision",
			title: "Memory reassigned to a new project",
			createdAt: "2026-06-01T00:00:01.000Z",
		});
		store.moveMemoryProject(id, "new-project");
		const item = store.get(id);
		if (!item) throw new Error("expected seeded memory");

		const [feature] = loadDistillVectorFeatures(store, [item]);

		expect(feature?.project).toBe("new-project");
	});

	it("keeps the denormalized memory project when the session has none", () => {
		const sessionId = insertSession("placeholder-project");
		const id = rememberAt({
			sessionId,
			kind: "decision",
			title: "Replicated memory without a session project",
			createdAt: "2026-06-01T00:00:01.000Z",
		});
		// Simulate a replicated row backfilled only on memory_items.project.
		store.db.prepare("UPDATE sessions SET project = NULL WHERE id = ?").run(sessionId);
		store.db.prepare("UPDATE memory_items SET project = ? WHERE id = ?").run("denormalized", id);
		const item = store.get(id);
		if (!item) throw new Error("expected seeded memory");

		const [feature] = loadDistillVectorFeatures(store, [item]);

		expect(feature?.project).toBe("denormalized");
	});

	it("ranks cross-session weekly recurrence above a larger same-session burst", () => {
		const features = [
			...Array.from({ length: 8 }, (_, index) => ({
				memory_id: index + 1,
				title: `Burst ${index}`,
				text: `Burst ${index}`,
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-22T00:00:00.000Z",
				confidence: 0.9,
			})),
			...Array.from({ length: 4 }, (_, index) => ({
				memory_id: index + 101,
				title: `Spread ${index}`,
				text: `Spread ${index}`,
				concepts: [],
				project: "codemem",
				session_id: index + 10,
				created_at: `2026-06-${String(1 + index * 7).padStart(2, "0")}T00:00:00.000Z`,
				confidence: 0.9,
			})),
		];
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1, 2, 3, 4, 5, 6, 7, 8],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
				{
					representative_id: 101,
					member_ids: [101, 102, 103, 104],
					overlap_concepts: [],
					overlap_words: [],
					signal: "semantic",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		expect(scored.map((cluster) => cluster.representative_id)).toEqual([101, 1]);
		expect(scored[0]?.scores.member_count).toBe(4);
		expect(scored[0]?.scores.session_count).toBe(4);
		expect(scored[0]?.scores.time_span_days).toBe(21);
		expect(scored[0]?.scores.mean_confidence).toBeCloseTo(0.9);
		expect(scored[0]?.scores.combined_score).toBeGreaterThan(scored[1]?.scores.combined_score ?? 0);
	});

	it("uses recency as a light weighting rather than overpowering spread", () => {
		const features = [
			{
				memory_id: 1,
				title: "recent burst one",
				text: "recent burst one",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-28T00:00:00.000Z",
				confidence: 0.9,
			},
			{
				memory_id: 2,
				title: "recent burst two",
				text: "recent burst two",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-28T00:00:00.000Z",
				confidence: 0.9,
			},
			{
				memory_id: 3,
				title: "old burst one",
				text: "old burst one",
				concepts: [],
				project: "codemem",
				session_id: 2,
				created_at: "2026-03-01T00:00:00.000Z",
				confidence: 0.9,
			},
			{
				memory_id: 4,
				title: "old burst two",
				text: "old burst two",
				concepts: [],
				project: "codemem",
				session_id: 2,
				created_at: "2026-03-01T00:00:00.000Z",
				confidence: 0.9,
			},
			...Array.from({ length: 4 }, (_, index) => ({
				memory_id: index + 10,
				title: `older spread ${index}`,
				text: `older spread ${index}`,
				concepts: [],
				project: "codemem",
				session_id: index + 10,
				created_at: `2026-03-${String(1 + index * 7).padStart(2, "0")}T00:00:00.000Z`,
				confidence: 0.9,
			})),
		];
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1, 2],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
				{
					representative_id: 3,
					member_ids: [3, 4],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
				{
					representative_id: 10,
					member_ids: [10, 11, 12, 13],
					overlap_concepts: [],
					overlap_words: [],
					signal: "semantic",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		const recentBurst = scored.find((cluster) => cluster.representative_id === 1);
		const oldBurst = scored.find((cluster) => cluster.representative_id === 3);
		const olderSpread = scored.find((cluster) => cluster.representative_id === 10);
		expect(recentBurst?.scores.combined_score).toBeGreaterThan(
			oldBurst?.scores.combined_score ?? 0,
		);
		expect(olderSpread?.scores.combined_score).toBeGreaterThan(
			recentBurst?.scores.combined_score ?? 0,
		);
	});

	it("scores singleton and missing timestamp clusters deterministically", () => {
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 2,
					member_ids: [2],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
				{
					representative_id: 1,
					member_ids: [1],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
			],
			[
				{
					memory_id: 1,
					title: "missing one",
					text: "missing one",
					concepts: [],
					project: "codemem",
					session_id: 1,
					created_at: "not-a-date",
					confidence: 0.7,
				},
				{
					memory_id: 2,
					title: "missing two",
					text: "missing two",
					concepts: [],
					project: "codemem",
					session_id: 2,
					created_at: null,
					confidence: 0.7,
				},
			],
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		expect(scored.map((cluster) => cluster.representative_id)).toEqual([1, 2]);
		expect(scored[0]?.scores.member_count).toBe(1);
		expect(scored[0]?.scores.time_span_days).toBe(0);
		expect(scored[0]?.scores.recency_score).toBe(0);
		expect(Number.isFinite(scored[0]?.scores.combined_score)).toBe(true);
	});

	it("treats absent confidence as neutral instead of zeroing promotability", () => {
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1, 2],
					overlap_concepts: [],
					overlap_words: [],
					signal: "semantic",
				},
			],
			[
				{
					memory_id: 1,
					title: "missing confidence one",
					text: "missing confidence one",
					concepts: [],
					project: "codemem",
					session_id: 1,
					created_at: "2026-06-01T00:00:00.000Z",
				},
				{
					memory_id: 2,
					title: "missing confidence two",
					text: "missing confidence two",
					concepts: [],
					project: "codemem",
					session_id: 2,
					created_at: "2026-06-08T00:00:00.000Z",
				},
			],
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		expect(scored[0]?.scores.mean_confidence).toBe(1);
		expect(scored[0]?.scores.combined_score).toBeGreaterThan(0);
	});

	it("uses one reference clock per batch for deterministic tie-breaking", () => {
		const features = [
			{
				memory_id: 1,
				title: "alpha",
				text: "alpha",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
			},
			{
				memory_id: 2,
				title: "beta",
				text: "beta",
				concepts: [],
				project: "codemem",
				session_id: 2,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
			},
		];
		// No referenceNow: scoreDistillClusters must capture a single clock so the
		// two equal clusters tie and fall through to the representative-id ordering.
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 2,
					member_ids: [2],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
				{
					representative_id: 1,
					member_ids: [1],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
			],
			features,
		);

		expect(scored[0]?.scores.combined_score).toBe(scored[1]?.scores.combined_score);
		expect(scored.map((cluster) => cluster.representative_id)).toEqual([1, 2]);
	});

	it("penalizes low mean confidence even with higher recurrence", () => {
		const lowConfidenceFeatures = Array.from({ length: 6 }, (_, index) => ({
			memory_id: index + 1,
			title: `low confidence ${index}`,
			text: `low confidence ${index}`,
			concepts: [],
			project: "codemem",
			session_id: index + 1,
			created_at: `2026-06-${String(1 + index).padStart(2, "0")}T00:00:00.000Z`,
			confidence: 0.2,
		}));
		const highConfidenceFeatures = Array.from({ length: 3 }, (_, index) => ({
			memory_id: index + 101,
			title: `high confidence ${index}`,
			text: `high confidence ${index}`,
			concepts: [],
			project: "codemem",
			session_id: index + 101,
			created_at: `2026-06-${String(1 + index * 3).padStart(2, "0")}T00:00:00.000Z`,
			confidence: 0.9,
		}));

		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1, 2, 3, 4, 5, 6],
					overlap_concepts: [],
					overlap_words: [],
					signal: "semantic",
				},
				{
					representative_id: 101,
					member_ids: [101, 102, 103],
					overlap_concepts: [],
					overlap_words: [],
					signal: "semantic",
				},
			],
			[...lowConfidenceFeatures, ...highConfidenceFeatures],
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		expect(scored.map((cluster) => cluster.representative_id)).toEqual([101, 1]);
		expect(scored[0]?.scores.mean_confidence).toBeCloseTo(0.9);
		expect(scored[1]?.scores.mean_confidence).toBeCloseTo(0.2);
	});

	it("chunks context documents before matching clusters", () => {
		const chunks = chunkDistillContextDocuments(
			[
				{
					path: "AGENTS.md",
					text: "Viewer server needs built static assets.\n\nRelease tag preflight must run on main with a clean tree.",
				},
				{ path: "empty.md", text: "   " },
			],
			{ maxChunkChars: 60 },
		);

		expect(chunks.map((chunk) => chunk.text)).toEqual([
			"Viewer server needs built static assets.",
			"Release tag preflight must run on main with a clean tree.",
		]);
		expect(chunks.map((chunk) => [chunk.document_path, chunk.chunk_index])).toEqual([
			["AGENTS.md", 0],
			["AGENTS.md", 1],
		]);
		expect(chunks.every((chunk) => chunk.text_hash.length > 0)).toBe(true);
	});

	it("clamps non-positive or fractional chunk sizes instead of hanging", () => {
		const text = "Paragraph one is here.\n\nParagraph two is here.";
		for (const maxChunkChars of [0, -50, 0.5]) {
			const chunks = chunkDistillContextDocuments([{ path: "AGENTS.md", text }], {
				maxChunkChars,
			});
			expect(chunks).toHaveLength(1);
			expect(chunks[0]?.text).toBe(text);
		}
	});

	it("does not suppress a cluster when only one member is documented", () => {
		const features = [
			{
				memory_id: 1,
				title: "Covered member",
				text: "alpha rule one covered fully here",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
			},
			{
				memory_id: 2,
				title: "Net-new member",
				text: "beta brand new undocumented distinct rule words",
				concepts: [],
				project: "codemem",
				session_id: 2,
				created_at: "2026-06-02T00:00:00.000Z",
				confidence: 0.9,
			},
		];
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1, 2],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		// Only member 1 is documented verbatim; member 2 is net-new, so the cluster
		// must stay eligible.
		const documented = markDistillClustersDocumented(
			scored,
			features,
			chunkDistillContextDocuments([
				{ path: "AGENTS.md", text: "alpha rule one covered fully here" },
			]),
		);

		expect(documented[0]).toMatchObject({
			already_documented: false,
			documentation_match: null,
		});
	});

	it("does not treat a negated doc chunk as documenting the opposite rule", () => {
		const features = [
			{
				memory_id: 1,
				title: "Release tags require clean tree",
				text: "release tags require clean tree before tagging",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
			},
			{
				memory_id: 2,
				title: "Release tags require clean tree",
				text: "release tags require clean tree before pushing",
				concepts: [],
				project: "codemem",
				session_id: 2,
				created_at: "2026-06-02T00:00:00.000Z",
				confidence: 0.9,
			},
		];
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1, 2],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		// The doc states the OPPOSITE rule; negators are stripped from the
		// significant-word overlap, so without a polarity check this would be a
		// full lexical match that wrongly suppresses the contradicting cluster.
		const documented = markDistillClustersDocumented(
			scored,
			features,
			chunkDistillContextDocuments([
				{
					path: "AGENTS.md",
					text: "release tags do not require clean tree before tagging or pushing",
				},
			]),
		);

		expect(documented[0]).toMatchObject({
			already_documented: false,
			documentation_match: null,
		});
	});

	it("skips project-scoped context for user-scoped clusters", () => {
		const features = [
			{
				memory_id: 1,
				title: "Shared lesson",
				text: "release tag preflight clean main branch",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
			},
		];
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);
		const chunks = chunkDistillContextDocuments([
			{ path: "AGENTS.md", text: "release tag preflight clean main branch", scope: "project" },
		]);

		// User-scoped cluster ignores the project AGENTS.md chunk.
		const documentedUser = markDistillClustersDocumented(
			scored,
			features,
			chunks,
			{},
			new Map([[1, "user"]]),
		);
		expect(documentedUser[0]).toMatchObject({
			already_documented: false,
			documentation_match: null,
		});

		// Project-scoped cluster still dedupes against the same chunk.
		const documentedProject = markDistillClustersDocumented(
			scored,
			features,
			chunks,
			{},
			new Map([[1, "project"]]),
		);
		expect(documentedProject[0]).toMatchObject({
			already_documented: true,
			documentation_match: { signal: "exact" },
		});
	});

	it("does not treat a title-only context chunk as an exact match", () => {
		const features = [
			{
				memory_id: 1,
				title: "Release",
				text: "Release\n\nRelease preflight must run on main with a clean tree.",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
			},
			{
				memory_id: 2,
				title: "Release",
				text: "Release\n\nRelease tags require an up-to-date main branch.",
				concepts: [],
				project: "codemem",
				session_id: 2,
				created_at: "2026-06-02T00:00:00.000Z",
				confidence: 0.9,
			},
		];
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1, 2],
					overlap_concepts: [],
					overlap_words: ["release"],
					signal: "title",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		const documented = markDistillClustersDocumented(
			scored,
			features,
			chunkDistillContextDocuments([{ path: "AGENTS.md", text: "Release" }]),
		);

		expect(documented[0]).toMatchObject({
			already_documented: false,
			documentation_match: null,
		});
	});

	it("ignores vector similarity when deduping against context", () => {
		const features = [
			{
				memory_id: 1,
				title: "Distinct narrative",
				text: "Distinct narrative wording about widgets.",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
				vector: new Float32Array([1, 0]),
			},
		];
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1],
					overlap_concepts: [],
					overlap_words: [],
					signal: "semantic",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		// Vector is identical to the chunk, but dedupe is exact/lexical only and the
		// distilled text shares no words with it, so the cluster stays eligible.
		const documented = markDistillClustersDocumented(scored, features, [
			{
				document_path: "AGENTS.md",
				chunk_index: 0,
				text: "Completely unrelated documentation heading.",
				text_hash: "unrelated",
				vector: new Float32Array([1, 0]),
			},
		]);

		expect(documented[0]).toMatchObject({
			already_documented: false,
			documentation_match: null,
		});
	});

	it("keeps clusters eligible when a vector matches but text does not", () => {
		const features = [
			{
				memory_id: 1,
				title: "Alpha lesson",
				text: "Alpha lesson",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
				vector: new Float32Array([1, 0]),
			},
			{
				memory_id: 2,
				title: "Beta lesson",
				text: "Beta lesson",
				concepts: [],
				project: "codemem",
				session_id: 2,
				created_at: "2026-06-02T00:00:00.000Z",
				confidence: 0.9,
			},
		];
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1, 2],
					overlap_concepts: [],
					overlap_words: [],
					signal: "semantic",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		// A vector identical to the chunk must not suppress the cluster because
		// dedupe ignores vectors entirely (exact/lexical only).
		const documented = markDistillClustersDocumented(scored, features, [
			{
				document_path: "AGENTS.md",
				chunk_index: 0,
				text: "completely different wording",
				text_hash: "unrelated",
				vector: new Float32Array([1, 0]),
			},
		]);

		expect(documented[0]).toMatchObject({
			already_documented: false,
			documentation_match: null,
		});
	});

	it("falls back to exact or lexical matching when vectors are absent", () => {
		const features = [
			{
				memory_id: 1,
				title: "release tag preflight clean main branch",
				text: "release tag preflight clean main branch",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
			},
			{
				memory_id: 2,
				title: "unrelated sync bootstrap",
				text: "unrelated sync bootstrap",
				concepts: [],
				project: "codemem",
				session_id: 2,
				created_at: "2026-06-02T00:00:00.000Z",
				confidence: 0.9,
			},
		];
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
				{
					representative_id: 2,
					member_ids: [2],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		const documented = markDistillClustersDocumented(
			scored,
			features,
			chunkDistillContextDocuments([
				{ path: "AGENTS.md", text: "release tag preflight clean main branch" },
				{ path: "docs.md", text: "weak overlap branch only" },
			]),
		);

		expect(documented.find((cluster) => cluster.representative_id === 1)).toMatchObject({
			already_documented: true,
			documentation_match: { signal: "exact" },
		});
		expect(documented.find((cluster) => cluster.representative_id === 2)).toMatchObject({
			already_documented: false,
			documentation_match: null,
		});
	});

	it("does not mark broad clusters documented from short lexical headings", () => {
		const features = [
			{
				memory_id: 1,
				title: "release tag preflight clean main branch",
				text: "release tag preflight clean main branch",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
			},
			{
				memory_id: 2,
				title: "release tagging requires preflight clean branch",
				text: "release tagging requires preflight clean branch",
				concepts: [],
				project: "codemem",
				session_id: 2,
				created_at: "2026-06-02T00:00:00.000Z",
				confidence: 0.9,
			},
		];
		const scored = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1, 2],
					overlap_concepts: [],
					overlap_words: ["branch", "clean", "preflight", "release"],
					signal: "title",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);

		const documented = markDistillClustersDocumented(
			scored,
			features,
			chunkDistillContextDocuments([{ path: "AGENTS.md", text: "## Release" }]),
		);

		expect(documented[0]).toMatchObject({
			already_documented: false,
			documentation_match: null,
		});
	});

	it("selects documentation matches deterministically across reordered chunks", () => {
		const features = [
			{
				memory_id: 1,
				title: "release tag preflight clean main branch",
				text: "release tag preflight clean main branch",
				concepts: [],
				project: "codemem",
				session_id: 1,
				created_at: "2026-06-01T00:00:00.000Z",
				confidence: 0.9,
			},
		];
		const [scored] = scoreDistillClusters(
			[
				{
					representative_id: 1,
					member_ids: [1],
					overlap_concepts: [],
					overlap_words: [],
					signal: "title",
				},
			],
			features,
			{ referenceNow: "2026-06-28T00:00:00.000Z" },
		);
		if (!scored) throw new Error("expected scored cluster");
		const chunks = chunkDistillContextDocuments([
			{ path: "Z.md", text: "release tag preflight clean main branch" },
			{ path: "AGENTS.md", text: "release tag preflight clean main branch" },
		]);

		const first = markDistillClustersDocumented([scored], features, chunks)[0];
		const second = markDistillClustersDocumented([scored], features, chunks.toReversed())[0];

		expect(first?.documentation_match).toMatchObject({ document_path: "AGENTS.md" });
		expect(second?.documentation_match).toEqual(first?.documentation_match);
	});

	it("loads only active-model vectors and averages current-model chunks", () => {
		const sessionId = insertSession("codemem");
		const id = rememberAt({
			sessionId,
			kind: "decision",
			title: "Current model vectors only",
			createdAt: "2026-06-01T00:00:01.000Z",
			metadata: { concepts: ["vectors"] },
		});
		const item = store.get(id);
		if (!item) throw new Error("expected seeded memory");

		store.db.exec("DROP TABLE IF EXISTS memory_vectors");
		store.db.exec(
			`CREATE TABLE memory_vectors(
				embedding BLOB,
				memory_id INTEGER,
				chunk_index INTEGER,
				content_hash TEXT,
				model TEXT
			)`,
		);
		const currentModel = resolveEmbeddingModel();
		const insertVector = store.db.prepare(
			"INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model) VALUES (?, ?, ?, ?, ?)",
		);
		insertVector.run(serializeFloat32(new Float32Array([100, 100])), id, 0, "old", "old-model");
		insertVector.run(serializeFloat32(new Float32Array([1, 0])), id, 0, "current-a", currentModel);
		insertVector.run(serializeFloat32(new Float32Array([0, 1])), id, 1, "current-b", currentModel);

		const [feature] = loadDistillVectorFeatures(store, [item]);

		expect(feature?.vector).toEqual(new Float32Array([0.5, 0.5]));
	});

	it("chunks vector lookup for large distill corpora", () => {
		const sessionId = insertSession("codemem");
		const now = "2026-06-01T00:00:01.000Z";
		const insertMemory = store.db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, project
			) VALUES (?, 'decision', ?, ?, 1, ?, ?, '{}', 'codemem')`,
		);
		const ids: number[] = [];
		for (let i = 0; i < 501; i++) {
			const info = insertMemory.run(sessionId, `Chunked vector ${i}`, `Body ${i}`, now, now);
			ids.push(Number(info.lastInsertRowid));
		}

		store.db.exec("DROP TABLE IF EXISTS memory_vectors");
		store.db.exec(
			`CREATE TABLE memory_vectors(
				embedding BLOB,
				memory_id INTEGER,
				chunk_index INTEGER,
				content_hash TEXT,
				model TEXT
			)`,
		);
		const currentModel = resolveEmbeddingModel();
		const insertVector = store.db.prepare(
			"INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model) VALUES (?, ?, ?, ?, ?)",
		);
		const firstId = ids[0];
		const lastId = ids.at(-1);
		if (firstId == null || lastId == null) throw new Error("expected seeded memory ids");
		insertVector.run(serializeFloat32(new Float32Array([1, 0])), firstId, 0, "first", currentModel);
		insertVector.run(serializeFloat32(new Float32Array([0, 1])), lastId, 0, "last", currentModel);

		const features = loadDistillVectorFeatures(store, store.recentByKinds(["decision"], 501));

		expect(features.find((feature) => feature.memory_id === firstId)?.vector).toEqual(
			new Float32Array([1, 0]),
		);
		expect(features.find((feature) => feature.memory_id === lastId)?.vector).toEqual(
			new Float32Array([0, 1]),
		);
	});
});
