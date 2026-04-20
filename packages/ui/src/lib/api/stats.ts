/* Stats + usage endpoints consumed by the Health tab — raw pipeline
 * state, per-project token usage, session summaries, and raw-event
 * queue counters. All are simple GETs so the module stays thin. */

import { fetchJson } from "./internal";

export async function loadStats(): Promise<unknown> {
	return fetchJson("/api/stats");
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
