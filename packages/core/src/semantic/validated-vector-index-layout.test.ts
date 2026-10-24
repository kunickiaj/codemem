import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyVectorLayout } from "../vector-layout.js";
import { MODEL, vector } from "./semantic-ranking.test-helper.js";
import {
	auditBatch,
	deleteValidatedVectors,
	initializeValidatedIndex,
	readCandidateVersions,
	readCatalog,
	startAudit,
	writeValidatedBatch,
} from "./validated-vector-index.js";
import { createDisposableIndexFixture, row } from "./validated-vector-index.test-helper.js";

describe.each(["legacy", "v1"] as const)("validated mutations on %s layout", (layout) => {
	let owned: ReturnType<typeof createDisposableIndexFixture>;
	let memoryId: number;
	let survivorId: number;
	beforeEach(() => {
		owned = createDisposableIndexFixture();
		const { fixture } = owned;
		if (layout === "v1") {
			fixture.db.exec("DROP TABLE memory_vectors");
			createEmptyVectorLayout(fixture.db);
		} else {
			initializeValidatedIndex(fixture.db, { writerVersion: 1, allWritersUpgraded: true });
		}
		memoryId = fixture.memory();
		survivorId = fixture.memory();
		// Seed the physical table independently so delete/replace do not depend on append working.
		const table = layout === "v1" ? "memory_vectors_v1" : "memory_vectors";
		const insert = fixture.db.prepare(`INSERT INTO ${table}
			(embedding,memory_id,chunk_index,content_hash,model) VALUES(?,?,?,?,?)`);
		for (const [id, chunk] of [
			[memoryId, 0],
			[memoryId, 1],
			[survivorId, 0],
		]) {
			insert.run(
				Buffer.from(vector(1).buffer),
				BigInt(id),
				BigInt(chunk),
				`hash-${id}-${chunk}`,
				MODEL,
			);
		}
		startAudit(fixture.db, { knownModels: [MODEL] });
		expect(auditBatch(fixture.db, { limit: 100 })).toMatchObject({
			invalid: 0,
			remaining: 0,
			catalog: { status: "ready", models: [{ model: MODEL, count: 3 }] },
		});
	});
	afterEach(() => owned.dispose());

	it.each([
		{ mode: "append", count: 3, delta: 1 },
		{ mode: "replace-memory-model", count: 1, delta: 3 },
		{ mode: "delete", count: 0, delta: 2 },
	] as const)("$mode updates physical rows and catalog exactly once", ({ mode, count, delta }) => {
		const { db } = owned.fixture;
		const before = readCatalog(db);
		const versions = () =>
			readCandidateVersions(db, { memoryIds: [memoryId, survivorId], models: [MODEL] });
		const previous = versions();

		const updated =
			mode === "delete"
				? deleteValidatedVectors(db, { writerVersion: 1, memoryId, model: MODEL })
				: writeValidatedBatch(db, {
						writerVersion: 1,
						expectedModel: MODEL,
						model: MODEL,
						expectedCount: 1,
						mode,
						rows: [row(memoryId, -1, 2)],
					});

		expect(updated).toMatchObject({
			generationId: before?.generationId,
			revision: (before?.revision ?? 0) + 1,
			status: "ready",
			models: [{ model: MODEL, count: count + 1 }],
		});
		expect(versions()).toEqual(
			previous.map((entry) =>
				entry.memoryId === memoryId ? { ...entry, count, version: entry.version + delta } : entry,
			),
		);
		expect(db.prepare("SELECT count FROM validated_vector_models").all()).toEqual([
			{ count: count + 1 },
		]);
		expect(
			db.prepare("SELECT pending_count,invalid_count FROM validated_vector_state").get(),
		).toEqual({
			pending_count: 0,
			invalid_count: 0,
		});
		expect(
			db.prepare("SELECT count(*) AS count FROM memory_vectors WHERE memory_id=?").get(memoryId),
		).toEqual({ count });
		expect(db.prepare("SELECT count(*) AS count FROM validated_vector_rows").get()).toEqual({
			count: count + 1,
		});
		// Rebuilding from physical rows must agree with the supported writer's bookkeeping.
		startAudit(db, { knownModels: [MODEL] });
		expect(auditBatch(db, { limit: 100 })).toMatchObject({
			invalid: 0,
			remaining: 0,
			catalog: { status: "ready", models: [{ model: MODEL, count: count + 1 }] },
		});
	});
});
