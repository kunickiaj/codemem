import { describe, expect, it } from "vitest";
import { classifyProbeArtifactBucket } from "./memory-role-helpers.js";

describe("classifyProbeArtifactBucket", () => {
	it("buckets session_summary kind as session_summary", () => {
		expect(
			classifyProbeArtifactBucket({
				kind: "session_summary",
				title: "Recap",
				body_text: "what happened",
				role: "recap",
			}),
		).toBe("session_summary");
	});

	// Codex #1297: legacy observer summaries are `change` + metadata.source.
	it("buckets legacy observer_summary change rows as session_summary", () => {
		expect(
			classifyProbeArtifactBucket({
				kind: "change",
				title: "Session recap",
				body_text: "broad progress narration",
				role: "recap",
				metadata: { source: "observer_summary" },
			}),
		).toBe("session_summary");
	});

	// Codex #1297: empty facts "[]" must NOT count as a derived-fact signal.
	it("does not treat an empty facts array as derived_fact_like", () => {
		expect(
			classifyProbeArtifactBucket({
				kind: "discovery",
				title: "Generic note",
				body_text: "nothing durable here",
				role: "ephemeral",
				facts: "[]",
			}),
		).toBe("durable_memory");
	});

	it("treats a non-empty facts array as derived_fact_like", () => {
		expect(
			classifyProbeArtifactBucket({
				kind: "discovery",
				title: "Has facts",
				body_text: "plain body",
				role: "durable",
				facts: JSON.stringify(["a durable extracted fact"]),
			}),
		).toBe("derived_fact_like");
	});

	// Codex #1297: telemetry wording in body_text (not title) must still bucket as telemetry.
	it("buckets telemetry wording from body_text as telemetry", () => {
		expect(
			classifyProbeArtifactBucket({
				kind: "change",
				title: "Validation",
				body_text: "pnpm run tsc passed",
				role: "ephemeral",
			}),
		).toBe("telemetry");
	});

	// Codex #1297: durable signal embedded in telemetry wording wins (signal balance).
	it("buckets a durable contract embedded in telemetry as derived_fact_like", () => {
		expect(
			classifyProbeArtifactBucket({
				kind: "discovery",
				title: "Deployment rule",
				body_text: "CI is green after confirming deployments require reciprocal approval.",
				role: "durable",
			}),
		).toBe("derived_fact_like");
	});
});
