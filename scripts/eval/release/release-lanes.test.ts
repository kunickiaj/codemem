import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MemoryResult, MemoryStore, type PackTrace } from "@codemem/core";
import { describe, expect, it } from "vitest";
import {
	bucketItem,
	compareToBaseline,
	finalPackOrder,
	probeSuiteDigest,
	runProbe,
	snapshot,
} from "../lib.js";
import type { HistoricalObserverSubject } from "./historical-observer.js";
import { runHistoricalPackDriver } from "./historical-pack.js";
import {
	adaptProjectedInjectionCases,
	answerFromProviderContext,
	normalizeExpectedWorkingSetPaths,
	runInjectionBenchmark,
	scoreInjectionCase,
} from "./injection-benchmark.js";
import type { ObserverCaseRunResult } from "./observer-runner.js";
import { adaptProjectedRetrievalProbes, runRetrievalMatrix } from "./retrieval-matrix.js";
import {
	assertSemanticReady,
	runCandidateSemanticRetrieval,
	type SemanticRetrievalDependencies,
	type SemanticRetrievalReadiness,
	type SemanticRetrievalStore,
} from "./semantic-retrieval.js";
import {
	type Digest,
	type HistoricalInjectionTraceV1,
	type ProjectedCorpusV1,
	RETRIEVAL_METRIC_IDS,
} from "./types.js";

const SHA = `sha256:${"a".repeat(64)}` as Digest;

function retrievalCorpus(): ProjectedCorpusV1 {
	return {
		schema_version: 1,
		rows: [
			{
				case_id: "probe",
				ordinal: 0,
				row_type: "retrieval_probe",
				value: {
					query: "durable target",
					expected_mode: "default",
					relevant_case_ids: ["target"],
					expected_artifact: "durable",
					explicit_recap: false,
					top_n: 5,
				},
			},
		],
	};
}

function observerRun(version: string): ObserverCaseRunResult {
	return {
		subject: {
			label: version,
			resolvedCommit: version === "0.37.1" ? "3".repeat(40) : "8".repeat(40),
			sanitizedSubject: { kind: "release", version },
		},
		caseId: "target",
		repetition: 1,
		status: "pass",
		final: {
			parsed: {
				observations: [
					{
						kind: "discovery",
						title: "durable target",
						narrative: "durable target",
						subtitle: null,
						facts: [],
						concepts: [],
						filesRead: [],
						filesModified: [],
					},
				],
				summary: null,
				skipSummaryReason: null,
			},
		},
	} as unknown as ObserverCaseRunResult;
}

function subject(version: "0.37.1" | "0.38.0"): HistoricalObserverSubject {
	const commit = version === "0.37.1" ? "3".repeat(40) : "8".repeat(40);
	return {
		label: version,
		requestedRef: `v${version}`,
		observerContextSchemaVersion: 1,
		sanitizedSubject: { kind: "release", version },
		productVersion: version,
		resolvedCommit: commit,
		worktreePath: "/ignored",
		buildObserverPrompt: async () => ({ system: "", user: "" }),
		componentDigest: async () => SHA,
		runPack: async (request) => ({
			traces: request.probes.map((probe) => ({
				probe_id: probe.probe_id,
				mode: "default",
				retrieval: { candidates: [{ id: 1, rank: 9 }] },
				assembly: { sections: { summary: [], timeline: [1], observations: [] } },
			})),
			materialized_items: request.memories.map((memory, index) => ({
				id: index + 1,
				memory_key: memory.memory_key,
				kind: memory.kind,
				title: memory.title,
				body_text: memory.body_text,
				metadata: memory.metadata,
			})),
			usage_row_count: 0,
		}),
	};
}

