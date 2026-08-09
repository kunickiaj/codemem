import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	backfillVectors,
	buildMemoryPackTraceAsync,
	deriveTags,
	getSemanticIndexDiagnostics,
	hasPendingRefBackfill,
	listMaintenanceJobs,
	type MemoryResult,
	MemoryStore,
	type PackTrace,
	semanticSearch,
} from "@codemem/core";
import { sanitizeSearchQuery } from "../../../packages/core/src/query-sanitizer.js";
import type { ObserverCaseRunResult } from "./observer-runner.js";
import { resolveFreshSqlitePathWithinAllowedRoots } from "./path-safety.js";
import { adaptProjectedRetrievalProbes, retrievalProbeSuiteDigest } from "./retrieval-matrix.js";
import { projectObserverRunsForRetrieval, scoreRetrievalProbes } from "./retrieval-scoring.js";
import type { CandidateSemanticRetrievalRunEvidence, Digest, ProjectedCorpusV1 } from "./types.js";
export interface SemanticRetrievalReadiness {
	state: string;
	mode: string;
	embedding_model: string;
	semantic_search_model: string | null;
	materialized_memory_count: number;
	active_memory_count: number;
	embeddable_memory_count: number;
	indexed_memory_count: number;
	pending_memory_count: number;
	tagged_memory_count: number;
	expected_file_ref_count: number;
	file_ref_count: number;
	expected_concept_ref_count: number;
	concept_ref_count: number;
	pending_ref_backfill: boolean;
	blocking_maintenance_jobs: Array<{ kind: string; status: string }>;
}
interface Materialized {
	memoryKey: string;
	sessionKey: string;
	kind: string;
	title: string;
	body: string;
	confidence: number;
	tags: string[];
	metadata: Record<string, unknown>;
}
export interface SemanticRetrievalStore {
	db: MemoryStore["db"];
	startSession(options: Parameters<MemoryStore["startSession"]>[0]): number;
	remember(...args: Parameters<MemoryStore["remember"]>): number;
	flushPendingVectorWrites(): Promise<void>;
	ownershipFilterContext(): ReturnType<MemoryStore["ownershipFilterContext"]>;
	close(): void;
}
export interface SemanticRetrievalDependencies {
	mkdir(path: string): Promise<void>;
	resolveStorePath(repositoryRoot: string, storePath: string): Promise<string>;
	createStore(path: string): SemanticRetrievalStore;
	backfill(store: SemanticRetrievalStore, ids: number[]): Promise<void>;
	inspectReadiness(
		store: SemanticRetrievalStore,
		memories: Array<Materialized & { id: number }>,
	): SemanticRetrievalReadiness;
	search(store: SemanticRetrievalStore, query: string, limit: number): Promise<MemoryResult[]>;
	pack(store: SemanticRetrievalStore, query: string, limit: number): Promise<PackTrace>;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function setEquals(left: Set<string>, right: Set<string>): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}

function project(runs: ObserverCaseRunResult[]): Materialized[] {
	return projectObserverRunsForRetrieval(runs).map((memory) => ({
		memoryKey: memory.memory_key,
		sessionKey: memory.session_key,
		kind: memory.kind,
		title: memory.title,
		body: memory.body_text,
		confidence: memory.confidence,
		tags: deriveTags({
			kind: memory.kind,
			title: memory.title,
			concepts: stringArray(memory.metadata.concepts),
			filesRead: stringArray(memory.metadata.files_read),
			filesModified: stringArray(memory.metadata.files_modified),
		}),
		metadata: memory.metadata,
	}));
}

