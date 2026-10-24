import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { loadSqliteVec } from "./db.js";
import {
	_resetEmbeddingRuntimeFactory,
	_setEmbeddingRuntimeFactory,
	type EmbeddingClient,
	resolveEmbeddingClientVectorIdentityLabel,
} from "./embeddings.js";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import {
	createFixture,
	MODEL,
	type RankingFixture,
	vector,
} from "./semantic/semantic-ranking.test-helper.js";
import { auditBatch, startAudit } from "./semantic/validated-vector-index-audit.js";
import { readCatalog, readState } from "./semantic/validated-vector-index-state.js";
import { MemoryStore } from "./store.js";
import { VectorIndexMaintenance } from "./vector-index-maintenance.js";
import { ensureVectorIndexReady } from "./vector-index-upgrade.js";
import { prepareVectorWrites } from "./vector-writes.js";
import { backfillVectors } from "./vectors.js";

vi.mock("node:timers/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:timers/promises")>();
	return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

let directory: string;
let fixture: RankingFixture;
let store: MemoryStore | undefined;
const drivers: VectorIndexMaintenance[] = [];
const connections: Database.Database[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-vector-maintenance-"));
	for (const key of Object.keys(process.env).filter((key) => key.startsWith("CODEMEM_")))
		vi.stubEnv(key, "");
	for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"])
		vi.stubEnv(key, directory);
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_DEVICE_ID", "fixture-device");
	vi.stubEnv("CODEMEM_ACTOR_ID", "local:fixture-device");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
	vi.stubEnv("HF_HUB_OFFLINE", "1");
	vi.stubEnv("TRANSFORMERS_OFFLINE", "1");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("test forbids network"));
	fixture = createFixture(directory);
	fixture.db.pragma("journal_mode = WAL");
	fixture.db.pragma("busy_timeout = 0");
	connections.push(fixture.db);
});

afterEach(async () => {
	try {
		for (const db of connections) if (db.inTransaction) db.exec("ROLLBACK");
		await Promise.allSettled(drivers.splice(0).map((driver) => driver.close()));
		await store?.closeAsync();
	} finally {
		store = undefined;
		_resetEmbeddingRuntimeFactory();
		vi.mocked(setTimeout).mockReset();
		vi.restoreAllMocks();
		for (const db of connections.splice(0)) if (db.open) db.close();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	}
});

function openStore(): MemoryStore {
	store = new MemoryStore(fixture.path, {
		keysDir: join(directory, "keys"),
		runtimeSigningKey: { deviceId: "fixture-device", publicKey: CANONICAL_PUBLIC_KEY },
	});
	return store;
}

function maintenance(): VectorIndexMaintenance {
	const driver = new VectorIndexMaintenance(fixture.db, () => false);
	drivers.push(driver);
	return driver;
}

function pendingAudit(): number {
	const id = fixture.memory();
	fixture.rawVector(id, vector(1));
	ensureVectorIndexReady(fixture.db, { configuredModel: MODEL });
	startAudit(fixture.db, { knownModels: [MODEL] });
	return id;
}

async function checkpoint(predicate: () => boolean): Promise<void> {
	for (let step = 0; step < 20; step++) {
		if (predicate()) return;
		await setImmediate();
	}
	expect(
		predicate(),
		"maintenance did not reach its state checkpoint within 20 explicit turns",
	).toBe(true);
}

function version(memoryId: number, model = MODEL) {
	return fixture.db
		.prepare("SELECT version,count FROM validated_vector_versions WHERE memory_id=? AND model=?")
		.get(memoryId, model) as { version: number; count: number };
}

function recoveryClient(): EmbeddingClient {
	const model = "fixture/offline-recovery";
	const revision = "0123456789abcdef0123456789abcdef01234567";
	return {
		model,
		dimensions: 384,
		identity: {
			package: "@huggingface/transformers",
			version: "4.2.0",
			model,
			revision,
			requestedRevision: revision,
			dtype: "fp32",
			device: "cpu",
			pooling: "mean",
			normalization: "l2",
			dimensions: 384,
		},
		embed: vi.fn(async (texts: string[]) => texts.map(() => vector(1))),
	};
}

