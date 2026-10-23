import { existsSync, renameSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../coordinator-ed25519-key-id-test-fixtures.js";
import { connect, loadSqliteVec } from "../db.js";
import { resolveEmbeddingClientVectorIdentityLabel, serializeFloat32 } from "../embeddings.js";
import { rankSemanticEmbedding, semanticResult } from "../vectors.js";
import { SemanticIdentityChangedError } from "./semantic-executor-seam.js";
import {
	deferred,
	request,
	resultBarrier,
	seedVector,
	unitVector,
	useSemanticWorkerFixture,
} from "./semantic-worker-test-fixtures.js";
import { deleteValidatedVectors } from "./validated-vector-index.js";

// Model transitions below use only labels declared by the initial generation audit.
const f = useSemanticWorkerFixture({
	additionalKnownModels: ["fixture-incompatible-model", "fixture-retired-model"],
});

describe("semantic worker preparation cost contract", () => {
	it("loads actual signing proof at most twice while returning real worker results", async () => {
		// Arrange: file-backed key loading must not repeat at every preparation stage.
		const loadExpectedPublicKey = vi.fn(() => CANONICAL_PUBLIC_KEY);
		vi.spyOn(f.store, "scopeResolutionDeviceContext").mockReturnValue({ loadExpectedPublicKey });
		const executor = f.openExecutor();

		// Act
		const results = await executor.search(request);

		// Assert: successful ranking still uses proof, without repeated key parsing.
		expect(results.map(({ id }) => id)).toEqual([f.ids.semantic, f.ids.keyword]);
		expect(loadExpectedPublicKey.mock.calls.length).toBeGreaterThan(0);
		expect(loadExpectedPublicKey.mock.calls.length).toBeLessThanOrEqual(2);
	});

	it("rechecks the actual signing key after worker completion", async () => {
		// Arrange: this loader changes independently of the captured context object.
		const loadExpectedPublicKey = vi.fn(() => CANONICAL_PUBLIC_KEY);
		vi.spyOn(f.store, "scopeResolutionDeviceContext").mockReturnValue({ loadExpectedPublicKey });
		const barrier = resultBarrier(f.store);
		const executor = f.openExecutor({ createWorker: barrier.createWorker });
		const outcome = executor.search(request).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await barrier.ranked;

		// Act
		loadExpectedPublicKey.mockReturnValue("fixture-replacement-key");
		barrier.release();

		// Assert: reducing intermediate key loads must retain the final actual-key check.
		expect(await outcome).toEqual({ error: expect.any(SemanticIdentityChangedError) });
	});

	it("skips client initialization when the vector table is empty", async () => {
		// Arrange: mutate only this test's synthetic database.
		for (const memoryId of Object.values(f.ids))
			deleteValidatedVectors(f.store.db, {
				writerVersion: 1,
				memoryId,
				model: resolveEmbeddingClientVectorIdentityLabel(f.client),
			});
		const getClient = vi.fn(async () => f.client);
		const executor = f.openExecutor({ getClient });

		// Act
		const results = await executor.search(request);

		// Assert: empty corpus keeps the inline path's cheap no-work behavior.
		expect(results).toEqual([]);
		expect(getClient).not.toHaveBeenCalled();
		expect(f.client.embed).not.toHaveBeenCalled();
	});

	it("resolves the client once but skips embedding for an incompatible model catalog", async () => {
		// Arrange: vector rows exist, but none match the runtime-resolved identity.
		for (const memoryId of Object.values(f.ids)) {
			deleteValidatedVectors(f.store.db, {
				writerVersion: 1,
				memoryId,
				model: resolveEmbeddingClientVectorIdentityLabel(f.client),
			});
			seedVector(f.store.db, memoryId, f.client, 1, 0, { model: "fixture-incompatible-model" });
		}
		const getClient = vi.fn(async () => f.client);
		const executor = f.openExecutor({ getClient });

		// Act
		const results = await executor.search(request);

		// Assert: determine compatibility before spending CPU on a query embedding.
		expect(results).toEqual([]);
		expect(getClient).toHaveBeenCalledTimes(1);
		expect(f.client.embed).not.toHaveBeenCalled();
	});
});

describe("real semantic worker ranking", () => {
	it("matches inline IDs/distances and chunk minimums, excludes hidden nearest, and leaves the database unchanged", async () => {
		// Arrange: the closest vector belongs to an invisible scope.
		const models = [resolveEmbeddingClientVectorIdentityLabel(f.client)];
		const expected = rankSemanticEmbedding(
			f.store.db,
			serializeFloat32(unitVector()),
			models,
			10,
			null,
			f.store.ownershipFilterContext(),
		).map(semanticResult);
		const snapshot = f.store.db.serialize();
		const executor = f.openExecutor();
		const prepares = vi.spyOn(f.store.db, "prepare");

		// Act: use the executor's normal transport, not a fake Worker.
		const actual = await executor.search(request);
		await executor.close();

		// Assert
		expect(actual).toEqual(expected);
		expect(actual.map(({ id }) => id)).toEqual([f.ids.semantic, f.ids.keyword]);
		expect(actual[0].distance).toBeCloseTo(Math.sqrt(0.2), 6);
		expect(actual.map(({ id }) => id)).not.toContain(f.ids.hidden);
		expect(prepares.mock.calls.map(([sql]) => sql).join("\n")).not.toContain("vec_distance_l2");
		expect(f.store.db.serialize().equals(snapshot)).toBe(true);
	});

	it.each(["content", "vector", "model"] as const)(
		"discards a completed result after an external %s change without ranking inline",
		async (change) => {
			// Arrange: the barrier fires only after a real worker read snapshot completes.
			const barrier = resultBarrier(f.store);
			const executor = f.openExecutor({ createWorker: barrier.createWorker });
			const prepares = vi.spyOn(f.store.db, "prepare");
			const pending = executor.search(request).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			await barrier.ranked;
			const writer = connect(f.store.dbPath);
			loadSqliteVec(writer);

			// Act: committed supported writes must invalidate only affected candidate versions.
			try {
				if (change === "content")
					writer
						.prepare("UPDATE memory_items SET body_text = 'Changed externally' WHERE id = ?")
						.run(f.ids.semantic);
				if (change === "vector")
					seedVector(writer, f.ids.semantic, f.client, 0, 0, { mode: "replace-memory-model" });
				if (change === "model") {
					deleteValidatedVectors(writer, {
						writerVersion: 1,
						memoryId: f.ids.semantic,
						model: resolveEmbeddingClientVectorIdentityLabel(f.client),
					});
					seedVector(writer, f.ids.semantic, f.client, 1, 0, { model: "fixture-retired-model" });
				}
			} finally {
				writer.close();
			}
			barrier.release();

			// Assert: no stale candidates and no fallback SQL on the parent connection.
			expect(await pending).toEqual({ value: [] });
			expect(prepares.mock.calls.map(([sql]) => sql).join("\n")).not.toContain("vec_distance_l2");
		},
	);
});

describe("real semantic worker identity and lifecycle", () => {
	it.each(["actor", "key"] as const)(
		"rejects a completed result after runtime %s changes",
		async (change) => {
			// Arrange
			const barrier = resultBarrier(f.store);
			const executor = f.openExecutor({ createWorker: barrier.createWorker });
			const outcome = executor.search(request).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			await barrier.ranked;

			// Act
			if (change === "actor") vi.stubEnv("CODEMEM_ACTOR_ID", "fixture-replacement-actor");
			if (change === "key")
				vi.spyOn(f.store, "scopeResolutionDeviceContext").mockReturnValue({
					expectedPublicKey: "fixture-replacement-key",
				});
			barrier.release();

			// Assert: an identity error must not become successful keyword-only delivery.
			expect(await outcome).toEqual({ error: expect.any(SemanticIdentityChangedError) });
		},
	);

	it("rechecks queued identity before obtaining another embedding client", async () => {
		// Arrange: first preparation holds the sole active slot after real readiness.
		const entered = deferred<void>();
		const release = deferred<void>();
		const getClient = vi.fn(async () => {
			entered.resolve();
			await release.promise;
			return f.client;
		});
		const executor = f.openExecutor({ getClient });
		const observe = (promise: ReturnType<typeof executor.search>) =>
			promise.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
		const first = observe(executor.search(request));
		await entered.promise;
		const queued = observe(executor.search(request));

		// Act
		vi.stubEnv("CODEMEM_ACTOR_ID", "fixture-replacement-actor");
		release.resolve();

		// Assert
		expect(await first).toEqual({ error: expect.any(SemanticIdentityChangedError) });
		expect(await queued).toEqual({ error: expect.any(SemanticIdentityChangedError) });
		expect(getClient).toHaveBeenCalledTimes(1);
	});

	it("does not recreate a missing database or deliver keyword success after its file disappears", async () => {
		// Arrange
		const executor = f.openExecutor();
		const path = f.store.dbPath;
		const moved = `${path}.fixture-moved`;
		renameSync(path, moved);

		// Act
		try {
			const outcome = await executor.search(request).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);

			// Assert
			expect(outcome).toEqual({ error: expect.any(SemanticIdentityChangedError) });
			expect(existsSync(path)).toBe(false);
			expect(existsSync(moved)).toBe(true);
		} finally {
			renameSync(moved, path);
		}
	});
});
