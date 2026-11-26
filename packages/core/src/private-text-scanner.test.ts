import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventToToolEvent } from "./ingest-events.js";
import { ingest } from "./ingest-pipeline.js";
import { buildObserverPrompt, buildObserverRepairPrompt } from "./ingest-prompts.js";
import { stripPrivate, stripPrivateObj } from "./ingest-sanitize.js";
import { buildTranscript, extractAssistantMessages, extractPrompts } from "./ingest-transcript.js";
import type { ObserverContext } from "./ingest-types.js";
import { ObserverClient } from "./observer-client.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { MemoryStore } from "./store.js";

/*
 * One private-text scanner for every path: nested and attribute-bearing blocks,
 * any case, unterminated openers, stray closers, and blocks split across pieces.
 */

const S = "SYNTHETIC_PRIVATE";

describe("private text scanner", () => {
	it.each([
		["nested blocks", `a <private>${S}1<private>${S}2</private>${S}3</private> b`, "a  b"],
		["an opener with attributes", `a <private reason="x">${S}</private> b`, "a  b"],
		["mixed case and whitespace", `a < PRIVATE >${S}</ Private > b`, "a  b"],
		["an unterminated opener", `a <private>${S} b`, "a "],
		["an opener without its >", `a <private reason="x ${S}`, "a "],
		["a stray closer", `${S}</private> b`, " b"],
	])("removes %s", (_case, text, expected) => {
		expect(stripPrivate(text)).toBe(expected);
	});

	it.each([
		"plain text with no markers",
		"escaped &lt;private&gt;markers&lt;/private&gt; stay text",
		"a self-closing <private/> or <private /> tag is text",
		"<privately> and <private_note> are other tags",
		"",
	])("leaves %j byte for byte unchanged", (text) => {
		expect(stripPrivate(text)).toBe(text);
		expect(stripPrivateObj({ key: text, list: [text] })).toEqual({ key: text, list: [text] });
	});

	it("drops an object entry whose key carries a private block", () => {
		expect(stripPrivateObj({ [`<private>${S}</private>`]: "value", kept: "yes" })).toEqual({
			kept: "yes",
		});
	});
});

describe("a private block split across pieces", () => {
	const events = [
		{ type: "user_prompt", prompt_text: `ask <private>${S}1` },
		{ type: "assistant_message", assistant_text: `${S}2</private> answer` },
		{ type: "user_prompt", prompt_text: "next" },
	];

	it("stays private across consecutive messages", () => {
		const transcript = buildTranscript(events);

		expect(transcript).toContain("ask");
		expect(transcript).toContain("answer");
		expect(transcript).toContain("next");
		expect(transcript).not.toContain(S);
		expect(extractAssistantMessages(events)).toEqual(["answer"]);
		expect(extractPrompts(events).map((prompt) => prompt.promptText)).toEqual(["ask", "next"]);
	});

	it("stays private across the fields of one tool event", () => {
		const event = eventToToolEvent(
			{
				type: "tool.execute.after",
				tool: "bash",
				args: { command: `echo <private>${S}1` },
				result: `${S}2</private> done`,
			},
			12_000,
		);

		expect(JSON.stringify(event)).not.toContain(S);
		expect(event?.toolOutput).toContain("done");
	});
});

describe("private text in rendered prompt fields", () => {
	const hidden = (label: string) => `${label} <private note="x">${S} ${label}</private> end`;
	const context = (overrides: Partial<ObserverContext> = {}): ObserverContext => ({
		project: hidden("PROJECT"),
		promptNumber: 1,
		includeSummary: true,
		userPrompt: hidden("REQUEST"),
		transcript: `<private>${S}<private>x</private>${S} nested</private>TRANSCRIPT`,
		diffSummary: hidden("DIFF"),
		recentFiles: hidden("FILES"),
		toolEvents: [
			{
				toolName: hidden("TOOL"),
				toolInput: { [`<private>${S} key</private>`]: "value", path: "a.ts" },
				toolOutput: `out <private>${S}`,
				toolError: `${S} error</private> visible`,
				timestamp: hidden("TIME"),
				cwd: hidden("/work"),
			},
		],
		lastAssistantMessage: hidden("ASSISTANT"),
		delegatedBriefs: [hidden("BRIEF")],
		...overrides,
	});

	for (const [name, includeSummary, outputMode] of [
		["summary XML", true, "legacy_xml"],
		["summary JSON", true, "json_schema"],
		["observations-only XML", false, "legacy_xml"],
		["observations-only JSON", false, "json_schema"],
	] as const) {
		it(`removes every private form from ${name} prompts`, () => {
			const { user } = buildObserverPrompt(context({ includeSummary }), { outputMode });

			expect(user).not.toContain(S);
			expect(user).toContain("REQUEST");
			expect(user).toContain("TRANSCRIPT");
			expect(user).toContain("<working_directory>/work  end</working_directory>");
			expect(user).toContain("<what_happened>TOOL  end</what_happened>");
		});
	}

	it("removes private text quoted in a previous response before the repair call", () => {
		const prompt = buildObserverPrompt(context());

		const repair = buildObserverRepairPrompt(
			prompt.system,
			prompt.user,
			`<summary>kept <private>${S} quoted</private> text</summary>`,
		);

		expect(repair.user).not.toContain(S);
		expect(repair.user).toContain("kept  text");
	});
});

describe("private text on the way in", () => {
	let directory: string;
	let store: MemoryStore;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-private-scanner-"));
		store = new MemoryStore(join(directory, "test.sqlite"));
	});
	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it("never sends a block split across events through the public ingest entry", async () => {
		const sent = vi.fn(async (_system: string, _user: string) => {
			throw new Error("captured");
		});
		const observer = Object.assign(Object.create(ObserverClient.prototype), {
			maxChars: 12_000,
			runtime: "test",
			_callOnce: sent,
			getStatus: () => ({
				provider: "test",
				model: "fixture",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		}) as ObserverClient;
		const now = new Date().toISOString();

		await ingest(
			{
				cwd: directory,
				project: "fixture",
				startedAt: now,
				events: [
					{ type: "user_prompt", prompt_text: `ask <PRIVATE>${S}1`, timestamp: now },
					{ type: "assistant_message", assistant_text: `${S}2</private> answer`, timestamp: now },
				],
			},
			store,
			{ observer },
		).catch(() => undefined);

		const user = sent.mock.calls[0]?.[1] ?? "";
		expect(user).toContain("answer");
		expect(user).not.toContain(S);
	});

	it("stores raw events without nested or attribute-bearing private text", () => {
		ingestRawEvents(store, {
			events: [
				{
					session_stream_id: "scanner",
					event_id: "nested",
					event_type: "user_prompt",
					payload: {
						type: "user_prompt",
						prompt_text: `a <private reason="r">${S}<private>x</private>${S}2</private> b`,
					},
				},
			],
		});

		const stored = store.rawEventsSinceBySeq("scanner")[0];
		expect(JSON.stringify(stored)).not.toContain(S);
		expect(stored?.prompt_text).toBe("a  b");
	});
});
