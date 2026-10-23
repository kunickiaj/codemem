import type { Database } from "better-sqlite3";
import { DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL } from "./embeddings.js";
import { inspectBytes, readModelJob } from "./semantic/semantic-ranking.js";
import { startAudit } from "./semantic/validated-vector-index-audit.js";
import {
	requireModel,
	requireVectorMetadata,
} from "./semantic/validated-vector-index-mutations.js";
import {
	initializeValidatedIndex,
	readState,
	refreshStatus,
	requireCatalog,
	type VectorCatalog,
} from "./semantic/validated-vector-index-state.js";
import {
	createEmptyVectorLayout,
	resolveVectorLayout,
	VECTOR_COMPATIBILITY_DDL,
	VECTOR_V1_DDL,
} from "./vector-layout.js";

export class VectorIndexUpgradeError extends Error {
	readonly code: "vector_upgrade_busy" | "vector_upgrade_failed";
	constructor(cause: unknown) {
		const code = (cause as { code?: unknown } | null)?.code;
		const busy = code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
		super(
			busy
				? "Vector index upgrade is busy. Close other vector writers and reopen the store."
				: "Vector index upgrade failed; the previous layout was preserved. Reopen with keyword search or repair the vector index before retrying.",
			{ cause },
		);
		this.name = "VectorIndexUpgradeError";
		this.code = busy ? "vector_upgrade_busy" : "vector_upgrade_failed";
	}
}

export interface VectorIndexReadyOptions {
	/** Identity already resolved by the caller; never constructs an embedding client. */
	configuredModel?: string;
}

/** Source labels come only from configured identity and persisted migration declarations. */
export function supportedVectorModelManifest(
	db: Database,
	options: VectorIndexReadyOptions = {},
): string[] {
	const configured = options.configuredModel ?? DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL;
	requireModel(configured);
	const models = new Set([configured]);
	if (configured === DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL)
		models.add("Xenova/bge-small-en-v1.5");
	const metadata = readModelJob(db)?.metadata;
	for (const key of ["source_model", "target_model"] as const) {
		const model = metadata?.[key];
		if (typeof model === "string" && model.trim()) models.add(model);
	}
	return [...models];
}

function copyLegacyVectors(db: Database): void {
	db.exec(VECTOR_V1_DDL);
	db.prepare(`INSERT INTO memory_vectors_v1(rowid,embedding,memory_id,chunk_index,content_hash,model)
	 SELECT rowid,embedding,memory_id,chunk_index,content_hash,model FROM memory_vectors`).run();
	const sourceCount = db.prepare("SELECT COUNT(*) FROM memory_vectors").pluck().get();
	const targetCount = db.prepare("SELECT COUNT(*) FROM memory_vectors_v1").pluck().get();
	if (sourceCount !== targetCount) throw new Error("vector_upgrade_copy_count_mismatch");
	const source = db.prepare(
		"SELECT rowid,embedding,memory_id,chunk_index,content_hash,model FROM memory_vectors",
	);
	const target = db.prepare(
		"SELECT embedding,memory_id,chunk_index,content_hash,model FROM memory_vectors_v1 WHERE rowid=?",
	);
	for (const row of source.iterate() as Iterable<CopiedVector>) {
		if (!Number.isSafeInteger(row.rowid)) throw new RangeError("unsafe_vector_rowid");
		const copied = target.get(BigInt(row.rowid)) as CopiedVector | undefined;
		if (
			!copied ||
			!Buffer.isBuffer(row.embedding) ||
			!row.embedding.equals(copied.embedding) ||
			row.memory_id !== copied.memory_id ||
			row.chunk_index !== copied.chunk_index ||
			row.content_hash !== copied.content_hash ||
			row.model !== copied.model
		)
			throw new Error("vector_upgrade_copy_mismatch");
	}
}

interface CopiedVector {
	rowid: number;
	embedding: Buffer;
	memory_id: number;
	chunk_index: number;
	content_hash: string;
	model: string | null;
}

function rejection(row: CopiedVector, models: Set<string>, sourceExists: boolean): string | null {
	if (row.model === null || !models.has(row.model)) return "model";
	try {
		requireVectorMetadata({
			memoryId: row.memory_id,
			chunkIndex: row.chunk_index,
			contentHash: row.content_hash,
		});
	} catch {
		return "metadata";
	}
	if (!sourceExists) return "metadata";
	return inspectBytes(row.embedding);
}

