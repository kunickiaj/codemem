import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { digest, digestCorpus } from "./canonical.js";
import { parseProjectedCorpusJson } from "./corpus.js";
import type {
	HistoricalObserverRunOptions,
	HistoricalObserverSubject,
} from "./historical-observer.js";
import { executeCommand, withHistoricalObserverSubjects } from "./historical-observer.js";
import { runInjectionBenchmark } from "./injection-benchmark.js";
import { commitId, parseJson } from "./json-shape.js";
import { parseComponentFileSetManifest, parseReleaseEvalManifest } from "./manifest.js";
import { createRealObserverInvoker } from "./observer-invoker.js";
import type { ObserverInvoker } from "./observer-runner.js";
import {
	adaptProjectedObserverCases,
	observerExecutionCounts,
	runCurrentEvaluatorObserver,
} from "./observer-runner.js";
import { resolvePathWithinAllowedRoots } from "./path-safety.js";
import { digestEvaluatorComponent, digestScopedEvaluatorComponent } from "./provenance.js";
import { buildDetailedReport, buildObserverScopeSummary } from "./reports.js";
import { runRetrievalMatrix } from "./retrieval-matrix.js";
import { runCandidateSemanticRetrieval } from "./semantic-retrieval.js";
import type {
	CandidateSemanticRetrievalEvidence,
	CandidateSemanticRetrievalRunEvidence,
	ComponentFileSetManifestV1,
	CorpusTier,
	Digest,
	JsonValue,
	ObserverScopeReleaseSummaryV1,
	ProjectedCorpusV1,
	ReleaseEvalManifestV1,
} from "./types.js";

const PRIVATE_REPORT_ROOT = ".tmp/eval-results/release";
const COMPONENT_MANIFEST_PATH = "scripts/eval/release/component-files.json";

type MaterializeSubjects = <T>(
	options: HistoricalObserverRunOptions,
	action: (subjects: HistoricalObserverSubject[]) => Promise<T>,
) => Promise<T>;

