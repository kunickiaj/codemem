import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { loadSqliteVec } from "./db.js";
import type { EmbeddingClient } from "./embeddings.js";
import {
	_resetEmbeddingRuntimeFactory,
	_setEmbeddingRuntimeFactory,
	getEmbeddingClient,
	MemoryStore,
	resolveEmbeddingVectorIdentityLabel,
	storeVectors,
} from "./index.js";
import { createFixture } from "./semantic/semantic-ranking.test-helper.js";
import { readCatalog } from "./semantic/validated-vector-index-state.js";

const query = "refresh authentication keys";
const title = "Credential rotation";
const body = "Replace secrets every quarter.";
const filters = { project: "semantic-default" };
const input = { query, limit: 10, filters };
const revision = "1".repeat(40);

function unitVector(): Float32Array {
	const vector = new Float32Array(384);
	vector[0] = 1;
	return vector;
}

let directory: string;
let store: MemoryStore | undefined;
const embed = vi.fn(async (texts: string[]) => texts.map(() => unitVector()));

function offlineClient(): EmbeddingClient {
	return {
		model: "fixture/offline-semantic",
		dimensions: 384,
		identity: {
			package: "@huggingface/transformers",
			version: "4.2.0",
			model: "fixture/offline-semantic",
			revision,
			requestedRevision: revision,
			dtype: "fp32",
			device: "cpu",
			pooling: "mean",
			normalization: "l2",
			dimensions: 384,
		},
		embed,
	};
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-semantic-default-"));
	for (const key of Object.keys(process.env).filter((key) => key.startsWith("CODEMEM_"))) {
		vi.stubEnv(key, "");
	}
	for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
		vi.stubEnv(key, directory);
	}
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_DEVICE_ID", "semantic-default");
	vi.stubEnv("CODEMEM_ACTOR_ID", "local:semantic-default");
	vi.stubEnv("CODEMEM_ACTOR_DISPLAY_NAME", "Test actor");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_EMBEDDING_MODEL", "fixture/offline-semantic");
	vi.stubEnv("CODEMEM_EMBEDDING_REVISION", revision);
	vi.stubEnv("HF_HUB_OFFLINE", "1");
	vi.stubEnv("TRANSFORMERS_OFFLINE", "1");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("test forbids network"));
	embed.mockReset().mockImplementation(async (texts) => texts.map(() => unitVector()));
	_setEmbeddingRuntimeFactory(async () => offlineClient());
});

afterEach(async () => {
	try {
		await store?.closeAsync();
	} finally {
		store = undefined;
		_resetEmbeddingRuntimeFactory();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	}
});

function openStore(storage: "file" | "memory"): MemoryStore {
	const path = storage === "file" ? join(directory, "memory.sqlite") : ":memory:";
	// Let the production constructor create its ordinary vector schema before disabling auto-embedding.
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	store = new MemoryStore(path, {
		keysDir: join(directory, "keys"),
		runtimeSigningKey: { deviceId: "semantic-default", publicKey: CANONICAL_PUBLIC_KEY },
	});
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	return store;
}

async function seed(current: MemoryStore): Promise<number> {
	const session = current.startSession({ project: filters.project });
	const id = current.remember(session, "decision", title, body, 0.9);
	await current.flushPendingVectorWrites();
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	// Use the supported writer: no experimental index initialization, audit, or executor attachment.
	await storeVectors(current.db, id, title, body);
	return id;
}