describe("vector maintenance ownership", () => {
	it("keeps a reopened building index synchronous until an async owner requests maintenance", async () => {
		// Arrange: first close the ordinary owner, then persist pending work on our own connection.
		const id = fixture.memory();
		fixture.rawVector(id, vector(1));
		ensureVectorIndexReady(fixture.db, { configuredModel: MODEL });
		await openStore().closeAsync();
		startAudit(fixture.db, { knownModels: [MODEL] });
		const before = readState(fixture.db);
		const rows = fixture.db.prepare("SELECT * FROM validated_vector_rows ORDER BY rowid").all();

		// Act
		const reopened = openStore();
		reopened.stats();
		reopened.search("Fixture", 10);
		const syncClose = () => reopened.close();

		// Assert: merely opening/searching must neither schedule a batch nor require async close.
		expect(syncClose).not.toThrow();
		await setImmediate();
		expect(readState(fixture.db)).toEqual(before);
		expect(fixture.db.prepare("SELECT * FROM validated_vector_rows ORDER BY rowid").all()).toEqual(
			rows,
		);
		expect(getMaintenanceJob(fixture.db, "vector_index_validation")).toBeNull();
	});

	it("audits pending rows when explicitly scheduled and closes without stale work", async () => {
		// Arrange
		pendingAudit();
		const driver = maintenance();
		expect(readState(fixture.db).pending_count).toBe(1);

		// Act
		driver.schedule();
		await checkpoint(() => readState(fixture.db).status === "ready");
		await driver.close();

		// Assert
		expect(readCatalog(fixture.db)).toMatchObject({
			status: "ready",
			models: [{ model: MODEL, count: 1 }],
		});
		expect(readState(fixture.db)).toMatchObject({ pending_count: 0, invalid_count: 0 });
		expect(getMaintenanceJob(fixture.db, "vector_index_validation")?.status).toBe("completed");
		expect(driver.requiresAsyncClose).toBe(false);
	});
});

describe("vector producer maintenance ownership", () => {
	it.each(["building", "needsrepair"] as const)(
		"flushes a committed producer write with a %s index without requiring async close",
		async (status) => {
			// Arrange: only explicit fixture work determines whether old rows await audit or declaration.
			const client = recoveryClient();
			const model = resolveEmbeddingClientVectorIdentityLabel(client);
			vi.stubEnv("CODEMEM_EMBEDDING_MODEL", client.model);
			vi.stubEnv("CODEMEM_EMBEDDING_REVISION", client.identity?.revision);
			fixture.rawVector(fixture.memory(), vector(1), 0, model);
			const unknownId = fixture.memory();
			const unknown = fixture.rawVector(unknownId, vector(1), 0, "undeclared-model");
			ensureVectorIndexReady(fixture.db, { configuredModel: model });
			if (status === "building") startAudit(fixture.db, { knownModels: [model] });
			_setEmbeddingRuntimeFactory(async () => client);
			const current = openStore();
			const session = current.startSession({ project: "producer-regression" });

			// Act: remember uses enqueueCommittedVectorWrites and its real post-commit embedding queue.
			const id = current.remember(
				session,
				"decision",
				"Producer write",
				"Persist before closing.",
				0.9,
			);
			await current.flushPendingVectorWrites();
			const source = fixture.db.prepare("SELECT * FROM memory_items ORDER BY id").all();
			const before = readState(fixture.db);
			const indexed = fixture.db
				.prepare("SELECT * FROM validated_vector_rows ORDER BY rowid")
				.all();

			// Assert: a completed producer cannot silently create a new async maintenance owner.
			expect(client.embed).toHaveBeenCalledTimes(1);
			expect(
				fixture.db.prepare("SELECT title,body_text FROM memory_items WHERE id=?").get(id),
			).toEqual({ title: "Producer write", body_text: "Persist before closing." });
			expect(version(id, model).count).toBe(1);
			expect(before.status).toBe(status);
			expect(() => current.close()).not.toThrow();
			await setImmediate();
			expect(readState(fixture.db)).toEqual(before);
			expect(
				fixture.db.prepare("SELECT * FROM validated_vector_rows ORDER BY rowid").all(),
			).toEqual(indexed);
			expect(fixture.db.prepare("SELECT * FROM memory_items ORDER BY id").all()).toEqual(source);
			expect(
				fixture.db.prepare("SELECT rowid FROM memory_vectors WHERE rowid=?").all(BigInt(unknown)),
			).toEqual([{ rowid: unknown }]);
			expect(getMaintenanceJob(fixture.db, "vector_index_validation")).toBeNull();
		},
	);
});

