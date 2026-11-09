/* Memory + summary + pack-trace endpoints — paginated list fetches
 * keyed off the current project, visibility toggles and forget
 * actions on individual memories, and the pack-trace debug call used
 * by the Inspector. */

import type { FeedContextResponse } from "@codemem/core/feed-contract";
import { buildProjectParams, fetchJson, payloadError, readJsonPayload } from "./internal";
import type { PackTrace, PaginatedResponse } from "./types";

export async function loadMemories(project: string): Promise<PaginatedResponse> {
	return loadMemoriesPage(project);
}

export async function loadMemoriesPage(
	project: string,
	options?: {
		limit?: number;
		offset?: number;
		scope?: string;
		q?: string;
		signal?: AbortSignal;
		view?: "feed";
	},
): Promise<PaginatedResponse> {
	const query = buildProjectParams(
		project,
		options?.limit,
		options?.offset,
		options?.scope,
		options?.q,
	);
	const view = options?.view === "feed" ? "&view=feed" : "";
	return fetchJson<PaginatedResponse>(`/api/observations?${query}${view}`, {
		signal: options?.signal,
	});
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

export async function moveMemoryProject(
	memoryId: number,
	project: string,
): Promise<{ session_id: number; project: string; moved_memory_count: number }> {
	const resp = await fetch("/api/memories/project", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ memory_id: memoryId, project }),
	});
	const { text, payload } = await readJsonPayload<{
		session_id: number;
		project: string;
		moved_memory_count: number;
	}>(resp);
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
	options?: {
		limit?: number;
		offset?: number;
		scope?: string;
		q?: string;
		signal?: AbortSignal;
		view?: "feed";
	},
): Promise<PaginatedResponse> {
	const query = buildProjectParams(
		project,
		options?.limit,
		options?.offset,
		options?.scope,
		options?.q,
	);
	const view = options?.view === "feed" ? "&view=feed" : "";
	return fetchJson<PaginatedResponse>(`/api/summaries?${query}${view}`, {
		signal: options?.signal,
	});
}

export async function loadMemoryContext(options: {
	id: number;
	project?: string;
	scope?: string;
	q?: string;
	classification?: "observation" | "summary";
	signal?: AbortSignal;
}): Promise<FeedContextResponse> {
	if (!Number.isSafeInteger(options.id) || options.id <= 0) {
		throw new Error("Invalid memory id.");
	}
	const query = new URLSearchParams();
	for (const key of ["project", "scope", "q", "classification"] as const) {
		if (options[key] !== undefined) query.set(key, options[key]);
	}
	try {
		const result = await fetchJson<unknown>(`/api/memory/${options.id}/context?${query}`, {
			signal: options.signal,
			cache: "no-store",
		});
		if (!result || typeof result !== "object") throw new Error("Invalid context response.");
		const response = result as Partial<FeedContextResponse>;
		if (
			!Number.isSafeInteger(response.id) ||
			response.id !== options.id ||
			typeof response.revision !== "string" ||
			typeof response.context !== "string"
		) {
			throw new Error("Invalid context response.");
		}
		return { id: Number(response.id), revision: response.revision, context: response.context };
	} catch {
		// Fetch failures can include URLs containing the user's search text.
		if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
		throw new Error("Full context unavailable. Try again.");
	}
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
