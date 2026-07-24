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
			onboarding: RecipientOnboardingPreviewV1;
	  };

export type RecipientInvitePreviewRequest =
	| { kind: "team_member"; policy_team_id: string }
	| { kind: "add_device"; target_identity_id: string };

export interface RecipientInvitePreviewResult {
	kind: RecipientInvitationKind;
	preview: RecipientOnboardingPreviewV1;
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
			recipient_name: string;
			device_name: string;
			reviewed_onboarding_digest: string;
	  };

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
): Promise<ImportInviteResult> {
	const resp = await fetch("/api/sync/invites/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ invite, ...identity }),
	});
	const { text, payload: data } = await readJsonPayload<ImportInviteResult>(resp);
	if (!resp.ok) {
		const detail = typeof data?.detail === "string" ? data.detail.trim() : "";
		throw new Error(detail || payloadError(data) || text || "request failed");
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
	fingerprint?: string,
): Promise<AcceptDiscoveredPeerResult> {
	const body: Record<string, string> = { peer_device_id: peerDeviceId };
	if (fingerprint) body.fingerprint = fingerprint;
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

export function loadRecipientPolicyReview(): Promise<RecipientPolicyReviewListV1> {
	return fetchJson<RecipientPolicyReviewListV1>("/api/sync/recipient-policy/v1/review");
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
