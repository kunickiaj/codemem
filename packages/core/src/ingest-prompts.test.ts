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
		expect(system).toContain("When the session contains MULTIPLE meaningful threads:");
		expect(system).toContain(
			"Emit a SMALL capped set of durable <observation> blocks for the highest-value reusable subthreads (usually 2-4, not a dump of everything).",
		);
		expect(system).toContain(
			"For rich multi-thread sessions, prefer one broad summary plus a small set of durable observations covering the highest-value subthreads.",
		);
		expect(system).toContain(
			"Treat the <summary> as the broad session-wide state, not a recap of only the latest thread.",
		);
		expect(system).toContain(
			"Before writing XML, mentally inventory the 2-4 highest-value subthreads",
		);
		expect(system).toContain("Do not let recency dominate");
		expect(system).toContain("Summary-only output is not sufficient for a rich session.");
		expect(system).toContain(
			"Do not collapse a rich batch into only the final or most recent thread",
		);
		expect(system).toContain(
			"For rich sessions, do not return summary-only output when multiple substantial durable subthreads are present.",
		);
	});

	it("guides rich sessions toward broad summary coverage and non-duplicative durable observations", () => {
		const { system } = buildObserverPrompt({
			project: "codemem",
			userPrompt: "Continue the memory injection quality work",
			promptNumber: 24,
			transcript:
				"User: continue track 3\nAssistant: investigated under-extraction\nUser: prep release 0.23.0\nAssistant: reframed the next quality slice",
			toolEvents: [],
			lastAssistantMessage: "Next we should improve rich-session extraction quality.",
			diffSummary: "",
			recentFiles: "",
			includeSummary: true,
		});

		expect(system).toContain("Cover the major subthreads in the summary");
		expect(system).toContain("Prefer one durable observation per distinct subthread");
		expect(system).toContain("Prefer coverage diversity");
		expect(system).toContain("important decisions, durable learnings, shipped changes");
		expect(system).toContain("If one thread clearly dominates and the rest are trivial");
		expect(system).toContain(
			"For rich sessions, make the summary broad enough that a future reader can see the major subthreads",
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

	it("truncates long transcripts while preserving head, middle, and tail context", () => {
		const transcript = `${"A".repeat(120)} middle context ${"Z".repeat(120)}`;
		const truncated = truncateObserverTranscript(transcript, 80);

		expect(truncated.length).toBeLessThanOrEqual(80);
		expect(truncated).toContain("[...]");
		expect(truncated.split("[...]").length).toBeGreaterThanOrEqual(3);
		expect(truncated.startsWith("A")).toBe(true);
		expect(truncated).toContain("middle context");
		expect(truncated.endsWith("Z".repeat(16))).toBe(true);
	});
});
