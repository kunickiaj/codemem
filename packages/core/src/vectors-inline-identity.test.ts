import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDistillVectorFeatures } from "./distill.js";
import {
	_resetEmbeddingClient,
	_resetEmbeddingRuntimeFactory,
	_setEmbeddingRuntimeFactory,
	resolveEmbeddingVectorIdentityLabel,
} from "./embeddings.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import { ensureVectorSchema } from "./schema-bootstrap.js";
import { MemoryStore } from "./store.js";
import { storeVectors } from "./vectors.js";

const REQUESTED_MODEL = "example/custom-embedding-model";
const REQUESTED_REVISION = "mutable-release";
const CANONICAL_REVISION = "0123456789abcdef0123456789abcdef01234567";
const EXPECTED_VECTOR = new Float32Array(384).fill(0.25);

describe("inline vector identity persistence", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;
	let previousDisabled: string | undefined;
	let previousModel: string | undefined;
	let previousRevision: string | undefined;
	let runtimeLoads: number;

	beforeEach(() => {
		previousDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
		previousModel = process.env.CODEMEM_EMBEDDING_MODEL;
		previousRevision = process.env.CODEMEM_EMBEDDING_REVISION;
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		process.env.CODEMEM_EMBEDDING_MODEL = REQUESTED_MODEL;
		process.env.CODEMEM_EMBEDDING_REVISION = REQUESTED_REVISION;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-inline-vector-identity-"));
		dbPath = join(tmpDir, "test.sqlite");
		store = new MemoryStore(dbPath);
		runtimeLoads = 0;
		_setEmbeddingRuntimeFactory(async () => {
			runtimeLoads++;
			return {
				model: REQUESTED_MODEL,
				dimensions: 384,
				identity: {
					package: "@huggingface/transformers",
					version: "4.2.0",
					model: REQUESTED_MODEL,
					revision: CANONICAL_REVISION,
					requestedRevision: REQUESTED_REVISION,
					dtype: "fp32",
					device: "cpu",
					pooling: "mean",
					normalization: "l2",
					dimensions: 384,
				},
				embed: async (texts) => texts.map(() => EXPECTED_VECTOR.slice()),
			};
		});
	});

	afterEach(() => {
		store.close();
		_resetEmbeddingRuntimeFactory();
		if (previousDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
		else process.env.CODEMEM_EMBEDDING_DISABLED = previousDisabled;
		if (previousModel === undefined) delete process.env.CODEMEM_EMBEDDING_MODEL;
		else process.env.CODEMEM_EMBEDDING_MODEL = previousModel;
		if (previousRevision === undefined) delete process.env.CODEMEM_EMBEDDING_REVISION;
		else process.env.CODEMEM_EMBEDDING_REVISION = previousRevision;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	async function writeInlineVector(): Promise<number> {
		const sessionId = store.startSession({ project: "codemem" });
		const memoryId = store.remember(sessionId, "decision", "Canonical inline identity", "Body");
		await store.flushPendingVectorWrites();
		delete process.env.CODEMEM_EMBEDDING_DISABLED;
		ensureVectorSchema(store.db);
		await storeVectors(store.db, memoryId, "Canonical inline identity", "Body");
		return memoryId;
	}

	it("maps a mutable request to the canonical vector label and maintenance identity", async () => {
		const memoryId = await writeInlineVector();
		const targetModel = resolveEmbeddingVectorIdentityLabel(REQUESTED_MODEL, CANONICAL_REVISION);
		const row = store.db
			.prepare("SELECT model FROM memory_vectors WHERE memory_id = ?")
			.get(memoryId);

		expect({
			row,
			metadata: getMaintenanceJob(store.db, "vector_model_identity")?.metadata,
		}).toEqual({
			row: { model: targetModel },
			metadata: {
				target_model: targetModel,
				requested_model: REQUESTED_MODEL,
				requested_revision: REQUESTED_REVISION,
			},
		});
	});

	it("keeps inline vectors discoverable after runtime client state is reset", async () => {
		const memoryId = await writeInlineVector();
		_resetEmbeddingClient();
		store.close();
		store = new MemoryStore(dbPath);
		const item = store.get(memoryId);
		if (!item) throw new Error("expected inline-vector memory");

		const [feature] = loadDistillVectorFeatures(store, [item]);

		expect(feature?.vector).toEqual(EXPECTED_VECTOR);
		expect(runtimeLoads).toBe(1);
	});

	it("does not rewrite an unchanged completed identity job", async () => {
		const memoryId = await writeInlineVector();
		store.db
			.prepare("UPDATE maintenance_jobs SET updated_at = ? WHERE kind = 'vector_model_identity'")
			.run("2000-01-01T00:00:00.000Z");

		await storeVectors(store.db, memoryId, "Canonical inline identity", "Body");

		expect(getMaintenanceJob(store.db, "vector_model_identity")?.updated_at).toBe(
			"2000-01-01T00:00:00.000Z",
		);
	});

	it("rolls back inline vectors when identity persistence fails", async () => {
		const sessionId = store.startSession({ project: "codemem" });
		const memoryId = store.remember(sessionId, "decision", "Atomic inline identity", "Body");
		await store.flushPendingVectorWrites();
		delete process.env.CODEMEM_EMBEDDING_DISABLED;
		ensureVectorSchema(store.db);
		getMaintenanceJob(store.db, "vector_model_identity");
		store.db.exec(`
			CREATE TRIGGER fail_vector_identity_insert
			BEFORE INSERT ON maintenance_jobs
			WHEN NEW.kind = 'vector_model_identity'
			BEGIN
				SELECT RAISE(ABORT, 'identity write failed');
			END;
		`);

		await expect(
			storeVectors(store.db, memoryId, "Atomic inline identity", "Body"),
		).rejects.toThrow("identity write failed");

		const vectorCount = store.db
			.prepare("SELECT COUNT(*) AS count FROM memory_vectors WHERE memory_id = ?")
			.get(memoryId) as { count: number };
		expect(vectorCount.count).toBe(0);
	});
});
