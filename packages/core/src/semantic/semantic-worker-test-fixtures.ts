import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../coordinator-ed25519-key-id-test-fixtures.js";
import { connect, type Database } from "../db.js";
import { type EmbeddingClient, resolveEmbeddingClientVectorIdentityLabel } from "../embeddings.js";
import { ensureVectorSchema } from "../schema-bootstrap.js";
import { MemoryStore } from "../store.js";
import { initTestSchema } from "../test-utils.js";
import type { PackSemanticExecutor } from "./semantic-executor-seam.js";
import { createSemanticExecutor, type SemanticWorkerOptions } from "./semantic-worker-executor.js";
import type { RankOutput, WorkerReply } from "./semantic-worker-protocol.js";
import {
	auditBatch,
	initializeValidatedIndex,
	startAudit,
	writeValidatedBatch,
} from "./validated-vector-index.js";

export const request = {
	query: "worker sentinel",
	limit: 10,
	filters: null,
	automaticContext: undefined,
};

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

export function unitVector(first = 1): Float32Array {
	const vector = new Float32Array(384);
	vector[0] = first;
	vector[1] = Math.sqrt(1 - first * first);
	return vector;
}

function offlineClient(): EmbeddingClient {
	const model = "fixture/offline-semantic";
	return {
		model,
		dimensions: 384,
		identity: {
			package: "@huggingface/transformers",
			version: "4.0.0",
			model,
			revision: "1".repeat(40),
			requestedRevision: "1".repeat(40),
			dtype: "fp32",
			device: "cpu",
			pooling: "mean",
			normalization: "l2",
			dimensions: 384,
		},
		// A fixed numerical ranking fixture, not a simulation of text understanding.
		embed: vi.fn(async (texts: string[]) => texts.map(() => unitVector())),
	};
}

export function seedVector(
	db: Database,
	id: number,
	client: EmbeddingClient,
	first: number,
	chunk = 0,
	options: { model?: string; mode?: "append" | "replace-memory-model" } = {},
) {
	const model = options.model ?? resolveEmbeddingClientVectorIdentityLabel(client);
	writeValidatedBatch(db, {
		writerVersion: 1,
		expectedModel: model,
		model,
		expectedCount: 1,
		mode: options.mode ?? "append",
		rows: [
			{
				memoryId: id,
				chunkIndex: chunk,
				contentHash: `fixture-${id}-${chunk}`,
				vector: unitVector(first),
			},
		],
	});
}

export function finishFixtureAudit(db: Database, models: string[]) {
	startAudit(db, { knownModels: models });
	const result = auditBatch(db, { limit: 100 });
	if (result.remaining !== 0 || result.catalog.status !== "ready")
		throw new Error("fixture audit did not finish ready");
	return result.catalog;
}

interface Fixture {
	directory: string;
	store: MemoryStore;
	client: EmbeddingClient;
	ids: { semantic: number; keyword: number; hidden: number };
	openExecutor(options?: Partial<Omit<SemanticWorkerOptions, "store">>): PackSemanticExecutor;
}

interface FixtureOptions {
	initializeIndex?: boolean;
	additionalKnownModels?: readonly string[];
}

export function useSemanticWorkerFixture(options: FixtureOptions = {}): Fixture {
	const fixture = {} as Fixture;
	const executors: PackSemanticExecutor[] = [];
	beforeEach(() => {
		fixture.directory = mkdtempSync(join(tmpdir(), "codemem-worker-integration-"));
		for (const key of Object.keys(process.env).filter((key) => key.startsWith("CODEMEM_")))
			vi.stubEnv(key, "");
		for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"])
			vi.stubEnv(key, fixture.directory);
		vi.stubEnv("CODEMEM_CONFIG", join(fixture.directory, "config.json"));
		vi.stubEnv("CODEMEM_KEYS_DIR", join(fixture.directory, "keys"));
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
		vi.stubEnv("CODEMEM_DEVICE_ID", "worker-fixture");
		vi.stubEnv("CODEMEM_ACTOR_ID", "local:worker-fixture");
		vi.stubEnv("CODEMEM_ACTOR_DISPLAY_NAME", "Fixture actor");
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
		vi.stubEnv("CODEMEM_EMBEDDING_MODEL", "fixture/offline-semantic");
		vi.stubEnv("CODEMEM_EMBEDDING_REVISION", "1".repeat(40));
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fixture forbids network"));
		vi.spyOn(MemoryStore.prototype, "enqueueVectorWrite").mockImplementation(() => {});
		writeFileSync(join(fixture.directory, "index.html"), "<!doctype html><title>fixture</title>");
		vi.stubEnv("CODEMEM_VIEWER_STATIC_DIR", fixture.directory);
		const path = join(fixture.directory, "memory.sqlite");
		const db = connect(path);
		initTestSchema(db);
		db.close();
		fixture.store = new MemoryStore(path, {
			runtimeSigningKey: { deviceId: "worker-fixture", publicKey: CANONICAL_PUBLIC_KEY },
		});
		fixture.client = offlineClient();
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "0");
		ensureVectorSchema(fixture.store.db);
		initializeFixtureVectors(fixture, options);
		fixture.openExecutor = (options = {}) => {
			const executor = createSemanticExecutor({
				store: fixture.store,
				getClient: async () => fixture.client,
				queueOptions: { requestMs: 10_000, readinessMs: 5_000, shutdownMs: 500 },
				...options,
			});
			executors.push(executor);
			return executor;
		};
	});
	afterEach(async () => {
		try {
			await Promise.all(executors.splice(0).map((executor) => executor.close()));
		} finally {
			fixture.store?.close();
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			rmSync(fixture.directory, { recursive: true, force: true });
		}
	});
	return fixture;
}

