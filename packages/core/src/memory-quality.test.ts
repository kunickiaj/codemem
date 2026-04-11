import { describe, expect, it } from "vitest";
import { inferMemoryRole } from "./memory-quality.js";

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
