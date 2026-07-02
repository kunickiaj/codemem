import { describe, expect, it } from "vitest";
import type { DistillCandidate } from "./distill.js";
import {
	buildDistillJudgePrompt,
	judgeDistillCandidate,
	judgeDistillCandidates,
	judgeDistillReport,
	parseJudgeVerdict,
} from "./distill-judge.js";

function candidate(overrides: Partial<DistillCandidate> = {}): DistillCandidate {
	return {
		scope: "project",
		suggested_target: "AGENTS.md",
		score: 0.5,
		recurrence: 4,
		projects: ["codemem"],
		member_ids: [1, 2, 3, 4],
		representative_id: 1,
		concepts: ["release", "preflight"],
		artifact_kind: "context_fact",
		evidence: ["Release preflight must run on main.", "Tags require a clean main branch."],
		draft_text: null,
		...overrides,
	};
}

describe("distill judge", () => {
	it("builds a prompt that defines the worthiness bar and routine-activity exclusions", () => {
		const { system, user } = buildDistillJudgePrompt(candidate());
		expect(system).toContain("durable lesson");
		expect(system).toContain("Routine activity is NOT a lesson");
		expect(system).toContain("release/CI/pipeline status narration");
		expect(system).toContain("review or validation passes that found no issues");
		expect(system).toContain(
			"context/docs lookups and their results, even when phrased as guidance or a fallback rule",
		);
		expect(system).toContain("Default to ROUTINE when uncertain");
		expect(system).toContain("LESSON:");
		expect(system).toContain("ROUTINE:");
		expect(user).toContain("Scope: project");
		expect(user).toContain("Times observed: 4");
		expect(user).toContain("- Release preflight must run on main.");
	});

	it("parses lesson and routine verdicts with reasons", () => {
		expect(parseJudgeVerdict("LESSON: preflight cleanliness is a repeatable constraint")).toEqual({
			verdict: "lesson",
			reason: "preflight cleanliness is a repeatable constraint",
		});
		expect(parseJudgeVerdict("routine: release status narration")).toEqual({
			verdict: "routine",
			reason: "release status narration",
		});
		expect(parseJudgeVerdict("- ROUTINE — context lookup results")).toEqual({
			verdict: "routine",
			reason: "context lookup results",
		});
	});

	it("returns unjudged for empty or unparseable output", () => {
		expect(parseJudgeVerdict(null)).toEqual({ verdict: "unjudged", reason: null });
		expect(parseJudgeVerdict("")).toEqual({ verdict: "unjudged", reason: null });
		expect(parseJudgeVerdict("maybe worth keeping?")).toEqual({
			verdict: "unjudged",
			reason: null,
		});
	});

	it("judges a candidate through the injected drafter", async () => {
		const judged = await judgeDistillCandidate(candidate(), async () => "ROUTINE: status noise");
		expect(judged.verdict).toBe("routine");
		expect(judged.reason).toBe("status noise");
		expect(judged.raw).toBe("ROUTINE: status noise");
	});

	it("annotates all candidates in order and preserves the original fields", async () => {
		const first = candidate({ representative_id: 1 });
		const second = candidate({ representative_id: 2, concepts: ["signing"] });
		const results = await judgeDistillCandidates([first, second], async (_system, user) =>
			user.includes("signing") ? "LESSON: signing constraint" : "ROUTINE: release noise",
		);
		expect(results.map((item) => item.judge.verdict)).toEqual(["routine", "lesson"]);
		expect(results[0]?.representative_id).toBe(1);
		expect(results[1]?.judge.reason).toBe("signing constraint");
		expect(results[1]?.evidence).toEqual(second.evidence);
	});

	it("marks a candidate unjudged when the model returns nothing", async () => {
		const judged = await judgeDistillCandidate(candidate(), async () => null);
		expect(judged.verdict).toBe("unjudged");
		expect(judged.raw).toBeNull();
	});

	it("keeps other verdicts when a single judge call fails", async () => {
		const first = candidate({ representative_id: 1, concepts: ["flaky"] });
		const second = candidate({ representative_id: 2, concepts: ["signing"] });
		const results = await judgeDistillCandidates([first, second], async (_system, user) => {
			if (user.includes("flaky")) throw new Error("transient rate limit");
			return "LESSON: durable constraint";
		});
		expect(results.map((item) => item.judge.verdict)).toEqual(["unjudged", "lesson"]);
	});

	it("rejects when every judge call fails so callers can fall back", async () => {
		await expect(
			judgeDistillCandidates([candidate()], async () => {
				throw new Error("no observer auth configured");
			}),
		).rejects.toThrow("no observer auth configured");
	});

	it("filters routine candidates out of a report and keeps unjudged ones", async () => {
		const report = {
			version: 1 as const,
			candidates: [
				candidate({ representative_id: 1, concepts: ["release-status"] }),
				candidate({ representative_id: 2, concepts: ["signing"] }),
				candidate({ representative_id: 3, concepts: ["unclear"] }),
			],
			metadata: {
				candidate_count: 3,
				cluster_count: 3,
				context_document_count: 0,
				corpus_count: 12,
				corpus_limit: 2000,
				documented_cluster_count: 0,
				include_documented: false,
				min_recurrence: 2,
			},
		};
		const judged = await judgeDistillReport(report, async (_system, user) => {
			if (user.includes("release-status")) return "ROUTINE: status narration";
			if (user.includes("signing")) return "LESSON: durable constraint";
			return "shrug";
		});
		expect(judged.candidates.map((item) => item.representative_id)).toEqual([2, 3]);
		expect(judged.metadata.candidate_count).toBe(2);
		expect(judged.metadata.judged).toBe(true);
		expect(judged.metadata.routine_filtered_count).toBe(1);
	});
});