describe("release retrieval and injection lanes", () => {
	it("scores final assembled order rather than retrieval candidate rank", async () => {
		expect(
			finalPackOrder({
				assembly: { sections: { summary: [2], timeline: [1, 2], observations: [3] } },
			}),
		).toEqual([2, 1, 3]);
		const result = await runRetrievalMatrix({
			corpus: retrievalCorpus(),
			observerRuns: [observerRun("0.37.1"), observerRun("0.38.0")],
			subjects: [subject("0.37.1"), subject("0.38.0")],
			repetitions: 1,
			sourceCorpusDigest: SHA,
			storeRoot: "/tmp/release-retrieval",
			mkdir: async () => {},
		});
		expect(
			result.metrics
				.filter((metric) => metric.id === "mean_relevant_rank")
				.every((metric) => metric.value === 1),
		).toBe(true);
		expect(result.detailed.lane).toBe("historical_keyword");
	});

	it("accepts historical keyword traces without modern artifact markers", async () => {
		let environment: NodeJS.ProcessEnv | undefined;
		const result = await runHistoricalPackDriver({
			execute: async (_command, _args, options) => {
				environment = options.env;
				return {
					exitCode: 0,
					stderr: "",
					stdout: JSON.stringify({
						schema_version: 1,
						ok: true,
						result: {
							traces: [
								{
									probe_id: "probe",
									mode: "default",
									retrieval: { candidates: [{ id: 1, rank: 1 }] },
									assembly: { sections: { summary: [], timeline: [1], observations: [] } },
								},
							],
							materialized_items: [
								{
									id: 1,
									memory_key: "case:observation:0",
									kind: "discovery",
									title: "target",
									body_text: "target",
									metadata: {},
								},
							],
							usage_row_count: 0,
						},
					}),
				};
			},
			nodeExecutable: "/node",
			driverPath: "/repository/driver.ts",
			worktreePath: "/repository/.tmp/worktree",
			repositoryRoot: "/repository",
			tsxImportPath: "/repository/tsx.mjs",
			prepareDependencies: async () => {},
			realpath: async (path) => path,
			request: {
				schema_version: 1,
				operation: "run_pack_traces",
				store_path: "/repository/.tmp/store.sqlite",
				memories: [],
				probes: [],
			},
		});
		expect(result.traces[0]?.retrieval.candidates[0]).toEqual({ id: 1, rank: 1 });
		expect(environment?.CODEMEM_EMBEDDING_DISABLED).toBe("1");
	});

	it("rejects a different canonical probe-suite identity even when counts match", () => {
		const metrics = [
			{
				query: "one",
				mode: "default",
				packMode: "default",
				topN: 1,
				shares: { session_summary: 0, derived_fact: 1, telemetry: 0, durable_other: 0 },
				markerShares: { session_summary: 0, derived_fact: 1, telemetry: 0, unknown: 0 },
				top1: "derived_fact",
			},
		] as const;
		const prior = snapshot([...metrics], probeSuiteDigest([{ query: "one", mode: "default" }], 1));
		const current = snapshot(
			[...metrics],
			probeSuiteDigest([{ query: "two", mode: "default" }], 1),
		);
		expect(compareToBaseline(prior, current)).toMatchObject({ ok: false });
	});

	it("excludes demoted unknown rows from durable share", () => {
		expect(
			bucketItem({
				kind: "change",
				title: "continue pending work",
				body_text: "next step only",
				metadata: {},
			}),
		).toBe("telemetry");
	});

	it("consumes strict PR2 retrieval and injection sidecar row shapes", () => {
		expect(adaptProjectedRetrievalProbes(retrievalCorpus())).toHaveLength(1);
		const injection: ProjectedCorpusV1 = {
			schema_version: 1,
			rows: [
				{
					case_id: "synthetic-injection",
					ordinal: 0,
					row_type: "injection_case",
					value: {
						scenario_class: "locating",
						first_prompt: "find",
						latest_prompt: "find",
						project_name: "release-eval",
						files_modified: [],
						expected_query: "find release-eval",
						injection_enabled: true,
						pack_outcome: "success",
						pack_text: "[[answer:found]]",
						memory_ids: ["memory-1"],
						expected_memory_ids: ["memory-1"],
						expected_answer: "found",
					},
				},
			],
		};
		expect(adaptProjectedInjectionCases(injection)).toHaveLength(1);
		expect(
			answerFromProviderContext(["fixture [[answer:no]]", "[codemem context]\n[[answer:found]]"]),
		).toBe("found");
	});

	it.each([
		["success", true, "success", true],
		["disabled", false, "success", false],
		["empty", true, "empty", false],
		["malformed", true, "malformed", false],
		["exit error", true, "exit_error", false],
	] as const)("scores %s injection delivery and containment", (_name, enabled, outcome, deliver) => {
		const packText = deliver ? "[[answer:used]]" : "";
		const expected = `[codemem context]\n${packText}`;
		const trace: HistoricalInjectionTraceV1 = {
			hook: "experimental.chat.messages.transform",
			runner: {
				invoked: enabled,
				args: enabled ? ["pack", "prompt release-eval", "--json"] : [],
				query: enabled ? "prompt release-eval" : null,
				memory_ids: deliver ? ["memory-1"] : [],
			},
			before: { system: ["base"], messages: [] },
			after: {
				system: ["base"],
				messages: [
					{
						info: { role: "user" },
						parts: [{ text: "prompt" }, ...(deliver ? [{ text: expected }] : [])],
					},
				],
			},
			session_survived: true,
			process_id: 1,
		};
		const scores = scoreInjectionCase(
			{
				caseId: "case",
				scenarioClass: "locating",
				firstPrompt: "prompt",
				latestPrompt: "prompt",
				projectName: "release-eval",
				filesModified: [],
				expectedQuery: "prompt release-eval",
				injectionEnabled: enabled,
				packOutcome: outcome,
				packText,
				memoryIds: deliver ? ["memory-1"] : [],
				expectedMemoryIds: deliver ? ["memory-1"] : [],
				expectedAnswer: "used",
			},
			trace,
		);
		if (deliver) {
			expect(scores.retrieval_success_rate).toBe(1);
			expect(scores.exact_delivery_rate).toBe(1);
			expect(scores.deterministic_answer_use_rate).toBe(1);
		} else {
			expect(scores.correct_no_delivery_rate).toBe(1);
		}
		expect(scores.session_survival_rate).toBe(1);
	});

	it("mirrors plugin working-set trimming and overlength dropping", () => {
		const overlength = "x".repeat(401);
		expect(
			normalizeExpectedWorkingSetPaths([
				"ignored-before-last-eight",
				"  src/one.ts  ",
				"",
				overlength,
				"src/two.ts",
				"src/three.ts",
				"src/four.ts",
				"src/five.ts",
				"src/six.ts",
			]),
		).toEqual([
			"src/one.ts",
			"src/two.ts",
			"src/three.ts",
			"src/four.ts",
			"src/five.ts",
			"src/six.ts",
		]);
	});

	it("rejects injection aggregates with an empty applicable denominator", async () => {
		const corpus: ProjectedCorpusV1 = {
			schema_version: 1,
			rows: [
				{
					case_id: "delivery-only",
					ordinal: 0,
					row_type: "injection_case",
					value: {
						scenario_class: "locating",
						first_prompt: "prompt",
						latest_prompt: "prompt",
						project_name: "release-eval",
						files_modified: [],
						expected_query: "prompt release-eval",
						injection_enabled: true,
						pack_outcome: "success",
						pack_text: "[[answer:used]]",
						memory_ids: ["memory-1"],
						expected_memory_ids: ["memory-1"],
						expected_answer: "used",
					},
				},
			],
		};
		const injectionSubject: HistoricalObserverSubject = {
			...subject("0.38.0"),
			runInjection: async () => ({
				hook: "experimental.chat.messages.transform",
				runner: {
					invoked: true,
					args: ["pack", "prompt release-eval", "--json"],
					query: "prompt release-eval",
					memory_ids: ["memory-1"],
				},
				before: { system: [], messages: [] },
				after: {
					system: [],
					messages: [
						{
							info: { role: "user" },
							parts: [{ text: "[codemem context]\n[[answer:used]]" }],
						},
					],
				},
				session_survived: true,
				process_id: 1,
			}),
		};
		await expect(
			runInjectionBenchmark({ corpus, subjects: [injectionSubject], repetitions: 1 }),
		).rejects.toThrow("correct_no_delivery_rate has no applicable runs");
	});

	it("fails semantic readiness closed on incomplete embeddable indexing", () => {
		const ready: SemanticRetrievalReadiness = {
			state: "healthy",
			mode: "semantic",
			embedding_model: "model",
			semantic_search_model: "model",
			materialized_memory_count: 2,
			active_memory_count: 2,
			embeddable_memory_count: 1,
			indexed_memory_count: 1,
			pending_memory_count: 0,
			tagged_memory_count: 2,
			expected_file_ref_count: 0,
			file_ref_count: 0,
			expected_concept_ref_count: 0,
			concept_ref_count: 0,
			pending_ref_backfill: false,
			blocking_maintenance_jobs: [],
		};
		expect(() => assertSemanticReady(ready)).toThrow("incomplete embeddable vector coverage");
	});

	it("materializes and scores candidate summaries for explicit recap probes", async () => {
		const remembered: Array<{
			id: number;
			kind: string;
			title: string;
			body: string;
			metadata: Record<string, unknown>;
		}> = [];
		const store: SemanticRetrievalStore = {
			db: {} as SemanticRetrievalStore["db"],
			startSession: () => 1,
			remember: (_session, kind, title, body, _confidence, _tags, metadata = {}) => {
				const id = remembered.length + 1;
				remembered.push({ id, kind, title, body, metadata });
				return id;
			},
			flushPendingVectorWrites: async () => {},
			ownershipFilterContext: () => ({
				actorId: "fixture-actor",
				deviceId: "fixture-device",
				claimedDeviceIds: [],
				legacyActorIds: [],
				enforceScopeVisibility: true,
			}),
			close: () => {},
		};
		const dependencies: SemanticRetrievalDependencies = {
			mkdir: async () => {},
			resolveStorePath: async () => "/repository/.tmp/eval-results/release/semantic.sqlite",
			createStore: () => store,
			backfill: async () => {},
			inspectReadiness: () => ({
				state: "healthy",
				mode: "semantic",
				embedding_model: "fixture-model",
				semantic_search_model: "fixture-model",
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
				blocking_maintenance_jobs: [],
			}),
			search: async () =>
				remembered.map(
					(memory): MemoryResult => ({
						id: memory.id,
						kind: memory.kind,
						title: memory.title,
						body_text: memory.body,
						confidence: 0.8,
						created_at: "2026-01-01T00:00:00.000Z",
						updated_at: "2026-01-01T00:00:00.000Z",
						tags_text: "",
						score: 1,
						session_id: 1,
						metadata: memory.metadata,
						narrative: null,
						facts: null,
					}),
				),
			pack: async () =>
				({
					mode: { selected: "recall" },
					assembly: { sections: { summary: [1], timeline: [], observations: [] } },
				}) as unknown as PackTrace,
		};
		const summaryRun = {
			subject: {
				label: "candidate",
				resolvedCommit: "c".repeat(40),
				sanitizedSubject: { kind: "candidate", version: "0.40.0" },
			},
			caseId: "summary-case",
			repetition: 1,
			status: "pass",
			final: {
				parsed: {
					observations: [],
					summary: {
						request: "Recap target",
						completed: "Completed recap target",
						learned: "Summary evidence",
						investigated: "",
						nextSteps: "",
						notes: "",
						filesRead: [],
						filesModified: [],
					},
					skipSummaryReason: null,
				},
			},
		} as unknown as ObserverCaseRunResult;
		const corpus: ProjectedCorpusV1 = {
			schema_version: 1,
			rows: [
				{
					case_id: "summary-probe",
					ordinal: 0,
					row_type: "retrieval_probe",
					value: {
						query: "recap target",
						expected_mode: "recall",
						relevant_case_ids: ["summary-case"],
						expected_artifact: "session_summary",
						explicit_recap: true,
						top_n: 5,
					},
				},
			],
		};
		const evidence = await runCandidateSemanticRetrieval({
			corpus,
			repositoryRoot: "/repository",
			observerRuns: [summaryRun],
			repetition: 1,
			storePath: "/repository/.tmp/eval-results/release/semantic.sqlite",
			sourceCorpusDigest: SHA,
			retrievalSubjectDigest: `sha256:${"d".repeat(64)}`,
			dependencies,
		});
		expect(remembered[0]).toMatchObject({
			kind: "session_summary",
			metadata: { is_summary: true, source: "observer_summary" },
		});
		expect(evidence.source_corpus_digest).toBe(SHA);
		expect(evidence.metrics.map((metric) => metric.id)).toEqual([...RETRIEVAL_METRIC_IDS]);
		for (const id of [
			"relevant_placement_rate",
			"mean_relevant_rank",
			"summary_share",
			"routing_accuracy",
			"expected_artifact_top1_rate",
			"explicit_recap_preservation_rate",
		] as const) {
			expect(evidence.metrics.find((metric) => metric.id === id)?.value).toBe(1);
		}
		expect(evidence.metrics.find((metric) => metric.id === "durable_share")?.value).toBe(0);
	});

	it("runs eval pack through the current asynchronous product path", async () => {
		const root = await mkdtemp(join(tmpdir(), "codemem-eval-pack-"));
		const previous = process.env.CODEMEM_EMBEDDING_DISABLED;
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		const store = new MemoryStore(join(root, "store.sqlite"));
		try {
			const session = store.startSession({ project: "release-eval", toolVersion: "test" });
			store.remember(
				session,
				"discovery",
				"durable async target",
				"durable async target",
				0.8,
				[],
				{},
			);
			const metric = await runProbe(store, { query: "durable async target", mode: "default" }, 5);
			expect(metric.topN).toBeGreaterThan(0);
		} finally {
			store.close();
			if (previous === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
			else process.env.CODEMEM_EMBEDDING_DISABLED = previous;
			await rm(root, { recursive: true, force: true });
		}
	});
});
