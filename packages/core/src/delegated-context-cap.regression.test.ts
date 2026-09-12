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
});
