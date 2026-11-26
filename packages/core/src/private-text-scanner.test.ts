import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { ingestRawEvents, validateRawEvents } from "./raw-event-ingest.js";
import { MemoryStore } from "./store.js";

/*
 * Contract: a private block protects text inside the single text value where it is
 * written. It never spans values, messages or events.
 */

const S = "SYNTHETIC_PRIVATE";
const { vectors } = JSON.parse(
	readFileSync(new URL("./private-text-vectors.json", import.meta.url), "utf8"),
) as { vectors: Array<{ name: string; input: string; expected: string }> };

describe("private text lexer", () => {
	it.each(vectors)("handles $name", ({ input, expected }) => {
		expect(stripPrivate(input)).toBe(expected);
	});

	it("scans each string of an object on its own and keeps other values", () => {
		expect(
			stripPrivateObj({
				a: `x <private>${S}`,
				b: "kept",
				list: [`<private>${S}`, "kept too", 3],
				n: 7,
				flag: false,
			}),
		).toEqual({ a: "x ", b: "kept", list: ["", "kept too", 3], n: 7, flag: false });
	});

	it("drops an entry whose key carries a marker", () => {
		expect(stripPrivateObj({ [`<private>${S}</private>`]: "value", kept: "yes" })).toEqual({
			kept: "yes",
		});
	});
});

describe("a private block within one message", () => {
	it("never spans messages", () => {
		const events = [
			{ type: "user_prompt", prompt_text: `ask <private>${S}` },
			{ type: "assistant_message", assistant_text: "after</private> answer" },
		];

		// The opener protects the rest of its own message; the next message's stray
		// closer is removed and its text stays.
		expect(buildTranscript(events)).not.toContain(S);
		expect(extractPrompts(events).map((prompt) => prompt.promptText)).toEqual(["ask"]);
		expect(extractAssistantMessages(events)).toEqual(["after answer"]);
	});
});

describe("tool events", () => {
	it("scans the tool name before it is normalized", () => {
		const event = eventToToolEvent(
			{ type: "tool.execute.after", tool: `<private>prefix:${S}`, args: {}, result: "ok" },
			12_000,
		);

		expect(JSON.stringify(event)).not.toMatch(new RegExp(S, "i"));
	});

	it("takes the working-directory fallback from the cleaned arguments", () => {
		const event = eventToToolEvent(
			{
				type: "tool.execute.after",
				tool: "bash",
				args: { cwd: `/work/<private>${S}` },
				result: "ok",
			},
			12_000,
		);

		expect(event?.cwd).toBe("/work/");
	});

	it("scans each field on its own", () => {
		const event = eventToToolEvent(
			{
				type: "tool.execute.after",
				tool: "bash",
				args: { command: `echo <private>${S}` },
				result: "after</private> done",
			},
			12_000,
		);

		expect(JSON.stringify(event?.toolInput)).not.toContain(S);
		expect(event?.toolOutput).toBe("after done");
	});
});

describe("private text in rendered prompt fields", () => {
	const hidden = (label: string) => `${label} <private note="a > b">${S} ${label}</private> end`;
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
				toolError: hidden("ERROR"),
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
			expect(user).toContain("REQUEST  end");
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

describe("durable writes", () => {
	let directory: string;
	let store: MemoryStore;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-private-writes-"));
		store = new MemoryStore(join(directory, "test.sqlite"));
	});
	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});

	const storedJson = (sql: string) => JSON.stringify(store.db.prepare(sql).all());

	it("stores raw events and their session metadata without private text", () => {
		ingestRawEvents(store, {
			cwd: `/work/<private>${S}</private>repo`,
			project: `demo<private>${S}`,
			started_at: `2026-01-01T00:00:00Z<private>${S}</private>`,
			events: [
				{
					session_stream_id: "writes",
					event_id: "nested",
					event_type: "user_prompt",
					payload: {
						type: "user_prompt",
						prompt_text: `a <private reason="r">${S}<private>x</private>${S}2</private> b`,
					},
				},
			],
		});

		expect(store.rawEventsSinceBySeq("writes")[0]?.prompt_text).toBe("a  b");
		expect(storedJson("SELECT * FROM raw_events")).not.toContain(S);
		expect(storedJson("SELECT * FROM raw_event_sessions")).not.toContain(S);
		expect(store.rawEventSessionMeta("writes")).toMatchObject({ cwd: "/work/repo" });
	});

	it("does not store capture provenance that carries private text", () => {
		const text = "Inspect the queue";
		ingestRawEvents(store, {
			source: "opencode",
			session_stream_id: "child",
			event_id: "brief",
			event_type: "user_prompt",
			payload: { type: "user_prompt", prompt_text: text },
			capture_context: {
				version: 1,
				host: "opencode-v1",
				origin: "delegated_brief",
				parent_session_id: "parent",
				child_session_id: "child",
				task_call_id: "task",
				message_id: `message<private>${S}</private>`,
				requested_agent: "explore",
				current_agent: "explore",
				brief_sha256: createHash("sha256").update(text).digest("hex"),
			},
		});

		expect(storedJson("SELECT * FROM raw_events")).not.toContain(S);
	});

	it("cleans each event of a multi-event request on its own", () => {
		const request = {
			session_stream_id: "multi",
			events: [
				{
					event_id: "first",
					event_type: "user_prompt",
					payload: { type: "user_prompt", prompt_text: `open <private>${S}` },
				},
				{
					event_id: "second",
					event_type: "user_prompt",
					payload: { type: "user_prompt", prompt_text: "second stays" },
				},
			],
		};

		const validated = validateRawEvents(request);
		ingestRawEvents(store, validated.request);

		expect(validated.received).toBe(2);
		expect(JSON.stringify(validated.request)).not.toContain(S);
		expect(store.rawEventsSinceBySeq("multi").map((event) => event.prompt_text)).toEqual([
			"open ",
			"second stays",
		]);
	});

	it("stores session rows from the public ingest entry without private text", async () => {
		const observer = Object.assign(Object.create(ObserverClient.prototype), {
			maxChars: 12_000,
			runtime: "test",
			_callOnce: vi.fn(async () => {
				throw new Error("captured");
			}),
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
				cwd: `${directory}<private>${S}</private>`,
				project: `fixture<private>${S}</private>`,
				startedAt: now,
				events: [{ type: "user_prompt", prompt_text: "Check the queue", timestamp: now }],
				sessionContext: { firstPrompt: `ask <private>${S}`, filesRead: [`a<private>${S}`] },
			},
			store,
			{ observer },
		).catch(() => undefined);

		expect(storedJson("SELECT * FROM sessions")).not.toContain(S);
		expect(storedJson("SELECT cwd, project FROM sessions")).toContain("fixture");
	});
});
