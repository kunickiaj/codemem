import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";
import { type Database, isEmbeddingDisabled } from "../db.js";
import {
	type EmbeddingClient,
	embedTexts,
	getEmbeddingClient,
	resolveEmbeddingClientVectorIdentityLabel,
	resolveEmbeddingModel,
	tryResolveEmbeddingRevision,
} from "../embeddings.js";
import { buildFilterClausesWithContext } from "../filters.js";
import { ownershipFilterContext, type StoreHandle } from "../search.js";
import { semanticResult } from "../semantic-query.js";
import { summaryContinuityFilter } from "../summary-memory.js";
import type { SemanticSearchResult } from "../vectors.js";
import {
	type PackSemanticExecutor,
	SemanticIdentityChangedError,
} from "./semantic-executor-seam.js";
import { resolveCatalogModels } from "./semantic-ranking.js";
import type { RankOutput, RuntimeProof, WorkerReply } from "./semantic-worker-protocol.js";
import {
	createSemanticWorkerQueue,
	type QueueOptions,
	type SemanticWorkerErrorCode,
	type WorkerEvents,
} from "./semantic-worker-queue.js";
import { contentIdentity, summarySessionId } from "./semantic-worker-ranking.js";
import {
	type CandidateVersion,
	isSearchableVectorCatalog,
	readCandidateVersions,
	readCatalog,
	readSearchableModelLabels,
	type VectorCatalog,
} from "./validated-vector-index.js";

export interface SemanticWorkerOptions {
	store: StoreHandle & {
		hasCurrentIdentity(): boolean;
		onIdentityChanged?(listener: () => void): () => void;
	};
	getClient?: () => Promise<EmbeddingClient | null>;
	queueOptions?: Omit<QueueOptions, "createWorker">;
	/** Lifecycle fault injection only; normal fixtures use the real worker. */
	createWorker?: QueueOptions["createWorker"];
}

function fileIdentity(path: string): string {
	const stat = statSync(path);
	if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
		throw new Error("semantic_worker_owned_file_required");
	}
	return `${stat.dev}:${stat.ino}`;
}

function assertCommittedStore(db: Database): void {
	if (db.inTransaction) throw new Error("semantic_worker_uncommitted_store");
}

function configuredModel(): string {
	return JSON.stringify([resolveEmbeddingModel(), tryResolveEmbeddingRevision()]);
}

interface SearchState {
	generationId: string;
	models: string[];
	model: string;
	embeddingIdentity: string;
	client: EmbeddingClient | null;
}

function cloneRequest(input: Parameters<PackSemanticExecutor["search"]>[0]) {
	if (input.query.length > 32_768 || JSON.stringify(input).length > 65_536) {
		throw new Error("semantic_worker_payload_limit");
	}
	return structuredClone(input);
}

type RuntimeIdentity = Pick<RuntimeProof, "actorId" | "deviceId">;

function captureIdentity(store: SemanticWorkerOptions["store"]): RuntimeIdentity {
	if (!store.hasCurrentIdentity()) throw new SemanticIdentityChangedError();
	return { actorId: store.actorId, deviceId: store.deviceId };
}

function captureProof(
	store: SemanticWorkerOptions["store"],
	identity = captureIdentity(store),
): RuntimeProof {
	const context = store.scopeResolutionDeviceContext?.();
	return {
		...identity,
		expectedPublicKey: context?.expectedPublicKey ?? context?.loadExpectedPublicKey?.(),
	};
}

function assertIdentity(store: SemanticWorkerOptions["store"], proof: RuntimeProof): void {
	const current = captureIdentity(store);
	if (current.actorId !== proof.actorId || current.deviceId !== proof.deviceId) {
		throw new SemanticIdentityChangedError();
	}
}

function assertProof(store: SemanticWorkerOptions["store"], proof: RuntimeProof): void {
	if (JSON.stringify(captureProof(store)) !== JSON.stringify(proof))
		throw new SemanticIdentityChangedError();
}

function assertCompletion(
	store: SemanticWorkerOptions["store"],
	proof: RuntimeProof,
	dbPath: string,
	identity: string,
): void {
	assertProof(store, proof);
	assertDatabaseIdentity(store, dbPath, identity);
}

function assertDatabaseIdentity(
	store: SemanticWorkerOptions["store"],
	dbPath: string,
	identity: string,
): void {
	try {
		if (realpathSync(store.db.name) === dbPath && fileIdentity(dbPath) === identity) return;
	} catch {
		// Removal/replacement cannot become a successful keyword-only delivery.
	}
	throw new SemanticIdentityChangedError();
}

function readyCatalog(db: Database): VectorCatalog | null {
	const catalog = readCatalog(db);
	if (!isSearchableVectorCatalog(db, catalog)) return null;
	return catalog.models.some((entry) => entry.count > 0) ? catalog : null;
}

function currentCatalog(db: Database): VectorCatalog | null {
	assertCommittedStore(db);
	return readyCatalog(db);
}

