import { chunkText, embedTexts, hashText } from "./embeddings.js";
import { projectBasename } from "./project.js";
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
	session_id?: number | null;
	created_at?: string | null;
	confidence?: number | null;
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

export interface DistillPromotabilityScores {
	combined_score: number;
	member_count: number;
	session_count: number;
	time_span_days: number;
	mean_confidence: number;
	recurrence_score: number;
	session_spread_score: number;
	time_spread_score: number;
	recency_score: number;
}

export interface DistillScoredCluster extends DistillCluster {
	scores: DistillPromotabilityScores;
}

export interface DistillScoringOptions {
	referenceNow?: Date | string;
	maxRecurrenceCount?: number;
	maxSessionCount?: number;
	maxTimeSpreadDays?: number;
	recencyHalfLifeDays?: number;
}

export type DistillContextScope = "project" | "user";

export interface DistillContextDocument {
	path: string;
	text: string;
	/**
	 * Which routed candidate scope this document applies to. "project" docs (a
	 * repo AGENTS.md) must not suppress user/global candidates; "user" docs apply
	 * to both. Undefined means the document applies to every scope.
	 */
	scope?: DistillContextScope;
}

export interface DistillContextChunk {
	document_path: string;
	chunk_index: number;
	text: string;
	text_hash: string;
	vector?: Float32Array;
	scope?: DistillContextScope;
}

export type DistillDocumentationSignal = "semantic" | "exact" | "lexical";

export interface DistillDocumentationMatch {
	document_path: string;
	chunk_index: number;
	signal: DistillDocumentationSignal;
	score: number;
	overlap_words: string[];
}

export interface DistillDocumentedCluster extends DistillScoredCluster {
	already_documented: boolean;
	documentation_match: DistillDocumentationMatch | null;
}

export interface DistillContextDedupeOptions {
	minLexicalOverlap?: number;
	semanticThreshold?: number;
	lexicalThreshold?: number;
}

export interface DistillContextChunkOptions {
	maxChunkChars?: number;
}

export interface DistillCandidateEmitOptions {
	artifactKind?: ArtifactKind;
	includeDocumented?: boolean;
	maxEvidenceItems?: number;
	maxEvidenceChars?: number;
	projectTarget?: string;
	userTarget?: string;
}

export const DEFAULT_CONTEXT_FACT_KINDS = ["discovery", "decision"] as const;

const DEFAULT_BATCH_SIZE = 500;
const VECTOR_LOOKUP_BATCH_SIZE = 500;
const SESSION_LOOKUP_BATCH_SIZE = 500;
const DEFAULT_MAX_RECURRENCE_COUNT = 8;
const DEFAULT_MAX_SESSION_COUNT = 4;
const DEFAULT_MAX_TIME_SPREAD_DAYS = 21;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 60;
const DEFAULT_UNKNOWN_CONFIDENCE = 1;
const DEFAULT_CONTEXT_LEXICAL_THRESHOLD = 0.75;
const DEFAULT_CONTEXT_MIN_LEXICAL_OVERLAP = 3;
const DEFAULT_PROJECT_CONTEXT_TARGET = "AGENTS.md";
const DEFAULT_USER_CONTEXT_TARGET = "~/.config/opencode/AGENTS.md";
// Bodies can be very large (ingest allows ~2MB), so cap each evidence string.
// maxEvidenceItems caps how many entries; this caps the size of each entry.
const DEFAULT_EVIDENCE_CHAR_LIMIT = 600;
const MS_PER_DAY = 86_400_000;

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

