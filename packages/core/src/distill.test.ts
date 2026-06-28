import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import {
	createContextFactDetector,
	projectContextFactFeatures,
	selectDistillCorpus,
} from "./distill.js";
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
		createdAt: string;
		metadata?: Record<string, unknown>;
	}): number {
		const id = store.remember(
			input.sessionId,
			input.kind,
			input.title,
			`${input.title} body`,
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
});
