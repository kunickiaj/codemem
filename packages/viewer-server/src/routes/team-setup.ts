import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
	CoordinatorLegacyTeamCompletionManifestV1,
	CoordinatorLegacyTeamCompletionRecord,
	LegacyTeamCandidateView,
	LegacyTeamConfiguredGroupSnapshot,
	LegacyTeamSetupAccessDeltaV1,
	LegacyTeamSetupActivationErrorCode,
	LegacyTeamSetupActivationResultV1,
	LegacyTeamSetupDraftView,
	LegacyTeamSetupErrorReason,
	MemoryStore,
} from "@codemem/core";
import {
	applyLegacyTeamSetupCompletionManifest,
	applyLegacyTeamSetupCompletionManifestAndReturnActivation,
	applyTeamMemberRemovals,
	areLegacyTeamSetupCompletionPolicyFactsAdditivelyCompatible,
	buildBaseUrl,
	type CoordinatorTeamMemberRemoval,
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	claimRecipientPolicyActorMutations,
	claimRecipientPolicyPublicationMutation,
	clearLegacyTeamSetupDeviceDecision,
	completeMaintenanceJob,
	containLegacyTeamSetupCompletionConflict,
	coordinatorCreateLegacyTeamCompletionAction,
	coordinatorGetLegacyTeamCompletionAction,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	coordinatorListLegacyTeamCompletionsAction,
	coordinatorListRemovedDevicesAction,
	coordinatorListTeamMemberRemovalsAction,
	deriveLegacyTeamSetupCompletionManifest,
	deterministicPolicyTeamId,
	discoverLegacyTeamCandidates,
	fetchPeerRemovalLookup,
	fingerprintPublicKey,
	getLegacyTeamSetupDraft,
	inspectFreshLegacyTeamSetupActivation,
	inspectLegacyTeamSetupActivation,
	isLegacyTeamCandidateSelectable,
	isLegacyTeamSetupProjectMappingIdentity,
	LegacyTeamSetupAdditiveConvergenceError,
	type LegacyTeamSetupDeviceRemovalEvidence,
	LegacyTeamSetupDeviceRemovalsUnavailableError,
	type LegacyTeamSetupPeerRemovalEvidence,
	LegacyTeamSetupRosterCapacityError,
	legacyTeamCandidateId,
	legacyTeamCandidateProjectInventory,
	legacyTeamCanonicalProjectRef,
	legacyTeamDeviceRef,
	legacyTeamResolvedProjectRef,
	legacyTeamSetupApiErrorCode,
	legacyTeamSetupCompletionActorIds,
	legacyTeamSetupFailureCheck,
	listProjectScopeCandidates,
	loadRuntimeSigningPublicKey,
	localRemovedDeviceIds,
	normalizedCoordinatorId,
	normalizeHumanPresentationName,
	previewLegacyTeamSetupActivation,
	RemoteCoordinatorRequestError,
	readCoordinatorSyncConfig,
	recipientPolicyDigest,
	reconstructLegacyTeamSetupCompletionManifest,
	refreshLegacyTeamCandidate,
	replayLegacyTeamSetupActivation,
	requireLegacyTeamSetupAccessDeltaWithinLimit,
	serializeRecipientPolicyActorMutations,
	serializeRecipientPolicyCoordinatorGroupMutation,
	serializeRecipientPolicyPublicationMutation,
	serializeRecipientPolicyTeamMutation,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
	setLegacyTeamSetupProjectMapping,
	startMaintenanceJob,
	validateLegacyTeamSetupCompletionManifest,
	validateLegacyTeamSetupCompletionManifestBinding,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import {
	createTeamSetupReconciliation,
	type TeamSetupReconciliation,
	type TeamSetupReconciliationOutcome,
	type TeamSetupReconciliationRead,
} from "./team-setup-reconciliation.js";
import {
	type LegacyTeamSetupCandidateSummaryV1,
	type LegacyTeamSetupDetailResponseV1,
	type LegacyTeamSetupDeviceV1,
	type LegacyTeamSetupErrorResponseV1,
	type LegacyTeamSetupFinishResponseV1,
	type LegacyTeamSetupIdentityChoiceV1,
	type LegacyTeamSetupPendingCandidateSummaryV1,
	type LegacyTeamSetupProjectV1,
	type LegacyTeamSetupSummaryResponseV1,
	type LegacyTeamSetupUnavailableReasonV1,
	type LegacyTeamSetupViewerAccessDeltaV1,
	projectLegacyTeamSetupView,
} from "./team-setup-view.js";

export type {
	LegacyTeamSetupActionBlockedReasonV1,
	LegacyTeamSetupActionGateV1,
	LegacyTeamSetupCandidateSummaryV1,
	LegacyTeamSetupDetailResponseV1,
	LegacyTeamSetupDeviceV1,
	LegacyTeamSetupErrorResponseV1,
	LegacyTeamSetupFinishResponseV1,
	LegacyTeamSetupIdentityChoiceV1,
	LegacyTeamSetupMutationResponseV1,
	LegacyTeamSetupPendingCandidateSummaryV1,
	LegacyTeamSetupProjectV1,
	LegacyTeamSetupSummaryResponseV1,
	LegacyTeamSetupUnavailableReasonV1,
	LegacyTeamSetupViewerAccessDeltaV1,
	LegacyTeamSetupViewV1,
} from "./team-setup-view.js";

const TEAM_SETUP_VERSION = 1 as const;
const MAX_CONFIGURED_GROUPS = 25;
const MAX_SCOPE_EVIDENCE_COORDINATORS = 100;
const MAX_DEVICES = 500;
const MAX_PROJECTS = 500;
const MAX_IDENTITY_CHOICES = 500;
const MAX_COMPLETED_IDENTITY_CHOICES = MAX_DEVICES * 4;
const MAX_PROJECT_MAPPING_CHOICES = 500;
const MAX_TOTAL_PROJECT_MAPPING_CHOICES = 10_000;
const MAX_PROJECT_MAPPING_SCAN_ROWS = 10_000;
const MAX_PROJECT_MAPPING_METADATA_ROWS = 10_000;
const MAX_MUTATION_BODY_BYTES = 8_192;
const SUMMARY_SNAPSHOT_CACHE_TTL_MS = 30_000;
const COORDINATOR_ROSTER_READ_BUDGET_MS = 60_000;

function serializeCanonicalManifestMutation<T>(
	store: MemoryStore,
	groupId: string,
	manifest: CoordinatorLegacyTeamCompletionManifestV1,
	operation: (actorIds: readonly string[]) => Promise<T>,
): Promise<T> {
	// Keep publication -> sorted actors -> Team -> group ordering shared with core and finish.
	return serializeRecipientPolicyPublicationMutation(store.db, () => {
		const actorIds = legacyTeamSetupCompletionActorIds(store.db, manifest);
		return serializeRecipientPolicyActorMutations(store.db, actorIds, () =>
			serializeRecipientPolicyTeamMutation(store.db, manifest.team_id, () =>
				serializeRecipientPolicyCoordinatorGroupMutation(store.db, groupId, () =>
					operation(actorIds),
				),
			),
		);
	});
}

function finishDraftActorIds(draft: LegacyTeamSetupDraftView): string[] {
	return draft.devices.flatMap((device) => [
		...(device.decision === "included" && device.targetIdentityId ? [device.targetIdentityId] : []),
		...(device.existingIdentityId ? [device.existingIdentityId] : []),
	]);
}

function completionRecipientPolicyLocksHeld(actorIds: readonly string[]) {
	return {
		publication: true,
		actors: actorIds,
		team: true,
		coordinatorGroup: true,
	} as const;
}
export const TEAM_SETUP_ROUTE_PREFIX = "/api/sync/team-setup/v1";
const CANDIDATE_REF_PATTERN = /^legacy-team-candidate:[0-9a-f]{32}$/u;
const DEVICE_REF_PATTERN = /^legacy-team-device-ref-v1:[0-9a-f]{64}$/u;
const PROJECT_REF_PATTERN = /^legacy-team-project-ref-v1:[0-9a-f]{64}$/u;
const IDENTITY_REF_PATTERN = /^legacy-team-viewer-identity-ref-v1:[0-9a-f]{64}$/u;
const RESOLVED_PROJECT_REF_PATTERN = /^legacy-team-resolved-project-ref-v1:[0-9a-f]{64}$/u;
const ATTEMPT_ID_PATTERN = /^legacy-team-attempt:[0-9a-f-]{36}$/u;
const FINISH_DIGEST_PATTERN = /^legacy-team-activation-finish-v1:[0-9a-f]{64}$/u;
const ACCESS_DELTA_DIGEST_PATTERN = /^legacy-team-access-delta:[0-9a-f]{64}$/u;
const VIEWER_ACCESS_DELTA_DIGEST_PATTERN = /^legacy-team-viewer-access-delta-v1:[0-9a-f]{64}$/u;
const activeCandidateMutations = new WeakMap<MemoryStore["db"], Map<string, Promise<void>>>();
/**
 * How many times each candidate's claim has been taken or released. A background
 * pass compares it with the count it began with, to tell whether another
 * operation ran on the candidate since.
 */
const candidateMutationRevisions = new WeakMap<MemoryStore["db"], Map<string, number>>();

function candidateMutationRevision(db: MemoryStore["db"], candidateRef: string): number {
	return candidateMutationRevisions.get(db)?.get(candidateRef) ?? 0;
}

function advanceCandidateMutationRevision(db: MemoryStore["db"], candidateRef: string): void {
	const revisions = candidateMutationRevisions.get(db) ?? new Map<string, number>();
	candidateMutationRevisions.set(db, revisions);
	revisions.set(candidateRef, (revisions.get(candidateRef) ?? 0) + 1);
}

/**
 * Claims the candidate for one access-changing operation, or returns null when
 * another holds it. Draft and finish routes, Team recovery and each background
 * reconciliation pass take it, so none of them runs across another.
 */
export function claimCandidateMutation(
	db: MemoryStore["db"],
	candidateRef: string,
): (() => void) | null {
	let active = activeCandidateMutations.get(db);
	if (!active) {
		active = new Map();
		activeCandidateMutations.set(db, active);
	}
	if (active.has(candidateRef)) return null;
	let settle: () => void = () => undefined;
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	active.set(candidateRef, settled);
	advanceCandidateMutationRevision(db, candidateRef);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		active?.delete(candidateRef);
		advanceCandidateMutationRevision(db, candidateRef);
		settle();
	};
}

/** Resolves once the current holder of the candidate claim (if any) releases it. */
function candidateMutationSettled(db: MemoryStore["db"], candidateRef: string): Promise<void> {
	return activeCandidateMutations.get(db)?.get(candidateRef) ?? Promise.resolve();
}

/**
 * One background pass over the candidates. `skipped` are the ones it leaves for
 * the next pass instead of reporting a failure. `revisions` holds the claim
 * revision each candidate must still have for the pass to act on it: the one it
 * had before the pass first read the coordinator, moved on only by the pass's
 * own claims.
 */
interface CandidatePass {
	skipped: Set<string>;
	revisions: Map<string, number>;
}

const candidatePass = new AsyncLocalStorage<CandidatePass>();

function beginCandidatePass(db: MemoryStore["db"]): CandidatePass {
	return { skipped: new Set(), revisions: new Map(candidateMutationRevisions.get(db)) };
}

/** Whether no other operation holds the candidate or has run on it since the pass began. */
function isUntouchedSince(db: MemoryStore["db"], pass: CandidatePass, candidateRef: string) {
	return (
		!activeCandidateMutations.get(db)?.has(candidateRef) &&
		candidateMutationRevision(db, candidateRef) === (pass.revisions.get(candidateRef) ?? 0)
	);
}

/**
 * Claims the candidate for a write of a background pass, or returns null when
 * another operation holds it or has run on it since the pass began. What the
 * pass read from the coordinator may be older than that operation, for example
 * a list of completions taken while a setup was finishing, so the pass must not
 * act on it once the setup lets go.
 */
function claimForCandidatePass(
	db: MemoryStore["db"],
	pass: CandidatePass,
	candidateRef: string,
): (() => void) | null {
	const untouched = isUntouchedSince(db, pass, candidateRef);
	const release = claimCandidateMutation(db, candidateRef);
	if (!release) return null;
	if (!untouched) {
		release();
		return null;
	}
	return () => {
		release();
		// The pass's own claim and release are not another operation's.
		pass.revisions.set(candidateRef, candidateMutationRevision(db, candidateRef));
	};
}

async function runCandidateMutation<T>(
	db: MemoryStore["db"],
	candidateRef: string,
	operation: () => Promise<T>,
): Promise<boolean> {
	const pass = candidatePass.getStore();
	const release = pass
		? claimForCandidatePass(db, pass, candidateRef)
		: claimCandidateMutation(db, candidateRef);
	if (!release) {
		pass?.skipped.add(candidateRef);
		return false;
	}
	try {
		await operation();
		return true;
	} finally {
		release();
	}
}

interface LegacyTeamConfiguredGroupSnapshotLoadOptions {
	candidateRef?: string;
	deadlineMs?: number;
}

export interface LegacyTeamCandidateGroupDescriptor {
	groupId: string;
	coordinatorId: string;
}

interface CompletionReconciliationOptions {
	isolateApplyFailures?: boolean;
	onFailure?: (group: LegacyTeamCandidateGroupDescriptor, error: unknown) => void;
}

function completionFailureHandlers(options: CompletionReconciliationOptions) {
	const handledGroupIds = new Set<string>();
	const reportFailure = (group: LegacyTeamCandidateGroupDescriptor, error: unknown) => {
		// A failed read is not proof that a coordinator completion is absent.
		// Do not try publishing the local completion after reporting its blocker.
		handledGroupIds.add(group.groupId);
		options.onFailure?.(group, error);
	};
	const handleFailure = (group: LegacyTeamCandidateGroupDescriptor, error: unknown) => {
		if (!options.isolateApplyFailures) throw error;
		reportFailure(group, error);
	};
	return { handledGroupIds, handleFailure, reportFailure };
}

// Neither failure proves divergence, so the active Team must not be contained.
/**
 * The group's Team member removals could not be read, so a completion is not
 * applied in this pass: it might make a removed person a member again on a
 * machine that has not recorded the removal. Nothing diverged.
 */
class TeamMemberRemovalsUnavailableError extends Error {
	constructor(cause?: unknown) {
		super("team_member_removals_unavailable", cause === undefined ? undefined : { cause });
		this.name = "TeamMemberRemovalsUnavailableError";
	}
}

function isNonDivergentApplyFailure(error: unknown): boolean {
	return (
		error instanceof LegacyTeamSetupAdditiveConvergenceError ||
		error instanceof LegacyTeamSetupDeviceRemovalsUnavailableError ||
		error instanceof TeamMemberRemovalsUnavailableError
	);
}

function completionConflictError(cause: unknown): Error {
	return new Error("team_setup_completion_conflict", { cause });
}

function addFreshCompletionGroups(
	index: Map<string, LegacyTeamConfiguredGroupSnapshot>,
	groups: Array<LegacyTeamConfiguredGroupSnapshot | undefined>,
	keyOf: (group: LegacyTeamConfiguredGroupSnapshot) => string,
): void {
	for (const group of groups) {
		if (!group) continue;
		const key = keyOf(group);
		if (index.has(key)) throw new Error("team_setup_completion_invalid");
		index.set(key, group);
	}
}

function groupCompletionFailureHandler(
	groups: Map<string, LegacyTeamCandidateGroupDescriptor>,
	handleFailure: (group: LegacyTeamCandidateGroupDescriptor, error: unknown) => void,
) {
	return (groupId: string, error: unknown) => {
		const group = groups.get(groupId);
		if (group) handleFailure(group, error);
	};
}

interface CompletionBlocker {
	code: LegacyTeamSetupActivationErrorCode;
	reason?: LegacyTeamSetupErrorReason;
}

/** The safe cause behind a retryable completion failure, when one is known. */
function completionFailureReason(error: unknown): LegacyTeamSetupErrorReason | undefined {
	const chain = errorChain(error);
	if (chain.some((item) => item instanceof LegacyTeamSetupDeviceRemovalsUnavailableError))
		return "device_removals_unavailable";
	if (chain.some((item) => item instanceof TeamMemberRemovalsUnavailableError))
		return "team_member_removals_unavailable";
	return undefined;
}

function completionBlocker(error: unknown): CompletionBlocker {
	const code = apiErrorCode(new Error(completionApiError(error)));
	const reason = completionFailureReason(error);
	return reason && code === "team_setup_completion_unavailable" ? { code, reason } : { code };
}

/** A detail read failure, with the safe completion cause when one is known. */
function detailFailure(error: unknown, route: string) {
	const failure = teamSetupFailure(error, route);
	const { reason } = completionBlocker(error);
	const body: LegacyTeamSetupErrorResponseV1 = reason
		? { error: failure.code, reason }
		: { error: failure.code };
	return { body, status: failure.status };
}

function summaryReconciliationOptions(
	blockingErrors: Map<string, CompletionBlocker>,
): CompletionReconciliationOptions {
	return {
		isolateApplyFailures: true,
		onFailure: (group, error) => {
			blockingErrors.set(
				legacyTeamCandidateId(group.coordinatorId, group.groupId),
				completionBlocker(error),
			);
		},
	};
}

export type LegacyTeamConfiguredGroupSnapshotLoader = (
	options?: LegacyTeamConfiguredGroupSnapshotLoadOptions,
) => Promise<LegacyTeamConfiguredGroupSnapshot[]>;

export interface TeamSetupRoutesOptions {
	getStore: () => MemoryStore;
	loadLegacyTeamConfiguredGroupSnapshots?: LegacyTeamConfiguredGroupSnapshotLoader;
	snapshotLoaderDependencies?: LegacyTeamSnapshotLoaderDependencies;
	completionDependencies?: LegacyTeamCompletionDependencies | null;
	readCoordinatorConfig?: typeof readCoordinatorSyncConfig;
	registerSummaryInvalidator?: (invalidate: () => void) => void;
	/** How soon a check retries candidates it skipped because a route held them; for tests. */
	reconciliationRetryDelayMs?: number;
	/** Receives the background reconciliation, so the service can start it and tests can await it. */
	registerReconciliation?: (
		reconciliation: TeamSetupReconciliation<SummaryReconciliationResult>,
	) => void;
}

export interface LegacyTeamCompletionDependencies {
	create: typeof coordinatorCreateLegacyTeamCompletionAction;
	get?: typeof coordinatorGetLegacyTeamCompletionAction;
	list: typeof coordinatorListLegacyTeamCompletionsAction;
	listRemovals?: typeof coordinatorListRemovedDevicesAction;
	/** The group's Team member removals, read before any completion is applied. */
	listTeamMemberRemovals?: typeof coordinatorListTeamMemberRemovalsAction;
	/** The sync daemon's signed peer removal lookup, asked with this device's key. */
	lookupPeerRemovals?: (
		store: MemoryStore,
		config: ReturnType<typeof readCoordinatorSyncConfig>,
	) => ReturnType<typeof fetchPeerRemovalLookup>;
}

/**
 * The daemon's signed lookup, asked with this device's existing identity. A
 * reconciliation never creates or repairs signing keys: with no usable identity
 * the lookup is reported unavailable, which keeps every pairing.
 */
export async function lookupPeerRemovalsAsDaemon(
	store: MemoryStore,
	config: ReturnType<typeof readCoordinatorSyncConfig>,
) {
	const identity = daemonSigningIdentity(store);
	if (!identity) return unavailablePeerRemovalLookup();
	return fetchPeerRemovalLookup(store, config, identity);
}

