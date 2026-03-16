/**
 * @codemem/core — store, embeddings, and shared types.
 *
 * This package owns the SQLite store, embedding worker interface,
 * and type definitions shared across the codemem TS backend.
 */

export const VERSION = "0.0.1";

export * as Api from "./api-types.js";
export type { Database } from "./db.js";
export {
	assertSchemaReady,
	connect,
	DEFAULT_DB_PATH,
	fromJson,
	getSchemaVersion,
	isEmbeddingDisabled,
	loadSqliteVec,
	MIN_COMPATIBLE_SCHEMA,
	migrateLegacyDbPath,
	resolveDbPath,
	SCHEMA_VERSION,
	tableExists,
	toJson,
} from "./db.js";
export { buildFilterClauses } from "./filters.js";
export { buildMemoryPack, estimateTokens } from "./pack.js";
export type { StoreHandle } from "./search.js";
export {
	expandQuery,
	explain,
	kindBonus,
	recencyScore,
	rerankResults,
	search,
	timeline,
} from "./search.js";
export { MemoryStore } from "./store.js";

export type {
	Actor,
	Artifact,
	ExplainError,
	ExplainItem,
	ExplainResponse,
	ExplainScoreComponents,
	MemoryFilters,
	MemoryItem,
	MemoryItemResponse,
	MemoryResult,
	OpenCodeSession,
	PackItem,
	PackResponse,
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
	StoreStats,
	SyncAttempt,
	SyncDaemonState,
	SyncDevice,
	SyncNonce,
	SyncPeer,
	TimelineItemResponse,
	UsageEvent,
	UserPrompt,
} from "./types.js";
