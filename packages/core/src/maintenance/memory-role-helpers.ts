/* Memory-role probe scoring + helper utilities. */

import { getInjectionEvalScenarioByPrompt } from "../eval-scenarios.js";
import { readArtifactClass } from "../memory-quality.js";
import { getSummaryMetadata, isSummaryLikeMemory } from "../summary-memory.js";
import type {
	MemoryArtifactBucket,
	MemoryRole,
	MemoryRoleProbeComparison,
	MemoryRoleProbeItem,
	MemoryRoleProbeResult,
} from "./types.js";

export interface InferredMemoryRole {
	role: MemoryRole;
	reason: string;
}

export function classifyProjectQuality(project: unknown): "normal" | "empty" | "garbage_like" {
	const value = typeof project === "string" ? project.trim() : "";
	if (!value) return "empty";
	if (value === "T" || value === "adam" || value === "opencode" || value.startsWith("fatal:")) {
		return "garbage_like";
	}
	return "normal";
}

export function safeParseMetadata(raw: string | null): Record<string, unknown> {
	return getSummaryMetadata(raw);
}

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(text));
}

const REVIEW_TELEMETRY_PATTERNS: RegExp[] = [
	/\b(?:reviewer|review|re-reviewed|pull request|pr)\b.*\b(?:no blockers?|no findings?|approved|no remaining issues?)\b/,
	/\b(?:no blockers?|no findings?|approved|no remaining issues?)\b.*\b(?:reviewer|review|re-reviewed|pull request|pr)\b/,
];
const VALIDATION_TELEMETRY_PATTERNS: RegExp[] = [
	/\b(?:tests?|lint|ci|build|typecheck|tsc)\b.*\b(?:passed|green|succeeded|clean)\b/,
	/\b(?:passed|green|succeeded|clean)\b.*\b(?:tests?|lint|ci|build|typecheck|tsc)\b/,
];
const BOOTSTRAP_TELEMETRY_PATTERNS: RegExp[] = [
	/\bcontext\s+files?\s+(?:were\s+)?loaded\b/,
	/\bloaded\s+(?:the\s+)?context\b/,
	/\bsession\s+started\b/,
	/\bagent\s+initialized\b/,
	/\bplugin\s+initialized\b/,
	/\bworkspace\s+root\b/,
];

export function isReviewTelemetryText(text: string): boolean {
	return hasAnyPattern(text.toLowerCase(), REVIEW_TELEMETRY_PATTERNS);
}
export function isValidationTelemetryText(text: string): boolean {
	return hasAnyPattern(text.toLowerCase(), VALIDATION_TELEMETRY_PATTERNS);
}
export function isBootstrapTelemetryText(text: string): boolean {
	return hasAnyPattern(text.toLowerCase(), BOOTSTRAP_TELEMETRY_PATTERNS);
}

export function isTelemetryLikeText(text: string): boolean {
	return (
		isReviewTelemetryText(text) || isValidationTelemetryText(text) || isBootstrapTelemetryText(text)
	);
}

export function isDerivedFactLikeText(text: string): boolean {
	const normalized = text.toLowerCase();
	// Exclude personal-task phrasing so "I/we must ..." is not a durable signal,
	// matching classifyMemoryWorthiness in memory-quality.ts.
	const personalTask = hasAnyPattern(normalized, [
		/\b(?:i|we|you)\s+(?:must|should|need\s+to|have\s+to)\b/,
		/\bmust\s+remember\b/,
	]);
	const durable = hasAnyPattern(normalized, [
		/\bderived[-\s]?fact\b/,
		/\bimplementation\s+contract\b/,
		/\brequires?\b/,
		/\bsource\s+of\s+truth\b/,
		/\bcontract\b/,
		/\binvariant\b/,
		/\bwhen\s+changing\b/,
		/\bfails?\s+when\b/,
		/\bthrows?\s+if\b/,
		/\broot\s+cause\b/,
		/\bgotcha\b/,
		/\bdepends?\s+on\b/,
		/\bdependent\s+on\b/,
		/\brelies\s+on\b/,
		/\bonly\s+(?:after|works?\s+when|if)\b/,
	]);
	const modalContract =
		!personalTask &&
		hasAnyPattern(normalized, [
			/\b(?:must|should|shall)\s+(?:not\s+|always\s+|never\s+)?[a-z]{2,}\b/,
		]);
	return durable || modalContract;
}

/** True when the facts column holds a non-empty array (ignores the common `"[]"`). */
function hasNonEmptyFacts(facts: string | null | undefined): boolean {
	if (!facts) return false;
	try {
		const parsed = JSON.parse(facts);
		return Array.isArray(parsed) && parsed.length > 0;
	} catch {
		// Non-JSON facts payload: treat any non-whitespace content as present.
		return facts.trim().length > 0;
	}
}

