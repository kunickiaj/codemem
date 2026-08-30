import type { LegacyTeamSetupActivationErrorCode, LegacyTeamSetupDraftView } from "@codemem/core";

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

export type LegacyTeamSetupActionBlockedReasonV1 =
	| "setup_incomplete"
	| "setup_unavailable"
	| "setup_completed"
	| "device_inactive"
	| "device_active"
	| "assignment_evidence_inactive"
	| "assignment_required"
	| "assignment_unavailable"
	| "decision_unresolved"
	| "mapping_unavailable"
	| "automatic_mapping";

export type LegacyTeamSetupActionGateV1 =
	| { enabled: true; blockedReason: null }
	| { enabled: false; blockedReason: LegacyTeamSetupActionBlockedReasonV1 };

export type LegacyTeamSetupUnavailableReasonV1 = Exclude<
	LegacyTeamSetupActivationErrorCode,
	"team_setup_projection_changed"
>;

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
	actions: {
		assignIdentity: LegacyTeamSetupActionGateV1;
		include: LegacyTeamSetupActionGateV1;
		exclude: LegacyTeamSetupActionGateV1;
		remove: LegacyTeamSetupActionGateV1;
		clearDecision: LegacyTeamSetupActionGateV1;
	};
}

export interface LegacyTeamSetupProjectV1 {
	projectRef: string;
	displayName: string;
	resolution: "unresolved" | "deterministic" | "explicit";
	canonicalProjectRef: string | null;
	resolvedProjectRef: string | null;
	mappingChoices: Array<{ resolvedProjectRef: string; displayName: string }>;
	actions: { map: LegacyTeamSetupActionGateV1 };
}

export interface LegacyTeamSetupIdentityChoiceV1 {
	identityRef: string;
	displayName: string;
}

export interface LegacyTeamSetupViewerAccessDeltaV1 {
	teamChanges: Array<{
		teamRef: string;
		teamDisplayName: string;
		change: "add" | "update" | "remove";
		fromDeviceEligibilityMode: "person_all_devices" | "reviewed_allowlist" | null;
		toDeviceEligibilityMode: "reviewed_allowlist";
	}>;
	membershipChanges: Array<{
		teamRef: string;
		teamDisplayName: string;
		identityRef: string;
		identityDisplayName: string;
		change: "add" | "update" | "remove";
	}>;
	projectChanges: Array<{
		projectRef: string;
		projectDisplayName: string;
		fromResolvedProjectRef: string | null;
		fromResolvedProjectDisplayName: string | null;
		toResolvedProjectRef: string | null;
		toResolvedProjectDisplayName: string | null;
		change: "add" | "update" | "remove";
	}>;
	recipientChanges: Array<{
		canonicalProjectRef: string;
		canonicalProjectDisplayName: string;
		recipientKind: "team";
		recipientRef: string;
		recipientDisplayName: string;
		change: "add" | "update" | "remove";
	}>;
	deviceAccessChanges: Array<{
		canonicalProjectRef: string;
		canonicalProjectDisplayName: string;
		deviceRef: string;
		deviceDisplayName: string;
		change: "add" | "remove";
	}>;
}

interface LegacyTeamSetupViewBaseV1 {
	version: 1;
	candidate: LegacyTeamSetupCandidateSummaryV1;
	attemptId: string;
	unresolvedDeviceCount: number;
	unresolvedProjectCount: number;
	devices: LegacyTeamSetupDeviceV1[];
	projects: LegacyTeamSetupProjectV1[];
	identityChoices: LegacyTeamSetupIdentityChoiceV1[];
}

export type LegacyTeamSetupViewV1 =
	| (LegacyTeamSetupViewBaseV1 & {
			state: "reviewing";
			actions: {
				refresh: { enabled: true; blockedReason: null };
				finish: { enabled: false; blockedReason: "setup_incomplete" };
			};
	  })
	| (LegacyTeamSetupViewBaseV1 & {
			state: "ready_to_finish";
			actions: {
				refresh: { enabled: true; blockedReason: null };
				finish: { enabled: true; blockedReason: null };
			};
			finishDigest: string;
			accessDeltaDigest: string;
			viewerAccessDeltaDigest: string;
			accessDelta: LegacyTeamSetupViewerAccessDeltaV1;
	  })
	| (LegacyTeamSetupViewBaseV1 & {
			state: "unavailable";
			unavailableReason: LegacyTeamSetupUnavailableReasonV1;
			actions: {
				refresh: { enabled: true; blockedReason: null };
				finish: { enabled: false; blockedReason: "setup_unavailable" };
			};
	  })
	| (LegacyTeamSetupViewBaseV1 & {
			state: "completed";
			actions: {
				refresh: { enabled: false; blockedReason: "setup_completed" };
				finish: { enabled: false; blockedReason: "setup_completed" };
			};
	  });

export type LegacyTeamSetupDetailResponseV1 = LegacyTeamSetupViewV1;
export type LegacyTeamSetupMutationResponseV1 = LegacyTeamSetupViewV1;

export interface LegacyTeamSetupErrorResponseV1 {
	error: LegacyTeamSetupActivationErrorCode;
}

