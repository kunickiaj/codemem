import { describe, expect, it } from "vitest";
import {
	inspectObserverResponseStructure,
	parseObserverResponse,
	shouldPreferRepairedObserverResponse,
} from "./ingest-xml-parser.js";
import { MAX_OBSERVER_XML_CHARACTERS, openingTagEnds } from "./ingest-xml-scan.js";

describe("legacy XML cost and recovery", () => {
	it.each([
		["unmatched observations", "<observation>".repeat(32_000)],
		["unmatched summaries", "<summary>".repeat(32_000)],
		["missing root delimiters", "<observation ".repeat(32_000)],
		["missing scalar delimiters", `<observation>${"<title ".repeat(32_000)}</observation>`],
		[
			"unmatched parents",
			`<observation><type>discovery</type>${"<facts>".repeat(32_000)}</observation>`,
		],
		[
			"unmatched children",
			`<observation><type>discovery</type><facts>${"<fact>".repeat(32_000)}</facts></observation>`,
		],
		[
			"missing child delimiters",
			`<observation><type>discovery</type><facts>${"<fact ".repeat(32_000)}</facts></observation>`,
		],
		["unclosed summary siblings", `<summary>${"<request>text".repeat(32_000)}</summary>`],
	])("finishes %s within one second", (_name, raw) => {
		const started = performance.now();
		const parsed = parseObserverResponse(raw);
		const diagnostics = inspectObserverResponseStructure(raw, parsed);
		expect(diagnostics.recognizedOutput).toBe(true);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("rejects oversized raw output before fence cleanup rather than truncating", () => {
		const raw = "```".repeat(Math.ceil(MAX_OBSERVER_XML_CHARACTERS / 3));
		expect(() => parseObserverResponse(raw)).toThrow("observer_output_too_large");
		expect(() => inspectObserverResponseStructure(raw)).toThrow(RangeError);
	});

	it("accepts the exact aggregate limit", () => {
		const xml = '<skip_summary reason="low-signal"/>';
		expect(parseObserverResponse(xml.padEnd(MAX_OBSERVER_XML_CHARACTERS))).toMatchObject({
			skipSummaryReason: "low-signal",
		});
	});

	it("keeps source offsets intact after Unicode prose and accepts uppercase child tags", () => {
		expect(
			parseObserverResponse(
				"İ<observation><TYPE>discovery</TYPE><TITLE>İ lesson</TITLE></observation>",
			).observations[0],
		).toMatchObject({
			kind: "discovery",
			title: "İ lesson",
		});
	});

	it("keeps the first malformed opening and its first closing rather than inventing nesting", () => {
		const xml =
			'<observation broken="<observation><type>discovery</type><title>Retained</title></observation>';
		expect(parseObserverResponse(xml).observations[0]?.title).toBe("Retained");
		expect(inspectObserverResponseStructure(xml).discardedObservationBlocks).toBe(1);
	});

	it("retains legacy root prefix and case behavior", () => {
		expect(
			parseObserverResponse("<observations><TITLE>Legacy prefix</TITLE></observation>")
				.observations[0]?.title,
		).toBe("Legacy prefix");
		expect(
			parseObserverResponse("<OBSERVATION><title>Ignored</title></OBSERVATION>").observations,
		).toEqual([]);
	});

	it("preserves duplicate kind attributes, word-boundary roots, and incomplete attribute values", () => {
		const xml = `<observation kind="change" kind="bugfix"><title>Last kind</title></observation>
			<observation-x kind="decision"><title>Dash suffix</title></observation>
			<observation kind="discovery>unfinished"<title>Malformed attribute</title></observation>`;
		expect(parseObserverResponse(xml).observations.map(({ kind }) => kind)).toEqual([
			"bugfix",
			"decision",
			"discovery>unfinished",
		]);
	});

	it("recovers incomplete child lists without accepting rewritten content", () => {
		const initial =
			"<observation><type>discovery</type><title>Parser lesson</title><facts><fact>First fact</fact><fact>Second";
		const repaired =
			"<observation><type>discovery</type><title>Parser lesson</title><facts><fact>First fact</fact><fact>Second fact</fact></facts></observation>";
		expect(
			shouldPreferRepairedObserverResponse(
				parseObserverResponse(initial),
				repaired,
				parseObserverResponse(repaired),
				initial,
			),
		).toBe(true);
		const rewritten = repaired.replace("First fact", "Invented fact");
		expect(
			shouldPreferRepairedObserverResponse(
				parseObserverResponse(initial),
				rewritten,
				parseObserverResponse(rewritten),
				initial,
			),
		).toBe(false);
	});

	it.each([
		[' attr="a>b">tail', 11],
		[" attr='a>b'>tail", 11],
		[' attr="a>b tail', 8],
		[' attr="unterminated', -1],
	])("retains quote-aware delimiter recovery for %s", (raw, end) => {
		expect(openingTagEnds(raw, [0]).get(0)).toBe(end);
	});
});
