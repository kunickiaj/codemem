/* Sync-domain viewer endpoints — status, invite import, peer
 * lifecycle (accept, rename, delete, scope, identity), actor CRUD, and
 * the manual sync-now trigger. Every request in this file hits
 * /api/sync/* or /api/sync/run/* on the viewer. */

import { fetchJson, payloadError, readJsonPayload } from "./internal";
import type { AcceptDiscoveredPeerResult, ImportInviteResult, SyncRunResponse } from "./types";

export type RecipientInvitationKind = "team_member" | "add_device";

export type RecipientOnboardingProjectSourceV1 =
	| { kind: "direct" }
	| { kind: "team"; teamId: string; displayName: string };

export interface RecipientOnboardingProjectV1 {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
	futureMemoriesShared: true;
	sources: RecipientOnboardingProjectSourceV1[];
}

export interface RecipientOnboardingPreviewV1 {
	version: 1;
	journey: "team" | "direct_project" | "add_device";
	binding: {
		invitationId: string;
		identityId: string;
		deviceId: string;
		deviceKeyFingerprint: string;
		deviceDisplayName: string;
	};
	team: { teamId: string; displayName: string; futureProjectsInherit: true } | null;
	projects: RecipientOnboardingProjectV1[];
	excludedProjects: Array<{
		canonicalProjectIdentity: string;
		displayName: string;
		existingMemoryCount: number;
	}>;
	reviewedOnboardingDigest: string;
}

export type InspectInviteResult =
	| { kind: "legacy_team_invite" }
	| {
			kind: "project_share_invite";
			operation_id?: string;
			inviter_name?: string | null;
			team_name?: string | null;
			recipient_name?: string;
			device_name?: string;
			projects?: Array<{ display_name: string; existing_memory_count: number }>;
	  }
	| {
			kind: RecipientInvitationKind;
			recipient_name: string;
			device_name: string;
			assigned_identity_id?: string;
			onboarding: RecipientOnboardingPreviewV1;
	  };

export type RecipientInvitePreviewRequest =
	| { kind: "team_member"; policy_team_id: string }
	| { kind: "add_device"; target_identity_id: string };

export interface RecipientInvitePreviewResult {
	kind: RecipientInvitationKind;
	preview: RecipientOnboardingPreviewV1;
}

export type RecipientPolicyTeamRenameErrorCode =
	| "team_name_invalid"
	| "team_not_found"
	| "team_rename_stale"
	| "team_link_stale"
	| "team_link_ambiguous"
	| "team_coordinator_rename_failed"
	| "team_local_rename_pending"
	| "team_rename_failed";

export interface RecipientPolicyTeamRenameResultV1 {
	version: 1;
	teamId: string;
	displayName: string;
	revision: string;
	linkedCoordinatorGroupRenamed: boolean;
}

export class RecipientPolicyTeamRenameApiError extends Error {
	constructor(
		readonly statusCode: number,
		readonly errorCode: RecipientPolicyTeamRenameErrorCode,
	) {
		super(errorCode);
		this.name = "RecipientPolicyTeamRenameApiError";
	}
}

const TEAM_RENAME_ERROR_CODES = new Set<RecipientPolicyTeamRenameErrorCode>([
	"team_name_invalid",
	"team_not_found",
	"team_rename_stale",
	"team_link_stale",
	"team_link_ambiguous",
	"team_coordinator_rename_failed",
	"team_local_rename_pending",
	"team_rename_failed",
]);

