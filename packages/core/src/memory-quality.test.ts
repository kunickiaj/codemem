import { describe, expect, it } from "vitest";
import {
	classifyMemoryWorthiness,
	inferMemoryRole,
	isDerivedFactRow,
	readArtifactClass,
} from "./memory-quality.js";

describe("artifact class metadata readers", () => {
	it("reads authoritative derived_fact artifact markers", () => {
		const metadata = { derivation: { artifact_class: "derived_fact" } };
		expect(readArtifactClass(metadata)).toBe("derived_fact");
		expect(isDerivedFactRow({ metadata })).toBe(true);
	});

	it("does not boost candidate-only derivation metadata (C13 guard)", () => {
		const metadata = { derivation: { candidate: true } };
		expect(readArtifactClass(metadata)).toBe("unknown");
		expect(isDerivedFactRow({ metadata })).toBe(false);
	});

	it("treats legacy and null metadata as unknown", () => {
		expect(readArtifactClass({ is_summary: true })).toBe("unknown");
		expect(readArtifactClass(null)).toBe("unknown");
		expect(isDerivedFactRow({})).toBe(false);
	});

	it("parses stringified metadata and tolerates invalid strings", () => {
		expect(readArtifactClass(JSON.stringify({ derivation: { artifact_class: "telemetry" } }))).toBe(
			"telemetry",
		);
		expect(readArtifactClass("not-json")).toBe("unknown");
	});
});

describe("inferMemoryRole", () => {
	it("maps summary-like rows to recap", () => {
		expect(
			inferMemoryRole({
				kind: "change",
				title: "Legacy recap",
				body_text: "summary body",
				metadata: { is_summary: true },
			}),
		).toEqual({ role: "recap", reason: "legacy_summary_metadata" });
	});

	it("treats investigative changes as durable", () => {
		expect(
			inferMemoryRole({
				kind: "change",
				title: "Root cause investigation",
				body_text: "Identified and resolved the vector migration failure.",
				metadata: { session_class: "durable" },
			}),
		).toEqual({ role: "durable", reason: "change_with_investigative_markers" });
	});

	it("treats micro-session change residue as ephemeral", () => {
		expect(
			inferMemoryRole({
				kind: "change",
				title: "Tiny process note",
				body_text: "Need to continue later.",
				metadata: { session_class: "micro_low_value" },
			}),
		).toEqual({ role: "ephemeral", reason: "micro_session_change" });
	});

	it("preserves general role inference when project quality is clearly non-normal", () => {
		expect(
			inferMemoryRole({
				kind: "decision",
				title: "Shared workflow lesson",
				body_text: "Confirmed the safer release tagging flow.",
				project: "opencode",
			}),
		).toEqual({ role: "general", reason: "durable_kind_with_non_normal_project" });
	});
});

