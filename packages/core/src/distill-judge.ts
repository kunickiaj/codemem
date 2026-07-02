import type { DistillCandidate, DistillReport } from "./distill.js";
import type { DistillRuleDrafter } from "./distill-draft.js";

/**
 * B-side worthiness gate for distill candidates.
 *
 * The deterministic A-side clusters by recurrence, but recurrence alone cannot
 * distinguish a recurring lesson from recurring routine activity (releases,
 * review passes, context lookups recur by definition). An LLM judge makes that
 * call per candidate — a handful of short calls per run instead of
 * reclassifying the whole corpus.
 */

export type DistillJudgeVerdict = "lesson" | "routine" | "unjudged";

export interface DistillCandidateJudgement {
	verdict: DistillJudgeVerdict;
	/** Short model-provided justification; null when unjudged. */
	reason: string | null;
	/** Raw model output, for debugging/--json. */
	raw: string | null;
}

export interface JudgedDistillCandidate extends DistillCandidate {
	judge: DistillCandidateJudgement;
}

const MAX_EVIDENCE_FOR_PROMPT = 8;
const VERDICT_PATTERN = /^(lesson|routine)\b[\s:—–-]*(.*)$/i;

export interface DistillJudgePrompt {
	system: string;
	user: string;
}

export function buildDistillJudgePrompt(candidate: DistillCandidate): DistillJudgePrompt {
	const system = [
		"You judge whether a cluster of recurring engineering observations carries a durable lesson worth promoting into a context file (a repo AGENTS.md or user-global context).",
		"A durable lesson is a constraint, gotcha, root cause, decision with rationale, or how-something-works insight that changes how future work should be done.",
		"Routine activity is NOT a lesson, no matter how often it recurs:",
		"- release/CI/pipeline status narration",
		"- review or validation passes that found no issues",
		"- context/docs lookups and their results, even when phrased as guidance or a fallback rule",
		"- restating workflow policy that is already established",
		"- bootstrap/setup narration",
		"Judge skeptically: a true statement is not automatically a lesson — it must change how future work is done. Recurrence is evidence of routine, not of value. Default to ROUTINE when uncertain.",
		'Output exactly one line: "LESSON: <short reason>" or "ROUTINE: <short reason>".',
	].join("\n");

	const evidence = candidate.evidence
		.slice(0, MAX_EVIDENCE_FOR_PROMPT)
		.map((item) => `- ${item}`)
		.join("\n");

	const user = [
		`Scope: ${candidate.scope}`,
		`Projects: ${candidate.projects.join(", ") || "(unknown)"}`,
		`Concepts: ${candidate.concepts.join(", ") || "(none)"}`,
		`Times observed: ${candidate.recurrence}`,
		"",
		"Recurring observations:",
		evidence || "(no evidence)",
	].join("\n");

	return { system, user };
}

/** Parse a model response into a verdict; unparseable output stays unjudged. */
export function parseJudgeVerdict(text: string | null | undefined): {
	verdict: DistillJudgeVerdict;
	reason: string | null;
} {
	if (!text) return { verdict: "unjudged", reason: null };
	const firstLine = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return { verdict: "unjudged", reason: null };

	const cleaned = firstLine
		.replace(/^[-*+]\s+/, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
	const match = cleaned.match(VERDICT_PATTERN);
	if (!match) return { verdict: "unjudged", reason: null };

	const verdict = match[1]?.toLowerCase() === "lesson" ? "lesson" : "routine";
	const reason = match[2]?.trim() || null;
	return { verdict, reason };
}

export async function judgeDistillCandidate(
	candidate: DistillCandidate,
	drafter: DistillRuleDrafter,
): Promise<DistillCandidateJudgement> {
	const { system, user } = buildDistillJudgePrompt(candidate);
	const raw = await drafter(system, user);
	const { verdict, reason } = parseJudgeVerdict(raw);
	return { verdict, reason, raw: raw ?? null };
}

export interface DistillJudgeOptions {
	/** Concurrent judge calls; candidates stay in order. */
	concurrency?: number;
}

const DEFAULT_JUDGE_CONCURRENCY = 4;

export async function judgeDistillCandidates(
	candidates: DistillCandidate[],
	drafter: DistillRuleDrafter,
	options: DistillJudgeOptions = {},
): Promise<JudgedDistillCandidate[]> {
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_JUDGE_CONCURRENCY);
	const results: JudgedDistillCandidate[] = new Array(candidates.length);
	let nextIndex = 0;
	let errorCount = 0;
	let firstError: unknown;
	const workers = Array.from(
		{ length: Math.min(concurrency, candidates.length) },
		async (): Promise<void> => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= candidates.length) return;
				const candidate = candidates[index];
				if (!candidate) continue;
				// A single transient failure (rate limit, timeout) must not void
				// the verdicts already collected for other candidates — mark just
				// this one unjudged and keep it (fail open, human review follows).
				let judge: DistillCandidateJudgement;
				try {
					judge = await judgeDistillCandidate(candidate, drafter);
				} catch (error) {
					errorCount += 1;
					firstError ??= error;
					judge = { verdict: "unjudged", reason: null, raw: null };
				}
				results[index] = { ...candidate, judge };
			}
		},
	);
	await Promise.all(workers);
	// Every call failing means the judge itself is unavailable (no observer
	// configured, auth broken) — surface that to the caller's fallback path
	// instead of returning a silently all-unjudged report.
	if (candidates.length > 0 && errorCount === candidates.length) throw firstError;
	return results.filter((item): item is JudgedDistillCandidate => item != null);
}

/**
 * Judge every candidate in a report and drop routine-activity clusters.
 * Unjudged candidates (model unavailable or unparseable output) are kept —
 * the report feeds a human review step, so failing open is the safe default.
 */
export async function judgeDistillReport(
	report: DistillReport,
	drafter: DistillRuleDrafter,
	options: DistillJudgeOptions = {},
): Promise<DistillReport> {
	const judged = await judgeDistillCandidates(report.candidates, drafter, options);
	const kept = judged.filter((item) => item.judge.verdict !== "routine");
	return {
		...report,
		candidates: kept,
		metadata: {
			...report.metadata,
			candidate_count: kept.length,
			judged: true,
			routine_filtered_count: judged.length - kept.length,
		},
	};
}
