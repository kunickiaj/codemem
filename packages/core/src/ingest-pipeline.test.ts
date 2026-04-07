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
import { stripPrivate } from "./ingest-sanitize.js";
import {
	buildTranscript,
	deriveRequest,
	firstSentence,
	isTrivialRequest,
	normalizeRequestText,
} from "./ingest-transcript.js";
import type { IngestPayload, ParsedSummary, ToolEvent } from "./ingest-types.js";
import { hasMeaningfulObservation, parseObserverResponse } from "./ingest-xml-parser.js";
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
		});

		it("handles skip_summary", () => {
			const xml = '<skip_summary reason="low-signal"/>';
			const result = parseObserverResponse(xml);
			expect(result.observations).toHaveLength(0);
			expect(result.summary).toBeNull();
			expect(result.skipSummaryReason).toBe("low-signal");
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
	});
});

// ---------------------------------------------------------------------------
// ingest() integration (mocked observer)
// ---------------------------------------------------------------------------

describe("ingest() integration", () => {
	let tmpDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-ingest-test-"));
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
				streamId: "test-stream-micro-summary",
				promptCount: 1,
				toolCount: 0,
				durationMs: 20_000,
			},
		});

		await ingest(payload, store, { observer: summaryOnlyObserver } as unknown as IngestOptions);

		expect(store.recent(10)).toHaveLength(0);
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
				"SELECT kind FROM memory_items WHERE json_extract(metadata_json, '$.is_summary') = 1 ORDER BY id DESC LIMIT 1",
			)
			.get() as { kind: string };
		expect(summaryMemory.kind).toBe("session_summary");
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
			.prepare("SELECT ended_at FROM sessions ORDER BY id DESC LIMIT 1")
			.get() as { ended_at: string | null };
		expect(session.ended_at).not.toBeNull();
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
		).rejects.toThrow("observer produced no storable output for raw-event flush");

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
					raw: `<summary><request>Check restart state</request><completed>Confirmed the observer needed an XML retry.</completed></summary>`,
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
		expect(memories[0]?.title).toBe("Check restart state");
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