export function classifyProbeArtifactBucket(input: {
	kind: string;
	title: string;
	body_text?: string | null;
	role: MemoryRole;
	metadata?: Record<string, unknown> | null;
	facts?: string | null;
}): MemoryArtifactBucket {
	const metadata = input.metadata ?? {};
	// Use the shared summary detector so legacy `change` rows carrying
	// `source: "observer_summary"` (or `is_summary`) are bucketed as summaries.
	if (isSummaryLikeMemory({ kind: input.kind, metadata })) return "session_summary";
	if (readArtifactClass(metadata) === "derived_fact") return "derived_fact_like";
	const text = `${input.title} ${input.body_text ?? ""}`.trim();
	// Signal-balance: durable signals (non-empty facts / derived-fact wording) win
	// over telemetry wording, mirroring classifyMemoryWorthiness. A row like
	// "CI is green after confirming deployments require reciprocal approval"
	// buckets as derived_fact_like, not telemetry.
	if (hasNonEmptyFacts(input.facts) || isDerivedFactLikeText(text)) return "derived_fact_like";
	if (isTelemetryLikeText(text)) return "telemetry";
	return "durable_memory";
}

export function subtractKeyedCounts<T extends string>(
	baseline: Partial<Record<T, number>>,
	candidate: Partial<Record<T, number>>,
): Record<T, number> {
	const keys = new Set<T>([...(Object.keys(baseline) as T[]), ...(Object.keys(candidate) as T[])]);
	const result = {} as Record<T, number>;
	for (const key of keys) {
		result[key] = Number(candidate[key] ?? 0) - Number(baseline[key] ?? 0);
	}
	return result;
}

export function subtractBurden(
	baseline: MemoryRoleProbeResult["top_burden"] | null,
	candidate: MemoryRoleProbeResult["top_burden"] | null,
): MemoryRoleProbeResult["top_burden"] | null {
	if (!baseline || !candidate) return null;
	return {
		recap_share: candidate.recap_share - baseline.recap_share,
		unmapped_share: candidate.unmapped_share - baseline.unmapped_share,
		recap_unmapped_share: candidate.recap_unmapped_share - baseline.recap_unmapped_share,
	};
}

export function compareProbeResults(
	baseline: MemoryRoleProbeResult[],
	candidate: MemoryRoleProbeResult[],
): MemoryRoleProbeComparison[] {
	const byQuery = new Map<
		string,
		{ baseline?: MemoryRoleProbeResult; candidate?: MemoryRoleProbeResult }
	>();
	for (const probe of baseline) {
		byQuery.set(probe.query, { ...(byQuery.get(probe.query) ?? {}), baseline: probe });
	}
	for (const probe of candidate) {
		byQuery.set(probe.query, { ...(byQuery.get(probe.query) ?? {}), candidate: probe });
	}
	return [...byQuery.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([query, value]) => {
			const baselineProbe = value.baseline;
			const candidateProbe = value.candidate;
			const baselineIds = baselineProbe?.item_ids ?? [];
			const candidateIds = candidateProbe?.item_ids ?? [];
			const baselineKeys = baselineProbe?.items.map((item) => item.stable_key) ?? [];
			const candidateKeySet = new Set(candidateProbe?.items.map((item) => item.stable_key) ?? []);
			const sharedItemKeys = baselineKeys.filter((key) => candidateKeySet.has(key));
			return {
				query,
				baseline_scenario_id: baselineProbe?.scenario_id,
				candidate_scenario_id: candidateProbe?.scenario_id,
				baseline_scenario_title: baselineProbe?.scenario_title,
				candidate_scenario_title: candidateProbe?.scenario_title,
				baseline_scenario_category: baselineProbe?.scenario_category,
				candidate_scenario_category: candidateProbe?.scenario_category,
				baseline_mode: baselineProbe?.mode ?? null,
				candidate_mode: candidateProbe?.mode ?? null,
				baseline_item_ids: baselineIds,
				candidate_item_ids: candidateIds,
				shared_item_keys: sharedItemKeys,
				baseline_top_burden: baselineProbe?.top_burden ?? null,
				candidate_top_burden: candidateProbe?.top_burden ?? null,
				delta_top_burden: subtractBurden(
					baselineProbe?.top_burden ?? null,
					candidateProbe?.top_burden ?? null,
				),
				baseline_top_mapping_counts: baselineProbe?.top_mapping_counts ?? null,
				candidate_top_mapping_counts: candidateProbe?.top_mapping_counts ?? null,
				delta_top_mapping_counts:
					baselineProbe && candidateProbe
						? subtractKeyedCounts(
								baselineProbe.top_mapping_counts,
								candidateProbe.top_mapping_counts,
							)
						: null,
				baseline_scenario_score: baselineProbe?.scenario_score,
				candidate_scenario_score: candidateProbe?.scenario_score,
				delta_scenario_score:
					baselineProbe?.scenario_score && candidateProbe?.scenario_score
						? {
								mode_match:
									Number(candidateProbe.scenario_score.mode_match) -
									Number(baselineProbe.scenario_score.mode_match),
								primary_in_top1:
									Number(candidateProbe.scenario_score.primary_in_top1) -
									Number(baselineProbe.scenario_score.primary_in_top1),
								primary_in_top3_count:
									candidateProbe.scenario_score.primary_in_top3_count -
									baselineProbe.scenario_score.primary_in_top3_count,
								anti_signal_in_top1:
									Number(candidateProbe.scenario_score.anti_signal_in_top1) -
									Number(baselineProbe.scenario_score.anti_signal_in_top1),
								primary_match_count:
									candidateProbe.scenario_score.primary_match_count -
									baselineProbe.scenario_score.primary_match_count,
								anti_signal_count:
									candidateProbe.scenario_score.anti_signal_count -
									baselineProbe.scenario_score.anti_signal_count,
								recap_count:
									candidateProbe.scenario_score.recap_count -
									baselineProbe.scenario_score.recap_count,
								unmapped_recap_count:
									candidateProbe.scenario_score.unmapped_recap_count -
									baselineProbe.scenario_score.unmapped_recap_count,
								administrative_chatter_count:
									candidateProbe.scenario_score.administrative_chatter_count -
									baselineProbe.scenario_score.administrative_chatter_count,
								score: candidateProbe.scenario_score.score - baselineProbe.scenario_score.score,
							}
						: undefined,
			};
		});
}