function initializeFixtureVectors(fixture: Fixture, options: FixtureOptions) {
	if (options.initializeIndex !== false)
		initializeValidatedIndex(fixture.store.db, { allWritersUpgraded: true, writerVersion: 1 });
	seedMemories(fixture, { seedVectors: options.initializeIndex !== false });
	if (options.initializeIndex !== false)
		finishFixtureAudit(fixture.store.db, [
			resolveEmbeddingClientVectorIdentityLabel(fixture.client),
			...(options.additionalKnownModels ?? []),
		]);
}

function seedMemories(f: Fixture, options: { seedVectors: boolean }) {
	const session = f.store.startSession({ cwd: f.directory, project: "worker-fixture" });
	f.ids = {
		semantic: f.store.remember(
			session,
			"discovery",
			"Independent concept",
			"A separate stored lesson",
			0.9,
		),
		keyword: f.store.remember(
			session,
			"discovery",
			"Worker sentinel",
			"Worker sentinel keyword lesson",
			0.8,
		),
		hidden: f.store.remember(session, "discovery", "Hidden nearest", "Hidden stored lesson", 0.9),
	};
	f.store.db
		.prepare(
			"UPDATE memory_items SET scope_id = 'fixture-hidden', origin_device_id = 'foreign-device' WHERE id = ?",
		)
		.run(f.ids.hidden);
	if (!options.seedVectors) return;
	seedVector(f.store.db, f.ids.semantic, f.client, 0.9);
	seedVector(f.store.db, f.ids.semantic, f.client, 0.1, 1);
	seedVector(f.store.db, f.ids.keyword, f.client, 0.5);
	seedVector(f.store.db, f.ids.hidden, f.client, 1);
}

/** Pause delivery after actual worker SQL completes, without sleeps or CPU work. */
export function resultBarrier(store: MemoryStore, options: { pauseFirstOnly?: boolean } = {}) {
	const ranked = deferred<void>();
	let deliver = () => {};
	let released = false;
	let output: RankOutput | null | undefined;
	const createWorker: NonNullable<SemanticWorkerOptions["createWorker"]> = (events) => {
		const stat = statSync(store.dbPath);
		const worker = new Worker(new URL("./semantic-worker-entry.ts", import.meta.url), {
			workerData: { dbPath: store.dbPath, fileIdentity: `${stat.dev}:${stat.ino}` },
			env: {},
			execArgv: ["--experimental-transform-types"],
		});
		worker.on("error", (error) => {
			ranked.reject(error);
			events.failure(error);
		});
		worker.on("exit", events.exit);
		worker.on("message", (reply: WorkerReply) => {
			if (reply.type !== "result" || (options.pauseFirstOnly && released)) {
				events.message(reply);
				return;
			}
			deliver = () => events.message(reply);
			output = reply.output;
			ranked.resolve();
		});
		return worker;
	};
	return {
		createWorker,
		ranked: ranked.promise,
		output: () => output,
		release: () => {
			released = true;
			deliver();
		},
	};
}

/** A foreign replica has no local-creation proof or local-origin exemption. */
export function seedForeignScopeReplica(fixture: Fixture, authority: "invite" | "coordinator") {
	const { store, client } = fixture;
	const scopeId = `fixture-${authority}-scope`;
	store.db
		.prepare(`INSERT INTO replication_scopes
		(scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
		VALUES (?, 'Fixture scope', 'team', ?, 'fixture-coordinator', 'fixture-group', 1, 'active', '2026-01-01', '2026-01-01')`)
		.run(scopeId, authority);
	store.db
		.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		VALUES (?, ?, 'member', 'active', 1, '2026-01-01')`)
		.run(scopeId, store.deviceId);
	const sessionId = (
		store.db
			.prepare("SELECT session_id FROM memory_items WHERE id = ?")
			.get(fixture.ids.semantic) as { session_id: number }
	).session_id;
	const memoryId = Number(
		store.db
			.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, scope_id, origin_device_id, import_key)
		VALUES (?, 'discovery', 'Foreign scope candidate', 'Foreign replica lesson', 0.8, '', 1, '2026-01-01', '2026-01-01', '{}', ?, 'foreign-replica-device', ?)`)
			.run(sessionId, scopeId, `fixture-foreign-${authority}`).lastInsertRowid,
	);
	seedVector(store.db, memoryId, client, 0.95);
	return { scopeId, memoryId };
}
