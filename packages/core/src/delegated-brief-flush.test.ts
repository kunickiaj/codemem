import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DELEGATED_BRIEF_LABEL,
	isDelegatedBrief,
	isDelegatedBriefOnlyBatch,
} from "./capture-context.js";
import { connect, ensureAdditiveSchemaCompatibility } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { MemoryStore } from "./store.js";

const brief =
	"Investigate whether the cache invalidation path loses retries; report actual findings.";
const getStatus = () => ({
	provider: "test",
	model: "test",
	runtime: "test",
	auth: { source: "none", type: "none", hasToken: false },
});
const context = {
	version: 1,
	host: "opencode-v1",
	origin: "delegated_brief",
	parent_session_id: "parent",
	child_session_id: "child",
	task_call_id: "call-1",
	message_id: "msg-1",
	requested_agent: "explore",
	current_agent: "explore",
	brief_sha256: createHash("sha256").update(brief).digest("hex"),
};
const envelope = {
	source: "opencode",
	session_stream_id: "child",
	event_id: "brief-1",
	event_type: "user_prompt",
	ts_wall_ms: 100,
	ts_mono_ms: 5,
	payload: {
		type: "user_prompt",
		prompt_text: brief,
		_adapter: {
			schema_version: "1.0",
			source: "opencode",
			session_id: "child",
			event_type: "prompt",
			payload: { text: brief },
		},
	},
	capture_context: context,
};

