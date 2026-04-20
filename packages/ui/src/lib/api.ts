/* API fetch wrappers — thin layer over the viewer HTTP endpoints. */

import { buildProjectParams, fetchJson, payloadError, readJsonPayload } from "./api/internal";

export {
	archiveCoordinatorAdminGroup,
	createCoordinatorAdminGroup,
	createCoordinatorInvite,
	disableCoordinatorAdminDevice,
	enableCoordinatorAdminDevice,
	loadCoordinatorAdminDevices,
	loadCoordinatorAdminGroups,
	loadCoordinatorAdminGroupsFiltered,
	loadCoordinatorAdminJoinRequests,
	loadCoordinatorAdminStatus,
	removeCoordinatorAdminDevice,
	renameCoordinatorAdminDevice,
	renameCoordinatorAdminGroup,
	reviewCoordinatorAdminJoinRequest,
	unarchiveCoordinatorAdminGroup,
} from "./api/coordinator-admin";

import type {
	AcceptDiscoveredPeerResult,
	ImportInviteResult,
	PackTrace,
	PaginatedResponse,
	RuntimeInfo,
	SyncRunResponse,
} from "./api/types";

export type {
	AcceptDiscoveredPeerResult,
	CoordinatorInviteResult,
	ImportInviteResult,
	PackTrace,
	PackTraceCandidate,
	PaginatedResponse,
	RuntimeInfo,
	SyncRunItem,
	SyncRunResponse,
} from "./api/types";

export async function pingViewerReady(timeoutMs = 1200): Promise<void> {
	const controller = new AbortController();
	const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch("/api/stats", {
			cache: "no-store",
			signal: controller.signal,
		});
		if (!resp.ok) throw new Error(`/api/stats: ${resp.status} ${resp.statusText}`);
	} finally {
		window.clearTimeout(timeoutId);
	}
}

export async function loadStats(): Promise<unknown> {
	return fetchJson("/api/stats");
}

export async function loadRuntimeInfo(): Promise<RuntimeInfo> {
	return fetchJson("/api/runtime");
}

export async function loadUsage(project: string): Promise<unknown> {
	return fetchJson(`/api/usage?project=${encodeURIComponent(project)}`);
}

export async function loadSession(project: string): Promise<unknown> {
	return fetchJson(`/api/session?project=${encodeURIComponent(project)}`);
}

export async function loadRawEvents(project: string): Promise<unknown> {
	return fetchJson(`/api/raw-events?project=${encodeURIComponent(project)}`);
}

export async function loadMemories(project: string): Promise<PaginatedResponse> {
	return loadMemoriesPage(project);
}

export async function loadMemoriesPage(
	project: string,
	options?: { limit?: number; offset?: number; scope?: string },
): Promise<PaginatedResponse> {
	const query = buildProjectParams(project, options?.limit, options?.offset, options?.scope);
	return fetchJson<PaginatedResponse>(`/api/observations?${query}`);
}

export async function updateMemoryVisibility(
	memoryId: number,
	visibility: "private" | "shared",
): Promise<{ item?: unknown }> {
	const resp = await fetch("/api/memories/visibility", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ memory_id: memoryId, visibility }),
	});
	const { text, payload } = await readJsonPayload<{ item?: unknown }>(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function forgetMemory(memoryId: number): Promise<{ status?: string }> {
	const resp = await fetch("/api/memories/forget", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ memory_id: memoryId }),
	});
	const { text, payload } = await readJsonPayload<{ status?: string }>(resp);
	if (!resp.ok) throw new Error(payloadError(payload) || text || "request failed");
	return payload;
}

export async function loadSummaries(project: string): Promise<PaginatedResponse> {
	return loadSummariesPage(project);
}

export async function loadSummariesPage(
	project: string,
	options?: { limit?: number; offset?: number; scope?: string },
): Promise<PaginatedResponse> {
	const query = buildProjectParams(project, options?.limit, options?.offset, options?.scope);
	return fetchJson<PaginatedResponse>(`/api/summaries?${query}`);
}

export async function tracePack(payload: {
	context: string;
	project?: string | null;
	working_set_files?: string[];
	token_budget?: number | null;
	limit?: number;
}): Promise<PackTrace> {
	const resp = await fetch("/api/pack/trace", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const { text, payload: data } = await readJsonPayload<PackTrace>(resp);
	if (!resp.ok) throw new Error(payloadError(data) || text || "request failed");
	return data;
}

export async function loadObserverStatus(): Promise<unknown> {
	return fetchJson("/api/observer-status");
}

export async function loadConfig(): Promise<unknown> {
	return fetchJson("/api/config");
}

export async function saveConfig(payload: Record<string, unknown>): Promise<unknown> {
	const resp = await fetch("/api/config", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const text = await resp.text();
	let parsed: unknown = null;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {}
	}
	if (!resp.ok) {
		const message = payloadError(parsed) || text || "request failed";
		throw new Error(message);
	}
	return parsed;
}

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

export async function loadPairing(): Promise<unknown> {
	return fetchJson("/api/sync/pairing?includeDiagnostics=1");
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
	fingerprint: string,
): Promise<AcceptDiscoveredPeerResult> {
	const resp = await fetch("/api/sync/peers/accept-discovered", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			peer_device_id: peerDeviceId,
			fingerprint,
		}),
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

export async function loadProjects(): Promise<string[]> {
	const payload = await fetchJson<{ projects?: string[] }>("/api/projects");
	return payload.projects || [];
}

export async function triggerSync(address?: string): Promise<SyncRunResponse> {
	const payload = address ? { address } : {};
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
