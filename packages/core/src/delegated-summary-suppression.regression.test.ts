import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DELEGATED_BRIEF_LABEL, type DelegatedBriefContext } from "./capture-context.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import type { SessionContext } from "./ingest-types.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";

const BRIEF = "Search maintenance behavior and summarize the result.";
const SUMMARY =
	`<summary><request>Review delegated search results</request><investigated>Checked the result set</investigated>` +
	`<learned>The search found the maintenance path</learned><completed>Reported the findings</completed>` +
	`<next_steps></next_steps><notes></notes></summary>`;
const MISMATCH_CASES: Array<{ name: string; overrides: Partial<SessionContext> }> = [
	{ name: "stream identity", overrides: { streamId: "sibling" } },
	{
		name: "extractor version",
		overrides: {
			flushBatch: {
				batch_id: 99,
				start_event_seq: 1,
				end_event_seq: 2,
				extractor_version: "raw_events_v2",
			},
		},
	},
];
let directory: string;
let store: MemoryStore;

interface TestMetadata {
	post: { session_class: string; summary_disposition: string };
	session_context: {
		delegatedBriefs?: string[];
		firstPrompt?: string;
		promptCount?: number;
		durationMs?: number;
		flushBatch: Record<string, unknown>;
	};
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-delegated-summary-"));
	store = new MemoryStore(join(directory, "test.sqlite"));
});

afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

function delegatedContext(): DelegatedBriefContext {
	return {
		version: 1,
		host: "opencode-v1",
		origin: "delegated_brief",
		parent_session_id: "parent",
		child_session_id: "child",
		task_call_id: "task",
		message_id: "message",
		requested_agent: "explore",
		current_agent: "explore",
		brief_sha256: createHash("sha256").update(BRIEF).digest("hex"),
	};
}

function resultEvents(): Record<string, unknown>[] {
	return [
		{
			type: "tool.execute.after",
			tool: "codemem_memory_search",
			args: { query: "maintenance job" },
			result: "Found the maintenance path.",
		},
		{ type: "assistant_message", assistant_text: "Delegated search complete." },
	];
}

function delegatedBriefEvent(): Record<string, unknown> {
	return {
		type: "user_prompt",
		prompt_text: BRIEF,
		capture_context: delegatedContext(),
	};
}