/**
 * The identity the sync daemon signs coordinator requests with: this store's
 * one device, and its keys in the directory `CODEMEM_KEYS_DIR` names or the
 * default one. Null when the store has no single device or its key is not
 * usable. Nothing here creates or repairs a key.
 */
export function daemonSigningIdentity(
	store: Pick<MemoryStore, "db">,
): { localDeviceId: string; keysDir: string | undefined } | null {
	const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
	const rows = store.db.prepare("SELECT device_id FROM sync_device LIMIT 2").pluck().all();
	const localDeviceId = rows.length === 1 && typeof rows[0] === "string" ? rows[0] : null;
	if (!localDeviceId) return null;
	if (!loadRuntimeSigningPublicKey(store.db, { deviceId: localDeviceId, keysDir })) return null;
	return { localDeviceId, keysDir };
}

function unavailablePeerRemovalLookup(): Awaited<ReturnType<typeof fetchPeerRemovalLookup>> {
	return {
		status: "failed",
		revoked: [],
		removed: [],
		enrolled: [],
		removalSeq: null,
		generation: null,
		removedFromGroups: [],
	};
}

const defaultCompletionDependencies: LegacyTeamCompletionDependencies = {
	create: coordinatorCreateLegacyTeamCompletionAction,
	get: coordinatorGetLegacyTeamCompletionAction,
	list: coordinatorListLegacyTeamCompletionsAction,
	listRemovals: coordinatorListRemovedDevicesAction,
	listTeamMemberRemovals: coordinatorListTeamMemberRemovalsAction,
	lookupPeerRemovals: lookupPeerRemovalsAsDaemon,
};

// Undefined when no removal reader is configured: core then has no removal
// evidence and handles a missing device as it did before removal replay.
type ListCompletionRemovals = () => Promise<LegacyTeamSetupDeviceRemovalEvidence | undefined>;
type LookupCompletionPeerRemovals = () => Promise<LegacyTeamSetupPeerRemovalEvidence | undefined>;

/** Evidence core reads for a device missing from a completed Team's roster. */
interface CompletionRemovalReads {
	listRemovals: ListCompletionRemovals;
	lookupPeerRemovals: LookupCompletionPeerRemovals;
	/** Undefined when no reader is configured. Throws when the read fails. */
	listTeamMemberRemovals: (groupId: string) => Promise<CoordinatorTeamMemberRemoval[] | undefined>;
}

interface LegacyTeamSnapshotLoaderDependencies {
	readConfig: typeof readCoordinatorSyncConfig;
	listGroups: typeof coordinatorListGroupsAction;
	listDevices: typeof coordinatorListDevicesAction;
}

const defaultSnapshotLoaderDependencies: LegacyTeamSnapshotLoaderDependencies = {
	readConfig: readCoordinatorSyncConfig,
	listGroups: coordinatorListGroupsAction,
	listDevices: coordinatorListDevicesAction,
};

function safeCoordinatorError(): Error {
	return new Error("team_setup_roster_unavailable");
}

class CoordinatorAdminConfigurationMissingError extends Error {
	constructor() {
		super("team_setup_roster_unavailable");
		this.name = "CoordinatorAdminConfigurationMissingError";
	}
}

function isPassthroughSnapshotLoadError(error: unknown): boolean {
	return (
		error instanceof CoordinatorAdminConfigurationMissingError ||
		(error instanceof Error && error.message === "legacy_team_setup_roster_too_large")
	);
}

/**
 * Without coordinator admin access this Viewer cannot discover groups to
 * migrate, so the summary suppresses discovery. Members still see their Teams
 * from local records, and Devices reports incomplete coordinator setup. Saved,
 * unfinished migrations stay visible so they can be resumed once access
 * returns. Only the summary uses this; Team detail and finish stay fail-closed.
 */
function summaryWithoutAdminAccess(
	error: unknown,
	getStore: () => MemoryStore,
	readConfig: typeof readCoordinatorSyncConfig,
): LegacyTeamConfiguredGroupSnapshot[] {
	if (!(error instanceof CoordinatorAdminConfigurationMissingError)) throw error;
	const store = getStore();
	const config = readConfig();
	const eligibleCandidateRefs = new Set(
		legacyTeamCandidateGroupDescriptors(
			store,
			config.syncCoordinatorUrl,
			config.syncCoordinatorGroups,
		).map(({ coordinatorId, groupId }) => legacyTeamCandidateId(coordinatorId, groupId)),
	);
	if (eligibleCandidateRefs.size === 0) return [];
	const eligibleRefs = [...eligibleCandidateRefs];
	const placeholders = eligibleRefs.map(() => "?").join(", ");
	const rows = store.db
		.prepare(
			`SELECT DISTINCT coordinator_id, group_id FROM legacy_team_setup_drafts
			 WHERE candidate_id IN (${placeholders})
			 ORDER BY coordinator_id, group_id`,
		)
		.all(...eligibleRefs) as Array<{ coordinator_id: string; group_id: string }>;
	// Bound the result only after dropping finished work, so old completed
	// migrations can never crowd out an unfinished one.
	const pending = rows.flatMap((row) => {
		const candidateRef = legacyTeamCandidateId(row.coordinator_id, row.group_id);
		if (!eligibleCandidateRefs.has(candidateRef)) return [];
		const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
		if (!draft || draft.state === "completed" || hasCompletedLegacyTeamSetup(store, candidateRef)) {
			return [];
		}
		// Only the saved draft is read for these groups; no roster data is needed.
		return [
			{
				coordinatorId: row.coordinator_id,
				groupId: row.group_id,
				displayName: draft.displayName,
				devices: [],
			},
		];
	});
	return pending.slice(0, MAX_CONFIGURED_GROUPS);
}

function loadSummarySnapshots(
	load: () => Promise<LegacyTeamConfiguredGroupSnapshot[]>,
	getStore: () => MemoryStore,
	readConfig: typeof readCoordinatorSyncConfig,
): () => Promise<LegacyTeamConfiguredGroupSnapshot[]> {
	return () => load().catch((error) => summaryWithoutAdminAccess(error, getStore, readConfig));
}

function createLoadedSummarySnapshotCache(
	load: () => Promise<LegacyTeamConfiguredGroupSnapshot[]>,
	options: TeamSetupRoutesOptions,
): ReturnType<typeof createCachedSnapshotLoader> {
	const readConfig =
		options.readCoordinatorConfig ??
		options.snapshotLoaderDependencies?.readConfig ??
		readCoordinatorSyncConfig;
	return createCachedSnapshotLoader(
		loadSummarySnapshots(load, options.getStore, readConfig),
		SUMMARY_SNAPSHOT_CACHE_TTL_MS,
	);
}

function isCoordinatorRosterTooLargeError(error: unknown): boolean {
	return error instanceof Error && error.message === "coordinator_response_too_large";
}

function remoteCoordinatorHttpStatus(error: unknown): number | null {
	if (!(error instanceof Error)) return null;
	const status = /Remote coordinator request failed \((\d{3})\):/u.exec(error.message)?.[1];
	return status ? Number(status) : null;
}

function isTransientCoordinatorReadError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const remoteStatus = remoteCoordinatorHttpStatus(error);
	if (remoteStatus) return [408, 429, 500, 502, 503, 504].includes(remoteStatus);
	return (
		error.name === "TimeoutError" ||
		error.name === "AbortError" ||
		/request_timeout|fetch failed|timed out|timeout/iu.test(error.message)
	);
}

function isUnsupportedCompletionQuery(error: unknown): boolean {
	const status = remoteCoordinatorHttpStatus(error);
	return status === 404 || status === 405;
}

/**
 * Batch completion decoding rejects the whole payload when any one record is
 * malformed or misattributed, so the failure cannot be pinned to a group.
 */
function isUnattributableCompletionBatchError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === "coordinator_completion_response_malformed" ||
			error.message === "coordinator_completion_group_mismatch")
	);
}

async function listCompletionRecordsPerGroup(
	groupIds: readonly string[],
	list: (groupIds: string[]) => Promise<CoordinatorLegacyTeamCompletionRecord[]>,
	onFailure: (groupId: string, error: unknown) => void,
	batchError: unknown,
): Promise<CoordinatorLegacyTeamCompletionRecord[]> {
	// The failed single-group query already identifies the affected candidate.
	if (groupIds.length === 1) {
		onFailure(groupIds[0] as string, batchError);
		return [];
	}
	const records: CoordinatorLegacyTeamCompletionRecord[] = [];
	for (const groupId of groupIds) {
		try {
			records.push(...(await list([groupId])));
		} catch (error) {
			if (!isUnattributableCompletionBatchError(error)) throw error;
			onFailure(groupId, error);
		}
	}
	return records;
}

