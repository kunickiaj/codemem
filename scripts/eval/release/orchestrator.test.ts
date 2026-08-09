import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { digestCorpus } from "./canonical.js";
import type { HistoricalObserverSubject } from "./historical-observer.js";
import type { ReleaseEvalDependencies } from "./orchestrator.js";
import {
	aggregateCandidateSemanticEvidence,
	assertMatchingProbeSuiteDigest,
	assertSanitizedReportPath,
	preflightReleaseEval,
	runReleaseEval,
	runSyntheticReleaseEval,
	syntheticObserverCorpus,
} from "./orchestrator.js";
import type {
	CandidateSemanticRetrievalRunEvidence,
	Digest,
	ProjectedCorpusV1,
	ReleaseEvalManifestV1,
} from "./types.js";

const ROOT = "/fixture/repository";
const COMMIT = "a".repeat(40);
const SHA = `sha256:${"b".repeat(64)}` as Digest;

function semanticEvidence(
	overrides: Partial<CandidateSemanticRetrievalRunEvidence> = {},
): CandidateSemanticRetrievalRunEvidence {
	return {
		lane: "candidate_semantic",
		candidate_commit: COMMIT,
		repetition: 1,
		probe_suite_digest: SHA,
		source_corpus_digest: SHA,
		retrieval_subject_digest: SHA,
		probe_count: 1,
		readiness: {
			state: "healthy",
			mode: "semantic",
			embedding_model: "fixture",
			semantic_search_model: "fixture",
			materialized_memory_count: 1,
			active_memory_count: 1,
			embeddable_memory_count: 1,
			indexed_memory_count: 1,
			pending_memory_count: 0,
			tagged_memory_count: 1,
			expected_file_ref_count: 0,
			file_ref_count: 0,
			expected_concept_ref_count: 0,
			concept_ref_count: 0,
			pending_ref_backfill: false,
			blocking_maintenance_job_count: 0,
		},
		metrics: [{ id: "summary_share", value: 1, unit: "ratio" }],
		...overrides,
	};
}

function harness(): {
	dependencies: Partial<ReleaseEvalDependencies>;
	files: Map<string, string>;
	writes: Map<string, string>;
	events: string[];
} {
	const files = new Map<string, string>();
	const writes = new Map<string, string>();
	const events: string[] = [];
	const dependencies: Partial<ReleaseEvalDependencies> = {
		readText: async (path) => {
			const value = files.get(path);
			if (value === undefined) throw new Error(`missing ${path}`);
			return value;
		},
		writeText: async (path, value) => {
			files.set(path, value);
			writes.set(path, value);
		},
		mkdir: async () => {},
		rename: async (from, to) => {
			const value = files.get(from);
			if (value === undefined) throw new Error(`missing ${from}`);
			files.set(to, value);
			writes.set(to, value);
		},
		resolveEvaluatorCommit: async () => COMMIT,
		readEvaluatorStatus: async () => "",
		resolveProductVersion: async () => "0.40.0-alpha.1",
		digestEvaluatorComponent: async () => {
			events.push("component-digest");
			return SHA;
		},
		digestScopedEvaluatorComponent: async (_root, _manifest, component) => {
			events.push(`${component}-component-digest`);
			return SHA;
		},
		materializeSubjects: async (options, action) => {
			events.push("refs-resolved");
			return await action(
				options.subjects.map(
					(spec): HistoricalObserverSubject => ({
						...spec,
						productVersion: spec.sanitizedSubject.version,
						resolvedCommit: COMMIT,
						worktreePath: "/ignored",
						buildObserverPrompt: async () => ({ system: "system", user: "user" }),
					}),
				),
			);
		},
		now: () => new Date("2026-08-08T00:00:00.000Z"),
	};
	return { dependencies, files, writes, events };
}