describe("vector maintenance writer contention", () => {
	it("recovers from a real competing WAL writer without a sticky close failure", async () => {
		// Arrange: hold only the retry deadline; SQLite and event-loop yields remain real.
		pendingAudit();
		const before = readState(fixture.db);
		const locker = new Database(fixture.path);
		loadSqliteVec(locker);
		connections.push(locker);
		locker.exec("BEGIN IMMEDIATE");
		const blocked = Promise.withResolvers<void>();
		const retry = Promise.withResolvers<void>();
		vi.mocked(setTimeout).mockImplementationOnce(async () => {
			blocked.resolve();
			await retry.promise;
		});
		const driver = maintenance();

		// Act: one audit turn must meet the held lock before it is released.
		driver.schedule();
		try {
			await blocked.promise;
			expect(setTimeout).toHaveBeenCalledWith(25);
			expect(readState(fixture.db)).toEqual(before);
			locker.exec("ROLLBACK");
			retry.resolve();
			await checkpoint(() => readState(fixture.db).status === "ready");

			// Assert: releasing contention resumes the same pending data, not a discarded generation.
			await expect(driver.close()).resolves.toBeUndefined();
			expect(readState(fixture.db)).toMatchObject({
				generation_id: before.generation_id,
				pending_count: 0,
				invalid_count: 0,
			});
			expect(readCatalog(fixture.db)?.models).toEqual([{ model: MODEL, count: 1 }]);
			expect(getMaintenanceJob(fixture.db, "vector_index_validation")?.status).toBe("completed");
		} finally {
			if (locker.inTransaction) locker.exec("ROLLBACK");
			retry.resolve();
			await driver.close();
		}
	});

	it("fails an audit batch atomically under a writer lock and permits a clean retry", () => {
		// Arrange
		pendingAudit();
		const before = readState(fixture.db);
		const rows = fixture.db.prepare("SELECT * FROM validated_vector_rows ORDER BY rowid").all();
		const locker = new Database(fixture.path);
		connections.push(locker);
		locker.exec("BEGIN IMMEDIATE");
		let error: unknown;
		const prepare = vi.spyOn(fixture.db, "prepare");

		// Act
		try {
			auditBatch(fixture.db, { limit: 250 });
		} catch (caught) {
			error = caught;
		}
		locker.exec("ROLLBACK");

		// Assert: rejected acquisition cannot partially validate rows or alter counts.
		expect(error).toMatchObject({ code: "SQLITE_BUSY" });
		expect(prepare).not.toHaveBeenCalled();
		prepare.mockRestore();
		expect(fixture.db.inTransaction).toBe(false);
		expect(readState(fixture.db)).toEqual(before);
		expect(fixture.db.prepare("SELECT * FROM validated_vector_rows ORDER BY rowid").all()).toEqual(
			rows,
		);
		expect(auditBatch(fixture.db, { limit: 250 }).catalog.status).toBe("ready");
	});
});

