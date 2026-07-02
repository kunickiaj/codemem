import type { MemoryStore } from "./store.js";
import type { MemoryFilters, MemoryItemResponse } from "./types.js";

export type DistillScope = "project" | "user";

export type ArtifactKind = "context_fact" | "skill";

export interface DistillCandidate {
	scope: DistillScope;
	suggested_target: string | null;
	score: number;
	recurrence: number;
	projects: string[];
	member_ids: number[];
	representative_id: number;
	concepts: string[];
	artifact_kind: ArtifactKind;
	evidence: string[];
	draft_text: string | null;
}

export interface DistillCorpusOptions {
	kinds?: string[];
	filters?: MemoryFilters | null;
	batchSize?: number;
	limit?: number;
}

export interface DistillDetector<TFeature> {
	artifactKind: ArtifactKind;
	select(store: MemoryStore, options?: DistillCorpusOptions): MemoryItemResponse[];
	project(items: MemoryItemResponse[]): TFeature[];
}

export interface ContextFactFeature {
	memory_id: number;
	text: string;
	concepts: string[];
	project: string | null;
}

export const DEFAULT_CONTEXT_FACT_KINDS = ["discovery", "decision"] as const;

const DEFAULT_BATCH_SIZE = 500;

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function parseJsonList(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed
					.filter((item): item is string => typeof item === "string")
					.map((item) => item.trim())
					.filter(Boolean)
			: [];
	} catch {
		return [];
	}
}

function normalizeKinds(kinds: string[] | undefined): string[] {
	const normalized = (kinds ?? [...DEFAULT_CONTEXT_FACT_KINDS])
		.map((kind) => kind.trim().toLowerCase())
		.filter(Boolean);
	return [...new Set(normalized)];
}

function compareCorpusItems(a: MemoryItemResponse, b: MemoryItemResponse): number {
	const created = b.created_at.localeCompare(a.created_at);
	if (created !== 0) return created;
	return b.id - a.id;
}

export function selectDistillCorpus(
	store: MemoryStore,
	options: DistillCorpusOptions = {},
): MemoryItemResponse[] {
	const kinds = normalizeKinds(options.kinds);
	if (kinds.length === 0) return [];

	const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
	const limit =
		options.limit == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.limit));
	if (limit === 0) return [];

	const results: MemoryItemResponse[] = [];
	let offset = 0;
	while (results.length < limit) {
		const remaining = Math.min(batchSize, limit - results.length);
		const batch = store.recentByKinds(kinds, remaining, options.filters ?? null, offset);
		results.push(...batch);
		if (batch.length < remaining) break;
		offset += batch.length;
	}

	return results.toSorted(compareCorpusItems);
}

export function projectContextFactFeatures(items: MemoryItemResponse[]): ContextFactFeature[] {
	return items.map((item) => {
		const narrative = clean(item.narrative);
		const body = clean(item.body_text);
		return {
			memory_id: item.id,
			text: [item.title, narrative ?? body ?? ""].filter(Boolean).join("\n\n"),
			concepts: parseJsonList(item.concepts),
			project: clean(item.project),
		};
	});
}

export function createContextFactDetector(): DistillDetector<ContextFactFeature> {
	return {
		artifactKind: "context_fact",
		select: selectDistillCorpus,
		project: projectContextFactFeatures,
	};
}
