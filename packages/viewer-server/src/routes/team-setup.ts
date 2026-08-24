import type {
	LegacyTeamCandidateView,
	LegacyTeamConfiguredGroupSnapshot,
	LegacyTeamSetupAccessDeltaV1,
	LegacyTeamSetupActivationErrorCode,
	LegacyTeamSetupDraftView,
	MemoryStore,
} from "@codemem/core";
import {
	buildBaseUrl,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	discoverLegacyTeamCandidates,
	fingerprintPublicKey,
	getLegacyTeamSetupDraft,
	legacyTeamCandidateId,
	legacyTeamCanonicalProjectRef,
	legacyTeamDeviceRef,
	legacyTeamResolvedProjectRef,
	legacyTeamSetupApiErrorCode,
	previewLegacyTeamSetupActivation,
	readCoordinatorSyncConfig,
	recipientPolicyDigest,
} from "@codemem/core";
import { Hono } from "hono";

const TEAM_SETUP_VERSION = 1 as const;
const MAX_CONFIGURED_GROUPS = 25;
const MAX_DEVICES = 500;
const MAX_PROJECTS = 500;
const MAX_ACCESS_DELTA_ENTRIES = 10_000;
export const TEAM_SETUP_ROUTE_PREFIX = "/api/sync/team-setup/v1";
const CANDIDATE_REF_PATTERN = /^legacy-team-candidate:[0-9a-f]{32}$/u;

export type LegacyTeamConfiguredGroupSnapshotLoader = () => Promise<
	LegacyTeamConfiguredGroupSnapshot[]
>;

export interface LegacyTeamSetupCandidateSummaryV1 {
	candidateRef: string;
	displayName: string;
	status: "needs_setup" | "in_progress" | "stale" | "ready";
	deviceCount: number;
	projectCount: number;
	unresolvedDeviceCount: number;
	unresolvedProjectCount: number;
}

export interface LegacyTeamSetupSummaryResponseV1 {
	version: 1;
	candidates: LegacyTeamSetupCandidateSummaryV1[];
}

export interface LegacyTeamSetupDeviceV1 {
	deviceRef: string;
	displayName: string;
	enabled: boolean;
	existingIdentityRef: string | null;
	suggestedIdentityRef: string | null;
	verifiedEvidenceKind: "active_assignment" | null;
	decision: "unresolved" | "included" | "excluded" | "removed";
	targetIdentityRef: string | null;
	expectation:
		| { kind: "absent" }
		| { kind: "existing"; assignmentVersion: number; identityRef: string };
}

export interface LegacyTeamSetupProjectV1 {
	projectRef: string;
	displayName: string;
	resolution: "unresolved" | "deterministic" | "explicit";
	canonicalProjectRef: string | null;
	resolvedProjectRef: string | null;
}

export interface LegacyTeamSetupViewerAccessDeltaV1 {
	teamChanges: Array<{
		teamRef: string;
		change: "add" | "update" | "remove";
		fromDeviceEligibilityMode: "person_all_devices" | "reviewed_allowlist" | null;
		toDeviceEligibilityMode: "reviewed_allowlist";
	}>;
	membershipChanges: Array<{
		teamRef: string;
		identityRef: string;
		change: "add" | "update" | "remove";
	}>;
	projectChanges: Array<{
		projectRef: string;
		fromResolvedProjectRef: string | null;
		toResolvedProjectRef: string | null;
		change: "add" | "update" | "remove";
	}>;
	recipientChanges: Array<{
		canonicalProjectRef: string;
		recipientKind: "team";
		recipientRef: string;
		change: "add" | "update" | "remove";
	}>;
	deviceAccessChanges: Array<{
		canonicalProjectRef: string;
		deviceRef: string;
		change: "add" | "remove";
	}>;
}

interface LegacyTeamSetupDetailBaseV1 {
	version: 1;
	candidate: LegacyTeamSetupCandidateSummaryV1;
	attemptId: string;
	draftState: "needs_setup" | "in_progress" | "stale" | "completed";
	unresolvedDeviceCount: number;
	unresolvedProjectCount: number;
	devices: LegacyTeamSetupDeviceV1[];
	projects: LegacyTeamSetupProjectV1[];
}

export type LegacyTeamSetupDetailResponseV1 = LegacyTeamSetupDetailBaseV1 &
	(
		| {
				canFinish: true;
				conflictState: null;
				finishDigest: string;
				accessDeltaDigest: string;
				accessDelta: LegacyTeamSetupViewerAccessDeltaV1;
		  }
		| {
				canFinish: false;
				conflictState: LegacyTeamSetupActivationErrorCode | null;
		  }
	);

