import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as embeddings from "./embeddings.js";
import { completeMaintenanceJob, getMaintenanceJob } from "./maintenance-jobs.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { queueVectorBackfill, VECTOR_MODEL_MIGRATION_JOB } from "./vector-backfill-queue.js";
import { upgradeVectorIndex } from "./vector-index-upgrade.js";
import {
	backfillVectors,
	bestEffortMaintainVectorsForSyncFallback,
	storeVectors,
} from "./vectors.js";

vi.mock("./embeddings.js", async () => ({
	...(await vi.importActual<typeof import("./embeddings.js")>("./embeddings.js")),
	getEmbeddingClient: vi.fn(),
	embedTexts: vi.fn(),
	resolveEmbeddingClientVectorIdentityLabel: vi.fn(() => "test-model"),
}));

const TITLE = "Original title";
const BODY = "Original body";
const NOW = "2026-01-01T00:00:00.000Z";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function vectors(texts: string[]): Float32Array[] {
	return texts.map(() => {
		const vector = new Float32Array(384);
		vector[0] = 1;
		return vector;
	});
}

let db: Database.Database;
let sessionId: number;

function useSourceFixture(layout: "legacy" | "v1") {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("test forbids network"));
		vi.mocked(embeddings.resolveEmbeddingClientVectorIdentityLabel).mockReturnValue("test-model");
		vi.mocked(embeddings.getEmbeddingClient).mockResolvedValue({
			model: "test-model",
			dimensions: 384,
			identity: {
				package: "@huggingface/transformers",
				version: "4.2.0",
				model: "test-model",
				revision: "0123456789abcdef0123456789abcdef01234567",
				requestedRevision: "test-revision",
				dtype: "fp32",
				device: "cpu",
				pooling: "mean",
				normalization: "l2",
				dimensions: 384,
			},
			embed: vi.fn(async () => {
				throw new Error("use the fake embedTexts barrier");
			}),
		});
		vi.mocked(embeddings.embedTexts).mockImplementation(async (texts) => vectors(texts));
		db = new Database(":memory:");
		initTestSchema(db);
		if (layout === "v1") upgradeVectorIndex(db, { configuredModel: "test-model" });
		sessionId = insertTestSession(db);
	});

	afterEach(() => {
		db.close();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});
}

function memory(id = 1, importKey = "original-memory", title = TITLE, body = BODY) {
	db.prepare(`INSERT INTO memory_items(
			id, session_id, kind, title, body_text, active, created_at, updated_at, rev, import_key)
			VALUES (?, ?, 'discovery', ?, ?, 1, ?, ?, 1, ?)`).run(
		id,
		sessionId,
		title,
		body,
		NOW,
		NOW,
		importKey,
	);
}

function rows() {
	return db
		.prepare(`SELECT memory_id, chunk_index, content_hash, model
			FROM memory_vectors ORDER BY memory_id, chunk_index, rowid`)
		.all();
}

function expectedRow(id: number, title = TITLE, body = BODY) {
	return {
		memory_id: id,
		chunk_index: 0,
		content_hash: embeddings.hashText(`${title}\n${body}`),
		model: "test-model",
	};
}

function holdInference() {
	const started = deferred<string[]>();
	const release = deferred<Float32Array[]>();
	vi.mocked(embeddings.embedTexts).mockImplementationOnce(async (texts) => {
		started.resolve(texts);
		return release.promise;
	});
	return {
		started: started.promise,
		release: (texts: string[]) => release.resolve(vectors(texts)),
	};
}

function write(entrypoint: "inline" | "backfill") {
	if (entrypoint === "inline") return storeVectors(db, 1, TITLE, BODY);
	return backfillVectors(db, { memoryIds: [1] });
}

function testChunkAndRetirementRaces(entrypoint: "inline" | "backfill") {
	it.each(["unchanged", "edited", "reordered"] as const)(
		"preserves original chunk positions for a %s multi-chunk source",
		async (change) => {
			// Arrange: real chunking produces three distinct chunks within one inference batch.
			const chunks = ["a".repeat(1200), "b".repeat(1200), "c".repeat(1200)];
			const body = chunks.join("");
			memory(1, "original-memory", "", body);
			const barrier = holdInference();
			const pending =
				entrypoint === "inline"
					? storeVectors(db, 1, "", body)
					: backfillVectors(db, { memoryIds: [1] });
			const texts = await barrier.started;
			// Act: keep identity and version fields unchanged, as in direct text redaction.
			if (change === "edited") {
				db.prepare("UPDATE memory_items SET body_text = ? WHERE id = 1").run(
					[chunks[0], "x".repeat(1200), chunks[2]].join(""),
				);
			}
			if (change === "reordered") {
				db.prepare("UPDATE memory_items SET body_text = ? WHERE id = 1").run(
					[chunks[0], chunks[2], chunks[1]].join(""),
				);
			}
			barrier.release(texts);
			await pending;
			// Assert: a hash at another position does not authorize the original chunk index.
			expect(texts).toEqual(chunks);
			const acceptedIndexes = { unchanged: [0, 1, 2], edited: [0, 2], reordered: [0] };
			expect(rows()).toEqual(
				acceptedIndexes[change].map((chunkIndex) => ({
					memory_id: 1,
					chunk_index: chunkIndex,
					content_hash: embeddings.hashText(chunks[chunkIndex] as string),
					model: "test-model",
				})),
			);
		},
	);

	it.each(["inactive", "deleted-at", "both"] as const)(
		"discards inference after soft deletion sets %s",
		async (change) => {
			// Arrange: independently exercise each persisted retirement field.
			memory();
			const barrier = holdInference();
			const pending = write(entrypoint);
			const texts = await barrier.started;
			// Act
			if (change !== "deleted-at") {
				db.prepare("UPDATE memory_items SET active = 0 WHERE id = 1").run();
			}
			if (change !== "inactive") {
				db.prepare("UPDATE memory_items SET deleted_at = ? WHERE id = 1").run(NOW);
			}
			barrier.release(texts);
			await pending;
			// Assert: retirement invalidates an otherwise unchanged source snapshot.
			expect(rows()).toEqual([]);
		},
	);
}

