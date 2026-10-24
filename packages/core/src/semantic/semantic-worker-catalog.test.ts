import { describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../coordinator-ed25519-key-id-test-fixtures.js";
import { resolveEmbeddingClientVectorIdentityLabel } from "../embeddings.js";
import { insertTestSession } from "../test-utils.js";
import {
	deferred,
	request,
	resultBarrier,
	seedForeignScopeReplica,
	seedVector,
	useSemanticWorkerFixture,
} from "./semantic-worker-test-fixtures.js";
import {
	auditBatch,
	deleteValidatedVectors,
	invalidateValidatedIndex,
	readCandidateVersions,
	readCatalog,
	startAudit,
} from "./validated-vector-index.js";

describe.each(["absent", "building", "needsrepair", "empty"] as const)(
	"semantic worker catalog without eligible evidence: %s",
	(state) => {
		const f = useSemanticWorkerFixture({ initializeIndex: state !== "absent" });
		it("returns no semantic candidates without starting a worker or loading embeddings", async () => {
			// Arrange: only the fixture owns these catalog/vector changes.
			if (state === "building")
				startAudit(f.store.db, {
					knownModels: [resolveEmbeddingClientVectorIdentityLabel(f.client)],
				});
			if (state === "needsrepair") {
				invalidateValidatedIndex(f.store.db);
				// Unsupported legacy maintenance is explicit: invalidate first, then audit before reuse.
				f.store.db.prepare("UPDATE memory_vectors SET model = 'fixture-unknown-model'").run();
				startAudit(f.store.db, {
					knownModels: [resolveEmbeddingClientVectorIdentityLabel(f.client)],
				});
				auditBatch(f.store.db, { limit: 100 });
			}
			if (state === "empty")
				for (const memoryId of Object.values(f.ids))
					deleteValidatedVectors(f.store.db, {
						writerVersion: 1,
						memoryId,
						model: resolveEmbeddingClientVectorIdentityLabel(f.client),
					});
			const getClient = vi.fn(async () => f.client);
			const createWorker = vi.fn(() => {
				throw new Error("unavailable catalog must not start worker");
			});
			const executor = f.openExecutor({ getClient, createWorker });
			expect(readCatalog(f.store.db)?.status ?? "absent").toBe(state === "empty" ? "ready" : state);

			// Act
			const results = await executor.search(request);

			// Assert: readiness gating must precede both admission and embedding work.
			expect(results).toEqual([]);
			expect(getClient).not.toHaveBeenCalled();
			expect(f.client.embed).not.toHaveBeenCalled();
			expect(createWorker).not.toHaveBeenCalled();
		});
	},
);

describe("semantic worker candidate-specific completion checks", () => {
	// Declaring a future label does not add physical vectors or change the initial model decision.
	const f = useSemanticWorkerFixture({ additionalKnownModels: ["fixture-incompatible-model"] });
	it.each(["usage", "unrelated vector"] as const)(
		"retains both semantic rows after a committed %s write",
		async (change) => {
			// Arrange: hold an actual worker result after its read snapshot completes.
			const barrier = resultBarrier(f.store);
			const executor = f.openExecutor({ createWorker: barrier.createWorker });
			const result = executor.search(request).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			await barrier.ranked;
			const before = readCatalog(f.store.db);

			// Act
			if (change === "usage")
				f.store.db
					.prepare("INSERT INTO usage_events(event, created_at) VALUES ('pack', '2026-01-01')")
					.run();
			if (change === "unrelated vector")
				seedVector(f.store.db, f.ids.hidden, f.client, 0.2, 0, { mode: "replace-memory-model" });
			const after = readCatalog(f.store.db);
			barrier.release();

			// Assert: global revision is diagnostic; hidden non-candidates cannot invalidate delivery.
			expect(await result).toMatchObject({
				value: [{ id: f.ids.semantic }, { id: f.ids.keyword }],
			});
			expect(after?.generationId).toBe(before?.generationId);
			const expectedRevision = change === "usage" ? before?.revision : expect.any(Number);
			expect(after?.revision).toEqual(expectedRevision);
			expect((after?.revision ?? -1) - (before?.revision ?? 0)).toBeGreaterThanOrEqual(
				change === "usage" ? 0 : 1,
			);
		},
	);

	it.each(["candidate delete", "generation invalidation"] as const)(
		"drops a held result after %s",
		async (change) => {
			// Arrange
			const barrier = resultBarrier(f.store);
			const executor = f.openExecutor({ createWorker: barrier.createWorker });
			const result = executor.search(request).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			await barrier.ranked;

			// Act
			if (change === "candidate delete")
				deleteValidatedVectors(f.store.db, {
					writerVersion: 1,
					memoryId: f.ids.semantic,
					model: resolveEmbeddingClientVectorIdentityLabel(f.client),
				});
			if (change === "generation invalidation") invalidateValidatedIndex(f.store.db);
			barrier.release();

			// Assert: absence/tombstones and invalid generation state cannot reuse an old score.
			expect(await result).toEqual({ value: [] });
		},
	);

	it("avoids parent model-table scans and vector-BLOB fingerprint queries", async () => {
		// Arrange
		const executor = f.openExecutor();
		const prepare = vi.spyOn(f.store.db, "prepare");

		// Act
		const result = await executor.search(request);
		const sql = prepare.mock.calls.map(([statement]) =>
			statement.replace(/\s+/g, " ").toLowerCase(),
		);

		// Assert: current content and indexed catalog/version reads are sufficient.
		expect(result.map(({ id }) => id)).toEqual([f.ids.semantic, f.ids.keyword]);
		expect(sql.filter((statement) => statement.includes("memory_vectors"))).toEqual([]);
		expect(sql.join("\n")).not.toMatch(/select distinct model from memory_vectors/);
		expect(sql.join("\n")).not.toMatch(/select[^;]*\bembedding\b[^;]*from memory_vectors/);
	});

	it("drops a held result when the no-job compatible-model decision changes, then skips inference", async () => {
		// Arrange: custom-model compatibility requires the catalog to contain only its identity.
		const barrier = resultBarrier(f.store);
		const executor = f.openExecutor({ createWorker: barrier.createWorker });
		const held = executor.search(request).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await barrier.ranked;

		// Act: a supported write adds another label without modifying either candidate.
		seedVector(f.store.db, f.ids.hidden, f.client, 0.1, 2, { model: "fixture-incompatible-model" });
		barrier.release();
		const first = await held;
		const second = await executor.search(request);

		// Assert: mixed catalogs must preserve the existing no-job compatibility decision.
		expect(first).toEqual({ value: [] });
		expect(second).toEqual([]);
		expect(f.client.embed).toHaveBeenCalledTimes(1);
	});
});

describe("semantic worker fresh scope authorization", () => {
	const f = useSemanticWorkerFixture();
	it("removes a revoked foreign candidate without discarding still-authorized rows", async () => {
		// Arrange: membership is the foreign replica's only authorization path.
		const foreign = seedForeignScopeReplica(f, "invite");
		const barrier = resultBarrier(f.store);
		const executor = f.openExecutor({ createWorker: barrier.createWorker });
		const result = executor.search(request).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await barrier.ranked;
		expect(barrier.output()?.candidates.map(({ id }) => id)).toContain(foreign.memoryId);
		const versionInput = {
			memoryIds: [f.ids.semantic, f.ids.keyword, foreign.memoryId],
			models: [resolveEmbeddingClientVectorIdentityLabel(f.client)],
		};
		const before = {
			catalog: readCatalog(f.store.db),
			versions: readCandidateVersions(f.store.db, versionInput),
			payload: f.store.db.prepare("SELECT * FROM memory_items ORDER BY id").all(),
		};

		// Act: scope SQL changes no vector, catalog, candidate version, or memory payload.
		f.store.db
			.prepare(
				"UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ? AND device_id = ?",
			)
			.run(foreign.scopeId, f.store.deviceId);
		const after = {
			catalog: readCatalog(f.store.db),
			versions: readCandidateVersions(f.store.db, versionInput),
			payload: f.store.db.prepare("SELECT * FROM memory_items ORDER BY id").all(),
		};
		barrier.release();

		// Assert: parent completion must re-evaluate access, not rely on unchanged versions.
		expect(after).toEqual(before);
		const outcome = await result;
		expect(outcome).not.toMatchObject({
			value: expect.arrayContaining([expect.objectContaining({ id: foreign.memoryId })]),
		});
		expect(outcome).toMatchObject({ value: [{ id: f.ids.semantic }, { id: f.ids.keyword }] });
	});

	it("uses at most two actual-key loads with coordinator membership candidates present", async () => {
		// Arrange: raw coordinator membership alone cannot authorize the managed replica.
		const foreign = seedForeignScopeReplica(f, "coordinator");
		const loadExpectedPublicKey = vi.fn(() => CANONICAL_PUBLIC_KEY);
		vi.spyOn(f.store, "scopeResolutionDeviceContext").mockReturnValue({ loadExpectedPublicKey });
		const executor = f.openExecutor();

		// Act
		const result = await executor.search(request);

		// Assert: captured public proof must also feed fresh parent scope resolution.
		expect(result.map(({ id }) => id)).toEqual([f.ids.semantic, f.ids.keyword]);
		expect(result.map(({ id }) => id)).not.toContain(foreign.memoryId);
		expect(loadExpectedPublicKey.mock.calls.length).toBeGreaterThan(0);
		expect(loadExpectedPublicKey.mock.calls.length).toBeLessThanOrEqual(2);
	});
});

describe("semantic worker eight-request wave", () => {
	const f = useSemanticWorkerFixture();
	it("returns five real semantic results and three overloads despite usage writes while queued", async () => {
		// Arrange: hold first preparation, then hold its actual worker result before delivery.
		const entered = deferred<void>();
		const prepareRelease = deferred<void>();
		const barrier = resultBarrier(f.store, { pauseFirstOnly: true });
		const getClient = vi.fn(async () => {
			entered.resolve();
			await prepareRelease.promise;
			return f.client;
		});
		const executor = f.openExecutor({ getClient, createWorker: barrier.createWorker });
		const calls = Array.from({ length: 8 }, () =>
			executor.search(request).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			),
		);
		await entered.promise;
		prepareRelease.resolve();
		await barrier.ranked;
		const catalog = readCatalog(f.store.db);

		// Act: first result and four queued jobs coexist with an unrelated parent write.
		f.store.db
			.prepare("INSERT INTO usage_events(event, created_at) VALUES ('pack', '2026-01-01')")
			.run();
		barrier.release();
		const outcomes = await Promise.all(calls);

		// Assert: count semantic IDs from the executor, not keyword-fallback pack items.
		expect(outcomes.slice(0, 5)).toMatchObject(
			Array.from({ length: 5 }, () => ({ value: [{ id: f.ids.semantic }, { id: f.ids.keyword }] })),
		);
		expect(outcomes.slice(5)).toMatchObject(
			Array.from({ length: 3 }, () => ({ error: { code: "overloaded" } })),
		);
		expect(getClient).toHaveBeenCalledTimes(5);
		expect(f.client.embed).toHaveBeenCalledTimes(5);
		expect(readCatalog(f.store.db)).toEqual(catalog);
	});
});