export interface LegacyTeamSetupFinishResponseV1 {
	version: 1;
	status: "completed";
	teamRef: string;
	attemptId: string;
	accessDeltaDigest: string;
	completedAt: string;
}

type DeviceData = Omit<LegacyTeamSetupDeviceV1, "actions">;
type ProjectData = Omit<LegacyTeamSetupProjectV1, "actions">;

interface ProjectViewInput {
	version: 1;
	candidate: LegacyTeamSetupCandidateSummaryV1;
	draftState: LegacyTeamSetupDraftView["state"];
	attemptId: string;
	unresolvedDeviceCount: number;
	unresolvedProjectCount: number;
	devices: DeviceData[];
	projects: ProjectData[];
	identityChoices: LegacyTeamSetupIdentityChoiceV1[];
	unavailableReason: LegacyTeamSetupUnavailableReasonV1 | null;
	preview: null | {
		finishDigest: string;
		accessDeltaDigest: string;
		viewerAccessDeltaDigest: string;
		accessDelta: LegacyTeamSetupViewerAccessDeltaV1;
	};
}

const enabled = { enabled: true, blockedReason: null } as const;

function blocked<const Reason extends LegacyTeamSetupActionBlockedReasonV1>(
	reason: Reason,
): { enabled: false; blockedReason: Reason } {
	return { enabled: false, blockedReason: reason };
}

function deviceActions(
	device: DeviceData,
	identityChoices: LegacyTeamSetupIdentityChoiceV1[],
	state: LegacyTeamSetupViewV1["state"],
): LegacyTeamSetupDeviceV1["actions"] {
	if (state === "completed") return disabledDeviceActions("setup_completed");
	if (state === "unavailable") return disabledDeviceActions("setup_unavailable");
	const assignmentEvidenceInactive =
		device.expectation.kind === "existing" && device.verifiedEvidenceKind !== "active_assignment";
	const targetAvailable = identityChoices.some(
		(identity) => identity.identityRef === device.targetIdentityRef,
	);
	return {
		assignIdentity: !device.enabled
			? blocked("device_inactive")
			: assignmentEvidenceInactive
				? blocked("assignment_evidence_inactive")
				: identityChoices.length === 0
					? blocked("assignment_unavailable")
					: enabled,
		include: !device.enabled
			? blocked("device_inactive")
			: assignmentEvidenceInactive
				? blocked("assignment_evidence_inactive")
				: !device.targetIdentityRef
					? blocked("assignment_required")
					: !targetAvailable
						? blocked("assignment_unavailable")
						: enabled,
		exclude: device.enabled ? enabled : blocked("device_inactive"),
		remove: device.enabled ? blocked("device_active") : enabled,
		clearDecision: device.decision === "unresolved" ? blocked("decision_unresolved") : enabled,
	};
}

function disabledDeviceActions(
	reason: "setup_completed" | "setup_unavailable",
): LegacyTeamSetupDeviceV1["actions"] {
	const gate = blocked(reason);
	return {
		assignIdentity: gate,
		include: gate,
		exclude: gate,
		remove: gate,
		clearDecision: gate,
	};
}

function projectActions(
	project: ProjectData,
	state: LegacyTeamSetupViewV1["state"],
): LegacyTeamSetupProjectV1["actions"] {
	if (state === "completed") return { map: blocked("setup_completed") };
	if (state === "unavailable") return { map: blocked("setup_unavailable") };
	return {
		map:
			project.resolution === "deterministic"
				? blocked("automatic_mapping")
				: project.mappingChoices.length === 0
					? blocked("mapping_unavailable")
					: enabled,
	};
}

function viewState(input: ProjectViewInput): LegacyTeamSetupViewV1["state"] {
	if (input.draftState === "completed") return "completed";
	if (input.draftState === "stale" || input.unavailableReason) return "unavailable";
	if (input.preview) return "ready_to_finish";
	return "reviewing";
}

export function projectLegacyTeamSetupView(input: ProjectViewInput): LegacyTeamSetupViewV1 {
	const state = viewState(input);
	const base = {
		version: input.version,
		candidate: input.candidate,
		attemptId: input.attemptId,
		unresolvedDeviceCount: input.unresolvedDeviceCount,
		unresolvedProjectCount: input.unresolvedProjectCount,
		devices: input.devices.map((device) => ({
			...device,
			actions: deviceActions(device, input.identityChoices, state),
		})),
		projects: input.projects.map((project) => ({
			...project,
			actions: projectActions(project, state),
		})),
		identityChoices: input.identityChoices,
	};
	if (state === "completed") {
		return {
			...base,
			state,
			actions: {
				refresh: blocked("setup_completed"),
				finish: blocked("setup_completed"),
			},
		};
	}
	if (state === "unavailable") {
		return {
			...base,
			state,
			unavailableReason: input.unavailableReason ?? "team_setup_confirmation_stale",
			actions: { refresh: enabled, finish: blocked("setup_unavailable") },
		};
	}
	if (state === "ready_to_finish" && input.preview) {
		return {
			...base,
			state,
			actions: { refresh: enabled, finish: enabled },
			...input.preview,
		};
	}
	return {
		...base,
		state: "reviewing",
		actions: { refresh: enabled, finish: blocked("setup_incomplete") },
	};
}
