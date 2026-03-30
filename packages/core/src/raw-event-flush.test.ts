import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

describe("flushRawEvents max retry", () => {
	let tmpDir: string;
	let store: MemoryStore;
	let prevMaxAttempts: string | undefined;

	beforeEach(() => {
		prevMaxAttempts = process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-flush-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		if (prevMaxAttempts === undefined) delete process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS;
		else process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS = prevMaxAttempts;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function seedEvents(sessionId: string) {
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-1",
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: "Hello" },
			tsWallMs: 100,
		});
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-2",
			eventType: "tool.execute.after",
			payload: { type: "tool.execute.after", tool: "read", args: { filePath: "/tmp/x.ts" } },
			tsWallMs: 200,
		});
	}

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

	it("gives up after max attempts and advances flush cursor", async () => {
		process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS = "3";
		const sessionId = "ses_max_retry_test";
		seedEvents(sessionId);

		const ingestOpts = { observer: nullObserver } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: null,
			maxEvents: null,
		};

		// Fail 3 times — each attempt claims the batch and increments attempt_count
		for (let i = 0; i < 3; i++) {
			await expect(flushRawEvents(store, ingestOpts, flushOpts)).rejects.toThrow(
				"observer failed during raw-event flush",
			);
		}

		// 4th attempt should give up instead of retrying
		const result = await flushRawEvents(store, ingestOpts, flushOpts);
		expect(result.updatedState).toBe(1);
		expect(result.flushed).toBe(0);

		// Batch should be marked gave_up
		const batch = store.db
			.prepare(
				"SELECT status, attempt_count FROM raw_event_flush_batches WHERE opencode_session_id = ?",
			)
			.get(sessionId) as { status: string; attempt_count: number };
		expect(batch.status).toBe("gave_up");
		expect(batch.attempt_count).toBe(3);

		// Flush state should be advanced so the session isn't retried
		const flushState = store.rawEventFlushState(sessionId, "opencode");
		expect(flushState).toBeGreaterThanOrEqual(0);
	});

	it("does not give up when under the max attempts", async () => {
		process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS = "5";
		const sessionId = "ses_under_max";
		seedEvents(sessionId);

		const ingestOpts = { observer: nullObserver } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: null,
			maxEvents: null,
		};

		// Fail twice — still under the limit
		for (let i = 0; i < 2; i++) {
			await expect(flushRawEvents(store, ingestOpts, flushOpts)).rejects.toThrow(
				"observer failed during raw-event flush",
			);
		}

		// 3rd attempt should still try (and fail), not give up
		await expect(flushRawEvents(store, ingestOpts, flushOpts)).rejects.toThrow(
			"observer failed during raw-event flush",
		);

		const batch = store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE opencode_session_id = ?")
			.get(sessionId) as { status: string };
		expect(batch.status).toBe("failed");
	});

	it("uses default max of 5 when env var is not set", async () => {
		delete process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS;
		const sessionId = "ses_default_max";
		seedEvents(sessionId);

		const ingestOpts = { observer: nullObserver } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: null,
			maxEvents: null,
		};

		// Fail 5 times
		for (let i = 0; i < 5; i++) {
			await expect(flushRawEvents(store, ingestOpts, flushOpts)).rejects.toThrow(
				"observer failed during raw-event flush",
			);
		}

		// 6th attempt should give up
		const result = await flushRawEvents(store, ingestOpts, flushOpts);
		expect(result.updatedState).toBe(1);

		const batch = store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE opencode_session_id = ?")
			.get(sessionId) as { status: string };
		expect(batch.status).toBe("gave_up");
	});

	it("gave_up batches are not resurrected by retryRawEventFailures", async () => {
		process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS = "1";
		const sessionId = "ses_no_resurrect";
		seedEvents(sessionId);

		const ingestOpts = { observer: nullObserver } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: null,
			maxEvents: null,
		};

		// Fail once, then give up
		await expect(flushRawEvents(store, ingestOpts, flushOpts)).rejects.toThrow();
		await flushRawEvents(store, ingestOpts, flushOpts);

		// Verify gave_up
		const before = store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE opencode_session_id = ?")
			.get(sessionId) as { status: string };
		expect(before.status).toBe("gave_up");

		// retryRawEventFailures should not touch it
		const { retryRawEventFailures } = await import("./maintenance.js");
		const retried = retryRawEventFailures(store.dbPath);
		expect(retried.retried).toBe(0);

		// Still gave_up
		const after = store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE opencode_session_id = ?")
			.get(sessionId) as { status: string };
		expect(after.status).toBe("gave_up");
	});
});