function inspectReadiness(
	store: SemanticRetrievalStore,
	memories: Array<Materialized & { id: number }>,
): SemanticRetrievalReadiness {
	const diagnostics = getSemanticIndexDiagnostics(store.db, { fastCounts: false });
	const active = store.db
		.prepare("SELECT id, tags_text FROM memory_items WHERE active = 1 ORDER BY id")
		.all() as Array<{ id: number; tags_text: string }>;
	const expected = new Map(memories.map((memory) => [memory.id, memory.tags.toSorted().join(" ")]));
	const tagged = active.filter(
		(row) =>
			row.tags_text.split(/\s+/).filter(Boolean).toSorted().join(" ") === expected.get(row.id),
	).length;
	const expectedFileRefs = memories.flatMap((memory) => [
		...stringArray(memory.metadata.files_read).map((path) => `${memory.id}\u0000read\u0000${path}`),
		...stringArray(memory.metadata.files_modified).map(
			(path) => `${memory.id}\u0000modified\u0000${path}`,
		),
	]);
	const fileRefs = (
		store.db
			.prepare(
				"SELECT memory_id, relation, file_path FROM memory_file_refs ORDER BY memory_id, relation, file_path",
			)
			.all() as Array<{ memory_id: number; relation: string; file_path: string }>
	).map((row) => `${row.memory_id}\u0000${row.relation}\u0000${row.file_path}`);
	const expectedConceptRefs = memories.flatMap((memory) =>
		stringArray(memory.metadata.concepts)
			.map((concept) => concept.trim().toLowerCase())
			.filter(Boolean)
			.map((concept) => `${memory.id}\u0000${concept}`),
	);
	const conceptRefs = (
		store.db
			.prepare("SELECT memory_id, concept FROM memory_concept_refs ORDER BY memory_id, concept")
			.all() as Array<{ memory_id: number; concept: string }>
	).map((row) => `${row.memory_id}\u0000${row.concept}`);
	return {
		state: diagnostics.state,
		mode: diagnostics.mode,
		embedding_model: diagnostics.current_model,
		semantic_search_model: diagnostics.semantic_search_model,
		materialized_memory_count: memories.length,
		active_memory_count: active.length,
		embeddable_memory_count: diagnostics.embeddable_memory_count,
		indexed_memory_count: diagnostics.indexed_memory_count,
		pending_memory_count: diagnostics.pending_memory_count,
		tagged_memory_count: tagged,
		expected_file_ref_count: new Set(expectedFileRefs).size,
		file_ref_count: new Set(fileRefs).size,
		expected_concept_ref_count: new Set(expectedConceptRefs).size,
		concept_ref_count: new Set(conceptRefs).size,
		pending_ref_backfill:
			hasPendingRefBackfill(store.db) ||
			!setEquals(new Set(expectedFileRefs), new Set(fileRefs)) ||
			!setEquals(new Set(expectedConceptRefs), new Set(conceptRefs)),
		blocking_maintenance_jobs: listMaintenanceJobs(store.db)
			.filter(
				(job) =>
					["memory_ref_backfill", "vector_model_migration"].includes(job.kind) &&
					["pending", "running", "failed"].includes(job.status),
			)
			.map((job) => ({ kind: job.kind, status: job.status })),
	};
}

function semanticResults(results: Awaited<ReturnType<typeof semanticSearch>>): MemoryResult[] {
	return results.map((result) => ({
		id: result.id,
		kind: result.kind,
		title: result.title,
		body_text: result.body_text,
		confidence: result.confidence,
		created_at: result.created_at,
		updated_at: result.updated_at,
		tags_text: result.tags_text,
		score: result.score,
		session_id: result.session_id,
		metadata: result.metadata_json
			? (JSON.parse(result.metadata_json) as Record<string, unknown>)
			: {},
		narrative: result.narrative,
		facts: result.facts,
	}));
}
const DEFAULTS: SemanticRetrievalDependencies = {
	mkdir: async (path) => {
		await mkdir(path, { recursive: true });
	},
	resolveStorePath: async (repositoryRoot, storePath) =>
		await resolveFreshSqlitePathWithinAllowedRoots(repositoryRoot, storePath, [
			".tmp/eval-results/release",
		]),
	createStore: (path) => new MemoryStore(path),
	backfill: async (store, ids) => {
		await backfillVectors(store.db, { memoryIds: ids });
	},
	inspectReadiness,
	search: async (store, query, limit) =>
		semanticResults(
			await semanticSearch(store.db, query, limit, null, store.ownershipFilterContext()),
		),
	pack: async (store, query, limit) =>
		await buildMemoryPackTraceAsync(store as MemoryStore, query, limit),
};

