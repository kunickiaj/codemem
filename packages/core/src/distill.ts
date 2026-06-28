import type { MemoryStore } from "./store.js";
import type { MemoryFilters, MemoryItemResponse } from "./types.js";
import { resolveSemanticSearchModel } from "./vectors.js";

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
	title: string;
	text: string;
	concepts: string[];
	project: string | null;
}

export interface DistillVectorFeature extends ContextFactFeature {
	vector?: Float32Array;
}

export interface DistillCluster {
	representative_id: number;
	member_ids: number[];
	overlap_concepts: string[];
	overlap_words: string[];
	signal: "semantic" | "concept" | "title";
}

export interface DistillClusterOptions {
	semanticThreshold?: number;
	semanticWithConceptThreshold?: number;
	minConceptOverlap?: number;
	minTitleWordOverlap?: number;
}

export const DEFAULT_CONTEXT_FACT_KINDS = ["discovery", "decision"] as const;

const DEFAULT_BATCH_SIZE = 500;
const VECTOR_LOOKUP_BATCH_SIZE = 500;
const SESSION_LOOKUP_BATCH_SIZE = 500;

const CLUSTER_STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"to",
	"in",
	"for",
	"of",
	"on",
	"with",
	"is",
	"was",
	"are",
	"were",
	"from",
	"this",
	"that",
	"it",
	"not",
	"no",
]);

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

function significantWords(text: string): Set<string> {
	return new Set(
		(text.toLowerCase().match(/\w+/g) ?? []).filter(
			(word) => word.length > 2 && !CLUSTER_STOP_WORDS.has(word),
		),
	);
}

function overlap(a: Set<string>, b: Set<string>): string[] {
	return [...a].filter((item) => b.has(item)).sort();
}

function cosine(a: Float32Array, b: Float32Array): number | null {
	if (a.length !== b.length) return null;
	const length = a.length;
	if (length === 0) return null;

	let dot = 0;
	let aNorm = 0;
	let bNorm = 0;
	for (let i = 0; i < length; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		aNorm += av * av;
		bNorm += bv * bv;
	}
	if (aNorm === 0 || bNorm === 0) return null;
	return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function deserializeFloat32(value: unknown): Float32Array | null {
	if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength % 4 !== 0) {
		return null;
	}
	const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
	const vector = new Float32Array(value.byteLength / 4);
	for (let i = 0; i < vector.length; i++) vector[i] = view.getFloat32(i * 4, true);
	return vector;
}

function average(vectors: Float32Array[]): Float32Array | undefined {
	const first = vectors[0];
	if (!first) return undefined;
	const result = new Float32Array(first.length);
	for (const vector of vectors) {
		for (let i = 0; i < first.length; i++) result[i] = (result[i] ?? 0) + (vector[i] ?? 0);
	}
	for (let i = 0; i < result.length; i++) result[i] = (result[i] ?? 0) / vectors.length;
	return result;
}

function signalRank(signal: DistillCluster["signal"] | undefined): number {
	if (signal === "semantic") return 3;
	if (signal === "concept") return 2;
	if (signal === "title") return 1;
	return 0;
}

function strongerSignal(
	...signals: Array<DistillCluster["signal"] | undefined>
): DistillCluster["signal"] {
	return signals.toSorted((a, b) => signalRank(b) - signalRank(a))[0] ?? "title";
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
			title: item.title,
			text: [item.title, narrative ?? body ?? ""].filter(Boolean).join("\n\n"),
			concepts: parseJsonList(item.concepts),
			project: clean(item.project),
		};
	});
}

