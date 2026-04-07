import { describe, expect, it } from "vitest";
import { buildObserverPrompt, truncateObserverTranscript } from "./ingest-prompts.js";

describe("buildObserverPrompt", () => {
	it("includes the Python parity examples and schema guidance", () => {
		const { system } = buildObserverPrompt({
			project: "codemem",
			userPrompt: "Fix observer quality drift",
			promptNumber: 1,
			transcript: "User: Fix observer quality drift",
			toolEvents: [],
			lastAssistantMessage: null,
			diffSummary: "",
			recentFiles: "",
			includeSummary: true,
		});

		expect(system).toContain("GOOD examples (describes what was built or learned)");
		expect(system).toContain("BAD examples (describes observation process - DO NOT DO THIS)");
		expect(system).toContain("IMPORTANT: Use 'exploration' when:");
		expect(system).toContain('Each fact must stand alone - no pronouns like "it" or "this"');
		expect(system).toContain("If the user prompt is a short approval or acknowledgement");
		expect(system).toContain(
			"Otherwise, write a summary that explains the current state of the PRIMARY work (not your observation process).",
		);
	});

	it("includes observed project and prompt context in the user prompt", () => {
		const { user } = buildObserverPrompt({
			project: "codemem",
			userPrompt: "Tighten observer prompt quality",
			promptNumber: 3,
			transcript: "User: Tighten observer prompt quality\n\nAssistant: Done.",
			toolEvents: [],
			lastAssistantMessage: "Done.",
			diffSummary: "",
			recentFiles: "",
			includeSummary: true,
		});

		expect(user).toContain("<project>codemem</project>");
		expect(user).toContain("<prompt_number>3</prompt_number>");
		expect(user).toContain("<conversation_transcript>");
		expect(user).toContain("Assistant: Done.");
		expect(user).toContain("<assistant_response>Done.</assistant_response>");
	});

	it("truncates long transcripts while preserving head and tail context", () => {
		const transcript = `${"A".repeat(120)} middle context ${"Z".repeat(120)}`;
		const truncated = truncateObserverTranscript(transcript, 80);

		expect(truncated.length).toBeLessThanOrEqual(80);
		expect(truncated).toContain("[...]");
		expect(truncated.startsWith("A")).toBe(true);
		expect(truncated.endsWith("Z".repeat(35))).toBe(true);
	});
});
