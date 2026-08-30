import type {
	LegacyTeamCandidateView,
	LegacyTeamConfiguredGroupSnapshot,
	LegacyTeamSetupAccessDeltaV1,
	LegacyTeamSetupActivationErrorCode,
	LegacyTeamSetupActivationResultV1,
	LegacyTeamSetupDraftView,
	MemoryStore,
} from "@codemem/core";
import {
	buildBaseUrl,
	clearLegacyTeamSetupDeviceDecision,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	discoverLegacyTeamCandidates,
	fingerprintPublicKey,
	finishLegacyTeamSetupActivation,
	getLegacyTeamSetupDraft,
	inspectLegacyTeamSetupActivation,
	isLegacyTeamCandidateSelectable,
	isLegacyTeamSetupProjectMappingIdentity,
	legacyTeamCandidateId,
	legacyTeamCandidateProjectInventory,
	legacyTeamCanonicalProjectRef,
	legacyTeamDeviceRef,
	legacyTeamResolvedProjectRef,
	legacyTeamSetupApiErrorCode,
	listProjectScopeCandidates,
	previewLegacyTeamSetupActivation,
	readCoordinatorSyncConfig,
	recipientPolicyDigest,
	refreshLegacyTeamCandidate,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
	setLegacyTeamSetupProjectMapping,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import {
	type LegacyTeamSetupCandidateSummaryV1,
	type LegacyTeamSetupDetailResponseV1,
	type LegacyTeamSetupDeviceV1,
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
const MAX_ACCESS_DELTA_ENTRIES = 10_000;
const MAX_IDENTITY_CHOICES = 500;
const MAX_COMPLETED_IDENTITY_CHOICES = MAX_DEVICES * 4;
const MAX_PROJECT_MAPPING_CHOICES = 500;
const MAX_TOTAL_PROJECT_MAPPING_CHOICES = 10_000;
const MAX_PROJECT_MAPPING_SCAN_ROWS = 10_000;
const MAX_PROJECT_MAPPING_METADATA_ROWS = 10_000;
const MAX_MUTATION_BODY_BYTES = 8_192;
const SUMMARY_SNAPSHOT_CACHE_TTL_MS = 30_000;
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

interface LegacyTeamConfiguredGroupSnapshotLoadOptions {
	candidateRef?: string;
}

export interface LegacyTeamCandidateGroupDescriptor {
	groupId: string;
	coordinatorId: string;
}

export type LegacyTeamConfiguredGroupSnapshotLoader = (
	options?: LegacyTeamConfiguredGroupSnapshotLoadOptions,
) => Promise<LegacyTeamConfiguredGroupSnapshot[]>;

export interface TeamSetupRoutesOptions {
	getStore: () => MemoryStore;
	loadLegacyTeamConfiguredGroupSnapshots?: LegacyTeamConfiguredGroupSnapshotLoader;
	snapshotLoaderDependencies?: LegacyTeamSnapshotLoaderDependencies;
	registerSummaryInvalidator?: (invalidate: () => void) => void;
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

function isCoordinatorRosterTooLargeError(error: unknown): boolean {
	return error instanceof Error && error.message === "coordinator_response_too_large";
}

function configuredGroupIds(groups: string[]): string[] {
	const unique = [...new Set(groups.map((group) => group.trim()).filter(Boolean))];
	if (unique.length > MAX_CONFIGURED_GROUPS) throw safeCoordinatorError();
	return unique;
}

export function normalizedCoordinatorId(value: string): string | null {
	try {
		const normalized = buildBaseUrl(value);
		if (!normalized) return null;
		const parsed = new URL(normalized);
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			!parsed.host ||
			parsed.username ||
			parsed.password
		) {
			return null;
		}
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
	} catch {
		return null;
	}
}

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
	if (!hasUrl || !hasSecret) throw safeCoordinatorError();

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
		const requestedGroupDescriptors = options.candidateRef
			? groupDescriptors.filter(
					({ coordinatorId, groupId }) =>
						legacyTeamCandidateId(coordinatorId, groupId) === options.candidateRef,
				)
			: groupDescriptors;
		const groups = await dependencies.listGroups({
			remoteUrl,
			adminSecret: config.syncCoordinatorAdminSecret,
			includeArchived: false,
			timeoutS,
		});
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
					devices = await dependencies.listDevices({
						groupId,
						includeDisabled: true,
						remoteUrl,
						adminSecret: config.syncCoordinatorAdminSecret,
						timeoutS,
					});
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
		if (error instanceof Error && error.message === "legacy_team_setup_roster_too_large") {
			throw error;
		}
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
	return discoverLegacyTeamCandidates(store.db, {
		projection: projectionOptions(store),
		groups,
	});
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

function requireBoundedAccessDelta(delta: LegacyTeamSetupAccessDeltaV1): void {
	const total =
		delta.teamChanges.length +
		delta.membershipChanges.length +
		delta.projectChanges.length +
		delta.recipientChanges.length +
		delta.deviceAccessChanges.length;
	if (
		delta.teamChanges.length > MAX_ACCESS_DELTA_ENTRIES ||
		delta.membershipChanges.length > MAX_ACCESS_DELTA_ENTRIES ||
		delta.projectChanges.length > MAX_ACCESS_DELTA_ENTRIES ||
		delta.recipientChanges.length > MAX_ACCESS_DELTA_ENTRIES ||
		delta.deviceAccessChanges.length > MAX_ACCESS_DELTA_ENTRIES ||
		total > MAX_ACCESS_DELTA_ENTRIES
	) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
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
): (() => Promise<LegacyTeamConfiguredGroupSnapshot[]>) & { invalidate: () => void } {
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
	return store.db.transaction(() => project(mutate())).immediate();
}

export const __teamSetupTestHooks = {
	createCachedSnapshotLoader,
	loadConfiguredLegacyTeamGroupSnapshotsWith,
	normalizedCoordinatorId,
	projectMutationAtomically,
	requireCompleteMappingChoices,
	disambiguateChoiceLabels,
	safeChoiceLabel,
	viewerSafeAccessDelta,
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
				isLegacyTeamSetupProjectMappingIdentity(candidate.workspace_identity),
		);
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "project_scope_candidate_scan_too_large" ||
				error.message === "project_scope_candidate_metadata_too_large")
		) {
			throw new Error("legacy_team_setup_roster_too_large");
		}
		throw error;
	}
	if (candidates.length > MAX_PROJECT_MAPPING_CHOICES) {
		throw new Error("legacy_team_setup_roster_too_large");
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
		devices: draft.devices.map((device) => ({
			deviceRef: device.deviceRef,
			displayName: device.displayName,
			enabled: device.enabled,
			existingIdentityRef: identityRef(draft.candidateRef, device.existingIdentityId),
			suggestedIdentityRef: identityRef(draft.candidateRef, device.suggestedIdentityId),
			verifiedEvidenceKind: device.verifiedEvidenceKind,
			decision: device.decision,
			targetIdentityRef: identityRef(draft.candidateRef, device.targetIdentityId),
			expectation:
				device.expectation.kind === "existing"
					? {
							kind: "existing" as const,
							assignmentVersion: device.expectation.assignmentVersion,
							identityRef: requiredIdentityRef(draft.candidateRef, device.expectation.identityId),
						}
					: { kind: "absent" as const },
		})),
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

function errorStatus(code: LegacyTeamSetupActivationErrorCode): 400 | 409 | 503 {
	if (code === "team_setup_roster_unavailable") return 503;
	if (code === "team_setup_failed") return 503;
	if (code === "team_setup_incomplete") return 400;
	return 409;
}

function apiErrorCode(error: unknown): LegacyTeamSetupActivationErrorCode {
	const code = legacyTeamSetupApiErrorCode(error);
	return code === "team_setup_projection_changed" ? "team_setup_conflict" : code;
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

function detailResponse(
	store: MemoryStore,
	draft: LegacyTeamSetupDraftView,
	candidate: LegacyTeamCandidateView = candidateFromDraft(draft),
): LegacyTeamSetupDetailResponseV1 {
	let unavailableReason: LegacyTeamSetupUnavailableReasonV1 | null = null;
	let preview: ReturnType<typeof inspectLegacyTeamSetupActivation> | null = null;
	if (draft.state !== "completed") {
		try {
			preview = inspectLegacyTeamSetupActivation(store.db, {
				candidateRef: draft.candidateRef,
				attemptId: draft.attemptId,
			});
		} catch (error) {
			const code = apiErrorCode(error);
			if (code === "team_setup_failed") throw error;
			if (code === "team_setup_projection_changed") unavailableReason = "team_setup_conflict";
			else if (code !== "team_setup_incomplete") unavailableReason = code;
		}
	}
	if (preview) requireBoundedAccessDelta(preview.accessDelta);
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
	): Promise<LegacyTeamConfiguredGroupSnapshot[]> {
		try {
			return await loadSnapshots(candidateRef ? { candidateRef } : undefined);
		} catch (error) {
			if (error instanceof Error && error.message === "legacy_team_setup_roster_too_large") {
				throw error;
			}
			throw safeCoordinatorError();
		}
	}
	const loadedSummarySnapshots = createCachedSnapshotLoader(
		() => loadedSnapshots(),
		SUMMARY_SNAPSHOT_CACHE_TTL_MS,
	);
	options.registerSummaryInvalidator?.(() => loadedSummarySnapshots.invalidate());
	async function loadedCandidateSnapshots(
		candidateRef: string,
	): Promise<LegacyTeamConfiguredGroupSnapshot[]> {
		loadedSummarySnapshots.invalidate();
		try {
			return await loadedSnapshots(candidateRef);
		} finally {
			loadedSummarySnapshots.invalidate();
		}
	}

	app.get("/api/sync/team-setup/v1", async (c) => {
		let groups: LegacyTeamConfiguredGroupSnapshot[];
		try {
			groups = await loadedSummarySnapshots();
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
		}
		try {
			const response = {
				version: TEAM_SETUP_VERSION,
				candidates: discoverCandidates(options.getStore(), groups)
					.map(candidateSummary)
					.filter(
						(candidate): candidate is LegacyTeamSetupPendingCandidateSummaryV1 =>
							candidate.status !== "ready",
					),
			} satisfies LegacyTeamSetupSummaryResponseV1;
			return c.json(response);
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
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
			let candidate: LegacyTeamCandidateView;
			if (
				draft?.state === "completed" &&
				isLegacyTeamCandidateSelectable(store.db, candidateRef, {
					projects: legacyTeamCandidateProjectInventory(
						store.db,
						projectionOptions(store),
						candidateRef,
					),
				})
			) {
				candidate = candidateFromDraft(draft);
			} else {
				const groups = await loadedCandidateSnapshots(candidateRef);
				const candidateGroups = groups.filter(
					(group) => legacyTeamCandidateId(group.coordinatorId, group.groupId) === candidateRef,
				);
				const discoveredCandidate = discoverCandidates(store, candidateGroups).find(
					(item) => item.candidateRef === candidateRef,
				);
				if (!discoveredCandidate) {
					return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
				}
				candidate = discoveredCandidate;
				draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			}
			if (!draft) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);

			return c.json(detailResponse(store, draft, candidate));
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
		}
	});

	app.put("/api/sync/team-setup/v1/:candidateRef/devices/:deviceRef/assignment", async (c) => {
		const candidateRef = c.req.param("candidateRef");
		const deviceRef = c.req.param("deviceRef");
		if (!CANDIDATE_REF_PATTERN.test(candidateRef) || !DEVICE_REF_PATTERN.test(deviceRef)) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const parsed = await parseBoundedJsonObject(c);
		if (
			!parsed.ok ||
			!hasExactKeys(parsed.value, ["attemptId", "expectation", "targetIdentityRef"])
		) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		const { attemptId, expectation, targetIdentityRef } = parsed.value;
		if (
			typeof attemptId !== "string" ||
			!ATTEMPT_ID_PATTERN.test(attemptId) ||
			typeof targetIdentityRef !== "string" ||
			!IDENTITY_REF_PATTERN.test(targetIdentityRef) ||
			!expectation ||
			typeof expectation !== "object" ||
			Array.isArray(expectation)
		) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}
		try {
			const store = options.getStore();
			const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			if (!draft) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			if (draft.attemptId !== attemptId) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (draft.state === "completed") {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			const device = draft.devices.find((item) => item.deviceRef === deviceRef);
			if (!device) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			const submittedExpectation = expectation as Record<string, unknown>;
			const expectationMatches =
				device.expectation.kind === "absent"
					? hasExactKeys(submittedExpectation, ["kind"]) && submittedExpectation.kind === "absent"
					: hasExactKeys(submittedExpectation, ["assignmentVersion", "identityRef", "kind"]) &&
						submittedExpectation.kind === "existing" &&
						submittedExpectation.assignmentVersion === device.expectation.assignmentVersion &&
						submittedExpectation.identityRef ===
							requiredIdentityRef(candidateRef, device.expectation.identityId);
			if (!expectationMatches) {
				return c.json({ error: "team_setup_assignment_changed" as const }, 409);
			}
			const target = identityChoices(store, candidateRef).find(
				(choice) => choice.identityRef === targetIdentityRef,
			);
			if (!target) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			return c.json(
				projectMutationAtomically(
					store,
					() =>
						setLegacyTeamSetupDeviceAssignment(store.db, {
							attemptId,
							deviceRef,
							targetIdentityId: target.identityId,
							expectation: device.expectation,
						}),
					(draft) => detailResponse(store, draft),
				),
			);
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
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
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
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
			if (draft.attemptId !== attemptId) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (draft.state === "completed") {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (!draft.devices.some((item) => item.deviceRef === deviceRef)) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			}
			return c.json(
				projectMutationAtomically(
					store,
					() => clearLegacyTeamSetupDeviceDecision(store.db, { attemptId, deviceRef }),
					(draft) => detailResponse(store, draft),
				),
			);
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
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
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
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
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
		}
		let groups: LegacyTeamConfiguredGroupSnapshot[];
		try {
			groups = await loadMutableCandidateSnapshots(store, candidateRef, () =>
				loadedCandidateSnapshots(candidateRef),
			);
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
		}
		if (
			groups.filter(
				(group) => legacyTeamCandidateId(group.coordinatorId, group.groupId) === candidateRef,
			).length === 0
		) {
			return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
		}
		try {
			return c.json(
				projectMutationAtomically(
					store,
					() => {
						if (getLegacyTeamSetupDraft(store.db, candidateRef)?.state === "completed") {
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
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
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
		try {
			const store = options.getStore();
			const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			if (!draft) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			if (draft.attemptId !== attemptId) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 409);
			}
			if (draft.state !== "completed") {
				const preview = previewLegacyTeamSetupActivation(store.db, {
					candidateRef,
					attemptId: draft.attemptId,
				});
				requireBoundedAccessDelta(preview.accessDelta);
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
			}
			const result = await finishLegacyTeamSetupActivation(store.db, {
				candidateRef,
				attemptId,
				finishDigest,
				confirmedAccessDeltaDigest,
				loadFreshRoster: async () => {
					const groups = await loadedCandidateSnapshots(candidateRef);
					const matching = groups.filter(
						(group) => legacyTeamCandidateId(group.coordinatorId, group.groupId) === candidateRef,
					);
					if (matching.length !== 1) throw safeCoordinatorError();
					return matching[0]?.devices ?? [];
				},
				loadProjectInventory: () =>
					legacyTeamCandidateProjectInventory(store.db, projectionOptions(store), candidateRef),
				validateLockedPreview: (lockedPreview) => {
					requireBoundedAccessDelta(lockedPreview.accessDelta);
					const lockedDraft = getLegacyTeamSetupDraft(store.db, candidateRef);
					if (!lockedDraft || lockedDraft.attemptId !== attemptId) return false;
					const safeDraft = viewerSafeDraft(store, lockedDraft);
					return (
						viewerAccessDeltaDigest(
							viewerSafeAccessDelta(candidateRef, lockedPreview.accessDelta, {
								teamDisplayName: lockedDraft.displayName,
								...safeDraft,
							}),
						) === confirmedViewerAccessDeltaDigest
					);
				},
			});
			return c.json(finishResponse(candidateRef, result));
		} catch (error) {
			const code = apiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
		}
	});

	return app;
}
