import { describe, expect, it } from "vitest";
import { DELEGATED_BRIEF_LABEL, MAX_DELEGATED_CONTEXT_CHARS } from "./capture-context.js";
import { buildObserverPrompt } from "./ingest-prompts.js";

const label = `\n\n[${DELEGATED_BRIEF_LABEL}; earlier in this raw stream]\n`;
const bodyBudget = MAX_DELEGATED_CONTEXT_CHARS - label.length;

function appendedBody(brief: string): string {
	const prompt = buildObserverPrompt({
		project: "fixture",
		userPrompt: "Report observed behavior.",
		promptNumber: 1,
		transcript: "",
		toolEvents: [],
		lastAssistantMessage: null,
		includeSummary: true,
		diffSummary: "",
		recentFiles: "",
		delegatedBriefs: [brief],
	});
	return prompt.user.slice(prompt.user.indexOf(label) + label.length);
}

describe("delegated observer-context XML cap", () => {
	it("keeps an XML entity complete when it fits before the boundary", () => {
		// Arrange
		const brief = `${"x".repeat(bodyBudget - 5)}&`;

		// Act
		const body = appendedBody(brief);

		// Assert
		expect(body).toBe(`${"x".repeat(bodyBudget - 5)}&amp;`);
	});

	it("does not split an escaped XML entity at the boundary", () => {
		// Arrange
		const brief = `${"x".repeat(bodyBudget - 1)}&`;

		// Act
		const body = appendedBody(brief);

		// Assert
		expect({
			withinCap: label.length + body.length <= MAX_DELEGATED_CONTEXT_CHARS,
			body,
		}).toEqual({
			withinCap: true,
			body: "x".repeat(bodyBudget - 1),
		});
	});

	it("keeps the newest corrections when an older brief exhausts the cap", () => {
		const prompt = buildObserverPrompt({
			project: "fixture",
			userPrompt: "Report observed behavior.",
			promptNumber: 1,
			transcript: "",
			toolEvents: [],
			lastAssistantMessage: null,
			includeSummary: true,
			diffSummary: "",
			recentFiles: "",
			delegatedBriefs: [
				`STALE_BRIEF ${"x".repeat(MAX_DELEGATED_CONTEXT_CHARS)} STALE_TAIL`,
				"CORRECTION_BRIEF use the bounded queue",
				"NEWEST_BRIEF verify the retry owner",
			],
		});
		const body = prompt.user.slice(prompt.user.indexOf(label) + label.length);

		expect({
			withinCap: label.length + body.length <= MAX_DELEGATED_CONTEXT_CHARS,
			keepsCompleteStaleBrief: body.includes("STALE_TAIL"),
			keepsCorrection: body.includes("CORRECTION_BRIEF"),
			keepsNewest: body.includes("NEWEST_BRIEF"),
			chronological: body.indexOf("CORRECTION_BRIEF") < body.indexOf("NEWEST_BRIEF"),
		}).toEqual({
			withinCap: true,
			keepsCompleteStaleBrief: false,
			keepsCorrection: true,
			keepsNewest: true,
			chronological: true,
		});
	});
});
