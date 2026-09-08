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

/** SQL equivalent of isSummaryLikeMemory for a trusted memory-items table alias. */
export function summaryLikeSqlPredicate(alias: "memory_items" | "mi" = "memory_items"): string {
	const kind = `${alias}.kind`;
	const metadata = `${alias}.metadata_json`;
	return `(
		LOWER(TRIM(COALESCE(${kind}, ''))) = 'session_summary'
		OR CASE WHEN json_valid(COALESCE(${metadata}, '')) = 1 THEN (
			COALESCE(json_type(${metadata}, '$.is_summary') = 'true', 0)
			OR LOWER(TRIM(COALESCE(json_extract(${metadata}, '$.source'), ''))) = 'observer_summary'
		) ELSE 0 END
	)`;
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

export function summaryContinuityFilter(summarySessionId?: number | null): {
	clauses: string[];
	params: number[];
} {
	if (summarySessionId === undefined) return { clauses: [], params: [] };
	const predicate = summaryLikeSqlPredicate();
	if (summarySessionId === null) return { clauses: [`NOT ${predicate}`], params: [] };
	return {
		clauses: [`(NOT ${predicate} OR memory_items.session_id = ?)`],
		params: [summarySessionId],
	};
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