export function assertSemanticReady(readiness: SemanticRetrievalReadiness): void {
	if (readiness.blocking_maintenance_jobs.length)
		throw new Error("candidate semantic lane blocked by maintenance");
	if (
		readiness.state !== "healthy" ||
		readiness.mode !== "semantic" ||
		!readiness.semantic_search_model ||
		readiness.semantic_search_model !== readiness.embedding_model ||
		readiness.pending_memory_count !== 0
	)
		throw new Error("candidate semantic lane requires a healthy current-model semantic index");
	if (
		readiness.active_memory_count !== readiness.materialized_memory_count ||
		readiness.embeddable_memory_count !== readiness.active_memory_count ||
		readiness.indexed_memory_count !== readiness.embeddable_memory_count
	)
		throw new Error("candidate semantic lane has incomplete embeddable vector coverage");
	if (
		readiness.tagged_memory_count !== readiness.active_memory_count ||
		readiness.pending_ref_backfill ||
		readiness.file_ref_count !== readiness.expected_file_ref_count ||
		readiness.concept_ref_count !== readiness.expected_concept_ref_count
	)
		throw new Error("candidate semantic lane has incomplete production metadata indexing");
}
export async function runCandidateSemanticRetrieval(input: {
	corpus: ProjectedCorpusV1;
	repositoryRoot: string;
	observerRuns: ObserverCaseRunResult[];
	repetition: number;
	storePath: string;
	sourceCorpusDigest: Digest;
	retrievalSubjectDigest: Digest;
	dependencies?: Partial<SemanticRetrievalDependencies>;
}): Promise<CandidateSemanticRetrievalRunEvidence> {
	const deps = { ...DEFAULTS, ...input.dependencies };
	const storePath = await deps.resolveStorePath(input.repositoryRoot, input.storePath);
	const candidateRuns = input.observerRuns.filter(
		(run) =>
			run.subject.sanitizedSubject.kind === "candidate" && run.repetition === input.repetition,
	);
	if (!candidateRuns.length)
		throw new TypeError("candidate semantic lane requires candidate observer outputs");
	const commits = new Set(candidateRuns.map((run) => run.subject.resolvedCommit));
	if (commits.size !== 1)
		throw new TypeError("candidate semantic lane requires one candidate commit");
	const candidateCommit = commits.values().next().value;
	if (!candidateCommit) throw new TypeError("candidate semantic lane candidate commit is missing");
	const memories = project(candidateRuns);
	const probes = adaptProjectedRetrievalProbes(input.corpus);
	await deps.mkdir(dirname(storePath));
	const store = deps.createStore(storePath);
	try {
		const sessions = new Map<string, number>();
		const stored = memories.map((memory) => {
			const session =
				sessions.get(memory.sessionKey) ??
				store.startSession({
					project: "release-eval",
					toolVersion: "release-eval",
					metadata: { release_eval_lane: "candidate_semantic" },
				});
			sessions.set(memory.sessionKey, session);
			return {
				...memory,
				id: store.remember(
					session,
					memory.kind,
					memory.title,
					memory.body,
					memory.confidence,
					memory.tags,
					memory.metadata,
				),
			};
		});
		if (!stored.length || new Set(stored.map((memory) => memory.id)).size !== stored.length)
			throw new Error(
				"candidate semantic lane did not independently materialize all candidate outputs",
			);
		await store.flushPendingVectorWrites();
		await deps.backfill(
			store,
			stored.map((memory) => memory.id),
		);
		const readiness = deps.inspectReadiness(store, stored);
		assertSemanticReady(readiness);
		const byId = new Map(stored.map((memory) => [memory.id, memory]));
		const traces: PackTrace[] = [];
		for (const probe of probes) {
			const query = sanitizeSearchQuery(probe.query).clean_query;
			const candidates = await deps.search(store, query, Math.max(probe.topN, 10));
			if (
				!candidates.some((candidate) => byId.has(candidate.id) && Number.isFinite(candidate.score))
			)
				throw new Error(
					`candidate semantic search returned no usable candidates for ${probe.probeId}`,
				);
			const trace = await deps.pack(store, probe.query, Math.max(probe.topN, 10));
			traces.push(trace);
		}
		const metrics = scoreRetrievalProbes({
			probes,
			traces: traces.map((trace) => ({ mode: trace.mode.selected, assembly: trace.assembly })),
			items: stored.map((memory) => ({
				id: memory.id,
				memoryKey: memory.memoryKey,
				kind: memory.kind,
				title: memory.title,
				bodyText: memory.body,
				metadata: memory.metadata,
			})),
		});
		return {
			lane: "candidate_semantic",
			candidate_commit: candidateCommit,
			repetition: input.repetition,
			probe_suite_digest: retrievalProbeSuiteDigest(probes),
			source_corpus_digest: input.sourceCorpusDigest,
			retrieval_subject_digest: input.retrievalSubjectDigest,
			probe_count: probes.length,
			readiness: {
				state: readiness.state,
				mode: readiness.mode,
				embedding_model: readiness.embedding_model,
				semantic_search_model: readiness.semantic_search_model,
				materialized_memory_count: readiness.materialized_memory_count,
				active_memory_count: readiness.active_memory_count,
				embeddable_memory_count: readiness.embeddable_memory_count,
				indexed_memory_count: readiness.indexed_memory_count,
				pending_memory_count: readiness.pending_memory_count,
				tagged_memory_count: readiness.tagged_memory_count,
				expected_file_ref_count: readiness.expected_file_ref_count,
				file_ref_count: readiness.file_ref_count,
				expected_concept_ref_count: readiness.expected_concept_ref_count,
				concept_ref_count: readiness.concept_ref_count,
				pending_ref_backfill: readiness.pending_ref_backfill,
				blocking_maintenance_job_count: readiness.blocking_maintenance_jobs.length,
			},
			metrics,
		};
	} finally {
		store.close();
	}
}
