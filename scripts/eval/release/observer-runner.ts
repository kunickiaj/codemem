import { scoreExtractionBenchmarkOutput } from "../../../packages/core/src/extraction-benchmark-scoring.js";
import type { ExtractionBenchmarkReview } from "../../../packages/core/src/extraction-benchmarks.js";
import type { ObserverContext, ParsedOutput } from "../../../packages/core/src/ingest-types.js";
import type { ObserverResponseStructuralDiagnostics } from "../../../packages/core/src/ingest-xml-parser.js";
import {
	inspectObserverResponseStructure,
	parseObserverResponse,
	shouldRepairObserverResponse,
} from "../../../packages/core/src/ingest-xml-parser.js";
import type { ObserverTokenUsage } from "../../../packages/core/src/observer-client.js";
import { compareCodePoints } from "./canonical.js";
import { parseProjectedCorpus } from "./corpus.js";
import type { HistoricalObserverSubject } from "./historical-observer.js";
import { exactKeys, jsonObject } from "./json-shape.js";
import type {
	JsonValue,
	ObserverMetric,
	SanitizedObserverMetric,
	SanitizedSubjectIdentifier,
} from "./types.js";

type SummaryDisposition = "required" | "optional" | "skip";
export type ObserverCaseStatus =
	| "pass"
	| "shape_failure"
	| "no_output"
	| "malformed"
	| "fallback"
	| "unavailable"
	| "partial";

interface ProjectedObserverCase {
	caseId: string;
	ordinal: number;
	context: ObserverContext;
	review: ExtractionBenchmarkReview & { status: "reviewed" };
	expectedSummaryDisposition: SummaryDisposition;
	expectedObservationPolicy: "zero" | "quality";
}

export interface ObserverInvocationRequest {
	system: string;
	user: string;
	subject: { label: string; resolvedCommit: string; sanitizedSubject: SanitizedSubjectIdentifier };
	caseId: string;
	repetition: number;
	attempt: "initial" | "repair";
}

export interface ObserverInvocationResult {
	status: "completed" | "unavailable" | "partial";
	raw: string | null;
	provider: string;
	requestedModel: string;
	resolvedModel: string | null;
	modelFallbackApplied: boolean;
	fallbackReason: string | null;
	elapsedMs: number | null;
	usage: ObserverTokenUsage | null;
	estimatedCostUsd: number | null;
	error: string | null;
}

export interface ObserverInvoker {
	invoke(request: ObserverInvocationRequest): Promise<ObserverInvocationResult>;
}

export interface ObserverAttemptResult extends ObserverInvocationResult {
	parsed: ParsedOutput;
	diagnostics: ObserverResponseStructuralDiagnostics;
	caseStatus: ObserverCaseStatus;
	score: ReturnType<typeof scoreExtractionBenchmarkOutput>;
}

export interface ObserverCaseRunResult {
	subject: ObserverInvocationRequest["subject"];
	caseId: string;
	caseOrdinal: number;
	repetition: number;
	prompt: { system: string; user: string };
	context: ObserverContext;
	expectedObservationPolicy: "zero" | "quality";
	initial: ObserverAttemptResult;
	repaired: ObserverAttemptResult | null;
	final: ObserverAttemptResult;
	status: ObserverCaseStatus;
	repairApplied: boolean;
	totalElapsedMs: number | null;
	totalUsage: ObserverTokenUsage | null;
	totalEstimatedCostUsd: number | null;
}

export interface ObserverRunnerResult {
	runs: ObserverCaseRunResult[];
	sanitizedMetrics: SanitizedObserverMetric[];
	caseResults: JsonValue[];
}

export type ObserverExecutionBucket = "completed" | "unavailable" | "partial" | "failed";

export function observerExecutionBucket(status: ObserverCaseStatus): ObserverExecutionBucket {
	switch (status) {
		case "pass":
		case "fallback":
			return "completed";
		case "unavailable":
			return "unavailable";
		case "partial":
			return "partial";
		case "shape_failure":
		case "no_output":
		case "malformed":
			return "failed";
	}
	const unsupported: never = status;
	throw new TypeError(`Unsupported observer case status: ${String(unsupported)}`);
}