/** One startup pass, with one blob at a time; no inference or request-path census. */
function auditCopiedVectors(db: Database, knownModels: readonly string[]): void {
	startAudit(db, { knownModels });
	const models = new Set(knownModels);
	const first = db.prepare("SELECT rowid FROM memory_vectors_v1_rowids ORDER BY rowid LIMIT 1");
	const next = db.prepare(
		"SELECT rowid FROM memory_vectors_v1_rowids WHERE rowid>? ORDER BY rowid LIMIT 1",
	);
	const vector = db.prepare(
		"SELECT rowid,embedding,memory_id,chunk_index,content_hash,model FROM memory_vectors_v1 WHERE rowid=?",
	);
	const source = db.prepare("SELECT 1 FROM memory_items WHERE id=?");
	const update = db.prepare(
		"UPDATE validated_vector_rows SET audit_state=?,reason=? WHERE rowid=?",
	);
	let invalid = 0;
	let cursor = first.get() as { rowid: number } | undefined;
	while (cursor) {
		if (!Number.isSafeInteger(cursor.rowid)) throw new RangeError("unsafe_vector_rowid");
		const row = vector.get(BigInt(cursor.rowid)) as CopiedVector;
		const reason = rejection(row, models, !!source.get(row.memory_id));
		update.run(reason ? "invalid" : "valid", reason, row.rowid);
		if (reason) invalid++;
		cursor = next.get(row.rowid) as { rowid: number } | undefined;
	}
	db.prepare("UPDATE validated_vector_state SET pending_count=0,invalid_count=? WHERE id=1").run(
		invalid,
	);
	refreshStatus(db);
}

/** Explicit model transitions create a new generation and re-audit, never extend a live manifest. */
export function declareVectorIndexModels(
	db: Database,
	options: { knownModels: readonly string[] },
): VectorCatalog {
	for (const model of options.knownModels) requireModel(model);
	if (resolveVectorLayout(db).kind !== "v1") throw new Error("vector_layout_upgrade_required");
	return db
		.transaction(() => {
			auditCopiedVectors(db, options.knownModels);
			return requireCatalog(db);
		})
		.immediate();
}

function upgradeWithinTransaction(
	db: Database,
	options: VectorIndexReadyOptions,
): VectorCatalog | null {
	const layout = resolveVectorLayout(db);
	if (layout.kind === "absent") return null;
	if (layout.kind === "v1") {
		const state = readState(db);
		// Bootstrap's empty generation has no configured identity yet.
		if (
			state.known_models === "[]" &&
			!db.prepare("SELECT 1 FROM validated_vector_rows LIMIT 1").get()
		)
			auditCopiedVectors(db, supportedVectorModelManifest(db, options));
		return requireCatalog(db);
	}
	copyLegacyVectors(db);
	db.exec("DROP TABLE memory_vectors");
	db.exec(VECTOR_COMPATIBILITY_DDL);
	// Only claim writer compatibility after the old name has become a fenced view.
	initializeValidatedIndex(db, { allWritersUpgraded: true, writerVersion: 1 });
	auditCopiedVectors(db, supportedVectorModelManifest(db, options));
	return requireCatalog(db);
}

/** Atomic cutover. Fail fast on another writer and restore this connection's timeout. */
export function upgradeVectorIndex(
	db: Database,
	options: VectorIndexReadyOptions = {},
): VectorCatalog | null {
	if (db.inTransaction) throw new TypeError("vector_upgrade_requires_standalone_transaction");
	const layout = resolveVectorLayout(db);
	if (layout.kind === "absent") return null;
	if (layout.kind === "v1") {
		const state = readState(db);
		if (state.known_models !== "[]") return requireCatalog(db);
	}
	const timeout = Number(db.pragma("busy_timeout", { simple: true }));
	db.pragma("busy_timeout = 0");
	try {
		return db.transaction(() => upgradeWithinTransaction(db, options)).immediate();
	} catch (cause) {
		throw new VectorIndexUpgradeError(cause);
	} finally {
		db.pragma(`busy_timeout = ${timeout}`);
	}
}

/** Call after identity schema setup and before accepting requests. Extension loading belongs to bootstrap. */
export function ensureVectorIndexReady(
	db: Database,
	options: VectorIndexReadyOptions = {},
): VectorCatalog | null {
	if (resolveVectorLayout(db).kind === "absent") {
		createEmptyVectorLayout(db);
	}
	return upgradeVectorIndex(db, options);
}
