/* Coordinator-admin viewer endpoints — status, group CRUD, join
 * request review, device lifecycle, invite creation. All requests go
 * through the viewer's /api/coordinator/admin/* proxy so the browser
 * never sees the admin secret directly. */

import { fetchJson, payloadError, readJsonPayload } from "./internal";
import type { CoordinatorInviteResult } from "./types";

export async function loadCoordinatorAdminStatus(): Promise<unknown> {
	return fetchJson("/api/coordinator/admin/status");
}

export async function loadCoordinatorAdminGroups(): Promise<unknown> {
	return fetchJson("/api/coordinator/admin/groups");
}

export async function loadCoordinatorAdminGroupsFiltered(
	includeArchived: boolean,
): Promise<unknown> {
	const suffix = includeArchived ? "?include_archived=1" : "";
	return fetchJson(`/api/coordinator/admin/groups${suffix}`);
}

export async function createCoordinatorAdminGroup(payload: {
	group_id: string;
	display_name?: string | null;
}): Promise<unknown> {
	const resp = await fetch("/api/coordinator/admin/groups", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function renameCoordinatorAdminGroup(
	groupId: string,
	displayName: string,
): Promise<unknown> {
	const resp = await fetch(`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/rename`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ display_name: displayName }),
	});
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function archiveCoordinatorAdminGroup(groupId: string): Promise<unknown> {
	const resp = await fetch(`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/archive`, {
		method: "POST",
	});
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function unarchiveCoordinatorAdminGroup(groupId: string): Promise<unknown> {
	const resp = await fetch(
		`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/unarchive`,
		{
			method: "POST",
		},
	);
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export interface CoordinatorAdminScopePayload {
	scope_id?: string;
	label?: string | null;
	kind?: string | null;
	authority_type?: string | null;
	coordinator_id?: string | null;
	manifest_issuer_device_id?: string | null;
	membership_epoch?: number | null;
	manifest_hash?: string | null;
	status?: string | null;
}

export interface CoordinatorAdminScopeMemberPayload {
	device_id?: string;
	role?: string | null;
	membership_epoch?: number | null;
	coordinator_id?: string | null;
	manifest_issuer_device_id?: string | null;
	manifest_hash?: string | null;
	signed_manifest_json?: string | null;
}

export async function loadCoordinatorAdminScopes(
	groupId: string,
	includeInactive = false,
): Promise<unknown> {
	const params = new URLSearchParams();
	if (includeInactive) params.set("include_inactive", "1");
	const suffix = params.size ? `?${params.toString()}` : "";
	return fetchJson(`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/scopes${suffix}`);
}

export async function createCoordinatorAdminScope(
	groupId: string,
	payload: CoordinatorAdminScopePayload & { scope_id: string; label: string },
): Promise<unknown> {
	const resp = await fetch(`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/scopes`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function updateCoordinatorAdminScope(
	groupId: string,
	scopeId: string,
	payload: Omit<CoordinatorAdminScopePayload, "scope_id">,
): Promise<unknown> {
	const resp = await fetch(
		`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function loadCoordinatorAdminScopeMembers(
	groupId: string,
	scopeId: string,
	includeRevoked = false,
): Promise<unknown> {
	const params = new URLSearchParams();
	if (includeRevoked) params.set("include_revoked", "1");
	const suffix = params.size ? `?${params.toString()}` : "";
	return fetchJson(
		`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}/members${suffix}`,
	);
}

export async function grantCoordinatorAdminScopeMember(
	groupId: string,
	scopeId: string,
	payload: CoordinatorAdminScopeMemberPayload & { device_id: string },
): Promise<unknown> {
	const resp = await fetch(
		`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}/members`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function revokeCoordinatorAdminScopeMember(
	groupId: string,
	scopeId: string,
	deviceId: string,
	payload: Omit<CoordinatorAdminScopeMemberPayload, "device_id"> = {},
): Promise<unknown> {
	const resp = await fetch(
		`/api/coordinator/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}/members/${encodeURIComponent(deviceId)}/revoke`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function loadCoordinatorAdminJoinRequests(groupId?: string | null): Promise<unknown> {
	const params = new URLSearchParams();
	if (groupId) params.set("group_id", groupId);
	const suffix = params.size ? `?${params.toString()}` : "";
	return fetchJson(`/api/coordinator/admin/join-requests${suffix}`);
}

export async function loadCoordinatorAdminDevices(
	groupId?: string | null,
	includeDisabled = true,
): Promise<unknown> {
	const params = new URLSearchParams();
	if (groupId) params.set("group_id", groupId);
	if (includeDisabled) params.set("include_disabled", "1");
	const suffix = params.size ? `?${params.toString()}` : "";
	return fetchJson(`/api/coordinator/admin/devices${suffix}`);
}

export async function reviewCoordinatorAdminJoinRequest(
	requestId: string,
	action: "approve" | "deny",
): Promise<unknown> {
	const resp = await fetch(
		`/api/coordinator/admin/join-requests/${encodeURIComponent(requestId)}/${action}`,
		{
			method: "POST",
		},
	);
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function renameCoordinatorAdminDevice(
	deviceId: string,
	groupId: string,
	displayName: string,
): Promise<unknown> {
	const resp = await fetch(
		`/api/coordinator/admin/devices/${encodeURIComponent(deviceId)}/rename`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ group_id: groupId, display_name: displayName }),
		},
	);
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function disableCoordinatorAdminDevice(
	deviceId: string,
	groupId: string,
): Promise<unknown> {
	const resp = await fetch(
		`/api/coordinator/admin/devices/${encodeURIComponent(deviceId)}/disable?group_id=${encodeURIComponent(groupId)}`,
		{ method: "POST" },
	);
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function enableCoordinatorAdminDevice(
	deviceId: string,
	groupId: string,
): Promise<unknown> {
	const resp = await fetch(
		`/api/coordinator/admin/devices/${encodeURIComponent(deviceId)}/enable?group_id=${encodeURIComponent(groupId)}`,
		{ method: "POST" },
	);
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function removeCoordinatorAdminDevice(
	deviceId: string,
	groupId: string,
): Promise<unknown> {
	const resp = await fetch(
		`/api/coordinator/admin/devices/${encodeURIComponent(deviceId)}/remove?group_id=${encodeURIComponent(groupId)}`,
		{
			method: "POST",
		},
	);
	const { text, payload: data } = await readJsonPayload(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function createCoordinatorInvite(payload: {
	group_id: string;
	coordinator_url?: string;
	policy: "auto_admit" | "approval_required";
	ttl_hours: number;
}): Promise<CoordinatorInviteResult> {
	const resp = await fetch("/api/coordinator/admin/invites", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const { text, payload: data } = await readJsonPayload<CoordinatorInviteResult>(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}