export function observerExecutionCounts(
	runs: readonly ObserverCaseRunResult[],
): Record<ObserverExecutionBucket, number> {
	const counts: Record<ObserverExecutionBucket, number> = {
		completed: 0,
		unavailable: 0,
		partial: 0,
		failed: 0,
	};
	for (const run of runs) counts[observerExecutionBucket(run.status)] += 1;
	return counts;
}

function text(value: unknown, path: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && !value.trim()))
		throw new TypeError(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
	return value;
}

function nullableText(value: unknown, path: string): string | null {
	return value === null ? null : text(value, path, true);
}

function parseContext(value: unknown, path: string): ObserverContext {
	const context = jsonObject(value, path);
	exactKeys(
		context,
		[
			"project",
			"user_prompt",
			"prompt_number",
			"transcript",
			"tool_events",
			"last_assistant_message",
			"include_summary",
			"diff_summary",
			"recent_files",
		],
		path,
	);
	if (
		context.prompt_number !== null &&
		(!Number.isSafeInteger(context.prompt_number) || (context.prompt_number as number) < 0)
	)
		throw new TypeError(`${path}.prompt_number must be null or nonnegative`);
	if (typeof context.include_summary !== "boolean" || !Array.isArray(context.tool_events))
		throw new TypeError(`${path} has invalid observer context fields`);
	return {
		project: nullableText(context.project, `${path}.project`),
		userPrompt: text(context.user_prompt, `${path}.user_prompt`, true),
		promptNumber: context.prompt_number as number | null,
		transcript: text(context.transcript, `${path}.transcript`, true),
		toolEvents: context.tool_events.map((entry, index) => {
			const eventPath = `${path}.tool_events[${index}]`;
			const event = jsonObject(entry, eventPath);
			exactKeys(
				event,
				["tool_name", "tool_input", "tool_output", "tool_error", "timestamp", "cwd"],
				eventPath,
			);
			return {
				toolName: text(event.tool_name, `${eventPath}.tool_name`),
				toolInput: event.tool_input,
				toolOutput: event.tool_output,
				toolError: event.tool_error,
				timestamp: nullableText(event.timestamp, `${eventPath}.timestamp`),
				cwd: nullableText(event.cwd, `${eventPath}.cwd`),
			};
		}),
		lastAssistantMessage: nullableText(
			context.last_assistant_message,
			`${path}.last_assistant_message`,
		),
		includeSummary: context.include_summary,
		diffSummary: text(context.diff_summary, `${path}.diff_summary`, true),
		recentFiles: text(context.recent_files, `${path}.recent_files`, true),
	};
}

function parseLabels(
	value: unknown,
	disposition: "required" | "optional" | "forbidden",
	path: string,
) {
	if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
	return value.map((entry, index) => {
		const labelPath = `${path}[${index}]`;
		const label = jsonObject(entry, labelPath);
		exactKeys(
			label,
			["label_id", "title", "keyword_groups", "reviewer_notes", "evidence_notes"],
			labelPath,
		);
		if (!Array.isArray(label.keyword_groups) || label.keyword_groups.length === 0)
			throw new TypeError(`${labelPath}.keyword_groups must be non-empty`);
		return {
			id: text(label.label_id, `${labelPath}.label_id`),
			title: text(label.title, `${labelPath}.title`),
			disposition,
			keywordGroups: label.keyword_groups.map((group, groupIndex) => {
				if (!Array.isArray(group) || group.length === 0)
					throw new TypeError(`${labelPath}.keyword_groups[${groupIndex}] must be non-empty`);
				return group.map((word, wordIndex) =>
					text(word, `${labelPath}.keyword_groups[${groupIndex}][${wordIndex}]`),
				);
			}),
			reviewerNotes: text(label.reviewer_notes, `${labelPath}.reviewer_notes`),
			sourceEvidence: text(label.evidence_notes, `${labelPath}.evidence_notes`),
		};
	});
}

