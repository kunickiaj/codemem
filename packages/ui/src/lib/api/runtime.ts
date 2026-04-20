/* Runtime-info endpoints — viewer readiness probe, build/version
 * info, and project list. Kept separate from stats so the tiny
 * readiness ping does not pull in the stats payload helpers. */

import { fetchJson } from "./internal";
import type { RuntimeInfo } from "./types";

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

export async function loadRuntimeInfo(): Promise<RuntimeInfo> {
	return fetchJson("/api/runtime");
}

export async function loadProjects(): Promise<string[]> {
	const payload = await fetchJson<{ projects?: string[] }>("/api/projects");
	return payload.projects || [];
}
