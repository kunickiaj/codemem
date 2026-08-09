import { parseProjectedCorpus } from "./corpus.js";
import type { HistoricalObserverSubject } from "./historical-observer.js";
import { exactKeys, jsonObject } from "./json-shape.js";
import type {
	DetailedInjectionSuite,
	HistoricalInjectionRequestV1,
	HistoricalInjectionTraceV1,
	InjectionMetricId,
	InjectionSubjectMetric,
	InjectionSubjectProvenance,
	ProjectedCorpusV1,
} from "./types.js";

const CLASSES = ["locating", "decision", "outcome", "troubleshooting", "continuation"] as const;
const OUTCOMES = ["success", "empty", "malformed", "exit_error"] as const;
const MAX_WORKING_SET_PATH_CHARS = 400;
export interface ProjectedInjectionCase {
	caseId: string;
	scenarioClass: (typeof CLASSES)[number];
	firstPrompt: string;
	latestPrompt: string;
	projectName: string;
	filesModified: string[];
	expectedQuery: string;
	injectionEnabled: boolean;
	packOutcome: (typeof OUTCOMES)[number];
	packText: string;
	memoryIds: string[];
	expectedMemoryIds: string[];
	expectedAnswer: string;
}

type InjectionSubject = HistoricalObserverSubject & {
	runInjection: NonNullable<HistoricalObserverSubject["runInjection"]>;
	componentDigest: NonNullable<HistoricalObserverSubject["componentDigest"]>;
};

function isInjectionSubject(subject: HistoricalObserverSubject): subject is InjectionSubject {
	return Boolean(subject.runInjection && subject.componentDigest);
}

function strings(value: unknown, path: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
		throw new TypeError(`${path} must be a string array`);
	return value as string[];
}

export function adaptProjectedInjectionCases(input: unknown): ProjectedInjectionCase[] {
	const rows = parseProjectedCorpus(input).rows.filter((row) => row.row_type === "injection_case");
	const cases = rows.map((row, index) => {
		const path = `projected corpus injection row[${index}]`;
		const value = jsonObject(row.value, `${path}.value`);
		exactKeys(
			value,
			[
				"scenario_class",
				"first_prompt",
				"latest_prompt",
				"project_name",
				"files_modified",
				"expected_query",
				"injection_enabled",
				"pack_outcome",
				"pack_text",
				"memory_ids",
				"expected_memory_ids",
				"expected_answer",
			],
			`${path}.value`,
		);
		if (
			!CLASSES.includes(value.scenario_class as (typeof CLASSES)[number]) ||
			!OUTCOMES.includes(value.pack_outcome as (typeof OUTCOMES)[number])
		)
			throw new TypeError(`${path} classification is invalid`);
		if (
			typeof value.injection_enabled !== "boolean" ||
			[
				value.first_prompt,
				value.latest_prompt,
				value.project_name,
				value.expected_query,
				value.pack_text,
				value.expected_answer,
			].some((entry) => typeof entry !== "string")
		)
			throw new TypeError(`${path} fields are invalid`);
		return {
			caseId: row.case_id,
			scenarioClass: value.scenario_class as ProjectedInjectionCase["scenarioClass"],
			firstPrompt: value.first_prompt as string,
			latestPrompt: value.latest_prompt as string,
			projectName: value.project_name as string,
			filesModified: strings(value.files_modified, `${path}.files_modified`),
			expectedQuery: value.expected_query as string,
			injectionEnabled: value.injection_enabled,
			packOutcome: value.pack_outcome as ProjectedInjectionCase["packOutcome"],
			packText: value.pack_text as string,
			memoryIds: strings(value.memory_ids, `${path}.memory_ids`),
			expectedMemoryIds: strings(value.expected_memory_ids, `${path}.expected_memory_ids`),
			expectedAnswer: value.expected_answer as string,
		};
	});
	if (!cases.length) throw new TypeError("projected injection corpus must contain injection cases");
	return cases;
}

function visible(trace: HistoricalInjectionTraceV1): string[] {
	return [
		...trace.after.system,
		...trace.after.messages.flatMap((message) => {
			if (!message || typeof message !== "object" || Array.isArray(message)) return [];
			const parts = (message as { parts?: unknown }).parts;
			return Array.isArray(parts)
				? parts.flatMap((part) =>
						part &&
						typeof part === "object" &&
						!Array.isArray(part) &&
						typeof (part as { text?: unknown }).text === "string"
							? [(part as { text: string }).text]
							: [],
					)
				: [];
		}),
	];
}

export function answerFromProviderContext(context: readonly string[]): string | null {
	for (const value of context)
		if (value.startsWith("[codemem context]\n"))
			return value.match(/\[\[answer:([^\]\r\n]+)\]\]/)?.[1] ?? null;
	return null;
}

export function normalizeExpectedWorkingSetPaths(filesModified: readonly string[]): string[] {
	return filesModified
		.slice(-8)
		.map((value) => String(value || "").trim())
		.filter((value) => value.length > 0 && value.length <= MAX_WORKING_SET_PATH_CHARS);
}

