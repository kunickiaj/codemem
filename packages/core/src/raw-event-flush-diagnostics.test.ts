import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IngestOptions } from "./ingest-pipeline.js";
import * as ingestPipeline from "./ingest-pipeline.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";

let store: MemoryStore;

beforeEach(() => {
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS", "1");
	store = new MemoryStore(":memory:");
});

afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function seedProcessableEvents() {
	store.recordRawEvent({
		opencodeSessionId: "synthetic-session",
		eventId: "tool-1",
		eventType: "tool.execute.after",
		payload: { type: "tool.execute.after", tool: "read", args: { filePath: "example.ts" } },
		tsWallMs: 100,
	});
}

it.each([
	[
		"synthetic-sensitive-content",
		"unstorable_observer_output",
		"Test output produced no storable content after validation and filtering.",
	],
	[null, "empty_observer_output", "Test returned no usable output for raw-event processing."],
])("reports output disposition without exposing response %s", async (raw, reason, message) => {
	// Arrange: a supported tool event reaches a synthetic observer.
	seedProcessableEvents();
	const observe = vi
		.fn()
		.mockResolvedValue({ raw, parsed: null, provider: "test", model: "test-model" });
	const options = {
		observer: {
			observe,
			getStatus: () => ({ provider: "test", model: "test-model", runtime: "test" }),
		},
	} as unknown as IngestOptions;

	// Act: leave the unsuccessful extraction retryable.
	await expect(
		flushRawEvents(store, options, { opencodeSessionId: "synthetic-session", source: "opencode" }),
	).rejects.toThrow();
	const batch = store.db
		.prepare("SELECT status, error_type, error_message FROM raw_event_flush_batches")
		.get();

	// Assert: no output is accepted and only the fixed stage description is stored.
	expect(observe).toHaveBeenCalled();
	expect(batch).toEqual({
		status: "failed",
		error_type: `RawEventObserverOutputError:${reason}`,
		error_message: message,
	});
	expect(store.rawEventFlushState("synthetic-session", "opencode")).toBe(-1);
	expect(store.recent(10)).toHaveLength(0);
});

it("does not attribute an unknown failure reason to provider output", async () => {
	// Arrange: emulate an unrecognized reason from a future pipeline version.
	seedProcessableEvents();
	const options = {
		observer: { getStatus: () => ({ provider: "test", model: "test-model", runtime: "test" }) },
	} as unknown as IngestOptions;
	const error = new ingestPipeline.RawEventObserverOutputError(
		"synthetic-sensitive-content",
		"synthetic_unknown_reason" as ingestPipeline.RawEventObserverOutputFailureReason,
		options.observer,
	);
	vi.spyOn(ingestPipeline, "ingest").mockRejectedValueOnce(error);

	// Act: persist a sanitized failure without assuming inference occurred.
	await expect(
		flushRawEvents(store, options, { opencodeSessionId: "synthetic-session", source: "opencode" }),
	).rejects.toBe(error);
	const batch = store.db.prepare("SELECT status, error_message FROM raw_event_flush_batches").get();

	// Assert: unknown stages stay visible and preserve the cursor.
	expect(batch).toEqual({
		status: "failed",
		error_message: "Raw-event processing failed for an unspecified reason.",
	});
	expect(store.rawEventFlushState("synthetic-session", "opencode")).toBe(-1);
});