export function adaptProjectedObserverCases(input: unknown): ProjectedObserverCase[] {
	const corpus = parseProjectedCorpus(input);
	const unsupported = corpus.rows.find((row) => row.row_type !== "observer_case");
	if (unsupported)
		throw new TypeError(
			`projected corpus row_type ${unsupported.row_type} is not supported by observer scope`,
		);
	const cases = corpus.rows.map((row, index): ProjectedObserverCase => {
		const path = `projected corpus observer row[${index}]`;
		const value = jsonObject(row.value, `${path}.value`);
		exactKeys(
			value,
			["observer_context", "review", "expected_summary_disposition", "expected_observation_policy"],
			`${path}.value`,
		);
		const review = jsonObject(value.review, `${path}.value.review`);
		exactKeys(
			review,
			["reviewer_notes", "required", "optional", "forbidden"],
			`${path}.value.review`,
		);
		const summaryDisposition = text(
			value.expected_summary_disposition,
			`${path}.value.expected_summary_disposition`,
		);
		if (
			summaryDisposition !== "required" &&
			summaryDisposition !== "optional" &&
			summaryDisposition !== "skip"
		)
			throw new TypeError(`${path}.value.expected_summary_disposition is not supported`);
		const observationPolicy = text(
			value.expected_observation_policy,
			`${path}.value.expected_observation_policy`,
		);
		if (observationPolicy !== "zero" && observationPolicy !== "quality")
			throw new TypeError(`${path}.value.expected_observation_policy is not supported`);
		const labels = [
			...parseLabels(review.required, "required", `${path}.value.review.required`),
			...parseLabels(review.optional, "optional", `${path}.value.review.optional`),
			...parseLabels(review.forbidden, "forbidden", `${path}.value.review.forbidden`),
		];
		if (new Set(labels.map((label) => label.id)).size !== labels.length)
			throw new TypeError(`${path}.value.review label IDs must be unique`);
		return {
			caseId: row.case_id,
			ordinal: row.ordinal,
			context: parseContext(value.observer_context, `${path}.value.observer_context`),
			review: {
				status: "reviewed" as const,
				reviewerNotes: text(review.reviewer_notes, `${path}.value.review.reviewer_notes`),
				labels,
			},
			expectedSummaryDisposition: summaryDisposition,
			expectedObservationPolicy: observationPolicy,
		};
	});
	if (cases.length === 0)
		throw new TypeError("projected observer corpus must contain at least one case");
	if (new Set(cases.map((entry) => entry.caseId)).size !== cases.length)
		throw new TypeError("projected observer case IDs must be unique");
	return cases.toSorted(
		(left, right) => left.ordinal - right.ordinal || compareCodePoints(left.caseId, right.caseId),
	);
}

function classify(
	invocation: ObserverInvocationResult,
	diagnostics: ObserverResponseStructuralDiagnostics,
): ObserverCaseStatus {
	if (invocation.status === "unavailable" || invocation.status === "partial")
		return invocation.status;
	if (!invocation.raw) return "no_output";
	if (!diagnostics.recognizedOutput) return "malformed";
	if (
		diagnostics.dataLoss ||
		diagnostics.illegalObservationNestingInSummary > 0 ||
		diagnostics.unknownSummaryFields.length > 0 ||
		diagnostics.unsupportedObservationKinds.length > 0 ||
		diagnostics.missingObservationKinds > 0
	)
		return "shape_failure";
	return invocation.modelFallbackApplied ? "fallback" : "pass";
}

function score(
	invocation: ObserverInvocationResult,
	review: ExtractionBenchmarkReview,
	expected: SummaryDisposition,
): ObserverAttemptResult {
	const parsed = invocation.raw
		? parseObserverResponse(invocation.raw)
		: { observations: [], summary: null, skipSummaryReason: null };
	const diagnostics = inspectObserverResponseStructure(invocation.raw ?? "", parsed);
	return {
		...invocation,
		parsed,
		diagnostics,
		caseStatus: classify(invocation, diagnostics),
		score: scoreExtractionBenchmarkOutput({
			parsed,
			diagnostics,
			review,
			expectedSummaryDisposition: expected,
			estimatedCostUsd: invocation.estimatedCostUsd,
		}),
	};
}

