import { describe, expect, it } from "vitest";
import type { DistillCandidate } from "./distill.js";
import {
	applyDistillRule,
	buildDistillDraftPrompt,
	DISTILL_BLOCK_BEGIN,
	DISTILL_BLOCK_END,
	draftDistillRule,
	renderUnifiedDiff,
	sanitizeRuleLine,
} from "./distill-draft.js";

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

describe("distill draft", () => {
	it("builds a prompt that carries scope, concepts, and evidence", () => {
		const { system, user } = buildDistillDraftPrompt(candidate());
		expect(system).toContain("AGENTS.md");
		expect(system).toContain("SKIP");
		expect(user).toContain("Scope: project");
		expect(user).toContain("release, preflight");
		expect(user).toContain("- Release preflight must run on main.");
	});

	it("sanitizes model output into a single clean rule line", () => {
		expect(sanitizeRuleLine("- Run release preflight on main.")).toBe(
			"Run release preflight on main.",
		);
		expect(sanitizeRuleLine('1. "Keep tags on a clean main branch."')).toBe(
			"Keep tags on a clean main branch.",
		);
		expect(sanitizeRuleLine("First useful line\nsecond line")).toBe("First useful line");
		expect(sanitizeRuleLine("SKIP")).toBeNull();
		expect(sanitizeRuleLine("   ")).toBeNull();
		expect(sanitizeRuleLine(null)).toBeNull();
	});

	it("caps very long rules", () => {
		const rule = sanitizeRuleLine("x".repeat(500));
		expect(rule).not.toBeNull();
		expect((rule ?? "").length).toBeLessThanOrEqual(200);
		expect((rule ?? "").endsWith("…")).toBe(true);
	});

	it("drafts a rule via the injected drafter and honors SKIP", async () => {
		const ok = await draftDistillRule(candidate(), async () => "- Always run preflight on main.");
		expect(ok.rule).toBe("Always run preflight on main.");

		const skipped = await draftDistillRule(candidate(), async () => "SKIP");
		expect(skipped.rule).toBeNull();
		expect(skipped.raw).toBe("SKIP");
	});

	it("creates a managed block in an empty file", () => {
		const result = applyDistillRule("", "Run preflight on main");
		expect(result.changed).toBe(true);
		expect(result.text).toContain("## Distilled lessons");
		expect(result.text).toContain(DISTILL_BLOCK_BEGIN);
		expect(result.text).toContain("- Run preflight on main");
		expect(result.text).toContain(DISTILL_BLOCK_END);
	});

	it("appends a managed block to an existing file without clobbering content", () => {
		const original = "# Project\n\nSome existing guidance.\n";
		const result = applyDistillRule(original, "Run preflight on main");
		expect(result.changed).toBe(true);
		expect(result.text.startsWith(original.replace(/\s+$/, ""))).toBe(true);
		expect(result.text).toContain(DISTILL_BLOCK_BEGIN);
		expect(result.text).toContain("- Run preflight on main");
	});

	it("inserts into an existing managed block and dedupes", () => {
		const first = applyDistillRule("", "Rule one").text;
		const second = applyDistillRule(first, "Rule two");
		expect(second.changed).toBe(true);
		expect(second.text).toContain("- Rule one");
		expect(second.text).toContain("- Rule two");
		// Only one managed block.
		expect(second.text.split(DISTILL_BLOCK_BEGIN).length).toBe(2);

		const dupe = applyDistillRule(second.text, "Rule two");
		expect(dupe.changed).toBe(false);
		expect(dupe.text).toBe(second.text);
	});

	it("renders a unified diff for the proposed change", () => {
		const before = "# Project\n\nSome existing guidance.\n";
		const after = applyDistillRule(before, "Run preflight on main").text;
		const diff = renderUnifiedDiff("AGENTS.md", before, after);
		expect(diff).toContain("--- a/AGENTS.md");
		expect(diff).toContain("+++ b/AGENTS.md");
		expect(diff).toContain("+- Run preflight on main");
		expect(diff).toContain(`+${DISTILL_BLOCK_BEGIN}`);
	});

	it("uses /dev/null as the original for a new file diff", () => {
		const after = applyDistillRule("", "Run preflight on main").text;
		const diff = renderUnifiedDiff("AGENTS.md", "", after);
		expect(diff).toContain("--- /dev/null");
		expect(diff).toContain("+## Distilled lessons");
	});
});
