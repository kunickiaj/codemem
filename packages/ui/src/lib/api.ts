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

export {
	acceptDiscoveredPeer,
	assignPeerActor,
	claimLegacyDeviceIdentity,
	createActor,
	deactivateActor,
	deletePeer,
	importCoordinatorInvite,
	loadPairing,
	loadSyncActors,
	loadSyncStatus,
	mergeActor,
	renameActor,
	renamePeer,
	triggerSync,
	updatePeerIdentity,
	updatePeerScope,
} from "./api/sync";

import type { PackTrace, PaginatedResponse, RuntimeInfo } from "./api/types";

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

export async function loadProjects(): Promise<string[]> {
	const payload = await fetchJson<{ projects?: string[] }>("/api/projects");
	return payload.projects || [];
}