export function scoreProbeScenario(
	items: MemoryRoleProbeItem[],
	query: string,
	mode: string,
): MemoryRoleProbeResult["scenario_score"] | undefined {
	const scenario = getInjectionEvalScenarioByPrompt(query);
	if (!scenario) return undefined;
	const topItems = items.slice(0, 5);
	const topThree = items.slice(0, 3);
	const matchToken = (text: string, token: string): boolean => text.includes(token.toLowerCase());
	// Metadata-only haystack for token/role matching.
	const metaHaystack = (item: MemoryRoleProbeItem): string =>
		[
			item.kind,
			item.role,
			item.title,
			item.role_reason,
			item.session_class,
			item.summary_disposition,
		]
			.join(" ")
			.toLowerCase();
	// Source-content haystack (title + body + facts) for telemetry/derived-fact
	// detection, so telemetry wording in body_text is scored, not just titles.
	const sourceHaystack = (item: MemoryRoleProbeItem): string =>
		[item.title, item.body_text ?? "", item.facts ?? ""].join(" ").toLowerCase();
	const itemMatchesPrimary = (item: MemoryRoleProbeItem): boolean => {
		const haystack = metaHaystack(item);
		const derivedFactLike =
			hasNonEmptyFacts(item.facts) || isDerivedFactLikeText(sourceHaystack(item));
		if (
			derivedFactLike &&
			scenario.expectedPrimary.some((token) =>
				["derived fact", "implementation contract"].includes(token.toLowerCase()),
			)
		) {
			return true;
		}
		return scenario.expectedPrimary.some((token) => matchToken(haystack, token));
	};
	const itemMatchesAntiSignal = (item: MemoryRoleProbeItem): boolean => {
		const genericRecap = item.role === "recap" && item.session_class === "micro_low_value";
		const unmappedRecap = item.role === "recap" && item.mapping === "unmapped";
		const wrongThreadSummary = item.role === "recap" && item.summary_disposition === "unknown";
		// Signal balance: a row carrying a durable keep-signal (or structured facts)
		// is NOT telemetry, even if it also contains telemetry wording. Mirrors
		// classifyMemoryWorthiness so the anti-signal metric matches classification.
		const src = sourceHaystack(item);
		const durableException = hasNonEmptyFacts(item.facts) || isDerivedFactLikeText(src);
		const reviewTelemetry = !durableException && isReviewTelemetryText(src);
		const validationTelemetry = !durableException && isValidationTelemetryText(src);
		const bootstrapTelemetry = !durableException && isBootstrapTelemetryText(src);
		const administrativeChatter =
			item.role === "ephemeral" &&
			item.kind !== "decision" &&
			item.kind !== "bugfix" &&
			item.kind !== "discovery";
		const explicitRecapBias = item.role === "recap" && topItems[0]?.id === item.id;
		const summaryFirstSludge = item.role === "recap" && item.kind === "session_summary";
		const missingSummaryIntent =
			scenario.expectedPrimary.includes("session_summary") && item.role !== "recap";
		const topicOnlyRefusal = scenario.expectedPrimary.includes("recap") && item.role !== "recap";
		const totallySummaryFreeOutput =
			scenario.expectedPrimary.includes("session_summary") &&
			!topItems.some((candidate) => candidate.role === "recap");
		if (scenario.expectedAntiSignals.includes("generic recap sludge") && genericRecap) return true;
		if (scenario.expectedAntiSignals.includes("recap takeover") && item.role === "recap")
			return true;
		if (scenario.expectedAntiSignals.includes("unmapped recap") && unmappedRecap) return true;
		if (scenario.expectedAntiSignals.includes("wrong-thread summary") && wrongThreadSummary)
			return true;
		if (scenario.expectedAntiSignals.includes("wrong-thread latest summary") && wrongThreadSummary)
			return true;
		if (scenario.expectedAntiSignals.includes("recap-only output") && item.role === "recap")
			return true;
		if (scenario.expectedAntiSignals.includes("generic summary") && item.role === "recap")
			return true;
		if (scenario.expectedAntiSignals.includes("explicit recap bias") && explicitRecapBias)
			return true;
		if (scenario.expectedAntiSignals.includes("summary-first sludge") && summaryFirstSludge)
			return true;
		if (scenario.expectedAntiSignals.includes("missing summary intent") && missingSummaryIntent)
			return true;
		if (scenario.expectedAntiSignals.includes("topic-only refusal") && topicOnlyRefusal)
			return true;
		if (
			scenario.expectedAntiSignals.includes("totally summary-free output") &&
			totallySummaryFreeOutput
		)
			return true;
		if (scenario.expectedAntiSignals.includes("administrative chatter") && administrativeChatter)
			return true;
		if (scenario.expectedAntiSignals.includes("review telemetry") && reviewTelemetry) return true;
		if (scenario.expectedAntiSignals.includes("validation telemetry") && validationTelemetry)
			return true;
		if (scenario.expectedAntiSignals.includes("bootstrap telemetry") && bootstrapTelemetry)
			return true;
		return false;
	};
	const primaryMatchCount = topItems.filter((item) => {
		return itemMatchesPrimary(item);
	}).length;
	const antiSignalCount = topItems.filter((item) => itemMatchesAntiSignal(item)).length;
	const expectedModes = scenario.expectedModes ?? [];
	const modeMatch = expectedModes.length === 0 || expectedModes.includes(mode);
	const primaryInTop1 =
		topItems.length > 0 ? itemMatchesPrimary(topItems[0] as MemoryRoleProbeItem) : false;
	const primaryInTop3Count = topThree.filter((item) => itemMatchesPrimary(item)).length;
	const antiSignalInTop1 =
		topItems.length > 0 ? itemMatchesAntiSignal(topItems[0] as MemoryRoleProbeItem) : false;
	const recapCount = topItems.filter((item) => item.role === "recap").length;
	const unmappedRecapCount = topItems.filter(
		(item) => item.role === "recap" && item.mapping === "unmapped",
	).length;
	const administrativeChatterCount = topItems.filter(
		(item) =>
			item.role === "ephemeral" &&
			item.kind !== "decision" &&
			item.kind !== "bugfix" &&
			item.kind !== "discovery",
	).length;
	return {
		mode_match: modeMatch,
		primary_in_top1: primaryInTop1,
		primary_in_top3_count: primaryInTop3Count,
		anti_signal_in_top1: antiSignalInTop1,
		primary_match_count: primaryMatchCount,
		anti_signal_count: antiSignalCount,
		recap_count: recapCount,
		unmapped_recap_count: unmappedRecapCount,
		administrative_chatter_count: administrativeChatterCount,
		score:
			primaryMatchCount -
			antiSignalCount +
			(modeMatch ? 1 : 0) +
			(primaryInTop1 ? 1 : 0) -
			(antiSignalInTop1 ? 1 : 0),
	};
}

export function stableProbeItemKey(input: {
	import_key?: string | null;
	kind: string;
	title: string;
	body_text: string;
}): string {
	const importKey = input.import_key?.trim();
	if (importKey) return `import:${importKey}`;
	return `fallback:${input.kind}\u241f${input.title}\u241f${input.body_text}`;
}