describe("observer release orchestration", () => {
	it("rejects semantic repetitions with different corpus identity", () => {
		expect(() =>
			aggregateCandidateSemanticEvidence([
				semanticEvidence(),
				semanticEvidence({
					repetition: 2,
					source_corpus_digest: `sha256:${"c".repeat(64)}`,
				}),
			]),
		).toThrow("inconsistent identity");
	});

	it("rejects semantic evidence scored against a different historical probe suite", () => {
		expect(() =>
			assertMatchingProbeSuiteDigest(
				`sha256:${"c".repeat(64)}`,
				aggregateCandidateSemanticEvidence([semanticEvidence()]),
			),
		).toThrow("probe-suite identity");
	});

	it.each([
		["tracked", " M scripts/eval/release/orchestrator.ts\n"],
		["untracked", "?? local-eval-output.json\n"],
	])("rejects a dirty evaluator worktree containing %s changes", async (_kind, status) => {
		const test = harness();
		const corpus = syntheticObserverCorpus();
		const corpusPath = resolve(ROOT, "corpus.json");
		const manifestPath = resolve(ROOT, "manifest.json");
		const manifest: ReleaseEvalManifestV1 = {
			schema_version: 1,
			benchmark_profile: "release-v1",
			corpora: [
				{
					tier: "public",
					schema_version: 1,
					source_path: corpusPath,
					expected_digest: digestCorpus(corpus),
				},
			],
			evaluator: {
				commit: COMMIT,
				configuration: {
					provider: "fake",
					transport: "fake",
					endpoint_mode: "provider_default",
					model: "fake",
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
					label: "candidate",
					requested_ref: COMMIT,
					observer_context_schema_version: 1,
					subject: { kind: "candidate", version: "0.40.0" },
					components: ["observer"],
				},
			],
			repetitions: 1,
		};
		test.files.set(manifestPath, JSON.stringify(manifest));
		test.files.set(corpusPath, JSON.stringify(corpus));
		test.dependencies.readEvaluatorStatus = async () => status;
		await expect(
			preflightReleaseEval({ repositoryRoot: ROOT, manifestPath, dependencies: test.dependencies }),
		).rejects.toThrow("worktree must be clean");
		expect(test.events).not.toContain("component-digest");
		expect(test.events).not.toContain("refs-resolved");
	});

	it("rejects corpus drift before resolving subject refs", async () => {
		const test = harness();
		const corpus = syntheticObserverCorpus();
		const corpusPath = resolve(ROOT, "corpus.json");
		const manifestPath = resolve(ROOT, "manifest.json");
		const manifest: ReleaseEvalManifestV1 = {
			schema_version: 1,
			benchmark_profile: "release-v1",
			corpora: [
				{ tier: "public", schema_version: 1, source_path: corpusPath, expected_digest: SHA },
			],
			evaluator: {
				commit: COMMIT,
				configuration: {
					provider: "fake",
					transport: "fake",
					endpoint_mode: "provider_default",
					model: "fake",
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
					label: "v0.37.1",
					requested_ref: "v0.37.1",
					observer_context_schema_version: 1,
					subject: { kind: "release", version: "0.37.1" },
					components: ["observer", "retrieval"],
				},
				{
					label: "v0.38.0",
					requested_ref: "v0.38.0",
					observer_context_schema_version: 1,
					subject: { kind: "release", version: "0.38.0" },
					components: ["observer", "retrieval", "injection"],
				},
				{
					label: "v0.39.0",
					requested_ref: "v0.39.0",
					observer_context_schema_version: 1,
					subject: { kind: "release", version: "0.39.0" },
					components: ["observer", "injection"],
				},
				{
					label: "candidate",
					requested_ref: COMMIT,
					observer_context_schema_version: 1,
					subject: { kind: "candidate", version: "0.40.0" },
					components: ["observer", "retrieval"],
				},
			],
			repetitions: 1,
		};
		test.files.set(manifestPath, JSON.stringify(manifest));
		test.files.set(corpusPath, JSON.stringify(corpus));
		test.files.set(
			resolve(ROOT, "scripts/eval/release/component-files.json"),
			JSON.stringify({
				schema_version: 1,
				components: {
					evaluator: ["evaluator.ts"],
					retrieval: ["retrieval.ts"],
					injection: ["injection.ts"],
				},
			}),
		);
		await expect(
			preflightReleaseEval({ repositoryRoot: ROOT, manifestPath, dependencies: test.dependencies }),
		).rejects.toThrow("Corpus digest mismatch");
		expect(test.events).not.toContain("refs-resolved");
	});

	it("runs the public synthetic fixture without model credentials and sanitizes the summary", async () => {
		const test = harness();
		const componentPath = resolve(ROOT, "scripts/eval/release/component-files.json");
		test.files.set(
			componentPath,
			JSON.stringify({
				schema_version: 1,
				components: {
					evaluator: ["evaluator.ts"],
					retrieval: ["retrieval.ts"],
					injection: ["injection.ts"],
				},
			}),
		);
		const result = await runSyntheticReleaseEval({
			repositoryRoot: ROOT,
			dependencies: test.dependencies,
		});
		expect(result.summary).toMatchObject({
			status: "partial",
			scope: "observer",
			completeness: { cases_completed: 8, cases_expected: 8 },
		});
		const summary = test.writes.get(result.sanitizedPath) ?? "";
		expect(summary).toContain('"version": "0.40.0-alpha.1"');
		expect(summary).not.toContain("This response is intentionally malformed");
		expect(test.writes.get(result.detailedPath)).toContain(
			"This response is intentionally malformed",
		);
	});

	it("uses disjoint failure buckets and manifest-derived expected case counts", async () => {
		const test = harness();
		const corpus = syntheticObserverCorpus();
		const corpusPath = resolve(ROOT, "corpus.json");
		const manifestPath = resolve(ROOT, "manifest.json");
		const manifest: ReleaseEvalManifestV1 = {
			schema_version: 1,
			benchmark_profile: "release-v1",
			corpora: [
				{
					tier: "public",
					schema_version: 1,
					source_path: corpusPath,
					expected_digest: digestCorpus(corpus),
				},
			],
			evaluator: {
				commit: COMMIT,
				configuration: {
					provider: "fake",
					transport: "fake",
					endpoint_mode: "provider_default",
					model: "fake",
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
					label: "candidate",
					requested_ref: COMMIT,
					observer_context_schema_version: 1,
					subject: { kind: "candidate", version: "0.40.0" },
					components: ["observer"],
				},
			],
			repetitions: 2,
		};
		test.files.set(manifestPath, JSON.stringify(manifest));
		test.files.set(corpusPath, JSON.stringify(corpus));
		test.files.set(
			resolve(ROOT, "scripts/eval/release/component-files.json"),
			JSON.stringify({ schema_version: 1, components: { evaluator: ["evaluator.ts"] } }),
		);
		test.dependencies.createInvoker = () => ({
			invoke: async (request) => ({
				status: "completed",
				raw:
					request.caseId === "synthetic-required-recall"
						? "<summary><request>fixture</request><learned>fixture durable fact</learned></summary>"
						: request.caseId === "synthetic-routine-silence"
							? null
							: request.caseId === "synthetic-repair"
								? "<observation><type>unsupported</type><title>bad shape</title></observation>"
								: "not xml",
				provider: "fake",
				requestedModel: "fake",
				resolvedModel: "fake",
				modelFallbackApplied: false,
				fallbackReason: null,
				elapsedMs: 1,
				usage: null,
				estimatedCostUsd: null,
				error: null,
			}),
		});
		const result = await runReleaseEval({
			repositoryRoot: ROOT,
			manifestPath,
			runId: "failure-counts",
			dependencies: test.dependencies,
		});
		expect(result.summary.completeness).toEqual({
			repetitions: 2,
			cases_completed: 2,
			cases_expected: 8,
		});
		expect(result.summary.execution).toEqual([
			{
				subject: { kind: "candidate", version: "0.40.0" },
				completed: 2,
				unavailable: 0,
				partial: 0,
				failed: 6,
			},
		]);
	});

	it("rejects sanitized output outside explicit safe roots", async () => {
		await expect(assertSanitizedReportPath(ROOT, "package.json")).rejects.toThrow(
			"allowed release-eval output roots",
		);
		await expect(
			assertSanitizedReportPath(ROOT, "scripts/eval/baselines/release/candidate.json"),
		).resolves.toBe(resolve(ROOT, "scripts/eval/baselines/release/candidate.json"));
		await expect(
			assertSanitizedReportPath(ROOT, ".tmp/eval-results/release/candidate.json"),
		).resolves.toBe(resolve(ROOT, ".tmp/eval-results/release/candidate.json"));
	});

	it("preflights PR2 retrieval and injection sidecars without binding them into the observer manifest", async () => {
		const test = harness();
		const observer = syntheticObserverCorpus();
		const observerPath = resolve(ROOT, "private-corpus.json");
		const manifestPath = resolve(ROOT, "private-release-manifest.json");
		const retrievalPath = resolve(ROOT, "private-retrieval-corpus.json");
		const injectionPath = resolve(ROOT, "public-injection-corpus.json");
		const manifest = {
			schema_version: 1,
			benchmark_profile: "release-v1",
			corpora: [
				{
					tier: "private",
					schema_version: 1,
					source_path: observerPath,
					expected_digest: digestCorpus(observer),
				},
			],
			evaluator: {
				commit: COMMIT,
				configuration: {
					provider: "fake",
					transport: "fake",
					endpoint_mode: "provider_default",
					model: "fake",
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
					label: "v0.37.1",
					requested_ref: "v0.37.1",
					observer_context_schema_version: 1,
					subject: { kind: "release", version: "0.37.1" },
					components: ["observer", "retrieval"],
				},
				{
					label: "v0.38.0",
					requested_ref: "v0.38.0",
					observer_context_schema_version: 1,
					subject: { kind: "release", version: "0.38.0" },
					components: ["observer", "retrieval", "injection"],
				},
				{
					label: "v0.39.0",
					requested_ref: "v0.39.0",
					observer_context_schema_version: 1,
					subject: { kind: "release", version: "0.39.0" },
					components: ["observer", "injection"],
				},
				{
					label: "candidate",
					requested_ref: COMMIT,
					observer_context_schema_version: 1,
					subject: { kind: "candidate", version: "0.40.0" },
					components: ["observer", "retrieval"],
				},
			],
			repetitions: 1,
		};
		const retrieval = {
			schema_version: 1,
			rows: [
				{
					case_id: "probe",
					ordinal: 0,
					row_type: "retrieval_probe",
					value: {
						query: "target",
						expected_mode: "default",
						relevant_case_ids: ["case"],
						expected_artifact: "durable",
						explicit_recap: false,
						top_n: 5,
					},
				},
			],
		};
		const injection = {
			schema_version: 1,
			rows: [
				{
					case_id: "injection",
					ordinal: 0,
					row_type: "injection_case",
					value: { scenario_class: "locating" },
				},
			],
		};
		test.files.set(manifestPath, JSON.stringify(manifest));
		test.files.set(observerPath, JSON.stringify(observer));
		test.files.set(retrievalPath, JSON.stringify(retrieval));
		test.files.set(injectionPath, JSON.stringify(injection));
		test.files.set(
			resolve(ROOT, "scripts/eval/release/component-files.json"),
			JSON.stringify({
				schema_version: 1,
				components: {
					evaluator: ["evaluator.ts"],
					retrieval: ["retrieval.ts"],
					injection: ["injection.ts"],
				},
			}),
		);
		const result = await preflightReleaseEval({
			repositoryRoot: ROOT,
			manifestPath,
			retrievalCorpusPath: retrievalPath,
			injectionCorpusPath: injectionPath,
			dependencies: test.dependencies,
		});
		expect(result.manifest.corpora).toHaveLength(1);
		expect(result.retrievalCorpusPath).toBe(retrievalPath);
		expect(result.injectionCorpusPath).toBe(injectionPath);
		expect(result.retrievalCorpusDigest).toBe(digestCorpus(retrieval as ProjectedCorpusV1));

		const candidate = manifest.subjects.find((subject) => subject.subject.kind === "candidate");
		if (!candidate) throw new Error("candidate fixture missing");
		candidate.components = ["observer"];
		test.files.set(manifestPath, JSON.stringify(manifest));
		await expect(
			runReleaseEval({
				repositoryRoot: ROOT,
				manifestPath,
				retrievalCorpusPath: retrievalPath,
				injectionCorpusPath: injectionPath,
				dependencies: test.dependencies,
			}),
		).rejects.toThrow("candidate with observer and retrieval components");
		expect(test.events).not.toContain("refs-resolved");
	});
});
