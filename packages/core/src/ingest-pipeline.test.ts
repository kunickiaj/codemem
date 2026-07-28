/**
 * Tests for the ingest pipeline stages.
 *
 * Tests individual stages (not the full pipeline, which requires an LLM mock).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import {
	budgetToolEvents,
	extractToolEvents,
	isInternalMemoryTool,
	normalizeToolName,
} from "./ingest-events.js";
import { isLowSignalObservation, normalizeObservation } from "./ingest-filters.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import { isSensitiveFieldName, stripPrivate } from "./ingest-sanitize.js";
import {
	buildTranscript,
	deriveRequest,
	firstSentence,
	isTrivialRequest,
	normalizeRequestText,
} from "./ingest-transcript.js";
import type { IngestPayload, ParsedSummary, ToolEvent } from "./ingest-types.js";
import {
	hasMeaningfulObservation,
	inspectObserverResponseStructure,
	parseObserverResponse,
	shouldPreferRepairedObserverResponse,
	shouldRepairObserverResponse,
} from "./ingest-xml-parser.js";
import type { ObserverConfig } from "./observer-client.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

// ---------------------------------------------------------------------------
// ingest-events
// ---------------------------------------------------------------------------

describe("ingest-events", () => {
	describe("normalizeToolName", () => {
		it("extracts last segment from dotted names", () => {
			expect(normalizeToolName({ tool: "tool.execute.after" })).toBe("after");
		});

		it("extracts last segment from colon-separated names", () => {
			expect(normalizeToolName({ tool: "mcp:read" })).toBe("read");
		});

		it("lowercases tool names", () => {
			expect(normalizeToolName({ tool: "BASH" })).toBe("bash");
		});

		it("falls back to type if tool is missing", () => {
			expect(normalizeToolName({ type: "tool.execute.after" })).toBe("after");
		});
	});

	describe("isInternalMemoryTool", () => {
		it("detects codemem memory tools", () => {
			expect(isInternalMemoryTool("codemem_memory_search")).toBe(true);
			expect(isInternalMemoryTool("codemem_memory_pack")).toBe(true);
		});

		it("does not flag non-memory tools", () => {
			expect(isInternalMemoryTool("bash")).toBe(false);
			expect(isInternalMemoryTool("read")).toBe(false);
		});
	});

	describe("extractToolEvents", () => {
		it("filters out low-signal tools", () => {
			const events = [
				{ type: "tool.execute.after", tool: "bash", args: {}, result: "ok" },
				{ type: "tool.execute.after", tool: "tui", args: {}, result: "ok" },
				{ type: "tool.execute.after", tool: "edit", args: {}, result: "ok" },
			];
			const result = extractToolEvents(events, 2000);
			const tools = result.map((e) => e.toolName);
			expect(tools).toContain("bash");
			expect(tools).toContain("edit");
			expect(tools).not.toContain("tui");
		});

		it("skips non tool.execute.after events", () => {
			const events = [
				{ type: "user_prompt", prompt_text: "hello" },
				{ type: "tool.execute.after", tool: "bash", args: {}, result: "ok" },
			];
			const result = extractToolEvents(events, 2000);
			expect(result).toHaveLength(1);
			expect(result[0]?.toolName).toBe("bash");
		});

		it("skips codemem memory tools", () => {
			const events = [
				{
					type: "tool.execute.after",
					tool: "codemem_memory_search",
					args: {},
					result: "memories",
				},
			];
			const result = extractToolEvents(events, 2000);
			expect(result).toHaveLength(0);
		});
	});

	describe("budgetToolEvents", () => {
		function makeEvent(name: string, size = 100): ToolEvent {
			return {
				toolName: name,
				toolInput: "x".repeat(size),
				toolOutput: null,
				toolError: null,
				timestamp: null,
				cwd: null,
			};
		}

		it("returns empty array for empty input", () => {
			expect(budgetToolEvents([], 5000, 10)).toEqual([]);
		});

		it("returns empty for zero budget", () => {
			expect(budgetToolEvents([makeEvent("bash")], 0, 10)).toEqual([]);
		});

		it("respects maxEvents limit", () => {
			const events = [makeEvent("a"), makeEvent("b"), makeEvent("c"), makeEvent("d")];
			const result = budgetToolEvents(events, 100_000, 2);
			expect(result.length).toBeLessThanOrEqual(2);
		});

		it("deduplicates identical events", () => {
			const e1 = makeEvent("bash");
			const e2 = { ...e1 }; // same signature
			const result = budgetToolEvents([e1, e2], 100_000, 10);
			expect(result).toHaveLength(1);
		});
	});
});

// ---------------------------------------------------------------------------
// ingest-transcript
// ---------------------------------------------------------------------------

describe("ingest-transcript", () => {
	describe("buildTranscript", () => {
		it("produces chronological text from prompts and messages", () => {
			const events = [
				{ type: "user_prompt", prompt_text: "Fix the bug" },
				{ type: "assistant_message", assistant_text: "I found the issue" },
				{ type: "user_prompt", prompt_text: "Ship it" },
			];
			const transcript = buildTranscript(events);
			expect(transcript).toContain("User: Fix the bug");
			expect(transcript).toContain("Assistant: I found the issue");
			expect(transcript).toContain("User: Ship it");
			// Check order
			const fixIdx = transcript.indexOf("Fix the bug");
			const foundIdx = transcript.indexOf("I found the issue");
			const shipIdx = transcript.indexOf("Ship it");
			expect(fixIdx).toBeLessThan(foundIdx);
			expect(foundIdx).toBeLessThan(shipIdx);
		});

		it("strips private content", () => {
			const events = [
				{ type: "user_prompt", prompt_text: "Hello <private>secret</private> world" },
			];
			const transcript = buildTranscript(events);
			expect(transcript).not.toContain("secret");
			expect(transcript).toContain("Hello");
			expect(transcript).toContain("world");
		});

		it("skips events with empty text", () => {
			const events = [
				{ type: "user_prompt", prompt_text: "" },
				{ type: "assistant_message", assistant_text: "   " },
				{ type: "user_prompt", prompt_text: "Real prompt" },
			];
			const transcript = buildTranscript(events);
			expect(transcript).toBe("User: Real prompt");
		});
	});

	describe("isTrivialRequest", () => {
		it("detects trivial inputs", () => {
			expect(isTrivialRequest("yes")).toBe(true);
			expect(isTrivialRequest("ok")).toBe(true);
			expect(isTrivialRequest("LGTM")).toBe(true);
			expect(isTrivialRequest("  approved  ")).toBe(true);
			expect(isTrivialRequest("")).toBe(true);
			expect(isTrivialRequest(null)).toBe(true);
		});

		it("does not flag real requests", () => {
			expect(isTrivialRequest("Fix the authentication bug")).toBe(false);
			expect(isTrivialRequest("Add a new endpoint for /api/users")).toBe(false);
		});
	});

	describe("normalizeRequestText", () => {
		it("trims, lowercases, and strips quotes", () => {
			expect(normalizeRequestText('  "Hello World"  ')).toBe("hello world");
		});

		it("handles null/empty", () => {
			expect(normalizeRequestText(null)).toBe("");
			expect(normalizeRequestText("")).toBe("");
		});
	});

	describe("firstSentence", () => {
		it("extracts first sentence", () => {
			expect(firstSentence("Fixed the bug. Then deployed.")).toBe("Fixed the bug.");
		});

		it("strips markdown prefixes", () => {
			expect(firstSentence("## Overview\nThis is the content.")).toBe(
				"Overview This is the content.",
			);
		});
	});

	describe("deriveRequest", () => {
		it("derives from completed field first", () => {
			const summary: ParsedSummary = {
				request: "",
				investigated: "Looked at stuff.",
				learned: "Learned things.",
				completed: "Fixed the auth bug. Then cleaned up.",
				nextSteps: "Deploy.",
				notes: "",
				filesRead: [],
				filesModified: [],
			};
			expect(deriveRequest(summary)).toBe("Fixed the auth bug.");
		});

		it("falls through to next non-empty field", () => {
			const summary: ParsedSummary = {
				request: "",
				investigated: "",
				learned: "Learned the system uses JWT. Tokens expire.",
				completed: "",
				nextSteps: "",
				notes: "",
				filesRead: [],
				filesModified: [],
			};
			expect(deriveRequest(summary)).toBe("Learned the system uses JWT.");
		});
	});
});

// ---------------------------------------------------------------------------
// ingest-xml-parser
// ---------------------------------------------------------------------------

describe("ingest-xml-parser", () => {
	describe("parseObserverResponse", () => {
		it("extracts observations and summary", () => {
			const xml = `
<observation>
  <type>bugfix</type>
  <title>Fixed auth timeout</title>
  <narrative>The session handler had a race condition.</narrative>
  <facts><fact>Race in session handler</fact></facts>
  <concepts><concept>problem-solution</concept></concepts>
  <files_read><file>src/auth.ts</file></files_read>
  <files_modified><file>src/auth.ts</file></files_modified>
</observation>

<summary>
  <request>Fix the auth bug</request>
  <investigated>Examined session handler</investigated>
  <learned>Race condition in event loop</learned>
  <completed>Fixed the timeout</completed>
  <next_steps>Add tests</next_steps>
  <notes>Consider retry logic</notes>
  <files_read><file>src/auth.ts</file></files_read>
  <files_modified><file>src/auth.ts</file></files_modified>
</summary>`;

			const result = parseObserverResponse(xml);
			expect(result.observations).toHaveLength(1);
			expect(result.observations[0]?.kind).toBe("bugfix");
			expect(result.observations[0]?.title).toBe("Fixed auth timeout");
			expect(result.observations[0]?.narrative).toContain("race condition");
			expect(result.observations[0]?.facts).toEqual(["Race in session handler"]);
			expect(result.observations[0]?.concepts).toEqual(["problem-solution"]);
			expect(result.observations[0]?.filesRead).toEqual(["src/auth.ts"]);

			expect(result.summary).not.toBeNull();
			expect(result.summary?.request).toBe("Fix the auth bug");
			expect(result.summary?.completed).toBe("Fixed the timeout");
			expect(result.skipSummaryReason).toBeNull();
			expect(inspectObserverResponseStructure(xml, result)).toMatchObject({
				dataLoss: false,
				illegalObservationNestingInSummary: 0,
				unknownSummaryFields: [],
				unsupportedObservationKinds: [],
			});
		});

		it("handles skip_summary", () => {
			const xml = '<skip_summary reason="low-signal"/>';
			const result = parseObserverResponse(xml);
			expect(result.observations).toHaveLength(0);
			expect(result.summary).toBeNull();
			expect(result.skipSummaryReason).toBe("low-signal");
			expect(parseObserverResponse('<skip_summary reason="paired"></skip_summary>')).toMatchObject({
				skipSummaryReason: "paired",
			});
			const unspecified = parseObserverResponse("<skip_summary/>");
			expect(unspecified).toMatchObject({
				skipSummaryReason: null,
			});
			expect(inspectObserverResponseStructure("<skip_summary/>", unspecified).dataLoss).toBe(true);
			expect(shouldRepairObserverResponse("<skip_summary/>", unspecified)).toBe(true);
			const labeledRepair = '<skip_summary reason="low-signal"/>';
			expect(
				shouldPreferRepairedObserverResponse(
					unspecified,
					labeledRepair,
					parseObserverResponse(labeledRepair),
					"<skip_summary/>",
				),
			).toBe(true);
		});

		it("reports contradictory summary decisions as data loss", () => {
			const xml = `<summary><request>Keep this summary</request></summary>
				<skip_summary reason="low-signal"></skip_summary>`;
			const parsed = parseObserverResponse(xml);

			expect(parsed.summary?.request).toBe("Keep this summary");
			expect(parsed.skipSummaryReason).toBe("low-signal");
			expect(inspectObserverResponseStructure(xml, parsed).dataLoss).toBe(true);
			expect(shouldRepairObserverResponse(xml, parsed)).toBe(true);

			const repaired = `<summary><request>Keep this summary</request></summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parsed,
					repaired,
					parseObserverResponse(repaired),
					xml,
				),
			).toBe(true);
		});

		it("allows a validated recovered summary to replace a skip marker", () => {
			const lossy = `<skip_summary reason="low-signal"/>
				<summary><request>Fix auth`;
			const repaired = `<summary><request>Fix auth safely</request></summary>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					repaired,
					parseObserverResponse(repaired),
					lossy,
				),
			).toBe(true);
		});

		it("handles empty/malformed XML gracefully", () => {
			const result = parseObserverResponse("");
			expect(result.observations).toHaveLength(0);
			expect(result.summary).toBeNull();
		});

		it("strips code fences", () => {
			const xml =
				"```xml\n<observation><type>change</type><title>Test</title><narrative>Narrative</narrative></observation>\n```";
			const result = parseObserverResponse(xml);
			expect(result.observations).toHaveLength(1);
			expect(result.observations[0]?.title).toBe("Test");
		});

		it("extracts multiple observations", () => {
			const xml = `
<observation><type>feature</type><title>First</title><narrative>N1</narrative></observation>
<observation><type>bugfix</type><title>Second</title><narrative>N2</narrative></observation>`;
			const result = parseObserverResponse(xml);
			expect(result.observations).toHaveLength(2);
			expect(result.observations[0]?.title).toBe("First");
			expect(result.observations[1]?.title).toBe("Second");
		});

		it("reports invalid observation nesting inside a summary", () => {
			// Arrange
			const xml = `<summary>
			  <request>Summarize the work.</request>
			  <observation><type>decision</type><title>Nested decision</title></observation>
			</summary>`;

			// Act
			const result = inspectObserverResponseStructure(xml);

			// Assert
			expect(result.illegalObservationNestingInSummary).toBe(1);
		});

		it("reports unknown summary fields instead of silently discarding them", () => {
			// Arrange
			const xml = `<summary>
			  <request>Summarize the work.</request>
			  <outcome>The implementation shipped.</outcome>
			</summary>`;

			// Act
			const result = inspectObserverResponseStructure(xml);

			// Assert
			expect(result.unknownSummaryFields).toEqual(["outcome"]);
			expect(result.dataLoss).toBe(true);
		});

		it("reports multiple summaries while retaining the selected summary", () => {
			// Arrange
			const xml = `
			<summary><request>First request</request></summary>
			<summary><request>Second request</request></summary>`;

			// Act
			const parsed = parseObserverResponse(xml);
			const result = inspectObserverResponseStructure(xml, parsed);

			// Assert
			expect(parsed.summary?.request).toBe("Second request");
			expect(result.summaryBlocks).toBe(2);
			expect(result.discardedSummaryBlocks).toBe(1);
			expect(result.dataLoss).toBe(true);
		});

		it("reports unsupported observation kinds", () => {
			// Arrange
			const xml = `<observation>
			  <type>status_update</type>
			  <title>Release status</title>
			  <narrative>The release workflow was green.</narrative>
			</observation>`;

			// Act
			const result = inspectObserverResponseStructure(xml);

			// Assert
			expect(result.unsupportedObservationKinds).toEqual(["status_update"]);
		});

		it("reports a retained observation with no kind as data loss", () => {
			const xml = `<observation>
			  <title>Durable lesson without a type</title>
			  <narrative>This block parses but replay cannot store it without a kind.</narrative>
			</observation>`;

			const result = inspectObserverResponseStructure(xml);

			expect(result.retainedObservations).toBe(1);
			expect(result.missingObservationKinds).toBe(1);
			expect(result.dataLoss).toBe(true);
		});

		it("preserves an observation kind attribute", () => {
			const xml = `<observation kind="decision">
			  <title>Durable decision</title>
			  <narrative>The observer used the supported attribute form.</narrative>
			</observation>`;

			const parsed = parseObserverResponse(xml);
			const diagnostics = inspectObserverResponseStructure(xml, parsed);

			expect(parsed.observations[0]?.kind).toBe("decision");
			expect(diagnostics.missingObservationKinds).toBe(0);
			expect(diagnostics.dataLoss).toBe(false);
		});

		it("reports plain prose as unrecognized lossy output", () => {
			const prose = "I found a durable auth lesson in src/auth.ts.";
			const result = inspectObserverResponseStructure(prose);
			const groundedRepair = `<observation>
				<type>discovery</type>
				<title>durable auth lesson</title>
				<subtitle>durable auth lesson</subtitle>
				<narrative>I found a durable auth lesson in src/auth.ts.</narrative>
				<facts><fact>durable auth lesson</fact></facts>
				<concepts><concept>how-it-works</concept></concepts>
				<files_read><file>src/auth.ts</file></files_read>
			</observation>
			<summary><learned>I found a durable auth lesson in src/auth.ts.</learned></summary>`;
			const embellishedRepair = groundedRepair.replace(
				"durable auth lesson</fact>",
				"Deployed the fix</fact>",
			);
			const negatedProse = "I did not find a durable auth issue.";
			const negationDroppingRepair = `<observation>
				<type>discovery</type><title>find a durable auth issue</title>
				<narrative>I did not find a durable auth issue.</narrative>
			</observation><summary><investigated>I did not find a durable auth issue.</investigated></summary>`;
			const fabricatedSummaryRepair = groundedRepair.replace(
				"</summary>",
				"<completed>Deployed the fix</completed></summary>",
			);
			const duplicateRepair = groundedRepair.replace(
				"</observation>",
				`</observation>
				<observation><type>discovery</type><title>durable auth lesson</title>
				<narrative>I found a durable auth lesson in src/auth.ts.</narrative></observation>`,
			);
			const summaryOnlyRepair = `<summary><learned>I found a durable auth lesson in src/auth.ts.</learned></summary>`;
			const skipRepair = `<skip_summary reason="low-signal"/>`;
			const observationWithoutSummary = groundedRepair.replace(
				"<summary><learned>I found a durable auth lesson in src/auth.ts.</learned></summary>",
				"",
			);
			const unsupportedConceptRepair = groundedRepair.replace("how-it-works", "discovery");
			const partialPathRepair = groundedRepair.replace("<file>src/auth.ts", "<file>auth.ts");
			const contractionProse = "The retry path doesn't recover the batch.";
			const contractionRepair = `<observation><type>discovery</type><title>recover the batch</title>
				<narrative>The retry path doesn't recover the batch.</narrative></observation>
				<summary><learned>The retry path doesn't recover the batch.</learned></summary>`;
			const prefixedProse = "This is a non-blocking issue.";
			const prefixedRepair = `<observation><type>discovery</type><title>blocking issue</title>
				<narrative>This is a non-blocking issue.</narrative></observation>
				<summary><learned>This is a non-blocking issue.</learned></summary>`;
			const entityProse = "Fixed the R&D pipeline.";
			const entityRepair = `<summary><completed>Fixed the R&amp;D pipeline.</completed></summary>`;

			expect(result.recognizedOutput).toBe(false);
			expect(result.dataLoss).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(prose),
					groundedRepair,
					parseObserverResponse(groundedRepair),
					prose,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(entityProse),
					entityRepair,
					parseObserverResponse(entityRepair),
					entityProse,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(prose),
					summaryOnlyRepair,
					parseObserverResponse(summaryOnlyRepair),
					prose,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(prose),
					skipRepair,
					parseObserverResponse(skipRepair),
					prose,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse("Okay."),
					skipRepair,
					parseObserverResponse(skipRepair),
					"Okay.",
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(prose),
					embellishedRepair,
					parseObserverResponse(embellishedRepair),
					prose,
				),
			).toBe(false);
			for (const ungrounded of [
				fabricatedSummaryRepair,
				duplicateRepair,
				observationWithoutSummary,
				unsupportedConceptRepair,
				partialPathRepair,
			]) {
				expect(
					shouldPreferRepairedObserverResponse(
						parseObserverResponse(prose),
						ungrounded,
						parseObserverResponse(ungrounded),
						prose,
					),
				).toBe(false);
			}
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(negatedProse),
					negationDroppingRepair,
					parseObserverResponse(negationDroppingRepair),
					negatedProse,
				),
			).toBe(false);
			for (const [source, repair] of [
				[contractionProse, contractionRepair],
				[prefixedProse, prefixedRepair],
			] as const) {
				expect(
					shouldPreferRepairedObserverResponse(
						parseObserverResponse(source),
						repair,
						parseObserverResponse(repair),
						source,
					),
				).toBe(false);
			}
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(" "),
					summaryOnlyRepair,
					parseObserverResponse(summaryOnlyRepair),
					" ",
				),
			).toBe(false);
		});

		it("rejects repairs that drop prose surrounding malformed XML", () => {
			const initial = `Auth race fixed
				<observation><type>bugfix</type><title>Recovered title`;
			const reducedRepair = `<observation><type>bugfix</type><title>Recovered title</title>
				<narrative>Recovered title</narrative></observation>
				<summary><completed>Recovered title</completed></summary>`;
			const preservingRepair = reducedRepair
				.replace(
					"<narrative>Recovered title</narrative>",
					"<narrative>Auth race fixed. Recovered title</narrative>",
				)
				.replace(
					"<completed>Recovered title</completed>",
					"<completed>Auth race fixed</completed>",
				);

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					reducedRepair,
					parseObserverResponse(reducedRepair),
					initial,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					preservingRepair,
					parseObserverResponse(preservingRepair),
					initial,
				),
			).toBe(true);
		});

		it("rejects ungrounded fields added while repairing a truncated observation", () => {
			const initial = `<observation><type>bugfix</type><title>Recovered title`;
			const inventedRepair = `<observation><type>bugfix</type><title>Recovered title</title>
				<narrative>Invented deployment result</narrative>
				<facts><fact>Invented fact</fact></facts>
				<concepts><concept>gotcha</concept></concepts>
				<files_modified><file>src/invented.ts</file></files_modified></observation>
				<summary><completed>Invented deployment result</completed></summary>`;
			const groundedRepair = `<observation><type>bugfix</type><title>Recovered title</title>
				<narrative>Recovered title</narrative></observation>
				<summary><completed>Recovered title</completed></summary>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					inventedRepair,
					parseObserverResponse(inventedRepair),
					initial,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					groundedRepair,
					parseObserverResponse(groundedRepair),
					initial,
				),
			).toBe(true);

			const prefixedInitial = `<observation><type>discovery</type><title>Findings</title>
				<narrative>This is a non-blocking issue in src/auth.ts</narrative>`;
			const prefixDroppingRepair = `<observation><type>discovery</type><title>Findings</title>
				<subtitle>blocking issue</subtitle>
				<narrative>This is a non-blocking issue in src/auth.ts</narrative></observation>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(prefixedInitial),
					prefixDroppingRepair,
					parseObserverResponse(prefixDroppingRepair),
					prefixedInitial,
				),
			).toBe(false);

			const fabricatedSummaryRepair = groundedRepair.replace(
				"<completed>Recovered title</completed>",
				"<completed>Invented deployment result</completed>",
			);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					fabricatedSummaryRepair,
					parseObserverResponse(fabricatedSummaryRepair),
					initial,
				),
			).toBe(false);
		});

		it("grounds repairs against visible text inside unrecognized XML roots", () => {
			const initial = `<result>Auth race fixed</result>`;
			const groundedRepair = `<summary><completed>Auth race fixed</completed></summary>`;
			const unrelatedRepair = `<summary><completed>Deployed unrelated fix</completed></summary>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					groundedRepair,
					parseObserverResponse(groundedRepair),
					initial,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					unrelatedRepair,
					parseObserverResponse(unrelatedRepair),
					initial,
				),
			).toBe(false);
		});

		it("requests repair for malformed children in retained root blocks", () => {
			const malformed = `<observation><type>discovery</type><title>Durable title
				<narrative>Durable narrative</narrative></observation>`;
			const parsed = parseObserverResponse(malformed);

			expect(parsed.observations).toHaveLength(1);
			expect(parsed.observations[0]?.title).toBe("");
			expect(inspectObserverResponseStructure(malformed, parsed).dataLoss).toBe(true);
			expect(shouldRepairObserverResponse(malformed, parsed)).toBe(true);
		});

		it("requests repair for parser data loss but not retained shape-only nesting", () => {
			const lossy = `<summary><request>Preserve the result</request><notes><observation></notes></summary>`;
			const retained = `<summary><request>Preserve the result</request><notes>
				<observation><type>discovery</type><title>Retained lesson</title></observation>
			</notes></summary>`;
			const repaired = `<observation><type>discovery</type><title>Repaired lesson</title></observation>
				<summary><request>Preserve the result</request></summary>`;
			const thinnerRepair = `<summary><request>Preserve the result</request></summary>`;
			const empty = { observations: [], summary: null, skipSummaryReason: null };

			expect(shouldRepairObserverResponse(lossy, parseObserverResponse(lossy))).toBe(true);
			expect(shouldRepairObserverResponse(retained, parseObserverResponse(retained))).toBe(false);
			expect(shouldRepairObserverResponse(" ", parseObserverResponse(" "))).toBe(true);
			expect(shouldRepairObserverResponse(null, empty)).toBe(false);
			expect(shouldPreferRepairedObserverResponse(parseObserverResponse(lossy), null, empty)).toBe(
				false,
			);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					repaired,
					parseObserverResponse(repaired),
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					lossy,
					parseObserverResponse(lossy),
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(retained),
					thinnerRepair,
					parseObserverResponse(thinnerRepair),
				),
			).toBe(false);
		});

		it("rejects clean repairs that drop retained observations or populated summary fields", () => {
			const retainedObservation = `<observation>
				<type>discovery</type><title>Retained lesson</title>
				<narrative>Keep this exact parsed observation.</narrative>
			</observation>`;
			const replacementObservation = `<observation>
				<type>discovery</type><title>Replacement lesson</title>
				<narrative>This must not replace the retained lesson.</narrative>
			</observation>`;
			const initial = `${retainedObservation}
				<summary><request>Preserve the result</request><learned>Durable detail</learned></summary>`;
			const disjointRepair = `${replacementObservation}
				<summary><request>Preserve the result</request><learned>Different detail</learned></summary>`;
			const incompleteSummaryRepair = `${retainedObservation}
				<summary><request>Preserve the result</request></summary>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					disjointRepair,
					parseObserverResponse(disjointRepair),
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					incompleteSummaryRepair,
					parseObserverResponse(incompleteSummaryRepair),
				),
			).toBe(false);
		});

		it("matches retained observation lists as order-insensitive multisets", () => {
			const retained = `<observation><type>discovery</type><title>Retained lesson</title>
				<facts><fact>First fact</fact><fact>Second fact</fact></facts>
				<concepts><concept>gotcha</concept><concept>pattern</concept></concepts>
				<files_read><file>src/a.ts</file><file>src/b.ts</file></files_read>
			</observation>`;
			const initial = `${retained}<observation><type>decision</type><title>Recovered decision`;
			const reordered = retained
				.replace(
					"<fact>First fact</fact><fact>Second fact</fact>",
					"<fact>Second fact</fact><fact>First fact</fact>",
				)
				.replace(
					"<concept>gotcha</concept><concept>pattern</concept>",
					"<concept>pattern</concept><concept>gotcha</concept>",
				)
				.replace(
					"<file>src/a.ts</file><file>src/b.ts</file>",
					"<file>src/b.ts</file><file>src/a.ts</file>",
				);
			const repair = `${reordered}<observation><type>decision</type><title>Recovered decision</title></observation>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					repair,
					parseObserverResponse(repair),
					initial,
				),
			).toBe(true);
		});

		it("rejects clean repairs that rewrite populated summary content", () => {
			const observation = `<observation>
				<type>discovery</type><title>Retained lesson</title>
				<narrative>Keep this exact parsed observation.</narrative>
			</observation>`;
			const initial = `${observation}<summary>
				<request>Preserve the result</request>
				<files_read><file>src/retained.ts</file></files_read>
			</summary>`;
			const rewrittenScalar = initial.replace("Preserve the result", "Replace the result");
			const rewrittenList = initial.replace("src/retained.ts", "src/replacement.ts");
			const introducedSkip = `${initial}<skip_summary reason="low-signal"/>`;
			const duplicateInitial = initial.replace(
				"<file>src/retained.ts</file>",
				"<file>src/retained.ts</file><file>src/retained.ts</file>",
			);

			for (const repair of [rewrittenScalar, rewrittenList, introducedSkip]) {
				expect(
					shouldPreferRepairedObserverResponse(
						parseObserverResponse(initial),
						repair,
						parseObserverResponse(repair),
					),
				).toBe(false);
			}
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(duplicateInitial),
					initial,
					parseObserverResponse(initial),
				),
			).toBe(false);
		});

		it("accepts repairs that only correct an invalid observation kind", () => {
			const unsupported = `<observation>
				<type>unsupported</type><title>Durable lesson</title>
				<narrative>Preserve every field while correcting the kind.</narrative>
			</observation>`;
			const missing = `<observation>
				<title>Durable lesson</title>
				<narrative>Preserve every field while correcting the kind.</narrative>
			</observation>`;
			const repaired = `<observation>
				<type>discovery</type><title>Durable lesson</title>
				<narrative>Preserve every field while correcting the kind.</narrative>
			</observation>`;
			const alreadyValid = unsupported.replace("unsupported", "decision");
			const repairedParsed = parseObserverResponse(repaired);

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unsupported),
					repaired,
					repairedParsed,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(missing),
					repaired,
					repairedParsed,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(alreadyValid),
					repaired,
					repairedParsed,
				),
			).toBe(false);
		});

		it("rejects repairs that preserve parsed items but omit discarded observation blocks", () => {
			const retained = `<observation>
				<type>discovery</type><title>Retained lesson</title>
				<narrative>Keep this observation.</narrative>
			</observation>`;
			const lossy = `${retained}<observation>
				<type>bugfix</type><title>Discarded fix</title>
				<narrative>Recover this truncated observation.`;
			const unrelatedRepair = `${retained}<observation>
				<type>bugfix</type><title>Unrelated clean item</title>
				<narrative>This does not recover the discarded fix.</narrative>
			</observation>`;
			const faithfulRepair = `${retained}<observation>
				<type>bugfix</type><title>Discarded fix</title>
				<narrative>Recover this truncated observation.</narrative>
			</observation>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					retained,
					parseObserverResponse(retained),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					unrelatedRepair,
					parseObserverResponse(unrelatedRepair),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					faithfulRepair,
					parseObserverResponse(faithfulRepair),
					lossy,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					`${retained}${retained}`,
					parseObserverResponse(`${retained}${retained}`),
					lossy,
				),
			).toBe(false);

			const twoDiscarded = `${lossy}<observation>
				<type>decision</type><title>Second discarded item`;
			const recoveredOnce = `<observation>
				<type>bugfix</type><title>Recovered fix</title>
				<narrative>Only one discarded block was actually recovered.</narrative>
			</observation>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(twoDiscarded),
					`${retained}${recoveredOnce}${recoveredOnce}`,
					parseObserverResponse(`${retained}${recoveredOnce}${recoveredOnce}`),
					twoDiscarded,
				),
			).toBe(false);
		});

		it("allows recovered structured output to replace a contradictory skip marker", () => {
			const lossy = `<skip_summary reason="low-signal"/><observation>
				<type>discovery</type><title>Recovered lesson`;
			const repaired = `<observation>
				<type>discovery</type><title>Recovered lesson</title>
				<narrative>Recovered lesson</narrative>
			</observation>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					repaired,
					parseObserverResponse(repaired),
					lossy,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					`${repaired}<skip_summary reason="rewritten"/>`,
					parseObserverResponse(`${repaired}<skip_summary reason="rewritten"/>`),
					lossy,
				),
			).toBe(false);

			const summaryRepair = `<summary><request>Recovered summary only</request></summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(`<skip_summary reason="low-signal"/><summary><request>Broken`),
					summaryRepair,
					parseObserverResponse(summaryRepair),
					`<skip_summary reason="low-signal"/><summary><request>Broken`,
				),
			).toBe(false);
		});

		it("requires repairs to preserve recoverable fields from a discarded summary", () => {
			const retained = `<observation>
				<type>discovery</type><title>Retained lesson</title>
				<narrative>Keep this observation.</narrative>
			</observation>`;
			const lossy = `${retained}<summary>
				<request>Preserve the original request</request>
				<files_read><file>src/original.ts</file></files_read>`;
			const unrelatedRepair = `${retained}<summary>
				<request>Different request</request>
				<files_read><file>src/unrelated.ts</file></files_read>
			</summary>`;
			const faithfulRepair = `${retained}<summary>
				<request>Preserve the original request</request>
				<files_read><file>src/original.ts</file></files_read>
			</summary>`;
			const extendedCompleteFieldRepair = faithfulRepair.replace(
				"Preserve the original request",
				"Preserve the original request and more",
			);

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					unrelatedRepair,
					parseObserverResponse(unrelatedRepair),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					extendedCompleteFieldRepair,
					parseObserverResponse(extendedCompleteFieldRepair),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					faithfulRepair,
					parseObserverResponse(faithfulRepair),
					lossy,
				),
			).toBe(true);

			const unknownLossy = `${retained}<summary><outcome>Auth race fixed`;
			const unknownFaithfulRepair = `${retained}<summary>
				<completed>Auth race fixed</completed>
			</summary>`;
			const unknownUnrelatedRepair = `${retained}<summary>
				<completed>Different result</completed>
			</summary>`;
			const unknownFabricatedRepair = unknownFaithfulRepair.replace(
				"</summary>",
				"<learned>Invented lesson</learned><files_read><file>src/invented.ts</file></files_read></summary>",
			);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unknownLossy),
					unknownUnrelatedRepair,
					parseObserverResponse(unknownUnrelatedRepair),
					unknownLossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unknownLossy),
					unknownFaithfulRepair,
					parseObserverResponse(unknownFaithfulRepair),
					unknownLossy,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unknownLossy),
					unknownFabricatedRepair,
					parseObserverResponse(unknownFabricatedRepair),
					unknownLossy,
				),
			).toBe(false);
			const adjacentUnknowns = `${retained}<summary>
				<outcome>Auth race fixed<verdict>Ship it`;
			const adjacentFaithfulRepair = `${retained}<summary>
				<completed>Auth race fixed Ship it</completed>
			</summary>`;
			const adjacentDroppedRepair = `${retained}<summary>
				<completed>Auth race fixed safely</completed>
			</summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(adjacentUnknowns),
					adjacentDroppedRepair,
					parseObserverResponse(adjacentDroppedRepair),
					adjacentUnknowns,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(adjacentUnknowns),
					adjacentFaithfulRepair,
					parseObserverResponse(adjacentFaithfulRepair),
					adjacentUnknowns,
				),
			).toBe(true);

			const truncatedListItem = `${retained}<summary>
				<request>Preserve the original request</request>
				<files_read><file>src/orig`;
			const unrelatedListRepair = `${retained}<summary>
				<request>Preserve the original request</request>
				<files_read><file>src/unrelated.ts</file></files_read>
			</summary>`;
			const faithfulListRepair = `${retained}<summary>
				<request>Preserve the original request</request>
				<files_read><file>src/original.ts</file></files_read>
			</summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(truncatedListItem),
					unrelatedListRepair,
					parseObserverResponse(unrelatedListRepair),
					truncatedListItem,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(truncatedListItem),
					faithfulListRepair,
					parseObserverResponse(faithfulListRepair),
					truncatedListItem,
				),
			).toBe(true);

			const overlappingListItems = `${retained}<summary>
				<request>Preserve the original request</request>
				<files_read><file>src/<file>src/a.ts</file>`;
			const overlappingListRepair = `${retained}<summary>
				<request>Preserve the original request</request>
				<files_read><file>src/a.ts</file><file>src/b.ts</file></files_read>
			</summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(overlappingListItems),
					overlappingListRepair,
					parseObserverResponse(overlappingListRepair),
					overlappingListItems,
				),
			).toBe(true);

			const duplicateListItems = `${retained}<summary>
				<request>Preserve the original request</request>
				<files_read><file>src/a.ts</file><file>src/a.ts</file>`;
			const missingDuplicateRepair = overlappingListRepair.replace("<file>src/b.ts</file>", "");
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(duplicateListItems),
					missingDuplicateRepair,
					parseObserverResponse(missingDuplicateRepair),
					duplicateListItems,
				),
			).toBe(false);
		});

		it("requires unknown summary values to map into a supported repaired field", () => {
			const initial = `<summary>
				<request>Fix auth</request>
				<outcome>Auth race fixed</outcome>
			</summary>`;
			const dropped = `<summary><request>Fix auth</request></summary>`;
			const mapped = `<summary>
				<request>Fix auth</request>
				<completed>Auth race fixed</completed>
			</summary>`;
			const embellishedMapping = mapped.replace(
				"Auth race fixed",
				"Auth race fixed with unrelated invented detail",
			);
			const reusedMapping = mapped.replace(
				"</summary>",
				"<learned>Auth race fixed</learned></summary>",
			);
			const unclosedUnknown = `<summary>
				<request>Fix auth</request>
				<outcome>Auth race fixed<detail>context</detail>
			</summary>`;
			const nestedValueMapping = mapped.replace("Auth race fixed", "Auth race fixed context");
			const embellishedNestedValue = nestedValueMapping.replace(
				"Auth race fixed context",
				"Auth race fixed context with unrelated invented detail",
			);
			const fabricatedObservation = `${mapped}<observation>
				<type>bugfix</type><title>Invented repair result</title>
				<narrative>This observation has no source block.</narrative>
			</observation>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					dropped,
					parseObserverResponse(dropped),
					initial,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					mapped,
					parseObserverResponse(mapped),
					initial,
				),
			).toBe(true);
			for (const ungrounded of [embellishedMapping, reusedMapping]) {
				expect(
					shouldPreferRepairedObserverResponse(
						parseObserverResponse(initial),
						ungrounded,
						parseObserverResponse(ungrounded),
						initial,
					),
				).toBe(false);
			}
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unclosedUnknown),
					nestedValueMapping,
					parseObserverResponse(nestedValueMapping),
					unclosedUnknown,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unclosedUnknown),
					embellishedNestedValue,
					parseObserverResponse(embellishedNestedValue),
					unclosedUnknown,
				),
			).toBe(false);

			const nestedOccurrence = `<summary>
				<request>Fix auth</request>
				<notes>See <outcome>nested context</outcome></notes>
				<outcome>Direct result</outcome>
			</summary>`;
			const directOccurrenceMapping = `<summary>
				<request>Fix auth</request>
				<notes>See <outcome>nested context</outcome></notes>
				<completed>Direct result</completed>
			</summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(nestedOccurrence),
					directOccurrenceMapping,
					parseObserverResponse(directOccurrenceMapping),
					nestedOccurrence,
				),
			).toBe(true);

			const quotedAttribute = `<summary>
				<request>Fix auth</request>
				<note kind="a > b">Unknown note</note>
				<outcome>Direct result</outcome>
			</summary>`;
			const quotedAttributeMapping = `<summary>
				<request>Fix auth</request>
				<notes>Unknown note</notes>
				<completed>Direct result</completed>
			</summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(quotedAttribute),
					quotedAttributeMapping,
					parseObserverResponse(quotedAttributeMapping),
					quotedAttribute,
				),
			).toBe(true);
			const unbalancedAttribute = quotedAttribute.replace('kind="a > b"', 'kind="broken');
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unbalancedAttribute),
					quotedAttributeMapping,
					parseObserverResponse(quotedAttributeMapping),
					unbalancedAttribute,
				),
			).toBe(true);

			const unclosedBeforeKnown = `<summary>
				<request>Fix auth</request>
				<outcome>Auth race fixed<completed>Shipped safely</completed>
			</summary>`;
			const unclosedBeforeKnownMapping = `<summary>
				<request>Fix auth</request>
				<notes>Auth race fixed</notes>
				<completed>Shipped safely</completed>
			</summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unclosedBeforeKnown),
					unclosedBeforeKnownMapping,
					parseObserverResponse(unclosedBeforeKnownMapping),
					unclosedBeforeKnown,
				),
			).toBe(true);
			const unknownAfterKnown = unclosedBeforeKnown.replace(
				"</summary>",
				"<verdict>Ship it</verdict></summary>",
			);
			const droppedUnknownAfterKnown = unclosedBeforeKnownMapping;
			const preservedUnknownAfterKnown = unclosedBeforeKnownMapping.replace(
				"</summary>",
				"<learned>Ship it</learned></summary>",
			);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unknownAfterKnown),
					droppedUnknownAfterKnown,
					parseObserverResponse(droppedUnknownAfterKnown),
					unknownAfterKnown,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unknownAfterKnown),
					preservedUnknownAfterKnown,
					parseObserverResponse(preservedUnknownAfterKnown),
					unknownAfterKnown,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					fabricatedObservation,
					parseObserverResponse(fabricatedObservation),
					initial,
				),
			).toBe(false);

			const nestedInitial = `<summary>
				<request>Index files</request>
				<files><file>src/a.ts</file></files>
			</summary>`;
			const nestedMapped = `<summary>
				<request>Index files</request>
				<files_read><file>src/a.ts</file></files_read>
			</summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(nestedInitial),
					nestedMapped,
					parseObserverResponse(nestedMapped),
					nestedInitial,
				),
			).toBe(true);
		});

		it("grounds restored retained-summary fields in the malformed raw prefix", () => {
			const lossy = `<summary>
				<request>Fix auth</request>
				<learned>Critical auth race
			</summary>
			<observation><type>bugfix</type><title>Recover this fix`;
			const faithfulRepair = `<summary>
				<request>Fix auth</request>
				<learned>Critical auth race in token refresh</learned>
			</summary>
			<observation><type>bugfix</type><title>Recover this fix safely</title></observation>`;
			const unrelatedRepair = faithfulRepair.replace(
				"Critical auth race in token refresh",
				"Unrelated cache observation",
			);
			const injectedListRepair = faithfulRepair.replace(
				"</summary>",
				"<files_modified><file>src/fabricated.ts</file></files_modified></summary>",
			);

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					unrelatedRepair,
					parseObserverResponse(unrelatedRepair),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					injectedListRepair,
					parseObserverResponse(injectedListRepair),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					faithfulRepair,
					parseObserverResponse(faithfulRepair),
					lossy,
				),
			).toBe(true);
		});

		it("allows multiple summaries to merge while preserving every value", () => {
			const initial = `<summary><request>First request</request></summary>
				<summary><request>Second request</request></summary>`;
			const merged = `<summary>
				<request>First request; Second request</request>
			</summary>`;
			const embellishedMerge = merged.replace(
				"Second request",
				"Second request with invented detail",
			);
			const fabricatedScalar = merged.replace(
				"</summary>",
				"<learned>Invented lesson</learned></summary>",
			);
			const fabricatedList = merged.replace(
				"</summary>",
				"<files_read><file>src/invented.ts</file></files_read></summary>",
			);

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					merged,
					parseObserverResponse(merged),
					initial,
				),
			).toBe(true);
			for (const ungrounded of [embellishedMerge, fabricatedScalar, fabricatedList]) {
				expect(
					shouldPreferRepairedObserverResponse(
						parseObserverResponse(initial),
						ungrounded,
						parseObserverResponse(ungrounded),
						initial,
					),
				).toBe(false);
			}

			const truncatedSecond = `<summary><request>First request</request></summary>
				<summary><request>Second request`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(truncatedSecond),
					merged,
					parseObserverResponse(merged),
					truncatedSecond,
				),
			).toBe(true);
			for (const ungrounded of [fabricatedScalar, fabricatedList]) {
				expect(
					shouldPreferRepairedObserverResponse(
						parseObserverResponse(truncatedSecond),
						ungrounded,
						parseObserverResponse(ungrounded),
						truncatedSecond,
					),
				).toBe(false);
			}
			const truncatedUnknownMerge = `<summary><outcome>Result A</outcome></summary>
				<summary><outcome>Result B`;
			const groundedTruncatedUnknown = `<summary>
				<completed>Result A and Result B</completed>
			</summary>`;
			const embellishedTruncatedUnknown = groundedTruncatedUnknown.replace(
				"Result B",
				"Result B with invented detail",
			);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(truncatedUnknownMerge),
					groundedTruncatedUnknown,
					parseObserverResponse(groundedTruncatedUnknown),
					truncatedUnknownMerge,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(truncatedUnknownMerge),
					embellishedTruncatedUnknown,
					parseObserverResponse(embellishedTruncatedUnknown),
					truncatedUnknownMerge,
				),
			).toBe(false);

			const unknownOnly = `<summary><outcome>Result A</outcome></summary>
				<summary><outcome>Result B</outcome></summary>`;
			const groundedUnknownMerge = `<summary><completed>Result A and Result B</completed></summary>`;
			const reusedUnknownMerge = `<summary>
				<learned>Result A</learned><completed>Result A and Result B</completed>
			</summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unknownOnly),
					groundedUnknownMerge,
					parseObserverResponse(groundedUnknownMerge),
					unknownOnly,
				),
			).toBe(true);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(unknownOnly),
					reusedUnknownMerge,
					parseObserverResponse(reusedUnknownMerge),
					unknownOnly,
				),
			).toBe(false);

			const overlappingUnknowns = `<summary><outcome>Result A</outcome>
				<summary><outcome>Result B</outcome></summary>`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(overlappingUnknowns),
					reusedUnknownMerge,
					parseObserverResponse(reusedUnknownMerge),
					overlappingUnknowns,
				),
			).toBe(false);

			const nonFinalTruncatedRequest = `<summary><request>Fix auth
				<summary><request>Deploy the service</request></summary>`;
			const exactBoundaryMerge = `<summary>
				<request>Deploy the service; Fix auth</request>
			</summary>`;
			const embellishedBoundaryMerge = exactBoundaryMerge.replace(
				"Fix auth",
				"Fix auth in the token refresh path",
			);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(nonFinalTruncatedRequest),
					embellishedBoundaryMerge,
					parseObserverResponse(embellishedBoundaryMerge),
					nonFinalTruncatedRequest,
				),
			).toBe(false);
		});

		it("requires distinct merged summary scalars to be consumed independently", () => {
			const initial = `<summary><request>auth</request></summary>
				<summary><request>oauth</request></summary>`;
			const reducedRepair = `<summary><request>oauth</request></summary>`;
			const completeRepair = `<summary><request>auth and oauth</request></summary>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					reducedRepair,
					parseObserverResponse(reducedRepair),
					initial,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					completeRepair,
					parseObserverResponse(completeRepair),
					initial,
				),
			).toBe(true);
		});

		it("validates discarded fragments even when the initial parse retained nothing", () => {
			const lossy = `<observation>
				<type>bugfix</type><title>Recover this bugfix</title>
				<narrative>Truncated`;
			const unrelatedRepair = `<summary><request>Unrelated summary</request></summary>`;
			const faithfulRepair = `<observation>
				<type>bugfix</type><title>Recover this bugfix</title>
				<narrative>Truncated content recovered durably.</narrative>
			</observation>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					unrelatedRepair,
					parseObserverResponse(unrelatedRepair),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					faithfulRepair,
					parseObserverResponse(faithfulRepair),
					lossy,
				),
			).toBe(true);
		});

		it("allows repairs to restore recoverable fields in retained malformed observations", () => {
			const malformedRetained = `<observation>
				<type>discovery</type>
				<title>Recovered title prefix
				<narrative>Keep this parsed narrative.</narrative>
			</observation>`;
			const lossy = `${malformedRetained}<observation>
				<type>bugfix</type><title>Recover the second item`;
			const faithfulRepair = `<observation>
				<type>discovery</type>
				<title>Recovered title prefix with detail</title>
				<narrative>Keep this parsed narrative.</narrative>
			</observation>
			<observation>
				<type>bugfix</type><title>Recover the second item safely</title>
			</observation>`;
			const unrelatedRepair = faithfulRepair.replace(
				"Recovered title prefix with detail",
				"Unrelated replacement title",
			);
			const injectedRepair = faithfulRepair.replace(
				"</observation>",
				"<files_modified><file>src/unrelated.ts</file></files_modified></observation>",
			);
			const injectedScalarRepair = faithfulRepair.replace(
				"</observation>",
				"<subtitle>Unrelated injected subtitle</subtitle></observation>",
			);

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					unrelatedRepair,
					parseObserverResponse(unrelatedRepair),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					injectedScalarRepair,
					parseObserverResponse(injectedScalarRepair),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					injectedRepair,
					parseObserverResponse(injectedRepair),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					faithfulRepair,
					parseObserverResponse(faithfulRepair),
					lossy,
				),
			).toBe(true);
		});

		it("preserves visible prefixes from scalar tags truncated mid-value", () => {
			const lossy = `<observation>
				<type>bugfix</type><title>Critical auth race`;
			const unrelatedRepair = `<observation>
				<type>bugfix</type><title>Unrelated cache bug</title>
			</observation>`;
			const faithfulRepair = `<observation>
				<type>bugfix</type><title>Critical auth race in token refresh</title>
			</observation>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					unrelatedRepair,
					parseObserverResponse(unrelatedRepair),
					lossy,
				),
			).toBe(false);
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					faithfulRepair,
					parseObserverResponse(faithfulRepair),
					lossy,
				),
			).toBe(true);
		});

		it("allows whitespace-only reflow in retained fields during repair", () => {
			const lossy = `<summary>
				<learned>Line one
					Line two</learned>
				<files_read><file>src/a.ts</file></files_read>
			</summary>
			<observation><type>bugfix</type><title>Recover this fix`;
			const repaired = `<summary>
				<learned>Line one Line two</learned>
				<files_read><file>src/a.ts</file></files_read>
			</summary>
			<observation><type>bugfix</type><title>Recover this fix safely</title></observation>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					repaired,
					parseObserverResponse(repaired),
					lossy,
				),
			).toBe(true);
		});

		it("rejects repaired output containing both a summary and skip marker", () => {
			const lossy = `<observation>
				<type>bugfix</type><title>Recover this bugfix`;
			const contradictoryRepair = `<observation>
				<type>bugfix</type><title>Recover this bugfix</title>
			</observation>
			<summary><request>Recovered summary</request></summary>
			<skip_summary reason="low-signal"/>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					contradictoryRepair,
					parseObserverResponse(contradictoryRepair),
					lossy,
				),
			).toBe(false);
		});

		it("allows unsupported kinds in discarded fragments to be corrected", () => {
			const retained = `<observation>
				<type>discovery</type><title>Retained lesson</title>
			</observation>`;
			const lossy = `${retained}<observation>
				<type>memo</type><title>Recover this item</title>`;
			const correctedRepair = `${retained}<observation>
				<type>decision</type><title>Recover this item</title>
			</observation>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(lossy),
					correctedRepair,
					parseObserverResponse(correctedRepair),
					lossy,
				),
			).toBe(true);

			const supportedLossy = lossy.replace("memo", "bugfix");
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(supportedLossy),
					correctedRepair,
					parseObserverResponse(correctedRepair),
					supportedLossy,
				),
			).toBe(false);
		});

		it("matches incomplete kinds by supported prefix or corrects unknown kinds", () => {
			const decisionRepair = `<observation>
				<type>decision</type><title>Recover this item</title>
			</observation>`;
			const bugfixRepair = decisionRepair.replace("decision", "bugfix");
			for (const lossyKind of ["dec", "memo"]) {
				const lossy = `<observation><type>${lossyKind}<title>Recover this item`;
				expect(
					shouldPreferRepairedObserverResponse(
						parseObserverResponse(lossy),
						decisionRepair,
						parseObserverResponse(decisionRepair),
						lossy,
					),
				).toBe(true);
			}
			const supportedPrefix = `<observation><type>dec<title>Recover this item`;
			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(supportedPrefix),
					bugfixRepair,
					parseObserverResponse(bugfixRepair),
					supportedPrefix,
				),
			).toBe(false);
		});

		it("reserves exact kind matches before correcting unsupported duplicates", () => {
			const sharedContent = `<title>Shared content</title>
				<narrative>Same durable body.</narrative>`;
			const initial = `<observation><type>memo</type>${sharedContent}</observation>
				<observation><type>discovery</type>${sharedContent}</observation>`;
			const repaired = `<observation><type>discovery</type>${sharedContent}</observation>
				<observation><type>decision</type>${sharedContent}</observation>`;

			expect(
				shouldPreferRepairedObserverResponse(
					parseObserverResponse(initial),
					repaired,
					parseObserverResponse(repaired),
					initial,
				),
			).toBe(true);
		});
	});

	describe("hasMeaningfulObservation", () => {
		it("returns true when observations have title or narrative", () => {
			expect(
				hasMeaningfulObservation([
					{
						kind: "change",
						title: "Something",
						narrative: "",
						subtitle: null,
						facts: [],
						concepts: [],
						filesRead: [],
						filesModified: [],
					},
				]),
			).toBe(true);
		});

		it("returns false for empty observations", () => {
			expect(hasMeaningfulObservation([])).toBe(false);
		});

		it("returns false when all observations lack title and narrative", () => {
			expect(
				hasMeaningfulObservation([
					{
						kind: "change",
						title: "",
						narrative: "",
						subtitle: null,
						facts: [],
						concepts: [],
						filesRead: [],
						filesModified: [],
					},
				]),
			).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------
// ingest-filters
// ---------------------------------------------------------------------------

describe("ingest-filters", () => {
	describe("isLowSignalObservation", () => {
		it("detects low-signal patterns", () => {
			expect(isLowSignalObservation("No code changes were recorded")).toBe(true);
			expect(isLowSignalObservation("No new deliverables")).toBe(true);
			expect(isLowSignalObservation("Only file inspection occurred")).toBe(true);
		});

		it("allows real observations through", () => {
			expect(isLowSignalObservation("Fixed race condition in session handler")).toBe(false);
			expect(isLowSignalObservation("Added OAuth2 PKCE flow to authentication")).toBe(false);
		});

		it("treats empty text as low-signal", () => {
			expect(isLowSignalObservation("")).toBe(true);
			expect(isLowSignalObservation("   ")).toBe(true);
		});
	});

	describe("normalizeObservation", () => {
		it("strips leading bullets and whitespace", () => {
			expect(normalizeObservation("  - Some observation")).toBe("Some observation");
			expect(normalizeObservation("• Bullet point")).toBe("Bullet point");
		});

		it("collapses whitespace", () => {
			expect(normalizeObservation("  multiple   spaces  ")).toBe("multiple spaces");
		});
	});
});

// ---------------------------------------------------------------------------
// ingest-sanitize
// ---------------------------------------------------------------------------

describe("ingest-sanitize", () => {
	describe("stripPrivate", () => {
		it("removes private blocks", () => {
			expect(stripPrivate("hello <private>secret</private> world")).toBe("hello  world");
		});

		it("handles orphaned opening tags", () => {
			expect(stripPrivate("before <private>after")).toBe("before ");
		});

		it("handles empty input", () => {
			expect(stripPrivate("")).toBe("");
		});

		it("is case-insensitive", () => {
			expect(stripPrivate("a <PRIVATE>b</PRIVATE> c")).toBe("a  c");
		});

		it("removes stray closing tags before later private blocks", () => {
			expect(stripPrivate("a </private> b <private>secret</private> c")).toBe("a  b  c");
		});
	});

	describe("isSensitiveFieldName", () => {
		it("detects camelCase API and private key names", () => {
			expect(isSensitiveFieldName("apiKey")).toBe(true);
			expect(isSensitiveFieldName("privateKey")).toBe(true);
		});
	});
});

// ---------------------------------------------------------------------------
// ingest() integration (mocked observer)
// ---------------------------------------------------------------------------

// CI occasionally times out these sqlite-backed ingest integration tests on
// shared runners. Keep the allowance scoped to this persistence-heavy suite
// rather than changing Vitest's global timeout.
describe("ingest() integration", { timeout: 15_000 }, () => {
	let tmpDir: string;
	let store: MemoryStore;
	let priorCaptureRouting: string | undefined;
	let priorDebug: string | undefined;

	beforeEach(() => {
		priorCaptureRouting = process.env.CODEMEM_CAPTURE_ROUTING;
		priorDebug = process.env.CODEMEM_DEBUG;
		delete process.env.CODEMEM_CAPTURE_ROUTING;
		delete process.env.CODEMEM_DEBUG;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-ingest-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		if (priorCaptureRouting === undefined) delete process.env.CODEMEM_CAPTURE_ROUTING;
		else process.env.CODEMEM_CAPTURE_ROUTING = priorCaptureRouting;
		if (priorDebug === undefined) delete process.env.CODEMEM_DEBUG;
		else process.env.CODEMEM_DEBUG = priorDebug;
		store?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const mockObserver = {
		observe: async () => ({
			raw: `<observation>
				<type>discovery</type>
				<title>Found the auth bug</title>
				<narrative>The timeout was caused by a race condition</narrative>
				<facts><fact>Race in session handler</fact></facts>
				<concepts><concept>concurrency</concept></concepts>
				<files_read><file>src/auth.ts</file></files_read>
				<files_modified></files_modified>
			</observation>
			<summary>
				<request>Fix auth timeout</request>
				<investigated>Session handling code</investigated>
				<learned>Race condition in handler</learned>
				<completed>Fixed the timeout</completed>
				<next_steps>Add retry logic</next_steps>
				<notes></notes>
			</summary>`,
			parsed: null,
			provider: "test",
			model: "test-model",
		}),
		getStatus: () => ({
			provider: "test",
			model: "test-model",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	};

	function buildPayload(overrides?: Partial<IngestPayload>): IngestPayload {
		return {
			cwd: "/tmp/test-project",
			events: [
				{
					type: "user_prompt",
					prompt_text: "Fix the auth timeout bug",
					prompt_number: 1,
					timestamp: new Date().toISOString(),
				},
				{
					type: "tool.execute.after",
					tool: "bash",
					args: { command: "grep -r timeout" },
					result: "src/auth.ts:42: setTimeout(...)",
					timestamp: new Date().toISOString(),
				},
				{
					type: "assistant_message",
					assistant_text: "I found the issue - there's a race condition in the session handler.",
					timestamp: new Date().toISOString(),
				},
			],
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-1",
				promptCount: 1,
				toolCount: 1,
				durationMs: 5000,
			},
			...overrides,
		};
	}

	function observerWithRaw(raw: string) {
		return {
			observe: async () => ({ raw, parsed: null, provider: "test", model: "test-model" }),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};
	}

	function latestObserverUsageMetadata(targetStore = store): Record<string, unknown> {
		const row = targetStore.db
			.prepare(
				"SELECT metadata_json FROM usage_events WHERE event = 'observer_call' ORDER BY id DESC LIMIT 1",
			)
			.get() as { metadata_json: string };
		return JSON.parse(row.metadata_json) as Record<string, unknown>;
	}

	function observerMemoryMetadata(title: string, targetStore = store): Record<string, unknown> {
		const row = targetStore.db
			.prepare("SELECT metadata_json FROM memory_items WHERE title = ? ORDER BY id DESC LIMIT 1")
			.get(title) as { metadata_json: string };
		return JSON.parse(row.metadata_json) as Record<string, unknown>;
	}

	it("creates memories from observer response", async () => {
		const payload = buildPayload();
		await ingest(payload, store, { observer: mockObserver } as unknown as IngestOptions);

		const memories = store.recent(10);
		expect(memories.length).toBeGreaterThan(0);

		// Should have at least one observation memory
		const obs = memories.find((m) => m.title === "Found the auth bug");
		expect(obs).toBeDefined();
		expect(obs?.kind).toBe("discovery");
		expect(obs?.body_text).toContain("race condition");
		expect(obs?.narrative).toContain("race condition");

		// Session should be ended
		const session = store.db
			.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as Record<string, unknown>;
		expect(session.project).toBe("test-project");
		expect(session.ended_at).not.toBeNull();

		const summaryMemory = store.db
			.prepare(
				"SELECT kind, metadata_json FROM memory_items WHERE json_extract(metadata_json, '$.is_summary') = 1 ORDER BY id DESC LIMIT 1",
			)
			.get() as { kind: string; metadata_json: string };
		expect(summaryMemory.kind).toBe("session_summary");
		const summaryMetadata = JSON.parse(summaryMemory.metadata_json) as Record<string, unknown>;
		expect(summaryMetadata.request).toBe("Fix auth timeout");
		expect(summaryMetadata.completed).toBe("Fixed the timeout");
		expect(summaryMetadata.learned).toBe("Race condition in handler");
	});

	it("repairs a structured response when parsing would discard an observation", async () => {
		const calls: Array<{ system: string; user: string }> = [];
		const lossy = `<summary>
			<request>Preserve the parser fix</request>
			<learned>The parser detected discarded durable content.</learned>
		</summary>
		<observation>
				<type>discovery</type>
				<title>Parser data loss now triggers repair</title>
				<narrative>A one-shot repair preserves durable observer content that malformed XML would discard.</narrative>
				<facts><fact>Parser-confirmed data loss triggers one XML repair call.</fact></facts>
				<concepts><concept>problem-solution</concept></concepts>
				<files_read></files_read><files_modified></files_modified>`;
		const repaired = `<observation>
			<type>discovery</type>
			<title>Parser data loss now triggers repair</title>
			<narrative>A one-shot repair preserves durable observer content that malformed XML would discard.</narrative>
			<facts><fact>Parser-confirmed data loss triggers one XML repair call.</fact></facts>
			<concepts><concept>problem-solution</concept></concepts>
			<files_read></files_read><files_modified></files_modified>
		</observation>
		<summary><request>Preserve the parser fix</request><learned>The parser detected discarded durable content.</learned></summary>`;
		const observer = {
			observe: async (system: string, user: string) => {
				calls.push({ system, user });
				return {
					raw: calls.length === 1 ? lossy : repaired,
					parsed: null,
					provider: "test",
					model: "test-model",
				};
			},
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		await ingest(buildPayload(), store, { observer } as unknown as IngestOptions);

		expect(calls).toHaveLength(2);
		expect(calls[1]?.system).toContain("previous reply was invalid");
		expect(calls[1]?.user).toContain(lossy);
		expect(
			store.recent(10).some((memory) => memory.title === "Parser data loss now triggers repair"),
		).toBe(true);
	});

	it("retains valid initial content when the parser repair returns no output", async () => {
		const calls: Array<{ system: string; user: string }> = [];
		const partiallyRetained = `<observation>
			<type>discovery</type>
			<title>Initial valid lesson survives repair failure</title>
			<narrative>The parser retained this valid observation before detecting another malformed block.</narrative>
		</observation>
		<summary>
			<request>Keep valid initial content</request>
			<notes><observation></notes>
		</summary>`;
		const observer = {
			observe: async (system: string, user: string) => {
				calls.push({ system, user });
				return {
					raw: calls.length === 1 ? partiallyRetained : null,
					parsed: null,
					provider: "test",
					model: "test-model",
				};
			},
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		await ingest(buildPayload(), store, { observer } as unknown as IngestOptions);

		expect(calls).toHaveLength(2);
		expect(
			store
				.recent(10)
				.some((memory) => memory.title === "Initial valid lesson survives repair failure"),
		).toBe(true);
	});

	it("retains valid initial content when the parser repair throws", async () => {
		let callCount = 0;
		const partiallyRetained = `<observation>
			<type>discovery</type>
			<title>Initial valid lesson survives repair exception</title>
			<narrative>The parser retained this valid observation before repair failed.</narrative>
		</observation><observation><type>bugfix</type><title>Truncated`;
		const observer = {
			observe: async () => {
				callCount += 1;
				if (callCount === 2) throw new Error("repair transport failed");
				return {
					raw: partiallyRetained,
					parsed: null,
					provider: "test",
					model: "test-model",
				};
			},
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		await ingest(buildPayload(), store, { observer } as unknown as IngestOptions);

		expect(callCount).toBe(2);
		expect(
			store
				.recent(10)
				.some((memory) => memory.title === "Initial valid lesson survives repair exception"),
		).toBe(true);
	});

	it("retains valid initial content when a clean repair returns different observations", async () => {
		const calls: string[] = [];
		const partiallyRetained = `<observation>
			<type>discovery</type>
			<title>Session ownership prevents stale refresh races</title>
			<narrative>The active session must own the refresh result before replacing authentication state.</narrative>
		</observation>
		<observation><type>discovery</type><title>Truncated replacement`;
		const disjointRepair = `<observation>
			<type>discovery</type>
			<title>Cache eviction uses bounded batches</title>
			<narrative>The clean response describes a different durable outcome.</narrative>
		</observation>`;
		const observer = {
			observe: async () => {
				calls.push("observe");
				return {
					raw: calls.length === 1 ? partiallyRetained : disjointRepair,
					parsed: null,
					provider: "test",
					model: "test-model",
				};
			},
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		await ingest(buildPayload(), store, { observer } as unknown as IngestOptions);

		expect(calls).toHaveLength(2);
		expect(store.recent(10).map((memory) => memory.title)).toContain(
			"Session ownership prevents stale refresh races",
		);
		expect(
			store.recent(10).some((memory) => memory.title === "Cache eviction uses bounded batches"),
		).toBe(false);
	});

	it("suppresses telemetry observations with capture routing enabled", async () => {
		process.env.CODEMEM_CAPTURE_ROUTING = "1";
		const observer = observerWithRaw(`<observation>
			<type>change</type>
			<title>Validation passed</title>
			<narrative>CI passed and lint was green.</narrative>
		</observation>`);

		await ingest(buildPayload(), store, { observer } as unknown as IngestOptions);

		expect(store.recent(10)).toHaveLength(0);
		expect(latestObserverUsageMetadata()).toEqual(
			expect.objectContaining({
				capture_suppressed_count: 1,
				capture_candidate_count: 0,
				capture_routing_enabled: true,
			}),
		);
	});

	it("keeps durable modal contracts as candidate derived facts", async () => {
		process.env.CODEMEM_CAPTURE_ROUTING = "1";
		const observer = observerWithRaw(`<observation>
			<type>discovery</type>
			<title>Handlers must return structured errors instead of throwing</title>
			<narrative>Handlers must return structured errors instead of throwing.</narrative>
		</observation>`);

		await ingest(buildPayload(), store, { observer } as unknown as IngestOptions);

		const metadata = observerMemoryMetadata(
			"Handlers must return structured errors instead of throwing",
		);
		expect(metadata.derivation).toEqual(
			expect.objectContaining({
				candidate: true,
				evaluated_extractor_version: "v1",
			}),
		);
		expect((metadata.derivation as Record<string, unknown>).candidate_reasons).toContain(
			"modal_contract",
		);
	});

	it("keeps validation text that embeds a durable contract", async () => {
		process.env.CODEMEM_CAPTURE_ROUTING = "1";
		const observer = observerWithRaw(`<observation>
			<type>discovery</type>
			<title>CI passed after confirming handlers must return structured errors</title>
			<narrative>CI passed after confirming handlers must return structured errors.</narrative>
		</observation>`);

		await ingest(buildPayload(), store, { observer } as unknown as IngestOptions);

		const metadata = observerMemoryMetadata(
			"CI passed after confirming handlers must return structured errors",
		);
		expect(metadata.derivation).toEqual(
			expect.objectContaining({
				candidate: true,
				evaluated_extractor_version: "v1",
			}),
		);
	});

	it("stores unknown observations with explicit candidate false", async () => {
		process.env.CODEMEM_CAPTURE_ROUTING = "1";
		const observer = observerWithRaw(`<observation>
			<type>change</type>
			<title>Review pass is pending</title>
			<narrative>The review pass is pending.</narrative>
		</observation>`);

		await ingest(buildPayload(), store, { observer } as unknown as IngestOptions);

		const metadata = observerMemoryMetadata("Review pass is pending");
		expect(metadata.derivation).toEqual({
			candidate: false,
			evaluated_extractor_version: "v1",
		});
	});

	it("does not route summaries through capture suppression", async () => {
		process.env.CODEMEM_CAPTURE_ROUTING = "1";
		const observer = observerWithRaw(`<observation>
			<type>change</type>
			<title>Validation passed</title>
			<narrative>CI passed and lint was green.</narrative>
		</observation>
		<summary>
			<request>Validate routing</request>
			<completed>CI passed and lint was green.</completed>
		</summary>`);

		await ingest(buildPayload(), store, { observer } as unknown as IngestOptions);

		const summaryMemory = store.db
			.prepare(
				"SELECT kind, metadata_json FROM memory_items WHERE json_extract(metadata_json, '$.is_summary') = 1 ORDER BY id DESC LIMIT 1",
			)
			.get() as { kind: string; metadata_json: string };
		expect(summaryMemory.kind).toBe("session_summary");
		expect(JSON.parse(summaryMemory.metadata_json).completed).toBe("CI passed and lint was green.");
		expect(latestObserverUsageMetadata().capture_suppressed_count).toBe(1);
	});

	it("does not add derivation metadata to manual memories when routing is enabled", () => {
		process.env.CODEMEM_CAPTURE_ROUTING = "1";
		const sessionId = store.startSession({ cwd: tmpDir, project: "codemem" });
		store.remember(
			sessionId,
			"discovery",
			"Manual contract",
			"Handlers must return structured errors instead of throwing.",
		);

		const metadata = observerMemoryMetadata("Manual contract");
		expect(metadata.derivation).toBeUndefined();
	});

	it("terminally completes raw-event batches when capture routing suppresses every observation", async () => {
		process.env.CODEMEM_CAPTURE_ROUTING = "1";
		store.recordRawEvent({
			opencodeSessionId: "sess-capture-suppressed",
			eventId: "evt-1",
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: "run validation" },
			tsWallMs: 100,
		});
		store.recordRawEvent({
			opencodeSessionId: "sess-capture-suppressed",
			eventId: "evt-2",
			eventType: "tool.execute.after",
			payload: { type: "tool.execute.after", tool: "bash", args: {}, result: "ci passed" },
			tsWallMs: 200,
		});

		const observer = observerWithRaw(`<observation>
			<type>change</type>
			<title>Validation passed</title>
			<narrative>CI passed and lint was green.</narrative>
		</observation>`);

		await expect(
			flushRawEvents(store, { observer } as unknown as IngestOptions, {
				opencodeSessionId: "sess-capture-suppressed",
				cwd: tmpDir,
				project: "codemem",
			}),
		).resolves.toEqual({ flushed: 2, updatedState: 1 });

		expect(store.rawEventFlushState("sess-capture-suppressed")).toBe(1);
		expect(store.recent(10)).toHaveLength(0);
		const session = store.db
			.prepare("SELECT ended_at, metadata_json FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as { ended_at: string | null; metadata_json: string };
		expect(session.ended_at).not.toBeNull();
		expect(JSON.parse(session.metadata_json).post).toEqual(
			expect.objectContaining({ capture_suppressed_count: 1 }),
		);
	});

	it("stores telemetry without derivation metadata when capture routing is off", async () => {
		const observer = observerWithRaw(`<observation>
			<type>change</type>
			<title>Validation passed</title>
			<narrative>CI passed and lint was green.</narrative>
		</observation>`);

		await ingest(buildPayload(), store, { observer } as unknown as IngestOptions);

		const metadata = observerMemoryMetadata("Validation passed");
		expect(metadata.derivation).toBeUndefined();
		// Default-off must be byte-identical to pre-feature: NO capture keys emitted.
		const usage = latestObserverUsageMetadata();
		expect(usage).not.toHaveProperty("capture_suppressed_count");
		expect(usage).not.toHaveProperty("capture_candidate_count");
		expect(usage).not.toHaveProperty("capture_routing_enabled");
	});

	it("stores only durable candidates from mixed batches when capture routing is on", async () => {
		const raw = `<observation>
			<type>discovery</type>
			<title>Handlers must return structured errors</title>
			<narrative>Handlers must return structured errors instead of throwing.</narrative>
		</observation>
		<observation>
			<type>change</type>
			<title>CI passed</title>
			<narrative>CI passed and lint was green.</narrative>
		</observation>
		<observation>
			<type>change</type>
			<title>Review approved</title>
			<narrative>The review was approved with no blockers.</narrative>
		</observation>`;

		await ingest(buildPayload(), store, {
			observer: observerWithRaw(raw),
		} as unknown as IngestOptions);
		expect(store.recent(10).filter((memory) => memory.kind !== "session_summary")).toHaveLength(3);

		const tmpDirOn = mkdtempSync(join(tmpdir(), "codemem-ingest-routing-on-"));
		const dbPathOn = join(tmpDirOn, "test.sqlite");
		const setupDbOn = connect(dbPathOn);
		initTestSchema(setupDbOn);
		setupDbOn.close();
		const routingStore = new MemoryStore(dbPathOn);
		try {
			process.env.CODEMEM_CAPTURE_ROUTING = "1";
			await ingest(buildPayload(), routingStore, {
				observer: observerWithRaw(raw),
			} as unknown as IngestOptions);
			expect(
				routingStore.recent(10).filter((memory) => memory.kind !== "session_summary"),
			).toHaveLength(1);
			expect(latestObserverUsageMetadata(routingStore)).toEqual(
				expect.objectContaining({
					capture_suppressed_count: 2,
					capture_candidate_count: 1,
					capture_routing_enabled: true,
				}),
			);
		} finally {
			routingStore.close();
			rmSync(tmpDirOn, { recursive: true, force: true });
		}
	});

	it("suppresses summary-only micro-session recap output", async () => {
		const summaryOnlyObserver = {
			observe: async () => ({
				raw: `<summary>
					<request>Check retrieval noise</request>
					<investigated>Looked at role report output</investigated>
					<learned>Recap-heavy rows still dominate</learned>
					<completed>Reviewed the current ranking behavior</completed>
					<next_steps>Tighten recap weighting</next_steps>
					<notes></notes>
				</summary>`,
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			events: [
				{
					type: "user_prompt",
					prompt_text: "check retrieval noise",
					prompt_number: 1,
					timestamp: new Date().toISOString(),
				},
				{
					type: "assistant_message",
					assistant_text: "Done.",
					timestamp: new Date().toISOString(),
				},
			],
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-micro-summary",
				promptCount: 1,
				toolCount: 0,
				durationMs: 20_000,
			},
		});

		await ingest(payload, store, { observer: summaryOnlyObserver } as unknown as IngestOptions);

		expect(store.recent(10)).toHaveLength(0);
		const sessionMeta = store.db
			.prepare("SELECT metadata_json FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as { metadata_json: string };
		expect(JSON.parse(sessionMeta.metadata_json).post).toEqual(
			expect.objectContaining({
				session_class: "micro_low_value",
				summary_disposition: "suppressed",
			}),
		);
	});

	it("persists session class on typed observer memories", async () => {
		const typedObserver = {
			observe: async () => ({
				raw: `<observation>
					<type>decision</type>
					<title>Keep session class on typed memories</title>
					<narrative>Typed memories should carry the same session class as the source session.</narrative>
					<files_read>
						<file>src/session-policy.ts</file>
					</files_read>
				</observation>`,
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			events: [
				{
					type: "user_prompt",
					prompt_text: "investigate session classification persistence",
					prompt_number: 1,
					timestamp: new Date().toISOString(),
				},
				{
					type: "assistant_message",
					assistant_text: "Tracked the policy gap.",
					timestamp: new Date().toISOString(),
				},
			],
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-typed-session-class",
				promptCount: 2,
				toolCount: 3,
				durationMs: 240_000,
				filesRead: ["/tmp/repo/src/session-policy.ts"],
			},
		});

		await ingest(payload, store, { observer: typedObserver } as unknown as IngestOptions);

		const memory = store.db
			.prepare(
				"SELECT kind, metadata_json FROM memory_items WHERE json_extract(metadata_json, '$.source') = 'observer' ORDER BY id DESC LIMIT 1",
			)
			.get() as { kind: string; metadata_json: string };
		expect(memory.kind).toBe("decision");
		expect(JSON.parse(memory.metadata_json).session_class).toBe("working");
	});

	it("keeps summary-only output for longer sessions", async () => {
		const summaryOnlyObserver = {
			observe: async () => ({
				raw: `<summary>
					<request>Check retrieval noise</request>
					<investigated>Looked at role report output</investigated>
					<learned>Recap-heavy rows still dominate</learned>
					<completed>Reviewed the current ranking behavior</completed>
					<next_steps>Tighten recap weighting</next_steps>
					<notes></notes>
				</summary>`,
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			events: [
				{
					type: "user_prompt",
					prompt_text: "ok",
					prompt_number: 1,
					timestamp: new Date().toISOString(),
				},
				{
					type: "assistant_message",
					assistant_text: "Done.",
					timestamp: new Date().toISOString(),
				},
			],
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-long-summary",
				promptCount: 1,
				toolCount: 0,
				durationMs: 120_000,
			},
		});

		await ingest(payload, store, { observer: summaryOnlyObserver } as unknown as IngestOptions);

		const summaryMemory = store.db
			.prepare(
				"SELECT kind, metadata_json FROM memory_items WHERE json_extract(metadata_json, '$.is_summary') = 1 ORDER BY id DESC LIMIT 1",
			)
			.get() as { kind: string; metadata_json: string };
		expect(summaryMemory.kind).toBe("session_summary");
		expect(JSON.parse(summaryMemory.metadata_json).session_class).toBe("working");
		const sessionMeta = store.db
			.prepare("SELECT metadata_json FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as { metadata_json: string };
		expect(JSON.parse(sessionMeta.metadata_json).post).toEqual(
			expect.objectContaining({
				session_class: "working",
				summary_disposition: "stored",
			}),
		);
	});

	it("falls back to cwd basename when payload project is missing", async () => {
		const payload = buildPayload({ cwd: "/tmp/workspaces/codemem" });
		await ingest(payload, store, { observer: mockObserver } as unknown as IngestOptions);

		const session = store.db
			.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as Record<string, unknown>;
		expect(session.project).toBe("codemem");
	});

	it("normalizes explicit path-like project labels before storing the session", async () => {
		const payload = buildPayload({
			cwd: "/tmp/workspaces/other-repo",
			project: "C:\\work\\codemem\\",
		});
		await ingest(payload, store, { observer: mockObserver } as unknown as IngestOptions);

		const session = store.db
			.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as Record<string, unknown>;
		expect(session.project).toBe("codemem");
	});

	it("handles observer returning null gracefully", async () => {
		const nullObserver = {
			observe: async () => ({
				raw: null as string | null,
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload();
		// Should not throw
		await ingest(payload, store, { observer: nullObserver } as unknown as IngestOptions);

		// No memories created
		const memories = store.recent(10);
		expect(memories).toHaveLength(0);

		// Session should still be ended
		const session = store.db
			.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as Record<string, unknown>;
		expect(session.ended_at).not.toBeNull();
	});

	it("treats skip_summary low-signal raw-event flushes as terminal no-op", async () => {
		const lowSignalObserver = {
			observe: async () => ({
				raw: '<skip_summary reason="low-signal"/>',
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-low-signal",
				promptCount: 1,
				toolCount: 1,
				durationMs: 1000,
				flusher: "raw_events",
			},
		});

		await ingest(payload, store, { observer: lowSignalObserver } as unknown as IngestOptions);

		expect(store.recent(10)).toHaveLength(0);
		const session = store.db
			.prepare("SELECT ended_at, metadata_json FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as { ended_at: string | null; metadata_json: string | null };
		expect(session.ended_at).not.toBeNull();
		// Default-off: this raw-event zero-output session-end branch must NOT leak
		// capture-routing metadata into session records (Codex default-off P2).
		const sessionMeta = JSON.parse(session.metadata_json ?? "{}") as Record<string, unknown>;
		expect(sessionMeta).not.toHaveProperty("capture_suppressed_count");
	});

	it("still fails raw-event flush when skip_summary reason is not low-signal", async () => {
		const oddSkipObserver = {
			observe: async () => ({
				raw: '<skip_summary reason="other"/>',
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-skip-other",
				promptCount: 1,
				toolCount: 1,
				durationMs: 1000,
				flusher: "raw_events",
			},
		});

		await expect(
			ingest(payload, store, { observer: oddSkipObserver } as unknown as IngestOptions),
		).rejects.toThrow("observer produced no storable output for raw-event flush");

		expect(store.recent(10)).toHaveLength(0);
	});

	it("still fails raw-event flush when low-signal skip is mixed with summary output", async () => {
		const mixedObserver = {
			observe: async () => ({
				raw: '<summary><request>Check logs</request></summary><skip_summary reason="low-signal"/>',
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-skip-mixed",
				promptCount: 1,
				toolCount: 1,
				durationMs: 1000,
				flusher: "raw_events",
			},
		});

		await expect(
			ingest(payload, store, { observer: mixedObserver } as unknown as IngestOptions),
		).rejects.toThrow("observer repair remained lossy during raw-event flush");

		expect(store.recent(10)).toHaveLength(0);
	});

	it("treats summary-only micro-session raw-event flushes as terminal no-op", async () => {
		const summaryOnlyObserver = {
			observe: async () => ({
				raw: `<summary>
					<request>Check retrieval noise</request>
					<investigated>Looked at role report output</investigated>
					<learned>Recap-heavy rows still dominate</learned>
					<completed>Reviewed the current ranking behavior</completed>
					<next_steps>Tighten recap weighting</next_steps>
					<notes></notes>
				</summary>`,
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			events: [
				{
					type: "user_prompt",
					prompt_text: "ok",
					prompt_number: 1,
					timestamp: new Date().toISOString(),
				},
				{
					type: "assistant_message",
					assistant_text: "Done.",
					timestamp: new Date().toISOString(),
				},
			],
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-summary-only-micro",
				promptCount: 1,
				toolCount: 0,
				durationMs: 20_000,
				flusher: "raw_events",
			},
		});

		await ingest(payload, store, { observer: summaryOnlyObserver } as unknown as IngestOptions);

		expect(store.recent(10)).toHaveLength(0);
		const session = store.db
			.prepare("SELECT ended_at FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as { ended_at: string | null };
		expect(session.ended_at).not.toBeNull();
	});

	it("does not terminally no-op a prompt-only raw-event flush before assistant context arrives", async () => {
		const observer = {
			observe: async () => ({
				raw: `<summary>
					<request>Check retrieval noise</request>
					<completed>Reviewed the current ranking behavior</completed>
				</summary>`,
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			events: [
				{
					type: "user_prompt",
					prompt_text: "ok",
					prompt_number: 1,
					timestamp: new Date().toISOString(),
				},
			],
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-prompt-only",
				promptCount: 1,
				toolCount: 0,
				durationMs: 20_000,
				flusher: "raw_events",
			},
		});

		await expect(ingest(payload, store, { observer } as unknown as IngestOptions)).rejects.toThrow(
			"observer produced no storable output for raw-event flush",
		);
	});

	it("retries once when observer returns plain text instead of XML during raw-event flush", async () => {
		let calls = 0;
		const retryingObserver = {
			observe: async () => {
				calls += 1;
				if (calls === 1) {
					return {
						raw: "Got it — the session inspected current pack stats and restart state.",
						parsed: null,
						provider: "test",
						model: "test-model",
					};
				}
				return {
					raw: `<observation><type>discovery</type><title>current pack stats and restart state</title><subtitle>current pack stats and restart state</subtitle><narrative>Got it — the session inspected current pack stats and restart state.</narrative><concepts><concept>how-it-works</concept></concepts></observation><summary><investigated>the session inspected current pack stats and restart state</investigated></summary>`,
					parsed: null,
					provider: "test",
					model: "test-model",
				};
			},
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-retry-xml",
				promptCount: 1,
				toolCount: 1,
				durationMs: 1000,
				flusher: "raw_events",
			},
		});

		await ingest(payload, store, { observer: retryingObserver } as unknown as IngestOptions);

		expect(calls).toBe(2);
		const memories = store.recent(10);
		expect(memories.some((memory) => memory.title === "current pack stats and restart state")).toBe(
			true,
		);
	});

	it("still fails raw-event flush when observer stays non-XML after retry", async () => {
		let calls = 0;
		const invalidObserver = {
			observe: async () => {
				calls += 1;
				return {
					raw: "I can summarize the session in plain English if you want.",
					parsed: null,
					provider: "test",
					model: "test-model",
				};
			},
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			sessionContext: {
				source: "opencode",
				streamId: "test-stream-invalid-xml",
				promptCount: 1,
				toolCount: 1,
				durationMs: 1000,
				flusher: "raw_events",
			},
		});

		await expect(
			ingest(payload, store, { observer: invalidObserver } as unknown as IngestOptions),
		).rejects.toThrow("observer produced no storable output for raw-event flush");

		expect(calls).toBe(2);
		expect(store.recent(10)).toHaveLength(0);
	});

	it("skips trivial requests", async () => {
		let observerCalled = false;
		const trackingObserver = {
			observe: async () => {
				observerCalled = true;
				return { raw: null as string | null, parsed: null, provider: "test", model: "test" };
			},
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const payload = buildPayload({
			events: [{ type: "user_prompt", prompt_text: "yes", timestamp: new Date().toISOString() }],
		});

		await ingest(payload, store, { observer: trackingObserver } as unknown as IngestOptions);

		expect(observerCalled).toBe(false);

		// Session should still be ended
		const session = store.db
			.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as Record<string, unknown>;
		expect(session.ended_at).not.toBeNull();
	});

	it("routes live rich batches to the rich observer tier when enabled and persists routing metadata", async () => {
		const observer = {
			provider: "openai",
			model: "gpt-5.4-mini",
			runtime: "api_http",
			tierRoutingEnabled: true,
			openaiUseResponses: false,
			reasoningEffort: null,
			reasoningSummary: null,
			maxChars: 12000,
			maxTokens: 4000,
			maxOutputTokens: 4000,
			temperature: 0.2,
			getStatus: () => ({
				provider: "openai",
				model: "gpt-5.4-mini",
				runtime: "api_http",
				auth: { source: "none", type: "api_direct", hasToken: true },
			}),
			toConfig: () => ({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerTierRoutingEnabled: true,
				observerSimpleModel: "gpt-5.4-mini",
				observerSimpleTemperature: 0.2,
				observerRichModel: "gpt-5.4",
				observerRichTemperature: 0.2,
				observerRichReasoningEffort: null,
				observerRichReasoningSummary: null,
				observerRichMaxOutputTokens: 12000,
				observerOpenAIUseResponses: false,
				observerReasoningEffort: null,
				observerReasoningSummary: null,
				observerMaxOutputTokens: 4000,
				observerMaxChars: 12000,
				observerMaxTokens: 4000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			}),
			observe: async () => ({
				raw: `<observation>
				  <type>decision</type>
				  <title>Track 3 reframed around injection-first quality</title>
				  <subtitle>Rich live routing should preserve this.</subtitle>
				  <facts><fact>Track 3 was reframed around injection-first quality.</fact></facts>
				  <narrative>This rich batch kept the durable subthreads visible.</narrative>
				  <concepts><concept>decision</concept></concepts>
				  <files_read><file>docs/one.md</file></files_read>
				  <files_modified><file>packages/core/src/x.ts</file></files_modified>
				</observation>
				<summary>
				  <request>Investigate qd7h and Track 3.</request>
				  <completed>Captured the rich batch summary.</completed>
				  <notes>Selected rich routing path.</notes>
				  <files_read><file>docs/one.md</file></files_read>
				  <files_modified><file>packages/core/src/x.ts</file></files_modified>
				</summary>`,
				parsed: null,
				provider: "openai",
				model: "gpt-5.4",
			}),
		} as unknown as IngestOptions["observer"];
		const createTierObserver = (config: ObserverConfig) =>
			({
				...observer,
				model: String(config.observerRichModel ?? config.observerModel ?? "gpt-5.4"),
				openaiUseResponses: config.observerOpenAIUseResponses === true,
			}) as IngestOptions["observer"];

		const payload = buildPayload({
			events: [
				{
					type: "user_prompt",
					prompt_text: "Investigate qd7h and Track 3",
					timestamp: new Date().toISOString(),
				},
				{
					type: "assistant_message",
					assistant_text: "We also need release readiness and graph direction.",
					timestamp: new Date().toISOString(),
				},
				{
					type: "user_prompt",
					prompt_text: "Capture the durable subthreads",
					timestamp: new Date().toISOString(),
				},
				{
					type: "assistant_message",
					assistant_text: "I will summarize the full rich batch.",
					timestamp: new Date().toISOString(),
				},
				...Array.from({ length: 30 }, (_, i) => ({
					type: "tool.execute.after",
					tool: "read",
					args: { filePath: `docs/file-${i}.md` },
					result: "ok",
					timestamp: new Date().toISOString(),
				})),
			],
			sessionContext: {
				promptCount: 3,
				toolCount: 30,
				durationMs: 900000,
				filesRead: ["docs/one.md", "docs/two.md"],
				filesModified: ["packages/core/src/x.ts"],
			},
		});

		await ingest(payload, store, { observer, createTierObserver } as IngestOptions);

		const memoryRow = store.db
			.prepare(
				"SELECT metadata_json FROM memory_items WHERE kind = 'decision' ORDER BY id DESC LIMIT 1",
			)
			.get() as { metadata_json: string } | undefined;
		const sessionRow = store.db
			.prepare("SELECT metadata_json FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as { metadata_json: string } | undefined;

		const memoryMeta = memoryRow?.metadata_json ? JSON.parse(memoryRow.metadata_json) : {};
		const sessionMeta = sessionRow?.metadata_json ? JSON.parse(sessionRow.metadata_json) : {};

		expect(memoryMeta).toEqual(
			expect.objectContaining({
				observer_tier: "rich",
				observer_requested_provider: "openai",
				observer_requested_model: "gpt-5.4",
				observer_requested_runtime: "api_http",
				observer_provider: "openai",
				observer_model: "gpt-5.4",
				observer_runtime: "api_http",
				observer_openai_responses: true,
				observer_fallback_applied: false,
				observer_fallback_reason: null,
			}),
		);
		expect(sessionMeta.post).toEqual(
			expect.objectContaining({
				observer_tier: "rich",
				observer_requested_provider: "openai",
				observer_requested_model: "gpt-5.4",
				observer_requested_runtime: "api_http",
				observer_provider: "openai",
				observer_model: "gpt-5.4",
				observer_runtime: "api_http",
				observer_openai_responses: true,
				observer_fallback_applied: false,
				observer_fallback_reason: null,
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// cleanOrphanSessions
// ---------------------------------------------------------------------------

describe("cleanOrphanSessions", () => {
	let tmpDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-orphan-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("closes stale sessions", async () => {
		// Dynamically import to get the function
		const { cleanOrphanSessions } = await import("./ingest-pipeline.js");

		// Insert an old session with no ended_at
		store.db
			.prepare("INSERT INTO sessions (started_at, cwd) VALUES (?, ?)")
			.run("2020-01-01T00:00:00Z", "/tmp");

		const cleaned = cleanOrphanSessions(store, 1);
		expect(cleaned).toBe(1);

		// Verify it was ended
		const session = store.db.prepare("SELECT * FROM sessions WHERE id = 1").get() as Record<
			string,
			unknown
		>;
		expect(session.ended_at).not.toBeNull();
	});

	it("does not close recent sessions", async () => {
		const { cleanOrphanSessions } = await import("./ingest-pipeline.js");

		// Insert a recent session with no ended_at
		store.db
			.prepare("INSERT INTO sessions (started_at, cwd) VALUES (?, ?)")
			.run(new Date().toISOString(), "/tmp");

		const cleaned = cleanOrphanSessions(store, 1);
		expect(cleaned).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// supersedePriorObserverSummaries
// ---------------------------------------------------------------------------

describe("supersedePriorObserverSummaries", () => {
	let tmpDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-supersede-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	async function loadHelpers() {
		const { supersedePriorObserverSummaries } = await import("./ingest-pipeline.js");
		const { drizzle } = await import("drizzle-orm/better-sqlite3");
		const schema = await import("./schema.js");
		return {
			supersede: supersedePriorObserverSummaries,
			d: drizzle(store.db, { schema }),
		};
	}

	function insertSession(): number {
		const result = store.db
			.prepare("INSERT INTO sessions (started_at, cwd) VALUES (?, ?)")
			.run(new Date().toISOString(), "/tmp") as { lastInsertRowid: number };
		return result.lastInsertRowid;
	}

	it("returns an empty list when no prior observer summaries exist", async () => {
		const { supersede, d } = await loadHelpers();
		const sessionId = insertSession();
		const supersededIds = supersede(store, d, sessionId);
		expect(supersededIds).toEqual([]);
	});

	it("soft-deletes prior active observer summaries for the session", async () => {
		const { supersede, d } = await loadHelpers();
		const sessionId = insertSession();

		const oldA = store.remember(sessionId, "session_summary", "flush A", "body A", 0.3, undefined, {
			source: "observer_summary",
		});
		const oldB = store.remember(sessionId, "session_summary", "flush B", "body B", 0.3, undefined, {
			source: "observer_summary",
		});

		const supersededIds = supersede(store, d, sessionId);
		expect(supersededIds.sort()).toEqual([oldA, oldB].sort());

		const rows = store.db
			.prepare(
				"SELECT id, active, metadata_json FROM memory_items WHERE session_id = ? AND kind = 'session_summary' ORDER BY id ASC",
			)
			.all(sessionId) as Array<{ id: number; active: number; metadata_json: string }>;
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.active === 0)).toBe(true);
		for (const row of rows) {
			const meta = JSON.parse(row.metadata_json ?? "{}");
			expect(typeof meta.superseded_at).toBe("string");
		}
	});

	it("does not touch summaries from other sources or other sessions", async () => {
		const { supersede, d } = await loadHelpers();
		const sessionId = insertSession();
		const otherSessionId = insertSession();

		const legacyId = store.remember(
			sessionId,
			"session_summary",
			"legacy summary",
			"legacy body",
			0.3,
			undefined,
			{ source: "legacy_import" },
		);
		const otherSessionSummaryId = store.remember(
			otherSessionId,
			"session_summary",
			"other session",
			"other body",
			0.3,
			undefined,
			{ source: "observer_summary" },
		);

		const supersededIds = supersede(store, d, sessionId);
		expect(supersededIds).toEqual([]);

		const legacyActive = store.db
			.prepare("SELECT active FROM memory_items WHERE id = ?")
			.get(legacyId) as { active: number };
		const otherActive = store.db
			.prepare("SELECT active FROM memory_items WHERE id = ?")
			.get(otherSessionSummaryId) as { active: number };
		expect(legacyActive.active).toBe(1);
		expect(otherActive.active).toBe(1);
	});

	it("keeps the freshest content when a later flush repeats an earlier title", async () => {
		// Reproduces the bug path the reviewer flagged: flush A, flush B, flush A
		// again. If supersede ran after store.remember, the A-title dedupe would
		// return the oldest A row and we would wipe out B, regressing to stale
		// content. Running supersede first ensures the dedupe query sees no
		// active matches so store.remember always inserts fresh.
		const { supersede, d } = await loadHelpers();
		const sessionId = insertSession();

		// Flush 1
		supersede(store, d, sessionId);
		const rowA1 = store.remember(
			sessionId,
			"session_summary",
			"flush A",
			"body A1",
			0.3,
			undefined,
			{ source: "observer_summary" },
		);

		// Flush 2 (different title)
		supersede(store, d, sessionId);
		const rowB = store.remember(sessionId, "session_summary", "flush B", "body B", 0.3, undefined, {
			source: "observer_summary",
		});

		// Flush 3 (repeats title A with fresher body)
		supersede(store, d, sessionId);
		const rowA2 = store.remember(
			sessionId,
			"session_summary",
			"flush A",
			"body A2-fresh",
			0.3,
			undefined,
			{ source: "observer_summary" },
		);

		// All three rows must be distinct inserts; the dedupe should not have
		// reused rowA1's id because it was soft-deleted before flush 3.
		expect(new Set([rowA1, rowB, rowA2]).size).toBe(3);

		const activeRows = store.db
			.prepare(
				"SELECT id, body_text FROM memory_items WHERE session_id = ? AND kind = 'session_summary' AND active = 1",
			)
			.all(sessionId) as Array<{ id: number; body_text: string }>;
		expect(activeRows).toHaveLength(1);
		expect(activeRows[0]?.id).toBe(rowA2);
		expect(activeRows[0]?.body_text).toBe("body A2-fresh");
	});
});