function testClientSetupRace() {
	it.each(["unchanged", "replaced"] as const)(
		"uses the pre-await source identity when client setup resumes with an %s source",
		async (change) => {
			// Arrange: pause client setup before inference or any asynchronous source reread.
			memory();
			const client = await embeddings.getEmbeddingClient();
			const started = deferred<void>();
			const setup = deferred<typeof client>();
			vi.mocked(embeddings.getEmbeddingClient).mockImplementationOnce(() => {
				started.resolve();
				return setup.promise;
			});
			const pending = storeVectors(db, 1, TITLE, BODY);
			await started.promise;
			// Act: preserve text and every version field but replace the import identity.
			if (change === "replaced") {
				db.prepare("DELETE FROM memory_items WHERE id = 1").run();
				memory(1, "replacement-memory");
			}
			setup.resolve(client);
			await pending;
			// Assert
			expect(rows()).toEqual(change === "unchanged" ? [expectedRow(1)] : []);
		},
	);
}

describe.each(["legacy", "v1"] as const)("%s source write fence", (layout) => {
	useSourceFixture(layout);
	testClientSetupRace();
	describe.each(["inline", "backfill"] as const)("%s completion", (entrypoint) => {
		testChunkAndRetirementRaces(entrypoint);
		it("inserts when the source and identity remain current", async () => {
			// Arrange: inference yields without any source mutation.
			memory();
			const barrier = holdInference();
			// Act
			const pending = write(entrypoint);
			const texts = await barrier.started;
			barrier.release(texts);
			await pending;
			// Assert
			expect(texts).toEqual([`${TITLE}\n${BODY}`]);
			expect(rows()).toEqual([expectedRow(1)]);
		});

		it.each(["title", "body_text"] as const)(
			"discards inference after %s changes without a revision bump",
			async (column) => {
				// Arrange: redaction changes text without changing rev or timestamps.
				memory();
				const barrier = holdInference();
				const pending = write(entrypoint);
				const texts = await barrier.started;
				// Act
				db.prepare(`UPDATE memory_items SET ${column} = '[redacted]' WHERE id = 1`).run();
				barrier.release(texts);
				await pending;
				// Assert
				expect(rows()).toEqual([]);
				expect(db.prepare("SELECT rev FROM memory_items WHERE id = 1").pluck().get()).toBe(1);
			},
		);

		it.each(["deleted", "reused-different-text", "reused-same-text"] as const)(
			"discards inference for a %s source",
			async (change) => {
				// Arrange: a replacement retains the numeric ID but has a different import identity.
				memory();
				const barrier = holdInference();
				const pending = write(entrypoint);
				const texts = await barrier.started;
				// Act
				db.prepare("DELETE FROM memory_items WHERE id = 1").run();
				if (change !== "deleted") {
					const body = change === "reused-same-text" ? BODY : "Replacement body";
					memory(1, "replacement-memory", TITLE, body);
				}
				barrier.release(texts);
				await pending;
				// Assert: equal text alone must not authorize writing to the replacement.
				expect(rows()).toEqual([]);
			},
		);

		it("does not resurrect old content after repair completes and its queue is removed", async () => {
			// Arrange: keep the old completion pending while current text is repaired.
			memory();
			const barrier = holdInference();
			const pending = write(entrypoint);
			const texts = await barrier.started;
			db.prepare("UPDATE memory_items SET title = ?, body_text = ? WHERE id = 1").run(
				"Safe title",
				"Safe body",
			);
			queueVectorBackfill(db, { upsertMemoryIds: [1], deleteMemoryIds: [] });
			await bestEffortMaintainVectorsForSyncFallback(db, {
				upsertMemoryIds: [1],
				deleteMemoryIds: [],
			});
			completeMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB, {
				metadata: { pending_upsert_memory_ids: [], pending_delete_memory_ids: [] },
			});
			const repaired = rows();
			// Act: the old worker finishes after no queue intent remains for this ID.
			barrier.release(texts);
			await pending;
			// Assert
			expect(repaired).toEqual([expectedRow(1, "Safe title", "Safe body")]);
			expect(rows()).toEqual(repaired);
			expect(getMaintenanceJob(db, VECTOR_MODEL_MIGRATION_JOB)?.metadata).toMatchObject({
				pending_upsert_memory_ids: [],
				pending_delete_memory_ids: [],
			});
		});
	});

	it("commits valid batch peers while rejecting edited and replaced sources", async () => {
		// Arrange: all three memories share one inference batch.
		memory(1);
		memory(2, "memory-two", "Two", "Second body");
		memory(3, "memory-three", "Three", "Third body");
		const barrier = holdInference();
		const pending = backfillVectors(db, { memoryIds: [1, 2, 3] });
		const texts = await barrier.started;
		// Act
		db.prepare("UPDATE memory_items SET body_text = '[redacted]' WHERE id = 1").run();
		db.prepare("DELETE FROM memory_items WHERE id = 3").run();
		memory(3, "replacement-three", "Three", "Third body");
		barrier.release(texts);
		const result = await pending;
		// Assert: one stale source must neither contaminate nor cancel its unchanged peer.
		expect(texts).toHaveLength(3);
		expect(rows()).toEqual([expectedRow(2, "Two", "Second body")]);
		expect(result.inserted).toBe(1);
	});
});
