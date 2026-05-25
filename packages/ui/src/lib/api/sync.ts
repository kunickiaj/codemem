/* Sync-domain viewer endpoints — status, invite import, peer
 * lifecycle (accept, rename, delete, scope, identity), actor CRUD, and
 * the manual sync-now trigger. Every request in this file hits
 * /api/sync/* or /api/sync/run/* on the viewer. */

import { fetchJson, payloadError, readJsonPayload } from "./internal";
import type { AcceptDiscoveredPeerResult, ImportInviteResult, SyncRunResponse } from "./types";

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

export async function importCoordinatorInvite(invite: string): Promise<ImportInviteResult> {
	const resp = await fetch("/api/sync/invites/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ invite }),
	});
	const { text, payload: data } = await readJsonPayload<ImportInviteResult>(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
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
	| "suggested"
	| "unmapped";

export interface ProjectScopeInventoryProject extends ProjectScopeCandidate {
	memory_count: number | null;
	session_count: number;
	statuses: ProjectScopeInventoryStatus[];
}

export interface ProjectScopeInventoryResult {
	projects: ProjectScopeInventoryProject[];
	total: number;
	limit: number;
	offset: number;
	has_more: boolean;
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