export interface ReleaseEvalDependencies {
	readText(path: string): Promise<string>;
	writeText(path: string, value: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	resolveEvaluatorCommit(repositoryRoot: string): Promise<string>;
	readEvaluatorStatus(repositoryRoot: string): Promise<string>;
	digestEvaluatorComponent(
		repositoryRoot: string,
		manifest: ComponentFileSetManifestV1,
	): Promise<Digest>;
	digestScopedEvaluatorComponent(
		repositoryRoot: string,
		manifest: ComponentFileSetManifestV1,
		component: "retrieval" | "injection",
	): Promise<Digest>;
	materializeSubjects: MaterializeSubjects;
	createInvoker(
		configuration: ReleaseEvalManifestV1["evaluator"]["configuration"],
	): ObserverInvoker;
	resolveProductVersion(repositoryRoot: string): Promise<string>;
	now(): Date;
	runSemanticRetrieval: typeof runCandidateSemanticRetrieval;
}

const DEFAULT_DEPENDENCIES: ReleaseEvalDependencies = {
	readText: async (path) => await readFile(path, "utf8"),
	writeText: async (path, value) => await writeFile(path, value, "utf8"),
	mkdir: async (path) => {
		await mkdir(path, { recursive: true });
	},
	rename,
	resolveEvaluatorCommit: async (repositoryRoot) => {
		const result = await executeCommand("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
		const commit = result.stdout.trim();
		if (result.exitCode !== 0)
			throw new Error(`Could not resolve evaluator commit: ${result.stderr.trim()}`);
		return commitId(commit, "evaluator commit");
	},
	readEvaluatorStatus: async (repositoryRoot) => {
		const result = await executeCommand(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all"],
			{
				cwd: repositoryRoot,
			},
		);
		if (result.exitCode !== 0)
			throw new Error(`Could not inspect evaluator worktree: ${result.stderr.trim()}`);
		return result.stdout;
	},
	digestEvaluatorComponent,
	digestScopedEvaluatorComponent,
	materializeSubjects: withHistoricalObserverSubjects,
	createInvoker: createRealObserverInvoker,
	resolveProductVersion: async (repositoryRoot) => {
		const value = parseJson(
			await readFile(resolve(repositoryRoot, "packages/core/package.json"), "utf8"),
			"core package",
		);
		const version = (value as { version?: unknown }).version;
		if (typeof version !== "string") throw new TypeError("core package version is missing");
		return version;
	},
	now: () => new Date(),
	runSemanticRetrieval: runCandidateSemanticRetrieval,
};

function dependencies(
	overrides: Partial<ReleaseEvalDependencies> | undefined,
): ReleaseEvalDependencies {
	return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

export function aggregateCandidateSemanticEvidence(
	runs: readonly CandidateSemanticRetrievalRunEvidence[],
): CandidateSemanticRetrievalEvidence {
	const first = runs[0];
	if (!first) return { status: "not_applicable", reason: "not_selected" };
	if (
		runs.some(
			(run) =>
				run.candidate_commit !== first.candidate_commit ||
				run.probe_suite_digest !== first.probe_suite_digest ||
				run.source_corpus_digest !== first.source_corpus_digest ||
				run.retrieval_subject_digest !== first.retrieval_subject_digest ||
				run.probe_count !== first.probe_count ||
				run.readiness.embedding_model !== first.readiness.embedding_model,
		)
	)
		throw new TypeError("candidate semantic repetitions have inconsistent identity");
	if (runs.some((run) => run.metrics.length !== first.metrics.length))
		throw new TypeError("candidate semantic repetitions have inconsistent metric coverage");
	const repetitions = runs.map((run) => run.repetition).toSorted((left, right) => left - right);
	if (
		new Set(repetitions).size !== repetitions.length ||
		JSON.stringify(repetitions) !==
			JSON.stringify(Array.from({ length: runs.length }, (_value, index) => index + 1))
	)
		throw new TypeError("candidate semantic repetitions are incomplete");
	return {
		status: "complete",
		lane: "candidate_semantic",
		candidate_commit: first.candidate_commit,
		probe_suite_digest: first.probe_suite_digest,
		source_corpus_digest: first.source_corpus_digest,
		retrieval_subject_digest: first.retrieval_subject_digest,
		embedding_model: first.readiness.embedding_model,
		probe_count: first.probe_count,
		repetition_count: runs.length,
		aggregate_metrics: first.metrics.map((metric) => {
			const values = runs.map((run) => {
				const matching = run.metrics.filter((entry) => entry.id === metric.id);
				const matched = matching[0];
				if (matching.length !== 1 || !matched || matched.unit !== metric.unit)
					throw new TypeError(
						`candidate semantic metric ${metric.id} has inconsistent repetition coverage`,
					);
				return matched.value;
			});
			return {
				...metric,
				value: values.reduce((sum, value) => sum + value, 0) / values.length,
			};
		}),
		runs: [...runs],
	};
}

export function assertMatchingProbeSuiteDigest(
	historicalDigest: Digest | undefined,
	semantic: CandidateSemanticRetrievalEvidence,
): void {
	if (
		historicalDigest &&
		semantic.status === "complete" &&
		semantic.probe_suite_digest !== historicalDigest
	)
		throw new TypeError(
			"candidate semantic probe-suite identity does not match historical retrieval",
		);
}

export async function assertPrivateReportPath(
	repositoryRoot: string,
	outputPath: string,
): Promise<string> {
	return await resolvePathWithinAllowedRoots(repositoryRoot, outputPath, [PRIVATE_REPORT_ROOT]);
}

export async function assertSanitizedReportPath(
	repositoryRoot: string,
	outputPath: string,
): Promise<string> {
	if (!outputPath.endsWith(".json"))
		throw new TypeError("Sanitized release-eval output must be a JSON file");
	return await resolvePathWithinAllowedRoots(repositoryRoot, outputPath, [
		"scripts/eval/baselines/release",
		PRIVATE_REPORT_ROOT,
	]);
}

function corpusPath(manifestPath: string, sourcePath: string): string {
	return isAbsolute(sourcePath) ? sourcePath : resolve(dirname(manifestPath), sourcePath);
}

export interface ReleaseEvalPreflight {
	manifest: ReleaseEvalManifestV1;
	corpus: ProjectedCorpusV1;
	corpusPaths: string[];
	corpusDigests: Partial<Record<CorpusTier, Digest>>;
	configurationDigest: Digest;
	evaluatorComponentDigest: Digest;
	evaluatorCommit: string;
	retrievalCorpus?: ProjectedCorpusV1;
	retrievalCorpusPath?: string;
	retrievalCorpusDigest?: Digest;
	injectionCorpus?: ProjectedCorpusV1;
	injectionCorpusPath?: string;
	injectionCorpusDigest?: Digest;
	retrievalComponentDigest?: Digest;
	injectionComponentDigest?: Digest;
}

function subjectHasComponents(
	manifest: ReleaseEvalManifestV1,
	kind: "candidate" | "release",
	version: string,
	components: readonly ("observer" | "retrieval" | "injection")[],
): boolean {
	return manifest.subjects.some(
		(subject) =>
			subject.subject.kind === kind &&
			subject.subject.version === version &&
			components.every((component) => subject.components.includes(component)),
	);
}

function assertLanePrerequisites(input: {
	manifest: ReleaseEvalManifestV1;
	retrievalSelected: boolean;
	injectionSelected: boolean;
}): void {
	if (input.retrievalSelected) {
		for (const version of ["0.37.1", "0.38.0"]) {
			if (!subjectHasComponents(input.manifest, "release", version, ["observer", "retrieval"]))
				throw new TypeError(
					`retrieval sidecar requires release ${version} with observer and retrieval components`,
				);
		}
		const candidate = input.manifest.subjects.find(
			(subject) => subject.subject.kind === "candidate",
		);
		if (
			!candidate ||
			!subjectHasComponents(input.manifest, "candidate", candidate.subject.version, [
				"observer",
				"retrieval",
			])
		)
			throw new TypeError(
				"retrieval sidecar requires candidate with observer and retrieval components",
			);
	}
	if (input.injectionSelected) {
		for (const version of ["0.38.0", "0.39.0"]) {
			if (!subjectHasComponents(input.manifest, "release", version, ["injection"]))
				throw new TypeError(
					`injection sidecar requires release ${version} with injection component`,
				);
		}
	}
}

export async function preflightReleaseEval(input: {
	repositoryRoot: string;
	manifestPath: string;
	retrievalCorpusPath?: string;
	injectionCorpusPath?: string;
	dependencies?: Partial<ReleaseEvalDependencies>;
}): Promise<ReleaseEvalPreflight> {
	const deps = dependencies(input.dependencies);
	const repositoryRoot = resolve(input.repositoryRoot);
	const manifestPath = resolve(repositoryRoot, input.manifestPath);
	const manifest = parseReleaseEvalManifest(
		parseJson(await deps.readText(manifestPath), "release manifest"),
	);
	const evaluatorCommit = await deps.resolveEvaluatorCommit(repositoryRoot);
	if (evaluatorCommit !== manifest.evaluator.commit)
		throw new TypeError(
			`Evaluator commit mismatch: manifest=${manifest.evaluator.commit} actual=${evaluatorCommit}`,
		);
	const evaluatorStatus = await deps.readEvaluatorStatus(repositoryRoot);
	if (evaluatorStatus.length > 0)
		throw new TypeError("Evaluator worktree must be clean, including untracked files");
	const componentManifest = parseComponentFileSetManifest(
		parseJson(
			await deps.readText(resolve(repositoryRoot, COMPONENT_MANIFEST_PATH)),
			"component file-set manifest",
		),
	);
	const evaluatorComponentDigest = await deps.digestEvaluatorComponent(
		repositoryRoot,
		componentManifest,
	);
	const corpusDigests: Partial<Record<CorpusTier, Digest>> = {};
	const corpusPaths: string[] = [];
	const rows: ProjectedCorpusV1["rows"] = [];
	for (const entry of manifest.corpora) {
		const path = corpusPath(manifestPath, entry.source_path);
		const corpus = parseProjectedCorpusJson(await deps.readText(path));
		const actualDigest = digestCorpus(corpus);
		if (actualDigest !== entry.expected_digest)
			throw new TypeError(
				`Corpus digest mismatch for ${entry.tier}: expected=${entry.expected_digest} actual=${actualDigest}`,
			);
		corpusDigests[entry.tier] = actualDigest;
		corpusPaths.push(path);
		rows.push(...corpus.rows);
	}
	const corpus: ProjectedCorpusV1 = { schema_version: 1, rows };
	digestCorpus(corpus);
	adaptProjectedObserverCases(corpus);
	const sidecar = async (path: string | undefined, rowType: string) => {
		if (!path) return undefined;
		const resolvedPath = corpusPath(manifestPath, path);
		const value = parseProjectedCorpusJson(await deps.readText(resolvedPath));
		if (value.rows.length === 0 || value.rows.some((row) => row.row_type !== rowType))
			throw new TypeError(`${rowType} sidecar must contain only ${rowType} rows`);
		return { corpus: value, path: resolvedPath, digest: digestCorpus(value) };
	};
	const retrieval = await sidecar(input.retrievalCorpusPath, "retrieval_probe");
	const injection = await sidecar(input.injectionCorpusPath, "injection_case");
	assertLanePrerequisites({
		manifest,
		retrievalSelected: Boolean(retrieval),
		injectionSelected: Boolean(injection),
	});
	const retrievalComponentDigest = retrieval
		? await deps.digestScopedEvaluatorComponent(repositoryRoot, componentManifest, "retrieval")
		: undefined;
	const injectionComponentDigest = injection
		? await deps.digestScopedEvaluatorComponent(repositoryRoot, componentManifest, "injection")
		: undefined;
	return {
		manifest,
		corpus,
		corpusPaths,
		corpusDigests,
		configurationDigest: digest(manifest.evaluator.configuration as unknown as JsonValue),
		evaluatorComponentDigest,
		evaluatorCommit,
		...(retrieval
			? {
					retrievalCorpus: retrieval.corpus,
					retrievalCorpusPath: retrieval.path,
					retrievalCorpusDigest: retrieval.digest,
				}
			: {}),
		...(injection
			? {
					injectionCorpus: injection.corpus,
					injectionCorpusPath: injection.path,
					injectionCorpusDigest: injection.digest,
				}
			: {}),
		...(retrievalComponentDigest ? { retrievalComponentDigest } : {}),
		...(injectionComponentDigest ? { injectionComponentDigest } : {}),
	};
}

async function writeJson(
	path: string,
	value: unknown,
	deps: ReleaseEvalDependencies,
): Promise<void> {
	await deps.mkdir(dirname(path));
	const temporary = `${path}.tmp-${process.pid}`;
	await deps.writeText(temporary, `${JSON.stringify(value, null, 2)}\n`);
	await deps.rename(temporary, path);
}

export interface ReleaseEvalRunResult {
	runId: string;
	detailedPath: string;
	sanitizedPath: string;
	summary: ObserverScopeReleaseSummaryV1;
}

export async function runReleaseEval(input: {
	repositoryRoot: string;
	manifestPath: string;
	retrievalCorpusPath?: string;
	injectionCorpusPath?: string;
	outputPath?: string;
	runId?: string;
	dependencies?: Partial<ReleaseEvalDependencies>;
}): Promise<ReleaseEvalRunResult> {
	const deps = dependencies(input.dependencies);
	const root = resolve(input.repositoryRoot);
	const preflight = await preflightReleaseEval({
		repositoryRoot: root,
		manifestPath: input.manifestPath,
		retrievalCorpusPath: input.retrievalCorpusPath,
		injectionCorpusPath: input.injectionCorpusPath,
		dependencies: deps,
	});
	const createdAt = deps.now().toISOString();
	const runId = input.runId ?? `observer-${createdAt.replace(/[^0-9A-Za-z]/g, "-")}`;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId))
		throw new TypeError("runId must be a safe path segment");
	const detailedPath = await assertPrivateReportPath(
		root,
		resolve(root, PRIVATE_REPORT_ROOT, runId, "detailed.json"),
	);
	const sanitizedPath = input.outputPath
		? await assertSanitizedReportPath(root, input.outputPath)
		: await assertSanitizedReportPath(
				root,
				resolve(root, PRIVATE_REPORT_ROOT, runId, "observer-summary.json"),
			);
	if (sanitizedPath === detailedPath)
		throw new TypeError("Sanitized output path must not replace the detailed report");
	return await deps.materializeSubjects(
		{
			repositoryRoot: root,
			runRoot: PRIVATE_REPORT_ROOT,
			runId,
			subjects: preflight.manifest.subjects
				.filter((subject) => {
					if (subject.components.includes("observer")) return true;
					if (preflight.retrievalCorpus && subject.components.includes("retrieval")) return true;
					return Boolean(preflight.injectionCorpus && subject.components.includes("injection"));
				})
				.map((subject) => ({
					label: subject.label,
					requestedRef: subject.requested_ref,
					observerContextSchemaVersion: 1,
					sanitizedSubject: subject.subject,
				})),
		},
		async (subjects) => {
			const componentsByLabel = new Map(
				preflight.manifest.subjects.map((subject) => [subject.label, subject.components]),
			);
			const observerSubjects = subjects.filter((subject) =>
				componentsByLabel.get(subject.label)?.includes("observer"),
			);
			const observer = await runCurrentEvaluatorObserver({
				corpus: preflight.corpus,
				subjects: observerSubjects,
				repetitions: preflight.manifest.repetitions,
				invoker: deps.createInvoker(preflight.manifest.evaluator.configuration),
			});
			const executionCounts = observerExecutionCounts(observer.runs);
			const retrieval =
				preflight.retrievalCorpus && preflight.retrievalCorpusDigest
					? await runRetrievalMatrix({
							corpus: preflight.retrievalCorpus,
							observerRuns: observer.runs,
							subjects: subjects.filter((subject) =>
								componentsByLabel.get(subject.label)?.includes("retrieval"),
							),
							repetitions: preflight.manifest.repetitions,
							sourceCorpusDigest: preflight.retrievalCorpusDigest,
							storeRoot: resolve(root, PRIVATE_REPORT_ROOT, runId, "retrieval-stores"),
							mkdir: deps.mkdir,
						})
					: null;
			const semanticRuns: CandidateSemanticRetrievalRunEvidence[] = [];
			if (
				preflight.retrievalCorpus &&
				preflight.retrievalCorpusDigest &&
				preflight.retrievalComponentDigest
			) {
				for (let repetition = 1; repetition <= preflight.manifest.repetitions; repetition += 1) {
					semanticRuns.push(
						await deps.runSemanticRetrieval({
							corpus: preflight.retrievalCorpus,
							repositoryRoot: root,
							observerRuns: observer.runs,
							repetition,
							storePath: resolve(
								root,
								PRIVATE_REPORT_ROOT,
								runId,
								"candidate-semantic",
								`repetition-${repetition}`,
								"store.sqlite",
							),
							sourceCorpusDigest: preflight.retrievalCorpusDigest,
							retrievalSubjectDigest: preflight.retrievalComponentDigest,
						}),
					);
				}
			}
			const candidateSemantic = aggregateCandidateSemanticEvidence(semanticRuns);
			assertMatchingProbeSuiteDigest(retrieval?.probeSuiteDigest, candidateSemantic);
			const injection = preflight.injectionCorpus
				? await runInjectionBenchmark({
						corpus: preflight.injectionCorpus,
						subjects: subjects.filter((subject) =>
							componentsByLabel.get(subject.label)?.includes("injection"),
						),
						repetitions: preflight.manifest.repetitions,
					})
				: null;
			const casesExpected =
				observerSubjects.length *
				adaptProjectedObserverCases(preflight.corpus).length *
				preflight.manifest.repetitions;
			const provenance = {
				evaluator_commit: preflight.evaluatorCommit,
				configuration_digest: preflight.configurationDigest,
				corpus_digests: preflight.corpusDigests,
				evaluator_component_digest: preflight.evaluatorComponentDigest,
			};
			const detailed = buildDetailedReport({
				benchmark_profile: "release-v1",
				run_id: runId,
				created_at: createdAt,
				status: "partial",
				provenance: {
					...provenance,
					subject_commits: subjects.map((subject) => ({
						label: subject.label,
						requested_ref: subject.requestedRef,
						resolved_commit: subject.resolvedCommit,
					})),
				},
				metrics: observer.sanitizedMetrics,
				case_results: observer.caseResults,
				...(retrieval ? { retrieval_matrix: retrieval.detailed } : {}),
				candidate_semantic_retrieval: candidateSemantic,
				...(injection ? { injection_suite: injection.detailed } : {}),
				local_artifacts: {
					manifest_path: resolve(root, input.manifestPath),
					corpus_paths: [
						...preflight.corpusPaths,
						...(preflight.retrievalCorpusPath ? [preflight.retrievalCorpusPath] : []),
						...(preflight.injectionCorpusPath ? [preflight.injectionCorpusPath] : []),
					],
				},
			});
			const summary = buildObserverScopeSummary({
				benchmark_profile: "release-v1",
				scope: retrieval || injection ? "release_layers" : "observer",
				status: "partial",
				partial_reason: retrieval || injection ? "thresholds_not_enforced" : "observer_scope_only",
				evaluated_at: createdAt,
				provenance: {
					...provenance,
					subject_commits: subjects.map((subject) => ({
						subject: subject.sanitizedSubject,
						resolved_commit: subject.resolvedCommit,
					})),
				},
				completeness: {
					repetitions: preflight.manifest.repetitions,
					cases_completed: executionCounts.completed,
					cases_expected: casesExpected,
				},
				metrics: {
					observer: observer.sanitizedMetrics,
					...(retrieval ? { retrieval: retrieval.metrics } : {}),
					...(injection ? { injection: injection.metrics } : {}),
				},
				...(retrieval ? { retrieval_cells: retrieval.provenance } : {}),
				candidate_semantic_retrieval: candidateSemantic,
				...(injection ? { injection_subjects: injection.provenance } : {}),
				execution: subjects.map((subject) => {
					const runs = observer.runs.filter(
						(run) =>
							JSON.stringify(run.subject.sanitizedSubject) ===
							JSON.stringify(subject.sanitizedSubject),
					);
					return { subject: subject.sanitizedSubject, ...observerExecutionCounts(runs) };
				}),
			});
			await writeJson(detailedPath, detailed, deps);
			await writeJson(sanitizedPath, summary, deps);
			return { runId, detailedPath, sanitizedPath, summary };
		},
	);
}

export function syntheticObserverCorpus(): ProjectedCorpusV1 {
	const context = (transcript: string): JsonValue => ({
		project: "synthetic",
		user_prompt: "evaluate deterministic observer behavior",
		prompt_number: 1,
		transcript,
		tool_events: [],
		last_assistant_message: null,
		include_summary: true,
		diff_summary: "",
		recent_files: "",
	});
	const label = (id: string, words: string[]): JsonValue => ({
		label_id: id,
		title: id,
		keyword_groups: words.map((word) => [word]),
		reviewer_notes: "Synthetic required fact",
		evidence_notes: "Deterministic public fixture",
	});
	const review = (required: JsonValue[] = []): JsonValue => ({
		reviewer_notes: "Synthetic scorer fixture",
		required,
		optional: [],
		forbidden: [],
	});
	return {
		schema_version: 1,
		rows: [
			{
				case_id: "synthetic-required-recall",
				ordinal: 0,
				row_type: "observer_case",
				value: {
					observer_context: context("The fixture durable fact is deterministic."),
					review: review([label("fixture-durable-fact", ["fixture", "durable", "fact"])]),
					expected_summary_disposition: "required",
					expected_observation_policy: "quality",
				},
			},
			{
				case_id: "synthetic-routine-silence",
				ordinal: 1,
				row_type: "observer_case",
				value: {
					observer_context: context("Checked status and completed a routine request."),
					review: review(),
					expected_summary_disposition: "required",
					expected_observation_policy: "zero",
				},
			},
			{
				case_id: "synthetic-repair",
				ordinal: 2,
				row_type: "observer_case",
				value: {
					observer_context: context("The repaired durable fact must survive malformed output."),
					review: review([label("repaired-durable-fact", ["repaired", "durable", "fact"])]),
					expected_summary_disposition: "required",
					expected_observation_policy: "quality",
				},
			},
			{
				case_id: "synthetic-fallback",
				ordinal: 3,
				row_type: "observer_case",
				value: {
					observer_context: context("This fallback fixture contains no lasting information."),
					review: review(),
					expected_summary_disposition: "skip",
					expected_observation_policy: "zero",
				},
			},
		],
	};
}

const REQUIRED_XML =
	"<observation><type>discovery</type><title>Fixture durable fact</title><narrative>The fixture durable fact is deterministic.</narrative><facts><fact>fixture durable fact</fact></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation><summary><request>Retain the fixture durable fact</request><learned>The fixture durable fact is deterministic.</learned></summary>";
const REPAIRED_XML =
	"<observation><type>discovery</type><title>Repaired durable fact</title><narrative>The repaired durable fact survived malformed output.</narrative><facts><fact>repaired durable fact</fact></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation><summary><request>Repair malformed output</request><learned>The repaired durable fact survived.</learned></summary>";

export async function runSyntheticReleaseEval(input: {
	repositoryRoot: string;
	outputPath?: string;
	dependencies?: Partial<ReleaseEvalDependencies>;
}): Promise<ReleaseEvalRunResult> {
	const deps = dependencies(input.dependencies);
	const root = resolve(input.repositoryRoot);
	const commit = await deps.resolveEvaluatorCommit(root);
	const productVersion = await deps.resolveProductVersion(root);
	const runId = "synthetic-observer";
	const fixtureRoot = await assertPrivateReportPath(
		root,
		resolve(root, PRIVATE_REPORT_ROOT, runId, "fixture"),
	);
	const corpus = syntheticObserverCorpus();
	const corpusFile = resolve(fixtureRoot, "corpus.json");
	const manifestFile = resolve(fixtureRoot, "manifest.json");
	const manifest: ReleaseEvalManifestV1 = {
		schema_version: 1,
		benchmark_profile: "release-v1",
		corpora: [
			{
				tier: "public",
				schema_version: 1,
				source_path: corpusFile,
				expected_digest: digestCorpus(corpus),
			},
		],
		evaluator: {
			commit,
			configuration: {
				provider: "synthetic",
				transport: "fake",
				endpoint_mode: "provider_default",
				model: "synthetic-v1",
				temperature: 0,
				openai_responses: false,
				reasoning_effort: null,
				reasoning_summary: null,
				max_output_tokens: 512,
				tier_routing_enabled: false,
			},
		},
		subjects: [
			{
				label: "approved-stable",
				requested_ref: commit,
				observer_context_schema_version: 1,
				subject: { kind: "approved_stable", version: productVersion },
				components: ["observer"],
			},
			{
				label: "candidate",
				requested_ref: commit,
				observer_context_schema_version: 1,
				subject: { kind: "candidate", version: productVersion },
				components: ["observer"],
			},
		],
		repetitions: 1,
	};
	await deps.mkdir(fixtureRoot);
	await deps.writeText(corpusFile, `${JSON.stringify(corpus, null, 2)}\n`);
	await deps.writeText(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
	const fakeInvoker: ObserverInvoker = {
		invoke: async (request) => {
			const fallback = request.caseId === "synthetic-fallback";
			const raw =
				request.caseId === "synthetic-required-recall"
					? REQUIRED_XML
					: request.caseId === "synthetic-routine-silence"
						? "<summary><request>Routine request</request><completed>Checked status without a durable observation.</completed></summary>"
						: request.caseId === "synthetic-repair"
							? request.attempt === "initial"
								? "This response is intentionally malformed."
								: REPAIRED_XML
							: '<skip_summary reason="low-signal" />';
			return {
				status: "completed",
				raw,
				provider: "synthetic",
				requestedModel: "synthetic-v1",
				resolvedModel: fallback ? "synthetic-fallback-v1" : "synthetic-v1",
				modelFallbackApplied: fallback,
				fallbackReason: fallback ? "deterministic synthetic fallback" : null,
				elapsedMs: 1,
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				estimatedCostUsd: null,
				error: null,
			};
		},
	};
	return await runReleaseEval({
		repositoryRoot: root,
		manifestPath: manifestFile,
		outputPath: input.outputPath,
		runId,
		dependencies: { ...deps, createInvoker: () => fakeInvoker },
	});
}
