import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import {
	clusterDistillFeatures,
	createContextFactDetector,
	loadDistillVectorFeatures,
	projectContextFactFeatures,
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
		createdAt: string;
		metadata?: Record<string, unknown>;
	}): number {
		const id = store.remember(
			input.sessionId,
			input.kind,
			input.title,
			input.bodyText ?? `${input.title} body`,
			0.8,
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

	it("preserves semantic as the strongest signal across chained unions", () => {
		const clusters = clusterDistillFeatures(
			[
				{
					memory_id: 1,
					title: "semantic root",
					text: "semantic root",
					concepts: ["root"],
					project: "codemem",
					vector: new Float32Array([1, 0]),
				},
				{
					memory_id: 2,
					title: "semantic bridge",
					text: "semantic bridge",
					concepts: ["root", "bridge", "handoff"],
					project: "codemem",
					vector: new Float32Array([0.99, 0.1]),
				},
				{
					// Un-embedded leaf: links via concept overlap to member 2, since
					// concept/title fallback only applies when a vector is missing.
					memory_id: 3,
					title: "concept leaf",
					text: "concept leaf",
					concepts: ["bridge", "handoff"],
					project: "codemem",
				},
			],
			{ semanticThreshold: 0.95, minConceptOverlap: 2 },
		);

		expect(clusters[0]?.member_ids).toEqual([1, 2, 3]);
		expect(clusters[0]?.signal).toBe("semantic");
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