describe("vector maintenance derived-row pruning", () => {
	it("prunes known-model bad norms and orphans in pages without changing good bytes or memories", async () => {
		// Arrange: all invalid bytes enter through the legacy layout, before production cutover.
		const goodId = fixture.memory();
		const good = fixture.rawVector(goodId, vector(1));
		const badId = fixture.memory();
		for (let chunk = 0; chunk < 251; chunk++) fixture.rawVector(badId, vector(3), chunk);
		const orphanId = 999999;
		fixture.rawVector(orphanId, vector(1));
		ensureVectorIndexReady(fixture.db, { configuredModel: MODEL });
		const bytes = fixture.db
			.prepare("SELECT embedding FROM memory_vectors WHERE rowid=?")
			.pluck()
			.get(BigInt(good)) as Buffer;
		const memories = fixture.db.prepare("SELECT * FROM memory_items ORDER BY id").all();
		const badVersion = version(badId);
		const orphanVersion = version(orphanId);
		const goodVersion = version(goodId);
		const driver = maintenance();

		// Act
		driver.schedule();
		await setImmediate();
		expect(readState(fixture.db).invalid_count).toBe(2);
		await checkpoint(() => readState(fixture.db).status === "ready");
		await driver.close();

		// Assert: derived-row retirement bumps candidate versions and never edits source content.
		expect(fixture.db.prepare("SELECT rowid FROM memory_vectors ORDER BY rowid").all()).toEqual([
			{ rowid: good },
		]);
		const retained = fixture.db
			.prepare("SELECT embedding FROM memory_vectors WHERE rowid=?")
			.pluck()
			.get(BigInt(good)) as Buffer;
		expect(retained.equals(bytes)).toBe(true);
		expect(fixture.db.prepare("SELECT * FROM memory_items ORDER BY id").all()).toEqual(memories);
		expect(version(badId)).toEqual({ version: badVersion.version + 251, count: 0 });
		expect(version(orphanId)).toEqual({ version: orphanVersion.version + 1, count: 0 });
		expect(version(goodId)).toEqual(goodVersion);
		fixture.db
			.transaction(() =>
				prepareVectorWrites(fixture.db)({
					insert: {
						model: MODEL,
						expectedCount: 1,
						rows: [
							{ memoryId: badId, chunkIndex: 0, contentHash: "replacement", vector: vector(1) },
						],
					},
				}),
			)
			.immediate();
		expect(version(badId)).toEqual({ version: badVersion.version + 252, count: 1 });
		expect(readState(fixture.db)).toMatchObject({
			status: "ready",
			pending_count: 0,
			invalid_count: 0,
		});
	});

	it("retains unknown-model rows without scheduling writes, then audits an explicit declaration", async () => {
		// Arrange: model rejection takes precedence over norm rejection until that model is declared.
		const id = fixture.memory();
		const good = fixture.rawVector(id, vector(1));
		const unknown = fixture.rawVector(id, vector(3), 1, "undeclared-model");
		ensureVectorIndexReady(fixture.db, { configuredModel: MODEL });
		const bytes = fixture.db
			.prepare("SELECT embedding FROM memory_vectors WHERE rowid=?")
			.pluck()
			.get(BigInt(unknown)) as Buffer;
		const memories = fixture.db.prepare("SELECT * FROM memory_items ORDER BY id").all();
		const original = version(id, "undeclared-model");
		const driver = maintenance();
		const changes = fixture.db.prepare("SELECT total_changes()").pluck().get();
		const transactions = vi.spyOn(fixture.db, "transaction");

		// Act: repeated async-query admission checks must remain read-only for model-only rejection.
		for (let request = 0; request < 3; request++) {
			driver.schedule();
			expect(driver.requiresAsyncClose).toBe(false);
			await setImmediate();
		}
		await driver.close();

		// Assert: the unknown row remains byte-identical and stable across further event-loop turns.
		expect(transactions).not.toHaveBeenCalled();
		transactions.mockRestore();
		expect(fixture.db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
		expect(getMaintenanceJob(fixture.db, "vector_index_validation")).toBeNull();
		expect(readState(fixture.db)).toMatchObject({ status: "needsrepair", invalid_count: 1 });
		expect(fixture.db.prepare("SELECT rowid FROM memory_vectors ORDER BY rowid").all()).toEqual([
			{ rowid: good },
			{ rowid: unknown },
		]);
		const retained = fixture.db
			.prepare("SELECT embedding FROM memory_vectors WHERE rowid=?")
			.pluck()
			.get(BigInt(unknown)) as Buffer;
		expect(retained.equals(bytes)).toBe(true);
		expect(version(id, "undeclared-model")).toEqual(original);
		const stable = readState(fixture.db);
		await setImmediate();
		expect(readState(fixture.db)).toEqual(stable);
		fixture.db
			.transaction(() => {
				startAudit(fixture.db, { knownModels: [MODEL, "undeclared-model"] });
			})
			.immediate();
		const next = maintenance();
		next.schedule();
		await checkpoint(() => readState(fixture.db).status === "ready");
		await next.close();
		expect(fixture.db.prepare("SELECT rowid FROM memory_vectors ORDER BY rowid").all()).toEqual([
			{ rowid: good },
		]);
		expect(version(id, "undeclared-model").version).toBeGreaterThan(original.version);
		expect(fixture.db.prepare("SELECT * FROM memory_items ORDER BY id").all()).toEqual(memories);
	});
});

describe("vector maintenance repair eligibility cache", () => {
	it("reuses a model-only rejection census across valid writes but rechecks a new generation", async () => {
		// Arrange: the undeclared row has a bad norm that becomes repairable only after declaration.
		const goodId = fixture.memory();
		const good = fixture.rawVector(goodId, vector(1));
		const badId = fixture.memory();
		const unknown = fixture.rawVector(badId, vector(3), 0, "undeclared-model");
		ensureVectorIndexReady(fixture.db, { configuredModel: MODEL });
		const source = fixture.db.prepare("SELECT * FROM memory_items ORDER BY id").all();
		const bytes = fixture.db
			.prepare("SELECT embedding FROM memory_vectors WHERE rowid=?")
			.pluck()
			.get(BigInt(good)) as Buffer;
		const before = readState(fixture.db);
		const changes = fixture.db.prepare("SELECT total_changes()").pluck().get();
		const prepare = vi.spyOn(fixture.db, "prepare");
		const transactions = vi.spyOn(fixture.db, "transaction");
		const eligibilityReads = () =>
			prepare.mock.calls.filter(([sql]) => /reason\s+IS\s+NOT\s+'model'/i.test(sql)).length;
		const driver = maintenance();

		// Act: only the first admission should scan the generation's invalid-row reasons.
		driver.schedule();
		expect(eligibilityReads()).toBe(1);
		for (let request = 0; request < 3; request++) driver.schedule();
		expect(driver.requiresAsyncClose).toBe(false);
		expect(eligibilityReads()).toBe(1);
		expect(transactions).not.toHaveBeenCalled();
		expect(fixture.db.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
		fixture.db
			.transaction(() =>
				prepareVectorWrites(fixture.db)({
					insert: {
						model: MODEL,
						expectedCount: 1,
						rows: [
							{ memoryId: goodId, chunkIndex: 1, contentHash: "valid-addition", vector: vector(1) },
						],
					},
				}),
			)
			.immediate();
		transactions.mockClear();
		const afterWrite = readState(fixture.db);
		for (let request = 0; request < 3; request++) driver.schedule();

		// Assert: revision alone cannot invalidate a census of unchanged invalid rows.
		expect(afterWrite.revision).toBeGreaterThan(before.revision);
		expect(afterWrite.generation_id).toBe(before.generation_id);
		expect(afterWrite.invalid_count).toBe(before.invalid_count);
		expect(eligibilityReads()).toBe(1);
		expect(driver.requiresAsyncClose).toBe(false);
		expect(transactions).not.toHaveBeenCalled();
		expect(getMaintenanceJob(fixture.db, "vector_index_validation")).toBeNull();
		transactions.mockRestore();
		startAudit(fixture.db, { knownModels: [MODEL, "undeclared-model"] });
		auditBatch(fixture.db, { limit: 250 });
		const declared = readState(fixture.db);
		expect(declared.generation_id).not.toBe(before.generation_id);
		expect(declared.invalid_count).toBe(before.invalid_count);
		expect(
			fixture.db.prepare("SELECT reason FROM validated_vector_rows WHERE rowid=?").get(unknown),
		).toEqual({ reason: "norm" });
		driver.schedule();
		await checkpoint(() => readState(fixture.db).status === "ready");
		await driver.close();
		expect(eligibilityReads()).toBeGreaterThan(1);
		expect(
			fixture.db.prepare("SELECT rowid FROM memory_vectors WHERE memory_id=?").all(badId),
		).toEqual([]);
		expect(version(badId, "undeclared-model").count).toBe(0);
		const retained = fixture.db
			.prepare("SELECT embedding FROM memory_vectors WHERE rowid=?")
			.pluck()
			.get(BigInt(good)) as Buffer;
		expect(retained.equals(bytes)).toBe(true);
		expect(readCatalog(fixture.db)?.models).toEqual([{ model: MODEL, count: 2 }]);
		expect(fixture.db.prepare("SELECT * FROM memory_items ORDER BY id").all()).toEqual(source);
	});
});

describe("production recovery of whitespace-only legacy content hashes", () => {
	it.each([
		["tab", "\t"],
		["newline", "\n"],
		["mixed whitespace", " \t\r\n "],
		["non-breaking space", "\u00a0"],
	])("prunes a %s hash and backfills only the affected memory", async (_label, hash) => {
		// Arrange: malformed metadata enters only through the legacy table before cutover.
		const client = recoveryClient();
		const model = resolveEmbeddingClientVectorIdentityLabel(client);
		const goodId = fixture.memory();
		const good = fixture.rawVector(goodId, vector(1), 0, model);
		const badId = fixture.memory();
		const bad = fixture.rawVector(badId, vector(1), 0, model);
		fixture.db
			.prepare("UPDATE memory_vectors SET content_hash=? WHERE rowid=?")
			.run(hash, BigInt(bad));
		const source = fixture.db.prepare("SELECT * FROM memory_items ORDER BY id").all();
		const bytes = fixture.db
			.prepare("SELECT embedding FROM memory_vectors WHERE rowid=?")
			.pluck()
			.get(BigInt(good)) as Buffer;
		ensureVectorIndexReady(fixture.db, { configuredModel: model });
		const original = version(badId, model);
		const incumbent = version(goodId, model);
		expect(
			fixture.db
				.prepare("SELECT audit_state,reason FROM validated_vector_rows WHERE rowid=?")
				.get(bad),
		).toEqual({ audit_state: "invalid", reason: "metadata" });
		const driver = maintenance();

		// Act: production maintenance retires the derived row; supported backfill re-embeds its source.
		driver.schedule();
		await checkpoint(() => readState(fixture.db).status === "ready");
		await driver.close();
		expect(version(badId, model)).toEqual({ version: original.version + 1, count: 0 });
		expect(
			fixture.db.prepare("SELECT rowid FROM memory_vectors WHERE memory_id=?").all(badId),
		).toEqual([]);
		expect(
			fixture.db.prepare("SELECT rowid FROM validated_vector_rows WHERE memory_id=?").all(badId),
		).toEqual([]);
		const result = await backfillVectors(fixture.db, { client, memoryIds: [badId] });
		const followup = maintenance();
		followup.schedule();
		await checkpoint(() => readState(fixture.db).status === "ready");
		await followup.close();

		// Assert: recovery creates current valid chunks without touching the valid incumbent or source.
		expect(result).toMatchObject({ checked: 1, embedded: 1, inserted: 1 });
		expect(client.embed).toHaveBeenCalledTimes(1);
		const recovered = fixture.db
			.prepare(
				"SELECT chunk_index,content_hash,model,audit_state,reason FROM validated_vector_rows WHERE memory_id=?",
			)
			.all(badId);
		expect(recovered).toEqual([
			{
				chunk_index: 0,
				content_hash: expect.stringMatching(/\S/),
				model,
				audit_state: "valid",
				reason: null,
			},
		]);
		const replacement = fixture.db
			.prepare("SELECT embedding FROM memory_vectors WHERE memory_id=?")
			.pluck()
			.get(badId) as Buffer;
		expect(replacement.equals(Buffer.from(vector(1).buffer))).toBe(true);
		expect(version(badId, model)).toEqual({ version: original.version + 2, count: 1 });
		expect(version(goodId, model)).toEqual(incumbent);
		expect(
			fixture.db.prepare("SELECT rowid FROM memory_vectors WHERE memory_id=?").all(goodId),
		).toEqual([{ rowid: good }]);
		const retained = fixture.db
			.prepare("SELECT embedding FROM memory_vectors WHERE rowid=?")
			.pluck()
			.get(BigInt(good)) as Buffer;
		expect(retained.equals(bytes)).toBe(true);
		expect(fixture.db.prepare("SELECT * FROM memory_items ORDER BY id").all()).toEqual(source);
		expect(readState(fixture.db)).toMatchObject({
			status: "ready",
			pending_count: 0,
			invalid_count: 0,
		});
		expect(readCatalog(fixture.db)?.models).toEqual([{ model, count: 2 }]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