function optionsFor(observe: ReturnType<typeof vi.fn>): IngestOptions {
	return {
		observer: {
			observe,
			getStatus: () => ({
				provider: "test",
				model: "fixture",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		},
	} as unknown as IngestOptions;
}

function observerFixture() {
	const observe = vi.fn(async () => ({
		raw: SUMMARY,
		parsed: null,
		provider: "test",
		model: "fixture",
	}));
	return { observe, options: optionsFor(observe) };
}

function recordBrief(brief = BRIEF): void {
	store.recordRawEvent({
		opencodeSessionId: "child",
		eventId: "delegated-brief",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: brief },
		captureContext: {
			...delegatedContext(),
			brief_sha256: createHash("sha256").update(brief).digest("hex"),
		},
		tsWallMs: 100,
	});
}

function recordResults(prefix: string, startMs: number): void {
	for (const [index, payload] of resultEvents().entries()) {
		store.recordRawEvent({
			opencodeSessionId: "child",
			eventId: `${prefix}-${index}`,
			eventType: String(payload.type),
			payload,
			tsWallMs: startMs + index * 10_000,
		});
	}
}

function latestMetadata(): TestMetadata {
	const row = store.db
		.prepare("SELECT metadata_json FROM sessions ORDER BY id DESC LIMIT 1")
		.get() as { metadata_json: string };
	return JSON.parse(row.metadata_json) as TestMetadata;
}

function directSessionContext(overrides: Partial<SessionContext> = {}): SessionContext {
	return {
		flusher: "raw_events",
		source: "opencode",
		streamId: "child",
		opencodeSessionId: "child",
		promptCount: 0,
		toolCount: 1,
		durationMs: 10_000,
		flushBatch: {
			batch_id: 99,
			start_event_seq: 1,
			end_event_seq: 2,
			extractor_version: "raw_events_v1",
		},
		...overrides,
	};
}

it("delivers a prompt-only delegated-shaped event without session context", async () => {
	const { observe, options } = observerFixture();

	await ingest(
		{
			cwd: "/fixture",
			project: "fixture",
			events: [delegatedBriefEvent()],
		},
		store,
		options,
	);

	expect(observe).toHaveBeenCalledTimes(1);
	const observerInput = observe.mock.calls[0]?.[1] ?? "";
	expect(observerInput).toContain(`<user_request>${BRIEF}</user_request>`);
	expect(observerInput).toContain(`${DELEGATED_BRIEF_LABEL}: ${BRIEF}`);
});

it("retains a delegated-shaped prompt in a mixed non-raw payload", async () => {
	const { observe, options } = observerFixture();

	await ingest(
		{
			cwd: "/fixture",
			project: "fixture",
			events: [delegatedBriefEvent(), ...resultEvents()],
		},
		store,
		options,
	);

	const observerInput = observe.mock.calls[0]?.[1] ?? "";
	expect(observerInput).toContain(`<user_request>${BRIEF}</user_request>`);
	expect(observerInput).toContain(`${DELEGATED_BRIEF_LABEL}: ${BRIEF}`);
	expect(observerInput).toContain("Assistant: Delegated search complete.");
});

it("does not let a caller-authored brief event strengthen a weak batch", async () => {
	const { observe, options } = observerFixture();

	await ingest(
		{
			cwd: "/fixture",
			project: "fixture",
			events: [delegatedBriefEvent(), ...resultEvents()],
			sessionContext: {
				source: "claude",
				flusher: "plugin",
				firstPrompt: "ok",
				promptCount: 1,
				toolCount: 1,
				durationMs: 10_000,
			},
		},
		store,
		options,
	);

	const metadata = latestMetadata();
	expect(metadata.post.session_class).toBe("micro_low_value");
	expect(metadata.post.summary_disposition).toBe("suppressed");
	expect(observe.mock.calls[0]?.[1] ?? "").toContain(`${DELEGATED_BRIEF_LABEL}: ${BRIEF}`);
});

it("classifies the batch after an adjacent completed delegated brief", async () => {
	const { observe, options } = observerFixture();
	recordBrief();
	await flushRawEvents(store, options, {
		opencodeSessionId: "child",
		throughEventSeq: 0,
	});
	recordResults("adjacent-result", 10_000);

	await flushRawEvents(store, options, { opencodeSessionId: "child" });

	const metadata = latestMetadata();
	const observerInput = observe.mock.calls[0]?.[1] ?? "";
	expect(metadata.post.session_class).toBe("micro_high_signal");
	expect(metadata.post.summary_disposition).toBe("stored");
	expect(observerInput).toContain(BRIEF);
});

it("keeps a weak summary when an adjacent validated brief has no observer-visible text", async () => {
	const { observe, options } = observerFixture();
	const privateBrief = "<private>Search maintenance behavior.</private>";
	recordBrief(privateBrief);
	await flushRawEvents(store, options, {
		opencodeSessionId: "child",
		throughEventSeq: 0,
	});
	recordResults("private-adjacent-result", 10_000);

	await flushRawEvents(store, options, { opencodeSessionId: "child" });

	const metadata = latestMetadata();
	const observerInput = observe.mock.calls[0]?.[1] ?? "";
	expect({
		sessionClass: metadata.post.session_class,
		summaryDisposition: metadata.post.summary_disposition,
		privateBriefVisible: observerInput.includes("Search maintenance behavior."),
	}).toEqual({
		sessionClass: "micro_high_signal",
		summaryDisposition: "stored",
		privateBriefVisible: false,
	});
});

it("carries delegated classification across an intervening bookkeeping batch", async () => {
	const { observe, options } = observerFixture();
	recordBrief();
	await flushRawEvents(store, options, {
		opencodeSessionId: "child",
		throughEventSeq: 0,
	});
	store.recordRawEvent({
		opencodeSessionId: "child",
		eventId: "intervening-idle",
		eventType: "session.idle",
		payload: { type: "session.idle" },
		tsWallMs: 1_000,
	});
	await flushRawEvents(store, options, { opencodeSessionId: "child" });
	recordResults("bookkeeping-separated-result", 10_000);

	await flushRawEvents(store, options, { opencodeSessionId: "child" });

	const metadata = latestMetadata();
	expect(metadata.post.session_class).toBe("micro_high_signal");
	expect(metadata.post.summary_disposition).toBe("stored");
	expect(observe.mock.calls[0]?.[1] ?? "").toContain(BRIEF);
});

it("expires delegated classification after the adjacent result batch", async () => {
	const { observe, options } = observerFixture();
	recordBrief();
	await flushRawEvents(store, options, {
		opencodeSessionId: "child",
		throughEventSeq: 0,
	});
	recordResults("adjacent-result", 10_000);
	await flushRawEvents(store, options, { opencodeSessionId: "child" });
	recordResults("later-result", 30_000);

	await flushRawEvents(store, options, { opencodeSessionId: "child" });

	const metadata = latestMetadata();
	expect(observe).toHaveBeenCalledTimes(2);
	expect(metadata.post.session_class).toBe("micro_low_value");
	expect(metadata.post.summary_disposition).toBe("suppressed");
	expect(observe.mock.calls[1]?.[1] ?? "").not.toContain(BRIEF);
});

it("keeps caller-supplied delegated briefs observer-only", async () => {
	const { observe, options } = observerFixture();

	await ingest(
		{
			cwd: "/fixture",
			project: "fixture",
			events: resultEvents(),
			sessionContext: directSessionContext({ delegatedBriefs: [BRIEF] }),
		},
		store,
		options,
	);

	const metadata = latestMetadata();
	expect(metadata.post.session_class).toBe("micro_low_value");
	expect(metadata.post.summary_disposition).toBe("suppressed");
	expect(observe.mock.calls[0]?.[1] ?? "").toContain(BRIEF);
});

it.each(MISMATCH_CASES)("rejects mismatched $name", async ({ overrides }) => {
	const { observe, options } = observerFixture();
	recordBrief();
	await flushRawEvents(store, options, {
		opencodeSessionId: "child",
		throughEventSeq: 0,
	});

	await ingest(
		{
			cwd: "/fixture",
			project: "fixture",
			events: resultEvents(),
			sessionContext: directSessionContext(overrides),
		},
		store,
		options,
	);

	const metadata = latestMetadata();
	expect(metadata.post.session_class).toBe("micro_low_value");
	expect(observe.mock.calls[0]?.[1] ?? "").not.toContain(BRIEF);
});

it("keeps delegated instructions outside stored metadata and evidence", async () => {
	const { observe, options } = observerFixture();
	recordBrief();
	await flushRawEvents(store, options, {
		opencodeSessionId: "child",
		throughEventSeq: 0,
	});
	recordResults("adjacent-result", 10_000);

	await flushRawEvents(store, options, { opencodeSessionId: "child" });

	const metadata = latestMetadata();
	const observerInput = observe.mock.calls[0]?.[1] ?? "";
	expect(metadata.session_context).not.toHaveProperty("delegatedBriefs");
	expect(metadata.session_context.firstPrompt).toBeUndefined();
	expect(metadata.session_context.promptCount).toBe(0);
	expect(metadata.session_context.durationMs).toBe(10_000);
	expect(observerInput).toContain(DELEGATED_BRIEF_LABEL);
	expect(observerInput).not.toContain(`User: ${BRIEF}`);
});