async function retryTransientCoordinatorRead<T>(
	read: (timeoutS: number) => Promise<T>,
	configuredTimeoutS: number,
	deadlineMs: number,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const remainingMs = deadlineMs - Date.now();
		if (remainingMs <= 0) throw lastError ?? safeCoordinatorError();
		try {
			return await read(Math.max(0.1, Math.min(configuredTimeoutS, remainingMs / 1_000)));
		} catch (error) {
			lastError = error;
			if (!isTransientCoordinatorReadError(error) || attempt === 7) throw error;
			const delayMs = Math.min(100 * 2 ** attempt, 2_000, deadlineMs - Date.now());
			if (delayMs <= 0) throw error;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	throw lastError;
}

export function remainingCoordinatorTimeoutS(
	configuredTimeoutS: number,
	deadlineMs: number,
	nowMs = Date.now(),
): number | null {
	const remainingMs = deadlineMs - nowMs;
	return remainingMs <= 0 ? null : Math.max(0.1, Math.min(configuredTimeoutS, remainingMs / 1_000));
}

function configuredGroupIds(groups: string[]): string[] {
	const unique = [...new Set(groups.map((group) => group.trim()).filter(Boolean))];
	if (unique.length > MAX_CONFIGURED_GROUPS) throw safeCoordinatorError();
	return unique;
}

export { normalizedCoordinatorId };

export function legacyTeamCandidateGroupDescriptors(
	store: MemoryStore | undefined,
	coordinatorUrl: string,
	groups: string[],
): LegacyTeamCandidateGroupDescriptor[] {
	const configuredIds = configuredGroupIds(groups);
	const configuredCoordinatorId = buildBaseUrl(coordinatorUrl);
	const normalizedConfiguredCoordinatorId = normalizedCoordinatorId(configuredCoordinatorId);
	if (!configuredCoordinatorId || !normalizedConfiguredCoordinatorId) throw safeCoordinatorError();
	let scopeBackedDescriptors: LegacyTeamCandidateGroupDescriptor[] = [];
	if (store) {
		try {
			scopeBackedDescriptors = scopeBackedGroupDescriptors(
				store,
				normalizedConfiguredCoordinatorId,
				MAX_CONFIGURED_GROUPS - configuredIds.length,
				configuredIds,
			);
		} catch {
			// Scope discovery is additive. Preserve configured coordinator candidates
			// when local evidence cannot be read.
			scopeBackedDescriptors = [];
		}
	}
	return [
		...configuredIds.map((groupId) => ({ groupId, coordinatorId: configuredCoordinatorId })),
		...scopeBackedDescriptors,
	];
}

function scopeBackedGroupDescriptors(
	store: MemoryStore,
	normalizedConfiguredCoordinatorId: string,
	limit: number,
	excludedGroupIds: string[],
): LegacyTeamCandidateGroupDescriptor[] {
	if (limit <= 0) return [];
	const textualCoordinatorIds = store.db
		.prepare(
			`SELECT DISTINCT coordinator_id FROM replication_scopes
			 WHERE status = 'active' AND authority_type = 'coordinator'
			   AND kind IN ('team', 'team_default', 'org', 'client')
			   AND coordinator_id IS NOT NULL
			   AND group_id IS NOT NULL AND TRIM(group_id) <> ''
			 ORDER BY coordinator_id LIMIT ?`,
		)
		.pluck()
		.all(MAX_SCOPE_EVIDENCE_COORDINATORS + 1) as string[];
	if (textualCoordinatorIds.length > MAX_SCOPE_EVIDENCE_COORDINATORS) {
		return [];
	}
	const matchingTextualIds = textualCoordinatorIds.filter(
		(value) => normalizedCoordinatorId(value) === normalizedConfiguredCoordinatorId,
	);
	if (matchingTextualIds.length === 0) return [];
	const coordinatorPlaceholders = matchingTextualIds.map(() => "?").join(", ");
	const excludedGroupClause =
		excludedGroupIds.length === 0
			? ""
			: `AND TRIM(group_id) NOT IN (${excludedGroupIds.map(() => "?").join(", ")})`;
	const groupIds = store.db
		.prepare(
			`SELECT DISTINCT TRIM(group_id) AS group_id FROM replication_scopes
			 WHERE status = 'active' AND authority_type = 'coordinator'
			   AND kind IN ('team', 'team_default', 'org', 'client')
			   AND coordinator_id IN (${coordinatorPlaceholders})
			   AND group_id IS NOT NULL AND TRIM(group_id) <> ''
			   ${excludedGroupClause}
			 ORDER BY TRIM(group_id) LIMIT ?`,
		)
		.pluck()
		.all(...matchingTextualIds, ...excludedGroupIds, limit) as string[];
	if (groupIds.length === 0) return [];
	const groupPlaceholders = groupIds.map(() => "?").join(", ");
	const records = store.db
		.prepare(
			`SELECT DISTINCT TRIM(group_id) AS group_id, coordinator_id FROM replication_scopes
			 WHERE status = 'active' AND authority_type = 'coordinator'
			   AND kind IN ('team', 'team_default', 'org', 'client')
			   AND coordinator_id IN (${coordinatorPlaceholders})
			   AND TRIM(group_id) IN (${groupPlaceholders})
			 ORDER BY TRIM(group_id), coordinator_id`,
		)
		.all(...matchingTextualIds, ...groupIds) as Array<{
		group_id: string;
		coordinator_id: string;
	}>;
	const coordinatorIdsByGroup = new Map<string, string[]>();
	for (const record of records) {
		const coordinatorIds = coordinatorIdsByGroup.get(record.group_id) ?? [];
		coordinatorIds.push(record.coordinator_id);
		coordinatorIdsByGroup.set(record.group_id, coordinatorIds);
	}
	return groupIds.flatMap((groupId) => {
		const coordinatorIds = coordinatorIdsByGroup.get(groupId) ?? [];
		// Equivalent textual coordinator IDs still represent distinct persisted
		// candidate identities. Never merge their authorization evidence by label.
		const coordinatorId = coordinatorIds[0];
		return coordinatorIds.length === 1 && coordinatorId ? [{ groupId, coordinatorId }] : [];
	});
}

async function loadConfiguredLegacyTeamGroupSnapshotsWith(
	dependencies: LegacyTeamSnapshotLoaderDependencies,
	options: LegacyTeamConfiguredGroupSnapshotLoadOptions = {},
	getStore?: () => MemoryStore,
): Promise<LegacyTeamConfiguredGroupSnapshot[]> {
	let config: ReturnType<typeof readCoordinatorSyncConfig>;
	try {
		config = dependencies.readConfig();
	} catch {
		throw safeCoordinatorError();
	}
	const hasUrl = Boolean(config.syncCoordinatorUrl);
	const hasSecret = Boolean(config.syncCoordinatorAdminSecret);
	if (!hasUrl && !hasSecret && config.syncCoordinatorGroups.length === 0) return [];
	// A configured coordinator without an admin secret is an ordinary member.
	if (hasUrl && !hasSecret) throw new CoordinatorAdminConfigurationMissingError();
	if (!hasUrl) throw safeCoordinatorError();

	try {
		const configuredCoordinatorId = buildBaseUrl(config.syncCoordinatorUrl);
		if (!configuredCoordinatorId) throw safeCoordinatorError();
		const remoteUrl = configuredCoordinatorId;
		let store: MemoryStore | undefined;
		try {
			store = getStore?.();
		} catch {
			// Scope discovery is additive. Preserve configured coordinator candidates
			// when local evidence cannot be read.
			store = undefined;
		}
		const groupDescriptors = legacyTeamCandidateGroupDescriptors(
			store,
			config.syncCoordinatorUrl,
			config.syncCoordinatorGroups,
		);
		if (groupDescriptors.length === 0) throw safeCoordinatorError();
		const timeoutS = Math.max(1, config.syncCoordinatorTimeoutS);
		const deadlineMs = options.deadlineMs ?? Date.now() + COORDINATOR_ROSTER_READ_BUDGET_MS;
		const requestedGroupDescriptors = options.candidateRef
			? groupDescriptors.filter(
					({ coordinatorId, groupId }) =>
						legacyTeamCandidateId(coordinatorId, groupId) === options.candidateRef,
				)
			: groupDescriptors;
		const groups = await retryTransientCoordinatorRead(
			(attemptTimeoutS) =>
				dependencies.listGroups({
					remoteUrl,
					adminSecret: config.syncCoordinatorAdminSecret,
					includeArchived: false,
					timeoutS: attemptTimeoutS,
				}),
			timeoutS,
			deadlineMs,
		);
		const groupById = new Map(groups.map((group) => [group.group_id, group]));
		const outcomes = await Promise.all(
			requestedGroupDescriptors.map(async ({ coordinatorId, groupId }) => {
				// Authoritative absence is stale state, while malformed or unavailable
				// evidence stays fail-closed. Summary mode may isolate the latter only
				// when another requested group remains healthy.
				const group = groupById.get(groupId);
				if (!group || group.archived_at != null) {
					return { kind: "absent" as const };
				}
				if (
					group.group_id !== groupId ||
					(group.display_name !== null && typeof group.display_name !== "string")
				) {
					if (options.candidateRef) throw safeCoordinatorError();
					return { kind: "unavailable" as const };
				}
				let devices: Awaited<ReturnType<typeof coordinatorListDevicesAction>>;
				try {
					devices = await retryTransientCoordinatorRead(
						(attemptTimeoutS) =>
							dependencies.listDevices({
								groupId,
								includeDisabled: true,
								remoteUrl,
								adminSecret: config.syncCoordinatorAdminSecret,
								timeoutS: attemptTimeoutS,
							}),
						timeoutS,
						deadlineMs,
					);
				} catch (error) {
					if (!options.candidateRef) return { kind: "unavailable" as const };
					if (isCoordinatorRosterTooLargeError(error)) {
						throw new Error("legacy_team_setup_roster_too_large");
					}
					throw safeCoordinatorError();
				}
				if (devices.length > MAX_DEVICES) {
					if (options.candidateRef) throw new Error("legacy_team_setup_roster_too_large");
					return { kind: "unavailable" as const };
				}
				if (
					devices.some(
						(device) =>
							fingerprintPublicKey(device.public_key) !== device.fingerprint ||
							(device.enabled !== 0 && device.enabled !== 1),
					)
				) {
					if (options.candidateRef) throw safeCoordinatorError();
					return { kind: "unavailable" as const };
				}
				return {
					kind: "snapshot" as const,
					snapshot: {
						coordinatorId,
						groupId,
						displayName: group.display_name ?? "Legacy Team",
						devices: devices.map((device) => ({
							deviceId: device.device_id,
							fingerprint: device.fingerprint,
							displayName: device.display_name ?? "Device",
							enabled: device.enabled === 1,
							labelRedactionIds: [device.identity_id ?? "", device.public_key].filter(Boolean),
						})),
					},
				};
			}),
		);
		const validSnapshots = outcomes.flatMap((outcome) =>
			outcome.kind === "snapshot" ? [outcome.snapshot] : [],
		);
		if (validSnapshots.length === 0 && outcomes.some((outcome) => outcome.kind === "unavailable")) {
			throw safeCoordinatorError();
		}
		return validSnapshots;
	} catch (error) {
		if (isPassthroughSnapshotLoadError(error)) throw error;
		throw safeCoordinatorError();
	}
}

function requireBoundedSnapshots(groups: LegacyTeamConfiguredGroupSnapshot[]): void {
	if (groups.length > MAX_CONFIGURED_GROUPS) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
}

function projectionOptions(store: MemoryStore) {
	return { localActorId: store.actorId, localDeviceId: store.deviceId };
}

function discoverCandidates(
	store: MemoryStore,
	groups: LegacyTeamConfiguredGroupSnapshot[],
): LegacyTeamCandidateView[] {
	requireBoundedSnapshots(groups);
	const mayRediscover = completedTeamDiscoveryAuthority.getStore() ?? (() => false);
	return discoverLegacyTeamCandidates(store.db, {
		projection: projectionOptions(store),
		groups: groups.filter((group) => !wasCompleted(store, group) || mayRediscover(group)),
	});
}

function wasCompleted(store: MemoryStore, group: LegacyTeamCandidateGroupDescriptor): boolean {
	const candidateRef = legacyTeamCandidateId(group.coordinatorId, group.groupId);
	return (
		getLegacyTeamSetupDraft(store.db, candidateRef)?.state === "completed" ||
		hasCompletedLegacyTeamSetup(store, candidateRef)
	);
}

function candidateSummary(candidate: LegacyTeamCandidateView): LegacyTeamSetupCandidateSummaryV1 {
	return {
		candidateRef: candidate.candidateRef,
		displayName: candidate.displayName,
		status: candidate.status,
		deviceCount: candidate.deviceCount,
		projectCount: candidate.projectCount,
		unresolvedDeviceCount: candidate.unresolvedDeviceCount,
		unresolvedProjectCount: candidate.unresolvedProjectCount,
	};
}

function candidateSummaryForDraft(
	candidate: LegacyTeamCandidateView,
	draft: LegacyTeamSetupDraftView,
): LegacyTeamSetupCandidateSummaryV1 {
	return {
		...candidateSummary(candidate),
		status: draft.state === "completed" ? "ready" : draft.state,
		unresolvedDeviceCount: draft.unresolvedDeviceCount,
		unresolvedProjectCount: draft.unresolvedProjectCount,
	};
}

function candidateFromDraft(draft: LegacyTeamSetupDraftView): LegacyTeamCandidateView {
	return {
		candidateRef: draft.candidateRef,
		displayName: draft.displayName,
		status: draft.state === "completed" ? "ready" : draft.state,
		deviceCount: draft.devices.length,
		projectCount: draft.projects.length,
		unresolvedDeviceCount: draft.unresolvedDeviceCount,
		unresolvedProjectCount: draft.unresolvedProjectCount,
	};
}

function blockedCandidateSummary(
	store: MemoryStore,
	group: LegacyTeamConfiguredGroupSnapshot,
	blocker: CompletionBlocker,
): LegacyTeamSetupPendingCandidateSummaryV1 {
	const candidateRef = legacyTeamCandidateId(group.coordinatorId, group.groupId);
	const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
	const blocking = {
		blockingError: blocker.code,
		...(blocker.reason ? { blockingReason: blocker.reason } : {}),
	};
	if (draft) {
		return { ...candidateSummary(candidateFromDraft(draft)), status: "stale", ...blocking };
	}
	const forbiddenIds = [
		group.coordinatorId,
		group.groupId,
		candidateRef,
		...group.devices.flatMap((device) => [
			device.deviceId,
			device.fingerprint,
			...(device.labelRedactionIds ?? []),
		]),
	];
	return {
		candidateRef,
		displayName: safeChoiceLabel(group.displayName, "Legacy Team", forbiddenIds),
		status: "stale",
		...blocking,
		deviceCount: group.devices.length,
		projectCount: 0,
		unresolvedDeviceCount: 0,
		unresolvedProjectCount: 0,
	};
}

/**
 * What one background pass found. `views` are the candidates discovery produced
 * after this pass's fresh evidence; `failed` groups carry a blocker; `skipped`
 * groups kept the previous pass's view and blocker because a route held their claim.
 */
interface SummaryReconciliationResult {
	groups: LegacyTeamConfiguredGroupSnapshot[];
	views: Map<string, LegacyTeamCandidateView>;
	blockers: Map<string, CompletionBlocker>;
	failed: Set<string>;
	skipped: Set<string>;
}

const TEAM_SETUP_RECONCILIATION_JOB = "team_setup_reconciliation";

interface SummaryReconciliationDependencies {
	loadSnapshots: ReturnType<typeof createCachedSnapshotLoader>;
	reconcile: (
		store: MemoryStore,
		groups: LegacyTeamCandidateGroupDescriptor[],
		options: CompletionReconciliationOptions,
	) => Promise<void>;
	/** Whether current admin authority covers rediscovering a completed group. */
	mayRediscover: (group: LegacyTeamCandidateGroupDescriptor) => boolean;
	/** Reads the coordinator's device and Team member removals for one group. */
	readRemovalsForRepair: (group: LegacyTeamCandidateGroupDescriptor) => Promise<RepairEvidence>;
}

/**
 * One background pass, on fresh evidence only: it loads the roster from the
 * coordinator, creates drafts for groups that have no local setup at all, then
 * reads completions and removals. Only after that, for each group that neither
 * failed nor was skipped, it rediscovers groups with a local completion, the
 * step that can restore setup-owned Project recipients. Every discovery runs
 * under the candidate claim, and none runs on a cached roster or after a failed
 * removal read.
 */
function runSummaryReconciliation(
	store: MemoryStore,
	dependencies: SummaryReconciliationDependencies,
	previous: SummaryReconciliationResult | null,
): Promise<SummaryReconciliationResult> {
	// The pass begins before its first coordinator read, so it can tell afterwards
	// which candidates another operation held or ran on while it was reading.
	const pass = beginCandidatePass(store.db);
	return candidatePass.run(pass, () => reconcileSummaryGroups(store, dependencies, previous, pass));
}

async function reconcileSummaryGroups(
	store: MemoryStore,
	dependencies: SummaryReconciliationDependencies,
	previous: SummaryReconciliationResult | null,
	pass: CandidatePass,
): Promise<SummaryReconciliationResult> {
	const { skipped } = pass;
	dependencies.loadSnapshots.invalidate();
	const configured = await dependencies.loadSnapshots();
	// Discovery below runs one group at a time, so bound the whole roster here.
	requireBoundedSnapshots(configured);
	// A group another operation holds is not waited for. One slow holder, such as a
	// Team recovery reading the coordinator, would stall the check of every other
	// group. Nothing more is read from the coordinator for such a group: it is
	// skipped here, and the pass retries it soon.
	const groups = openSummaryGroups(store, configured, pass);
	const blockers = new Map<string, CompletionBlocker>();
	const views = new Map<string, LegacyTeamCandidateView>();
	// Applying a coordinator completion needs the group's draft. Creating it reads
	// only the fresh roster and changes no access: a group without any local setup
	// has no completion whose recipients discovery could restore.
	for (const group of groups) {
		if (!hasNoLocalSetup(store, summaryCandidateRef(group))) continue;
		await discoverAfterReconciliation(store, group, dependencies, { views, skipped });
	}
	await dependencies.reconcile(store, groups, summaryReconciliationOptions(blockers));
	for (const group of groups) {
		const candidateRef = summaryCandidateRef(group);
		if (isDoneForPass(store, pass, { blockers, views }, candidateRef)) continue;
		// Rediscovering a completion can restore setup recipients. Reconciliation
		// reads removals only on some paths, so read them here for every completion.
		let removals: Extract<RepairEvidence, { status: "read" }> | null = null;
		if (hasRepairableSetupTeam(store, candidateRef)) {
			const evidence = await dependencies.readRemovalsForRepair(group);
			if (evidence.status === "failed") blockers.set(candidateRef, evidence.blocker);
			if (evidence.status !== "read") continue;
			removals = evidence;
		}
		await discoverAfterReconciliation(store, group, dependencies, { views, skipped }, () =>
			removals ? applyRemovalsBeforeRepair(store, group, removals) : true,
		);
	}
	return carrySkippedGroups({ groups: configured, views, blockers, skipped }, previous);
}

/** Whether the pass has nothing more to do for the group: it failed, was discovered or is skipped. */
function isDoneForPass(
	store: MemoryStore,
	pass: CandidatePass,
	found: { blockers: Map<string, CompletionBlocker>; views: Map<string, LegacyTeamCandidateView> },
	candidateRef: string,
): boolean {
	if (found.blockers.has(candidateRef) || found.views.has(candidateRef)) return true;
	// Another operation took the group up since the pass began: read nothing more for it.
	if (!isUntouchedSince(store.db, pass, candidateRef)) pass.skipped.add(candidateRef);
	return pass.skipped.has(candidateRef);
}

/** The groups a pass goes on with. One another operation holds or ran on is marked skipped. */
function openSummaryGroups(
	store: MemoryStore,
	groups: LegacyTeamConfiguredGroupSnapshot[],
	pass: CandidatePass,
): LegacyTeamConfiguredGroupSnapshot[] {
	return groups.filter((group) => {
		const candidateRef = summaryCandidateRef(group);
		if (isUntouchedSince(store.db, pass, candidateRef)) return true;
		pass.skipped.add(candidateRef);
		return false;
	});
}

/**
 * Whether rediscovering this candidate can restore setup recipients: core repairs
 * them only for the setup's Team while it is active, so this is the same check.
 */
function hasRepairableSetupTeam(store: MemoryStore, candidateRef: string): boolean {
	return Boolean(
		store.db
			.prepare("SELECT 1 FROM policy_teams WHERE team_id = ? AND status = 'active' LIMIT 1")
			.pluck()
			.get(deterministicPolicyTeamId(candidateRef)),
	);
}

const DEVICE_REMOVALS_UNREAD: CompletionBlocker = {
	code: "team_setup_completion_unavailable",
	reason: "device_removals_unavailable",
};
const TEAM_MEMBER_REMOVALS_UNREAD: CompletionBlocker = {
	code: "team_setup_completion_unavailable",
	reason: "team_member_removals_unavailable",
};

/**
 * Whether a completed group's recipients may be repaired. `read`: both removal
 * lists were read. `unavailable`: no current admin authority for the group or no
 * removal reads at all, so nothing is repaired, as on a device without the admin
 * secret. `failed`: a removal read was attempted and failed, so nothing is
 * repaired and the group carries the blocker.
 */
type RepairEvidence =
	| {
			status: "read";
			deviceRemovals: ReadonlyArray<{ group_id: string; device_id: string; fingerprint: string }>;
			teamMemberRemovals: CoordinatorTeamMemberRemoval[];
	  }
	| { status: "unavailable" }
	| { status: "failed"; blocker: CompletionBlocker };

/** Fresh removal evidence for one group, read before any recipient repair. */
async function readRemovalsForRepair(
	options: TeamSetupRoutesOptions,
	store: MemoryStore,
	group: LegacyTeamCandidateGroupDescriptor,
): Promise<RepairEvidence> {
	const dependencies =
		options.completionDependencies === undefined
			? defaultCompletionDependencies
			: options.completionDependencies;
	const authorization = readCompletionAuthorization(options);
	const reads = dependencies?.listRemovals && dependencies.listTeamMemberRemovals;
	if (!reads || !authorization || !authorizesGroup(authorization, group)) {
		return { status: "unavailable" };
	}
	const timeoutS = Math.max(1, authorization.config.syncCoordinatorTimeoutS);
	const deadlineMs = Date.now() + COORDINATOR_ROSTER_READ_BUDGET_MS;
	const { removalReads } = completionReadActions(
		dependencies,
		{ authorization, store },
		timeoutS,
		deadlineMs,
	);
	const devices = await removalReads.listRemovals();
	if (devices?.status !== "read") return { status: "failed", blocker: DEVICE_REMOVALS_UNREAD };
	let teamMemberRemovals: CoordinatorTeamMemberRemoval[] | undefined;
	try {
		teamMemberRemovals = await removalReads.listTeamMemberRemovals(group.groupId);
	} catch {
		return { status: "failed", blocker: TEAM_MEMBER_REMOVALS_UNREAD };
	}
	if (!teamMemberRemovals) return { status: "unavailable" };
	return { status: "read", deviceRemovals: devices.removals, teamMemberRemovals };
}

/**
 * Applies the removals a check read, before rediscovery can restore recipients,
 * and returns whether the repair may run.
 *
 * Team member removals are recorded with their enforcements, as the enrollment
 * check does. They commit in their own transaction before rediscovery, under the
 * same candidate claim, so any recipient the repair restores is refused to a
 * removed person's devices.
 *
 * A device removal covers one group, and the device may still be enrolled in
 * another, so this check does not end device-wide access: the sync daemon's
 * removal check does that once the device is removed everywhere, and the Team
 * then goes back to review. While this machine still pins or binds a device
 * this group removed, under the removed key, the repair waits.
 */
function applyRemovalsBeforeRepair(
	store: MemoryStore,
	group: LegacyTeamCandidateGroupDescriptor,
	evidence: Extract<RepairEvidence, { status: "read" }>,
): boolean {
	applyTeamMemberRemovals(store.db, {
		coordinatorId: group.coordinatorId,
		groupId: group.groupId,
		removals: evidence.teamMemberRemovals,
		now: new Date().toISOString(),
	});
	const removed = evidence.deviceRemovals.filter((removal) => removal.group_id === group.groupId);
	if (removed.length === 0) return true;
	// Read only: never create a signing identity here.
	const localDeviceId =
		(store.db.prepare("SELECT device_id FROM sync_device LIMIT 1").pluck().get() as
			| string
			| undefined) ?? "";
	// The local IDs whose pin and binding, if any, match a removed key.
	const removedLocally = localRemovedDeviceIds(
		store.db,
		{
			enrollments: removed.map(({ device_id, fingerprint }) => ({ device_id, fingerprint })),
			keyId: null,
		},
		localDeviceId,
	);
	const stillServed = store.db.prepare(
		`SELECT 1 FROM identity_devices WHERE device_id = ? AND status = 'active'
		 UNION ALL SELECT 1 FROM sync_peers WHERE peer_device_id = ? LIMIT 1`,
	);
	return removedLocally.every((deviceId) => !stillServed.get(deviceId, deviceId));
}

/** No draft of any state and no completed Team: discovery here only creates a draft. */
function hasNoLocalSetup(store: MemoryStore, candidateRef: string): boolean {
	return (
		getLegacyTeamSetupDraft(store.db, candidateRef) === null &&
		!hasCompletedLegacyTeamSetup(store, candidateRef)
	);
}

function summaryCandidateRef(group: LegacyTeamCandidateGroupDescriptor): string {
	return legacyTeamCandidateId(group.coordinatorId, group.groupId);
}

/** Discovery for one group under its claim; a taken claim marks the group skipped. */
async function discoverAfterReconciliation(
	store: MemoryStore,
	group: LegacyTeamConfiguredGroupSnapshot,
	dependencies: SummaryReconciliationDependencies,
	found: { views: Map<string, LegacyTeamCandidateView>; skipped: Set<string> },
	mayRepair: () => boolean = () => true,
): Promise<void> {
	const candidateRef = summaryCandidateRef(group);
	const ran = await runCandidateMutation(store.db, candidateRef, async () => {
		if (!mayRepair()) return;
		const view = discoveredSummaryView(store, group, dependencies.mayRediscover);
		if (view) found.views.set(candidateRef, view);
	});
	if (!ran) found.skipped.add(candidateRef);
}

/** The candidate view the summary lists for one group, discovering it when needed. */
function discoveredSummaryView(
	store: MemoryStore,
	group: LegacyTeamConfiguredGroupSnapshot,
	mayRediscover: (group: LegacyTeamCandidateGroupDescriptor) => boolean,
): LegacyTeamCandidateView | null {
	const candidateRef = summaryCandidateRef(group);
	const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
	if (hasCompletedLegacyTeamSetup(store, candidateRef)) {
		// Only canonical terminal completions pass through discovery: they can
		// reconcile missing setup recipient edges while preserving newer drafts.
		if (!isLegacyTeamCandidateSelectable(store.db, candidateRef)) return null;
	} else if (draft && draft.state !== "completed") {
		return candidateFromDraft(draft);
	}
	const [view] = completedTeamDiscoveryAuthority.run(mayRediscover, () =>
		discoverCandidates(store, [group]),
	);
	return view ?? null;
}

/** A skipped group keeps what the previous pass found, so a busy route never clears it. */
function carrySkippedGroups(
	result: Omit<SummaryReconciliationResult, "failed">,
	previous: SummaryReconciliationResult | null,
): SummaryReconciliationResult {
	for (const candidateRef of result.skipped) {
		result.blockers.delete(candidateRef);
		const blocker = previous?.blockers.get(candidateRef);
		if (blocker) result.blockers.set(candidateRef, blocker);
		const view = previous?.views.get(candidateRef);
		if (view) result.views.set(candidateRef, view);
	}
	return { ...result, failed: new Set(result.blockers.keys()) };
}

/** Candidates with an unfinished local draft, listed before the coordinator was ever checked. */
function localDraftCandidateSummaries(
	store: MemoryStore,
): LegacyTeamSetupPendingCandidateSummaryV1[] {
	const candidateRefs = store.db
		.prepare(
			`SELECT DISTINCT candidate_id FROM legacy_team_setup_drafts
			 WHERE state <> 'completed' AND superseded_at IS NULL ORDER BY candidate_id`,
		)
		.pluck()
		.all() as string[];
	return candidateRefs.flatMap((candidateRef) => {
		const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
		if (!draft || draft.state === "completed" || hasCompletedLegacyTeamSetup(store, candidateRef)) {
			return [];
		}
		const summary = candidateSummary(candidateFromDraft(draft));
		return summary.status === "ready" ? [] : [summary as LegacyTeamSetupPendingCandidateSummaryV1];
	});
}

/**
 * The summary from the last reconciliation pass, read from local state only. With
 * nothing checked yet and the latest check failed, the answer is that failure, as
 * when the summary checked inline.
 */
function summaryResponse(
	store: MemoryStore,
	read: TeamSetupReconciliationRead<SummaryReconciliationResult>,
): LegacyTeamSetupSummaryResponseV1 | { error: LegacyTeamSetupActivationErrorCode } {
	if (!read.result && read.status.error_code) {
		return { error: read.status.error_code as LegacyTeamSetupActivationErrorCode };
	}
	const candidates = read.result
		? checkedCandidateSummaries(store, read.result)
		: localDraftCandidateSummaries(store);
	return { version: TEAM_SETUP_VERSION, candidates, reconciliation: read.status };
}

/**
 * The candidates the last pass found, with local drafts read again so edits show
 * at once. Reads only: discovery, which can write drafts and access, runs in the pass.
 */
function checkedCandidateSummaries(
	store: MemoryStore,
	result: SummaryReconciliationResult,
): LegacyTeamSetupPendingCandidateSummaryV1[] {
	return result.groups
		.flatMap((group) => {
			const candidateRef = summaryCandidateRef(group);
			const blocker = result.blockers.get(candidateRef);
			if (blocker) return [blockedCandidateSummary(store, group, blocker)];
			if (hasCompletedLegacyTeamSetup(store, candidateRef)) return [];
			const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			const view =
				draft && draft.state !== "completed"
					? candidateFromDraft(draft)
					: result.views.get(candidateRef);
			if (!view || view.status === "ready") return [];
			return [candidateSummary(view) as LegacyTeamSetupPendingCandidateSummaryV1];
		})
		.toSorted((left, right) => compareCandidateRefs(left.candidateRef, right.candidateRef));
}

function compareCandidateRefs(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

/** The background check behind the summary, refreshed again when coordinator settings change. */
function createSummaryReconciliation(
	options: TeamSetupRoutesOptions,
	loadSnapshots: ReturnType<typeof createCachedSnapshotLoader>,
	reconcile: SummaryReconciliationDependencies["reconcile"],
): TeamSetupReconciliation<SummaryReconciliationResult> {
	const mayRediscover = (group: LegacyTeamCandidateGroupDescriptor) => {
		const authorization = readCompletionAuthorization(options);
		return Boolean(authorization && authorizesGroup(authorization, group));
	};
	const dependencies: SummaryReconciliationDependencies = {
		loadSnapshots,
		reconcile,
		mayRediscover,
		readRemovalsForRepair: (group) => readRemovalsForRepair(options, options.getStore(), group),
	};
	const reconciliation = createTeamSetupReconciliation<SummaryReconciliationResult>({
		run: (previous) => runSummaryReconciliation(options.getStore(), dependencies, previous),
		assess: (result) => ({
			failedGroups: result.failed.size,
			skippedGroups: result.skipped.size,
			errorCode: result.blockers.values().next().value?.code ?? null,
		}),
		retryDelayMs: options.reconciliationRetryDelayMs,
		errorCode: (error) => teamSetupFailure(error, "background GET /api/sync/team-setup/v1").code,
		record: (outcome) => recordReconciliationOutcome(options.getStore(), outcome),
	});
	options.registerReconciliation?.(reconciliation);
	options.registerSummaryInvalidator?.(() => {
		loadSnapshots.invalidate();
		void reconciliation.refresh();
	});
	return reconciliation;
}

/** Shows each pass on the Health tab; a coordinator outage is not a failed job. */
function recordReconciliationOutcome(
	store: MemoryStore,
	outcome: TeamSetupReconciliationOutcome,
): void {
	const checkedAt =
		outcome.checkedAtMs === null ? null : new Date(outcome.checkedAtMs).toISOString();
	const message = outcome.ok
		? "Checked Team setup with the coordinator"
		: `Could not check Team setup with the coordinator (${outcome.errorCode}); showing the last check`;
	// One transaction, so status never shows the row as pending.
	store.db.transaction(() => {
		startMaintenanceJob(store.db, {
			kind: TEAM_SETUP_RECONCILIATION_JOB,
			title: "Team setup check",
			status: "pending",
			message,
			metadata: { last_checked_at: checkedAt, last_error_code: outcome.errorCode },
		});
		completeMaintenanceJob(store.db, TEAM_SETUP_RECONCILIATION_JOB, { message });
	})();
}

function hasCompletedLegacyTeamSetup(store: MemoryStore, candidateRef: string): boolean {
	return Boolean(
		store.db
			.prepare(
				`SELECT 1 FROM policy_teams
				 WHERE team_id = ? AND status = 'active'
				   AND provenance = 'reviewed_team_candidate'
				   AND migration_state = 'completed' LIMIT 1`,
			)
			.pluck()
			.get(deterministicPolicyTeamId(candidateRef)),
	);
}

function identityRef(candidateRef: string, identityId: string | null): string | null {
	return identityId
		? recipientPolicyDigest("legacy-team-viewer-identity-ref-v1", [candidateRef, identityId])
		: null;
}

function requiredIdentityRef(candidateRef: string, identityId: string): string {
	return recipientPolicyDigest("legacy-team-viewer-identity-ref-v1", [candidateRef, identityId]);
}

function teamRef(candidateRef: string, teamId: string): string {
	return recipientPolicyDigest("legacy-team-viewer-team-ref-v1", [candidateRef, teamId]);
}

function resolvedProjectRef(projectRef: string, projectIdentity: string | null): string | null {
	return projectIdentity ? legacyTeamResolvedProjectRef(projectRef, projectIdentity) : null;
}

function viewerSafeAccessDelta(
	candidateRef: string,
	delta: LegacyTeamSetupAccessDeltaV1,
	labels?: {
		teamDisplayName: string;
		devices: Array<Omit<LegacyTeamSetupDeviceV1, "actions">>;
		projects: Array<Omit<LegacyTeamSetupProjectV1, "actions">>;
		identityChoices: LegacyTeamSetupIdentityChoiceV1[];
	},
): LegacyTeamSetupViewerAccessDeltaV1 {
	const fallbackLabels = new Map<string, string>();
	const fallbackLabelCounts = new Map<string, number>();
	const reservedLabels = new Set(
		[
			labels?.teamDisplayName,
			...(labels?.devices.map((device) => device.displayName) ?? []),
			...(labels?.projects.flatMap((project) => [
				project.displayName,
				...project.mappingChoices.map((choice) => choice.displayName),
			]) ?? []),
			...(labels?.identityChoices.map((identity) => identity.displayName) ?? []),
		]
			.filter((label): label is string => Boolean(label))
			.map((label) => normalizeChoiceLabelText(label).toLowerCase()),
	);
	const fallbackLabel = (kind: string, ref: string) => {
		const key = `${kind}:${ref}`;
		const existing = fallbackLabels.get(key);
		if (existing) return existing;
		let index = (fallbackLabelCounts.get(kind) ?? 0) + 1;
		let label = `${kind} outside this setup (${index})`;
		while (reservedLabels.has(normalizeChoiceLabelText(label).toLowerCase())) {
			index += 1;
			label = `${kind} outside this setup (${index})`;
		}
		fallbackLabelCounts.set(kind, index);
		reservedLabels.add(normalizeChoiceLabelText(label).toLowerCase());
		fallbackLabels.set(key, label);
		return label;
	};
	const projectsByRef = new Map(labels?.projects.map((project) => [project.projectRef, project]));
	const projectsByCanonicalRef = new Map(
		labels?.projects.flatMap((project) =>
			project.canonicalProjectRef ? [[project.canonicalProjectRef, project] as const] : [],
		),
	);
	const identitiesByRef = new Map(
		labels?.identityChoices.map((identity) => [identity.identityRef, identity]),
	);
	const devicesByRef = new Map(labels?.devices.map((device) => [device.deviceRef, device]));
	const canonicalProjectPresentation = (identity: string, ref: string) => {
		if (identity === "shared:default") {
			return { displayName: "Legacy default sharing", kind: "legacy_default_sharing" as const };
		}
		return {
			displayName: projectsByCanonicalRef.get(ref)?.displayName ?? fallbackLabel("Project", ref),
			kind: "project" as const,
		};
	};
	const resolvedDisplayName = (projectRef: string, ref: string | null): string | null => {
		if (!ref) return null;
		const project = projectsByRef.get(projectRef);
		const choice = project?.mappingChoices.find((item) => item.resolvedProjectRef === ref);
		if (choice) return choice.displayName;
		if (project?.resolvedProjectRef === ref && project.resolution === "deterministic") {
			return `${project.displayName} (automatic match)`;
		}
		return fallbackLabel("Project", ref);
	};
	return {
		teamChanges: delta.teamChanges.map((change) => ({
			teamRef: teamRef(candidateRef, change.teamId),
			teamDisplayName:
				labels?.teamDisplayName ?? fallbackLabel("Team", teamRef(candidateRef, change.teamId)),
			change: change.change,
			fromDeviceEligibilityMode: change.fromDeviceEligibilityMode,
			toDeviceEligibilityMode: change.toDeviceEligibilityMode,
		})),
		membershipChanges: delta.membershipChanges.map((change) => {
			const identityRef = requiredIdentityRef(candidateRef, change.identityId);
			const membershipTeamRef = teamRef(candidateRef, change.teamId);
			return {
				teamRef: membershipTeamRef,
				teamDisplayName: labels?.teamDisplayName ?? fallbackLabel("Team", membershipTeamRef),
				identityRef,
				identityDisplayName:
					identitiesByRef.get(identityRef)?.displayName ?? fallbackLabel("Person", identityRef),
				change: change.change,
			};
		}),
		projectChanges: delta.projectChanges.map((change) => {
			const fromRef = resolvedProjectRef(change.projectRef, change.fromProjectIdentity);
			const toRef = resolvedProjectRef(change.projectRef, change.toProjectIdentity);
			return {
				projectRef: change.projectRef,
				projectDisplayName:
					projectsByRef.get(change.projectRef)?.displayName ??
					fallbackLabel("Project", change.projectRef),
				fromCanonicalProjectRef: change.fromProjectIdentity
					? legacyTeamCanonicalProjectRef(candidateRef, change.fromProjectIdentity)
					: null,
				fromResolvedProjectRef: fromRef,
				fromResolvedProjectDisplayName: resolvedDisplayName(change.projectRef, fromRef),
				toCanonicalProjectRef: change.toProjectIdentity
					? legacyTeamCanonicalProjectRef(candidateRef, change.toProjectIdentity)
					: null,
				toResolvedProjectRef: toRef,
				toResolvedProjectDisplayName: resolvedDisplayName(change.projectRef, toRef),
				change: change.change,
			};
		}),
		recipientChanges: delta.recipientChanges.map((change) => {
			const canonicalProjectRef = legacyTeamCanonicalProjectRef(
				candidateRef,
				change.canonicalProjectIdentity,
			);
			const recipientRef = teamRef(candidateRef, change.recipientId);
			const projectPresentation = canonicalProjectPresentation(
				change.canonicalProjectIdentity,
				canonicalProjectRef,
			);
			return {
				canonicalProjectRef,
				canonicalProjectDisplayName: projectPresentation.displayName,
				canonicalProjectKind: projectPresentation.kind,
				recipientKind: change.recipientKind,
				recipientRef,
				recipientDisplayName: labels?.teamDisplayName ?? fallbackLabel("Team", recipientRef),
				change: change.change,
			};
		}),
		deviceAccessChanges: delta.deviceAccessChanges.map((change) => {
			const canonicalProjectRef = legacyTeamCanonicalProjectRef(
				candidateRef,
				change.canonicalProjectIdentity,
			);
			const deviceRef = legacyTeamDeviceRef(candidateRef, change.deviceId);
			const projectPresentation = canonicalProjectPresentation(
				change.canonicalProjectIdentity,
				canonicalProjectRef,
			);
			return {
				canonicalProjectRef,
				canonicalProjectDisplayName: projectPresentation.displayName,
				canonicalProjectKind: projectPresentation.kind,
				deviceRef,
				deviceDisplayName:
					devicesByRef.get(deviceRef)?.displayName ?? fallbackLabel("Device", deviceRef),
				change: change.change,
			};
		}),
	};
}

function viewerAccessDeltaDigest(delta: LegacyTeamSetupViewerAccessDeltaV1): string {
	return recipientPolicyDigest("legacy-team-viewer-access-delta-v1", delta);
}

const SAFE_CHOICE_LABEL_PATTERN = /^[\p{L}\p{N} '&,.()_-]*$/u;

// Keep this byte-for-byte equivalent in behavior to the core setup-label
// normalization without exporting a presentation-only core implementation.
function normalizeChoiceLabelText(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/\p{Cf}/gu, "")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function safeChoiceLabel(
	value: string,
	fallback: string,
	forbiddenIds: readonly string[],
	opaqueRef?: string,
): string {
	const normalized = normalizeChoiceLabelText(value.slice(0, 512));
	const label = normalized.slice(0, 120).trim();
	const forbiddenComparisons = forbiddenIds
		.map((forbiddenId) => normalizeChoiceLabelText(forbiddenId).toLowerCase())
		.filter(Boolean);
	const comparable = normalized.toLowerCase();
	if (
		!label ||
		!SAFE_CHOICE_LABEL_PATTERN.test(label) ||
		/[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(label) ||
		/-----|\b(?:ssh|ecdsa|sk)-[\p{L}\p{N}-]+ /iu.test(label) ||
		forbiddenComparisons.some((forbiddenComparison) => comparable.includes(forbiddenComparison))
	) {
		const suffix = opaqueRef?.slice(-6);
		return suffix ? `${fallback} ${suffix}` : fallback;
	}
	return label;
}

function disambiguateChoiceLabels<T extends { displayName: string }>(
	choices: readonly T[],
	choiceRef: (choice: T) => string,
): T[] {
	const counts = new Map<string, number>();
	const originalLabels = new Set<string>();
	for (const choice of choices) {
		const comparable = normalizeChoiceLabelText(choice.displayName).toLowerCase();
		counts.set(comparable, (counts.get(comparable) ?? 0) + 1);
		originalLabels.add(comparable);
	}
	const usedLabels = new Set<string>();
	return choices.map((choice, index) => {
		const comparable = normalizeChoiceLabelText(choice.displayName).toLowerCase();
		if ((counts.get(comparable) ?? 0) < 2 && !usedLabels.has(comparable)) {
			usedLabels.add(comparable);
			return choice;
		}
		const ref = choiceRef(choice);
		let suffixLength = Math.min(6, ref.length);
		let suffix = ref.slice(-suffixLength);
		const maxAttempts = ref.length + originalLabels.size + usedLabels.size + 2;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const baseLength = Math.max(0, 119 - suffix.length);
			const base = choice.displayName.slice(0, baseLength).trimEnd();
			const displayName = base ? `${base} ${suffix}` : suffix.slice(-120);
			const finalComparable = normalizeChoiceLabelText(displayName).toLowerCase();
			if (!usedLabels.has(finalComparable) && !originalLabels.has(finalComparable)) {
				usedLabels.add(finalComparable);
				return { ...choice, displayName };
			}
			if (suffixLength < ref.length) {
				suffixLength = Math.min(ref.length, suffixLength + 2);
				suffix = ref.slice(-suffixLength);
				continue;
			}
			suffix = `${ref.slice(-Math.min(96, ref.length))}-${index + 1}-${attempt + 1}`;
		}
		throw new Error("legacy_team_setup_roster_too_large");
	});
}

function requireCompleteMappingChoices(projectCount: number, choiceCount: number): void {
	if (projectCount * choiceCount > MAX_TOTAL_PROJECT_MAPPING_CHOICES) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
}

function createCachedSnapshotLoader(
	load: () => Promise<LegacyTeamConfiguredGroupSnapshot[]>,
	ttlMs: number,
	now: () => number = Date.now,
): (() => Promise<LegacyTeamConfiguredGroupSnapshot[]>) & {
	invalidate: () => void;
	peek: () => LegacyTeamConfiguredGroupSnapshot[] | null;
} {
	let cached: { expiresAt: number; snapshots: LegacyTeamConfiguredGroupSnapshot[] } | null = null;
	let inFlight: Promise<LegacyTeamConfiguredGroupSnapshot[]> | null = null;
	let generation = 0;
	const cachedLoad = () => {
		if (cached && now() < cached.expiresAt) return Promise.resolve(cached.snapshots);
		if (inFlight) return inFlight;
		const operationGeneration = generation;
		let operation: Promise<LegacyTeamConfiguredGroupSnapshot[]>;
		operation = load()
			.then((snapshots) => {
				if (generation !== operationGeneration) return cachedLoad();
				cached = { expiresAt: now() + ttlMs, snapshots };
				return snapshots;
			})
			.finally(() => {
				if (inFlight === operation) inFlight = null;
			});
		inFlight = operation;
		return operation;
	};
	cachedLoad.invalidate = () => {
		generation += 1;
		cached = null;
		inFlight = null;
	};
	cachedLoad.peek = () => (cached && now() < cached.expiresAt ? cached.snapshots : null);
	return cachedLoad;
}

async function loadMutableCandidateSnapshots(
	store: MemoryStore,
	candidateRef: string,
	load: () => Promise<LegacyTeamConfiguredGroupSnapshot[]>,
): Promise<LegacyTeamConfiguredGroupSnapshot[]> {
	if (getLegacyTeamSetupDraft(store.db, candidateRef)?.state === "completed") {
		throw new Error("team_setup_confirmation_stale");
	}
	return load();
}

function projectMutationAtomically<Mutation, Projection>(
	store: MemoryStore,
	mutate: () => Mutation,
	project: (mutation: Mutation) => Projection,
): Projection {
	return store.db
		.transaction(() => {
			const mayEdit = draftEditAuthority.getStore();
			if (mayEdit && !mayEdit()) throw new Error("team_setup_admin_required");
			return project(mutate());
		})
		.immediate();
}

export const __teamSetupTestHooks = {
	claimCandidateMutation,
	createCachedSnapshotLoader,
	loadConfiguredLegacyTeamGroupSnapshotsWith,
	normalizedCoordinatorId,
	projectMutationAtomically,
	requireBoundedAccessDelta: requireLegacyTeamSetupAccessDeltaWithinLimit,
	requireCompleteMappingChoices,
	disambiguateChoiceLabels,
	safeChoiceLabel,
	viewerSafeAccessDelta,
	// Lazy: the classifier and its typed error are declared below this object.
	finishFailureDetails: (error: unknown) => teamSetupFinishFailureDetails(error),
	localProjectScanBudgetError: (cause?: unknown) => new LocalProjectScanBudgetError(cause),
};

interface IdentityChoiceInternal extends LegacyTeamSetupIdentityChoiceV1 {
	identityId: string;
}

type IdentityChoiceRow = { actor_id: string; display_name: string };

function identityChoicesFromRows(
	rows: IdentityChoiceRow[],
	candidateRef: string,
	maxChoices = MAX_IDENTITY_CHOICES,
): IdentityChoiceInternal[] {
	if (rows.length > maxChoices) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
	const actorIds = rows.map((row) => row.actor_id);
	return disambiguateChoiceLabels(
		rows.map((row) => {
			const opaqueIdentityRef = requiredIdentityRef(candidateRef, row.actor_id);
			return {
				identityId: row.actor_id,
				identityRef: opaqueIdentityRef,
				displayName: safeChoiceLabel(row.display_name, "Person", actorIds, opaqueIdentityRef),
			};
		}),
		(choice) => choice.identityRef,
	);
}

type AssignmentTarget = { targetIdentityRef: string } | { newPersonName: string };

/**
 * A device is assigned to a person already in the list, or to someone new, named
 * here. Naming someone new creates that person as part of the saved assignment,
 * so Team setup never sends people elsewhere to create them first.
 */
function parseAssignmentTarget(body: Record<string, unknown>): AssignmentTarget | null {
	if (hasExactKeys(body, ["attemptId", "expectation", "targetIdentityRef"])) {
		const ref = body.targetIdentityRef;
		return typeof ref === "string" && IDENTITY_REF_PATTERN.test(ref)
			? { targetIdentityRef: ref }
			: null;
	}
	if (!hasExactKeys(body, ["attemptId", "expectation", "newPersonName"])) return null;
	if (typeof body.newPersonName !== "string") return null;
	try {
		return {
			newPersonName: normalizeHumanPresentationName(body.newPersonName, "display_name"),
		};
	} catch {
		return null;
	}
}

/**
 * Someone already listed under that name should be picked from the list instead.
 * Compares stored names: the list adds suffixes to tell same-named people apart,
 * so only the server can tell whether a typed name is taken.
 */
function personNameTaken(store: MemoryStore, name: string): boolean {
	const key = name.normalize("NFC").toLocaleLowerCase();
	const rows = store.db
		.prepare(
			"SELECT display_name FROM actors WHERE status = 'active' AND merged_into_actor_id IS NULL",
		)
		.all() as Array<{ display_name: string }>;
	return rows.some((row) => row.display_name.normalize("NFC").toLocaleLowerCase() === key);
}

/** Runs inside the assignment transaction, so a failed assignment creates no one. */
function insertTeamSetupPerson(store: MemoryStore, assignee: AssignmentTarget): string {
	if (!("newPersonName" in assignee)) throw new Error("team_setup_incomplete");
	const now = new Date().toISOString();
	const actorId = randomUUID();
	store.db
		.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at)
			 VALUES (?, ?, 0, 'active', NULL, ?, ?)`,
		)
		.run(actorId, assignee.newPersonName, now, now);
	return actorId;
}

function identityChoices(store: MemoryStore, candidateRef: string): IdentityChoiceInternal[] {
	const rows = store.db
		.prepare(
			`SELECT actor_id, display_name FROM actors
			 WHERE status = 'active' AND merged_into_actor_id IS NULL
			 ORDER BY display_name, actor_id LIMIT ?`,
		)
		.all(MAX_IDENTITY_CHOICES + 1) as IdentityChoiceRow[];
	return identityChoicesFromRows(rows, candidateRef);
}

function completedDraftIdentityChoices(
	store: MemoryStore,
	draft: LegacyTeamSetupDraftView,
): IdentityChoiceInternal[] {
	const actorIds = [
		...new Set(
			draft.devices.flatMap((device) => [
				device.existingIdentityId,
				device.suggestedIdentityId,
				device.targetIdentityId,
				device.expectation.kind === "existing" ? device.expectation.identityId : null,
			]),
		),
	].filter((actorId): actorId is string => actorId !== null);
	if (actorIds.length === 0) return [];
	const placeholders = actorIds.map(() => "?").join(", ");
	const rows = store.db
		.prepare(
			`SELECT actor_id, display_name FROM actors
			 WHERE status = 'active' AND merged_into_actor_id IS NULL
			   AND actor_id IN (${placeholders})
			 ORDER BY display_name, actor_id`,
		)
		.all(...actorIds) as IdentityChoiceRow[];
	return identityChoicesFromRows(rows, draft.candidateRef, MAX_COMPLETED_IDENTITY_CHOICES);
}

interface ProjectMappingChoiceInternal {
	projectIdentity: string;
	sourceDisplayName: string;
}

function projectMappingChoices(store: MemoryStore): ProjectMappingChoiceInternal[] {
	let candidates: ReturnType<typeof listProjectScopeCandidates>;
	try {
		candidates = listProjectScopeCandidates(store.db, {
			limit: null,
			maxScannedRows: MAX_PROJECT_MAPPING_SCAN_ROWS,
			maxMetadataRows: MAX_PROJECT_MAPPING_METADATA_ROWS,
			excludePeerReceived: true,
		}).filter(
			(candidate) =>
				!candidate.read_only &&
				isLegacyTeamSetupProjectMappingIdentity(candidate.workspace_identity, store.db),
		);
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "project_scope_candidate_scan_too_large" ||
				error.message === "project_scope_candidate_metadata_too_large")
		) {
			throw new LocalProjectScanBudgetError(error);
		}
		throw error;
	}
	if (candidates.length > MAX_PROJECT_MAPPING_CHOICES) {
		throw new LocalProjectScanBudgetError();
	}
	return candidates.map((candidate) => ({
		projectIdentity: candidate.workspace_identity,
		sourceDisplayName: candidate.display_project,
	}));
}

interface ViewerSafeDraft {
	devices: Array<Omit<LegacyTeamSetupDeviceV1, "actions">>;
	projects: Array<Omit<LegacyTeamSetupProjectV1, "actions">>;
	identityChoices: LegacyTeamSetupIdentityChoiceV1[];
}

function viewerSafeDevice(
	candidateRef: string,
	device: LegacyTeamSetupDraftView["devices"][number],
): ViewerSafeDraft["devices"][number] {
	return {
		deviceRef: device.deviceRef,
		displayName: device.displayName,
		enabled: device.enabled,
		existingIdentityRef: identityRef(candidateRef, device.existingIdentityId),
		suggestedIdentityRef: identityRef(candidateRef, device.suggestedIdentityId),
		verifiedEvidenceKind: device.verifiedEvidenceKind,
		identityEvidence: device.identityEvidence,
		decision: device.decision,
		targetIdentityRef: identityRef(candidateRef, device.targetIdentityId),
		expectation:
			device.expectation.kind === "existing"
				? {
						kind: "existing" as const,
						assignmentVersion: device.expectation.assignmentVersion,
						identityRef: requiredIdentityRef(candidateRef, device.expectation.identityId),
					}
				: { kind: "absent" as const },
	};
}

function viewerSafeDraft(store: MemoryStore, draft: LegacyTeamSetupDraftView): ViewerSafeDraft {
	if (draft.devices.length > MAX_DEVICES || draft.projects.length > MAX_PROJECTS) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
	const completed = draft.state === "completed";
	const identities = completed
		? completedDraftIdentityChoices(store, draft)
		: identityChoices(store, draft.candidateRef);
	const mappableProjectCount = completed
		? 0
		: draft.projects.filter((project) => project.resolution !== "deterministic").length;
	const mappingChoices = mappableProjectCount === 0 ? [] : projectMappingChoices(store);
	requireCompleteMappingChoices(mappableProjectCount, mappingChoices.length);
	const mappingChoiceIdentities = mappingChoices.map((choice) => choice.projectIdentity);
	return {
		devices: draft.devices.map((device) => viewerSafeDevice(draft.candidateRef, device)),
		projects: draft.projects.map((project) => ({
			projectRef: project.projectRef,
			displayName: project.displayName,
			resolution: project.resolution,
			canonicalProjectRef: project.canonicalProjectRef,
			resolvedProjectRef: project.resolvedProjectRef,
			mappingChoices:
				project.resolution === "deterministic"
					? []
					: disambiguateChoiceLabels(
							mappingChoices.map((choice) => {
								const opaqueResolvedProjectRef = legacyTeamResolvedProjectRef(
									project.projectRef,
									choice.projectIdentity,
								);
								return {
									resolvedProjectRef: opaqueResolvedProjectRef,
									displayName: safeChoiceLabel(
										choice.sourceDisplayName,
										"Project",
										mappingChoiceIdentities,
										opaqueResolvedProjectRef,
									),
								};
							}),
							(choice) => choice.resolvedProjectRef,
						),
		})),
		identityChoices: identities.map(({ identityRef, displayName }) => ({
			identityRef,
			displayName,
		})),
	};
}

function viewerSafePreview(
	draft: LegacyTeamSetupDraftView,
	safeDraft: ViewerSafeDraft,
	preview: ReturnType<typeof inspectLegacyTeamSetupActivation>,
) {
	const accessDelta = viewerSafeAccessDelta(draft.candidateRef, preview.accessDelta, {
		teamDisplayName: draft.displayName,
		...safeDraft,
	});
	return {
		finishDigest: preview.finishDigest,
		accessDeltaDigest: preview.accessDeltaDigest,
		viewerAccessDeltaDigest: viewerAccessDeltaDigest(accessDelta),
		accessDelta,
	};
}

function errorStatus(code: LegacyTeamSetupActivationErrorCode): 400 | 403 | 409 | 503 {
	if (code === "team_setup_admin_required") return 403;
	if (code === "team_setup_roster_unavailable" || code === "team_setup_completion_unavailable")
		return 503;
	if (code === "team_setup_failed") return 503;
	if (code === "team_setup_incomplete") return 400;
	return 409;
}

function apiErrorCode(error: unknown): LegacyTeamSetupActivationErrorCode {
	const code = legacyTeamSetupApiErrorCode(error);
	return code === "team_setup_projection_changed" ? "team_setup_conflict" : code;
}

/**
 * Maps a setup failure to its API code and logs the internal check that raised
 * it. Dozens of checks share each public code, so the log is the only place an
 * operator can see which one failed.
 */
function teamSetupFailure(
	error: unknown,
	route: string,
): { code: LegacyTeamSetupActivationErrorCode; status: 400 | 403 | 409 | 503 } {
	const code = apiErrorCode(error);
	const check = legacyTeamSetupFailureCheck(error);
	console.warn(`[team-setup] route=${route} apiCode=${code}${check ? ` check=${check}` : ""}`);
	return { code, status: errorStatus(code) };
}

function completionApiError(error: unknown): LegacyTeamSetupActivationErrorCode {
	const code = legacyTeamSetupApiErrorCode(error);
	return code === "team_setup_failed" ? "team_setup_completion_unavailable" : code;
}

class TeamSetupFinishError extends Error {
	constructor(
		code: LegacyTeamSetupActivationErrorCode,
		readonly reason: LegacyTeamSetupErrorReason | undefined,
		readonly alreadyLogged: boolean,
		cause?: unknown,
	) {
		super(code, cause === undefined ? undefined : { cause });
		this.name = "TeamSetupFinishError";
	}
}

/**
 * Records the group's Team member removals, then applies the coordinator's
 * winning completion, whether this request published it or recovered it after
 * a lost response. A removal recorded on another admin device must be known
 * before the completion runs. When the removals cannot be read, nothing is
 * applied here; reconciliation applies the published winner later.
 */
async function applyFinishWinnerAfterRemovals(
	{
		store,
		dependencies,
		config,
	}: {
		store: MemoryStore;
		dependencies: LegacyTeamCompletionDependencies;
		config: ReturnType<typeof readCoordinatorSyncConfig>;
	},
	input: Parameters<typeof applyLegacyTeamSetupCompletionManifestAndReturnActivation>[1],
) {
	const list = dependencies.listTeamMemberRemovals;
	if (list) {
		let removals: CoordinatorTeamMemberRemoval[];
		try {
			removals = await list({
				groupId: input.groupId,
				remoteUrl: buildBaseUrl(config.syncCoordinatorUrl),
				adminSecret: config.syncCoordinatorAdminSecret,
				timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
			});
		} catch (error) {
			throw new TeamSetupFinishError(
				"team_setup_completion_unavailable",
				"team_member_removals_unavailable",
				false,
				error,
			);
		}
		applyTeamMemberRemovals(store.db, {
			coordinatorId: input.coordinatorId,
			groupId: input.groupId,
			removals,
			now: new Date().toISOString(),
		});
	}
	return applyLegacyTeamSetupCompletionManifestAndReturnActivation(store.db, input);
}

interface TeamSetupFinishFailureDetails {
	reason?: LegacyTeamSetupErrorReason;
	cause: string;
	status?: number;
	code?: string;
}

/**
 * The generic `legacy_team_setup_roster_too_large` string is thrown by ten
 * sites for unrelated limits (coordinator roster size, draft device count,
 * local project choices). Only the local project-candidate scan is a
 * "this device's history is too large" condition, so it carries a distinct
 * type. The message is kept identical so the frozen API-code mapping and every
 * existing caller that matches on it are unchanged.
 */
class LocalProjectScanBudgetError extends Error {
	constructor(cause?: unknown) {
		super("legacy_team_setup_roster_too_large", cause === undefined ? undefined : { cause });
		this.name = "LocalProjectScanBudgetError";
	}
}

/**
 * Remote error codes the finish path can legitimately receive from the
 * coordinator. Anything else — including identifier-shaped values, which a
 * hostile or misconfigured upstream could use to smuggle a credential through
 * a JSON `error` field — is reduced to a fixed classification before logging.
 * A shape check is not an allowlist; only this set is echoed verbatim.
 */
const LOGGABLE_REMOTE_ERROR_CODES = new Set([
	"body_too_large",
	"completion_manifest_invalid",
	"completion_manifest_unavailable",
	"completion_not_found",
	"completion_query_invalid",
	"group_archived",
	"group_id_and_candidate_ref_required",
	"group_not_found",
	"invalid_json",
	"missing_admin_header",
	"not_found",
	"rate_limited",
	"response_too_large",
	"unauthorized",
]);

function loggableRemoteCode(code: string): string {
	if (LOGGABLE_REMOTE_ERROR_CODES.has(code)) return code;
	if (code.startsWith("non_json_response")) return "non_json_response";
	return "unclassified_remote_error";
}

/**
 * Local causes the finish path can produce. Same allowlist discipline as
 * remote codes: everything else, including transport messages that embed the
 * target URL, is classified rather than echoed.
 */
const LOGGABLE_LOCAL_CAUSES = new Set([
	"completion_conflict",
	"legacy_team_setup_roster_too_large",
	"project_scope_candidate_metadata_too_large",
	"project_scope_candidate_scan_too_large",
	"team_setup_completion_conflict",
	"team_setup_completion_invalid",
	"team_setup_completion_unavailable",
	"team_setup_confirmation_stale",
	"team_setup_roster_unavailable",
]);

function loggableLocalCause(error: Error): string {
	if (LOGGABLE_LOCAL_CAUSES.has(error.message)) return error.message;
	if (error.name === "AbortError" || error.name === "TimeoutError") return error.name;
	if (/fetch failed/iu.test(error.message)) return "fetch_failed";
	if (/timed out|timeout/iu.test(error.message)) return "timed_out";
	return `unclassified_error:${error.name || "Error"}`;
}

function errorChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current = error;
	while (current && !chain.includes(current)) {
		chain.push(current);
		current = current instanceof Error ? current.cause : undefined;
	}
	return chain;
}

function remoteFailureReason(
	remote: RemoteCoordinatorRequestError,
	fallback: LegacyTeamSetupErrorReason | undefined,
): LegacyTeamSetupErrorReason | undefined {
	if (
		remote.status === 404 &&
		(remote.code === "not_found" || remote.code.startsWith("non_json"))
	) {
		return "coordinator_route_missing";
	}
	if (remote.status === 400 && remote.code === "completion_manifest_invalid") {
		return "coordinator_rejected_manifest";
	}
	return fallback;
}

function teamSetupFinishFailureDetails(error: unknown): TeamSetupFinishFailureDetails {
	const chain = errorChain(error);
	const wrapper = chain.find(
		(item): item is TeamSetupFinishError => item instanceof TeamSetupFinishError,
	);
	const remote = chain.find(
		(item): item is RemoteCoordinatorRequestError => item instanceof RemoteCoordinatorRequestError,
	);
	if (remote) {
		const reason = remoteFailureReason(remote, wrapper?.reason);
		return {
			...(reason ? { reason } : {}),
			cause: "remote coordinator request failed",
			status: remote.status,
			code: loggableRemoteCode(remote.code),
		};
	}
	// Only typed scan-budget errors mean "this device's history is too large".
	// The shared roster_too_large string also fires for coordinator roster size
	// and draft device count, which are not local conditions.
	if (
		chain.some(
			(item) =>
				item instanceof LegacyTeamSetupRosterCapacityError ||
				item instanceof LocalProjectScanBudgetError,
		)
	) {
		return {
			reason: "local_candidate_scan_budget_exceeded",
			cause: "local project candidate scan exceeded budget",
		};
	}
	const errorCause = chain.find(
		(item): item is Error => item instanceof Error && !(item instanceof TeamSetupFinishError),
	);
	const cause = errorCause ? loggableLocalCause(errorCause) : "unclassified_non_error";
	if (wrapper?.reason) return { reason: wrapper.reason, cause };
	if (
		errorCause &&
		(errorCause.name === "AbortError" ||
			errorCause.name === "TimeoutError" ||
			/fetch failed|timed out|timeout/iu.test(errorCause.message))
	) {
		return { reason: "coordinator_unreachable", cause };
	}
	return { cause };
}

function warnTeamSetupFinishFailure(
	error: unknown,
	details: TeamSetupFinishFailureDetails,
	context: {
		candidateRef: string;
		attemptId: string;
		apiCode: LegacyTeamSetupActivationErrorCode;
		redactValues?: readonly string[];
	},
): void {
	if (
		errorChain(error).some((item) => item instanceof TeamSetupFinishError && item.alreadyLogged)
	) {
		return;
	}
	const safe = (value: string | number): string => {
		let sanitized = String(value).replace(/[\r\n\t]+/gu, " ");
		for (const secret of context.redactValues ?? []) {
			if (secret) sanitized = sanitized.replaceAll(secret, "[redacted]");
		}
		return sanitized.replace(/https?:\/\/[^\s]+/giu, (value) => {
			try {
				const url = new URL(value);
				return `${url.protocol}//${url.host}`;
			} catch {
				return "[redacted-url]";
			}
		});
	};
	const fields = [
		`candidateRef=${safe(context.candidateRef)}`,
		`attemptId=${safe(context.attemptId)}`,
		`apiCode=${safe(context.apiCode)}`,
		`cause=${safe(details.cause)}`,
		...(details.reason ? [`reason=${safe(details.reason)}`] : []),
		...(details.status == null ? [] : [`status=${safe(details.status)}`]),
		...(details.code == null ? [] : [`code=${safe(details.code)}`]),
	];
	console.warn(`[team-setup finish] ${fields.join(" ")}`);
}

