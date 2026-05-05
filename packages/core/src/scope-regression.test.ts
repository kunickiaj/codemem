import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, type Database } from "./db.js";
import * as embeddings from "./embeddings.js";
import { exportMemories } from "./export-import.js";
import { buildMemoryPack } from "./pack.js";
import { MemoryStore } from "./store.js";
import type { MixedScopeFixture } from "./test-utils.js";
import { initTestSchema, seedMixedScopeFixture } from "./test-utils.js";
import { semanticSearch } from "./vectors.js";

vi.mock("./embeddings.js", async () => {
	const actual = await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js");
	return {
		...actual,
		embedTexts: vi.fn(),
		getEmbeddingClient: vi.fn(),
		resolveEmbeddingModel: vi.fn(() => "test-model"),
	};
});

describe("mixed-domain scope regression", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;
	let fixture: MixedScopeFixture;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-scope-regression-"));
		dbPath = join(tmpDir, "test.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
		fixture = seedMixedScopeFixture(store.db, store.deviceId);
	});

	afterEach(() => {
		store?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("keeps unauthorized scope rows out of store, search, recent, timeline, and explain", () => {
		const visibleIds = new Set(fixture.visibleIds);

		expect(store.get(fixture.personalId)?.title).toBe(fixture.visibleTitles[0]);
		expect(store.get(fixture.authorizedId)?.title).toBe(fixture.visibleTitles[1]);
		expect(store.get(fixture.unauthorizedId)).toBeNull();

		for (const ids of [
			store.recent(10).map((item) => item.id),
			store.search(fixture.query, 10).map((item) => item.id),
			store.timeline(null, fixture.authorizedId, 5, 5).map((item) => item.id),
			store.explain(fixture.query, fixture.allIds, 10).items.map((item) => item.id),
		]) {
			expect(ids.some((id) => visibleIds.has(id))).toBe(true);
			expect(ids).not.toContain(fixture.unauthorizedId);
		}
		expect(store.timeline(null, fixture.unauthorizedId, 5, 5)).toEqual([]);

		const explain = store.explain(null, fixture.allIds, 10);
		expect(explain.items.map((item) => item.id).sort((a, b) => a - b)).toEqual(
			[...fixture.visibleIds].sort((a, b) => a - b),
		);
		expect(explain.missing_ids).toContain(fixture.unauthorizedId);
		expect(
			explain.errors.find((error) => error.code === "PROJECT_MISMATCH")?.ids ?? [],
		).not.toContain(fixture.unauthorizedId);
		expect(
			explain.errors.find((error) => error.code === "FILTER_MISMATCH")?.ids ?? [],
		).not.toContain(fixture.unauthorizedId);
	});

	it("keeps unauthorized scope rows out of semantic search", async () => {
		insertTestVector(store.db, fixture.personalId, 0.3, "personal-vector");
		insertTestVector(store.db, fixture.unauthorizedId, 0, "hidden-vector");
		insertTestVector(store.db, fixture.authorizedId, 0.2, "authorized-vector");
		vi.mocked(embeddings.embedTexts).mockResolvedValue([new Float32Array(384)]);

		const results = await semanticSearch(store.db, fixture.query, 10, null, {
			actorId: `local:${store.deviceId}`,
			deviceId: store.deviceId,
		});

		const resultIds = results.map((item) => item.id);
		expect(resultIds).toEqual(expect.arrayContaining(fixture.visibleIds));
		expect(resultIds).not.toContain(fixture.unauthorizedId);
	});

	it("keeps unauthorized scope rows out of pack text and exports", () => {
		const pack = buildMemoryPack(store, fixture.query, 10);
		expect(pack.item_ids.some((id) => fixture.visibleIds.includes(id))).toBe(true);
		expect(pack.item_ids).not.toContain(fixture.unauthorizedId);
		expect(pack.pack_text).toContain(fixture.visibleTitles[1]);
		expect(pack.pack_text).not.toContain(fixture.unauthorizedTitle);

		const payload = exportMemories({ dbPath, allProjects: true });
		const exportedTitles = payload.memory_items.map((memory) => String(memory.title));
		expect(exportedTitles).toEqual(expect.arrayContaining(fixture.visibleTitles));
		expect(exportedTitles).not.toContain(fixture.unauthorizedTitle);
		expect(payload.memory_items.map((memory) => memory.scope_id)).not.toContain(
			fixture.unauthorizedScopeId,
		);
	});
});

function insertTestVector(
	db: Database,
	memoryId: number,
	value: number,
	contentHash: string,
): void {
	const vector = new Float32Array(384).fill(value);
	const vectorJson = JSON.stringify(Array.from(vector));
	const escapedVectorJson = vectorJson.replaceAll("'", "''");
	const escapedHash = contentHash.replaceAll("'", "''");
	db.exec(`
		INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
		VALUES (vec_f32('${escapedVectorJson}'), ${memoryId}, 0, '${escapedHash}', 'test-model')
	`);
}