/** Metadata-only admission check; construction never starts a worker. */
export function hasReadySemanticCatalog(db: Database): boolean {
	return currentCatalog(db) !== null;
}

function catalogModels(db: Database, catalog: VectorCatalog | null, identity: string): string[] {
	if (!catalog) return [];
	return resolveCatalogModels(identity, readSearchableModelLabels(db, catalog), catalog.migration);
}

function matchingCatalog(db: Database, state: SearchState): VectorCatalog | null {
	const catalog = currentCatalog(db);
	return catalog?.generationId === state.generationId ? catalog : null;
}

function transport(dbPath: string, identity: string, events: WorkerEvents) {
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	// These two static sibling files are separate build entries, not Vite browser-worker assets.
	const entryName =
		extension === "ts" ? "./semantic-worker-entry.ts" : "./semantic-worker-entry.js";
	const entry = new URL(entryName, import.meta.url);
	const worker = new Worker(entry, {
		workerData: { dbPath, fileIdentity: identity },
		// The named protocol supplies model/public proof; do not inherit profile settings or credentials.
		env: {},
		// The existing DB loader's source graph contains parameter properties; emitted JS needs no loader.
		execArgv: extension === "ts" ? ["--experimental-transform-types"] : [],
	});
	worker.on("message", (message: WorkerReply) => {
		if (!message || !["ready", "result", "error"].includes(message.type)) {
			events.failure(new Error("invalid_semantic_worker_reply"));
			return;
		}
		events.message(message);
	});
	worker.on("error", events.failure);
	worker.on("exit", events.exit);
	return worker;
}

function warnSemanticCircuitOpen(code: SemanticWorkerErrorCode): void {
	console.warn(
		`codemem: semantic_worker_${code}; semantic retrieval disabled until process restart.`,
	);
}

function createWorkerOwner(options: SemanticWorkerOptions) {
	const { store } = options;
	if (!isAbsolute(store.db.name) || store.db.name === ":memory:") {
		throw new Error("semantic_worker_file_required");
	}
	const dbPath = realpathSync(store.db.name);
	const identity = fileIdentity(dbPath);
	const queue = createSemanticWorkerQueue({
		...options.queueOptions,
		onCircuitOpen: options.queueOptions?.onCircuitOpen ?? warnSemanticCircuitOpen,
		createWorker: options.createWorker ?? ((events) => transport(dbPath, identity, events)),
	});
	return { dbPath, identity, queue };
}

/** Owner must await close() before closing its writable store. */
export function createSemanticExecutor(options: SemanticWorkerOptions): PackSemanticExecutor {
	const { store } = options;
	const { dbPath, identity, queue } = createWorkerOwner(options);
	let generation = 0;
	const unsubscribe = store.onIdentityChanged?.(() => {
		generation++;
	});
	return {
		async search(input, executionOptions) {
			const requestIdentity = captureIdentity(store);
			const requestGeneration = generation;
			assertDatabaseIdentity(store, dbPath, identity);
			if (isEmbeddingDisabled() || input.query.trim().length < 3 || !currentCatalog(store.db)) {
				return [];
			}
			const proof = captureProof(store, requestIdentity);
			const request = cloneRequest(input);
			const state: SearchState = {
				generationId: "",
				models: [],
				model: "",
				embeddingIdentity: "",
				client: null,
			};
			const outcome = await queue
				.run(async () => {
					if (generation !== requestGeneration) throw new SemanticIdentityChangedError();
					assertIdentity(store, proof);
					const embedding = await prepareEmbedding(options, request.query, state);
					assertIdentity(store, proof);
					if (!embedding) return null;
					assertDatabaseIdentity(store, dbPath, identity);
					return {
						...request,
						generationId: state.generationId,
						proof,
						embedding: new Float32Array(embedding),
						embeddingIdentity: state.embeddingIdentity,
					};
				}, executionOptions)
				.then(
					(output) => ({ output }),
					(error: unknown) => ({ error }),
				);
			// Check both outcomes: identity changes must not become keyword delivery on timeout/crash.
			assertCompletion(store, proof, dbPath, identity);
			if (generation !== requestGeneration) throw new SemanticIdentityChangedError();
			if ("error" in outcome) throw outcome.error;
			return revalidateOutput(store, outcome.output, state, request, proof);
		},
		async close() {
			await queue.close();
			unsubscribe?.();
		},
	};
}

async function prepareEmbedding(
	options: SemanticWorkerOptions,
	query: string,
	state: SearchState,
): Promise<Float32Array | null> {
	const catalog = currentCatalog(options.store.db);
	if (!catalog) return null;
	state.generationId = catalog.generationId;
	state.model = configuredModel();
	const client = await (options.getClient ?? getEmbeddingClient)();
	if (!client) return null;
	state.client = client;
	state.embeddingIdentity = resolveEmbeddingClientVectorIdentityLabel(client);
	state.models = catalogModels(
		options.store.db,
		matchingCatalog(options.store.db, state),
		state.embeddingIdentity,
	);
	if (!state.models.length) return null;
	const embedding = (await embedTexts([query], client))[0];
	if (!embedding || !currentEmbedding(state)) return null;
	const current = catalogModels(
		options.store.db,
		matchingCatalog(options.store.db, state),
		state.embeddingIdentity,
	);
	if (JSON.stringify(current) !== JSON.stringify(state.models)) return null;
	return embedding;
}

