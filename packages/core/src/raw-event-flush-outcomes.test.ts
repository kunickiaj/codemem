import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

let store: MemoryStore | null = null;
let tmpDir: string | null = null;

afterEach(() => {
	store?.close();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("raw-event flush observer outcomes", () => {
	it("persists the call-local code for missing structured output", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-flush-outcome-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
		const sessionId = "ses_structured_output_missing";
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-1",
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: "Hello" },
			tsWallMs: 100,
		});
		const structuredObserver = {
			provider: "openai",
			runtime: "api_http",
			openaiUseResponses: true,
			hasCustomBaseUrl: false,
			outputMode: "json_schema",
			maxChars: 12_000,
			observeStructuredJson: async () => ({
				raw: null,
				parsed: null,
				provider: "openai",
				model: "test-model",
				usedStructuredOutputs: true,
				failureReason: "structured_output_missing",
				transportFailureCode: null,
				outcome: {
					status: "empty",
					error: {
						code: "structured_output_missing",
						message: "OpenAI structured observer output was missing.",
					},
					authRetry: null,
				},
			}),
			getStatus: () => ({
				provider: "openai",
				model: "test-model",
				runtime: "api_http",
				auth: { source: "env", type: "api_direct", hasToken: true },
				lastError: { code: "stale_shared_error", message: "Stale shared error" },
			}),
		};

		await expect(
			flushRawEvents(store, { observer: structuredObserver } as unknown as IngestOptions, {
				opencodeSessionId: sessionId,
				source: "opencode",
				cwd: null,
				project: null,
				startedAt: null,
				maxEvents: null,
			}),
		).rejects.toThrow("observer output failed validation (structured_output_missing)");

		const batch = store.db
			.prepare(
				"SELECT error_type, observer_error_code FROM raw_event_flush_batches WHERE opencode_session_id = ?",
			)
			.get(sessionId) as { error_type: string; observer_error_code: string };
		expect(batch).toEqual({
			error_type: "ObserverOutputError:structured_output_missing",
			observer_error_code: "structured_output_missing",
		});
	});
});

it("persists the failed legacy repair's call-local status", async () => {
	tmpDir = mkdtempSync(join(tmpdir(), "codemem-flush-outcome-test-"));
	const dbPath = join(tmpDir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(dbPath);
	const sessionId = "ses_failed_legacy_repair";
	store.recordRawEvent({
		opencodeSessionId: sessionId,
		eventId: "evt-1",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Hello" },
		tsWallMs: 100,
	});
	const observe = vi
		.fn()
		.mockResolvedValueOnce({
			raw: "<observation><type>discovery</type><title>Retained</title></observation><observation>",
			provider: "openai",
			model: "test-model",
			outcome: { status: "success", error: null, authRetry: null },
		})
		.mockResolvedValueOnce({
			raw: null,
			provider: "openai",
			model: "test-model",
			outcome: {
				status: "failure",
				error: { code: "observer_timeout", message: "Repair timed out" },
				authRetry: null,
			},
		});
	const observer = {
		provider: "openai",
		runtime: "api_http",
		openaiUseResponses: false,
		hasCustomBaseUrl: false,
		outputMode: "legacy_xml",
		maxChars: 12_000,
		observe,
		getStatus: () => ({
			provider: "openai",
			model: "test-model",
			runtime: "api_http",
			auth: { source: "env", type: "api_direct", hasToken: true },
			lastError: { code: "stale_shared_error", message: "Stale shared error" },
		}),
	};

	await expect(
		flushRawEvents(store, { observer } as unknown as IngestOptions, {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: null,
			maxEvents: null,
		}),
	).rejects.toThrow("observer repair remained lossy during raw-event flush");

	const batch = store.db
		.prepare(
			"SELECT error_type, observer_error_code FROM raw_event_flush_batches WHERE opencode_session_id = ?",
		)
		.get(sessionId) as { error_type: string; observer_error_code: string };
	expect(batch).toEqual({
		error_type: "RawEventObserverOutputError:lossy_repair",
		observer_error_code: "observer_timeout",
	});
});

it("classifies structured transport failures without advancing the cursor", async () => {
	tmpDir = mkdtempSync(join(tmpdir(), "codemem-flush-outcome-test-"));
	const dbPath = join(tmpDir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(dbPath);
	const sessionId = "ses_structured_transport_failure";
	store.recordRawEvent({
		opencodeSessionId: sessionId,
		eventId: "evt-1",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Hello" },
		tsWallMs: 100,
	});
	store.db.exec(`
		CREATE TRIGGER fail_observer_failure_telemetry
		BEFORE INSERT ON usage_events
		WHEN NEW.event = 'observer_call'
		BEGIN
			SELECT RAISE(ABORT, 'telemetry unavailable');
		END
	`);
	const structuredObserver = {
		provider: "openai",
		runtime: "api_http",
		openaiUseResponses: true,
		hasCustomBaseUrl: false,
		outputMode: "json_schema",
		maxChars: 12_000,
		observeStructuredJson: async () => ({
			raw: null,
			parsed: null,
			provider: "openai",
			model: "test-model",
			usedStructuredOutputs: true,
			failureReason: null,
			transportFailureCode: "rate_limited",
		}),
		getStatus: () => ({
			provider: "openai",
			model: "test-model",
			runtime: "api_http",
			auth: { source: "env", type: "api_direct", hasToken: true },
			lastError: { code: "rate_limited", message: "Try again later" },
		}),
	};

	await expect(
		flushRawEvents(store, { observer: structuredObserver } as unknown as IngestOptions, {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: null,
			maxEvents: null,
		}),
	).rejects.toThrow("observer request failed (rate_limited)");

	const batch = store.db
		.prepare(
			"SELECT status, error_type, error_message FROM raw_event_flush_batches WHERE opencode_session_id = ?",
		)
		.get(sessionId) as { status: string; error_type: string; error_message: string };
	expect(batch).toEqual({
		status: "failed",
		error_type: "ObserverOutputTransportError:rate_limited",
		error_message: "OpenAI request was rate limited during raw-event processing.",
	});
	expect(store.rawEventFlushState(sessionId)).toBe(-1);
});