describe("semantic worker fresh automatic session mapping", () => {
	const f = useSemanticWorkerFixture();
	it.each(["remap", "remove"] as const)(
		"skips the old summary after mapping %s while retaining durable candidates",
		async (change) => {
			// Arrange: use the same mapping columns as core's automatic-session continuity tests.
			const oldSession = insertTestSession(f.store.db);
			const newSession = insertTestSession(f.store.db);
			const hostSessionId = "fixture-automatic-host";
			f.store.db
				.prepare(
					"INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run("opencode", hostSessionId, hostSessionId, oldSession, "2026-01-01");
			const summaryId = f.store.remember(
				oldSession,
				"session_summary",
				"Old mapped summary",
				"Old session continuity handoff",
				0.9,
			);
			seedVector(f.store.db, summaryId, f.client, 0.95);
			const barrier = resultBarrier(f.store);
			const executor = f.openExecutor({ createWorker: barrier.createWorker });
			const result = executor
				.search({ ...request, automaticContext: { source: "opencode", hostSessionId } })
				.then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				);
			await barrier.ranked;
			expect(barrier.output()?.candidates.map(({ id }) => id)).toContain(summaryId);
			const versionInput = {
				memoryIds: [f.ids.semantic, f.ids.keyword, summaryId],
				models: [resolveEmbeddingClientVectorIdentityLabel(f.client)],
			};
			const before = {
				catalog: readCatalog(f.store.db),
				versions: readCandidateVersions(f.store.db, versionInput),
			};

			// Act: only session metadata changes after actual worker SQL has finished.
			if (change === "remap")
				f.store.db
					.prepare("UPDATE opencode_sessions SET session_id = ? WHERE source = ? AND stream_id = ?")
					.run(newSession, "opencode", hostSessionId);
			if (change === "remove")
				f.store.db
					.prepare("DELETE FROM opencode_sessions WHERE source = ? AND stream_id = ?")
					.run("opencode", hostSessionId);
			const after = {
				catalog: readCatalog(f.store.db),
				versions: readCandidateVersions(f.store.db, versionInput),
			};
			barrier.release();

			// Assert: unchanged vector metadata does not authorize a stale session summary.
			expect(after).toEqual(before);
			const outcome = await result;
			expect(outcome).not.toMatchObject({
				value: expect.arrayContaining([expect.objectContaining({ id: summaryId })]),
			});
			expect(outcome).toMatchObject({ value: [{ id: f.ids.semantic }, { id: f.ids.keyword }] });
		},
	);
});
