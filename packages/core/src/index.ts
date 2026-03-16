/**
 * @codemem/core — store, embeddings, and shared types.
 *
 * This package owns the SQLite store, embedding worker interface,
 * and type definitions shared across the codemem TS backend.
 */

export const VERSION = "0.0.1";

export type { Database } from "./db.js";
export {
	assertSchemaReady,
	connect,
	DEFAULT_DB_PATH,
	fromJson,
	getSchemaVersion,
	isEmbeddingDisabled,
	loadSqliteVec,
	SCHEMA_VERSION,
	tableExists,
	toJson,
} from "./db.js";
export { buildFilterClauses } from "./filters.js";

export { MemoryStore } from "./store.js";
export type {
	Actor,
	Artifact,
	MemoryFilters,
	MemoryItem,
	MemoryResult,
	OpenCodeSession,
	RawEvent,
	RawEventFlushBatch,
	RawEventIngestSample,
	RawEventIngestStats,
	RawEventSession,
	ReplicationClock,
	ReplicationCursor,
	ReplicationOp,
	Session,
	SessionSummary,
	SyncAttempt,
	SyncDaemonState,
	SyncDevice,
	SyncNonce,
	SyncPeer,
	UsageEvent,
	UserPrompt,
} from "./types.js";