let directory: string;
let dbPath: string;
let store: MemoryStore;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-brief-"));
	dbPath = join(directory, "test.sqlite");
	store = new MemoryStore(dbPath);
});
afterEach(() => {
	if (store.db.open) store.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("delegated brief raw-event contract", () => {
	it("adds a nullable column during compatibility migration without changing IDs or payloads", () => {
		// Arrange
		ingestRawEvents(store, envelope);
		store.db.exec("DROP INDEX idx_raw_events_capture_context");
		store.db.exec("ALTER TABLE raw_events DROP COLUMN capture_context_json");
		const before = store.db.prepare("SELECT * FROM raw_events").all();
		store.close();
		const db = connect(dbPath);

		// Act
		const after = (() => {
			try {
				ensureAdditiveSchemaCompatibility(db);
				return db.prepare("SELECT * FROM raw_events").all() as Record<string, unknown>[];
			} finally {
				if (db.open) db.close();
			}
		})();

		// Assert
		expect(after).toEqual(
			before.map((row) => ({ ...(row as object), capture_context_json: null })),
		);
		store = new MemoryStore(dbPath);
		expect(store.rawEventsSinceBySeq("child")[0]).not.toHaveProperty("capture_context");
	});

	it("freezes first accepted provenance on duplicates, including unknown-first retries", () => {
		ingestRawEvents(store, envelope);
		const before = store.db.prepare("SELECT * FROM raw_events").all();
		expect(
			ingestRawEvents(store, {
				...envelope,
				capture_context: { ...context, message_id: "different" },
			}).skipped,
		).toBe(1);
		expect(store.db.prepare("SELECT * FROM raw_events").all()).toEqual(before);
		ingestRawEvents(store, { ...envelope, event_id: "unknown-first", capture_context: null });
		ingestRawEvents(store, { ...envelope, event_id: "unknown-first" });
		expect(store.rawEventsSinceBySeq("child")[1]).not.toHaveProperty("capture_context");
	});

	it("keeps generated IDs identical with and without optional context", () => {
		const { event_id: _id, ...withoutId } = envelope;
		ingestRawEvents(store, { ...withoutId, capture_context: null });
		const before = store.db
			.prepare("SELECT event_id, event_seq, payload_json FROM raw_events")
			.all();
		expect(ingestRawEvents(store, withoutId).skipped).toBe(1);
		expect(
			store.db.prepare("SELECT event_id, event_seq, payload_json FROM raw_events").all(),
		).toEqual(before);
	});

	it.each([
		{ ...context, requested_agent: "review" },
		{ ...context, child_session_id: "sibling" },
		{ ...context, brief_sha256: "incorrect" },
		{ origin: "delegated_brief" },
		{ version: 1, origin: "human" },
		"invalid",
	])("retains valid raw data with invalid optional context %#", (captureContext) => {
		expect(ingestRawEvents(store, { ...envelope, capture_context: captureContext }).inserted).toBe(
			1,
		);
		expect(store.rawEventsSinceBySeq("child")[0]).not.toHaveProperty("capture_context");
		expect(store.db.prepare("SELECT payload_json FROM raw_events").get()).toEqual({
			payload_json: JSON.stringify(envelope.payload),
		});
	});

	it("ignores forged similarly named provenance fields on direct ingress", () => {
		// Arrange
		const forged = {
			...envelope,
			event_id: "forged-fields",
			capture_context: undefined,
			captureContext: context,
			capture_context_json: JSON.stringify(context),
		};

		// Act
		ingestRawEvents(store, forged);

		// Assert
		const row = store.db
			.prepare("SELECT event_id, event_seq, payload_json, capture_context_json FROM raw_events")
			.get();
		expect(row).toEqual({
			event_id: "forged-fields",
			event_seq: 0,
			payload_json: JSON.stringify(envelope.payload),
			capture_context_json: null,
		});
	});
});

describe("delegated brief classification", () => {
	it("recognizes only the complete validated provenance shape", () => {
		// Arrange
		const validated = { type: "user_prompt", prompt_text: brief, capture_context: context };
		const callerClaim = {
			type: "user_prompt",
			prompt_text: brief,
			capture_context: { origin: "delegated_brief" },
		};

		// Act
		const classification = {
			validatedEvent: isDelegatedBrief(validated),
			validatedBatch: isDelegatedBriefOnlyBatch([validated]),
			callerEvent: isDelegatedBrief(callerClaim),
			callerBatch: isDelegatedBriefOnlyBatch([callerClaim]),
		};

		// Assert
		expect(classification).toEqual({
			validatedEvent: true,
			validatedBatch: true,
			callerEvent: false,
			callerBatch: false,
		});
	});
});

describe("delegated brief extraction", () => {
	it("completes brief-only batches without observer, memories, or retry loops", async () => {
		const observe = vi.fn();
		ingestRawEvents(store, envelope);
		store.recordRawEvent({
			opencodeSessionId: "child",
			eventId: "idle",
			eventType: "session.idle",
			payload: {},
		});
		const options = { observer: { observe } } as unknown as IngestOptions;
		expect(await flushRawEvents(store, options, { opencodeSessionId: "child" })).toEqual({
			flushed: 2,
			updatedState: 1,
		});
		expect(await flushRawEvents(store, options, { opencodeSessionId: "child" })).toEqual({
			flushed: 0,
			updatedState: 0,
		});
		expect(observe).not.toHaveBeenCalled();
		expect(store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get()).toEqual({
			count: 0,
		});
		expect(store.rawEventsSinceBySeq("child")).toHaveLength(2);
		expect(
			store.db.prepare("SELECT status, attempt_count FROM raw_event_flush_batches").get(),
		).toEqual({ status: "completed", attempt_count: 1 });
	});

	it("recovers earlier same-stream instructions after restart for actual findings", async () => {
		ingestRawEvents(store, envelope);
		await flushRawEvents(store, { observer: { observe: vi.fn() } } as unknown as IngestOptions, {
			opencodeSessionId: "child",
		});
		ingestRawEvents(store, { ...envelope, source: "claude", event_id: "other-host" });
		store.close();
		store = new MemoryStore(dbPath);
		store.recordRawEvent({
			opencodeSessionId: "child",
			eventId: "ordinary-user-prompt",
			eventType: "user_prompt",
			payload: {
				type: "user_prompt",
				prompt_text: "Check the queue implementation and report the observed behavior.",
			},
		});
		store.recordRawEvent({
			opencodeSessionId: "child",
			eventId: "finding",
			eventType: "tool.execute.after",
			payload: {
				type: "tool.execute.after",
				tool: "read",
				args: { filePath: "src/cache.ts" },
				result: "Retry entries survive invalidation in the pending queue.",
			},
		});
		const observe = vi.fn(async (_system: string, _user: string) => ({
			raw: `<observation><type>discovery</type><title>Retry entries survive cache invalidation</title><narrative>The pending queue retains retry entries independently of cache invalidation.</narrative><facts><fact>Invalidation leaves the pending queue intact.</fact></facts><concepts><concept>how-it-works</concept></concepts></observation>`,
			parsed: null,
			provider: "test",
			model: "test",
		}));
		await flushRawEvents(store, { observer: { observe, getStatus } } as unknown as IngestOptions, {
			opencodeSessionId: "child",
		});
		expect(observe).toHaveBeenCalledTimes(1);
		const observerInput = observe.mock.calls[0]?.[1];
		expect(observerInput).toContain(brief);
		expect(observerInput).toContain(DELEGATED_BRIEF_LABEL);
		expect(observerInput).toContain(
			"User: Check the queue implementation and report the observed behavior.",
		);
		expect(observerInput).not.toContain(
			`${DELEGATED_BRIEF_LABEL}: Check the queue implementation and report the observed behavior.`,
		);
		expect(store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get()).toEqual({
			count: 1,
		});
		expect(store.priorDelegatedBriefEvents("sibling", "opencode", 999)).toEqual([]);
		expect(store.priorDelegatedBriefEvents("child", "claude", 999)).toEqual([]);
	});

	it.each([null, { ...context, brief_sha256: "bad" }])(
		"preserves normal extraction for unknown origin %#",
		async (captureContext) => {
			ingestRawEvents(store, { ...envelope, capture_context: captureContext });
			const observe = vi.fn(async () => {
				throw new Error("observer reached");
			});
			await expect(
				flushRawEvents(store, { observer: { observe, getStatus } } as unknown as IngestOptions, {
					opencodeSessionId: "child",
				}),
			).rejects.toThrow("observer reached");
			expect(observe).toHaveBeenCalledTimes(1);
		},
	);
});

describe("mixed delegated batches", () => {
	it.each([
		{ type: "user_prompt", prompt_text: "Use a separate pending queue for retry ownership." },
		{ type: "assistant_message", assistant_text: "The pending queue owns retry entries." },
		{ type: "tool.execute.after", tool: "read", args: {}, result: "pending queue implementation" },
		{ type: "assistant_usage", usage: { input_tokens: 12 } },
		{ type: "session.idle", synthetic: true, result: "injected task result" },
		{ type: "session.idle", parts: [{ type: "text", text: "synthetic result", synthetic: true }] },
		{ type: "session.idle", future_result: { text: "unknown result shape" } },
	])("keeps substantive or synthetic $type batches on the observer path", async (payload) => {
		ingestRawEvents(store, envelope);
		store.recordRawEvent({
			opencodeSessionId: "child",
			eventId: "substantive",
			eventType: payload.type,
			payload,
		});
		const observe = vi.fn(async (_system: string, user: string) => {
			expect(user).toContain(DELEGATED_BRIEF_LABEL);
			throw new Error("observer reached");
		});
		await expect(
			flushRawEvents(store, { observer: { observe, getStatus } } as unknown as IngestOptions, {
				opencodeSessionId: "child",
			}),
		).rejects.toThrow("observer reached");
		expect(observe).toHaveBeenCalledTimes(1);
	});
});