function finishErrorResponse(
	code: LegacyTeamSetupActivationErrorCode,
	details: TeamSetupFinishFailureDetails,
): { error: LegacyTeamSetupActivationErrorCode; reason?: LegacyTeamSetupErrorReason } {
	const reason = details.reason;
	return reason ? { error: code, reason } : { error: code };
}

type BoundedJsonResult = { ok: true; value: Record<string, unknown> } | { ok: false };

async function parseBoundedJsonObject(c: Context): Promise<BoundedJsonResult> {
	const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json") return { ok: false };
	const lengthHeader = c.req.header("content-length");
	if (lengthHeader != null && !/^\d+$/u.test(lengthHeader.trim())) return { ok: false };
	const contentLength = lengthHeader == null ? null : Number(lengthHeader);
	if (contentLength != null && contentLength > MAX_MUTATION_BODY_BYTES) return { ok: false };
	const body = c.req.raw.body;
	if (!body) return { ok: false };
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_MUTATION_BODY_BYTES) {
				await reader.cancel().catch(() => undefined);
				return { ok: false };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false };
	} finally {
		reader.releaseLock();
	}
	try {
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? { ok: true, value: parsed as Record<string, unknown> }
			: { ok: false };
	} catch {
		return { ok: false };
	}
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).toSorted();
	const expected = keys.toSorted();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