function currentEmbedding(state: SearchState): boolean {
	return (
		state.model === configuredModel() &&
		state.client !== null &&
		resolveEmbeddingClientVectorIdentityLabel(state.client) === state.embeddingIdentity
	);
}

function revalidateOutput(
	store: SemanticWorkerOptions["store"],
	output: RankOutput | null,
	state: SearchState,
	request: Parameters<PackSemanticExecutor["search"]>[0],
	proof: RuntimeProof,
): SemanticSearchResult[] {
	if (!output || !currentEmbedding(state)) return [];
	assertCommittedStore(store.db);
	return store.db.transaction(() => {
		const catalog = readyCatalog(store.db);
		if (catalog?.generationId !== state.generationId || output.generationId !== state.generationId)
			return [];
		const models = catalogModels(store.db, catalog, state.embeddingIdentity);
		if (
			JSON.stringify(models) !== JSON.stringify(output.models) ||
			JSON.stringify(models) !== JSON.stringify(state.models)
		)
			return [];
		const ids = candidateIds(output.candidates);
		const current = readCandidateVersions(store.db, { memoryIds: ids, models });
		if (
			versionSignature(current, ids, models) !==
			versionSignature(output.candidateVersions, ids, models)
		)
			return [];
		return rehydrate(store, output.candidates, request, proof);
	})();
}

function candidateIds(candidates: RankOutput["candidates"]): number[] {
	if (!Array.isArray(candidates) || candidates.length > 200)
		throw new Error("invalid_semantic_worker_result");
	for (const candidate of candidates) {
		if (
			!Number.isSafeInteger(candidate.id) ||
			candidate.id <= 0 ||
			!Number.isFinite(candidate.distance) ||
			candidate.distance < 0
		) {
			throw new Error("invalid_semantic_worker_candidate");
		}
	}
	const ids = candidates.map((candidate) => candidate.id);
	if (new Set(ids).size !== ids.length) throw new Error("duplicate_semantic_worker_candidate");
	return ids;
}

function versionSignature(versions: CandidateVersion[], ids: number[], models: string[]): string {
	if (!Array.isArray(versions) || versions.length > ids.length * models.length) {
		throw new Error("invalid_semantic_worker_versions");
	}
	const byPair = new Map<string, CandidateVersion>();
	for (const row of versions) {
		if (
			!ids.includes(row.memoryId) ||
			!models.includes(row.model) ||
			!Number.isSafeInteger(row.version) ||
			row.version < 0 ||
			!Number.isSafeInteger(row.count) ||
			row.count < 0
		)
			throw new Error("invalid_semantic_worker_version");
		const key = JSON.stringify([row.memoryId, row.model]);
		if (byPair.has(key)) throw new Error("duplicate_semantic_worker_version");
		byPair.set(key, row);
	}
	// Include absent pairs: adding a previously missing model/chunk must change the comparison.
	return JSON.stringify(
		ids
			.toSorted((a, b) => a - b)
			.flatMap((id) =>
				models.toSorted().map((model) => {
					const row = byPair.get(JSON.stringify([id, model]));
					return [id, model, row?.version ?? 0, row?.count ?? 0];
				}),
			),
	);
}

function rehydrate(
	store: SemanticWorkerOptions["store"],
	candidates: RankOutput["candidates"],
	request: Parameters<PackSemanticExecutor["search"]>[0],
	proof: RuntimeProof,
): SemanticSearchResult[] {
	if (candidates.length === 0) return [];
	const context = ownershipFilterContext(store, { expectedPublicKey: proof.expectedPublicKey });
	const filter = buildFilterClausesWithContext(request.filters, context);
	const continuity = summaryContinuityFilter(summarySessionId(store.db, request.automaticContext));
	const join = filter.joinSessions ? "JOIN sessions ON sessions.id = memory_items.session_id" : "";
	const clauses = [
		"memory_items.active = 1",
		"memory_items.id IN (SELECT value FROM json_each(?))",
		...filter.clauses,
		...continuity.clauses,
	];
	const rows = store.db
		.prepare(`SELECT memory_items.* FROM memory_items ${join} WHERE ${clauses.join(" AND ")}`)
		.all(
			JSON.stringify(candidates.map((candidate) => candidate.id)),
			...filter.params,
			...continuity.params,
		) as Record<string, unknown>[];
	const byId = new Map(rows.map((row) => [Number(row.id), row]));
	const results: SemanticSearchResult[] = [];
	for (const candidate of candidates) {
		const row = byId.get(candidate.id);
		if (!row) continue;
		if (contentIdentity(row) !== candidate.contentIdentity) return [];
		results.push(semanticResult({ ...row, distance: candidate.distance }));
	}
	return results;
}