export interface LegacyTeamSetupErrorResponseV1 {
	error: LegacyTeamSetupActivationErrorCode;
}

interface TeamSetupRoutesOptions {
	getStore: () => MemoryStore;
	loadLegacyTeamConfiguredGroupSnapshots?: LegacyTeamConfiguredGroupSnapshotLoader;
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

async function loadConfiguredLegacyTeamGroupSnapshotsWith(
	dependencies: LegacyTeamSnapshotLoaderDependencies,
): Promise<LegacyTeamConfiguredGroupSnapshot[]> {
	let config: ReturnType<typeof readCoordinatorSyncConfig>;
	try {
		config = dependencies.readConfig();
	} catch {
		throw safeCoordinatorError();
	}
	const groupIds = configuredGroupIds(config.syncCoordinatorGroups);
	const hasUrl = Boolean(config.syncCoordinatorUrl);
	const hasSecret = Boolean(config.syncCoordinatorAdminSecret);
	if (!hasUrl && !hasSecret && groupIds.length === 0) return [];
	if (!hasUrl || !hasSecret || groupIds.length === 0) throw safeCoordinatorError();

	try {
		const remoteUrl = buildBaseUrl(config.syncCoordinatorUrl);
		const coordinatorId = remoteUrl;
		const timeoutS = Math.max(1, config.syncCoordinatorTimeoutS);
		const groups = await dependencies.listGroups({
			remoteUrl,
			adminSecret: config.syncCoordinatorAdminSecret,
			includeArchived: false,
			timeoutS,
		});
		const groupById = new Map(groups.map((group) => [group.group_id, group]));
		const snapshots = await Promise.all(
			groupIds.map(async (groupId) => {
				const group = groupById.get(groupId);
				if (
					!group ||
					group.group_id !== groupId ||
					(group.display_name !== null && typeof group.display_name !== "string") ||
					group.archived_at != null
				) {
					throw safeCoordinatorError();
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
					if (isCoordinatorRosterTooLargeError(error)) return null;
					throw error;
				}
				if (devices.length > MAX_DEVICES) return null;
				if (
					devices.some(
						(device) =>
							fingerprintPublicKey(device.public_key) !== device.fingerprint ||
							(device.enabled !== 0 && device.enabled !== 1),
					)
				) {
					throw safeCoordinatorError();
				}
				return {
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
				};
			}),
		);
		return snapshots.filter((snapshot) => snapshot !== null);
	} catch {
		throw safeCoordinatorError();
	}
}

export async function loadConfiguredLegacyTeamGroupSnapshots(): Promise<
	LegacyTeamConfiguredGroupSnapshot[]
> {
	return loadConfiguredLegacyTeamGroupSnapshotsWith(defaultSnapshotLoaderDependencies);
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
): LegacyTeamSetupViewerAccessDeltaV1 {
	return {
		teamChanges: delta.teamChanges.map((change) => ({
			teamRef: teamRef(candidateRef, change.teamId),
			change: change.change,
			fromDeviceEligibilityMode: change.fromDeviceEligibilityMode,
			toDeviceEligibilityMode: change.toDeviceEligibilityMode,
		})),
		membershipChanges: delta.membershipChanges.map((change) => ({
			teamRef: teamRef(candidateRef, change.teamId),
			identityRef: requiredIdentityRef(candidateRef, change.identityId),
			change: change.change,
		})),
		projectChanges: delta.projectChanges.map((change) => ({
			projectRef: change.projectRef,
			fromResolvedProjectRef: resolvedProjectRef(change.projectRef, change.fromProjectIdentity),
			toResolvedProjectRef: resolvedProjectRef(change.projectRef, change.toProjectIdentity),
			change: change.change,
		})),
		recipientChanges: delta.recipientChanges.map((change) => ({
			canonicalProjectRef: legacyTeamCanonicalProjectRef(
				candidateRef,
				change.canonicalProjectIdentity,
			),
			recipientKind: change.recipientKind,
			recipientRef: teamRef(candidateRef, change.recipientId),
			change: change.change,
		})),
		deviceAccessChanges: delta.deviceAccessChanges.map((change) => ({
			canonicalProjectRef: legacyTeamCanonicalProjectRef(
				candidateRef,
				change.canonicalProjectIdentity,
			),
			deviceRef: legacyTeamDeviceRef(candidateRef, change.deviceId),
			change: change.change,
		})),
	};
}

export const __teamSetupTestHooks = {
	loadConfiguredLegacyTeamGroupSnapshotsWith,
	viewerSafeAccessDelta,
};

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

function viewerSafeDraft(draft: LegacyTeamSetupDraftView): {
	devices: LegacyTeamSetupDeviceV1[];
	projects: LegacyTeamSetupProjectV1[];
} {
	if (draft.devices.length > MAX_DEVICES || draft.projects.length > MAX_PROJECTS) {
		throw new Error("legacy_team_setup_roster_too_large");
	}
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
		})),
	};
}

