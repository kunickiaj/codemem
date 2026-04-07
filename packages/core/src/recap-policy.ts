import { isSummaryLikeMemory } from "./summary-memory.js";
import type { MemoryResult } from "./types.js";

export function queryPrefersRecap(query: string): boolean {
	const lowered = query.toLowerCase();
	for (const token of ["summarize", "summarise", "recap"]) {
		if (lowered.includes(token)) return true;
	}
	for (const phrase of [
		"summary of",
		"summary for",
		"summary on",
		"show summary",
		"session summary",
		"catch me up",
		"catch up",
		"what happened",
		"where were we",
	]) {
		if (lowered.includes(phrase)) return true;
	}
	if (lowered === "summary") return true;
	if (lowered.startsWith("summary ")) return true;
	return false;
}

export function memoryLooksRecapLike(
	item: Pick<MemoryResult, "kind" | "title" | "body_text" | "metadata">,
): boolean {
	if (isSummaryLikeMemory(item)) return true;
	const metadata = item.metadata ?? {};
	if (metadata.source === "observer_summary") return true;
	if (typeof metadata.request === "string" && typeof metadata.completed === "string") return true;
	const text = `${item.title} ${item.body_text}`.toLowerCase();
	for (const marker of ["session recap", "wrap-up", "wrap up", "recap", "## request"]) {
		if (text.includes(marker)) return true;
	}
	return false;
}
