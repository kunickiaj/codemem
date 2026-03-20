/**
 * @codemem/core — store, embeddings, and shared types.
 *
 * This package owns the SQLite store, embedding worker interface,
 * and type definitions shared across the codemem TS backend.
 */

export const VERSION = "0.20.0-alpha.5";

export * as Api from "./api-types.js";
export type { ClaudeHookAdapterEvent, ClaudeHookRawEventEnvelope } from "./claude-hooks.js";
export {
	buildIngestPayloadFromHook,
	buildRawEventEnvelopeFromHook,
	MAPPABLE_CLAUDE_HOOK_EVENTS,
	mapClaudeHookPayload,
	normalizeProjectLabel,
	resolveHookProject,
} from "./claude-hooks.js";
export { createCoordinatorApp } from "./coordinator-api.js";
export type { InvitePayload } from "./coordinator-invites.js";
export {
	decodeInvitePayload,
	encodeInvitePayload,
	extractInvitePayload,
	inviteLink,
} from "./coordinator-invites.js";
export {
	CoordinatorStore,
	connectCoordinator,
	DEFAULT_COORDINATOR_DB_PATH,
} from "./coordinator-store.js";
export type { Database } from "./db.js";
export {
	assertSchemaReady,
	backupOnFirstAccess,
	connect,
	DEFAULT_DB_PATH,
	fromJson,
	fromJsonStrict,
	getSchemaVersion,
	isEmbeddingDisabled,
	loadSqliteVec,
	MIN_COMPATIBLE_SCHEMA,
	migrateLegacyDbPath,
	resolveDbPath,
	SCHEMA_VERSION,
	tableExists,
	toJson,
	toJsonNullable,
} from "./db.js";
export type { EmbeddingClient } from "./embeddings.js";
export {
	_resetEmbeddingClient,
	chunkText,
	embedTexts,
	getEmbeddingClient,
	hashText,
	serializeFloat32,
} from "./embeddings.js";
export type { ExportOptions, ExportPayload, ImportOptions, ImportResult } from "./export-import.js";
export {
	buildImportKey,
	exportMemories,
	importMemories,
	mergeSummaryMetadata,
	readImportPayload,
} from "./export-import.js";
export { buildFilterClauses, buildFilterClausesWithContext } from "./filters.js";
// Ingest pipeline
export {
	budgetToolEvents,
	eventToToolEvent,
	extractAdapterEvent,
	extractToolEvents,
	isInternalMemoryTool,
	LOW_SIGNAL_TOOLS,
	normalizeToolName,
	projectAdapterToolEvent,
} from "./ingest-events.js";
export { isLowSignalObservation, normalizeObservation } from "./ingest-filters.js";
export type { IngestOptions } from "./ingest-pipeline.js";
export { cleanOrphanSessions, ingest, main as ingestMain } from "./ingest-pipeline.js";
export { buildObserverPrompt } from "./ingest-prompts.js";
export {
	isSensitiveFieldName,
	sanitizePayload,
	sanitizeToolOutput,
	stripPrivate,
	stripPrivateObj,
} from "./ingest-sanitize.js";
export {
	buildTranscript,
	deriveRequest,
	extractAssistantMessages,
	extractAssistantUsage,
	extractPrompts,
	firstSentence,
	isTrivialRequest,
	normalizeAdapterEvents,
	normalizeRequestText,
	TRIVIAL_REQUESTS,
} from "./ingest-transcript.js";
export type {
	IngestPayload,
	ObserverContext,
	ParsedObservation,
	ParsedOutput,
	ParsedSummary,
	SessionContext,
	ToolEvent,
} from "./ingest-types.js";
export { hasMeaningfulObservation, parseObserverResponse } from "./ingest-xml-parser.js";
export { parsePositiveMemoryId, parseStrictInteger } from "./integers.js";
export type {
	GateResult,
	RawEventStatusItem,
	RawEventStatusResult,
	ReliabilityMetrics,
} from "./maintenance.js";
export {
	getRawEventStatus,
	getReliabilityMetrics,
	initDatabase,
	rawEventsGate,
	retryRawEventFailures,
	vacuumDatabase,
} from "./maintenance.js";
export type { ObserverAuthMaterial } from "./observer-auth.js";
export {
	buildCodexHeaders,
	extractOAuthAccess,
	extractOAuthAccountId,
	extractOAuthExpires,
	extractProviderApiKey,
	loadOpenCodeOAuthCache,
	ObserverAuthAdapter,
	probeAvailableCredentials,
	readAuthFile,
	redactText,
	renderObserverHeaders,
	resolveOAuthProvider,
	runAuthCommand,
} from "./observer-auth.js";
export type { ObserverConfig, ObserverResponse, ObserverStatus } from "./observer-client.js";
export { loadObserverConfig, ObserverAuthError, ObserverClient } from "./observer-client.js";
export {
	CODEMEM_CONFIG_ENV_OVERRIDES,
	getCodememConfigPath,
	getCodememEnvOverrides,
	getOpenCodeProviderConfig,
	getProviderApiKey,
	getProviderBaseUrl,
	getProviderHeaders,
	getProviderOptions,
	listConfiguredOpenCodeProviders,
	listCustomProviders,
	listObserverProviderOptions,
	loadOpenCodeConfig,
	readCodememConfigFile,
	resolveBuiltInProviderDefaultModel,
	resolveBuiltInProviderFromModel,
	resolveBuiltInProviderModel,
	resolveCustomProviderDefaultModel,
	resolveCustomProviderFromModel,
	resolveCustomProviderModel,
	resolvePlaceholder,
	stripJsonComments,
	stripTrailingCommas,
	writeCodememConfigFile,
} from "./observer-config.js";
export { buildMemoryPack, buildMemoryPackAsync, estimateTokens } from "./pack.js";
export {
	projectBasename,
	projectClause,
	projectColumnClause,
	projectMatchesFilter,
	resolveProject,
} from "./project.js";
export type { FlushRawEventsOptions } from "./raw-event-flush.js";
export { buildSessionContext, flushRawEvents } from "./raw-event-flush.js";
export { RawEventSweeper } from "./raw-event-sweeper.js";
export * as schema from "./schema.js";
export type { StoreHandle } from "./search.js";
export {
	dedupeOrderedIds,
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
	BuildAuthHeadersOptions,
	SignRequestOptions,
	VerifySignatureOptions,
} from "./sync-auth.js";
export {
	buildAuthHeaders,
	buildCanonicalRequest,
	cleanupNonces,
	DEFAULT_TIME_WINDOW_S,
	recordNonce,
	SIGNATURE_VERSION,
	signRequest,
	verifySignature,
} from "./sync-auth.js";
export type { SyncDaemonOptions, SyncTickResult } from "./sync-daemon.js";
export {
	runSyncDaemon,
	setSyncDaemonError,
	setSyncDaemonOk,
	syncDaemonTick,
} from "./sync-daemon.js";
export type { MdnsEntry } from "./sync-discovery.js";
export {
	addressDedupeKey,
	advertiseMdns,
	DEFAULT_SERVICE_TYPE,
	discoverPeersViaMdns,
	loadPeerAddresses,
	mdnsAddressesForPeer,
	mdnsEnabled,
	mergeAddresses,
	normalizeAddress,
	recordPeerSuccess,
	recordSyncAttempt,
	selectDialAddresses,
	setPeerLocalActorClaim,
	setPeerProjectFilter,
	updatePeerAddresses,
} from "./sync-discovery.js";
export type { RequestJsonOptions } from "./sync-http-client.js";
export { buildBaseUrl, requestJson } from "./sync-http-client.js";
export type { EnsureDeviceIdentityOptions } from "./sync-identity.js";
export {
	ensureDeviceIdentity,
	fingerprintPublicKey,
	generateKeypair,
	loadPrivateKey,
	loadPrivateKeyKeychain,
	loadPublicKey,
	resolveKeyPaths,
	storePrivateKeyKeychain,
	validateExistingKeypair,
} from "./sync-identity.js";
export type { SyncPassOptions, SyncResult } from "./sync-pass.js";
export {
	consecutiveConnectivityFailures,
	cursorAdvances,
	isConnectivityError,
	peerBackoffSeconds,
	runSyncPass,
	shouldSkipOfflinePeer,
	syncOnce,
	syncPassPreflight,
} from "./sync-pass.js";
export type { ApplyResult } from "./sync-replication.js";
export {
	applyReplicationOps,
	chunkOpsBySize,
	clockTuple,
	extractReplicationOps,
	getReplicationCursor,
	isNewerClock,
	loadReplicationOpsSince,
	recordReplicationOp,
	setReplicationCursor,
} from "./sync-replication.js";
// Test utilities (exported for consumer packages like viewer-server)
export { initTestSchema, insertTestSession } from "./test-utils.js";
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
export type {
	BackfillVectorsOptions,
	BackfillVectorsResult,
	SemanticSearchResult,
} from "./vectors.js";
export { backfillVectors, semanticSearch, storeVectors } from "./vectors.js";
