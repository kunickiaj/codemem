/**
 * @codemem/core — store, embeddings, and shared types.
 *
 * This package owns the SQLite store, embedding worker interface,
 * and type definitions shared across the codemem TS backend.
 */

export const VERSION = "0.39.0";

export * as Api from "./api-types.js";
export { extractApplyPatchPaths, MUTATING_TOOL_NAMES } from "./apply-patch.js";
export type { CreateBetterSqliteCoordinatorAppOptions } from "./better-sqlite-coordinator-runtime.js";
export { createBetterSqliteCoordinatorApp } from "./better-sqlite-coordinator-runtime.js";
export type { ClaudeHookAdapterEvent, ClaudeHookRawEventEnvelope } from "./claude-hooks.js";
export {
	buildIngestPayloadFromHook,
	buildRawEventEnvelopeFromHook,
	MAPPABLE_CLAUDE_HOOK_EVENTS,
	mapClaudeHookPayload,
	normalizeProjectLabel,
	resolveHookProject,
} from "./claude-hooks.js";
export type { CodexHookAdapterEvent, CodexHookRawEventEnvelope } from "./codex-hooks.js";
export {
	buildIngestPayloadFromCodexHook,
	buildRawEventEnvelopeFromCodexHook,
	MAPPABLE_CODEX_HOOK_EVENTS,
	mapCodexHookPayload,
} from "./codex-hooks.js";
export {
	coordinatorArchiveGroupAction,
	coordinatorCreateGroupAction,
	coordinatorCreateInviteAction,
	coordinatorCreateScopeAction,
	coordinatorDisableDeviceAction,
	coordinatorEnableDeviceAction,
	coordinatorEnrollDeviceAction,
	coordinatorGrantScopeMembershipAction,
	coordinatorImportInviteAction,
	coordinatorListBootstrapGrantsAction,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	coordinatorListJoinRequestsAction,
	coordinatorListScopeMembershipsAction,
	coordinatorListScopesAction,
	coordinatorRemoveDeviceAction,
	coordinatorRenameDeviceAction,
	coordinatorRenameGroupAction,
	coordinatorReviewJoinRequestAction,
	coordinatorRevokeBootstrapGrantAction,
	coordinatorRevokeScopeMembershipAction,
	coordinatorUnarchiveGroupAction,
	coordinatorUpdateScopeAction,
} from "./coordinator-actions.js";
export type {
	CoordinatorRequestVerifier,
	CoordinatorRuntimeDeps,
	CoordinatorVerifyRequestInput,
	CreateCoordinatorAppOptions,
} from "./coordinator-api.js";
export { createCoordinatorApp } from "./coordinator-api.js";
export type {
	CoordinatorGroupPreference,
	UpsertCoordinatorGroupPreferenceInput,
} from "./coordinator-group-preferences.js";
export {
	defaultSpaceScopeIdForGroup,
	deleteCoordinatorGroupPreference,
	getCoordinatorGroupPreference,
	listCoordinatorGroupPreferences,
	upsertCoordinatorGroupPreference,
} from "./coordinator-group-preferences.js";
export type { InvitePayload } from "./coordinator-invites.js";
export {
	decodeInvitePayload,
	encodeInvitePayload,
	extractInvitePayload,
	inviteLink,
} from "./coordinator-invites.js";
export {
	coordinatorEnabled,
	coordinatorStatusSnapshot,
	createCoordinatorReciprocalApproval,
	fetchCoordinatorStalePeers,
	listCoordinatorJoinRequests,
	listCoordinatorReciprocalApprovals,
	lookupCoordinatorPeers,
	readCoordinatorSyncConfig,
	refreshStoredCoordinatorPeerAddresses,
	registerCoordinatorPresence,
} from "./coordinator-runtime.js";
export type {
	CoordinatorBootstrapGrantVerification,
	CoordinatorConsumeProjectInviteInput,
	CoordinatorCreateInviteInput,
	CoordinatorCreateJoinRequestInput,
	CoordinatorCreateReciprocalApprovalInput,
	CoordinatorCreateScopeInput,
	CoordinatorEnrollDeviceInput,
	CoordinatorEnrollment,
	CoordinatorGrantScopeMembershipInput,
	CoordinatorGroup,
	CoordinatorInvite,
	CoordinatorJoinRequest,
	CoordinatorJoinRequestReviewResult,
	CoordinatorListReciprocalApprovalsInput,
	CoordinatorListScopeMembershipAuditInput,
	CoordinatorListScopesInput,
	CoordinatorPeerRecord,
	CoordinatorPresenceRecord,
	CoordinatorProjectInviteAcceptance,
	CoordinatorProjectInviteSummary,
	CoordinatorReciprocalApproval,
	CoordinatorReviewJoinRequestInput,
	CoordinatorRevokeScopeMembershipInput,
	CoordinatorScope,
	CoordinatorScopeMembership,
	CoordinatorScopeMembershipAuditAction,
	CoordinatorScopeMembershipAuditEvent,
	CoordinatorStore,
	CoordinatorStoreInterface,
	CoordinatorUpdateScopeInput,
	CoordinatorUpsertPresenceInput,
} from "./coordinator-store.js";
export {
	BetterSqliteCoordinatorStore,
	connectCoordinator,
	DEFAULT_COORDINATOR_DB_PATH,
} from "./coordinator-store.js";
export type { Database } from "./db.js";
export {
	assertSchemaReady,
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
export {
	DEDUP_KEY_BACKFILL_JOB,
	DedupKeyBackfillRunner,
	hasPendingDedupKeyBackfill,
	runDedupKeyBackfillPass,
} from "./dedup-key-backfill.js";
export type {
	ArtifactKind,
	ContextFactFeature,
	DistillCandidate,
	DistillCandidateEmitOptions,
	DistillCluster,
	DistillClusterOptions,
	DistillContextChunk,
	DistillContextChunkOptions,
	DistillContextDedupeOptions,
	DistillContextDocument,
	DistillCorpusOptions,
	DistillDetector,
	DistillDocumentationMatch,
	DistillDocumentationSignal,
	DistillDocumentedCluster,
	DistillPromotabilityScores,
	DistillReport,
	DistillReportOptions,
	DistillScope,
	DistillScoredCluster,
	DistillScoringOptions,
	DistillVectorFeature,
} from "./distill.js";
export {
	buildDistillReport,
	chunkDistillContextDocuments,
	clusterDistillFeatures,
	createContextFactDetector,
	DEFAULT_CONTEXT_FACT_KINDS,
	embedDistillContextChunks,
	emitDistillCandidates,
	loadDistillVectorFeatures,
	markDistillClustersDocumented,
	projectContextFactFeatures,
	scoreDistillCluster,
	scoreDistillClusters,
	selectDistillCorpus,
} from "./distill.js";
export type {
	DistillApplyResult,
	DistillDraftPrompt,
	DistillDraftResult,
	DistillRuleDrafter,
} from "./distill-draft.js";
export {
	applyDistillRule,
	buildDistillDraftPrompt,
	DISTILL_BLOCK_BEGIN,
	DISTILL_BLOCK_END,
	DISTILL_LESSONS_HEADING,
	draftDistillRule,
	renderUnifiedDiff,
	sanitizeRuleLine,
} from "./distill-draft.js";
export type {
	DistillCandidateJudgement,
	DistillJudgePrompt,
	DistillJudgeVerdict,
	JudgedDistillCandidate,
} from "./distill-judge.js";
export {
	buildDistillJudgePrompt,
	judgeDistillCandidate,
	judgeDistillCandidates,
	judgeDistillReport,
	parseJudgeVerdict,
} from "./distill-judge.js";
export type { EmbeddingClient } from "./embeddings.js";
export {
	_resetEmbeddingClient,
	chunkText,
	embedTexts,
	getEmbeddingClient,
	hashText,
	serializeFloat32,
} from "./embeddings.js";
export type { InjectionEvalScenario, InjectionEvalScenarioPack } from "./eval-scenarios.js";
export {
	getInjectionEvalScenarioByPrompt,
	getInjectionEvalScenarioPack,
	getInjectionEvalScenarioPrompts,
	INJECTION_EVAL_SCENARIO_PACKS,
} from "./eval-scenarios.js";
export type { ExportOptions, ExportPayload, ImportOptions, ImportResult } from "./export-import.js";
export {
	buildImportKey,
	exportMemories,
	importMemories,
	mergeSummaryMetadata,
	readImportPayload,
} from "./export-import.js";
export type {
	ExtractionBenchmarkQualityDimensions,
	ExtractionBenchmarkScore,
	ExtractionBenchmarkSummaryDispositionScore,
} from "./extraction-benchmark-scoring.js";
export {
	calculateCostAdjustedScore,
	calculateWeightedQualityCoverage,
	calculateWeightedQualityScore,
	scoreExtractionBenchmarkOutput,
} from "./extraction-benchmark-scoring.js";
export type {
	ExtractionBenchmarkBatch,
	ExtractionBenchmarkLabel,
	ExtractionBenchmarkLabelDisposition,
	ExtractionBenchmarkModelCandidate,
	ExtractionBenchmarkProfile,
	ExtractionBenchmarkReview,
} from "./extraction-benchmarks.js";
export {
	getExtractionBenchmarkProfile,
	listExtractionBenchmarkProfiles,
} from "./extraction-benchmarks.js";
export type {
	ExtractionStructuralDiagnostics,
	SessionExtractionEvalItem,
	SessionExtractionEvalResult,
	SessionExtractionEvalScenario,
	SessionExtractionEvalThread,
	SessionExtractionEvalThreadResult,
} from "./extraction-eval.js";
export {
	evaluateExtractionStructure,
	evaluateSessionExtractionItems,
	getSessionExtractionEval,
	getSessionExtractionEvalScenario,
} from "./extraction-eval.js";
export type {
	ExtractionModelCostEstimate,
	ExtractionModelPricing,
	NormalizedExtractionTokenUsage,
} from "./extraction-model-pricing.js";
export {
	estimateExtractionModelCost,
	getExtractionModelPricing,
	listExtractionModelPricing,
} from "./extraction-model-pricing.js";
export type { ExtractionReplayResult } from "./extraction-replay.js";
export {
	replayBatchExtraction,
	replayBatchExtractionWithTierRouting,
} from "./extraction-replay.js";
export type {
	ExtractionReplayTierRoutingDecision,
	ExtractionReplayTierRoutingInput,
} from "./extraction-tier-routing.js";
export {
	decideExtractionReplayTier,
	RICH_TIER_DEFAULTS,
	SIMPLE_TIER_DEFAULTS,
} from "./extraction-tier-routing.js";
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
	normalizeEventsForSessionContext,
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
export type { ObserverResponseStructuralDiagnostics } from "./ingest-xml-parser.js";
export {
	hasMeaningfulObservation,
	inspectObserverResponseStructure,
	parseObserverResponse,
	SUPPORTED_OBSERVATION_KINDS,
} from "./ingest-xml-parser.js";
export { parsePositiveMemoryId, parseStrictInteger } from "./integers.js";
export type {
	LegacyRecipientPolicyConditionCodeV1,
	LegacyRecipientPolicyConditionV1,
	LegacyRecipientPolicyConfidenceV1,
	LegacyRecipientPolicyEffectiveDeviceV1,
	LegacyRecipientPolicyEnforcementStateV1,
	LegacyRecipientPolicyEnforcementV1,
	LegacyRecipientPolicyIdentityCandidateV1,
	LegacyRecipientPolicyProjectionV1,
	LegacyRecipientPolicyProvenanceV1,
	LegacyRecipientPolicyTeamCandidateV1,
	ListLegacyRecipientPolicyProjectionsOptions,
} from "./legacy-recipient-policy-projection.js";
export {
	listLegacyRecipientPolicyProjections,
	resolveLegacyRecipientPolicyLocalIdentity,
} from "./legacy-recipient-policy-projection.js";
export type {
	BackfillTagsTextOptions,
	BackfillTagsTextResult,
	DeactivateLowSignalMemoriesOptions,
	DeactivateLowSignalResult,
	GateResult,
	MemoryArtifactClassCount,
	MemoryArtifactReport,
	MemoryArtifactReportOptions,
	MemoryRole,
	MemoryRoleReport,
	MemoryRoleReportComparison,
	MemoryRoleReportComparisonOptions,
	MemoryRoleReportOptions,
	RawEventRelinkAction,
	RawEventRelinkGroup,
	RawEventRelinkPlan,
	RawEventRelinkPlanOptions,
	RawEventRelinkReport,
	RawEventRelinkReportOptions,
	RawEventStatusItem,
	RawEventStatusResult,
	ReliabilityMetrics,
} from "./maintenance.js";
export {
	aiBackfillStructuredContent,
	backfillMemoryDedupKeys,
	backfillNarrativeFromBody,
	backfillTagsText,
	compareMemoryRoleReports,
	deactivateLowSignalMemories,
	deactivateLowSignalObservations,
	dedupNearDuplicateMemories,
	extractNarrativeFromBody,
	getMemoryArtifactReport,
	getMemoryRoleReport,
	getRawEventRelinkPlan,
	getRawEventRelinkReport,
	getRawEventStatus,
	getReliabilityMetrics,
	initDatabase,
	rawEventsGate,
	retryRawEventFailures,
	scanSecretsRetroactive,
	vacuumDatabase,
} from "./maintenance.js";
export type {
	MaintenanceJobRecord,
	MaintenanceJobSnapshot,
	MaintenanceJobStatus,
	StartMaintenanceJobInput,
	UpdateMaintenanceJobInput,
} from "./maintenance-jobs.js";
export {
	completeMaintenanceJob,
	ensureMaintenanceJobsSchema,
	failMaintenanceJob,
	getMaintenanceJob,
	listMaintenanceJobs,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
export type {
	DerivedMemoryRole,
	DerivedMemoryRoleResult,
	InferMemoryRoleInput,
	MemoryArtifactClass,
	MemoryWorthinessAction,
	MemoryWorthinessReason,
	MemoryWorthinessResult,
} from "./memory-quality.js";
export {
	classifyMemoryWorthiness,
	inferMemoryRole,
	isDerivedFactRow,
	readArtifactClass,
} from "./memory-quality.js";
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
export type {
	ObserverConfig,
	ObserverResponse,
	ObserverStatus,
	ObserverTokenUsage,
} from "./observer-client.js";
export { loadObserverConfig, ObserverAuthError, ObserverClient } from "./observer-client.js";
export type {
	ConfigPathResolution,
	ConfigPathSource,
	ConfigResolutionResult,
} from "./observer-config.js";
export {
	CODEMEM_CONFIG_ENV_OVERRIDES,
	coerceObserverCommand,
	getCodememConfigPath,
	getCodememEnvOverrides,
	getOpenCodeProviderConfig,
	getProviderApiKey,
	getProviderBaseUrl,
	getProviderHeaders,
	getProviderOptions,
	getWorkspaceCodememConfigPath,
	getWorkspaceScopedCodememConfigPath,
	listConfiguredOpenCodeProviders,
	listCustomProviders,
	listObserverProviderOptions,
	loadOpenCodeConfig,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readWorkspaceCodememConfigFile,
	resolveBuiltInProviderDefaultModel,
	resolveBuiltInProviderFromModel,
	resolveBuiltInProviderModel,
	resolveCodememConfigPath,
	resolveCustomProviderDefaultModel,
	resolveCustomProviderFromModel,
	resolveCustomProviderModel,
	resolvePlaceholder,
	stripJsonComments,
	stripTrailingCommas,
	writeCodememConfigFile,
	writeWorkspaceCodememConfigFile,
} from "./observer-config.js";
export {
	buildMemoryPack,
	buildMemoryPackAsync,
	buildMemoryPackTrace,
	buildMemoryPackTraceAsync,
	estimateTokens,
} from "./pack.js";
export {
	projectBasename,
	projectClause,
	projectColumnClause,
	projectMatchesFilter,
	resolveProject,
	resolveProjectRoot,
} from "./project.js";
export type { ProjectInviteSummary } from "./project-invite-identity.js";
export {
	friendlyDeviceName,
	normalizeDeviceNameHint,
	normalizeIdentityDisplayName,
	normalizeProjectInviteSummaries,
} from "./project-invite-identity.js";
export type {
	ProjectScopeCandidate,
	ProjectScopeGuardrailCode,
	ProjectScopeGuardrailSeverity,
	ProjectScopeGuardrailWarning,
	ProjectScopeInventoryOptions,
	ProjectScopeInventoryProject,
	ProjectScopeInventoryResult,
	ProjectScopeInventoryStatus,
	ProjectScopeMappingChangeGuardrailAnalysis,
	ProjectScopeSettingsMapping,
	ReassignProjectScopeInventoryProjectResult,
	SharingDomainSettingsScope,
	UpsertProjectScopeMappingInput,
} from "./project-scope-settings.js";
export {
	analyzeProjectScopeMappingChangeGuardrails,
	deleteProjectScopeSettingsMapping,
	listProjectScopeCandidates,
	listProjectScopeInventory,
	listProjectScopeSettingsMappings,
	listSharingDomainSettingsScopes,
	reassignProjectScopeInventoryProject,
	upsertProjectScopeSettingsMapping,
} from "./project-scope-settings.js";
export type { FlushRawEventsOptions } from "./raw-event-flush.js";
export { buildSessionContext, flushRawEvents } from "./raw-event-flush.js";
export { RawEventSweeper } from "./raw-event-sweeper.js";
export type {
	RecipientPolicyAuthorityV1,
	RecipientPolicyBlockedItemV1,
	RecipientPolicyContractVersion,
	RecipientPolicyEffectiveDeviceV1,
	RecipientPolicyEnforcementV1,
	RecipientPolicyIdentityDeviceV1,
	RecipientPolicyIdentityKindV1,
	RecipientPolicyIdentityStatusV1,
	RecipientPolicyIdentityV1,
	RecipientPolicyIntentSourceV1,
	RecipientPolicyParityV1,
	RecipientPolicyProjectionV1,
	RecipientPolicyProjectRecipientV1,
	RecipientPolicyProjectV1,
	RecipientPolicyReconciliationStatusV1,
	RecipientPolicyReviewDecisionV1,
	RecipientPolicyReviewItemV1,
	RecipientPolicyReviewOptionV1,
	RecipientPolicyReviewPreviewDeviceV1,
	RecipientPolicyReviewPreviewProjectV1,
	RecipientPolicyReviewPreviewV1,
	RecipientPolicyReviewResolutionV1,
	RecipientPolicyTeamMembershipV1,
	RecipientPolicyTeamV1,
} from "./recipient-policy-contract.js";
export { RECIPIENT_POLICY_CONTRACT_VERSION } from "./recipient-policy-contract.js";
export type {
	RecipientPolicyEdgeChangeV1,
	RecipientPolicyEdgeCommitOutcomeV1,
	RecipientPolicyEdgeCommitRequestV1,
	RecipientPolicyEdgeCommitResultV1,
	RecipientPolicyEdgeEffectiveDeviceV1,
	RecipientPolicyEdgeIdentitySummaryV1,
	RecipientPolicyEdgeOutcomeV1,
	RecipientPolicyEdgePreviewProjectV1,
	RecipientPolicyEdgePreviewRequestV1,
	RecipientPolicyEdgePreviewResponseV1,
	RecipientPolicyEdgeRecipientRefV1,
	RecipientPolicyEdgeSelectedRecipientV1,
} from "./recipient-policy-edges.js";
export {
	commitRecipientPolicyEdges,
	parseRecipientPolicyEdgeCommitRequest,
	parseRecipientPolicyEdgePreviewRequest,
	previewRecipientPolicyEdges,
	RecipientPolicyEdgeRequestError,
} from "./recipient-policy-edges.js";
export type { RecipientPolicyIntentGraphV1 } from "./recipient-policy-intent.js";
export { listRecipientPolicyIntent } from "./recipient-policy-intent.js";
export type {
	RecipientPolicyMigrationOptions,
	RecipientPolicyMigrationProjectResultV1,
	RecipientPolicyMigrationProjectStatus,
	RecipientPolicyMigrationResultV1,
} from "./recipient-policy-migration.js";
export {
	deterministicPolicyTeamId,
	migrateRecipientPolicyIntent,
} from "./recipient-policy-migration.js";
export type {
	RecipientPolicyAddDeviceOnboardingRequestV1,
	RecipientPolicyDirectProjectOnboardingRequestV1,
	RecipientPolicyOnboardingBindingV1,
	RecipientPolicyOnboardingCommitRequestV1,
	RecipientPolicyOnboardingCommitResultV1,
	RecipientPolicyOnboardingExcludedProjectV1,
	RecipientPolicyOnboardingJourneyV1,
	RecipientPolicyOnboardingPreviewRequestV1,
	RecipientPolicyOnboardingPreviewV1,
	RecipientPolicyOnboardingProjectSourceV1,
	RecipientPolicyOnboardingProjectV1,
	RecipientPolicyTeamOnboardingRequestV1,
} from "./recipient-policy-onboarding.js";
export {
	commitRecipientPolicyOnboarding,
	previewRecipientPolicyOnboarding,
	RecipientPolicyOnboardingRequestError,
} from "./recipient-policy-onboarding.js";
export type {
	RecipientPolicyCoordinatorEffectReceipt,
	RecipientPolicyCoordinatorSnapshot,
	RecipientPolicyPeerCapability,
	RecipientPolicyReconcileResult,
	RecipientPolicyReconcilerEffects,
	RecipientPolicyReconcileStatus,
	ReconcileRecipientPolicyProjectInput,
} from "./recipient-policy-reconciler.js";
export {
	assertLegacyShareGrantAllowed,
	reconcileRecipientPolicyProject,
} from "./recipient-policy-reconciler.js";
export type {
	DeriveRecipientPolicyEffectiveDevicesInput,
	RecipientPolicyAuthorityState,
	RecipientPolicyAuthorityStateRecord,
	RecipientPolicyDenyOverlayRecord,
	RecipientPolicyDerivationBlock,
	RecipientPolicyDerivationBlockCode,
	RecipientPolicyDerivationIdentity,
	RecipientPolicyDerivationIdentityDevice,
	RecipientPolicyDerivationProjectRecipient,
	RecipientPolicyDerivationTeam,
	RecipientPolicyDerivationTeamMembership,
	RecipientPolicyEffectiveDeviceSource,
	RecipientPolicyReconciliationStepRecord,
	RecordRecipientPolicyAuthorityExecutionInput,
	RecordRecipientPolicyReconciliationStepStateInput,
	StrictRecipientPolicyEffectiveDevice,
	StrictRecipientPolicyEffectiveDeviceDerivation,
	UpsertRecipientPolicyAuthorityObservationInput,
} from "./recipient-policy-reconciliation.js";
export {
	clearRecipientPolicyDenyOverlay,
	deriveRecipientPolicyEffectiveDevices,
	deriveRecipientPolicyEffectiveDevicesFromDatabase,
	deterministicRecipientPolicyReconciliationEffectId,
	ensureRecipientPolicyReconciliationStep,
	getAnyRecipientPolicyDenyOverlayForScopeDevice,
	getRecipientPolicyAuthorityState,
	listRecipientPolicyDenyOverlays,
	putRecipientPolicyDenyOverlay,
	recipientPolicyDevicesDigest,
	recordRecipientPolicyAuthorityExecution,
	recordRecipientPolicyReconciliationStepState,
	recordRecipientPolicyStableParityPass,
	upsertRecipientPolicyAuthorityObservation,
} from "./recipient-policy-reconciliation.js";
export type {
	RecipientPolicyActionableReviewItemV1,
	RecipientPolicyDerivedReviewState,
	RecipientPolicyReviewActionOptionV1,
	RecipientPolicyReviewBulkResultV1,
	RecipientPolicyReviewContext,
	RecipientPolicyReviewListV1,
	RecipientPolicyReviewResolveRequestV1,
	RecipientPolicyReviewResolveResultV1,
	RecipientPolicyReviewResolveStatusV1,
} from "./recipient-policy-review.js";
export {
	deriveRecipientPolicyReviewState,
	listRecipientPolicyReview,
	recipientPolicyReviewSourceFingerprint,
	resolveRecipientPolicyReview,
	resolveRecipientPolicyReviewBulk,
} from "./recipient-policy-review.js";
export {
	hasPendingRefBackfill,
	REF_BACKFILL_JOB,
	RefBackfillRunner,
	runRefBackfillPass,
} from "./ref-backfill.js";
export { clearMemoryRefs, normalizeConcept, populateMemoryRefs } from "./ref-populate.js";
export type { RefQueryOptions, RefQueryResult } from "./ref-queries.js";
export { findByConcept, findByFile } from "./ref-queries.js";
export type {
	IdentityDevice,
	MaintenanceJob,
	NewIdentityDevice,
	NewMaintenanceJob,
	NewPolicyTeam,
	NewPolicyTeamMembership,
	NewProjectRecipient,
	NewRecipientPolicyAuthorityStateRow,
	NewRecipientPolicyDenyOverlay,
	NewRecipientPolicyReconciliationStep,
	NewRecipientPolicyReviewResolution,
	PolicyTeam,
	PolicyTeamMembership,
	ProjectRecipient,
	RecipientPolicyAuthorityStateRow,
	RecipientPolicyDenyOverlay,
	RecipientPolicyReconciliationStep,
	RecipientPolicyReviewResolution,
} from "./schema.js";
export * as schema from "./schema.js";
export { bootstrapSchema, ensureSchemaBootstrapped } from "./schema-bootstrap.js";
export type {
	LegacyMemoryScopeClassification,
	LegacyMemoryScopeInput,
	ScopeBackfillOptions,
	ScopeBackfillReason,
	ScopeBackfillResult,
	ScopeBackfillRunnerOptions,
} from "./scope-backfill.js";
export {
	backfillScopeIds,
	classifyLegacyMemoryScope,
	ensureScopeBackfillScopes,
	hasPendingScopeBackfill,
	LEGACY_SHARED_REVIEW_SCOPE_ID,
	runScopeBackfillPass,
	SCOPE_BACKFILL_JOB,
	ScopeBackfillRunner,
} from "./scope-backfill.js";
export type {
	CachedDeviceScopeMemberships,
	CachedScopeAuthorization,
	CachedScopeMembership,
	RefreshScopeMembershipCacheGroupResult,
	RefreshScopeMembershipCacheOptions,
	RefreshScopeMembershipCacheResult,
	ScopeMembershipAuthorizationState,
	ScopeMembershipCacheAuthority,
	ScopeMembershipCacheFetchers,
	ScopeMembershipCacheFreshness,
	ScopeMembershipCacheState,
} from "./scope-membership-cache.js";
export {
	DEFAULT_SCOPE_MEMBERSHIP_CACHE_MAX_AGE_MS,
	ensureScopeMembershipCacheStateTable,
	getCachedScopeAuthorization,
	listCachedScopesForDevice,
	refreshConfiguredScopeMembershipCache,
	refreshScopeMembershipCache,
	upsertCachedScopeMemberships,
} from "./scope-membership-cache.js";
export type {
	ScopeMembershipEpochStatus,
	ScopeMembershipRevocationNotice,
} from "./scope-membership-semantics.js";
export {
	explainScopeMembershipRevocation,
	SCOPE_MEMBERSHIP_REVOCATION_LIMITATION,
	scopeMembershipEpochStatus,
} from "./scope-membership-semantics.js";
export type {
	CanonicalWorkspaceIdentity,
	ResolveProjectScopeInput,
	ScopeMapping,
	ScopeResolution,
	ScopeResolutionReason,
	WorkspaceIdentityInput,
	WorkspaceIdentitySource,
} from "./scope-resolution.js";
export {
	canonicalWorkspaceIdentity,
	LOCAL_DEFAULT_SCOPE_ID,
	resolveProjectScope,
} from "./scope-resolution.js";
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
export {
	hasPendingSessionContextBackfill,
	runSessionContextBackfillPass,
	SESSION_CONTEXT_BACKFILL_JOB,
	SessionContextBackfillRunner,
} from "./session-context-backfill.js";
export type {
	AcceptedProjectIntent,
	PersistShareOperationInvite,
	ShareOperationAcceptanceInput,
	ShareOperationPlan,
	ShareOperationStep,
	SharePersonIntent,
	ShareProjectIntent,
} from "./share-operation.js";
export {
	inviteTokenDigest,
	normalizeTeammateName,
	parseAcceptedProjectIntent,
	persistShareOperation,
	planShareOperation,
	reconcileShareOperationAcceptance,
	SHARE_HISTORY_POLICY,
	SHARE_OPERATION_STATE,
	shareProjectSetDigest,
} from "./share-operation.js";
export type {
	ShareOperationLifecycle,
	ShareOperationLifecycleInput,
	ShareOperationLifecycleProjection,
	ShareOperationLifecycleStepInput,
	ShareOperationPrimaryAction,
} from "./share-operation-lifecycle.js";
export {
	projectShareLifecycle,
	SHARE_OPERATION_MAX_ATTEMPTS,
	SHARE_OPERATION_STALE_AFTER_MS,
} from "./share-operation-lifecycle.js";
export type {
	ManagedProjectPlan,
	ReassignScopeCapability,
	ShareProvisioningDependencies,
	ShareProvisioningPlan,
} from "./share-provisioning.js";
export {
	countShareableProjectMemories,
	executeShareProvisioning,
	planShareProvisioning,
} from "./share-provisioning.js";
export { MemoryStore } from "./store.js";
export {
	hasPendingSummaryDedupBackfill,
	runSummaryDedupBackfillPass,
	SUMMARY_DEDUP_BACKFILL_JOB,
	SummaryDedupBackfillRunner,
} from "./summary-dedup-backfill.js";
export { canonicalMemoryKind, getSummaryMetadata, isSummaryLikeMemory } from "./summary-memory.js";
export type {
	BuildAuthHeadersOptions,
	SignRequestOptions,
	VerifySignatureOptions,
} from "./sync-auth.js";
export {
	buildAuthHeaders,
	buildCanonicalRequest,
	cleanupNonces,
	recordNonce,
	SIGNATURE_VERSION,
	signRequest,
	verifySignature,
} from "./sync-auth.js";
export { DEFAULT_TIME_WINDOW_S } from "./sync-auth-constants.js";
export type { BootstrapOptions, BootstrapResult } from "./sync-bootstrap.js";
export { applyBootstrapSnapshot, fetchAllSnapshotPages } from "./sync-bootstrap.js";
export type { SyncCapability, SyncFeature } from "./sync-capability.js";
export {
	isScopedSyncCapability,
	LOCAL_SYNC_CAPABILITY,
	LOCAL_SYNC_FEATURES,
	negotiateSyncCapability,
	normalizeSyncCapability,
	normalizeSyncFeatures,
	SYNC_AUTHORIZATION_REFRESH_HEADER,
	SYNC_CAPABILITIES,
	SYNC_CAPABILITY_HEADER,
	SYNC_FEATURES,
	SYNC_FEATURES_HEADER,
	supportsSyncFeature,
} from "./sync-capability.js";
export type {
	SyncDaemonOptions,
	SyncDaemonPhase,
	SyncDaemonTickCallback,
	SyncDaemonTickContext,
	SyncTickResult,
} from "./sync-daemon.js";
export {
	createSerializedDaemonTickRunner,
	getSyncDaemonPhase,
	runSyncDaemon,
	setSyncDaemonError,
	setSyncDaemonOk,
	setSyncDaemonPhase,
	syncDaemonTick,
} from "./sync-daemon.js";
export type { MdnsEntry } from "./sync-discovery.js";
export {
	addressDedupeKey,
	advertiseMdns,
	DEFAULT_SERVICE_TYPE,
	discoverPeersViaMdns,
	formatHostPort,
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
export type { SyncFailureCategory, SyncPassOptions, SyncResult } from "./sync-pass.js";
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
export type {
	ApplyReplicationOpsOptions,
	ApplyResult,
	DiagnoseStalePeerReceivedRowsResult,
	FilterReplicationSkipped,
	InboundScopeRejection,
	InboundScopeRejectionPeerSummary,
	InboundScopeRejectionReason,
	InboundScopeRejectionRecord,
	InboundScopeRejectionSummaryOptions,
	ListInboundScopeRejectionsOptions,
	ReassignScopePayload,
	ReconcileStalePeerReceivedRowsOptions,
	ReconcileStalePeerReceivedRowsResult,
	StalePeerReceivedRowDiagnostic,
	StalePeerReceivedRowReason,
} from "./sync-replication.js";
export {
	ACCESS_CLEANUP_OP_TYPE,
	applyReplicationOps,
	backfillReplicationOps,
	bulkPruneReplicationOpsByAgeCutoff,
	chunkOpsBySize,
	clockTuple,
	DEFAULT_SYNC_SCOPE_ID,
	diagnoseStalePeerReceivedRows,
	extractReplicationOps,
	filterReplicationOpsForSync,
	filterReplicationOpsForSyncWithStatus,
	getReplicationCursor,
	getSyncResetState,
	hasUnsyncedSharedMemoryChanges,
	isNewerClock,
	listInboundScopeRejections,
	loadMemorySnapshotPageForPeer,
	loadReplicationOpsForPeer,
	loadReplicationOpsSince,
	migrateLegacyImportKeys,
	parseReassignScopePayload,
	peerCanSyncPrivateOpByPersonalScopeGrant,
	personalScopeGrantStatusForPeer,
	planReplicationOpsAgePrune,
	pruneReplicationOps,
	pruneReplicationOpsUntilCaughtUp,
	REASSIGN_SCOPE_OP_TYPE,
	reconcileStalePeerReceivedRows,
	recordAccessCleanupOp,
	recordReplicationOp,
	recordScopeReassignment,
	rejectInboundScopeFailures,
	replicationOpRequiresPersonalScopeAuthorization,
	setReplicationCursor,
	setSyncResetState,
	summarizeInboundScopeRejections,
	syncProjectAllowedByFilters,
	syncVisibilityAllowed,
} from "./sync-replication.js";
export { listRetentionScopeIds, SyncRetentionRunner } from "./sync-retention-runner.js";
export type {
	AuthorizedScopeEntry,
	PerPeerScopeSyncEntry,
	SyncScopeRequest,
	SyncScopeRequestMode,
	SyncScopeResetReason,
} from "./sync-scope-protocol.js";
export {
	addSyncScopeToBoundary,
	listAuthorizedScopesForPeer,
	listPerPeerScopeSyncState,
	parseSyncScopeRequest,
	SYNC_SCOPE_QUERY_PARAM,
	scopeAuthorizationFailureReason,
	syncScopeResetRequiredPayload,
} from "./sync-scope-protocol.js";
export { deriveTags, fileTags, normalizeTag } from "./tags.js";
// Test utilities (exported for consumer packages like viewer-server)
export type { MixedScopeFixture } from "./test-utils.js";
export { initTestSchema, insertTestSession, seedMixedScopeFixture } from "./test-utils.js";
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
	PackRenderOptions,
	PackResponse,
	PackTrace,
	PackTraceCandidate,
	PackTraceCandidateScores,
	PackTraceDisposition,
	PackTraceMode,
	PackTraceSection,
	RawEvent,
	RawEventFlushBatch,
	RawEventIngestSample,
	RawEventIngestStats,
	RawEventSession,
	ReplicationClock,
	ReplicationCursor,
	ReplicationOp,
	ReplicationOpsAgePrunePlan,
	ReplicationOpsPruneResult,
	Session,
	SessionSummary,
	StoreStats,
	SyncAttempt,
	SyncDaemonState,
	SyncDevice,
	SyncDirtyLocalState,
	SyncMemorySnapshotItem,
	SyncNonce,
	SyncPeer,
	SyncResetBoundary,
	SyncResetRequired,
	SyncResetState,
	TimelineItemResponse,
	UsageEvent,
	UserPrompt,
} from "./types.js";
export {
	runVectorMigrationPass,
	VECTOR_MODEL_MIGRATION_JOB,
	VectorModelMigrationRunner,
} from "./vector-migration.js";
export type {
	BackfillVectorsOptions,
	BackfillVectorsResult,
	SemanticIndexDiagnostics,
	SemanticSearchResult,
} from "./vectors.js";
export {
	backfillVectors,
	getSemanticIndexDiagnostics,
	semanticSearch,
	storeVectors,
} from "./vectors.js";