interface DraftPreview {
	preview: ReturnType<typeof inspectLegacyTeamSetupActivation> | null;
	unavailableReason: LegacyTeamSetupUnavailableReasonV1 | null;
}

function draftPreview(
	store: MemoryStore,
	draft: LegacyTeamSetupDraftView,
	options: { editable?: boolean },
): DraftPreview {
	if (draft.state === "completed") return { preview: null, unavailableReason: null };
	// A device that can't save draft edits sees the draft with every action off.
	if (options.editable === false)
		return { preview: null, unavailableReason: "team_setup_admin_required" };
	try {
		const preview = inspectLegacyTeamSetupActivation(store.db, {
			candidateRef: draft.candidateRef,
			attemptId: draft.attemptId,
		});
		return { preview, unavailableReason: null };
	} catch (error) {
		const code = apiErrorCode(error);
		if (code === "team_setup_failed") throw error;
		if (code === "team_setup_projection_changed")
			return { preview: null, unavailableReason: "team_setup_conflict" };
		return { preview: null, unavailableReason: code === "team_setup_incomplete" ? null : code };
	}
}

function detailResponse(
	store: MemoryStore,
	draft: LegacyTeamSetupDraftView,
	candidate: LegacyTeamCandidateView = candidateFromDraft(draft),
	options: { editable?: boolean } = {},
): LegacyTeamSetupDetailResponseV1 {
	const { preview, unavailableReason } = draftPreview(store, draft, options);
	if (preview) requireLegacyTeamSetupAccessDeltaWithinLimit(preview.accessDelta);
	const safeDraft = viewerSafeDraft(store, draft);
	const safePreview = preview ? viewerSafePreview(draft, safeDraft, preview) : null;
	return projectLegacyTeamSetupView({
		version: TEAM_SETUP_VERSION,
		candidate: candidateSummaryForDraft(candidate, draft),
		draftState: draft.state,
		attemptId: draft.attemptId,
		unresolvedDeviceCount: draft.unresolvedDeviceCount,
		unresolvedProjectCount: draft.unresolvedProjectCount,
		...safeDraft,
		unavailableReason,
		preview: safePreview,
	});
}