async function servesValidRowsAfterMixedLegacyUpgrade(): Promise<void> {
	// Arrange: only raw legacy fixture bootstrap/seeding precedes an ordinary production store open.
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	const client = await getEmbeddingClient();
	expect(client).not.toBeNull();
	const model = resolveEmbeddingVectorIdentityLabel("fixture/offline-semantic", revision);
	const legacy = createFixture(directory);
	const valid = legacy.memory();
	const unknown = legacy.memory();
	legacy.db
		.prepare("UPDATE memory_items SET actor_id=?,origin_device_id=?,project='fixture'")
		.run("local:semantic-default", "semantic-default");
	legacy.rawVector(valid, unitVector(), 0, model);
	legacy.rawVector(unknown, unitVector(), 0, "unknown-legacy-model");
	const before = legacy.snapshot();
	legacy.db.close();
	const current = new MemoryStore(legacy.path, {
		keysDir: join(directory, "keys"),
		runtimeSigningKey: { deviceId: "semantic-default", publicKey: CANONICAL_PUBLIC_KEY },
	});
	store = current;
	expect(readCatalog(current.db)).toMatchObject({ status: "needsrepair" });
	const prepare = vi.spyOn(current.db, "prepare");
	// Act: the default worker must search audited eligible rows without an attached executor.
	const results = await current.semanticSearchAsync({
		query,
		limit: 1,
		filters: { project: "fixture" },
	});
	const parentSql = prepare.mock.calls.map(([sql]) => sql);
	// Assert: unknown bytes and source rows remain intact; repair is not a prerequisite for valid evidence.
	expect(results.map((row) => row.id)).toEqual([valid]);
	expect(parentSql.some((sql) => /vec_distance_l2\s*\(/i.test(sql))).toBe(false);
	expect(current.db.prepare("SELECT rowid, * FROM memory_vectors ORDER BY rowid").all()).toEqual(
		before.vectors,
	);
	expect(current.db.prepare("SELECT * FROM memory_items ORDER BY id").all()).toEqual(
		before.memories,
	);
	expect(readCatalog(current.db)).toMatchObject({ status: "needsrepair" });
	expect(globalThis.fetch).not.toHaveBeenCalled();
}

it(
	"default file retrieval uses valid evidence after a mixed legacy catalog auto-upgrades to needsrepair",
	servesValidRowsAfterMixedLegacyUpgrade,
);

function effects(current: MemoryStore) {
	return {
		usage: current.db
			.prepare("SELECT COUNT(*) FROM usage_events WHERE event = 'pack'")
			.pluck()
			.get(),
		attempts: current.db.prepare("SELECT COUNT(*) FROM retrieval_attempts").pluck().get(),
		exposures: current.db.prepare("SELECT COUNT(*) FROM retrieval_exposures").pluck().get(),
	};
}

function observeProducerSql(current: MemoryStore) {
	let runs = 0;
	const original = current.db.prepare.bind(current.db);
	const prepare = vi.spyOn(current.db, "prepare").mockImplementation((sql: string) => {
		const statement = original(sql);
		const run = statement.run.bind(statement);
		vi.spyOn(statement, "run").mockImplementation((...params: unknown[]) => {
			runs++;
			return run(...params);
		});
		return statement;
	});
	const exec = vi.spyOn(current.db, "exec");
	const pragma = vi.spyOn(current.db, "pragma");
	const transaction = vi.spyOn(current.db, "transaction");
	return () => ({
		prepare: prepare.mock.calls.length,
		runs,
		exec: exec.mock.calls.length,
		pragma: pragma.mock.calls.length,
		transaction: transaction.mock.calls.length,
	});
}

function persistedProducerRows(memoryId: number) {
	const reader = new Database(join(directory, "memory.sqlite"), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		loadSqliteVec(reader);
		return {
			memory: reader
				.prepare("SELECT id, title, body_text FROM memory_items WHERE id=?")
				.get(memoryId),
			vectors: reader
				.prepare("SELECT COUNT(*) AS count FROM memory_vectors_v1 WHERE memory_id=?")
				.get(memoryId),
			versions: reader
				.prepare("SELECT count FROM validated_vector_versions WHERE memory_id=?")
				.all(memoryId),
			models: reader.prepare("SELECT count FROM validated_vector_models WHERE count>0").all(),
			catalog: reader
				.prepare("SELECT status, writer_version FROM validated_vector_state WHERE id=1")
				.get(),
		};
	} finally {
		reader.close();
	}
}

async function closesBeforeClientResolves(): Promise<void> {
	// Arrange: the ordinary producer is admitted, but client construction has not completed.
	const current = openStore("file");
	const session = current.startSession({ project: filters.project });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	_setEmbeddingRuntimeFactory(async () => {
		entered.resolve();
		await release.promise;
		return offlineClient();
	});
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	const sqlCounts = observeProducerSql(current);
	const id = current.remember(session, "decision", title, body);
	try {
		await entered.promise;
		// Act: synchronous close cancels best-effort work, including its late client result.
		expect(() => current.close()).not.toThrow();
		const afterClose = sqlCounts();
		release.resolve();
		await expect(current.flushPendingVectorWrites()).resolves.toBeUndefined();
		// Assert: count after close so legitimate optimization SQL does not count as a late write.
		expect(current.db.open).toBe(false);
		expect(embed).not.toHaveBeenCalled();
		expect(sqlCounts()).toEqual(afterClose);
		expect(persistedProducerRows(id)).toMatchObject({
			memory: { id, title, body_text: body },
			vectors: { count: 0 },
			versions: [],
			models: [],
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await current.flushPendingVectorWrites();
	}
}

async function closesDuringProducerInference(): Promise<void> {
	// Arrange: inference has actually entered the provider, not merely requested a client.
	const current = openStore("file");
	const session = current.startSession({ project: filters.project });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	embed.mockImplementationOnce(async (texts) => {
		entered.resolve();
		await release.promise;
		return texts.map(() => unitVector());
	});
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	const sqlCounts = observeProducerSql(current);
	const id = current.remember(session, "decision", title, body);
	try {
		await entered.promise;
		// Act: do not claim native inference was canceled; release its valid result after closure.
		expect(() => current.close()).not.toThrow();
		const afterClose = sqlCounts();
		release.resolve();
		await expect(current.flushPendingVectorWrites()).resolves.toBeUndefined();
		// Assert: neither derived vectors nor their identity metadata may touch the closed connection.
		expect(current.db.open).toBe(false);
		expect(embed).toHaveBeenCalledTimes(1);
		expect(sqlCounts()).toEqual(afterClose);
		expect(persistedProducerRows(id)).toMatchObject({
			memory: { id, title, body_text: body },
			vectors: { count: 0 },
			versions: [],
			models: [],
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await current.flushPendingVectorWrites();
	}
}

async function asyncCloseFlushesProducerInference(): Promise<void> {
	// Arrange: this is an ordinary remember producer, with no semantic worker or query attached.
	const current = openStore("file");
	const session = current.startSession({ project: filters.project });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	embed.mockImplementationOnce(async (texts) => {
		entered.resolve();
		await release.promise;
		return texts.map(() => unitVector());
	});
	const draining = Promise.withResolvers<void>();
	const flush = current.flushPendingVectorWrites.bind(current);
	vi.spyOn(current, "flushPendingVectorWrites").mockImplementation(() => {
		draining.resolve();
		return flush();
	});
	const closeDatabase = vi.spyOn(current.db, "close");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	const id = current.remember(session, "decision", title, body);
	try {
		await entered.promise;
		// Act: wait for close to reach its drain barrier before releasing provider inference.
		const closing = current.closeAsync();
		await draining.promise;
		expect(current.db.open).toBe(true);
		expect(closeDatabase).not.toHaveBeenCalled();
		release.resolve();
		await closing;
		// Assert: an independent read-only connection observes the committed vector and its metadata.
		expect(current.db.open).toBe(false);
		expect(closeDatabase).toHaveBeenCalledTimes(1);
		expect(embed).toHaveBeenCalledTimes(1);
		expect(persistedProducerRows(id)).toEqual({
			memory: { id, title, body_text: body },
			vectors: { count: 1 },
			versions: [{ count: 1 }],
			models: [{ count: 1 }],
			catalog: { status: "ready", writer_version: 1 },
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await current.closeAsync();
	}
}

describe("default inline producer close compatibility", () => {
	it("cancels late client resolution without touching closed SQLite", closesBeforeClientResolves);
	it(
		"discards held inference results after synchronous close without late SQLite calls",
		closesDuringProducerInference,
	);
	it(
		"waits for held producer inference and persists it before asynchronous close",
		asyncCloseFlushesProducerInference,
	);
});

describe("default semantic retrieval through the public core entrypoint", () => {
	it.each(["file", "memory"] as const)(
		"ordinary %s vector writes feed all three async pack variants without duplicate usage",
		async (storage) => {
			// Arrange: the query shares no lexical terms with the only memory.
			const current = openStore(storage);
			const id = await seed(current);
			expect(current.search(query, 10, filters)).toEqual([]);
			const before = effects(current);
			const prepare = vi.spyOn(current.db, "prepare");

			// Act: exercise the default owner, never an attached test executor.
			const response = await current.buildMemoryPackAsync(query, 10, null, filters);
			const afterResponse = effects(current);
			const artifacts = await current.buildMemoryPackWithTraceAsync(query, 10, null, filters);
			const afterArtifacts = effects(current);
			const trace = await current.buildMemoryPackTraceAsync(query, 10, null, filters);
			const afterTrace = effects(current);
			const parentRanked = prepare.mock.calls.some(([sql]) => /vec_distance_l2\s*\(/i.test(sql));

			// Assert: missing writer/bootstrap integration must remain RED, not keyword fallback success.
			expect(parentRanked).toBe(storage === "memory");
			expect(response.metrics.sources.semantic).toBe(1);
			expect(response.metrics.fallback_used).toBe(false);
			expect(response.item_ids, "normal storeVectors writes must become worker-searchable").toEqual(
				[id],
			);
			expect(artifacts.response.item_ids).toEqual(response.item_ids);
			expect([...new Set(Object.values(trace.assembly.sections).flat())]).toEqual([id]);
			expect([...new Set(Object.values(artifacts.trace.assembly.sections).flat())]).toEqual([id]);
			expect(afterResponse).toEqual({ ...before, usage: Number(before.usage) + 1 });
			expect(afterArtifacts).toEqual({ ...before, usage: Number(before.usage) + 2 });
			expect(afterTrace).toEqual(afterArtifacts);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["file", "memory"] as const)(
		"does not return semantic candidates excluded by %s project filters",
		async (storage) => {
			// Arrange
			const current = openStore(storage);
			const id = await seed(current);
			const visible = await current.semanticSearchAsync(input);
			const prepare = vi.spyOn(current.db, "prepare");

			// Act
			const hidden = await current.semanticSearchAsync({
				...input,
				filters: { project: "absent" },
			});

			// Assert: verify a working positive control before accepting an empty filtered result.
			expect(visible.map((row) => row.id)).toEqual([id]);
			expect(hidden).toEqual([]);
			if (storage === "file") {
				expect(prepare.mock.calls.some(([sql]) => /vec_distance_l2\s*\(/i.test(sql))).toBe(false);
			}
		},
	);

	it("leaves an empty file-backed store lexical-only without inline vector SQL or inference", async () => {
		// Arrange
		const current = openStore("file");
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
		const prepare = vi.spyOn(current.db, "prepare");

		// Act
		const results = await current.semanticSearchAsync(input);

		// Assert: unavailable catalog admission must not invoke the old parent distance query.
		expect(results).toEqual([]);
		expect(embed).not.toHaveBeenCalled();
		expect(prepare.mock.calls.some(([sql]) => /vec_distance_l2\s*\(/i.test(sql))).toBe(false);
	});
});

describe("default semantic owner lifecycle", () => {
	it("drains admitted embedding work, joins the real worker, and closes SQLite exactly once", async () => {
		// Arrange: observe actual Worker instances without replacing their transport or protocol.
		const current = openStore("file");
		const id = await seed(current);
		const messages = vi.spyOn(Worker.prototype, "postMessage");
		expect((await current.semanticSearchAsync(input)).map((row) => row.id)).toEqual([id]);
		const worker = messages.mock.contexts[0] as Worker | undefined;
		expect(worker).toBeInstanceOf(Worker);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		embed.mockImplementationOnce(async (texts) => {
			entered.resolve();
			await release.promise;
			return texts.map(() => unitVector());
		});
		const closeDatabase = vi.spyOn(current.db, "close");
		const admitted = current.semanticSearchAsync(input);
		const settled = Promise.allSettled([admitted]);
		try {
			await entered.promise;

			// Act
			const closing = current.closeAsync();
			let closed = false;
			void closing.then(() => {
				closed = true;
			});
			expect(current.closeAsync()).toBe(closing);
			await Promise.resolve();

			// Assert: close rejects new admission but keeps the DB alive until parent work finishes.
			expect(closed).toBe(false);
			expect(current.db.open).toBe(true);
			expect(closeDatabase).not.toHaveBeenCalled();
			await expect(current.semanticSearchAsync(input)).rejects.toThrow(/closed/);
			release.resolve();
			await settled;
			await closing;
			await current.closeAsync();
			expect(worker?.threadId).toBe(-1);
			expect(current.db.open).toBe(false);
			expect(closeDatabase).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve();
			await settled;
			await current.closeAsync();
		}
	});

	it("closes an unused owner idempotently and prevents every async pack from reopening it", async () => {
		// Arrange
		const current = openStore("file");
		const closeDatabase = vi.spyOn(current.db, "close");
		const messages = vi.spyOn(Worker.prototype, "postMessage");

		// Act
		const closing = current.closeAsync();
		const repeated = current.closeAsync();
		await closing;

		// Assert
		expect(repeated).toBe(closing);
		expect(closeDatabase).toHaveBeenCalledTimes(1);
		expect(messages).not.toHaveBeenCalled();
		await expect(current.semanticSearchAsync(input)).rejects.toThrow(/closed/);
		await expect(current.buildMemoryPackAsync(query)).rejects.toThrow(/closed/);
		await expect(current.buildMemoryPackWithTraceAsync(query)).rejects.toThrow(/closed/);
		await expect(current.buildMemoryPackTraceAsync(query)).rejects.toThrow(/closed/);
	});
});

describe("default semantic request cancellation", () => {
	it("rejects pre-aborted packs before semantic admission without recording a fallback delivery", async () => {
		// Arrange: retain a keyword hit so swallowed cancellation would cause observable writes.
		const current = openStore("file");
		await seed(current);
		const session = current.startSession({ project: filters.project });
		current.remember(session, "discovery", query, "Matching lexical evidence.", 0.9);
		await current.flushPendingVectorWrites();
		const before = effects(current);
		const semantic = vi.spyOn(current, "semanticSearchAsync");
		const controller = new AbortController();
		controller.abort();
		const options = { signal: controller.signal };

		// Act: execution options are last, after automaticContext, on all three public wrappers.
		const outcomes = await Promise.allSettled([
			current.buildMemoryPackAsync(query, 10, null, filters, undefined, undefined, options),
			current.buildMemoryPackWithTraceAsync(
				query,
				10,
				null,
				filters,
				undefined,
				undefined,
				options,
			),
			current.buildMemoryPackTraceAsync(query, 10, null, filters, undefined, undefined, options),
		]);

		// Assert: cancellation is not a successful keyword-only pack.
		expect(semantic).not.toHaveBeenCalled();
		for (const outcome of outcomes) {
			expect(outcome.status).toBe("rejected");
			if (outcome.status === "rejected") expect(String(outcome.reason)).toMatch(/abort/i);
		}
		expect(effects(current)).toEqual(before);
	});

	it.each([
		"buildMemoryPackAsync",
		"buildMemoryPackWithTraceAsync",
		"buildMemoryPackTraceAsync",
	] as const)(
		"%s forwards an admitted signal and rejects cancellation before assembly",
		async (wrapper) => {
			// Arrange: hold the semantic boundary while a real keyword hit could otherwise be delivered.
			const current = openStore("file");
			const session = current.startSession({ project: filters.project });
			current.remember(session, "discovery", query, "Matching lexical evidence.", 0.9);
			await current.flushPendingVectorWrites();
			const before = effects(current);
			const entered = Promise.withResolvers<AbortSignal | undefined>();
			const release =
				Promise.withResolvers<Awaited<ReturnType<MemoryStore["semanticSearchAsync"]>>>();
			const semantic = vi
				.spyOn(current, "semanticSearchAsync")
				.mockImplementation(async (_input, options) => {
					entered.resolve(options?.signal);
					return release.promise;
				});
			const controller = new AbortController();
			const options = { signal: controller.signal };

			// Act: admit a live signal, then abort before semantic results reach pack assembly.
			const pending = current[wrapper](query, 10, null, filters, undefined, undefined, options);
			const settled = Promise.allSettled([pending]);
			try {
				const passed = await entered.promise;
				expect(passed).toBe(controller.signal);
				expect(passed?.aborted).toBe(false);
				controller.abort();
				release.resolve([]);
				const [outcome] = await settled;

				// Assert: forwarding succeeds, but cancellation prevents keyword delivery and all writes.
				expect(semantic).toHaveBeenCalledTimes(1);
				expect(semantic.mock.calls[0]?.[1]).toBe(options);
				expect(outcome?.status).toBe("rejected");
				if (outcome?.status === "rejected") expect(String(outcome.reason)).toMatch(/abort/i);
				expect(effects(current)).toEqual(before);
			} finally {
				release.resolve([]);
				await settled;
				semantic.mockRestore();
			}
		},
	);
});