export function scoreInjectionCase(
	entry: ProjectedInjectionCase,
	trace: HistoricalInjectionTraceV1,
): Record<InjectionMetricId, number | null> {
	const expected = `[codemem context]\n${entry.packText}`;
	const shouldDeliver =
		entry.injectionEnabled && entry.packOutcome === "success" && !!entry.packText.trim();
	const context = visible(trace);
	const latestUser = trace.after.messages
		.toReversed()
		.find(
			(message) =>
				message &&
				typeof message === "object" &&
				!Array.isArray(message) &&
				(message as { info?: { role?: unknown } }).info?.role === "user",
		) as { parts?: Array<{ text?: string }> } | undefined;
	const workingSet = trace.runner.args.flatMap((arg, index) =>
		arg === "--working-set-file" && trace.runner.args[index + 1]
			? [trace.runner.args[index + 1] as string]
			: [],
	);
	const expectedWorkingSet = normalizeExpectedWorkingSetPaths(entry.filesModified);
	const retrieval =
		trace.runner.invoked &&
		trace.runner.query === entry.expectedQuery &&
		trace.runner.args.slice(0, 3).join("\0") ===
			["pack", entry.expectedQuery, "--json"].join("\0") &&
		workingSet.length === expectedWorkingSet.length &&
		expectedWorkingSet.every((file, index) => workingSet[index] === file) &&
		entry.expectedMemoryIds.every((id) => trace.runner.memory_ids.includes(id));
	return {
		retrieval_success_rate: shouldDeliver ? Number(retrieval) : null,
		exact_delivery_rate: shouldDeliver
			? Number(context.filter((value) => value === expected).length === 1)
			: null,
		message_placement_rate: shouldDeliver
			? Number((latestUser?.parts ?? []).some((part) => part.text === expected))
			: null,
		deterministic_answer_use_rate: shouldDeliver
			? Number(answerFromProviderContext(context) === entry.expectedAnswer)
			: null,
		session_survival_rate: Number(trace.session_survived),
		correct_no_delivery_rate: shouldDeliver
			? null
			: Number(!context.some((value) => value.startsWith("[codemem context]"))),
	};
}

function mean(values: number[], metric: InjectionMetricId, subject: string): number {
	if (values.length === 0)
		throw new TypeError(`injection metric ${metric} has no applicable runs for ${subject}`);
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function runInjectionBenchmark(input: {
	corpus: ProjectedCorpusV1;
	subjects: HistoricalObserverSubject[];
	repetitions: number;
}): Promise<{
	detailed: DetailedInjectionSuite;
	metrics: InjectionSubjectMetric[];
	provenance: InjectionSubjectProvenance[];
}> {
	const cases = adaptProjectedInjectionCases(input.corpus);
	const subjects = input.subjects.filter(isInjectionSubject);
	if (!subjects.length)
		throw new TypeError("injection benchmark requires injection-capable subjects");
	const runs: DetailedInjectionSuite["runs"] = [];
	for (const subject of subjects)
		for (let repetition = 1; repetition <= input.repetitions; repetition += 1)
			for (const entry of cases) {
				const request: HistoricalInjectionRequestV1 = {
					schema_version: 1,
					operation: "run_plugin_injection",
					case: {
						first_prompt: entry.firstPrompt,
						latest_prompt: entry.latestPrompt,
						project_name: entry.projectName,
						files_modified: entry.filesModified,
						disabled: !entry.injectionEnabled,
						pack: {
							outcome: entry.packOutcome,
							pack_text: entry.packText,
							memory_ids: entry.memoryIds,
						},
					},
				};
				const trace = await subject.runInjection(request);
				runs.push({
					case_id: entry.caseId,
					scenario_class: entry.scenarioClass,
					subject: subject.sanitizedSubject,
					resolved_commit: subject.resolvedCommit,
					repetition,
					trace,
					scores: scoreInjectionCase(entry, trace),
				});
			}
	const metricIds = [
		"retrieval_success_rate",
		"exact_delivery_rate",
		"message_placement_rate",
		"deterministic_answer_use_rate",
		"session_survival_rate",
		"correct_no_delivery_rate",
	] as const;
	const metrics = subjects.flatMap((subject) =>
		metricIds.map((id): InjectionSubjectMetric => {
			const values = runs
				.filter((run) => run.resolved_commit === subject.resolvedCommit)
				.flatMap((run) => (run.scores[id] == null ? [] : [run.scores[id] as number]));
			return {
				subject: subject.sanitizedSubject,
				id,
				value: mean(values, id, JSON.stringify(subject.sanitizedSubject)),
				unit: "ratio",
			};
		}),
	);
	const provenance = await Promise.all(
		subjects.map(
			async (subject): Promise<InjectionSubjectProvenance> => ({
				subject: subject.sanitizedSubject,
				resolved_commit: subject.resolvedCommit,
				injection_subject_digest: await subject.componentDigest("injection"),
			}),
		),
	);
	return { detailed: { status: "partial", runs }, metrics, provenance };
}