function finishResponse(
	candidateRef: string,
	result: LegacyTeamSetupActivationResultV1,
): LegacyTeamSetupFinishResponseV1 {
	return {
		version: TEAM_SETUP_VERSION,
		status: result.status,
		teamRef: teamRef(candidateRef, result.teamId),
		attemptId: result.attemptId,
		accessDeltaDigest: result.accessDeltaDigest,
		completedAt: result.completedAt,
	};
}

interface AssignmentRequest {
	attemptId: string;
	expectation: Record<string, unknown>;
	assignee: AssignmentTarget;
}

function parseAssignmentRequest(body: Record<string, unknown>): AssignmentRequest | null {
	const assignee = parseAssignmentTarget(body);
	const { attemptId, expectation } = body;
	if (!assignee || typeof attemptId !== "string" || !ATTEMPT_ID_PATTERN.test(attemptId)) {
		return null;
	}
	if (!expectation || typeof expectation !== "object" || Array.isArray(expectation)) return null;
	return { attemptId, expectation: expectation as Record<string, unknown>, assignee };
}

type AssignmentFailureCode =
	| "team_setup_incomplete"
	| "team_setup_person_listed"
	| "team_setup_confirmation_stale"
	| "team_setup_assignment_changed";

type AssignmentOutcome =
	| { status: 200; body: ReturnType<typeof detailResponse> }
	| { status: 400 | 404 | 409; body: { error: AssignmentFailureCode } };

function assignmentFailure(
	error: AssignmentFailureCode,
	status: 400 | 404 | 409,
): AssignmentOutcome {
	return { status, body: { error } };
}

function assignmentExpectationMatches(
	candidateRef: string,
	expected: LegacyTeamSetupDraftView["devices"][number]["expectation"],
	submitted: Record<string, unknown>,
): boolean {
	if (expected.kind === "absent") {
		return hasExactKeys(submitted, ["kind"]) && submitted.kind === "absent";
	}
	return (
		hasExactKeys(submitted, ["assignmentVersion", "identityRef", "kind"]) &&
		submitted.kind === "existing" &&
		submitted.assignmentVersion === expected.assignmentVersion &&
		submitted.identityRef === requiredIdentityRef(candidateRef, expected.identityId)
	);
}

/** The listed person a device goes to, null for someone new, or why neither works. */
function assigneeIdentityId(
	store: MemoryStore,
	candidateRef: string,
	assignee: AssignmentTarget,
): { identityId: string | null } | AssignmentOutcome {
	if ("newPersonName" in assignee) {
		return personNameTaken(store, assignee.newPersonName)
			? assignmentFailure("team_setup_person_listed", 409)
			: { identityId: null };
	}
	const target = identityChoices(store, candidateRef).find(
		(choice) => choice.identityRef === assignee.targetIdentityRef,
	);
	return target
		? { identityId: target.identityId }
		: assignmentFailure("team_setup_confirmation_stale", 404);
}

function editableAssignmentDraft(
	store: MemoryStore,
	candidateRef: string,
	attemptId: string,
): LegacyTeamSetupDraftView | AssignmentOutcome {
	const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
	if (!draft) return assignmentFailure("team_setup_confirmation_stale", 404);
	const stale =
		(draft.state !== "completed" && hasCompletedLegacyTeamSetup(store, candidateRef)) ||
		draft.attemptId !== attemptId ||
		draft.state === "completed";
	return stale ? assignmentFailure("team_setup_confirmation_stale", 409) : draft;
}

function saveDeviceAssignment(
	store: MemoryStore,
	input: AssignmentRequest & { candidateRef: string; deviceRef: string },
): AssignmentOutcome {
	const draft = editableAssignmentDraft(store, input.candidateRef, input.attemptId);
	if ("status" in draft) return draft;
	const device = draft.devices.find((item) => item.deviceRef === input.deviceRef);
	if (!device) return assignmentFailure("team_setup_confirmation_stale", 404);
	if (!assignmentExpectationMatches(input.candidateRef, device.expectation, input.expectation)) {
		return assignmentFailure("team_setup_assignment_changed", 409);
	}
	const target = assigneeIdentityId(store, input.candidateRef, input.assignee);
	if ("status" in target) return target;
	const releaseMutation = claimCandidateMutation(store.db, input.candidateRef);
	if (!releaseMutation) return assignmentFailure("team_setup_confirmation_stale", 409);
	try {
		const body = projectMutationAtomically(
			store,
			() =>
				setLegacyTeamSetupDeviceAssignment(store.db, {
					attemptId: input.attemptId,
					deviceRef: input.deviceRef,
					targetIdentityId: target.identityId ?? insertTeamSetupPerson(store, input.assignee),
					expectation: device.expectation,
				}),
			(updated) => detailResponse(store, updated),
		);
		return { status: 200, body };
	} finally {
		releaseMutation();
	}
}

interface CompletionAuthorization {
	config: ReturnType<typeof readCoordinatorSyncConfig>;
	remoteUrl: string;
	configuredCoordinatorId: string;
	currentGroupIds: Set<string>;
}

function readCompletionAuthorization(
	options: TeamSetupRoutesOptions,
): CompletionAuthorization | null {
	const config = (
		options.readCoordinatorConfig ??
		options.snapshotLoaderDependencies?.readConfig ??
		readCoordinatorSyncConfig
	)();
	const remoteUrl = buildBaseUrl(config.syncCoordinatorUrl);
	if (!remoteUrl || !config.syncCoordinatorAdminSecret) return null;
	const configuredCoordinatorId = normalizedCoordinatorId(remoteUrl);
	if (!configuredCoordinatorId) return null;
	let currentGroupIds: Set<string>;
	try {
		currentGroupIds = new Set(configuredGroupIds(config.syncCoordinatorGroups));
	} catch {
		return null;
	}
	return { config, remoteUrl, configuredCoordinatorId, currentGroupIds };
}

/** One daemon lookup per reconciliation, read only when a missing device needs it. */
function peerRemovalReader(
	dependencies: LegacyTeamCompletionDependencies,
	store: MemoryStore,
	config: CompletionAuthorization["config"],
): LookupCompletionPeerRemovals {
	let lookup: Promise<LegacyTeamSetupPeerRemovalEvidence> | undefined;
	return () => {
		const read = dependencies.lookupPeerRemovals;
		if (!read) return Promise.resolve(undefined);
		lookup ??= Promise.resolve()
			.then(() => read(store, config))
			.then(
				(result): LegacyTeamSetupPeerRemovalEvidence =>
					result.status === "checked"
						? {
								status: "read",
								removed: result.removed,
								enrolled: result.enrolled,
								generation: result.generation,
							}
						: { status: "unavailable" },
				(): LegacyTeamSetupPeerRemovalEvidence => ({ status: "unavailable" }),
			);
		return lookup;
	};
}

function completionReadActions(
	dependencies: LegacyTeamCompletionDependencies,
	{ authorization, store }: { authorization: CompletionAuthorization; store: MemoryStore },
	timeoutS: number,
	deadlineMs: number,
) {
	const { config, remoteUrl } = authorization;
	const adminSecret = config.syncCoordinatorAdminSecret;
	let removals: ReturnType<ListCompletionRemovals> | undefined;
	const listRemovals: ListCompletionRemovals = () => {
		const read = dependencies.listRemovals;
		if (!read) return Promise.resolve(undefined);
		// A failed read is not an empty list: core must not treat it as missing proof.
		removals ??= read({
			includeBlocked: true,
			remote: { url: remoteUrl, adminSecret, timeoutS, deadlineMs },
		}).then(
			(items): LegacyTeamSetupDeviceRemovalEvidence => ({ status: "read", removals: items }),
			(): LegacyTeamSetupDeviceRemovalEvidence => ({ status: "unavailable" }),
		);
		return removals;
	};
	const listCompletionRecords = (groupIds: string[]) =>
		retryTransientCoordinatorRead(
			(attemptTimeoutS) =>
				dependencies.list({ groupIds, remoteUrl, adminSecret, timeoutS: attemptTimeoutS }),
			timeoutS,
			deadlineMs,
		);
	const removalReads: CompletionRemovalReads = {
		listRemovals,
		lookupPeerRemovals: peerRemovalReader(dependencies, store, config),
		listTeamMemberRemovals: async (groupId) => {
			const read = dependencies.listTeamMemberRemovals;
			if (!read) return undefined;
			try {
				return await read({ groupId, remoteUrl, adminSecret, timeoutS });
			} catch (error) {
				throw new TeamMemberRemovalsUnavailableError(error);
			}
		},
	};
	return { listCompletionRecords, removalReads };
}

/**
 * What applying a completion needs from the coordinator: device removal
 * evidence when an included device is missing, and always the group's Team
 * member removals. A removal recorded on another admin device must be known
 * before the completion runs, or applying it could make that person a member
 * again. A failed removal read throws, so nothing is applied.
 */
async function readCompletionEvidence(
	reads: CompletionRemovalReads,
	groupId: string,
	includedDeviceMissing: boolean,
) {
	const removalEvidence = includedDeviceMissing ? await readRemovalEvidence(reads) : {};
	const teamMemberRemovals = await reads.listTeamMemberRemovals(groupId);
	return { removalEvidence, teamMemberRemovals };
}

/** Records the group's Team member removals, then applies the completion. */
async function applyCompletionAfterTeamMemberRemovals(
	store: MemoryStore,
	teamMemberRemovals: CoordinatorTeamMemberRemoval[] | undefined,
	input: Parameters<typeof applyLegacyTeamSetupCompletionManifest>[1],
) {
	if (teamMemberRemovals)
		applyTeamMemberRemovals(store.db, {
			coordinatorId: input.coordinatorId,
			groupId: input.groupId,
			removals: teamMemberRemovals,
			now: new Date().toISOString(),
		});
	await applyLegacyTeamSetupCompletionManifest(store.db, input);
}

async function readRemovalEvidence(reads: CompletionRemovalReads) {
	return {
		deviceRemovals: await reads.listRemovals(),
		peerRemovals: await reads.lookupPeerRemovals(),
	};
}

// Endpoint equivalence only: candidate identity stays bound to the persisted
// coordinator string and is never rewritten from configuration.
function authorizesGroup(
	authorization: CompletionAuthorization,
	group: LegacyTeamCandidateGroupDescriptor,
): boolean {
	return (
		authorization.currentGroupIds.has(group.groupId) &&
		normalizedCoordinatorId(group.coordinatorId) === authorization.configuredCoordinatorId
	);
}

/**
 * Draft edits decide who will receive Projects once the Team is set up, so only a
 * device that could finish setup saves them (ADR 0007 Decision 4). Reading a draft
 * stays open to any device. The routes check on entry, and the write transaction
 * checks again, because body parsing and lock waits come in between.
 */
const draftEditAuthority = new AsyncLocalStorage<() => boolean>();

const DRAFT_EDIT_ROUTES = [
	["PUT", "/api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/assignment"],
	["PUT", "/api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/decision"],
	["DELETE", "/api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/decision"],
	["PUT", "/api/sync/team-setup/v1/:candidateRef/projects/:projectRef/mapping"],
	["POST", "/api/sync/team-setup/v1/:candidateRef/refresh"],
] as const;

/**
 * Discovery of a completed Team can restore its setup-owned Project recipients,
 * which changes who receives Projects, so it needs current authority for the
 * Team's group. Every Team setup request carries that check; without it, nothing
 * completed is rediscovered.
 */
const completedTeamDiscoveryAuthority = new AsyncLocalStorage<
	(group: LegacyTeamCandidateGroupDescriptor) => boolean
>();

function installSetupGates(
	app: Hono,
	getStore: () => MemoryStore,
	authorization: () => CompletionAuthorization | null,
	mayEditDraft: (store: MemoryStore, candidateRef: string) => boolean,
): void {
	const mayEdit = (candidateRef: string) => mayEditDraft(getStore(), candidateRef);
	for (const [method, path] of DRAFT_EDIT_ROUTES) {
		app.on(method, path, async (c, next) => {
			const candidateRef = c.req.param("candidateRef") ?? "";
			if (!mayEdit(candidateRef))
				return c.json({ error: "team_setup_admin_required" as const }, 403);
			await draftEditAuthority.run(() => mayEdit(candidateRef), next);
		});
	}
	const mayRediscover = (group: LegacyTeamCandidateGroupDescriptor) => {
		const current = authorization();
		return Boolean(current && authorizesGroup(current, group));
	};
	for (const path of ["/api/sync/team-setup/v1", "/api/sync/team-setup/v1/*"]) {
		app.use(path, (_c, next) => completedTeamDiscoveryAuthority.run(mayRediscover, next));
	}
}