describe("classifyMemoryWorthiness", () => {
	it("keeps durable decisions as derived facts", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "decision",
				title: "Use role-based memory quality",
				body_text:
					"Decided to keep memory kinds stable because roles can evolve without a schema rewrite.",
			}),
		).toEqual({ artifact: "derived_fact", action: "store", reasons: ["durable_decision"] });
	});

	it("normalizes kind before classifying durable decisions", () => {
		expect(
			classifyMemoryWorthiness({
				kind: " Decision ",
				title: "Use role-based memory quality",
				body_text:
					"Decided to keep memory kinds stable because roles can evolve without a schema rewrite.",
			}),
		).toEqual({ artifact: "derived_fact", action: "store", reasons: ["durable_decision"] });
	});

	it("keeps implementation contracts tied to files", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "discovery",
				title: "Memory kind surfaces move together",
				body_text:
					"When changing memory kinds, packages/core/src/store.ts and packages/ui/src/tabs/feed.ts must be updated together.",
			}),
		).toEqual({ artifact: "derived_fact", action: "store", reasons: ["implementation_contract"] });
	});

	// Codex M1: ordinary "must <verb>" contracts must be recognized.
	it("keeps ordinary must-verb implementation contracts (M1)", () => {
		const result = classifyMemoryWorthiness({
			kind: "discovery",
			title: "CLI error handling",
			body_text:
				"packages/cli/src/index.ts command handlers must return structured errors instead of throwing.",
		});
		expect(result.artifact).toBe("derived_fact");
		expect(result.action).toBe("store");
		expect(result.reasons).toContain("implementation_contract");
	});

	// Codex M2: validation phrasing with an embedded contract is kept.
	it("keeps a durable contract embedded in validation telemetry (M2)", () => {
		const result = classifyMemoryWorthiness({
			kind: "discovery",
			title: "Deployment rule",
			body_text: "CI is green after confirming deployments require reciprocal approval.",
		});
		expect(result.artifact).toBe("derived_fact");
		expect(result.reasons).toContain("modal_contract");
		expect(result.reasons).not.toContain("validation_telemetry_only");
	});

	// Codex M3: review phrasing with an embedded contract is kept.
	it("keeps a durable lesson embedded in review telemetry (M3)", () => {
		const result = classifyMemoryWorthiness({
			kind: "discovery",
			title: "Release tagging",
			body_text:
				"Review approved after confirming release tags require tagging the merged main commit.",
		});
		expect(result.artifact).toBe("derived_fact");
		expect(result.reasons).not.toContain("review_telemetry_no_findings");
	});

	// Codex M4: workspace-root rule with contract language is kept, not bootstrap noise.
	it("keeps durable workspace-root rules (M4)", () => {
		const result = classifyMemoryWorthiness({
			kind: "discovery",
			title: "Project scope",
			body_text:
				"Workspace root resolution requires the git repo root when deriving project scope.",
		});
		expect(result.artifact).toBe("derived_fact");
		expect(result.reasons).not.toContain("runtime_bootstrap_noise");
	});

	// Codex C5: any modal verb (not a whitelist) with a locator is a contract.
	it("keeps modal contracts with arbitrary verbs (C5)", () => {
		const result = classifyMemoryWorthiness({
			kind: "discovery",
			title: "Migration rule",
			body_text:
				"CI is green after confirming packages/core/src/db.ts migrations must add nullable columns before readers depend on them.",
		});
		expect(result.artifact).toBe("derived_fact");
		expect(result.reasons).toContain("implementation_contract");
		expect(result.reasons).not.toContain("validation_telemetry_only");
	});

	// Codex C6: dependency/outcome lessons are durable.
	it("keeps dependency-lesson outcomes embedded in validation telemetry (C6)", () => {
		const result = classifyMemoryWorthiness({
			kind: "discovery",
			title: "Asset dependency",
			body_text:
				"The test passed only after rebuilding UI assets, confirming viewer-server checks depend on generated static files.",
		});
		expect(result.artifact).toBe("derived_fact");
		expect(result.reasons).not.toContain("validation_telemetry_only");
	});

	// Codex C9: a decision-kind row with telemetry words is still durable.
	it("keeps decision-kind rows even with telemetry wording (C9)", () => {
		const result = classifyMemoryWorthiness({
			kind: "decision",
			title: "Use SQLite by default",
			body_text: "Tests passed. We will use SQLite by default for local stores.",
		});
		expect(result.artifact).toBe("derived_fact");
		expect(result.reasons).toContain("durable_decision");
	});

	// Codex C10: investigation with a confirmed outcome is durable, not demoted.
	it("keeps investigations with a confirmed outcome (C10)", () => {
		const result = classifyMemoryWorthiness({
			kind: "discovery",
			title: "Reranking behavior",
			body_text:
				"Investigated packages/core/src/search.ts and confirmed reranking uses recency decay.",
		});
		expect(result.artifact).toBe("derived_fact");
		expect(result.reasons).not.toContain("investigation_without_durable_conclusion");
	});

	// Codex: "regression tests passed" is validation telemetry, not a gotcha.
	it("does not keep regression-test-pass telemetry as a gotcha", () => {
		const result = classifyMemoryWorthiness({
			kind: "change",
			title: "Regression run",
			body_text: "Regression tests passed and the regression suite is green.",
		});
		expect(result.artifact).toBe("telemetry");
		expect(result.reasons).not.toContain("troubleshooting_gotcha");
	});

	// Codex: findings phrased without "that" should still count as a conclusion.
	it("keeps investigations with a finding phrased without 'that'", () => {
		const result = classifyMemoryWorthiness({
			kind: "change",
			title: "Reranking inspection",
			body_text: "Investigated packages/core/src/search.ts and found the recency-decay weighting.",
		});
		expect(result.reasons).not.toContain("investigation_without_durable_conclusion");
	});

	it("does not treat personal task language as a derived fact", () => {
		const result = classifyMemoryWorthiness({
			kind: "change",
			title: "Pending edit",
			body_text: "I must update store.ts later.",
		});
		expect(result.artifact).not.toBe("derived_fact");
		expect(result.reasons).not.toContain("implementation_contract");
		expect(result.reasons).not.toContain("modal_contract");
	});

	it("keeps troubleshooting gotchas", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "bugfix",
				title: "Viewer asset gotcha",
				body_text: "Viewer server throws if static/index.html is missing; build UI assets first.",
			}),
		).toEqual({ artifact: "derived_fact", action: "store", reasons: ["troubleshooting_gotcha"] });
	});

	it("suppresses review telemetry without findings", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "discovery",
				title: "Review completed",
				body_text: "CodeReviewer re-reviewed the PR and found no blockers or remaining issues.",
			}),
		).toEqual({
			artifact: "telemetry",
			action: "suppress",
			reasons: ["review_telemetry_no_findings"],
		});
	});

	it("suppresses validation telemetry without a durable lesson", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "change",
				title: "Validation passed",
				body_text: "pnpm run lint passed and CI is green.",
			}),
		).toEqual({
			artifact: "telemetry",
			action: "suppress",
			reasons: ["validation_telemetry_only"],
		});
	});

	it("stores summaries even when they mention validation telemetry", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "session_summary",
				title: "Session recap",
				body_text: "Tests passed, CI is green, and context files were loaded.",
			}),
		).toEqual({ artifact: "session_summary", action: "store", reasons: ["session_summary_recap"] });
	});

	it("keeps validation details that encode a durable gotcha", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "discovery",
				title: "Lint coverage gotcha",
				body_text: "Lint only covers files included by biome.json; docs need separate review.",
			}),
		).toEqual({ artifact: "derived_fact", action: "store", reasons: ["troubleshooting_gotcha"] });
	});

	it("suppresses duplicate active policy reminders", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "discovery",
				title: "Delegation reminder",
				body_text: "Use the task delegation workflow before delegating multi-file work.",
			}),
		).toEqual({ artifact: "telemetry", action: "suppress", reasons: ["duplicate_active_policy"] });
	});

	it("suppresses session bootstrap noise", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "discovery",
				title: "Session bootstrap",
				body_text: "Context files were loaded before the run.",
			}),
		).toEqual({ artifact: "telemetry", action: "suppress", reasons: ["runtime_bootstrap_noise"] });
	});

	it("stores a micro-session summary as demoted recap", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "session_summary",
				title: "Tiny recap",
				body_text: "Short note.",
				metadata: { session_class: "micro_low_value" },
			}),
		).toEqual({
			artifact: "session_summary",
			action: "store_demoted",
			reasons: ["session_summary_micro"],
		});
	});

	it("demotes workstream continuity notes", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "discovery",
				title: "Follow-up state",
				body_text: "Next step is to run tests after the edit lands.",
			}),
		).toEqual({ artifact: "unknown", action: "store_demoted", reasons: ["workstream_continuity"] });
	});

	it("keeps durable facts that use current-state wording", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "discovery",
				title: "Coordinator behavior",
				body_text: "The coordinator currently uses reciprocal approvals before peers can sync.",
			}),
		).toEqual({ artifact: "derived_fact", action: "store", reasons: ["role_inferred_durable"] });
	});

	it("demotes investigation notes without a durable conclusion", () => {
		expect(
			classifyMemoryWorthiness({
				kind: "change",
				title: "Scoped inspection",
				body_text:
					"Investigated packages/core/src/search.ts and packages/core/src/pack.ts for later follow-up.",
			}),
		).toEqual({
			artifact: "unknown",
			action: "store_demoted",
			reasons: ["investigation_without_durable_conclusion"],
		});
	});
});
