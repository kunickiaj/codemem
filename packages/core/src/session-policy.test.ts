import { describe, expect, it } from "vitest";
import {
	classifySessionForInjection,
	type SessionClassificationInput,
	type SummarySuppressionInput,
	shouldSuppressSummaryOnlyOutput,
} from "./session-policy.js";

function input(overrides: Partial<SessionClassificationInput> = {}): SessionClassificationInput {
	return {
		sessionContext: {
			promptCount: 1,
			toolCount: 0,
			durationMs: 20_000,
			filesModified: [],
			filesRead: [],
		},
		latestPrompt: "ok",
		toolEventCount: 0,
		hasAssistantMessage: true,
		observationsCount: 0,
		hasSummaryCandidate: true,
		...overrides,
	};
}

function suppressionInput(
	overrides: Partial<SummarySuppressionInput> = {},
): SummarySuppressionInput {
	return {
		...input(),
		skipSummaryReason: null,
		...overrides,
	};
}

describe("session policy classification", () => {
	it("classifies trivial acknowledgement turns", () => {
		const result = classifySessionForInjection(
			input({ hasSummaryCandidate: false, hasAssistantMessage: false }),
		);
		expect(result).toBe("trivial_turn");
	});

	it("classifies low-value micro sessions", () => {
		const result = classifySessionForInjection(input({ latestPrompt: "check logs" }));
		expect(result).toBe("micro_low_value");
	});

	it("classifies high-signal micro sessions when typed observations exist", () => {
		const result = classifySessionForInjection(input({ observationsCount: 1 }));
		expect(result).toBe("micro_high_signal");
	});

	it("classifies working sessions in the middle band", () => {
		const result = classifySessionForInjection(
			input({
				sessionContext: {
					promptCount: 2,
					toolCount: 3,
					durationMs: 240_000,
					filesModified: [],
					filesRead: ["src/foo.ts"],
				},
				latestPrompt: "investigate auth",
				toolEventCount: 3,
				hasAssistantMessage: true,
				observationsCount: 1,
			}),
		);
		expect(result).toBe("working");
	});

	it("classifies durable sessions from strong duration/activity signals", () => {
		const result = classifySessionForInjection(
			input({
				sessionContext: {
					promptCount: 6,
					toolCount: 12,
					durationMs: 900_000,
					filesModified: ["src/index.ts"],
					filesRead: ["src/index.ts"],
				},
				latestPrompt: "fix recap extraction",
				toolEventCount: 12,
				observationsCount: 2,
			}),
		);
		expect(result).toBe("durable");
	});
});

describe("summary-only suppression policy", () => {
	it("suppresses trivial-turn summary-only output", () => {
		expect(
			shouldSuppressSummaryOnlyOutput(
				suppressionInput({ hasSummaryCandidate: true, hasAssistantMessage: false }),
			),
		).toBe(false);
		expect(
			shouldSuppressSummaryOnlyOutput(
				suppressionInput({ hasSummaryCandidate: true, hasAssistantMessage: true }),
			),
		).toBe(true);
	});

	it("suppresses low-value micro-session summary-only output", () => {
		expect(shouldSuppressSummaryOnlyOutput(suppressionInput())).toBe(true);
	});

	it("keeps high-signal micro-session summary candidates when typed observations exist", () => {
		expect(
			shouldSuppressSummaryOnlyOutput(
				suppressionInput({ observationsCount: 1, hasSummaryCandidate: true }),
			),
		).toBe(false);
	});

	it("keeps longer working-session summary candidates", () => {
		expect(
			shouldSuppressSummaryOnlyOutput(
				suppressionInput({
					sessionContext: {
						promptCount: 2,
						toolCount: 3,
						durationMs: 240_000,
						filesModified: [],
						filesRead: ["src/foo.ts"],
					},
					latestPrompt: "investigate auth",
					toolEventCount: 3,
					observationsCount: 0,
				}),
			),
		).toBe(false);
	});

	it("never suppresses when skip_summary reason is already present", () => {
		expect(
			shouldSuppressSummaryOnlyOutput(suppressionInput({ skipSummaryReason: "low-signal" })),
		).toBe(false);
	});
});