function repairPrompt(prompt: { system: string; user: string }, raw: string) {
	return {
		system: `${prompt.system}\n\nYour previous reply was invalid because it did not follow the required XML-only schema. Rewrite the same analysis as valid XML only.`,
		user: `${prompt.user}\n\nPrevious invalid response to rewrite as valid XML:\n${raw}`,
	};
}

export function addObserverUsage(
	left: ObserverTokenUsage | null,
	right: ObserverTokenUsage | null | undefined,
): ObserverTokenUsage | null {
	if (!right) return left ? { ...left } : null;
	if (!left) return { ...right };
	const optionalTotal = (
		key: "cacheReadInputTokens" | "cacheCreationInputTokens",
	): number | undefined =>
		left[key] === undefined && right[key] === undefined
			? undefined
			: (left[key] ?? 0) + (right[key] ?? 0);
	const cacheReadInputTokens = optionalTotal("cacheReadInputTokens");
	const cacheCreationInputTokens = optionalTotal("cacheCreationInputTokens");
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		totalTokens:
			(left.totalTokens ?? left.inputTokens + left.outputTokens) +
			(right.totalTokens ?? right.inputTokens + right.outputTokens),
		...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
		...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
	};
}

function mean(values: Array<number | null | undefined>): number | null {
	const known = values.filter((value): value is number => value != null && Number.isFinite(value));
	return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

function aggregate(runs: ObserverCaseRunResult[], phase: "initial" | "final"): ObserverMetric[] {
	const attempt = (run: ObserverCaseRunResult) => (phase === "initial" ? run.initial : run.final);
	const complete = runs.filter((run) => {
		const bucket = observerExecutionBucket(attempt(run).caseStatus);
		return bucket === "completed" || bucket === "failed";
	});
	const zero = complete.filter((run) => run.expectedObservationPolicy === "zero");
	const values: Array<[ObserverMetric["id"], number | null, ObserverMetric["unit"]]> = [
		[
			"required_fact_recall",
			mean(complete.map((run) => attempt(run).score.requiredRecall.score)),
			"ratio",
		],
		[
			"forbidden_noise_avoidance",
			mean(complete.map((run) => attempt(run).score.forbidden.avoidance)),
			"ratio",
		],
		[
			"correct_silence_rate",
			mean(
				zero.map((run) =>
					attempt(run).score.schemaCompliance.score === 1 &&
					attempt(run).parsed.observations.length === 0
						? 1
						: 0,
				),
			),
			"ratio",
		],
		[
			"summary_disposition_accuracy",
			mean(complete.map((run) => attempt(run).score.summaryDisposition.score)),
			"ratio",
		],
		[
			"schema_compliance_rate",
			mean(complete.map((run) => attempt(run).score.schemaCompliance.score)),
			"ratio",
		],
		[
			"parser_data_loss_rate",
			mean(complete.map((run) => (attempt(run).diagnostics.dataLoss ? 1 : 0))),
			"ratio",
		],
		[
			"fallback_rate",
			mean(complete.map((run) => (attempt(run).modelFallbackApplied ? 1 : 0))),
			"ratio",
		],
		[
			"observation_count",
			mean(complete.map((run) => attempt(run).parsed.observations.length)),
			"count",
		],
		[
			"latency",
			mean(
				complete.map((run) => (phase === "initial" ? run.initial.elapsedMs : run.totalElapsedMs)),
			),
			"milliseconds",
		],
		[
			"input_tokens",
			mean(
				complete.map(
					(run) => (phase === "initial" ? run.initial.usage : run.totalUsage)?.inputTokens,
				),
			),
			"tokens",
		],
		[
			"output_tokens",
			mean(
				complete.map(
					(run) => (phase === "initial" ? run.initial.usage : run.totalUsage)?.outputTokens,
				),
			),
			"tokens",
		],
		[
			"cost",
			mean(
				complete.map((run) =>
					phase === "initial" ? run.initial.estimatedCostUsd : run.totalEstimatedCostUsd,
				),
			),
			"usd",
		],
	];
	return values.flatMap(([id, value, unit]) => (value === null ? [] : [{ id, value, unit }]));
}

export async function runCurrentEvaluatorObserver(input: {
	corpus: unknown;
	subjects: HistoricalObserverSubject[];
	repetitions: number;
	invoker: ObserverInvoker;
}): Promise<ObserverRunnerResult> {
	if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 1)
		throw new TypeError("observer repetitions must be a positive safe integer");
	if (input.subjects.length === 0) throw new TypeError("at least one observer subject is required");
	const cases = adaptProjectedObserverCases(input.corpus);
	const runs: ObserverCaseRunResult[] = [];
	for (const subject of input.subjects) {
		for (const observerCase of cases) {
			const prompt = await subject.buildObserverPrompt(observerCase.context);
			for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
				const identity = {
					label: subject.label,
					resolvedCommit: subject.resolvedCommit,
					sanitizedSubject: subject.sanitizedSubject,
				};
				const initialInvocation = await input.invoker.invoke({
					...prompt,
					subject: identity,
					caseId: observerCase.caseId,
					repetition,
					attempt: "initial",
				});
				const initial = score(
					initialInvocation,
					observerCase.review,
					observerCase.expectedSummaryDisposition,
				);
				let repaired: ObserverAttemptResult | null = null;
				if (
					initialInvocation.status === "completed" &&
					shouldRepairObserverResponse(initialInvocation.raw, initial.parsed)
				) {
					const repairedInvocation = await input.invoker.invoke({
						...repairPrompt(prompt, initialInvocation.raw as string),
						subject: identity,
						caseId: observerCase.caseId,
						repetition,
						attempt: "repair",
					});
					repaired = score(
						repairedInvocation,
						observerCase.review,
						observerCase.expectedSummaryDisposition,
					);
				}
				const final = repaired ?? initial;
				runs.push({
					subject: identity,
					caseId: observerCase.caseId,
					caseOrdinal: observerCase.ordinal,
					repetition,
					prompt,
					context: observerCase.context,
					expectedObservationPolicy: observerCase.expectedObservationPolicy,
					initial,
					repaired,
					final,
					status: final.caseStatus,
					repairApplied: repaired !== null,
					totalElapsedMs:
						initial.elapsedMs === null || (repaired && repaired.elapsedMs === null)
							? null
							: initial.elapsedMs + (repaired?.elapsedMs ?? 0),
					totalUsage:
						!initial.usage || (repaired && !repaired.usage)
							? null
							: addObserverUsage(initial.usage, repaired?.usage),
					totalEstimatedCostUsd:
						initial.estimatedCostUsd === null || (repaired && repaired.estimatedCostUsd === null)
							? null
							: initial.estimatedCostUsd + (repaired?.estimatedCostUsd ?? 0),
				});
			}
		}
	}
	const sanitizedMetrics = input.subjects.flatMap((subject) => {
		const subjectRuns = runs.filter(
			(run) =>
				run.subject.resolvedCommit === subject.resolvedCommit &&
				JSON.stringify(run.subject.sanitizedSubject) === JSON.stringify(subject.sanitizedSubject),
		);
		return (["initial", "final"] as const).flatMap((phase) =>
			aggregate(subjectRuns, phase).map((metric) => ({
				...metric,
				subject: subject.sanitizedSubject,
				phase,
			})),
		);
	});
	return {
		runs,
		sanitizedMetrics,
		caseResults: runs.map(
			(run) =>
				({
					case_id: run.caseId,
					prompt: `${run.prompt.system}\n\n${run.prompt.user}`,
					transcript: run.context.transcript,
					initial_output: run.initial.raw ?? "",
					repaired_output: run.repaired?.raw ?? null,
					status: run.status,
					repetition: run.repetition,
					subject_label: run.subject.label,
					resolved_commit: run.subject.resolvedCommit,
				}) as JsonValue,
		),
	};
}