export async function renameRecipientPolicyTeam(input: {
	teamId: string;
	displayName: string;
	expectedDisplayName: string;
}): Promise<RecipientPolicyTeamRenameResultV1> {
	let response: Response;
	try {
		response = await fetch(
			`/api/sync/recipient-policy/v1/teams/${encodeURIComponent(input.teamId)}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					displayName: input.displayName,
					expectedDisplayName: input.expectedDisplayName,
				}),
			},
		);
	} catch {
		throw new RecipientPolicyTeamRenameApiError(0, "team_rename_failed");
	}
	const { payload } = await readJsonPayload<RecipientPolicyTeamRenameResultV1>(response);
	if (!response.ok) {
		const code =
			payload && typeof payload === "object" && "error" in payload ? String(payload.error) : "";
		throw new RecipientPolicyTeamRenameApiError(
			response.status,
			TEAM_RENAME_ERROR_CODES.has(code as RecipientPolicyTeamRenameErrorCode)
				? (code as RecipientPolicyTeamRenameErrorCode)
				: "team_rename_failed",
		);
	}
	if (
		payload?.version !== 1 ||
		typeof payload.teamId !== "string" ||
		typeof payload.displayName !== "string" ||
		typeof payload.revision !== "string" ||
		typeof payload.linkedCoordinatorGroupRenamed !== "boolean"
	) {
		throw new RecipientPolicyTeamRenameApiError(response.status, "team_rename_failed");
	}
	return payload;
}

export interface CreatedRecipientInvite extends RecipientInvitePreviewResult {
	ok: true;
	invite: {
		encoded?: string;
		link?: string;
		invite_id?: string;
	};
}

type CoordinatorInviteIdentity =
	| {
			recipient_name?: string;
			device_name?: string;
			reviewed_onboarding_digest?: never;
	  }
	| {
			recipient_name?: string;
			device_name: string;
			reviewed_onboarding_digest: string;
	  };

const PROJECT_INVITE_ACCEPTANCE_ERROR_CODES = new Set([
	"device_display_name_invalid",
	"device_display_name_required",
	"device_display_name_too_long",
	"invite_already_bound",
	"invite_expired",
	"invite_identity_conflict",
	"invite_invalid",
	"inviter_identity_invalid",
	"project_invite_acceptance_failed",
	"project_invite_bootstrap_incomplete",
	"project_invite_self_acceptance_forbidden",
	"project_invite_trust_state_invalid",
	"project_sync_enablement_failed",
	"recipient_display_name_invalid",
	"recipient_display_name_required",
	"recipient_display_name_too_long",
]);

export class ProjectInviteAcceptanceError extends Error {
	constructor(
		message: string,
		readonly errorCode: string,
	) {
		super(message);
		this.name = "ProjectInviteAcceptanceError";
	}
}

type TriggerSyncTarget = {
	address?: string;
	peerDeviceId?: string;
};

export async function loadSyncStatus(
	includeDiagnostics: boolean,
	project = "",
	options?: { includeJoinRequests?: boolean },
): Promise<unknown> {
	const params = new URLSearchParams();
	if (includeDiagnostics) params.set("includeDiagnostics", "1");
	if (project) params.set("project", project);
	if (options?.includeJoinRequests) params.set("includeJoinRequests", "1");
	const suffix = params.size ? `?${params.toString()}` : "";
	return fetchJson(`/api/sync/status${suffix}`);
}

export async function importCoordinatorInvite(
	invite: string,
	identity?: CoordinatorInviteIdentity,
	inviteKind?: InspectInviteResult["kind"],
): Promise<ImportInviteResult> {
	const resp = await fetch("/api/sync/invites/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ invite, ...identity }),
	});
	const { text, payload: data } = await readJsonPayload<ImportInviteResult>(resp);
	if (!resp.ok) {
		const detail = typeof data?.detail === "string" ? data.detail.trim() : "";
		const errorCode = payloadError(data);
		const message = detail || errorCode || text || "request failed";
		if (
			inviteKind === "project_share_invite" &&
			errorCode &&
			PROJECT_INVITE_ACCEPTANCE_ERROR_CODES.has(errorCode)
		) {
			throw new ProjectInviteAcceptanceError(message, errorCode);
		}
		throw new Error(message);
	}
	return data;
}

export async function inspectCoordinatorInvite(
	invite: string,
	options: { device_name?: string } = {},
): Promise<InspectInviteResult> {
	const resp = await fetch("/api/sync/invites/inspect", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ invite, ...options }),
	});
	const { text, payload } = await readJsonPayload<InspectInviteResult>(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload as InspectInviteResult;
}

export async function loadSyncActors(): Promise<unknown> {
	return fetchJson("/api/sync/actors");
}

export async function loadPairing(includeDiagnostics = false): Promise<unknown> {
	const suffix = includeDiagnostics ? "?includeDiagnostics=1" : "";
	return fetchJson(`/api/sync/pairing${suffix}`);
}

export async function updatePeerScope(
	peerDeviceId: string,
	include: string[] | null,
	exclude: string[] | null,
	inheritGlobal = false,
): Promise<unknown> {
	const resp = await fetch("/api/sync/peers/scope", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			peer_device_id: peerDeviceId,
			include,
			exclude,
			inherit_global: inheritGlobal,
		}),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) {
		throw new Error(payloadError(payload) || text || "request failed");
	}
	return payload;
}

export async function updatePeerIdentity(
	peerDeviceId: string,
	claimedLocalActor: boolean,
): Promise<unknown> {
	const resp = await fetch("/api/sync/peers/identity", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			peer_device_id: peerDeviceId,
			claimed_local_actor: claimedLocalActor,
		}),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function assignPeerActor(
	peerDeviceId: string,
	actorId: string | null,
): Promise<unknown> {
	const resp = await fetch("/api/sync/peers/identity", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			peer_device_id: peerDeviceId,
			actor_id: actorId,
		}),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function deletePeer(peerDeviceId: string): Promise<unknown> {
	const resp = await fetch(`/api/sync/peers/${encodeURIComponent(peerDeviceId)}`, {
		method: "DELETE",
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function renamePeer(peerDeviceId: string, name: string): Promise<unknown> {
	const resp = await fetch("/api/sync/peers/rename", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			peer_device_id: peerDeviceId,
			name,
		}),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function acceptDiscoveredPeer(
	peerDeviceId: string,
	options?: {
		fingerprint?: string | null;
		expectedGroupId?: string;
		expectedIncomingRequestId?: string;
	},
): Promise<AcceptDiscoveredPeerResult> {
	const body: Record<string, string> = { peer_device_id: peerDeviceId };
	if (options?.fingerprint) body.fingerprint = options.fingerprint;
	if (options?.expectedGroupId) body.expected_group_id = options.expectedGroupId;
	if (options?.expectedIncomingRequestId) {
		body.expected_incoming_request_id = options.expectedIncomingRequestId;
	}
	const resp = await fetch("/api/sync/peers/accept-discovered", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	let payload: AcceptDiscoveredPeerResult = {};
	try {
		const parsed = text ? JSON.parse(text) : null;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			payload = parsed as AcceptDiscoveredPeerResult;
		}
	} catch {
		payload = {};
	}
	const detail = typeof payload.detail === "string" ? payload.detail : undefined;
	if (!resp.ok) throw new Error(detail || payloadError(payload) || text || "request failed");
	return payload;
}

export interface CoordinatorGroupPreferences {
	coordinator_id?: string;
	group_id?: string;
	projects_include: string[] | null;
	projects_exclude: string[] | null;
	auto_seed_scope: boolean;
	default_space_scope_id?: string | null;
	auto_grant_default_space_on_join?: boolean;
	updated_at?: string | null;
}

export interface SharingDomainScope {
	scope_id: string;
	label: string;
	kind: string;
	authority_type: string;
	coordinator_id?: string | null;
	group_id?: string | null;
	membership_epoch?: number;
	status: string;
	updated_at?: string | null;
}

export interface ProjectScopeMapping {
	id: number;
	workspace_identity: string | null;
	project_pattern: string;
	scope_id: string;
	priority: number;
	source: string;
	created_at?: string | null;
	updated_at?: string | null;
	guardrail_warnings?: ProjectScopeGuardrailWarning[];
}

export type ProjectScopeGuardrailSeverity = "info" | "warning";

export interface ProjectScopeGuardrailWarning {
	code: string;
	severity: ProjectScopeGuardrailSeverity;
	message: string;
	requires_confirmation: boolean;
	scope_id?: string | null;
	previous_scope_id?: string | null;
	mapping_id?: number | null;
	workspace_identity?: string | null;
	project_pattern?: string | null;
	related_workspace_identities?: string[];
	related_projects?: string[];
	confirmation_token?: string;
}

export interface ProjectScopeCandidate {
	workspace_identity: string;
	identity_source: string;
	display_project: string;
	project: string | null;
	cwd: string | null;
	git_remote: string | null;
	git_branch: string | null;
	latest_session_at: string | null;
	read_only?: boolean;
	read_only_reason?: "peer_received" | null;
	resolved_scope_id: string;
	resolution_reason: string;
	mapping_id: number | null;
	matched_pattern: string | null;
	suggested_scope_id?: string | null;
	suggestion_reason?: string | null;
	suggestion_signal?: string | null;
	guardrail_warnings?: ProjectScopeGuardrailWarning[];
}

export type ProjectScopeInventoryStatus =
	| "explicitly_mapped"
	| "legacy_review"
	| "local_only"
	| "needs_attention"
	| "received"
	| "suggested"
	| "unmapped";

export interface ProjectScopeInventoryProject extends ProjectScopeCandidate {
	memory_count: number | null;
	session_count: number;
	statuses: ProjectScopeInventoryStatus[];
	sharing?: ProjectSharingSummary[];
}

export interface ProjectSharingSummary {
	person: { actor_id: string; display_name: string };
	lifecycle: Pick<ShareOperationLifecycle, "state" | "label" | "explanation">;
}

export type ShareOperationLifecycleState =
	| "waiting_for_acceptance"
	| "provisioning"
	| "initial_sync"
	| "waiting_for_device"
	| "active"
	| "needs_attention"
	| "revoking"
	| "revoked"
	| "cancelled";

export interface ShareOperationLifecycle {
	state: ShareOperationLifecycleState;
	label: string;
	explanation: string;
	primary_action:
		| { kind: "copy_invite"; label: string; invite_link?: string }
		| { kind: "retry_setup"; label: string }
		| { kind: "share_again"; label: string }
		| { kind: "create_new_invite"; label: string }
		| null;
}

export interface ShareOperationReadModel {
	operation_id: string;
	person: { actor_id: string; display_name: string };
	devices: Array<{ device_id: string; display_name: string; last_seen_at: string | null }>;
	projects: Array<{ project_id?: string; display_name: string; existing_memory_count: number }>;
	project_count: number;
	lifecycle: ShareOperationLifecycle;
	timestamps: {
		created_at: string;
		updated_at: string;
		accepted_at: string | null;
		invite_expires_at: string;
	};
}

export interface ShareOperationList {
	items: ShareOperationReadModel[];
}

export interface ProjectScopeInventoryResult {
	projects: ProjectScopeInventoryProject[];
	total: number;
	limit: number;
	offset: number;
	has_more: boolean;
}

export interface ProjectInvitePreviewProject {
	project_id: string;
	display_name: string;
	existing_memory_count: number;
}

export interface ProjectInvitePreview {
	operation_id: string;
	teammate: {
		display_name: string;
		match: "existing" | "pending";
		person_id?: string;
	};
	projects: ProjectInvitePreviewProject[];
	existing_memory_count: number;
	future_memories_shared: true;
	history_policy: "existing_and_future";
	reviewed_project_set_digest: string;
}

export interface CreatedProjectInvite extends ProjectInvitePreview {
	ok: true;
	invite: { link: string; encoded: string; expires_at: string };
}

export interface ProjectReassignmentResult {
	workspace_identity: string;
	project: string;
	previous_projects: string[];
	moved_session_count: number;
	moved_memory_count: number;
}

export interface ProjectForgetPreview {
	confirmation_token: string;
	confirmed?: boolean;
	local_owned_memory_count: number;
	peer_owned_memory_count: number;
	workspace_identity: string;
}

type ProjectMappingBulkInput = {
	id?: number | null;
	priority?: number | null;
	project_pattern?: string | null;
	scope_id: string;
	source?: string | null;
	workspace_identity?: string | null;
};

export interface ProjectForgetResult extends ProjectForgetPreview {
	forgotten_memory_count: number;
	ok?: boolean;
}

export class ProjectForgetConfirmationError extends Error {
	preview: ProjectForgetPreview;

	constructor(preview: ProjectForgetPreview) {
		super("Project forget confirmation required");
		this.name = "ProjectForgetConfirmationError";
		this.preview = preview;
	}
}

export interface LegacySharedReviewReassignmentPreview {
	confirmation_token: string;
	workspace_identity: string;
	scope_id: string;
	target_scope_label: string;
	memory_count: number;
	reassignable_memory_count: number;
	skipped_memory_count: number;
	affected_peer_device_count: number;
	affected_peer_device_ids: string[];
	warning: string;
}

export interface LegacySharedReviewReassignmentResult
	extends LegacySharedReviewReassignmentPreview {
	ok?: boolean;
	reassigned_memory_count: number;
	legacy_shared_review?: Record<string, unknown> | null;
}

export interface SharingDomainSettings {
	scopes: SharingDomainScope[];
	mappings: ProjectScopeMapping[];
	projects: ProjectScopeCandidate[];
	local_default_scope_id: string;
}

export class SharingDomainGuardrailConfirmationError extends Error {
	requiredGuardrails: string[];
	requiredGuardrailTokens: string[];
	guardrailWarnings: ProjectScopeGuardrailWarning[];

	constructor(input: {
		required_guardrails?: string[];
		required_guardrail_tokens?: string[];
		guardrail_warnings?: ProjectScopeGuardrailWarning[];
	}) {
		super("Sharing domain guardrail confirmation required");
		this.name = "SharingDomainGuardrailConfirmationError";
		this.requiredGuardrails = input.required_guardrails ?? [];
		this.requiredGuardrailTokens = input.required_guardrail_tokens ?? [];
		this.guardrailWarnings = input.guardrail_warnings ?? [];
	}
}

export class LegacySharedReviewConfirmationError extends Error {
	preview: LegacySharedReviewReassignmentPreview;

	constructor(preview: LegacySharedReviewReassignmentPreview) {
		super("Legacy shared review confirmation required");
		this.name = "LegacySharedReviewConfirmationError";
		this.preview = preview;
	}
}

export type RecipientPolicyReviewDecisionV1 =
	| "apply_recommendation"
	| "choose_recipients"
	| "preserve_current_access"
	| "reject_suggestion"
	| "keep_current_setup"
	| "keep_project_local"
	| "keep_identities_separate"
	| "attach_device_to_identity"
	| "create_identity"
	| "remove_stale_device";

export interface RecipientPolicyReviewPreviewProjectV1 {
	canonicalIdentity: string;
	displayName: string;
}

export interface RecipientPolicyReviewPreviewDeviceV1 {
	deviceId: string;
	displayName: string;
	identityId: string | null;
	assignment: "assigned" | "unassigned";
}

export interface RecipientPolicyReviewPreviewV1 {
	projects: RecipientPolicyReviewPreviewProjectV1[];
	effectiveDevices: RecipientPolicyReviewPreviewDeviceV1[];
	affectedProjectCount: number;
	affectedMemoryCount: number;
	affectedDeviceCount: number;
	effect: "none" | "grant_reviewed_access" | "revoke_reviewed_access" | "metadata_only";
	requiresDecisionInput: boolean;
}

export interface RecipientPolicyReviewOptionV1 {
	decision: RecipientPolicyReviewDecisionV1;
	label: string;
	effect: RecipientPolicyReviewPreviewV1["effect"];
	affectedProjectCount: number;
	affectedMemoryCount: number;
	affectedDeviceCount: number;
	preview: RecipientPolicyReviewPreviewV1;
}

export interface RecipientPolicyReviewItemV1 {
	version: 1;
	reviewItemId: string;
	sourceFingerprint: string;
	finding: string;
	reason: string;
	recommendedDecision: RecipientPolicyReviewDecisionV1;
	options: RecipientPolicyReviewOptionV1[];
	state: "open" | "resolved";
	resolution: null | {
		decision: RecipientPolicyReviewDecisionV1;
		decidedByIdentityId: string;
		decidedByDeviceId: string;
		resolvedAt: string;
	};
}

export interface RecipientPolicyBlockedItemV1 {
	version: 1;
	blockedItemId: string;
	finding: string;
	reason: string;
	ownerLabel: string;
	repairAction: string;
}

export interface RecipientPolicyReviewListV1 {
	version: 1;
	reviewItems: RecipientPolicyReviewItemV1[];
	blockedItems: RecipientPolicyBlockedItemV1[];
	continuity: {
		state: "legacy_access_preserved";
		findingCount: number;
	} | null;
}

export interface RecipientPolicyReviewResolveRequestV1 {
	reviewItemId: string;
	sourceFingerprint: string;
	decision: RecipientPolicyReviewDecisionV1;
	decisionInput?: unknown;
}

export type RecipientPolicyReviewResolveStatusV1 =
	| "applied"
	| "stale"
	| "not_found"
	| "invalid"
	| "conflict";

export interface RecipientPolicyReviewResolveResultV1 {
	reviewItemId: string;
	sourceFingerprint: string;
	status: RecipientPolicyReviewResolveStatusV1;
	errorCode: string | null;
	idempotent: boolean;
}

export interface RecipientPolicyReviewBulkResultV1 {
	version: 1;
	results: RecipientPolicyReviewResolveResultV1[];
}

export class RecipientPolicyReviewStaleError extends Error {
	result: RecipientPolicyReviewResolveResultV1;

	constructor(result: RecipientPolicyReviewResolveResultV1) {
		super("Recipient policy review source state changed");
		this.name = "RecipientPolicyReviewStaleError";
		this.result = result;
	}
}

export type RecipientPolicyEdgeRecipientRefV1 =
	| { recipientKind: "identity"; identityId: string }
	| { recipientKind: "team"; teamId: string };

export interface RecipientPolicyIdentityV1 {
	version: 1;
	identityId: string;
	displayName: string;
	kind: "personal" | "work" | "other";
	verification: "local";
	status: "active" | "pending" | "merged";
	mergedIntoIdentityId: string | null;
}

export interface RecipientPolicyTeamV1 {
	version: 1;
	teamId: string;
	displayName: string;
	status: "active" | "archived";
}

export interface RecipientPolicyTeamMembershipV1 {
	version: 1;
	teamId: string;
	identityId: string;
	role: "member" | "admin";
	status: "active" | "pending" | "revoked";
}

export interface RecipientPolicyIdentityDeviceV1 {
	version: 1;
	identityId: string;
	deviceId: string;
	displayName: string;
	status: "active" | "revoked";
}

interface RecipientPolicyProjectRecipientBaseV1 {
	version: 1;
	canonicalProjectIdentity: string;
	intentSource: "user" | "migration" | "legacy_project_invite";
	policyRevision: string;
	status: "active" | "revoked";
}

export type RecipientPolicyProjectRecipientV1 =
	| (RecipientPolicyProjectRecipientBaseV1 & { recipientKind: "identity"; identityId: string })
	| (RecipientPolicyProjectRecipientBaseV1 & { recipientKind: "team"; teamId: string });

export interface RecipientPolicyIntentGraphV1 {
	version: 1;
	identities: RecipientPolicyIdentityV1[];
	teams: RecipientPolicyTeamV1[];
	teamMemberships: RecipientPolicyTeamMembershipV1[];
	identityDevices: RecipientPolicyIdentityDeviceV1[];
	projectRecipients: RecipientPolicyProjectRecipientV1[];
}

export type DeviceIdentityInventoryStateV1 =
	| "configured"
	| "setup_required"
	| "pairing_required"
	| "conflicted";

export interface DeviceIdentityInventoryItemV1 {
	version: 1;
	deviceId: string;
	evidenceDeviceIds: string[];
	displayName: string;
	state: DeviceIdentityInventoryStateV1;
	identityId: string | null;
	suggestedIdentityId: string | null;
	validatedFingerprint: string | null;
	isLocal: boolean;
	sources: Array<"local_device" | "sync_peer" | "coordinator_enrollment" | "identity_binding">;
	conflictCodes: string[];
}

export interface DeviceIdentityInventoryV1 {
	version: 1;
	items: DeviceIdentityInventoryItemV1[];
	coordinatorEvidence: {
		availability: "available" | "unavailable";
		safeErrorCode: string | null;
	};
	truncated: boolean;
}

export interface DeviceIdentityBindingSelectionV1 {
	deviceId: string;
	targetIdentityId: string;
	confirmed: boolean;
	allowRebind?: boolean;
}

export interface DeviceIdentityBindingPreviewRequestV1 {
	bindings: DeviceIdentityBindingSelectionV1[];
}

export interface DeviceIdentityBindingOutcomeV1 {
	deviceId: string;
	displayName: string;
	targetIdentityId: string;
	previousIdentityId: string | null;
	action: "bind" | "rebind" | "unchanged";
	isLocal: boolean;
}

export interface DeviceIdentityBindingPreviewV1 {
	version: 1;
	status: "ready" | "invalid" | "not_found" | "conflict";
	reviewedInventoryDigest: string;
	errorCode: string | null;
	outcomes: DeviceIdentityBindingOutcomeV1[];
	writeCount: number;
}

export interface DeviceIdentityBindingCommitV1 {
	version: 1;
	status: "applied" | "invalid" | "not_found" | "stale" | "conflict";
	reviewedInventoryDigest: string;
	errorCode: string | null;
	outcomes: DeviceIdentityBindingOutcomeV1[];
	writeCount: number;
	idempotent: boolean;
}

export class DeviceIdentityBindingApiError extends Error {
	constructor(
		readonly statusCode: number,
		readonly errorCode: string,
		readonly result: DeviceIdentityBindingPreviewV1 | DeviceIdentityBindingCommitV1 | null,
	) {
		super(errorCode);
		this.name = "DeviceIdentityBindingApiError";
	}
}

export type LegacyTeamSetupStatusV1 = "needs_setup" | "in_progress" | "stale" | "ready";

export interface LegacyTeamSetupCandidateSummaryV1 {
	candidateRef: string;
	displayName: string;
	status: LegacyTeamSetupStatusV1;
	deviceCount: number;
	projectCount: number;
	unresolvedDeviceCount: number;
	unresolvedProjectCount: number;
}

export type LegacyTeamSetupPendingCandidateSummaryV1 = Omit<
	LegacyTeamSetupCandidateSummaryV1,
	"status"
> & {
	status: Exclude<LegacyTeamSetupStatusV1, "ready">;
};

export interface LegacyTeamSetupSummaryResponseV1 {
	version: 1;
	candidates: LegacyTeamSetupPendingCandidateSummaryV1[];
}

export type LegacyTeamSetupAssignmentExpectationV1 =
	| { kind: "absent" }
	| { kind: "existing"; assignmentVersion: number; identityRef: string };

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

export interface LegacyTeamSetupDeviceV1 {
	deviceRef: string;
	displayName: string;
	enabled: boolean;
	existingIdentityRef: string | null;
	suggestedIdentityRef: string | null;
	verifiedEvidenceKind: "active_assignment" | null;
	decision: "unresolved" | "included" | "excluded" | "removed";
	targetIdentityRef: string | null;
	expectation: LegacyTeamSetupAssignmentExpectationV1;
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

export interface LegacyTeamSetupAccessDeltaV1 {
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
			accessDelta: LegacyTeamSetupAccessDeltaV1;
	  })
	| (LegacyTeamSetupViewBaseV1 & {
			state: "unavailable";
			unavailableReason: LegacyTeamSetupErrorCode;
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

export interface LegacyTeamSetupFinishResponseV1 {
	version: 1;
	status: "completed";
	teamRef: string;
	attemptId: string;
	accessDeltaDigest: string;
	completedAt: string;
}

export type LegacyTeamSetupErrorCode =
	| "team_setup_incomplete"
	| "team_setup_roster_changed"
	| "team_setup_assignment_changed"
	| "team_setup_roster_unavailable"
	| "team_setup_conflict"
	| "team_setup_confirmation_stale"
	| "team_setup_failed";

const LEGACY_TEAM_SETUP_VERSION = 1;
const LEGACY_TEAM_SETUP_ERROR_CODES = new Set<LegacyTeamSetupErrorCode>([
	"team_setup_incomplete",
	"team_setup_roster_changed",
	"team_setup_assignment_changed",
	"team_setup_roster_unavailable",
	"team_setup_conflict",
	"team_setup_confirmation_stale",
	"team_setup_failed",
]);
const LEGACY_TEAM_SETUP_STATUSES = new Set<LegacyTeamSetupStatusV1>([
	"needs_setup",
	"in_progress",
	"stale",
	"ready",
]);
const LEGACY_TEAM_SETUP_VIEW_STATES = new Set([
	"reviewing",
	"ready_to_finish",
	"unavailable",
	"completed",
]);
const LEGACY_TEAM_SETUP_ACTION_BLOCKED_REASONS = new Set<LegacyTeamSetupActionBlockedReasonV1>([
	"setup_incomplete",
	"setup_unavailable",
	"setup_completed",
	"device_inactive",
	"device_active",
	"assignment_evidence_inactive",
	"assignment_required",
	"assignment_unavailable",
	"decision_unresolved",
	"mapping_unavailable",
	"automatic_mapping",
]);

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactJsonKeys(value: JsonRecord, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStringOrNull(value: unknown): value is string | null {
	return typeof value === "string" || value === null;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isArrayOf<T>(value: unknown, predicate: (item: unknown) => item is T): value is T[] {
	return Array.isArray(value) && value.every(predicate);
}

function isLegacyTeamSetupCandidateSummary(
	value: unknown,
): value is LegacyTeamSetupCandidateSummaryV1 {
	if (!isJsonRecord(value)) return false;
	return (
		typeof value.candidateRef === "string" &&
		typeof value.displayName === "string" &&
		typeof value.status === "string" &&
		LEGACY_TEAM_SETUP_STATUSES.has(value.status as LegacyTeamSetupStatusV1) &&
		isNonNegativeInteger(value.deviceCount) &&
		isNonNegativeInteger(value.projectCount) &&
		isNonNegativeInteger(value.unresolvedDeviceCount) &&
		isNonNegativeInteger(value.unresolvedProjectCount)
	);
}

function isLegacyTeamSetupSummary(value: unknown): value is LegacyTeamSetupSummaryResponseV1 {
	return (
		isJsonRecord(value) &&
		value.version === LEGACY_TEAM_SETUP_VERSION &&
		isArrayOf(
			value.candidates,
			(candidate): candidate is LegacyTeamSetupPendingCandidateSummaryV1 =>
				isLegacyTeamSetupCandidateSummary(candidate) && candidate.status !== "ready",
		)
	);
}

function isLegacyTeamSetupExpectation(
	value: unknown,
): value is LegacyTeamSetupAssignmentExpectationV1 {
	if (!isJsonRecord(value)) return false;
	return (
		value.kind === "absent" ||
		(value.kind === "existing" &&
			isNonNegativeInteger(value.assignmentVersion) &&
			typeof value.identityRef === "string")
	);
}

function isLegacyTeamSetupActionGate(value: unknown): value is LegacyTeamSetupActionGateV1 {
	if (!isJsonRecord(value) || !hasExactJsonKeys(value, ["blockedReason", "enabled"])) return false;
	if (value.enabled === true) return value.blockedReason === null;
	return (
		value.enabled === false &&
		typeof value.blockedReason === "string" &&
		LEGACY_TEAM_SETUP_ACTION_BLOCKED_REASONS.has(
			value.blockedReason as LegacyTeamSetupActionBlockedReasonV1,
		)
	);
}

function isLegacyTeamSetupDeviceActions(
	value: unknown,
): value is LegacyTeamSetupDeviceV1["actions"] {
	if (
		!isJsonRecord(value) ||
		!hasExactJsonKeys(value, ["assignIdentity", "clearDecision", "exclude", "include", "remove"])
	) {
		return false;
	}
	return (
		isLegacyTeamSetupActionGate(value.assignIdentity) &&
		isLegacyTeamSetupActionGate(value.include) &&
		isLegacyTeamSetupActionGate(value.exclude) &&
		isLegacyTeamSetupActionGate(value.remove) &&
		isLegacyTeamSetupActionGate(value.clearDecision)
	);
}

function isLegacyTeamSetupDevice(value: unknown): value is LegacyTeamSetupDeviceV1 {
	if (!isJsonRecord(value)) return false;
	return (
		typeof value.deviceRef === "string" &&
		typeof value.displayName === "string" &&
		typeof value.enabled === "boolean" &&
		isStringOrNull(value.existingIdentityRef) &&
		isStringOrNull(value.suggestedIdentityRef) &&
		(value.verifiedEvidenceKind === "active_assignment" || value.verifiedEvidenceKind === null) &&
		typeof value.decision === "string" &&
		["unresolved", "included", "excluded", "removed"].includes(value.decision) &&
		isStringOrNull(value.targetIdentityRef) &&
		isLegacyTeamSetupExpectation(value.expectation) &&
		isLegacyTeamSetupDeviceActions(value.actions)
	);
}

function isLegacyTeamSetupProject(value: unknown): value is LegacyTeamSetupProjectV1 {
	if (!isJsonRecord(value)) return false;
	return (
		typeof value.projectRef === "string" &&
		typeof value.displayName === "string" &&
		typeof value.resolution === "string" &&
		["unresolved", "deterministic", "explicit"].includes(value.resolution) &&
		isStringOrNull(value.canonicalProjectRef) &&
		isStringOrNull(value.resolvedProjectRef) &&
		isArrayOf(
			value.mappingChoices,
			(item): item is { resolvedProjectRef: string; displayName: string } =>
				isJsonRecord(item) &&
				typeof item.resolvedProjectRef === "string" &&
				typeof item.displayName === "string",
		) &&
		isJsonRecord(value.actions) &&
		hasExactJsonKeys(value.actions, ["map"]) &&
		isLegacyTeamSetupActionGate(value.actions.map)
	);
}

function isLegacyTeamSetupAccessDelta(value: unknown): value is LegacyTeamSetupAccessDeltaV1 {
	if (!isJsonRecord(value)) return false;
	const validChange = (change: unknown) =>
		typeof change === "string" && ["add", "update", "remove"].includes(change);
	return (
		isArrayOf(
			value.teamChanges,
			(item): item is LegacyTeamSetupAccessDeltaV1["teamChanges"][number] =>
				isJsonRecord(item) &&
				typeof item.teamRef === "string" &&
				typeof item.teamDisplayName === "string" &&
				validChange(item.change) &&
				[null, "person_all_devices", "reviewed_allowlist"].includes(
					item.fromDeviceEligibilityMode as null | string,
				) &&
				item.toDeviceEligibilityMode === "reviewed_allowlist",
		) &&
		isArrayOf(
			value.membershipChanges,
			(item): item is LegacyTeamSetupAccessDeltaV1["membershipChanges"][number] =>
				isJsonRecord(item) &&
				typeof item.teamRef === "string" &&
				typeof item.teamDisplayName === "string" &&
				typeof item.identityRef === "string" &&
				typeof item.identityDisplayName === "string" &&
				validChange(item.change),
		) &&
		isArrayOf(
			value.projectChanges,
			(item): item is LegacyTeamSetupAccessDeltaV1["projectChanges"][number] =>
				isJsonRecord(item) &&
				typeof item.projectRef === "string" &&
				typeof item.projectDisplayName === "string" &&
				isStringOrNull(item.fromResolvedProjectRef) &&
				isStringOrNull(item.fromResolvedProjectDisplayName) &&
				isStringOrNull(item.toResolvedProjectRef) &&
				isStringOrNull(item.toResolvedProjectDisplayName) &&
				validChange(item.change),
		) &&
		isArrayOf(
			value.recipientChanges,
			(item): item is LegacyTeamSetupAccessDeltaV1["recipientChanges"][number] =>
				isJsonRecord(item) &&
				typeof item.canonicalProjectRef === "string" &&
				typeof item.canonicalProjectDisplayName === "string" &&
				item.recipientKind === "team" &&
				typeof item.recipientRef === "string" &&
				typeof item.recipientDisplayName === "string" &&
				validChange(item.change),
		) &&
		isArrayOf(
			value.deviceAccessChanges,
			(item): item is LegacyTeamSetupAccessDeltaV1["deviceAccessChanges"][number] =>
				isJsonRecord(item) &&
				typeof item.canonicalProjectRef === "string" &&
				typeof item.canonicalProjectDisplayName === "string" &&
				typeof item.deviceRef === "string" &&
				typeof item.deviceDisplayName === "string" &&
				typeof item.change === "string" &&
				["add", "remove"].includes(item.change),
		)
	);
}

function isLegacyTeamSetupViewActions(value: unknown): value is LegacyTeamSetupViewV1["actions"] {
	return (
		isJsonRecord(value) &&
		hasExactJsonKeys(value, ["finish", "refresh"]) &&
		isLegacyTeamSetupActionGate(value.refresh) &&
		isLegacyTeamSetupActionGate(value.finish)
	);
}

function hasDisabledItemActions(
	devices: LegacyTeamSetupDeviceV1[],
	projects: LegacyTeamSetupProjectV1[],
	reason: "setup_unavailable" | "setup_completed",
): boolean {
	return (
		devices.every((device) =>
			Object.values(device.actions).every((gate) => !gate.enabled && gate.blockedReason === reason),
		) &&
		projects.every(
			(project) => !project.actions.map.enabled && project.actions.map.blockedReason === reason,
		)
	);
}

export function isLegacyTeamSetupView(value: unknown): value is LegacyTeamSetupDetailResponseV1 {
	if (!isJsonRecord(value)) return false;
	const validBase =
		value.version === LEGACY_TEAM_SETUP_VERSION &&
		isLegacyTeamSetupCandidateSummary(value.candidate) &&
		typeof value.attemptId === "string" &&
		typeof value.state === "string" &&
		LEGACY_TEAM_SETUP_VIEW_STATES.has(value.state) &&
		isNonNegativeInteger(value.unresolvedDeviceCount) &&
		isNonNegativeInteger(value.unresolvedProjectCount) &&
		isArrayOf(value.devices, isLegacyTeamSetupDevice) &&
		isArrayOf(value.projects, isLegacyTeamSetupProject) &&
		isLegacyTeamSetupViewActions(value.actions) &&
		isArrayOf(
			value.identityChoices,
			(item): item is LegacyTeamSetupIdentityChoiceV1 =>
				isJsonRecord(item) &&
				typeof item.identityRef === "string" &&
				typeof item.displayName === "string",
		);
	if (!validBase) return false;
	const actions = value.actions as LegacyTeamSetupViewV1["actions"];
	const devices = value.devices as LegacyTeamSetupDeviceV1[];
	const projects = value.projects as LegacyTeamSetupProjectV1[];
	const baseKeys = [
		"actions",
		"attemptId",
		"candidate",
		"devices",
		"identityChoices",
		"projects",
		"state",
		"unresolvedDeviceCount",
		"unresolvedProjectCount",
		"version",
	] as const;
	if (value.state === "ready_to_finish") {
		return (
			hasExactJsonKeys(value, [
				...baseKeys,
				"accessDelta",
				"accessDeltaDigest",
				"finishDigest",
				"viewerAccessDeltaDigest",
			]) &&
			actions.refresh.enabled === true &&
			actions.finish.enabled === true &&
			typeof value.finishDigest === "string" &&
			typeof value.accessDeltaDigest === "string" &&
			typeof value.viewerAccessDeltaDigest === "string" &&
			isLegacyTeamSetupAccessDelta(value.accessDelta)
		);
	}
	if (value.state === "unavailable") {
		return (
			hasExactJsonKeys(value, [...baseKeys, "unavailableReason"]) &&
			typeof value.unavailableReason === "string" &&
			LEGACY_TEAM_SETUP_ERROR_CODES.has(value.unavailableReason as LegacyTeamSetupErrorCode) &&
			actions.refresh.enabled === true &&
			actions.finish.enabled === false &&
			actions.finish.blockedReason === "setup_unavailable" &&
			hasDisabledItemActions(devices, projects, "setup_unavailable")
		);
	}
	if (value.state === "completed") {
		return (
			hasExactJsonKeys(value, baseKeys) &&
			actions.refresh.enabled === false &&
			actions.refresh.blockedReason === "setup_completed" &&
			actions.finish.enabled === false &&
			actions.finish.blockedReason === "setup_completed" &&
			hasDisabledItemActions(devices, projects, "setup_completed")
		);
	}
	return (
		hasExactJsonKeys(value, baseKeys) &&
		value.state === "reviewing" &&
		actions.refresh.enabled === true &&
		actions.finish.enabled === false &&
		actions.finish.blockedReason === "setup_incomplete"
	);
}

function isLegacyTeamSetupFinish(value: unknown): value is LegacyTeamSetupFinishResponseV1 {
	return (
		isJsonRecord(value) &&
		value.version === LEGACY_TEAM_SETUP_VERSION &&
		value.status === "completed" &&
		typeof value.teamRef === "string" &&
		typeof value.attemptId === "string" &&
		typeof value.accessDeltaDigest === "string" &&
		typeof value.completedAt === "string"
	);
}

export class LegacyTeamSetupApiError extends Error {
	constructor(
		readonly statusCode: number,
		readonly errorCode: LegacyTeamSetupErrorCode,
	) {
		super(errorCode);
		this.name = "LegacyTeamSetupApiError";
	}
}

function legacyTeamSetupPath(candidateRef?: string): string {
	return candidateRef
		? `/api/sync/team-setup/v1/${encodeURIComponent(candidateRef)}`
		: "/api/sync/team-setup/v1";
}

async function legacyTeamSetupRequest<T>(
	path: string,
	isPayload: (value: unknown) => value is T,
	init?: RequestInit,
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, init);
	} catch {
		throw new LegacyTeamSetupApiError(0, "team_setup_failed");
	}
	let payload: unknown;
	try {
		const text = await response.text();
		if (!text) throw new Error("empty Team setup response");
		payload = JSON.parse(text) as unknown;
	} catch {
		throw new LegacyTeamSetupApiError(response.status, "team_setup_failed");
	}
	if (!response.ok) {
		const submittedCode =
			payload &&
			typeof payload === "object" &&
			"error" in payload &&
			typeof payload.error === "string"
				? payload.error
				: "";
		const errorCode = LEGACY_TEAM_SETUP_ERROR_CODES.has(submittedCode as LegacyTeamSetupErrorCode)
			? (submittedCode as LegacyTeamSetupErrorCode)
			: "team_setup_failed";
		throw new LegacyTeamSetupApiError(response.status, errorCode);
	}
	if (!isPayload(payload)) {
		throw new LegacyTeamSetupApiError(response.status, "team_setup_failed");
	}
	return payload;
}

function legacyTeamSetupJson(method: "PUT" | "POST" | "DELETE", body: unknown): RequestInit {
	return {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

export function loadLegacyTeamSetupSummary(): Promise<LegacyTeamSetupSummaryResponseV1> {
	return legacyTeamSetupRequest(legacyTeamSetupPath(), isLegacyTeamSetupSummary);
}

export function loadLegacyTeamSetupDetail(
	candidateRef: string,
): Promise<LegacyTeamSetupDetailResponseV1> {
	return legacyTeamSetupRequest(legacyTeamSetupPath(candidateRef), isLegacyTeamSetupView);
}

export function saveLegacyTeamSetupAssignment(
	candidateRef: string,
	deviceRef: string,
	input: {
		attemptId: string;
		targetIdentityRef: string;
		expectation: LegacyTeamSetupAssignmentExpectationV1;
	},
): Promise<LegacyTeamSetupMutationResponseV1> {
	return legacyTeamSetupRequest(
		`${legacyTeamSetupPath(candidateRef)}/devices/${encodeURIComponent(deviceRef)}/assignment`,
		isLegacyTeamSetupView,
		legacyTeamSetupJson("PUT", input),
	);
}

export function saveLegacyTeamSetupDecision(
	candidateRef: string,
	deviceRef: string,
	input:
		| { attemptId: string; decision: "included"; expectedTargetIdentityRef: string }
		| { attemptId: string; decision: "excluded" | "removed" },
): Promise<LegacyTeamSetupMutationResponseV1> {
	return legacyTeamSetupRequest(
		`${legacyTeamSetupPath(candidateRef)}/devices/${encodeURIComponent(deviceRef)}/decision`,
		isLegacyTeamSetupView,
		legacyTeamSetupJson("PUT", input),
	);
}

export function clearLegacyTeamSetupDecision(
	candidateRef: string,
	deviceRef: string,
	input: { attemptId: string },
): Promise<LegacyTeamSetupMutationResponseV1> {
	return legacyTeamSetupRequest(
		`${legacyTeamSetupPath(candidateRef)}/devices/${encodeURIComponent(deviceRef)}/decision`,
		isLegacyTeamSetupView,
		legacyTeamSetupJson("DELETE", input),
	);
}

export function saveLegacyTeamSetupProjectMapping(
	candidateRef: string,
	projectRef: string,
	input: { attemptId: string; resolvedProjectRef: string },
): Promise<LegacyTeamSetupMutationResponseV1> {
	return legacyTeamSetupRequest(
		`${legacyTeamSetupPath(candidateRef)}/projects/${encodeURIComponent(projectRef)}/mapping`,
		isLegacyTeamSetupView,
		legacyTeamSetupJson("PUT", input),
	);
}

export function refreshLegacyTeamSetupCandidate(
	candidateRef: string,
): Promise<LegacyTeamSetupMutationResponseV1> {
	return legacyTeamSetupRequest(
		`${legacyTeamSetupPath(candidateRef)}/refresh`,
		isLegacyTeamSetupView,
		legacyTeamSetupJson("POST", {}),
	);
}

export function finishLegacyTeamSetup(
	candidateRef: string,
	input: {
		attemptId: string;
		finishDigest: string;
		confirmedAccessDeltaDigest: string;
		confirmedViewerAccessDeltaDigest: string;
	},
): Promise<LegacyTeamSetupFinishResponseV1> {
	return legacyTeamSetupRequest(
		`${legacyTeamSetupPath(candidateRef)}/finish`,
		isLegacyTeamSetupFinish,
		legacyTeamSetupJson("POST", input),
	);
}

export type RecipientPolicyReconciliationReadState =
	| "active"
	| "needs_attention"
	| "pending"
	| "verifying"
	| "waiting";

export interface RecipientPolicyReconciliationStatusV1 {
	version: 1;
	items: Array<{
		canonicalProjectIdentity: string;
		state: RecipientPolicyReconciliationReadState;
		label: string;
		explanation: string;
		deliveredCopiesMayRemain: true;
		revocationWarning: string;
	}>;
}

export interface RecipientPolicyEdgeChangeV1 {
	canonicalProjectIdentity: string;
	recipient: RecipientPolicyEdgeRecipientRefV1;
	action: "add" | "remove";
}

export interface RecipientPolicyEdgePreviewRequestV1 {
	version: 1;
	changes: RecipientPolicyEdgeChangeV1[];
}

export interface RecipientPolicyEdgeCommitRequestV1 extends RecipientPolicyEdgePreviewRequestV1 {
	reviewedPolicyDigest: string;
}

export interface RecipientPolicyEdgePreviewProjectV1 {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
	futureMemoriesShared: true;
}

export interface RecipientPolicyEdgeIdentitySummaryV1 {
	identityId: string;
	displayName: string;
	verification: "local";
}

export type RecipientPolicyEdgeSelectedRecipientV1 =
	| ({ recipientKind: "identity" } & RecipientPolicyEdgeIdentitySummaryV1)
	| {
			recipientKind: "team";
			teamId: string;
			displayName: string;
			currentMembers: RecipientPolicyEdgeIdentitySummaryV1[];
			futureMembersInherit: true;
	  };

export interface RecipientPolicyEdgeEffectiveDeviceV1 {
	canonicalProjectIdentity: string;
	identityId: string;
	deviceId: string;
	displayName: string;
}

export interface RecipientPolicyEdgePreviewResponseV1 {
	version: 1;
	normalizedChanges: RecipientPolicyEdgeChangeV1[];
	outcomes: RecipientPolicyEdgeCommitOutcomeV1[];
	projects: RecipientPolicyEdgePreviewProjectV1[];
	selectedRecipients: RecipientPolicyEdgeSelectedRecipientV1[];
	effectiveDevices: RecipientPolicyEdgeEffectiveDeviceV1[];
	unchangedProjects: RecipientPolicyEdgePreviewProjectV1[];
	reviewedPolicyDigest: string;
	addCount: number;
	removeCount: number;
	netWriteCount: number;
}

export type RecipientPolicyEdgeOutcomeV1 =
	| "added"
	| "removed"
	| "already_present"
	| "already_absent";

export interface RecipientPolicyEdgeCommitOutcomeV1 {
	change: RecipientPolicyEdgeChangeV1;
	outcome: RecipientPolicyEdgeOutcomeV1;
}

export interface RecipientPolicyEdgeCommitResultV1 {
	version: 1;
	status: "applied" | "stale" | "invalid" | "not_found" | "conflict";
	reviewedPolicyDigest: string;
	errorCode: string | null;
	outcomes: RecipientPolicyEdgeCommitOutcomeV1[];
	writeCount: number;
	idempotent: boolean;
}

export class RecipientPolicyEdgesStaleError extends Error {
	result: RecipientPolicyEdgeCommitResultV1;

	constructor(result: RecipientPolicyEdgeCommitResultV1) {
		super("Recipient policy changed after review");
		this.name = "RecipientPolicyEdgesStaleError";
		this.result = result;
	}
}

export function loadRecipientPolicyIntent(): Promise<RecipientPolicyIntentGraphV1> {
	return fetchJson<RecipientPolicyIntentGraphV1>("/api/sync/recipient-policy/v1/intent");
}

export function loadDeviceIdentityInventory(): Promise<DeviceIdentityInventoryV1> {
	return fetchJson<DeviceIdentityInventoryV1>("/api/sync/recipient-policy/v1/device-inventory");
}

async function deviceIdentityBindingRequest<T>(
	path: string,
	input: DeviceIdentityBindingPreviewRequestV1 & { reviewedInventoryDigest?: string },
): Promise<T> {
	const resp = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const { text, payload } = await readJsonPayload<
		(DeviceIdentityBindingPreviewV1 | DeviceIdentityBindingCommitV1) & { error?: string }
	>(resp);
	if (!resp.ok) {
		const errorCode =
			payload?.errorCode || payload?.error || payloadError(payload) || text || "request_failed";
		const result = payload && "status" in payload ? payload : null;
		throw new DeviceIdentityBindingApiError(resp.status, errorCode, result);
	}
	return payload as T;
}

export function previewDeviceIdentityBindings(
	input: DeviceIdentityBindingPreviewRequestV1,
): Promise<DeviceIdentityBindingPreviewV1> {
	return deviceIdentityBindingRequest(
		"/api/sync/recipient-policy/v1/device-bindings/preview",
		input,
	);
}

export function commitDeviceIdentityBindings(
	input: DeviceIdentityBindingPreviewRequestV1 & { reviewedInventoryDigest: string },
): Promise<DeviceIdentityBindingCommitV1> {
	return deviceIdentityBindingRequest(
		"/api/sync/recipient-policy/v1/device-bindings/commit",
		input,
	);
}

export function loadRecipientPolicyReconciliationStatus(): Promise<RecipientPolicyReconciliationStatusV1> {
	return fetchJson<RecipientPolicyReconciliationStatusV1>(
		"/api/sync/recipient-policy/v1/reconciliation-status",
	);
}

async function recipientPolicyEdgeRequest<T>(
	path: string,
	input: RecipientPolicyEdgePreviewRequestV1 | RecipientPolicyEdgeCommitRequestV1,
): Promise<T> {
	const resp = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const { text, payload } = await readJsonPayload<T>(resp);
	if (!resp.ok) {
		if (
			resp.status === 409 &&
			payload &&
			typeof payload === "object" &&
			(payload as unknown as RecipientPolicyEdgeCommitResultV1).status === "stale"
		) {
			throw new RecipientPolicyEdgesStaleError(
				payload as unknown as RecipientPolicyEdgeCommitResultV1,
			);
		}
		if (
			resp.status === 409 &&
			payload &&
			typeof payload === "object" &&
			(payload as unknown as RecipientPolicyEdgeCommitResultV1).status === "conflict"
		) {
			return payload as T;
		}
		const edgeErrorCode =
			payload && typeof payload === "object" && "errorCode" in payload
				? String((payload as { errorCode?: unknown }).errorCode ?? "")
				: "";
		throw new Error(edgeErrorCode || payloadError(payload) || text || "request failed");
	}
	return payload as T;
}

export function previewRecipientPolicyEdges(
	input: RecipientPolicyEdgePreviewRequestV1,
): Promise<RecipientPolicyEdgePreviewResponseV1> {
	return recipientPolicyEdgeRequest("/api/sync/recipient-policy/v1/edges/preview", input);
}

export function commitRecipientPolicyEdges(
	input: RecipientPolicyEdgeCommitRequestV1,
): Promise<RecipientPolicyEdgeCommitResultV1> {
	return recipientPolicyEdgeRequest("/api/sync/recipient-policy/v1/edges/commit", input);
}

async function recipientInviteRequest<T>(
	path: string,
	input: RecipientInvitePreviewRequest & { reviewed_onboarding_digest?: string },
): Promise<T> {
	const resp = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const { text, payload } = await readJsonPayload<T>(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload as T;
}

export function previewRecipientInvite(
	input: RecipientInvitePreviewRequest,
): Promise<RecipientInvitePreviewResult> {
	return recipientInviteRequest("/api/sync/recipient-policy/v1/invites/preview", input);
}

export function createRecipientInvite(
	input: RecipientInvitePreviewRequest & { reviewed_onboarding_digest: string },
): Promise<CreatedRecipientInvite> {
	return recipientInviteRequest("/api/sync/recipient-policy/v1/invites", input);
}

export async function loadRecipientPolicyReview(): Promise<RecipientPolicyReviewListV1> {
	const review = await fetchJson<
		Omit<RecipientPolicyReviewListV1, "continuity"> & {
			continuity?: RecipientPolicyReviewListV1["continuity"];
		}
	>("/api/sync/recipient-policy/v1/review");
	if (review.continuity !== undefined) return { ...review, continuity: review.continuity };
	return {
		...review,
		continuity:
			review.reviewItems.length > 0
				? { state: "legacy_access_preserved", findingCount: review.reviewItems.length }
				: null,
	};
}

export async function resolveRecipientPolicyReview(
	input: RecipientPolicyReviewResolveRequestV1,
): Promise<RecipientPolicyReviewResolveResultV1> {
	const resp = await fetch("/api/sync/recipient-policy/v1/review/resolve", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const { text, payload } = await readJsonPayload<RecipientPolicyReviewResolveResultV1>(resp);
	if (!resp.ok) {
		if (resp.status === 409 && payload?.status === "stale") {
			throw new RecipientPolicyReviewStaleError(payload);
		}
		throw new Error(payloadError(payload) || text || "request failed");
	}
	return payload as RecipientPolicyReviewResolveResultV1;
}

export async function resolveRecipientPolicyReviewBulk(
	requests: RecipientPolicyReviewResolveRequestV1[],
): Promise<RecipientPolicyReviewBulkResultV1> {
	const resp = await fetch("/api/sync/recipient-policy/v1/review/resolve-bulk", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ requests }),
	});
	const { text, payload } = await readJsonPayload<RecipientPolicyReviewBulkResultV1>(resp);
	if (!resp.ok && resp.status !== 207) {
		throw new Error(payloadError(payload) || text || "request failed");
	}
	return payload as RecipientPolicyReviewBulkResultV1;
}

export async function loadSharingDomainSettings(): Promise<SharingDomainSettings> {
	return fetchJson<SharingDomainSettings>("/api/sync/sharing-domains/settings");
}

export async function loadProjectScopeInventory(
	input: {
		identity_source?: string;
		limit?: number;
		offset?: number;
		q?: string;
		scope_id?: string;
		status?: string;
	} = {},
): Promise<ProjectScopeInventoryResult> {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(input)) {
		if (value == null || value === "") continue;
		params.set(key, String(value));
	}
	const query = params.toString();
	return fetchJson<ProjectScopeInventoryResult>(`/api/sync/projects${query ? `?${query}` : ""}`);
}

async function projectInviteRequest<T>(
	path: string,
	input: { teammate_name: string; project_ids: string[]; reviewed_project_set_digest?: string },
): Promise<T> {
	const resp = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const { text, payload } = await readJsonPayload<T>(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload as T;
}

export function previewProjectInvite(input: {
	teammate_name: string;
	project_ids: string[];
}): Promise<ProjectInvitePreview> {
	return projectInviteRequest("/api/sync/project-invites/preview", input);
}

export function createProjectInvite(input: {
	teammate_name: string;
	project_ids: string[];
	reviewed_project_set_digest: string;
}): Promise<CreatedProjectInvite> {
	return projectInviteRequest("/api/sync/project-invites", input);
}

export function loadShareOperations(): Promise<ShareOperationList> {
	return fetchJson<ShareOperationList>("/api/sync/share-operations");
}

export function loadShareOperation(operationId: string): Promise<ShareOperationReadModel> {
	return fetchJson<ShareOperationReadModel>(
		`/api/sync/share-operations/${encodeURIComponent(operationId)}`,
	);
}

export async function advanceShareOperation(operationId: string): Promise<ShareOperationReadModel> {
	const resp = await fetch(
		`/api/sync/share-operations/${encodeURIComponent(operationId)}/advance`,
		{ method: "POST" },
	);
	const { text, payload } = await readJsonPayload<{
		error?: string;
		operation?: ShareOperationReadModel;
	}>(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	if (!payload?.operation) throw new Error("response missing share operation");
	return payload.operation;
}

export async function saveSharingDomainProjectMapping(input: {
	id?: number | null;
	workspace_identity?: string | null;
	project_pattern?: string | null;
	scope_id: string;
	priority?: number | null;
	confirmed_guardrail_tokens?: string[];
}): Promise<ProjectScopeMapping> {
	const resp = await fetch("/api/sync/sharing-domains/project-mappings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const { text, payload } = await readJsonPayload<{
		error?: string;
		mapping?: ProjectScopeMapping;
		required_guardrails?: string[];
		required_guardrail_tokens?: string[];
		guardrail_warnings?: ProjectScopeGuardrailWarning[];
	}>(resp);
	if (!resp.ok) {
		if (payload?.error === "guardrail_confirmation_required") {
			throw new SharingDomainGuardrailConfirmationError(payload);
		}
		throw new Error(payloadError(payload) || text || "request failed");
	}
	const mapping = payload?.mapping;
	if (!mapping) throw new Error("response missing mapping");
	return {
		...mapping,
		guardrail_warnings: payload.guardrail_warnings ?? mapping.guardrail_warnings,
	};
}

export async function saveSharingDomainProjectMappings(input: {
	mappings: ProjectMappingBulkInput[];
}): Promise<ProjectScopeMapping[]> {
	const resp = await fetch("/api/sync/sharing-domains/project-mappings/bulk", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const { text, payload } = await readJsonPayload<{
		error?: string;
		mappings?: ProjectScopeMapping[];
		required_guardrails?: string[];
		required_guardrail_tokens?: string[];
		guardrail_warnings?: ProjectScopeGuardrailWarning[];
	}>(resp);
	if (!resp.ok) {
		if (payload?.error === "guardrail_confirmation_required") {
			throw new SharingDomainGuardrailConfirmationError(payload);
		}
		throw new Error(payloadError(payload) || text || "request failed");
	}
	if (!Array.isArray(payload?.mappings)) throw new Error("response missing mappings");
	return payload.mappings;
}

export async function deleteSharingDomainProjectMapping(id: number): Promise<boolean> {
	const resp = await fetch(`/api/sync/sharing-domains/project-mappings/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	const { text, payload } = await readJsonPayload<{ deleted?: boolean }>(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return Boolean(payload?.deleted);
}

export async function reassignProjectInventoryProject(input: {
	workspace_identity: string;
	project: string;
}): Promise<ProjectReassignmentResult> {
	const resp = await fetch("/api/sync/projects/reassign-project", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const { text, payload } = await readJsonPayload<ProjectReassignmentResult & { error?: string }>(
		resp,
	);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	if (!payload?.workspace_identity) throw new Error("response missing project reassignment");
	return payload;
}

export async function forgetProjectInventoryMemories(input: {
	confirmation_token?: string;
	confirmed?: boolean;
	workspace_identity: string;
}): Promise<ProjectForgetResult> {
	const resp = await fetch("/api/sync/projects/forget", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const { text, payload } = await readJsonPayload<
		ProjectForgetResult & { error?: string; preview?: ProjectForgetPreview }
	>(resp);
	if (!resp.ok) {
		if (payload?.error === "project_forget_confirmation_required" && payload.preview) {
			throw new ProjectForgetConfirmationError(payload.preview);
		}
		throw new Error(payloadError(payload) || text || "request failed");
	}
	if (!payload?.workspace_identity) throw new Error("response missing project forget result");
	return payload;
}

export async function reassignLegacySharedReviewGroup(input: {
	workspace_identity: string;
	scope_id: string;
	confirmation_token?: string;
	confirmed_old_copies?: boolean;
}): Promise<LegacySharedReviewReassignmentResult> {
	const resp = await fetch("/api/sync/legacy-shared-review/reassign", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const { text, payload } = await readJsonPayload<
		LegacySharedReviewReassignmentResult & {
			error?: string;
			preview?: LegacySharedReviewReassignmentPreview;
		}
	>(resp);
	if (!resp.ok) {
		if (payload?.error === "legacy_review_confirmation_required" && payload.preview) {
			throw new LegacySharedReviewConfirmationError(payload.preview);
		}
		throw new Error(payloadError(payload) || text || "request failed");
	}
	if (!payload?.workspace_identity) throw new Error("response missing legacy review reassignment");
	return payload;
}

export async function loadCoordinatorGroupPreferences(
	groupId: string,
): Promise<CoordinatorGroupPreferences> {
	const resp = await fetch(
		`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/preferences`,
	);
	const { text, payload } = await readJsonPayload<{
		preferences?: CoordinatorGroupPreferences;
	}>(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	const prefs = payload?.preferences;
	if (!prefs) throw new Error("response missing preferences");
	return prefs;
}

export async function saveCoordinatorGroupPreferences(
	groupId: string,
	input: {
		projects_include?: string[] | null;
		projects_exclude?: string[] | null;
		auto_seed_scope?: boolean;
		default_space_scope_id?: string | null;
		auto_grant_default_space_on_join?: boolean;
	},
): Promise<CoordinatorGroupPreferences> {
	const resp = await fetch(
		`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/preferences`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	const { text, payload } = await readJsonPayload<{
		preferences?: CoordinatorGroupPreferences;
	}>(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	const prefs = payload?.preferences;
	if (!prefs) throw new Error("response missing preferences");
	return prefs;
}

export interface EnrollPeerResult {
	ok?: boolean;
	peer_device_id?: string;
	created?: boolean;
	updated?: boolean;
	name?: string | null;
	group_id?: string | null;
	error?: string;
	detail?: string;
}

export type EnrollPeerMode = "discovered" | "manual";

export interface EnrollPeerPayload {
	mode?: EnrollPeerMode;
	peer_device_id?: string;
	fingerprint?: string;
	peer_public_key?: string;
	peer_addresses?: string[];
	name?: string | null;
	projects_include?: string[] | null;
	projects_exclude?: string[] | null;
}

/**
 * Unified peer enrollment endpoint.
 *
 * Pass `payload.mode = "manual"` to pair a peer by `peer_public_key`
 * directly — `groupId` is ignored and discovery attribution stays null.
 * Otherwise (default `"discovered"`), `groupId` must be a real coordinator
 * group id and the peer is promoted from the discovered list, seeded
 * with the group's scope template when `auto_seed_scope` is true.
 */
export async function enrollPeer(
	groupId: string,
	payload: EnrollPeerPayload,
): Promise<EnrollPeerResult> {
	const resp = await fetch(
		`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/enroll-peer`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: payload.mode ?? "discovered", ...payload }),
		},
	);
	const text = await resp.text();
	let body: EnrollPeerResult = {};
	try {
		const parsed = text ? JSON.parse(text) : null;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			body = parsed as EnrollPeerResult;
		}
	} catch {
		body = {};
	}
	if (!resp.ok) {
		const msg = typeof body.detail === "string" ? body.detail : payloadError(body) || text;
		throw new Error(msg || "request failed");
	}
	return body;
}

export async function createActor(displayName: string): Promise<unknown> {
	const resp = await fetch("/api/sync/actors", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ display_name: displayName }),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function renameActor(actorId: string, displayName: string): Promise<unknown> {
	const resp = await fetch("/api/sync/actors/rename", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ actor_id: actorId, display_name: displayName }),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function mergeActor(
	primaryActorId: string,
	secondaryActorId: string,
): Promise<unknown> {
	const resp = await fetch("/api/sync/actors/merge", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			primary_actor_id: primaryActorId,
			secondary_actor_id: secondaryActorId,
		}),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function deactivateActor(actorId: string): Promise<unknown> {
	const resp = await fetch("/api/sync/actors/deactivate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ actor_id: actorId }),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function claimLegacyDeviceIdentity(originDeviceId: string): Promise<unknown> {
	const resp = await fetch("/api/sync/legacy-devices/claim", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ origin_device_id: originDeviceId }),
	});
	const { text, payload } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function triggerSync(target?: string | TriggerSyncTarget): Promise<SyncRunResponse> {
	const address = typeof target === "string" ? target.trim() : target?.address?.trim();
	const peerDeviceId = typeof target === "string" ? "" : target?.peerDeviceId?.trim();
	const payload: Record<string, string> = {};
	if (address) payload.address = address;
	if (peerDeviceId) payload.peer_device_id = peerDeviceId;
	const resp = await fetch("/api/sync/run", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const { text, payload: body } = await readJsonPayload<SyncRunResponse>(resp);
	if (!resp.ok) throw new Error(payloadError(body) || text || "request failed");
	if (!text) throw new Error("empty sync response");
	if (!Array.isArray(body?.items)) throw new Error(text || "invalid sync response");
	return body;
}