it.each([
	{ count: 3, adapter: false },
	{ count: 8, adapter: false },
	{ count: 100, adapter: false },
	{ count: 3, adapter: true },
])(
	"completes $count diagnosed trivial prompts (adapter=$adapter) at exhaustion without inference",
	async ({ count, adapter }) => {
		// Arrange: repeated acknowledgements contain no tool or assistant result to extract.
		const sessionId = "ses_no_input_stage";
		for (let index = 0; index < count; index += 1) {
			store.recordRawEvent({
				opencodeSessionId: sessionId,
				eventId: `prompt-${index}`,
				eventType: "user_prompt",
				payload: {
					type: "user_prompt",
					prompt_text: "ok",
					...(adapter
						? {
								_adapter: {
									schema_version: "1.0",
									source: "opencode",
									session_id: sessionId,
									event_id: `prompt-${index}`,
									event_type: "prompt",
									ts: "2026-01-01T00:00:00.000Z",
									payload: { text: "ok" },
								},
							}
						: {}),
				},
				tsWallMs: 100 + index,
			});
		}
		const observe = vi.fn();
		const options = {
			observer: {
				observe,
				getStatus: () => ({ provider: "test", model: "test-model", runtime: "test" }),
			},
		} as unknown as IngestOptions;
		const flushOptions = { opencodeSessionId: sessionId, source: "opencode" };

		// Act: retain the normal retry boundary, then finalize the proven trivial range.
		await expect(flushRawEvents(store, options, flushOptions)).rejects.toThrow();
		const beforeFinalization = store.rawEventFlushState(sessionId, "opencode");
		await flushRawEvents(store, options, flushOptions);
		const batch = store.db
			.prepare(
				"SELECT status, attempt_count, error_type, error_message FROM raw_event_flush_batches WHERE opencode_session_id = ?",
			)
			.get(sessionId);

		// Assert: raw input remains available and no extraction or memory writes occurred.
		expect(observe).not.toHaveBeenCalled();
		expect(beforeFinalization).toBe(-1);
		expect(store.rawEventFlushState(sessionId, "opencode")).toBe(count - 1);
		expect(batch).toEqual({
			status: "completed",
			attempt_count: 1,
			error_type: null,
			error_message: null,
		});
		expect(
			store.db
				.prepare("SELECT COUNT(*) AS count FROM raw_events WHERE opencode_session_id = ?")
				.get(sessionId),
		).toEqual({ count });
		expect(store.recent(10)).toHaveLength(0);
	},
);

it.each([
	{
		type: "tool.execute.after",
		tool: "shell",
		args: { command: "printf 'synthetic result'" },
		result: "synthetic result",
	},
	{ type: "assistant_message", assistant_text: "A synthetic durable finding requires review." },
	{ type: "user_prompt", prompt_text: "Remember that deployment requires a reviewed migration." },
	{ type: "unknown_event", result: "unrecognized input must remain retained" },
	{ type: "user_prompt", prompt_text: "ok", _adapter: { schema_version: "unsupported" } },
])("does not dismiss a larger failed range containing $type", async (event) => {
	const sessionId = "ses_nontrivial_failure";
	for (const [index, payload] of [
		{ type: "user_prompt", prompt_text: "ok" },
		{ type: "user_prompt", prompt_text: "ok" },
		event,
	].entries()) {
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: `event-${index}`,
			eventType: payload.type,
			payload,
			tsWallMs: 100 + index,
		});
	}
	const observe = vi.fn();
	const options = {
		observer: {
			observe,
			getStatus: () => ({ provider: "test", model: "test-model", runtime: "test" }),
		},
	} as unknown as IngestOptions;
	const error = new ingestPipeline.RawEventObserverOutputError(
		"synthetic pre-inference failure",
		"no_processable_input",
		options.observer,
		{ includeObserverError: false },
	);
	vi.spyOn(ingestPipeline, "ingest").mockRejectedValueOnce(error);
	const flushOptions = { opencodeSessionId: sessionId, source: "opencode" };
	await expect(flushRawEvents(store, options, flushOptions)).rejects.toBe(error);
	await flushRawEvents(store, options, flushOptions);
	expect(
		store.db
			.prepare(
				"SELECT status,error_type,error_message FROM raw_event_flush_batches WHERE opencode_session_id=?",
			)
			.get(sessionId),
	).toEqual({
		status: "gave_up",
		error_type: "RawEventObserverOutputError:no_processable_input",
		error_message:
			"Raw-event input contained no processable content. Observer inference was not called.",
	});
	expect(observe).not.toHaveBeenCalled();
	expect(
		store.db
			.prepare("SELECT count(*) count FROM raw_events WHERE opencode_session_id=?")
			.get(sessionId),
	).toEqual({ count: 3 });
	expect(store.recent(10)).toHaveLength(0);
});