function normalizeProjectPath(project: string): string {
	let normalized = project.replaceAll("\\", "/");
	while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
	return normalized;
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

function documentationSignalRank(signal: DistillDocumentationSignal): number {
	if (signal === "exact") return 3;
	if (signal === "semantic") return 2;
	return 1;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(Math.max(value, 0), 1);
}

function parseTime(value: string | null | undefined): number | null {
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : null;
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function betterDocumentationMatch(
	a: DistillDocumentationMatch | null,
	b: DistillDocumentationMatch,
): DistillDocumentationMatch {
	if (!a) return b;
	if (b.score !== a.score) return b.score > a.score ? b : a;
	const signalDiff = documentationSignalRank(b.signal) - documentationSignalRank(a.signal);
	if (signalDiff !== 0) return signalDiff > 0 ? b : a;
	const pathDiff = b.document_path.localeCompare(a.document_path);
	if (pathDiff !== 0) return pathDiff < 0 ? b : a;
	return b.chunk_index < a.chunk_index ? b : a;
}

function hasDocumentationStatus(
	cluster: DistillScoredCluster | DistillDocumentedCluster,
): cluster is DistillDocumentedCluster {
	return "already_documented" in cluster;
}

function compareDistillCandidates(a: DistillCandidate, b: DistillCandidate): number {
	if (b.score !== a.score) return b.score - a.score;
	if (b.recurrence !== a.recurrence) return b.recurrence - a.recurrence;
	return a.representative_id - b.representative_id;
}

function truncateEvidence(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit).trimEnd()}…`;
}

/**
 * Route a cluster's candidate scope from its members' projects. Project scope
 * requires every member to resolve to a single repo (basename aliases collapse;
 * distinct same-basename repos and unknown projects fall back to user scope).
 * Shared by candidate emission and scope-aware dedupe so both agree.
 */
function routeDistillScope(memberProjects: Array<string | null>): {
	scope: DistillScope;
	projects: string[];
} {
	const hasUnknownProject = memberProjects.some((project) => project == null);
	const projects = [
		...new Set(memberProjects.filter((project): project is string => project != null)),
	].sort();
	const normalizedProjects = projects.map(normalizeProjectPath);
	const distinctBasenames = new Set(
		normalizedProjects.map((project) => projectBasename(project) || project),
	);
	const distinctPathForms = new Set(
		normalizedProjects.filter((project) => {
			const base = projectBasename(project);
			return base !== "" && base !== project;
		}),
	);
	const isSingleRepo =
		projects.length > 0 && distinctBasenames.size === 1 && distinctPathForms.size <= 1;
	const scope: DistillScope = !hasUnknownProject && isSingleRepo ? "project" : "user";
	return { scope, projects };
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
			session_id: item.session_id,
			created_at: item.created_at,
			confidence: item.confidence,
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
			// giant cluster. A null similarity means at least one member lacks a
			// comparable vector, so the lexical fallback applies.
			if (similarity != null) {
				if (
					similarity >= semanticThreshold ||
					(similarity >= semanticWithConceptThreshold && sharedConcepts.length > 0)
				) {
					union(a.memory_id, b.memory_id, "semantic");
				}
				continue;
			}
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

export function scoreDistillCluster(
	cluster: DistillCluster,
	features: DistillVectorFeature[],
	options: DistillScoringOptions = {},
): DistillScoredCluster {
	const featureById = new Map(features.map((feature) => [feature.memory_id, feature]));
	const members = cluster.member_ids.flatMap((id) => {
		const feature = featureById.get(id);
		return feature ? [feature] : [];
	});
	const memberCount = members.length;
	const sessionCount = new Set(
		members
			.map((feature) => feature.session_id)
			.filter((sessionId): sessionId is number => typeof sessionId === "number"),
	).size;
	const times = members
		.map((feature) => parseTime(feature.created_at))
		.filter((time): time is number => time != null)
		.toSorted((a, b) => a - b);
	const firstTime = times[0] ?? null;
	const lastTime = times.at(-1) ?? null;
	const timeSpanDays =
		firstTime != null && lastTime != null ? (lastTime - firstTime) / MS_PER_DAY : 0;
	const confidences = members
		.map((feature) => feature.confidence)
		.filter(
			(confidence): confidence is number => confidence != null && Number.isFinite(confidence),
		);
	const meanConfidence = clamp01(
		confidences.length > 0 ? mean(confidences) : DEFAULT_UNKNOWN_CONFIDENCE,
	);

	const maxRecurrenceCount = Math.max(
		1,
		options.maxRecurrenceCount ?? DEFAULT_MAX_RECURRENCE_COUNT,
	);
	const maxSessionCount = Math.max(1, options.maxSessionCount ?? DEFAULT_MAX_SESSION_COUNT);
	const maxTimeSpreadDays = Math.max(1, options.maxTimeSpreadDays ?? DEFAULT_MAX_TIME_SPREAD_DAYS);
	const recencyHalfLifeDays = Math.max(
		1,
		options.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS,
	);
	const referenceNow =
		options.referenceNow instanceof Date
			? options.referenceNow.getTime()
			: (parseTime(options.referenceNow) ?? Date.now());

	const recurrenceScore = clamp01(Math.log2(memberCount + 1) / Math.log2(maxRecurrenceCount + 1));
	const sessionSpreadScore = 0.4 + 0.6 * clamp01(sessionCount / maxSessionCount);
	const timeSpreadScore = 0.4 + 0.6 * clamp01(timeSpanDays / maxTimeSpreadDays);
	const ageDays =
		lastTime == null
			? Number.POSITIVE_INFINITY
			: Math.max(0, (referenceNow - lastTime) / MS_PER_DAY);
	const recencyScore = lastTime == null ? 0 : 1 / (1 + ageDays / recencyHalfLifeDays);
	const recencyMultiplier = 0.95 + 0.1 * recencyScore;
	const combinedScore =
		recurrenceScore * sessionSpreadScore * timeSpreadScore * meanConfidence * recencyMultiplier;

	return {
		...cluster,
		scores: {
			combined_score: combinedScore,
			member_count: memberCount,
			session_count: sessionCount,
			time_span_days: timeSpanDays,
			mean_confidence: meanConfidence,
			recurrence_score: recurrenceScore,
			session_spread_score: sessionSpreadScore,
			time_spread_score: timeSpreadScore,
			recency_score: recencyScore,
		},
	};
}

export function scoreDistillClusters(
	clusters: DistillCluster[],
	features: DistillVectorFeature[],
	options: DistillScoringOptions = {},
): DistillScoredCluster[] {
	// Resolve the scoring clock once so every cluster in the batch shares the
	// same reference time. Otherwise Date.now() ticks between clusters and equal
	// clusters get different recency multipliers, making rank depend on timing.
	const scoringOptions: DistillScoringOptions =
		options.referenceNow == null ? { ...options, referenceNow: new Date() } : options;
	return clusters
		.map((cluster) => scoreDistillCluster(cluster, features, scoringOptions))
		.toSorted((a, b) => {
			if (b.scores.combined_score !== a.scores.combined_score) {
				return b.scores.combined_score - a.scores.combined_score;
			}
			if (b.scores.member_count !== a.scores.member_count) {
				return b.scores.member_count - a.scores.member_count;
			}
			if (b.scores.mean_confidence !== a.scores.mean_confidence) {
				return b.scores.mean_confidence - a.scores.mean_confidence;
			}
			return a.representative_id - b.representative_id;
		});
}

export function chunkDistillContextDocuments(
	documents: DistillContextDocument[],
	options: DistillContextChunkOptions = {},
): DistillContextChunk[] {
	// Guard against non-positive or fractional chunk sizes from flags/config:
	// chunkText advances its hard-split loop by maxChars, so a value that floors
	// to 0 (e.g. 0.5) would never progress and could hang on a long document.
	// Require the floored size to be at least 1, else fall back to the default.
	const flooredChunkChars =
		options.maxChunkChars != null ? Math.floor(options.maxChunkChars) : undefined;
	const maxChunkChars =
		flooredChunkChars != null && flooredChunkChars >= 1 ? flooredChunkChars : undefined;
	return documents.flatMap((document) => {
		const documentPath = clean(document.path) ?? "context";
		return chunkText(document.text, maxChunkChars)
			.map((chunk) => chunk.trim())
			.filter(Boolean)
			.map((chunk, index) => ({
				document_path: documentPath,
				chunk_index: index,
				text: chunk,
				text_hash: hashText(chunk),
				scope: document.scope,
			}));
	});
}

export async function embedDistillContextChunks(
	chunks: DistillContextChunk[],
): Promise<DistillContextChunk[]> {
	if (chunks.length === 0) return [];
	const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));
	return chunks.map((chunk, index) => {
		const vector = embeddings[index];
		return vector ? { ...chunk, vector } : chunk;
	});
}

// Exact + lexical matching for a single member against context chunks.
// Semantic (vector) matching is intentionally excluded: stored vectors are
// embedded from title+body while a distilled feature may prefer a divergent
// narrative, so a vector hit could wrongly suppress a net-new lesson.
// Exact matches require the full projected text, not the title alone, so a
// terse title (e.g. "Release") whose body carries the rule is not "documented"
// just because a chunk repeats that title.
function bestMemberDocumentationMatch(
	member: DistillVectorFeature,
	chunks: DistillContextChunk[],
	minLexicalOverlap: number,
	lexicalThreshold: number,
): DistillDocumentationMatch | null {
	const memberHash = hashText(member.text);
	const memberWords = significantWords(`${member.title}\n${member.text}`);
	let best: DistillDocumentationMatch | null = null;

	for (const chunk of chunks) {
		if (chunk.text_hash === memberHash) {
			best = betterDocumentationMatch(best, {
				document_path: chunk.document_path,
				chunk_index: chunk.chunk_index,
				signal: "exact",
				score: 1,
				overlap_words: overlap(memberWords, significantWords(chunk.text)),
			});
			continue;
		}

		const chunkWords = significantWords(chunk.text);
		const sharedWords = overlap(memberWords, chunkWords);
		const denominator = memberWords.size;
		const lexicalScore = denominator > 0 ? sharedWords.length / denominator : 0;
		if (sharedWords.length >= minLexicalOverlap && lexicalScore >= lexicalThreshold) {
			best = betterDocumentationMatch(best, {
				document_path: chunk.document_path,
				chunk_index: chunk.chunk_index,
				signal: "lexical",
				score: lexicalScore,
				overlap_words: sharedWords,
			});
		}
	}

	return best;
}

export function markDistillClustersDocumented(
	clusters: DistillScoredCluster[],
	features: DistillVectorFeature[],
	contextChunks: DistillContextChunk[],
	options: DistillContextDedupeOptions = {},
	clusterScopeByRepresentative?: ReadonlyMap<number, DistillContextScope>,
): DistillDocumentedCluster[] {
	const lexicalThreshold = options.lexicalThreshold ?? DEFAULT_CONTEXT_LEXICAL_THRESHOLD;
	const minLexicalOverlap = Math.max(
		1,
		Math.floor(options.minLexicalOverlap ?? DEFAULT_CONTEXT_MIN_LEXICAL_OVERLAP),
	);
	const featureById = new Map(features.map((feature) => [feature.memory_id, feature]));

	return clusters.map((cluster) => {
		const members = cluster.member_ids.flatMap((id) => {
			const feature = featureById.get(id);
			return feature ? [feature] : [];
		});
		// Project-scoped context docs (a repo AGENTS.md) must not suppress a
		// candidate routed to user/global scope. When the caller supplies the
		// routed scope, skip "project" chunks for "user" clusters.
		const clusterScope = clusterScopeByRepresentative?.get(cluster.representative_id);
		const eligibleChunks =
			clusterScope === "user"
				? contextChunks.filter((chunk) => chunk.scope !== "project")
				: contextChunks;

		// Suppress only when the docs cover EVERY member. A heterogeneous cluster
		// where one member is documented but another carries a net-new rule must
		// still surface, so coverage is required per member, not per cluster.
		const memberMatches = members.map((member) =>
			bestMemberDocumentationMatch(member, eligibleChunks, minLexicalOverlap, lexicalThreshold),
		);
		const allCovered = members.length > 0 && memberMatches.every((match) => match != null);
		const best = allCovered
			? memberMatches.reduce<DistillDocumentationMatch | null>(
					(acc, match) => (match ? betterDocumentationMatch(acc, match) : acc),
					null,
				)
			: null;

		return {
			...cluster,
			already_documented: allCovered,
			documentation_match: best,
		};
	});
}

export function emitDistillCandidates(
	clusters: Array<DistillScoredCluster | DistillDocumentedCluster>,
	features: DistillVectorFeature[],
	options: DistillCandidateEmitOptions = {},
): DistillCandidate[] {
	const featureById = new Map(features.map((feature) => [feature.memory_id, feature]));
	const artifactKind = options.artifactKind ?? "context_fact";
	const maxEvidenceItems = Math.max(1, Math.floor(options.maxEvidenceItems ?? 5));
	const maxEvidenceChars = Math.max(
		1,
		Math.floor(options.maxEvidenceChars ?? DEFAULT_EVIDENCE_CHAR_LIMIT),
	);

	return clusters
		.flatMap((cluster) => {
			if (
				hasDocumentationStatus(cluster) &&
				cluster.already_documented &&
				!options.includeDocumented
			) {
				return [];
			}

			const members = cluster.member_ids.flatMap((id) => {
				const feature = featureById.get(id);
				return feature ? [feature] : [];
			});
			const { scope, projects } = routeDistillScope(
				members.map((feature) => clean(feature.project)),
			);
			const concepts = [
				...new Set(
					(cluster.overlap_concepts.length > 0
						? cluster.overlap_concepts
						: members.flatMap((feature) => feature.concepts)
					).map((concept) => concept.toLowerCase()),
				),
			].sort();
			const evidence = members
				.toSorted((a, b) => a.memory_id - b.memory_id)
				.map((feature) => clean(feature.text) ?? clean(feature.title))
				.filter((text): text is string => text != null)
				.slice(0, maxEvidenceItems)
				.map((text) => truncateEvidence(text, maxEvidenceChars));

			return [
				{
					scope,
					suggested_target:
						scope === "project"
							? (options.projectTarget ?? DEFAULT_PROJECT_CONTEXT_TARGET)
							: (options.userTarget ?? DEFAULT_USER_CONTEXT_TARGET),
					score: cluster.scores.combined_score,
					recurrence: cluster.scores.member_count,
					projects,
					member_ids: [...cluster.member_ids].sort((a, b) => a - b),
					representative_id: cluster.representative_id,
					concepts,
					artifact_kind: artifactKind,
					evidence,
					draft_text: null,
				},
			];
		})
		.toSorted(compareDistillCandidates);
}

export function createContextFactDetector(): DistillDetector<ContextFactFeature> {
	return {
		artifactKind: "context_fact",
		select: selectDistillCorpus,
		project: projectContextFactFeatures,
	};
}