function loadSessionProjects(store: MemoryStore, sessionIds: number[]): Map<number, string | null> {
	const result = new Map<number, string | null>();
	if (sessionIds.length === 0) return result;

	try {
		for (let start = 0; start < sessionIds.length; start += SESSION_LOOKUP_BATCH_SIZE) {
			const batch = sessionIds.slice(start, start + SESSION_LOOKUP_BATCH_SIZE);
			const placeholders = batch.map(() => "?").join(", ");
			const rows = store.db
				.prepare(`SELECT id, project FROM sessions WHERE id IN (${placeholders})`)
				.all(...batch) as Array<Record<string, unknown>>;
			for (const row of rows) {
				const id = Number(row.id);
				if (!Number.isFinite(id)) continue;
				result.set(id, clean(typeof row.project === "string" ? row.project : null));
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/no such table:\s*sessions/i.test(message)) throw error;
	}

	return result;
}

export function loadDistillVectorFeatures(
	store: MemoryStore,
	items: MemoryItemResponse[],
): DistillVectorFeature[] {
	const projectedFeatures = projectContextFactFeatures(items);
	if (projectedFeatures.length === 0) return [];

	// Project attribution is canonical on sessions.project; moveMemoryProject()
	// only updates that column and leaves memory_items.project stale. Resolve the
	// session project so candidate routing never points at a stale target.
	const sessionIdByMemory = new Map<number, number | null>(
		items.map((item) => [item.id, item.session_id]),
	);
	const projectBySession = loadSessionProjects(store, [
		...new Set(
			items
				.map((item) => item.session_id)
				.filter((sessionId): sessionId is number => typeof sessionId === "number"),
		),
	]);
	const baseFeatures = projectedFeatures.map((feature) => {
		const sessionId = sessionIdByMemory.get(feature.memory_id);
		const sessionProject =
			typeof sessionId === "number" ? projectBySession.get(sessionId) : undefined;
		// Prefer the canonical session project, but keep the denormalized
		// memory-row project when the session has none (e.g. replicated rows whose
		// project was backfilled only on memory_items.project).
		if (sessionProject != null) return { ...feature, project: sessionProject };
		return feature;
	});

	const vectorsByMemory = new Map<number, Float32Array[]>();
	const model = resolveSemanticSearchModel(store.db);
	if (!model) return baseFeatures;

	try {
		for (let start = 0; start < baseFeatures.length; start += VECTOR_LOOKUP_BATCH_SIZE) {
			const batch = baseFeatures.slice(start, start + VECTOR_LOOKUP_BATCH_SIZE);
			const placeholders = batch.map(() => "?").join(", ");
			const rows = store.db
				.prepare(
					`SELECT memory_id, embedding FROM memory_vectors
					 WHERE model = ? AND memory_id IN (${placeholders})
					 ORDER BY memory_id ASC, chunk_index ASC`,
				)
				.all(model, ...batch.map((feature) => feature.memory_id)) as Array<Record<string, unknown>>;

			for (const row of rows) {
				const memoryId = Number(row.memory_id);
				const vector = deserializeFloat32(row.embedding);
				if (!Number.isFinite(memoryId) || !vector) continue;
				const existing = vectorsByMemory.get(memoryId);
				if (existing) existing.push(vector);
				else vectorsByMemory.set(memoryId, [vector]);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/no such (table|module):\s*(memory_vectors|vec0)/i.test(message)) throw error;
	}

	return baseFeatures.map((feature) => {
		const vector = average(vectorsByMemory.get(feature.memory_id) ?? []);
		return vector ? { ...feature, vector } : feature;
	});
}

export function clusterDistillFeatures(
	features: DistillVectorFeature[],
	options: DistillClusterOptions = {},
): DistillCluster[] {
	// BGE-small embeddings have a high baseline cosine, so a low threshold makes
	// single-linkage union-find collapse the whole corpus into one cluster.
	// ~0.92 yields coherent "same lesson restated" clusters on a real store; tune
	// via the CLI/MCP similarity flag.
	const semanticThreshold = options.semanticThreshold ?? 0.92;
	const semanticWithConceptThreshold = options.semanticWithConceptThreshold ?? 0.9;
	const minConceptOverlap = options.minConceptOverlap ?? 2;
	const minTitleWordOverlap = options.minTitleWordOverlap ?? 3;

	const parent = new Map<number, number>();
	const signalByRoot = new Map<number, DistillCluster["signal"]>();
	for (const feature of features) parent.set(feature.memory_id, feature.memory_id);

	const find = (id: number): number => {
		const current = parent.get(id);
		if (current == null) throw new Error(`missing cluster parent for ${id}`);
		if (current === id) return id;
		const root = find(current);
		parent.set(id, root);
		return root;
	};
	const union = (a: number, b: number, signal: DistillCluster["signal"]): void => {
		const aRoot = find(a);
		const bRoot = find(b);
		const root = Math.min(aRoot, bRoot);
		const child = Math.max(aRoot, bRoot);
		if (root !== child) parent.set(child, root);
		signalByRoot.set(
			root,
			strongerSignal(signalByRoot.get(aRoot), signalByRoot.get(bRoot), signal),
		);
	};

	const conceptSets = new Map(
		features.map((feature) => [
			feature.memory_id,
			new Set(feature.concepts.map((item) => item.toLowerCase())),
		]),
	);
	const wordSets = new Map(
		features.map((feature) => [feature.memory_id, significantWords(feature.title)]),
	);

	for (let i = 0; i < features.length; i++) {
		for (let j = i + 1; j < features.length; j++) {
			const a = features[i];
			const b = features[j];
			if (!a || !b) continue;

			const sharedConcepts = overlap(
				conceptSets.get(a.memory_id) ?? new Set(),
				conceptSets.get(b.memory_id) ?? new Set(),
			);
			const similarity = a.vector && b.vector ? cosine(a.vector, b.vector) : null;
			// When both memories are embedded, cluster on semantics only. Concept
			// and title overlap are a fallback for un-embedded memories, NOT an
			// additional union path: generic concept tags (e.g. "decision",
			// "security") otherwise chain unrelated memories transitively into one
			// giant cluster.
			if (similarity != null) {
				if (
					similarity >= semanticThreshold ||
					(similarity >= semanticWithConceptThreshold && sharedConcepts.length > 0)
				) {
					union(a.memory_id, b.memory_id, "semantic");
				}
				continue;
			}
			// The lexical fallback applies only when NEITHER member is embedded.
			// In a partially indexed store, letting a mixed pair fall through
			// would let one unembedded memory with generic concepts bridge
			// embedded clusters whose semantic comparisons already failed.
			if (a.vector || b.vector) continue;
			if (sharedConcepts.length >= minConceptOverlap) {
				union(a.memory_id, b.memory_id, "concept");
				continue;
			}
			const sharedWords = overlap(
				wordSets.get(a.memory_id) ?? new Set(),
				wordSets.get(b.memory_id) ?? new Set(),
			);
			if (sharedWords.length >= minTitleWordOverlap) union(a.memory_id, b.memory_id, "title");
		}
	}

	const byRoot = new Map<number, DistillVectorFeature[]>();
	for (const feature of features) {
		const root = find(feature.memory_id);
		const existing = byRoot.get(root);
		if (existing) existing.push(feature);
		else byRoot.set(root, [feature]);
	}

	return [...byRoot.entries()]
		.map(([root, cluster]) => {
			const sorted = cluster.toSorted((a, b) => a.memory_id - b.memory_id);
			if (sorted.length < 2) return null;
			const conceptSetsForCluster = sorted.map(
				(feature) => conceptSets.get(feature.memory_id) ?? new Set<string>(),
			);
			const wordSetsForCluster = sorted.map(
				(feature) => wordSets.get(feature.memory_id) ?? new Set<string>(),
			);
			return {
				representative_id: sorted[0]?.memory_id ?? root,
				member_ids: sorted.map((feature) => feature.memory_id),
				overlap_concepts: [...(conceptSetsForCluster[0] ?? new Set<string>())]
					.filter((concept) => conceptSetsForCluster.every((set) => set.has(concept)))
					.sort(),
				overlap_words: [...(wordSetsForCluster[0] ?? new Set<string>())]
					.filter((word) => wordSetsForCluster.every((set) => set.has(word)))
					.sort(),
				signal: signalByRoot.get(root) ?? "title",
			};
		})
		.filter((cluster): cluster is DistillCluster => cluster != null)
		.toSorted((a, b) => a.representative_id - b.representative_id);
}

export function createContextFactDetector(): DistillDetector<ContextFactFeature> {
	return {
		artifactKind: "context_fact",
		select: selectDistillCorpus,
		project: projectContextFactFeatures,
	};
}