function errorStatus(code: LegacyTeamSetupActivationErrorCode): 400 | 409 | 500 | 503 {
	if (code === "team_setup_roster_unavailable") return 503;
	if (code === "team_setup_failed") return 500;
	if (code === "team_setup_incomplete") return 400;
	return 409;
}

export function teamSetupRoutes(options: TeamSetupRoutesOptions): Hono {
	const app = new Hono();
	const loadSnapshots =
		options.loadLegacyTeamConfiguredGroupSnapshots ?? loadConfiguredLegacyTeamGroupSnapshots;

	async function loadedSnapshots(): Promise<LegacyTeamConfiguredGroupSnapshot[]> {
		try {
			return await loadSnapshots();
		} catch {
			throw safeCoordinatorError();
		}
	}

	app.get("/api/sync/team-setup/v1", async (c) => {
		let groups: LegacyTeamConfiguredGroupSnapshot[];
		try {
			groups = await loadedSnapshots();
		} catch {
			return c.json({ error: "team_setup_roster_unavailable" as const }, 503);
		}
		try {
			const response = {
				version: TEAM_SETUP_VERSION,
				candidates: discoverCandidates(options.getStore(), groups).map(candidateSummary),
			} satisfies LegacyTeamSetupSummaryResponseV1;
			return c.json(response);
		} catch (error) {
			const code = legacyTeamSetupApiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
		}
	});

	app.get("/api/sync/team-setup/v1/:candidateRef", async (c) => {
		const candidateRef = c.req.param("candidateRef");
		if (!CANDIDATE_REF_PATTERN.test(candidateRef)) {
			return c.json({ error: "team_setup_incomplete" as const }, 400);
		}

		let groups: LegacyTeamConfiguredGroupSnapshot[];
		try {
			groups = await loadedSnapshots();
		} catch {
			return c.json({ error: "team_setup_roster_unavailable" as const }, 503);
		}

		try {
			const store = options.getStore();
			const candidateGroups = groups.filter(
				(group) => legacyTeamCandidateId(group.coordinatorId, group.groupId) === candidateRef,
			);
			const candidate = discoverCandidates(store, candidateGroups).find(
				(item) => item.candidateRef === candidateRef,
			);
			if (!candidate) {
				return c.json({ error: "team_setup_confirmation_stale" as const }, 404);
			}
			const draft = getLegacyTeamSetupDraft(store.db, candidateRef);
			if (!draft) return c.json({ error: "team_setup_confirmation_stale" as const }, 404);

			let conflictState: LegacyTeamSetupActivationErrorCode | null = null;
			let preview: ReturnType<typeof previewLegacyTeamSetupActivation> | null = null;
			if (draft.state !== "completed") {
				try {
					preview = previewLegacyTeamSetupActivation(store.db, {
						candidateRef,
						attemptId: draft.attemptId,
					});
				} catch (error) {
					const code = legacyTeamSetupApiErrorCode(error);
					if (code === "team_setup_failed") return c.json({ error: code }, 500);
					preview = null;
					conflictState = code;
				}
			}
			if (preview) requireBoundedAccessDelta(preview.accessDelta);

			const viewDraft = conflictState
				? (getLegacyTeamSetupDraft(store.db, candidateRef) ?? draft)
				: draft;
			const safeDraft = viewerSafeDraft(viewDraft);
			const responseBase = {
				version: TEAM_SETUP_VERSION,
				candidate: candidateSummaryForDraft(candidate, viewDraft),
				attemptId: viewDraft.attemptId,
				draftState: viewDraft.state,
				unresolvedDeviceCount: viewDraft.unresolvedDeviceCount,
				unresolvedProjectCount: viewDraft.unresolvedProjectCount,
				...safeDraft,
			};
			if (!preview) {
				const response = {
					...responseBase,
					canFinish: false,
					conflictState,
				} satisfies LegacyTeamSetupDetailResponseV1;
				return c.json(response);
			}
			const response = {
				...responseBase,
				canFinish: true,
				conflictState: null,
				finishDigest: preview.finishDigest,
				accessDeltaDigest: preview.accessDeltaDigest,
				accessDelta: viewerSafeAccessDelta(candidateRef, preview.accessDelta),
			} satisfies LegacyTeamSetupDetailResponseV1;
			return c.json(response);
		} catch (error) {
			const code = legacyTeamSetupApiErrorCode(error);
			return c.json({ error: code }, errorStatus(code));
		}
	});

	return app;
}
