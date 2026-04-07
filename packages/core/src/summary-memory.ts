import type { MemoryResult } from "./types.js";

type SummaryLikeInput = {
	kind?: string | null;
	metadata?: unknown;
};

function parseMetadataObject(value: unknown): Record<string, unknown> {
	if (!value) return {};
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			return {};
		} catch {
			return {};
		}
	}
	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

export function getSummaryMetadata(metadata: unknown): Record<string, unknown> {
	return parseMetadataObject(metadata);
}

export function isSummaryLikeMemory(input: SummaryLikeInput): boolean {
	const kindValue = String(input.kind ?? "")
		.trim()
		.toLowerCase();
	if (kindValue === "session_summary") return true;
	const metadata = getSummaryMetadata(input.metadata);
	if (metadata.is_summary === true) return true;
	return (
		String(metadata.source ?? "")
			.trim()
			.toLowerCase() === "observer_summary"
	);
}

export function isNativeSessionSummaryMemory(input: SummaryLikeInput): boolean {
	const kindValue = String(input.kind ?? "")
		.trim()
		.toLowerCase();
	if (kindValue !== "session_summary") return false;
	const metadata = getSummaryMetadata(input.metadata);
	if (metadata.is_summary === true) return false;
	return (
		String(metadata.source ?? "")
			.trim()
			.toLowerCase() !== "observer_summary"
	);
}

export function canonicalMemoryKind(kind: string | null | undefined, metadata?: unknown): string {
	const normalized = String(kind ?? "")
		.trim()
		.toLowerCase();
	if (isSummaryLikeMemory({ kind: normalized, metadata })) return "session_summary";
	return normalized || "change";
}

export function canonicalizeMemoryResultKind<T extends Pick<MemoryResult, "kind" | "metadata">>(
	item: T,
): T {
	return {
		...item,
		kind: canonicalMemoryKind(item.kind, item.metadata),
	};
}
