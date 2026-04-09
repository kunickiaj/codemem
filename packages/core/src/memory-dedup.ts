import { createHash } from "node:crypto";

export function normalizeMemoryDedupTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/\b(?:pr|pull\s+request|issue)\s*#?\d+\b/gi, " ")
		.replace(/^\s*#\d+\s*/g, " ")
		.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildMemoryDedupKey(title: string): string | null {
	const normalized = normalizeMemoryDedupTitle(title);
	const fallback = title.toLowerCase().replace(/\s+/g, " ").trim();
	const keySource = normalized || fallback;
	if (!keySource) return null;
	return createHash("sha256").update(keySource).digest("hex");
}
