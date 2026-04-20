/* Memory + summary + pack-trace endpoints — paginated list fetches
 * keyed off the current project, visibility toggles and forget
 * actions on individual memories, and the pack-trace debug call used
 * by the Inspector. */

import { buildProjectParams, fetchJson, payloadError, readJsonPayload } from "./internal";
import type { PackTrace, PaginatedResponse } from "./types";

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