export function teamSetupRoutes(options: TeamSetupRoutesOptions): Hono {
	const app = new Hono();
	const loadSnapshots =
		options.loadLegacyTeamConfiguredGroupSnapshots ??
		((loadOptions?: LegacyTeamConfiguredGroupSnapshotLoadOptions) =>
			loadConfiguredLegacyTeamGroupSnapshotsWith(
				options.snapshotLoaderDependencies ?? defaultSnapshotLoaderDependencies,
				loadOptions,
				options.getStore,
			));

	async function loadedSnapshots(
		candidateRef?: string,
		deadlineMs?: number,
	): Promise<LegacyTeamConfiguredGroupSnapshot[]> {
		try {
			return await loadSnapshots(
				candidateRef || deadlineMs != null ? { candidateRef, deadlineMs } : undefined,
			);
		} catch (error) {
			if (isPassthroughSnapshotLoadError(error)) {
				throw error;
			}
			throw safeCoordinatorError();
		}
	}
	const loadedSummarySnapshots = createLoadedSummarySnapshotCache(loadedSnapshots, options);
	const reconciliation = createSummaryReconciliation(
		options,
		loadedSummarySnapshots,
		reconcileCompletions,
	);
	const completionDependencies =
		options.completionDependencies === undefined
			? defaultCompletionDependencies
			: options.completionDependencies;

	const currentCompletionAuthorization = () => readCompletionAuthorization(options);

	function hasDraftEditAuthority(store: MemoryStore, candidateRef: string): boolean {
		const authorization = currentCompletionAuthorization();
		const group = persistedCompletionGroup(store, candidateRef);
		return Boolean(authorization && (!group || authorizesGroup(authorization, group)));
	}
	const detailAccess = (store: MemoryStore, candidateRef: string) => ({
		editable: hasDraftEditAuthority(store, candidateRef),
	});
	installSetupGates(app, options.getStore, currentCompletionAuthorization, hasDraftEditAuthority);

	/**
	 * Configuration may change while completion-list or roster requests are in
	 * flight. Re-prove authorization for the exact coordinator and group right
	 * before applying canonical policy, as the finish publication path does.
	 */
	function stillAuthorizesGroup(
		initial: CompletionAuthorization,
		group: LegacyTeamCandidateGroupDescriptor,
	): boolean {
		let current: CompletionAuthorization | null;
		try {
			current = currentCompletionAuthorization();
		} catch {
			return false;
		}
		return (
			current !== null &&
			current.configuredCoordinatorId === initial.configuredCoordinatorId &&
			current.remoteUrl === initial.remoteUrl &&
			current.config.syncCoordinatorAdminSecret === initial.config.syncCoordinatorAdminSecret &&
			authorizesGroup(current, group)
		);
	}

	function matchesGroupSnapshot(
		snapshot: LegacyTeamConfiguredGroupSnapshot,
		group: LegacyTeamCandidateGroupDescriptor,
	): boolean {
		return (
			snapshot.groupId === group.groupId &&
			normalizedCoordinatorId(snapshot.coordinatorId) ===
				normalizedCoordinatorId(group.coordinatorId)
		);
	}

	function freshGroupKey(group: { coordinatorId: string; groupId: string }): string {
		return `${normalizedCoordinatorId(group.coordinatorId) ?? group.coordinatorId}\0${group.groupId}`;
	}

	/**
	 * The snapshot loader keys candidates by the configured coordinator spelling,
	 * while a persisted group may carry an equivalent but different spelling.
	 * Ask for the roster under each spelling and match on normalized identity,
	 * preserving the persisted candidate identity for everything else.
	 */
	async function loadFreshGroupSnapshot(
		group: LegacyTeamCandidateGroupDescriptor,
		remoteUrl: string,
		deadlineMs: number,
	): Promise<LegacyTeamConfiguredGroupSnapshot | undefined> {
		const candidateRefs = [
			...new Set([
				legacyTeamCandidateId(remoteUrl, group.groupId),
				legacyTeamCandidateId(group.coordinatorId, group.groupId),
			]),
		];
		for (const candidateRef of candidateRefs) {
			const snapshots = await loadedSnapshots(candidateRef, deadlineMs);
			const matches = snapshots.filter((snapshot) => matchesGroupSnapshot(snapshot, group));
			if (matches.length > 1) throw new Error("team_setup_completion_invalid");
			if (matches[0]) return matches[0];
		}
		return undefined;
	}

	function completionRecordCandidateRef(record: { manifest: unknown }): string | null {
		const manifest = record.manifest;
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
		const candidateRef = (manifest as { candidate_ref?: unknown }).candidate_ref;
		return typeof candidateRef === "string" ? candidateRef : null;
	}

	// The coordinator lists every candidate a group has ever completed. A record
	// for a different candidate identity (an earlier coordinator address) is
	// historical context, not evidence about this candidate.
	function belongsToGroupCandidate(
		record: { manifest: unknown },
		group: LegacyTeamCandidateGroupDescriptor,
	): boolean {
		const candidateRef = completionRecordCandidateRef(record);
		return (
			candidateRef === null ||
			candidateRef === legacyTeamCandidateId(group.coordinatorId, group.groupId)
		);
	}

	/**
	 * Applies a canonical manifest with authorization re-proven inside the same
	 * serialized section that guards the apply. Checking before the locks would
	 * let a group removed while reconciliation waited on another policy
	 * mutation still be applied once the queues open.
	 */
	async function applyCanonicalManifestIfStillAuthorized(
		store: MemoryStore,
		authorization: CompletionAuthorization,
		group: LegacyTeamCandidateGroupDescriptor,
		manifest: CoordinatorLegacyTeamCompletionManifestV1,
		freshRoster: LegacyTeamConfiguredGroupSnapshot["devices"],
		reads: CompletionRemovalReads,
	): Promise<"applied" | "unauthorized" | "claimed"> {
		const freshIds = new Set(freshRoster.map((device) => device.deviceId));
		const missing = manifest.device_decisions.some(
			(device) => device.decision === "included" && !freshIds.has(device.device_id),
		);
		const evidence = await readCompletionEvidence(reads, group.groupId, missing);
		let outcome: "applied" | "unauthorized" = "unauthorized";
		const ran = await runCandidateMutation(
			store.db,
			legacyTeamCandidateId(group.coordinatorId, group.groupId),
			() =>
				serializeCanonicalManifestMutation(store, group.groupId, manifest, async (actorIds) => {
					if (!stillAuthorizesGroup(authorization, group)) return;
					await applyCompletionAfterTeamMemberRemovals(store, evidence.teamMemberRemovals, {
						coordinatorId: group.coordinatorId,
						groupId: group.groupId,
						manifest,
						freshRoster,
						...evidence.removalEvidence,
						recipientPolicyLocksHeld: completionRecipientPolicyLocksHeld(actorIds),
					});
					outcome = "applied";
				}),
		);
		return ran ? outcome : "claimed";
	}

	async function reconcileCompletions(
		store: MemoryStore,
		groups: LegacyTeamCandidateGroupDescriptor[],
		reconciliationOptions: CompletionReconciliationOptions = {},
	): Promise<void> {
		const { handledGroupIds, handleFailure, reportFailure } =
			completionFailureHandlers(reconciliationOptions);
		if (!completionDependencies || groups.length === 0) return;
		let authorization: CompletionAuthorization | null;
		try {
			authorization = currentCompletionAuthorization();
		} catch (error) {
			throw new Error(completionApiError(error), { cause: error });
		}
		// If current authorization cannot be proven, skip completion I/O without
		// failing an otherwise serviceable persisted detail read.
		if (!authorization) return;
		const { config, remoteUrl } = authorization;
		const scopedGroups = groups.filter((group) => authorizesGroup(authorization, group));
		if (scopedGroups.length === 0) return;
		const timeoutS = Math.max(1, config.syncCoordinatorTimeoutS);
		try {
			const reconciliationDeadlineMs = Date.now() + COORDINATOR_ROSTER_READ_BUDGET_MS;
			const { listCompletionRecords, removalReads } = completionReadActions(
				completionDependencies,
				{ authorization, store },
				timeoutS,
				reconciliationDeadlineMs,
			);
			const groupById = new Map(scopedGroups.map((group) => [group.groupId, group]));
			const scopedGroupIds = [...new Set(scopedGroups.map((group) => group.groupId))];
			let records: Awaited<ReturnType<LegacyTeamCompletionDependencies["list"]>>;
			try {
				records = await listCompletionRecords(scopedGroupIds);
			} catch (error) {
				// Older coordinators do not expose completion reconciliation. Read routes
				// remain usable, and best-effort publication below still lets upgraded
				// peers observe a locally completed migration.
				if (isUnsupportedCompletionQuery(error)) {
					records = [];
				} else if (
					reconciliationOptions.isolateApplyFailures &&
					isUnattributableCompletionBatchError(error)
				) {
					// One corrupt or mixed-version record must not hide every healthy
					// group's setup state. Re-query per group so the decode failure
					// stays attributable; a group whose own record cannot be decoded is
					// skipped, matching the unprovable-binding path below.
					records = await listCompletionRecordsPerGroup(
						scopedGroupIds,
						listCompletionRecords,
						groupCompletionFailureHandler(groupById, handleFailure),
						error,
					);
				} else {
					throw error;
				}
			}
			const freshGroupByKey = new Map<string, LegacyTeamConfiguredGroupSnapshot>();
			if (records.length > 0) {
				try {
					const onlyGroup = scopedGroups.length === 1 ? scopedGroups[0] : undefined;
					const freshGroups = onlyGroup
						? [await loadFreshGroupSnapshot(onlyGroup, remoteUrl, reconciliationDeadlineMs)]
						: await loadedSnapshots(undefined, reconciliationDeadlineMs);
					addFreshCompletionGroups(freshGroupByKey, freshGroups, freshGroupKey);
				} catch (error) {
					for (const record of records) {
						const group = groupById.get(record.group_id);
						if (!group || !belongsToGroupCandidate(record, group)) continue;
						reportFailure(group, error);
						try {
							validateLegacyTeamSetupCompletionManifestBinding(record.manifest, {
								coordinatorId: group.coordinatorId,
								groupId: group.groupId,
							});
						} catch (bindingError) {
							handleFailure(group, bindingError);
							continue;
						}
						let canonicalManifest: ReturnType<typeof validateLegacyTeamSetupCompletionManifest>;
						try {
							canonicalManifest = validateLegacyTeamSetupCompletionManifest(record.manifest, {
								coordinatorId: group.coordinatorId,
								groupId: group.groupId,
							});
						} catch (validationError) {
							reportFailure(group, validationError);
							try {
								const contained = await runCandidateMutation(
									store.db,
									legacyTeamCandidateId(group.coordinatorId, group.groupId),
									() =>
										containLegacyTeamSetupCompletionConflict(store.db, {
											coordinatorId: group.coordinatorId,
											groupId: group.groupId,
										}),
								);
								if (!contained) {
									handleFailure(group, validationError);
									continue;
								}
							} catch (containmentError) {
								handleFailure(group, containmentError);
							}
							if (!reconciliationOptions.isolateApplyFailures) throw validationError;
							continue;
						}
						try {
							const localManifest = reconstructLegacyTeamSetupCompletionManifest(store.db, {
								candidateRef: canonicalManifest.candidate_ref,
							});
							if (
								canonicalCoordinatorLegacyTeamCompletionManifestJson(localManifest) ===
								canonicalCoordinatorLegacyTeamCompletionManifestJson(canonicalManifest)
							) {
								continue;
							}
							if (
								areLegacyTeamSetupCompletionPolicyFactsAdditivelyCompatible(
									localManifest,
									canonicalManifest,
								)
							) {
								continue;
							}
						} catch {
							// Missing or invalid local completion state must not remain active when
							// a valid coordinator winner cannot be applied safely.
						}
						try {
							await runCandidateMutation(store.db, canonicalManifest.candidate_ref, () =>
								containLegacyTeamSetupCompletionConflict(store.db, {
									coordinatorId: group.coordinatorId,
									groupId: group.groupId,
								}),
							);
						} catch (containmentError) {
							handleFailure(group, containmentError);
						}
					}
					if (!reconciliationOptions.isolateApplyFailures) throw error;
					return;
				}
			}
			for (const record of records) {
				const group = groupById.get(record.group_id);
				if (!group) throw new Error("team_setup_completion_invalid");
				if (!belongsToGroupCandidate(record, group)) continue;
				try {
					validateLegacyTeamSetupCompletionManifestBinding(record.manifest, {
						coordinatorId: group.coordinatorId,
						groupId: group.groupId,
					});
				} catch (bindingError) {
					handleFailure(group, bindingError);
					continue;
				}
				let canonicalManifest: ReturnType<typeof validateLegacyTeamSetupCompletionManifest>;
				try {
					canonicalManifest = validateLegacyTeamSetupCompletionManifest(record.manifest, {
						coordinatorId: group.coordinatorId,
						groupId: group.groupId,
					});
				} catch (validationError) {
					reportFailure(group, validationError);
					try {
						await runCandidateMutation(
							store.db,
							legacyTeamCandidateId(group.coordinatorId, group.groupId),
							() =>
								containLegacyTeamSetupCompletionConflict(store.db, {
									coordinatorId: group.coordinatorId,
									groupId: group.groupId,
								}),
						);
					} catch (containmentError) {
						handleFailure(group, containmentError);
					}
					if (!reconciliationOptions.isolateApplyFailures) throw validationError;
					continue;
				}
				handledGroupIds.add(record.group_id);
				try {
					let freshGroup = freshGroupByKey.get(freshGroupKey(group));
					if (!freshGroup && scopedGroups.length > 1) {
						if (remainingCoordinatorTimeoutS(timeoutS, reconciliationDeadlineMs) == null) {
							throw new Error("team_setup_roster_unavailable");
						}
						freshGroup = await loadFreshGroupSnapshot(group, remoteUrl, reconciliationDeadlineMs);
					}
					if (!freshGroup) {
						const contained = await runCandidateMutation(
							store.db,
							legacyTeamCandidateId(group.coordinatorId, group.groupId),
							() =>
								containLegacyTeamSetupCompletionConflict(store.db, {
									coordinatorId: group.coordinatorId,
									groupId: group.groupId,
								}),
						);
						if (!contained) {
							handleFailure(group, new Error("team_setup_completion_invalid"));
							continue;
						}
						throw new Error("team_setup_completion_invalid");
					}
					const applied = await applyCanonicalManifestIfStillAuthorized(
						store,
						authorization,
						group,
						canonicalManifest,
						freshGroup.devices,
						removalReads,
					);
					if (applied !== "applied") continue;
				} catch (error) {
					handleFailure(group, error);
				}
			}
			for (const group of scopedGroups) {
				if (handledGroupIds.has(group.groupId)) continue;
				const publicationTimeoutS = remainingCoordinatorTimeoutS(
					timeoutS,
					reconciliationDeadlineMs,
				);
				if (publicationTimeoutS == null) break;
				if (
					!hasCompletedLegacyTeamSetup(
						store,
						legacyTeamCandidateId(group.coordinatorId, group.groupId),
					)
				) {
					continue;
				}
				const candidateRef = legacyTeamCandidateId(group.coordinatorId, group.groupId);
				let reconstructionFailed = false;
				try {
					const published = await runCandidateMutation(store.db, candidateRef, () =>
						serializeRecipientPolicyPublicationMutation(store.db, () =>
							serializeRecipientPolicyTeamMutation(
								store.db,
								deterministicPolicyTeamId(candidateRef),
								async () => {
									let manifest: ReturnType<typeof reconstructLegacyTeamSetupCompletionManifest>;
									try {
										manifest = reconstructLegacyTeamSetupCompletionManifest(store.db, {
											candidateRef,
										});
									} catch {
										reconstructionFailed = true;
										return;
									}
									// Publication sends identity and policy data to the coordinator;
									// re-prove the destination is still the configured one.
									if (!stillAuthorizesGroup(authorization, group)) {
										reconstructionFailed = true;
										return;
									}
									await completionDependencies.create({
										groupId: group.groupId,
										manifest,
										remoteUrl,
										adminSecret: config.syncCoordinatorAdminSecret,
										timeoutS: publicationTimeoutS,
									});
								},
							),
						),
					);
					if (!published || reconstructionFailed) continue;
				} catch (error) {
					// Publishing an existing local completion is best-effort. The bounded
					// list/apply pass above remains authoritative and fail-closed.
					if (completionApiError(error) !== "team_setup_completion_conflict") continue;
					const getCompletion = completionDependencies.get;
					let canonicalManifest: Awaited<ReturnType<NonNullable<typeof getCompletion>>> = null;
					try {
						if (!getCompletion) throw new Error("team_setup_completion_conflict");
						canonicalManifest = await retryTransientCoordinatorRead(
							(attemptTimeoutS) =>
								getCompletion({
									groupId: group.groupId,
									candidateRef,
									remoteUrl,
									adminSecret: config.syncCoordinatorAdminSecret,
									timeoutS: attemptTimeoutS,
								}),
							timeoutS,
							reconciliationDeadlineMs,
						);
						if (!canonicalManifest) throw new Error("team_setup_completion_conflict");
					} catch {
						try {
							const contained = await runCandidateMutation(store.db, candidateRef, () =>
								containLegacyTeamSetupCompletionConflict(store.db, {
									coordinatorId: group.coordinatorId,
									groupId: group.groupId,
								}),
							);
							if (!contained) {
								handleFailure(group, new Error("team_setup_completion_conflict"));
								continue;
							}
						} catch (containmentError) {
							handleFailure(group, containmentError);
							continue;
						}
						handleFailure(group, new Error("team_setup_completion_conflict"));
						continue;
					}
					try {
						const freshGroup = await loadFreshGroupSnapshot(
							group,
							remoteUrl,
							reconciliationDeadlineMs,
						);
						if (!freshGroup) throw new Error("team_setup_roster_unavailable");
						const applied = await applyCanonicalManifestIfStillAuthorized(
							store,
							authorization,
							group,
							canonicalManifest,
							freshGroup.devices,
							removalReads,
						);
						if (applied !== "applied") continue;
					} catch (applyError) {
						if (isNonDivergentApplyFailure(applyError)) {
							handleFailure(group, applyError);
							continue;
						}
						try {
							const contained = await runCandidateMutation(store.db, candidateRef, () =>
								containLegacyTeamSetupCompletionConflict(store.db, {
									coordinatorId: group.coordinatorId,
									groupId: group.groupId,
								}),
							);
							if (!contained) {
								handleFailure(group, completionConflictError(applyError));
								continue;
							}
						} catch (containmentError) {
							handleFailure(group, containmentError);
							continue;
						}
						handleFailure(group, completionConflictError(applyError));
					}
				}
			}
		} catch (error) {
			throw new Error(completionApiError(error), { cause: error });
		}
	}
	async function loadedCandidateSnapshots(
		candidateRef: string,
		loadOptions: {
			allowCachedSummaryFallback?: boolean;
			deadlineMs?: number;
			invalidateSummaryCache?: boolean;
		} = {},
	): Promise<LegacyTeamConfiguredGroupSnapshot[]> {
		const allowCachedSummaryFallback = loadOptions.allowCachedSummaryFallback ?? false;
		const invalidateSummaryCache = loadOptions.invalidateSummaryCache ?? true;
		if (invalidateSummaryCache) loadedSummarySnapshots.invalidate();
		try {
			return await loadedSnapshots(candidateRef, loadOptions.deadlineMs);
		} catch (error) {
			if (!allowCachedSummaryFallback) throw error;
			const cachedGroups = loadedSummarySnapshots.peek();
			if (!cachedGroups) throw error;
			const matching = cachedGroups.filter(
				(group) => legacyTeamCandidateId(group.coordinatorId, group.groupId) === candidateRef,
			);
			if (matching.length !== 1) throw error;
			return matching;
		} finally {
			if (invalidateSummaryCache) loadedSummarySnapshots.invalidate();
		}
	}

	function persistedCompletionGroup(
		store: MemoryStore,
		candidateRef: string,
	): LegacyTeamCandidateGroupDescriptor | null {
		const row = store.db
			.prepare(
				`SELECT coordinator_id, group_id FROM legacy_team_setup_drafts
				 WHERE candidate_id = ? ORDER BY rowid DESC LIMIT 1`,
			)
			.get(candidateRef) as { coordinator_id: string; group_id: string } | undefined;
		if (!row || legacyTeamCandidateId(row.coordinator_id, row.group_id) !== candidateRef)
			return null;
		return { coordinatorId: row.coordinator_id, groupId: row.group_id };
	}

	// The summary never waits for the coordinator; the background pass does that.
	app.get("/api/sync/team-setup/v1", (c) => {
		try {
			const summary = summaryResponse(options.getStore(), reconciliation.read());
			return "error" in summary ? c.json(summary, errorStatus(summary.error)) : c.json(summary);
		} catch (error) {
			const failure = teamSetupFailure(error, `${c.req.method} ${c.req.routePath}`);
			return c.json({ error: failure.code }, failure.status);
		}
	});

	app.get("/api/sync/team-setup/v1/:candidateRef", async (c) => {
		const candidateRef = c.req.param("candidateRef");
		if (!CANDIDATE_REF_PATTERN.test(candidateRef)) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}

		try {
			const store = options.getStore();
			let draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			const terminal = hasCompletedLegacyTeamSetup(store, candidateRef);
			let candidateGroupsForCompletion: LegacyTeamConfiguredGroupSnapshot[] | null = null;
			if (terminal && draft?.state !== "completed") {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			}
			let candidate: LegacyTeamCandidateView;
			if (draft && (draft.state !== "completed" || terminal)) {
				candidate = candidateFromDraft(draft);
			} else {
				// Revalidation may replace a completed draft, so it must never decide
				// against a stale summary-cache roster. Cache fallback remains safe for
				// candidates that have no persisted attempt yet.
				const groups = await loadedCandidateSnapshots(candidateRef, {
					allowCachedSummaryFallback: draft == null,
					invalidateSummaryCache: false,
				});
				const candidateGroups = groups.filter(
					(group) => legacyTeamCandidateId(group.coordinatorId, group.groupId) === candidateRef,
				);
				candidateGroupsForCompletion = candidateGroups;
				const postLoadDraft = getLegacyTeamSetupDraft(store.db, candidateRef);
				if (hasCompletedLegacyTeamSetup(store, candidateRef)) {
					if (postLoadDraft?.state !== "completed") {
						return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
					}
					draft = postLoadDraft;
					candidate = candidateFromDraft(postLoadDraft);
				} else {
					const discoveredCandidate = discoverCandidates(store, candidateGroups).find(
						(item) => item.candidateRef === candidateRef,
					);
					if (!discoveredCandidate) {
						return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
					}
					candidate = discoveredCandidate;
					draft = getLegacyTeamSetupDraft(store.db, candidateRef);
				}
			}
			if (!draft) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			const cachedCandidateGroups = loadedSummarySnapshots
				.peek()
				?.filter(
					(group) => legacyTeamCandidateId(group.coordinatorId, group.groupId) === candidateRef,
				);
			let completionGroups: LegacyTeamCandidateGroupDescriptor[] | null =
				candidateGroupsForCompletion ??
				(cachedCandidateGroups?.length ? cachedCandidateGroups : null);
			if (!completionGroups) {
				const persistedGroup = persistedCompletionGroup(store, candidateRef);
				completionGroups = persistedGroup ? [persistedGroup] : null;
			}
			const terminalBeforeReconciliation = hasCompletedLegacyTeamSetup(store, candidateRef);
			if (completionGroups) await reconcileCompletions(store, completionGroups);
			draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			if (
				!draft ||
				(!terminalBeforeReconciliation && hasCompletedLegacyTeamSetup(store, candidateRef))
			) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			}
			if (completionGroups) candidate = candidateFromDraft(draft);

			return c.json(detailResponse(store, draft, candidate, detailAccess(store, candidateRef)));
		} catch (error) {
			const failure = detailFailure(error, `${c.req.method} ${c.req.routePath}`);
			return c.json(failure.body, failure.status);
		}
	});

	app.put("/api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/assignment", async (c) => {
		const candidateRef = c.req.param("candidateRef");
		const deviceRef = c.req.param("deviceRef");
		if (!CANDIDATE_REF_PATTERN.test(candidateRef) || !DEVICE_REF_PATTERN.test(deviceRef)) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const parsed = await parseBoundedJsonObject(c);
		const request = parsed.ok ? parseAssignmentRequest(parsed.value) : null;
		if (!request) return c.json({ error: "team_setup_incomplete" as const }, 400);
		try {
			const outcome = saveDeviceAssignment(options.getStore(), {
				candidateRef,
				deviceRef,
				...request,
			});
			return c.json(outcome.body, outcome.status);
		} catch (error) {
			const failure = teamSetupFailure(error, `${c.req.method} ${c.req.routePath}`);
			return c.json({ error: failure.code }, failure.status);
		}
	});

	app.put("/api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/decision", async (c) => {
		const candidateRef = c.req.param("candidateRef");
		const deviceRef = c.req.param("deviceRef");
		if (!CANDIDATE_REF_PATTERN.test(candidateRef) || !DEVICE_REF_PATTERN.test(deviceRef)) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const parsed = await parseBoundedJsonObject(c);
		if (!parsed.ok) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const { attemptId, decision, expectedTargetIdentityRef } = parsed.value;
		if (
			typeof attemptId !== "string" ||
			!ATTEMPT_ID_PATTERN.test(attemptId) ||
			!(["included", "excluded", "removed"] as unknown[]).includes(decision) ||
			(decision === "included"
				? !hasExactKeys(parsed.value, ["attemptId", "decision", "expectedTargetIdentityRef"]) ||
					typeof expectedTargetIdentityRef !== "string" ||
					!IDENTITY_REF_PATTERN.test(expectedTargetIdentityRef)
				: !hasExactKeys(parsed.value, ["attemptId", "decision"]))
		) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		try {
			const store = options.getStore();
			const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			if (!draft) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			if (draft.state !== "completed" && hasCompletedLegacyTeamSetup(store, candidateRef)) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (draft.attemptId !== attemptId) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (draft.state === "completed") {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			const device = draft.devices.find((item) => item.deviceRef === deviceRef);
			if (!device) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			}
			if (
				decision === "included" &&
				(device.targetIdentityId === null ||
					requiredIdentityRef(candidateRef, device.targetIdentityId) !== expectedTargetIdentityRef)
			) {
				return c.json({ error: "team_setup_assignment_changed" as const }, 409);
			}
			const releaseMutation = claimCandidateMutation(store.db, candidateRef);
			if (!releaseMutation) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			try {
				return c.json(
					projectMutationAtomically(
						store,
						() =>
							setLegacyTeamSetupDeviceDecision(store.db, {
								attemptId,
								deviceRef,
								decision: decision as "included" | "excluded" | "removed",
							}),
						(draft) => detailResponse(store, draft),
					),
				);
			} finally {
				releaseMutation();
			}
		} catch (error) {
			const failure = teamSetupFailure(error, `${c.req.method} ${c.req.routePath}`);
			return c.json({ error: failure.code }, failure.status);
		}
	});

	app.delete("/api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/decision", async (c) => {
		const candidateRef = c.req.param("candidateRef");
		const deviceRef = c.req.param("deviceRef");
		if (!CANDIDATE_REF_PATTERN.test(candidateRef) || !DEVICE_REF_PATTERN.test(deviceRef)) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const parsed = await parseBoundedJsonObject(c);
		if (!parsed.ok || !hasExactKeys(parsed.value, ["attemptId"])) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const { attemptId } = parsed.value;
		if (typeof attemptId !== "string" || !ATTEMPT_ID_PATTERN.test(attemptId)) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		try {
			const store = options.getStore();
			const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			if (!draft) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			if (draft.state !== "completed" && hasCompletedLegacyTeamSetup(store, candidateRef)) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (draft.attemptId !== attemptId) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (draft.state === "completed") {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (!draft.devices.some((item) => item.deviceRef === deviceRef)) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			}
			const releaseMutation = claimCandidateMutation(store.db, candidateRef);
			if (!releaseMutation) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			try {
				return c.json(
					projectMutationAtomically(
						store,
						() => clearLegacyTeamSetupDeviceDecision(store.db, { attemptId, deviceRef }),
						(draft) => detailResponse(store, draft),
					),
				);
			} finally {
				releaseMutation();
			}
		} catch (error) {
			const failure = teamSetupFailure(error, `${c.req.method} ${c.req.routePath}`);
			return c.json({ error: failure.code }, failure.status);
		}
	});

	app.put("/api/sync/team-setup/v1/:candidateRef/projects/:projectRef/mapping", async (c) => {
		const candidateRef = c.req.param("candidateRef");
		const projectRef = c.req.param("projectRef");
		if (!CANDIDATE_REF_PATTERN.test(candidateRef) || !PROJECT_REF_PATTERN.test(projectRef)) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const parsed = await parseBoundedJsonObject(c);
		if (!parsed.ok || !hasExactKeys(parsed.value, ["attemptId", "resolvedProjectRef"])) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const { attemptId, resolvedProjectRef } = parsed.value;
		if (
			typeof attemptId !== "string" ||
			!ATTEMPT_ID_PATTERN.test(attemptId) ||
			typeof resolvedProjectRef !== "string" ||
			!RESOLVED_PROJECT_REF_PATTERN.test(resolvedProjectRef)
		) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		try {
			const store = options.getStore();
			const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			if (!draft) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			if (draft.state !== "completed" && hasCompletedLegacyTeamSetup(store, candidateRef)) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (draft.attemptId !== attemptId) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (draft.state === "completed") {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			const project = draft.projects.find((item) => item.projectRef === projectRef);
			if (!project) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			}
			if (project.resolution === "deterministic") {
				return c.json({ error: "team_setup_incomplete" as const }, 400);
			}
			const target = projectMappingChoices(store).find(
				(choice) =>
					legacyTeamResolvedProjectRef(projectRef, choice.projectIdentity) === resolvedProjectRef,
			);
			if (!target) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			const releaseMutation = claimCandidateMutation(store.db, candidateRef);
			if (!releaseMutation) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			try {
				return c.json(
					projectMutationAtomically(
						store,
						() =>
							setLegacyTeamSetupProjectMapping(store.db, {
								attemptId,
								projectRef,
								resolvedProjectIdentity: target.projectIdentity,
							}),
						(draft) => detailResponse(store, draft),
					),
				);
			} finally {
				releaseMutation();
			}
		} catch (error) {
			const failure = teamSetupFailure(error, `${c.req.method} ${c.req.routePath}`);
			return c.json({ error: failure.code }, failure.status);
		}
	});

	app.post("/api/sync/team-setup/v1/:candidateRef/refresh", async (c) => {
		const candidateRef = c.req.param("candidateRef");
		if (!CANDIDATE_REF_PATTERN.test(candidateRef)) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const parsed = await parseBoundedJsonObject(c);
		if (!parsed.ok || !hasExactKeys(parsed.value, [])) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		let store: MemoryStore;
		try {
			store = options.getStore();
			const currentDraft = getLegacyTeamSetupDraft(store.db, candidateRef);
			if (currentDraft?.state === "completed" || hasCompletedLegacyTeamSetup(store, candidateRef)) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
		} catch (error) {
			const failure = teamSetupFailure(error, `${c.req.method} ${c.req.routePath}`);
			return c.json({ error: failure.code }, failure.status);
		}
		let groups: LegacyTeamConfiguredGroupSnapshot[];
		try {
			groups = await loadMutableCandidateSnapshots(store, candidateRef, () =>
				loadedCandidateSnapshots(candidateRef),
			);
		} catch (error) {
			const failure = teamSetupFailure(error, `${c.req.method} ${c.req.routePath}`);
			return c.json({ error: failure.code }, failure.status);
		}
		if (
			groups.filter(
				(group) => legacyTeamCandidateId(group.coordinatorId, group.groupId) === candidateRef,
			).length === 0
		) {
			return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
		}
		try {
			const releaseMutation = claimCandidateMutation(store.db, candidateRef);
			if (!releaseMutation) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			try {
				return c.json(
					projectMutationAtomically(
						store,
						() => {
							const currentDraft = getLegacyTeamSetupDraft(store.db, candidateRef);
							if (
								currentDraft?.state === "completed" ||
								hasCompletedLegacyTeamSetup(store, candidateRef)
							) {
								throw new Error("team_setup_confirmation_stale");
							}
							return refreshLegacyTeamCandidate(
								store.db,
								{ projection: projectionOptions(store), groups },
								candidateRef,
							);
						},
						(draft) => detailResponse(store, draft),
					),
				);
			} finally {
				releaseMutation();
			}
		} catch (error) {
			const failure = teamSetupFailure(error, `${c.req.method} ${c.req.routePath}`);
			return c.json({ error: failure.code }, failure.status);
		}
	});

	app.post("/api/sync/team-setup/v1/:candidateRef/finish", async (c) => {
		const candidateRef = c.req.param("candidateRef");
		if (!CANDIDATE_REF_PATTERN.test(candidateRef)) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const parsed = await parseBoundedJsonObject(c);
		if (!parsed.ok) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const finishKeys = [
			"attemptId",
			"confirmedAccessDeltaDigest",
			"confirmedViewerAccessDeltaDigest",
			"finishDigest",
		] as const;
		if (!hasExactKeys(parsed.value, finishKeys)) {
			return Object.keys(parsed.value).every((key) =>
				finishKeys.includes(key as (typeof finishKeys)[number]),
			)
				? c.json({ error: "team_setup_confirmation_stale" as const }, 409)
				: c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const {
			attemptId,
			confirmedAccessDeltaDigest,
			confirmedViewerAccessDeltaDigest,
			finishDigest,
		} = parsed.value;
		if (
			typeof attemptId !== "string" ||
			!ATTEMPT_ID_PATTERN.test(attemptId) ||
			typeof finishDigest !== "string" ||
			!FINISH_DIGEST_PATTERN.test(finishDigest) ||
			typeof confirmedAccessDeltaDigest !== "string" ||
			!ACCESS_DELTA_DIGEST_PATTERN.test(confirmedAccessDeltaDigest) ||
			typeof confirmedViewerAccessDeltaDigest !== "string" ||
			!VIEWER_ACCESS_DELTA_DIGEST_PATTERN.test(confirmedViewerAccessDeltaDigest)
		) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		let releaseMutation: (() => void) | undefined;
		let releasePublicationMutation: (() => void) | undefined;
		let releaseActorMutations: (() => void) | undefined;
		let finishLogRedactValues: readonly string[] = [];
		try {
			const store = options.getStore();
			const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			if (!draft) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			if (draft.state !== "completed" && hasCompletedLegacyTeamSetup(store, candidateRef)) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (draft.attemptId !== attemptId) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			const replay = replayLegacyTeamSetupActivation(store.db, {
				candidateRef,
				attemptId,
				finishDigest,
				confirmedAccessDeltaDigest,
			});
			if (replay) return c.json(finishResponse(candidateRef, replay));
			if (draft.state === "completed") {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			const preview = previewLegacyTeamSetupActivation(store.db, {
				candidateRef,
				attemptId: draft.attemptId,
			});
			requireLegacyTeamSetupAccessDeltaWithinLimit(preview.accessDelta);
			const safeDraft = viewerSafeDraft(store, draft);
			const currentViewerDigest = viewerAccessDeltaDigest(
				viewerSafeAccessDelta(candidateRef, preview.accessDelta, {
					teamDisplayName: draft.displayName,
					...safeDraft,
				}),
			);
			if (currentViewerDigest !== confirmedViewerAccessDeltaDigest) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			const freshGroups = await loadedCandidateSnapshots(candidateRef);
			const matchingGroups = freshGroups.filter(
				(group) => legacyTeamCandidateId(group.coordinatorId, group.groupId) === candidateRef,
			);
			if (matchingGroups.length !== 1) throw safeCoordinatorError();
			const group = matchingGroups[0];
			if (!group) throw safeCoordinatorError();
			releaseMutation = claimCandidateMutation(store.db, candidateRef) ?? undefined;
			if (!releaseMutation) {
				// An identical request may be committing right now. Wait for it and
				// return its immutable result instead of a stale-confirmation error.
				await candidateMutationSettled(store.db, candidateRef);
				const overlappingReplay = replayLegacyTeamSetupActivation(store.db, {
					candidateRef,
					attemptId,
					finishDigest,
					confirmedAccessDeltaDigest,
				});
				if (overlappingReplay) return c.json(finishResponse(candidateRef, overlappingReplay));
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			// The pre-claim replay lookup raced an in-flight commit; recheck under the claim.
			const claimedReplay = replayLegacyTeamSetupActivation(store.db, {
				candidateRef,
				attemptId,
				finishDigest,
				confirmedAccessDeltaDigest,
			});
			if (claimedReplay) return c.json(finishResponse(candidateRef, claimedReplay));
			const claimedDraft = getLegacyTeamSetupDraft(store.db, candidateRef);
			if (!claimedDraft || claimedDraft.attemptId !== attemptId) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			const publicationDeadlineMs = Date.now() + COORDINATOR_ROSTER_READ_BUDGET_MS;
			releasePublicationMutation = await claimRecipientPolicyPublicationMutation(store.db);
			// Every identity the activation reads or writes is part of the immutable
			// publication winner: the target of each included device and the existing
			// assignment of every reviewed device (including excluded or removed ones,
			// whose current assignment the access delta depends on). These locks cover
			// coordinator creation, conflict recovery, and local application.
			const claimedActorIds = finishDraftActorIds(claimedDraft);
			releaseActorMutations = await claimRecipientPolicyActorMutations(store.db, claimedActorIds);
			const response = await serializeRecipientPolicyTeamMutation(
				store.db,
				deterministicPolicyTeamId(candidateRef),
				() =>
					serializeRecipientPolicyCoordinatorGroupMutation(store.db, group.groupId, async () => {
						let authorization: CompletionAuthorization | null;
						try {
							authorization = currentCompletionAuthorization();
						} catch (error) {
							throw new Error(completionApiError(error), { cause: error });
						}
						if (!completionDependencies || !authorization) {
							throw new Error("team_setup_completion_unavailable");
						}
						if (!authorizesGroup(authorization, group)) {
							throw new Error("team_setup_completion_invalid");
						}
						const { config, remoteUrl } = authorization;
						finishLogRedactValues = [config.syncCoordinatorAdminSecret];
						const freshGroup = await loadFreshGroupSnapshot(
							group,
							remoteUrl,
							publicationDeadlineMs,
						);
						if (!freshGroup) {
							throw new TeamSetupFinishError(
								"team_setup_roster_unavailable",
								"coordinator_roster_unavailable",
								false,
								new Error("coordinator roster unavailable"),
							);
						}
						if (!stillAuthorizesGroup(authorization, group)) {
							throw new Error("team_setup_completion_invalid");
						}
						const projectInventory = legacyTeamCandidateProjectInventory(
							store.db,
							projectionOptions(store),
							candidateRef,
						);
						const freshPreview = inspectFreshLegacyTeamSetupActivation(store.db, {
							candidateRef,
							attemptId,
							freshRoster: freshGroup.devices,
							projectInventory,
						});
						if (
							freshPreview.finishDigest !== finishDigest ||
							freshPreview.accessDeltaDigest !== confirmedAccessDeltaDigest
						) {
							return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
						}
						const freshDraft = getLegacyTeamSetupDraft(store.db, candidateRef);
						if (!freshDraft || freshDraft.attemptId !== attemptId) {
							return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
						}
						const safeFreshDraft = viewerSafeDraft(store, freshDraft);
						if (
							viewerAccessDeltaDigest(
								viewerSafeAccessDelta(candidateRef, freshPreview.accessDelta, {
									teamDisplayName: freshDraft.displayName,
									...safeFreshDraft,
								}),
							) !== confirmedViewerAccessDeltaDigest
						) {
							return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
						}
						const completedAt = new Date().toISOString();
						const proposedManifest = deriveLegacyTeamSetupCompletionManifest(store.db, {
							candidateRef,
							attemptId,
							completedAt,
						});
						const timeoutS = Math.max(1, config.syncCoordinatorTimeoutS);
						const publicationTimeoutS = remainingCoordinatorTimeoutS(
							timeoutS,
							publicationDeadlineMs,
						);
						if (publicationTimeoutS == null) {
							throw new Error("team_setup_completion_unavailable");
						}
						let canonicalManifest: typeof proposedManifest;
						try {
							canonicalManifest = validateLegacyTeamSetupCompletionManifest(
								(
									await completionDependencies.create({
										groupId: group.groupId,
										manifest: proposedManifest,
										remoteUrl,
										adminSecret: config.syncCoordinatorAdminSecret,
										timeoutS: publicationTimeoutS,
									})
								).manifest,
								{ coordinatorId: group.coordinatorId, groupId: group.groupId },
							);
							if (
								canonicalCoordinatorLegacyTeamCompletionManifestJson(canonicalManifest) !==
								canonicalCoordinatorLegacyTeamCompletionManifestJson(proposedManifest)
							) {
								throw new Error("team_setup_completion_conflict");
							}
						} catch (error) {
							const code = completionApiError(error);
							const details = teamSetupFinishFailureDetails(error);
							const getCompletion = completionDependencies.get;
							if (code !== "team_setup_completion_conflict" || !getCompletion) {
								warnTeamSetupFinishFailure(error, details, {
									candidateRef,
									attemptId,
									apiCode: code,
									redactValues: finishLogRedactValues,
								});
								throw new TeamSetupFinishError(code, details.reason, true, error);
							}
							try {
								const existing = await retryTransientCoordinatorRead(
									(attemptTimeoutS) =>
										getCompletion({
											groupId: group.groupId,
											candidateRef,
											remoteUrl,
											adminSecret: config.syncCoordinatorAdminSecret,
											timeoutS: attemptTimeoutS,
										}),
									timeoutS,
									publicationDeadlineMs,
								);
								if (!existing) throw new Error("team_setup_completion_conflict");
								canonicalManifest = validateLegacyTeamSetupCompletionManifest(existing, {
									coordinatorId: group.coordinatorId,
									groupId: group.groupId,
								});
								// A conflict can mean an earlier request committed before its response was lost.
								// The matching policy digest identifies that winner; its publication timestamp
								// is coordinator-owned metadata and must be applied unchanged.
								if (canonicalManifest.finish_digest !== proposedManifest.finish_digest) {
									throw new Error("team_setup_completion_conflict");
								}
							} catch (recoveryError) {
								throw new TeamSetupFinishError(
									completionApiError(recoveryError),
									teamSetupFinishFailureDetails(recoveryError).reason,
									false,
									recoveryError,
								);
							}
						}
						// Publication is the commit point. Apply its immutable winner after binding
						// each included device to the current coordinator roster evidence.
						// If this reload fails, reconciliation can apply the published winner later.
						let postPublicationGroup: LegacyTeamConfiguredGroupSnapshot | undefined;
						try {
							postPublicationGroup = await loadFreshGroupSnapshot(
								group,
								remoteUrl,
								publicationDeadlineMs,
							);
						} catch (error) {
							if (legacyTeamSetupApiErrorCode(error) === "team_setup_completion_invalid") {
								throw new TeamSetupFinishError(
									"team_setup_roster_unavailable",
									"coordinator_roster_unavailable",
									false,
									error,
								);
							}
							throw error;
						}
						if (!postPublicationGroup) {
							throw new TeamSetupFinishError(
								"team_setup_roster_unavailable",
								"coordinator_roster_unavailable",
								false,
								new Error("coordinator roster unavailable"),
							);
						}
						const result = await applyFinishWinnerAfterRemovals(
							{ store, dependencies: completionDependencies, config },
							{
								coordinatorId: group.coordinatorId,
								groupId: group.groupId,
								freshRoster: postPublicationGroup.devices,
								manifest: canonicalManifest,
								expectedDraftManifest: proposedManifest,
								recipientPolicyLocksHeld: completionRecipientPolicyLocksHeld(claimedActorIds),
							},
						);
						return c.json(finishResponse(candidateRef, result));
					}),
			);
			return response;
		} catch (error) {
			const code = apiErrorCode(error);
			const details = teamSetupFinishFailureDetails(error);
			warnTeamSetupFinishFailure(error, details, {
				candidateRef,
				attemptId,
				apiCode: code,
				redactValues: finishLogRedactValues,
			});
			return c.json(finishErrorResponse(code, details), errorStatus(code));
		} finally {
			releaseActorMutations?.();
			releasePublicationMutation?.();
			releaseMutation?.();
		}
	});

	return app;
}
